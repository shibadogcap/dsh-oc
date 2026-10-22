import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { MessageConvertOptions } from './convert/message.js'
import type { WireMessageEntry } from './convert/wire.js'
import { DEFAULT_AGENT, projectIdFor, safeJsonParse } from './convert/common.js'
import { opencodeToolName, type ToolCallInfo } from './convert/tool.js'
import type { InteractionState } from './state.js'

/**
 * SSE event emitted to opencode. We deliberately carry the same payload under
 * both `properties` (the 1.18.18 TUI binary's expectation) and `data` (the
 * published OpenCode 2.x payload), so either consumer can parse it.
 *
 * The bridge also speaks the OpenCode 2.x native vocabulary (see
 * `makeV2Event`): `properties` stays the 1.18.18 projection while `data`
 * carries the 2.x payload of the same event.
 */
export interface BridgeGlobalEvent {
  directory: string
  project?: string
  workspace?: string
  payload: {
    id: string
    created?: number
    type: string
    /** The OpenCode 1.18.18 projection; what the bundled TUI reads. */
    properties: Record<string, unknown>
    /**
     * The OpenCode 2.x projection; what a 2.x client (the OpenChamber UI)
     * reads. It is the 1.18.18 payload unless the event has a 2.x-native
     * counterpart, in which case it carries the 2.x payload.
     */
    data: Record<string, unknown>
    durable?: { aggregateID: string; seq: number; version: 1 }
    location?: { directory: string; workspaceID?: string }
  }
}

export interface TranslateDeps {
  cwd: string
  state: InteractionState
  defaultModel?: { providerID: string; modelID: string; variant?: string }
  log(message: string): void
  /** Per-SSE-connection replay guard for approval/question/chunk frames. */
  replayGuard?: { approvals: Set<string>; questions: Set<string>; chunks?: Set<string> }
  /** Per-SSE-connection projection state surviving translator rebuilds. */
  sharedState?: { todos: Map<string, unknown>; goals: Map<string, unknown> }
  /** Coalescing window for `tool-call-delta` events before flushing (ms). */
  toolFlushMs?: number
  /** Injectable timer used by the tool-input throttle. */
  setTimeoutImpl?: (callback: () => void, ms: number) => TimerHandle
  /** Injectable timer clearer used by the tool-input throttle. */
  clearTimeoutImpl?: (handle: TimerHandle | undefined) => void
  /** Called with events flushed asynchronously by the tool-input throttle. */
  onFlush?: (events: BridgeGlobalEvent[]) => void
  /**
   * Called with every OpenCode 2.x native event the translator produces.
   * The 1.18.18 TUI stream keeps its own vocabulary, so the 2.x events
   * travel on their own channel.
   */
  onV2Event?: (event: BridgeGlobalEvent) => void
}

/** Structural timer handle so tests can inject a fake scheduler. */
export interface TimerHandle {
  unref?(): unknown
}

/**
 * Durable sequence counters, one per aggregate (the session id). OpenCode 2.x
 * numbers the events of a session, so the sequence has to advance per session
 * rather than per process.
 */
const durableSeqByAggregate = new Map<string, number>()

/** The next durable sequence number of one aggregate. */
function nextDurableSeq(aggregateID: string): number {
  const next = (durableSeqByAggregate.get(aggregateID) ?? 0) + 1
  durableSeqByAggregate.set(aggregateID, next)
  return next
}

export function makeEvent(
  directory: string,
  type: string,
  properties: Record<string, unknown>,
  project?: string,
  v2?: Record<string, unknown>,
): BridgeGlobalEvent {
  const aggregateID = typeof properties.sessionID === 'string' ? properties.sessionID : directory
  return {
    directory,
    ...(project === undefined ? {} : { project }),
    payload: {
      id: randomUUID(),
      created: Date.now(),
      type,
      properties,
      data: v2 ?? properties,
      durable: { aggregateID, seq: nextDurableSeq(aggregateID), version: 1 },
      location: { directory },
    },
  }
}

/**
 * Build one OpenCode 2.x native event. The 2.x vocabulary names its events
 * differently (`session.text.delta`, not `message.part.delta`) and carries
 * the event's own fields under `data`; the 1.18.18 TUI ignores the event
 * because it does not know the name.
 */
export function makeV2Event(
  directory: string,
  type: string,
  data: Record<string, unknown>,
  project?: string,
  aggregateID?: string,
): BridgeGlobalEvent {
  const aggregate = aggregateID
    ?? (typeof data.sessionID === 'string' ? data.sessionID : directory)
  return {
    directory,
    ...(project === undefined ? {} : { project }),
    payload: {
      id: randomUUID(),
      created: Date.now(),
      type,
      properties: data,
      data,
      durable: { aggregateID: aggregate, seq: nextDurableSeq(aggregate), version: 1 },
      location: { directory },
    },
  }
}

