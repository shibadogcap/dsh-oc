import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { BridgeEvent } from '../dsh-types.js'
import type { ToolEventView } from '../dsh-types.js'
import type {
  AssistantMessage as DshAssistantMessage,
  ContentBlock,
  TokenUsage,
} from '@deepseek-ai/dsh-llm/types'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import type {
  JsonValue,
  ModelRef,
  SessionMessageAssistant as ClientSessionMessageAssistant,
  SessionMessageAssistantReasoning as ClientSessionMessageAssistantReasoning,
  SessionMessageAssistantText as ClientSessionMessageAssistantText,
  SessionMessageAssistantTool as ClientSessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageUser as ClientSessionMessageUser,
  ToolContent,
} from '@opencode/client'
import type {
  WireCompactionPart,
  WireMessageEntry,
  WireMessageInfo,
  WirePart,
  WireTextPart,
} from './wire.js'

// Local widened aliases built on top of @opencode/client types so the
// v2 converter can keep carrying the extra fields (part ids, pending tool
// state, structured metadata) that the dsh bridge relies on. These remain
// assignable to the client wire types used at the route boundary.
type SessionMessageUser = ClientSessionMessageUser
type SessionMessageAssistantText = ClientSessionMessageAssistantText & { id?: string }
type SessionMessageAssistantReasoning = ClientSessionMessageAssistantReasoning & { id?: string }
type SessionMessageAssistantTool = ClientSessionMessageAssistantTool
type SessionMessageAssistant = Omit<ClientSessionMessageAssistant, 'content'> & {
  content: Array<SessionMessageAssistantText | SessionMessageAssistantReasoning | SessionMessageAssistantTool>
}
type SessionMessage = SessionMessageUser | SessionMessageAssistant
import {
  DEFAULT_AGENT,
  externalProviderId,
  provisionalMessageId,
  provisionalPartId,
  safeJsonParse,
  textFromBlocks,
} from './common.js'
import {
  normalizedToolInput,
  pendingToolPart,
  opencodeToolName,
  subagentMetadataForCall,
  type ToolCallInfo,
  type SubagentToolMetadata,
} from './tool.js'
import { goalChangeText } from './goal.js'

export interface MessageConvertOptions {
  sessionId: string
  cwd: string
  /**
   * Model ref attached to user messages. The opencode TUI reads the last
   * user message's model to restore the session model, so it must name a
   * model present in the advertised catalog.
   */
  defaultModel?: { providerID: string; modelID: string; variant?: string }
  onSkip?: (eventType: string, reason: string) => void
  /** Resolve a dsh delegation's child id from the parent session catalog. */
  subagentForCall?: (call: ToolCallInfo) => SubagentToolMetadata | undefined
}

/**
 * Packed dsh chunk rows surface through the session event feed as
 * `text-chunks` / `reasoning-chunks`. They are not part of the strict
 * `SessionEventMap` union, so the converter treats them as a narrow runtime
 * shape instead of extending the public type.
 */
interface StreamChunkRowEvent {
  type: 'text-chunks' | 'reasoning-chunks'
  seq: number
  time: number
  time0: number
  data: {
    turn: number
    step: number
    index: number
    dt?: number[]
    texts: string[]
  }
}

/** Block timing extracted from one durable `assistant/message` embedded stream. */
interface AssistantStreamTiming {
  starts: Array<[string, number]>
  ends: Array<[string, number]>
  finish: string | undefined
}

/**
 * Read the exact block timing and finish reason back out of a dsh 0.1.5
 * embedded Assistant stream. History rows only preserve the packed delta runs
 * (`expandRecord`), so the raw `block-start` / `block-end` / `finish` chunks
 * inside the settlement event are the authoritative source for part durations
 * on a cold read.
 */
function assistantStreamTiming(
  stream: readonly AssistantStreamRecord[] | undefined,
  turn: number,
  step: number,
): AssistantStreamTiming {
  const starts: Array<[string, number]> = []
  const ends: Array<[string, number]> = []
  if (!Array.isArray(stream)) return { starts, ends, finish: undefined }
  let finish: string | undefined
  for (const record of stream) {
    if (record.type === 'chunk') {
      const chunk = record.chunk
      if (chunk.type === 'block-start') {
        starts.push([`${turn}:${step}:${chunk.index}:${chunk.blockType}`, record.time])
      } else if (chunk.type === 'block-end') {
        ends.push([`${turn}:${step}:${chunk.index}:${chunk.block.type}`, record.time])
      } else if (chunk.type === 'finish') {
        finish = chunk.reason.kind
      }
      continue
    }
    const blockType = record.type === 'text-chunks'
      ? 'text'
      : record.type === 'reasoning-chunks' ? 'reasoning' : 'tool-call'
    let elapsed = 0
    for (const gap of record.dt) {
      if (typeof gap === 'number') elapsed += gap
    }
    starts.push([`${turn}:${step}:${record.index}:${blockType}`, record.time0])
    ends.push([`${turn}:${step}:${record.index}:${blockType}`, record.time0 + elapsed])
  }
  return { starts, ends, finish }
}

/** Dsh checkpoint rows written by compaction have a plugin `compact` source. */
export function isCompactCheckpoint(event: SessionEvent<'user/message'>): boolean {  const source = event.data.source as { kind?: string; plugin?: string } | undefined
  return source?.kind === 'plugin' && source.plugin === 'compact'
}

/** Manual `/compact` records a sourceCommandId; automatic compaction omits it. */
export function isAutoCompactCheckpoint(event: SessionEvent<'user/message'>): boolean {
  const source = event.data.source as { sourceCommandId?: unknown } | undefined
  return source?.sourceCommandId === undefined
}

function compactionPart(
  messageId: string,
  opts: MessageConvertOptions,
  auto: boolean,
): WireCompactionPart {
  return {
    id: `${messageId}:compaction`,
    sessionID: opts.sessionId,
    messageID: messageId,
    type: 'compaction',
    auto,
  }
}

const ZERO_TOKENS = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function usageTokens(usage?: TokenUsage) {
  if (!usage) return ZERO_TOKENS
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    reasoning: usage.reasoningTokens ?? 0,
    cache: {
      read: usage.cacheReadTokens ?? 0,
      write: usage.cacheWriteTokens ?? 0,
    },
  }
}

function userMessageInfo(id: string, time: number, opts: MessageConvertOptions): WireMessageInfo {
  const selected = opts.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
  // The 1.18.18 TUI reads the `variant` field of a user card when restoring
  // the active model, so the bridge keeps carrying it next to the provider
  // and model ids.
  const model = {
    providerID: selected.providerID,
    modelID: selected.modelID,
    ...(selected.variant === undefined ? {} : { variant: selected.variant }),
  }
  return {
    id,
    sessionID: opts.sessionId,
    role: 'user',
    time: { created: time },
    agent: DEFAULT_AGENT,
    model,
  }
}

function assistantMessageInfo(
  message: DshAssistantMessage,
  time: number,
  parentID: string,
  opts: MessageConvertOptions,
  usage?: TokenUsage,
  created?: number,
  finish?: string,
): WireMessageInfo {
  return {
    id: String(message.id),
    sessionID: opts.sessionId,
    role: 'assistant',
    time: { created: created ?? time, completed: time },
    parentID,
    agent: DEFAULT_AGENT,
    modelID: message.source.model,
    providerID: externalProviderId(message.source.provider),
    mode: DEFAULT_AGENT,
    path: { cwd: opts.cwd, root: opts.cwd },
    cost: 0,
    tokens: usageTokens(usage),
    ...(finish === undefined ? {} : { finish }),
  }
}