/**
 * Rewrite every occurrence of a dsh session id in an event payload.
 *
 * A revert forks the dsh session at the boundary, so the events of the fork
 * carry the new dsh id while the clients know the session under its
 * original id. The ids are unique, so replacing every exact match is safe
 * and covers the many shapes a session id can take in an event.
 */
export function mapEventSessionId(
  event: BridgeGlobalEvent,
  from: string,
  to: string,
): BridgeGlobalEvent {
  if (from === to) return event
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') return value === from ? to : value
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = replace(item)
      }
      return out
    }
    return value
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      properties: replace(event.payload.properties) as Record<string, unknown>,
      data: replace(event.payload.data) as Record<string, unknown>,
      ...(event.payload.durable === undefined
        ? {}
        : { durable: { ...event.payload.durable, aggregateID: event.payload.durable.aggregateID === from ? to : event.payload.durable.aggregateID } }),
    },
  }
}

export function directoryFor(sessionId: string, deps: TranslateDeps): string {
  return deps.state.sessionDirectories.get(sessionId) ?? deps.cwd
}

export function messageOptions(
  sessionId: string,
  deps: TranslateDeps,
): MessageConvertOptions {
  const selected = deps.state.sessionModelSelectionFor(sessionId)
  return {
    sessionId,
    cwd: deps.cwd,
    ...(selected === undefined
      ? deps.defaultModel === undefined ? {} : { defaultModel: deps.defaultModel }
      : { defaultModel: selected }),
    onSkip: (eventType, reason) => deps.log(`[bridge/events] skip ${eventType}: ${reason}`),
  }
}

export function messageEvents(
  sessionId: string,
  deps: TranslateDeps,
  build: () => { info: Record<string, unknown>; parts: Array<Record<string, unknown>> },
  partsFirst = false,
): BridgeGlobalEvent[] {
  const directory = directoryFor(sessionId, deps)
  const project = projectIdFor(directory)
  const { info, parts } = build()
  const update = makeEvent(directory, 'message.updated', { sessionID: sessionId, info }, project)
  const events: BridgeGlobalEvent[] = partsFirst
    ? []
    : [update]
  for (const part of parts) {
    events.push(
      makeEvent(directory, 'message.part.updated', { sessionID: sessionId, part, time: Date.now() }, project),
    )
  }
  if (partsFirst) events.push(update)
  return events
}

export function toolCallId(resultEvent: SessionEvent<'tool/result'>): string {
  const message = resultEvent.data.message as { toolCallId?: unknown; source?: { callId?: unknown } }
  return String(message.toolCallId ?? message.source?.callId ?? '')
}

/** Best-effort structured progress label for a started tool call. */
export function toolProgressStructured(call: ToolCallInfo): Record<string, unknown> {
  const present = call.view?.for === 'call'
    ? (call.view.view as unknown as { title?: unknown; card?: unknown })
    : undefined
  const title = typeof present?.title === 'string'
    ? present.title
    : opencodeToolName(call.name, safeJsonParse(call.arguments))
  return {
    title,
    ...(typeof present?.card === 'string' ? { card: present.card } : {}),
  }
}

export function earliestBlockStart(
  blockStarts: Map<string, number>,
  turn: number,
  step: number,
): number | undefined {
  let earliest: number | undefined
  for (const [key, value] of blockStarts) {
    const [keyTurn, keyStep] = key.split(':')
    if (Number(keyTurn) === turn && Number(keyStep) === step) {
      if (earliest === undefined || value < earliest) earliest = value
    }
  }
  return earliest
}

export function zeroTokens(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
}

export function provisionalAssistantMessage(
  sessionId: string,
  deps: TranslateDeps,
  id: string,
  created: number,
  parentID: string,
): Record<string, unknown> {
  // The live provisional card must name the session's actual model as soon as
  // the prompt route recorded it; the deployment default (or the legacy
  // fallback) is only for sessions with no selection yet.
  const selected = deps.state.sessionModelSelectionFor(sessionId)
  const model = selected ?? deps.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
  const agent = deps.state.sessionAgentFor(sessionId) ?? DEFAULT_AGENT
  return {
    id,
    sessionID: sessionId,
    role: 'assistant',
    agent,
    time: { created },
    parentID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: agent,
    path: { cwd: deps.cwd, root: deps.cwd },
    cost: 0,
    tokens: zeroTokens(),
  }
}

export function streamPart(
  blockType: 'text' | 'reasoning',
  sessionId: string,
  messageId: string,
  partId: string,
  text: string,
  start: number,
  end?: number,
): Record<string, unknown> {
  return {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: blockType,
    text,
    time: end === undefined ? { start } : { start, end },
  }
}