function textPart(
  id: string,
  messageID: string,
  text: string,
  time: { start: number; end?: number },
  opts: MessageConvertOptions,
): WireTextPart {
  return {
    id,
    sessionID: opts.sessionId,
    messageID,
    type: 'text',
    text,
    time: { start: time.start, ...(time.end === undefined ? {} : { end: time.end }) },
  }
}

/** Build the SSE text/reasoning/tool parts for one assistant message. */
export function assistantPartsFromMessage(
  message: DshAssistantMessage,
  time: number,
  opts: MessageConvertOptions,
  blockStart?: (index: number, blockType: string) => number | undefined,
  blockEnd?: (index: number, blockType: string) => number | undefined,
  partIdFor?: (index: number, blockType: string) => string | undefined,
): { parts: WirePart[]; calls: Map<string, ToolCallInfo> } {
  const parts: WirePart[] = []
  const calls = new Map<string, ToolCallInfo>()
  const messageID = String(message.id)
  message.content.forEach((block, index) => {
    const start = blockStart?.(index, block.type) ?? time
    if (block.type === 'text') {
      parts.push(textPart(partIdFor?.(index, block.type) ?? `${messageID}:${index}`, messageID, block.text, { start, end: time }, opts))
    } else if (block.type === 'reasoning') {
      parts.push({
        id: partIdFor?.(index, block.type) ?? `${messageID}:${index}`,
        sessionID: opts.sessionId,
        messageID,
        type: 'reasoning',
        text: block.text,
        time: { start, end: blockEnd?.(index, 'reasoning') ?? time },
      })
    } else if (block.type === 'tool-call') {
      let call: ToolCallInfo = {
        callId: String(block.id),
        name: block.name,
        arguments: block.arguments,
      }
      const subagent = opts.subagentForCall?.(call)
      if (subagent !== undefined) call = { ...call, subagent }
      calls.set(call.callId, call)
      parts.push(
        pendingToolPart(call, {
          sessionID: opts.sessionId,
          messageID,
          time,
        }),
      )
    } else {
      opts.onSkip?.('assistant/message', `unhandled content block "${String((block as { type: string }).type)}"`)
    }
  })
  return { parts, calls }
}

function userPartsFromMessage(
  messageId: string,
  content: readonly ContentBlock[],
  time: number,
  opts: MessageConvertOptions,
): WirePart[] {
  const parts: WirePart[] = []
  content.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(textPart(`${messageId}:${index}`, messageId, block.text, { start: time, end: time }, opts))
    } else if (block.type === 'image') {
      // First version: image parts are skipped; the text surface still works.
      opts.onSkip?.('user/message', `image block skipped (${String((block.attachment as { mediaType?: string }).mediaType ?? 'unknown')})`)
    } else {
      opts.onSkip?.('user/message', `unhandled content block "${String((block as { type: string }).type)}"`)
    }
  })
  return parts
}