/**
 * Build the opencode SSE events that make a server-side command result
 * visible in the TUI: an optional session status change plus one synthetic
 * assistant message with a text part. The message is intentionally
 * ephemeral — dsh history is not touched, so no model turn is triggered.
 */
export function commandResultMessage(
  deps: TranslateDeps,
  sessionId: string,
  text: string,
  options: {
    status?: 'busy' | 'idle'
    parentID?: string
    model?: { providerID: string; modelID: string; variant?: string }
  } = {},
): { events: BridgeGlobalEvent[]; entry: WireMessageEntry } {
  const directory = directoryFor(sessionId, deps)
  const project = projectIdFor(directory)
  const events: BridgeGlobalEvent[] = []
  if (options.status !== undefined) {
    events.push(
      makeEvent(directory, 'session.status', {
        sessionID: sessionId,
        status: { type: options.status },
      }, project),
    )
  }
  const id = `msg_cmd:${randomUUID()}`
  const partId = `prt_cmd:${randomUUID()}`
  const created = Date.now()
  // A command is rendered in the active session, not in the connection-wide
  // catalog.  The latter is only a startup fallback and may differ after the
  // user selected another model/variant in the TUI.
  const model: { providerID: string; modelID: string; variant?: string } = options.model
    ?? deps.state.sessionModelSelectionFor(sessionId)
    ?? deps.defaultModel
    ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
  const agent = deps.state.sessionAgentFor(sessionId) ?? DEFAULT_AGENT
  // The OpenCode TUI treats an assistant message without `time.completed` as
  // an in-flight turn and marks following user cards QUEUED.  A command has
  // two phases: the transient "Running …" marker is genuinely busy, while
  // the final result is already complete.  Preserve that distinction in the
  // synthetic message as well as in its text part.
  const finished = options.status !== 'busy'
  const info: Record<string, unknown> = {
        id,
        sessionID: sessionId,
        role: 'assistant',
        agent,
        time: finished ? { created, completed: created } : { created },
        parentID: options.parentID ?? `pending:${sessionId}:user`,
        modelID: model.modelID,
        providerID: model.providerID,
        ...(model.variant === undefined ? {} : { variant: model.variant }),
        mode: agent,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: zeroTokens(),
      }
  const part: Record<string, unknown> = {
        id: partId,
        sessionID: sessionId,
        messageID: id,
        type: 'text',
        text,
        time: finished ? { start: created, end: created } : { start: created },
      }
  events.push(makeEvent(directory, 'message.updated', { sessionID: sessionId, info }, project))
  events.push(makeEvent(directory, 'message.part.updated', {
    sessionID: sessionId,
    part,
    time: created,
  }, project))
  return {
    events,
    entry: {
      info: info as unknown as WireMessageEntry['info'],
      parts: [part as unknown as WireMessageEntry['parts'][number]],
    },
  }
}

export function commandResultEvents(
  deps: TranslateDeps,
  sessionId: string,
  text: string,
  options: { status?: 'busy' | 'idle'; parentID?: string } = {},
): BridgeGlobalEvent[] {
  return commandResultMessage(deps, sessionId, text, options).events
}

/** Visible agent-error message used by the host-level error path. */
export function opencodeError(code: string, message: string): { name: string; data: Record<string, unknown> } {
  if (code === 'message-aborted' || code === 'aborted') {
    return { name: 'MessageAbortedError', data: { message } }
  }
  if (code === 'auth' || code === 'invalid_api_key' || code === 'authentication') {
    return { name: 'ProviderAuthError', data: { providerID: 'deepseek', message } }
  }
  return { name: 'UnknownError', data: { message } }
}

export function agentErrorEvents(sessionId: string, message: string, cwd: string): BridgeGlobalEvent[] {
  const project = projectIdFor(cwd)
  const created = Date.now()
  const id = `msg_err:${randomUUID()}`
  const partId = `${id}:0`
  return [
    makeEvent(cwd, 'session.error', {
      sessionID: sessionId,
      error: opencodeError('agent-error', message),
    }, project),
    makeEvent(cwd, 'message.updated', {
      sessionID: sessionId,
      info: {
        id,
        sessionID: sessionId,
        role: 'assistant',
        agent: DEFAULT_AGENT,
        time: { created },
        parentID: `pending:${sessionId}:user`,
        modelID: 'deepseek-chat',
        providerID: 'deepseek',
        mode: DEFAULT_AGENT,
        path: { cwd, root: cwd },
        cost: 0,
        tokens: zeroTokens(),
      },
    }, project),
    makeEvent(cwd, 'message.part.updated', {
      sessionID: sessionId,
      part: {
        id: partId,
        sessionID: sessionId,
        messageID: id,
        type: 'text',
        text: `[错误] ${message}`,
        time: { start: created, end: created },
      },
      time: created,
    }, project),
  ]
}