function earliestBlockStart(
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

type StreamBlockType = 'text' | 'reasoning'

interface StreamBlockAccumulator {
  blockType: StreamBlockType
  start: number
  text: string
}

type StreamBlocksByStep = Map<string, Map<string, StreamBlockAccumulator>>

function accumulateStreamBlock(
  blocksByStep: StreamBlocksByStep,
  turn: number,
  step: number,
  index: number,
  blockType: StreamBlockType,
  text: string,
  start: number,
): void {
  const stepKey = `${turn}:${step}`
  let blocks = blocksByStep.get(stepKey)
  if (!blocks) {
    blocks = new Map()
    blocksByStep.set(stepKey, blocks)
  }
  const blockKey = `${index}:${blockType}`
  const existing = blocks.get(blockKey)
  if (existing) {
    existing.text += text
  } else {
    blocks.set(blockKey, { blockType, start, text })
  }
}

/** Single-event conversion used by the SSE bridge. */
export function userMessageFromEvent(
  event: SessionEvent<'user/message'>,
  opts: MessageConvertOptions,
): WireMessageEntry {
  const id = String(event.data.id)
  return {
    info: userMessageInfo(id, event.time, opts),
    parts: isCompactCheckpoint(event)
      ? [compactionPart(id, opts, isAutoCompactCheckpoint(event))]
      : userPartsFromMessage(id, event.data.content, event.time, opts),
  }
}

/** Single-event conversion used by the SSE bridge. */
export function assistantMessageFromEvent(
  event: SessionEvent<'assistant/message'>,
  opts: MessageConvertOptions,
  blockStart?: (index: number, blockType: string) => number | undefined,
  blockEnd?: (index: number, blockType: string) => number | undefined,
  created?: number,
  parentID?: string,
  finish?: string,
  partIdFor?: (index: number, blockType: string) => string | undefined,
): WireMessageEntry {
  const id = String(event.data.message.id)
  const effectivePartIdFor = partIdFor ?? ((index: number, blockType: string) =>
    provisionalPartId(opts.sessionId, event.data.turn, event.data.step, blockType, index))
  const { parts } = assistantPartsFromMessage(event.data.message, event.time, opts, blockStart, blockEnd, effectivePartIdFor)
  return {
    info: assistantMessageInfo(event.data.message, event.time, parentID ?? id, opts, event.data.usage, created, finish),
    parts,
  }
}

// ---- v2 conversion (GET /api/session/{id}/message) ----

interface V2AssistantState {
  info: SessionMessageAssistant
  calls: Map<string, ToolCallInfo>
}

function partialV2Assistant(
  id: string,
  created: number,
  opts: MessageConvertOptions,
): SessionMessageAssistant {
  const model = opts.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
  return {
    id,
    time: { created },
    type: 'assistant',
    agent: DEFAULT_AGENT,
    model: { id: model.modelID, providerID: model.providerID },
    content: [],
    cost: 0,
    tokens: ZERO_TOKENS,
  }
}

function v2StreamPart(
  block: StreamBlockAccumulator,
  partId: string,
): SessionMessageAssistantText | SessionMessageAssistantReasoning {
  if (block.blockType === 'text') {
    return {
      type: 'text',
      id: partId,
      text: block.text,
    }
  }
  return {
    type: 'reasoning',
    id: partId,
    text: block.text,
    time: { created: block.start },
  }
}

function upsertPartialV2(
  messages: SessionMessage[],
  pending: Map<string, SessionMessageAssistant>,
  blocksByStep: StreamBlocksByStep,
  pendingCallsByStep: Map<string, Map<string, ToolCallInfo>>,
  opts: MessageConvertOptions,
  turn: number,
  step: number,
  created: number,
  seq: number,
  pushFn?: (message: SessionMessage, seq: number) => void,
): V2AssistantState {
  const stepKey = `${turn}:${step}`
  let info = pending.get(stepKey)
  if (!info) {
    info = partialV2Assistant(provisionalMessageId(opts.sessionId, turn, step), created, opts)
    pending.set(stepKey, info)
    if (pushFn === undefined) {
      messages.push(info)
    } else {
      pushFn(info, seq)
    }
  }
  const blocks = blocksByStep.get(stepKey)
  if (blocks) {
    for (const [blockKey, block] of blocks) {
      const blockIndex = Number(blockKey.slice(0, blockKey.indexOf(':')))
      const partId = provisionalPartId(opts.sessionId, turn, step, block.blockType, blockIndex)
      const replacement = v2StreamPart(block, partId)
      const partIndex = info.content.findIndex((part) => (part as any).id === partId)
      if (partIndex === -1) {
        info.content.push(replacement)
      } else {
        info.content[partIndex] = replacement
      }
    }
  }
  const calls = pendingCallsByStep.get(stepKey) ?? new Map<string, ToolCallInfo>()
  for (const call of calls.values()) {
    if (!info.content.some((part) => part.type === 'tool' && part.id === `tool:${call.callId}`)) {
      const tool: SessionMessageAssistantTool = {
        type: 'tool',
        id: `tool:${call.callId}`,
        name: opencodeToolName(call.name, safeJsonParse(call.arguments)),
        state: { status: 'streaming', input: call.arguments },
        time: { created },
      }
      info.content.push(tool)
    }
  }
  return { info, calls }
}

function toV2ModelRef(message: DshAssistantMessage): ModelRef {
  return {
    id: message.source.model,
    providerID: externalProviderId(message.source.provider),
  }
}

function toV2Assistant(
  event: SessionEvent<'assistant/message'>,
  opts: MessageConvertOptions,
  created?: number,
  blockStart?: (index: number, blockType: string) => number | undefined,
): V2AssistantState {
  const data = event.data
  const messageID = String(data.message.id)
  const content: SessionMessageAssistant['content'] = []
  const calls = new Map<string, ToolCallInfo>()
  data.message.content.forEach((block, index) => {
    if (block.type === 'text') {
      const part: SessionMessageAssistantText = {
        type: 'text',
        id: provisionalPartId(opts.sessionId, data.turn, data.step, 'text', index),
        text: block.text,
      }
      content.push(part)
    } else if (block.type === 'reasoning') {
      const start = blockStart?.(index, block.type) ?? event.time
      content.push({
        type: 'reasoning',
        id: provisionalPartId(opts.sessionId, data.turn, data.step, 'reasoning', index),
        text: block.text,
        time: { created: start, completed: event.time },
      })
    } else if (block.type === 'tool-call') {
      let call: ToolCallInfo = {
        callId: String(block.id),
        name: block.name,
        arguments: block.arguments,
      }
      const subagent = opts.subagentForCall?.(call)
      if (subagent !== undefined) call = { ...call, subagent }
      calls.set(call.callId, call)
      const tool: SessionMessageAssistantTool = {
        type: 'tool',
        id: `tool:${call.callId}`,
        name: opencodeToolName(call.name, safeJsonParse(call.arguments)),
        state: { status: 'streaming', input: call.arguments },
        time: { created: event.time },
      }
      content.push(tool)
    } else {
      opts.onSkip?.('assistant/message', `unhandled v2 block "${String((block as { type: string }).type)}"`)
    }
  })
  const info: SessionMessageAssistant = {
    id: messageID,
    time: { created: created ?? event.time, completed: event.time },
    type: 'assistant',
    agent: DEFAULT_AGENT,
    model: toV2ModelRef(data.message),
    content,
    cost: 0,
    tokens: usageTokens(data.usage),
  }
  return { info, calls }
}

function applyToolResultV2(
  messages: SessionMessage[],
  state: V2AssistantState | undefined,
  calls: Map<string, ToolCallInfo>,
  event: SessionEvent<'tool/result'>,
  opts: MessageConvertOptions,
): void {
  const data = event.data
  const callId = String((data.message as { toolCallId?: unknown }).toolCallId ?? data.message.source.callId)
  const call = calls.get(callId)
  if (!call || !state) {
    opts.onSkip?.('tool/result', `no matching v2 tool/call for "${callId}"`)
    return
  }
  const blocks = data.message.content
  const text = textFromBlocks(blocks as readonly { type: string; text?: unknown }[])
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text' as const, text }]
  const tool = state.info.content.find(
    (part): part is SessionMessageAssistantTool => part.type === 'tool' && part.id === `tool:${callId}`,
  )
  if (!tool) {
    opts.onSkip?.('tool/result', `no v2 tool part for "${callId}"`)
    return
  }
  const metadata = subagentMetadataForCall(call) as { [x: string]: JsonValue }
  if (data.error !== undefined) {
    tool.state = {
      status: 'error',
      input: normalizedToolInput(call.name, safeJsonParse(call.arguments)) as { [x: string]: JsonValue },
      ...(text.length > 0
        ? { content: [{ type: 'text' as const, text }] as [ToolContent, ...Array<ToolContent>] }
        : {}),
      metadata,
      error: { type: 'unknown', message: data.error.name ?? data.error.code ?? 'tool failed' },
    }
  } else {
    tool.state = {
      status: 'completed',
      input: normalizedToolInput(call.name, safeJsonParse(call.arguments)) as { [x: string]: JsonValue },
      content: content as [ToolContent, ...Array<ToolContent>],
      metadata,
    }
  }
  tool.time = { ...tool.time, completed: event.time }
  void messages
}

/** Fold dsh history events into the v2 `SessionMessage[]` list. */
export function convertMessagesV2(
  events: readonly BridgeEvent[],
  opts: MessageConvertOptions,
  views?: ReadonlyArray<ToolEventView | undefined>,
  anchorSeqs?: number[],
): SessionMessage[] {
  const messages: SessionMessage[] = []
  const pushMessage = (message: SessionMessage, seq: number): void => {
    messages.push(message)
    anchorSeqs?.push(seq)
  }
  const spliceMessage = (index: number): void => {
    messages.splice(index, 1)
    anchorSeqs?.splice(index, 1)
  }
  const calls = new Map<string, ToolCallInfo>()
  const blockStarts = new Map<string, number>()
  const turnStarts = new Map<number, number>()
  const finishReasons = new Map<string, string>()
  const blocksByStep: StreamBlocksByStep = new Map()
  const pending = new Map<string, SessionMessageAssistant>()
  const pendingCallsByStep = new Map<string, Map<string, ToolCallInfo>>()
  let lastAssistant: V2AssistantState | undefined
  // Keep an assistant fallback timestamp at or after the latest visible user
  // card.  dsh emits turn/start before user/message, while OpenCode's live /
  // history merge orders message keys by time.created.
  let lastUserMessageTime: number | undefined

  const assistantCreatedAt = (turn: number, step: number, fallback: number): number => Math.max(
    earliestBlockStart(blockStarts, turn, step) ?? turnStarts.get(turn) ?? fallback,
    lastUserMessageTime === undefined ? Number.MIN_SAFE_INTEGER : lastUserMessageTime + 1,
  )
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex] as BridgeEvent
    const view = views?.[eventIndex]
    switch (event.type) {
      case 'turn/start': {
        turnStarts.set(event.data.turn, event.time)
        break
      }
      case 'user/message': {
        const data = event.data
        const compact = isCompactCheckpoint(event)
        const sourceKind = (data.source as { kind?: string } | undefined)?.kind
        if (sourceKind !== 'user' && !compact) {
          // See convertMessagesV1: plugin/system rows stay off the surface.
          break
        }
        const model = opts.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
        const message = {
          id: String(data.id),
          time: { created: event.time },
          text: compact
            ? ''
            : textFromBlocks(data.content as readonly { type: string; text?: unknown }[]),
          type: 'user',
          // SessionMessageUser's generated v2 type omits the model metadata,
          // but the OpenCode TUI accepts it and uses it to keep the selected
          // provider/variant when hydrating the transcript.
          model: {
            id: model.modelID,
            providerID: model.providerID,
            ...(model.variant === undefined ? {} : { variant: model.variant }),
          },
        } as SessionMessageUser & { model: ModelRef }
        pushMessage(message, event.seq)
        lastUserMessageTime = event.time
        break
      }
      case 'text-chunks':
      case 'reasoning-chunks': {
        const chunk = event as unknown as StreamChunkRowEvent
        const blockType = chunk.type === 'text-chunks' ? 'text' : 'reasoning'
        const key = `${chunk.data.turn}:${chunk.data.step}:${chunk.data.index}:${blockType}`
        const time0 = chunk.time0 ?? chunk.time
        if (!blockStarts.has(key)) {
          blockStarts.set(key, time0)
        }
        const start = blockStarts.get(key) ?? time0
        accumulateStreamBlock(
          blocksByStep,
          chunk.data.turn,
          chunk.data.step,
          chunk.data.index,
          blockType,
          chunk.data.texts.join(''),
          start,
        )
        lastAssistant = upsertPartialV2(
          messages,
          pending,
          blocksByStep,
          pendingCallsByStep,
          opts,
          chunk.data.turn,
          chunk.data.step,
          assistantCreatedAt(chunk.data.turn, chunk.data.step, time0),
          chunk.seq,
          (message, seq) => pushMessage(message, seq),
        )
        break
      }
      case 'assistant/message': {
        const data = event.data
        const stepKey = `${data.turn}:${data.step}`
        const timing = assistantStreamTiming(data.stream, data.turn, data.step)
        for (const [key, time] of timing.starts) blockStarts.set(key, time)
        if (timing.finish !== undefined) finishReasons.set(stepKey, timing.finish)
        const state = toV2Assistant(
          event,
          opts,
          assistantCreatedAt(data.turn, data.step, event.time),
          (index, blockType) => blockStarts.get(`${data.turn}:${data.step}:${index}:${blockType}`),
        )
        const pendingMessage = pending.get(stepKey)
        const pendingIndex = pendingMessage === undefined
          ? -1
          : messages.findIndex((message) => message.id === pendingMessage.id)
        pushMessage(state.info, event.seq)
        if (pendingIndex !== -1) spliceMessage(pendingIndex)
        pending.delete(stepKey)
        pendingCallsByStep.delete(stepKey)
        for (const [callId, call] of state.calls) calls.set(callId, call)
        lastAssistant = state
        break
      }
      case 'tool/call': {
        const data = event.data
        let call: ToolCallInfo = {
          callId: String(data.callId),
          name: data.name,
          arguments: data.arguments,
          ...(view === undefined ? {} : { view }),
        }
        const subagent = opts.subagentForCall?.(call)
        if (subagent !== undefined) call = { ...call, subagent }
        calls.set(call.callId, call)
        const stepKey = `${data.turn}:${data.step}`
        let stepCalls = pendingCallsByStep.get(stepKey)
        if (!stepCalls) {
          stepCalls = new Map()
          pendingCallsByStep.set(stepKey, stepCalls)
        }
        stepCalls.set(call.callId, call)
        const pendingMessage = pending.get(stepKey)
        if (
          pendingMessage
          && !pendingMessage.content.some((part) => part.type === 'tool' && part.id === `tool:${call.callId}`)
        ) {
          pendingMessage.content.push({
            type: 'tool',
            id: `tool:${call.callId}`,
            name: opencodeToolName(call.name, safeJsonParse(call.arguments)),
            state: { status: 'streaming', input: call.arguments },
            time: { created: event.time },
          })
        }
        if (pendingMessage) lastAssistant = { info: pendingMessage, calls: stepCalls }
        break
      }
      case 'tool/result': {
        applyToolResultV2(messages, lastAssistant, calls, event, opts)
        break
      }
      default:
        if (event.type === 'goal/change') {
          const text = goalChangeText((event as unknown as { data: unknown }).data)
          if (text !== undefined) {
            const id = `goal:${event.seq}`
            const model = opts.defaultModel ?? { providerID: 'deepseek', modelID: 'deepseek-chat' }
            pushMessage({
              id,
              time: { created: event.time, completed: event.time },
              type: 'assistant',
              agent: DEFAULT_AGENT,
              model: {
                id: model.modelID,
                providerID: model.providerID,
              },
              content: [{ type: 'text', id: `${id}:note`, text } as SessionMessageAssistantText],
              cost: 0,
              tokens: ZERO_TOKENS,
            } as SessionMessage, event.seq)
          }
        }
        break
    }
  }
  return messages
}
