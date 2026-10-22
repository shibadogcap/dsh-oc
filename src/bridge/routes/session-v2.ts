// session-v2 routes for the dsh-oc bridge.
import * as R from '../router.js'
import type { SessionMessagesResponse } from '@opencode/client'
import type { SessionSummary } from '../dsh-types.js'
import { badRequest, notFound } from '../errors.js'
import { convertMessagesV2 } from '../convert/message.js'
import type { WireMessageEntry } from '../convert/wire.js'
import { convertSessionSummary, convertSessionSummaryV2 } from '../convert/session.js'
import { filterGitTrackedDiffs } from '../git.js'
import { randomUUID } from 'node:crypto'
import { toPermissionV2 } from '../convert/permission.js'
import { toQuestionV2 } from '../convert/question.js'
import type { RouteRegistrar } from '../routes.js'

/** Convert one bridge-only command card to the 2.x message shape. */
function commandResultToV2(entry: WireMessageEntry): SessionMessagesResponse['data'][number] {
  const info = entry.info as unknown as Record<string, unknown>
  const rawTime = info.time as { created?: unknown; completed?: unknown } | undefined
  const created = typeof rawTime?.created === 'number' ? rawTime.created : 0
  const completed = typeof rawTime?.completed === 'number' ? rawTime.completed : undefined
  const rawModel = info.model as { providerID?: unknown; modelID?: unknown; variant?: unknown } | undefined
  const providerID = typeof rawModel?.providerID === 'string'
    ? rawModel.providerID
    : typeof info.providerID === 'string' ? info.providerID : undefined
  const modelID = typeof rawModel?.modelID === 'string'
    ? rawModel.modelID
    : typeof info.modelID === 'string' ? info.modelID : undefined
  const model = providerID !== undefined && modelID !== undefined
    ? {
        id: modelID,
        providerID,
        ...(typeof rawModel?.variant === 'string'
          ? { variant: rawModel.variant }
          : typeof info.variant === 'string' ? { variant: info.variant } : {}),
      }
    : undefined
  const text = entry.parts
    .map((part) => part.type === 'text' && 'text' in part ? String((part as { text: unknown }).text) : '')
    .join('')
  if (info.role === 'user') {
    // v2's generated user shape does not declare the extra agent/model fields,
    // but the official TUI reads them from the live v1-compatible event when a
    // synthetic preset card is hydrated. Keep them on the wire so history does
    // not fall back to the catalog-first deepseek-chat model.
    return {
      id: String(info.id),
      time: { created },
      text,
      type: 'user',
      ...(typeof info.agent === 'string' ? { agent: info.agent } : {}),
      ...(model === undefined ? {} : { model }),
    } as unknown as SessionMessagesResponse['data'][number]
  }
  const toolPart = entry.parts.find((part) => part.type === 'tool') as {
    id?: unknown
    tool?: unknown
    callID?: unknown
    state?: Record<string, unknown>
  } | undefined
  if (toolPart !== undefined) {
    const state = toolPart.state ?? {}
    const output = typeof state.output === 'string'
      ? state.output
      : typeof (state.metadata as Record<string, unknown> | undefined)?.output === 'string'
        ? String((state.metadata as Record<string, unknown>).output)
        : ''
    const status = state.status === 'error' ? 'error' : state.status === 'running' ? 'running' : 'completed'
    const content = output === '' ? [] : [{ type: 'text', text: output }]
    return {
      id: String(info.id),
      time: completed === undefined ? { created } : { created, completed },
      type: 'assistant',
      agent: typeof info.agent === 'string' ? info.agent : 'build',
      model: {
        id: typeof info.modelID === 'string' ? info.modelID : 'deepseek-chat',
        providerID: typeof info.providerID === 'string' ? info.providerID : 'deepseek',
        ...(typeof info.variant === 'string' ? { variant: info.variant } : {}),
      },
      content: [{
        type: 'tool',
        id: String(toolPart.id ?? `tool:${String(toolPart.callID ?? '')}`),
        name: typeof toolPart.tool === 'string' ? toolPart.tool : 'bash',
        time: { created, ...(completed === undefined ? {} : { completed }) },
        state: {
          status,
          input: state.input ?? {},
          content,
          structured: {},
          ...(status === 'error'
            ? { error: { type: 'unknown', message: String(state.error ?? output ?? 'shell failed') } }
            : {}),
        },
      }],
    } as unknown as SessionMessagesResponse['data'][number]
  }
  return {
    id: String(info.id),
    time: completed === undefined ? { created } : { created, completed },
    type: 'assistant',
    agent: typeof info.agent === 'string' ? info.agent : 'build',
    model: {
      id: typeof info.modelID === 'string' ? info.modelID : 'deepseek-chat',
      providerID: typeof info.providerID === 'string' ? info.providerID : 'deepseek',
      ...(typeof info.variant === 'string' ? { variant: info.variant } : {}),
    },
    content: text === '' ? [] : [{ type: 'text', text }],
  }
}

/** Insert bridge-only cards without reordering durable converter output. */
function mergeCommandResultsV2(
  entries: SessionMessagesResponse['data'],
  commandResults: readonly WireMessageEntry[],
): void {
  if (commandResults.length === 0) return
  const seen = new Set(entries.map((entry) => String((entry as { id?: unknown }).id ?? '')))
  for (const source of commandResults) {
    const entry = commandResultToV2(source)
    if (seen.has(String((entry as { id?: unknown }).id ?? ''))) continue
    seen.add(String((entry as { id?: unknown }).id ?? ''))
    const createdAt = entry.time.created
    const index = entries.findIndex((candidate) => candidate.time.created > createdAt)
    entries.splice(index === -1 ? entries.length : index, 0, entry)
  }
}

function remapV2Messages(
  ctx: R.BridgeRouteContext,
  sessionId: string,
  messages: SessionMessagesResponse['data'],
): SessionMessagesResponse['data'] {
  const remapped: SessionMessagesResponse['data'] = []
  for (const message of messages) {
    const promptId = ctx.state.promptIdForDshId(sessionId, (message as { id: string }).id)
    const assistantId = promptId === undefined
      ? ctx.state.assistantIdForDshId(sessionId, (message as { id: string }).id)
      : undefined
    const surfaceId = promptId ?? assistantId
    const sessionAgent = ctx.state.sessionAgentFor(sessionId)
    const messageType = 'type' in message ? message.type : undefined
    // Synthetic command cards carry their own agent (notably the
    // msg_preset: user echo); do not overwrite that label with the session's
    // current preset while remapping history.
    const synthetic = String((message as { id: string }).id).startsWith('msg_cmd:')
      || String((message as { id: string }).id).startsWith('msg_preset:')
      || String((message as { id: string }).id).startsWith('msg_shell:')
    if (surfaceId === undefined && sessionAgent === undefined) {
      remapped.push(message)
      continue
    }
    let result: SessionMessagesResponse['data'][number]
    if (!('content' in message) || !Array.isArray(message.content)) {
      result = {
        ...message,
        ...(surfaceId === undefined ? {} : { id: surfaceId }),
        ...(!synthetic && sessionAgent !== undefined && (messageType === 'assistant' || messageType === 'user')
          ? { agent: sessionAgent }
          : {}),
      } as SessionMessagesResponse['data'][number]
    } else {
      const content = message.content.map((part) => ({
        ...part,
        ...(surfaceId === undefined ? {} : {
          id: String((part as { id?: unknown }).id ?? '').replaceAll((message as { id: string }).id, surfaceId),
          messageID: surfaceId,
        }),
      }))
      result = {
        ...message,
        ...(surfaceId === undefined ? {} : { id: surfaceId }),
        ...(!synthetic && sessionAgent !== undefined && (messageType === 'assistant' || messageType === 'user')
          ? { agent: sessionAgent }
          : {}),
        content,
      } as SessionMessagesResponse['data'][number]
    }
    if (assistantId !== undefined) {
      const created = ctx.state.assistantMessageCreatedAt(sessionId, assistantId)
      if (created !== undefined && result.type === 'assistant') {
        const time = {
          ...result.time,
          // Reuse the immutable key of the live provisional card.
          created,
        }
        if (ctx.state.isAssistantPending(sessionId, assistantId)) delete time.completed
        result = { ...result, time }
      }
    }
    if (promptId !== undefined && result.type === 'user') {
      const created = ctx.state.promptMessageCreatedAt(sessionId, promptId)
      if (created !== undefined) result = { ...result, time: { ...result.time, created } }
    }
    if (surfaceId !== undefined && result.type === 'assistant') {
      const existing = remapped.find((candidate) => (candidate as { id?: unknown }).id === surfaceId)
      if (existing !== undefined && 'content' in existing && Array.isArray(existing.content)
        && 'content' in result && Array.isArray(result.content)) {
        existing.content.push(...result.content)
        continue
      }
    }
    remapped.push(result)
  }
  return remapped
}

function promptText(content: Array<{ type: string; text?: unknown }>): string {
  return content.filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}

export function registerSessionV2Routes(register: RouteRegistrar): void {
  // ---- v2 sessions ----
  register('GET', '/api/session', 'json', async (req, ctx) => {
    const search = req.query.get('search')
    let all: SessionSummary[]
    if (search !== null && search.length > 0) {
      const results = await R.rpc<{ items: Array<{ sessionId: string }> }>(ctx, 'session.search', { query: search })
      const ids = new Set(results.items.map((item) => String(item.sessionId)))
      const list = await R.cachedSessionList(ctx)
      all = list.filter((item) => ids.has(String(item.sessionId)))
    } else {
      all = await R.cachedSessionList(ctx)
    }
    // A session that a revert moved to a fork is published under the id the
    // client knows, and the session it replaced drops out of the list.
    const replaced = new Set(ctx.state.aliasedSessionIds())
    const published = all
      .filter((item) => !replaced.has(String(item.sessionId)))
      .map((item) => ({ item, dshId: String(item.sessionId) }))
    const filtered = R.filterSessionsByDirectory(
      published.map((entry) => entry.item),
      req.query.get('directory') ?? undefined,
      ctx.cwd,
    )
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100
    const cursorRaw = req.query.get('cursor')
    const offset = cursorRaw === null ? 0 : R.decodeSessionCursor(cursorRaw)
    const ordered = req.query.get('order') === 'asc' ? [...filtered].reverse() : filtered
    const page = ordered.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    R.recordSessionSummaries(ctx, page)
    await R.warmListTitles(ctx, page)
    return R.json(200, {
      data: page.map((item) => {
        const dshId = String(item.sessionId)
        const opencodeId = ctx.state.openCodeIdFor(dshId)
        return {
          ...convertSessionSummaryV2(item, {
            cwd: ctx.state.sessionDirectories.get(dshId) ?? ctx.cwd,
            title: ctx.state.sessionTitleFor(dshId),
            ...(ctx.state.sessionAgentFor(dshId) === undefined
              ? {}
              : { agent: ctx.state.sessionAgentFor(dshId) }),
          }),
          id: opencodeId,
        }
      }),
      cursor: {
        ...(nextOffset < filtered.length ? { next: R.encodeSessionCursor(nextOffset) } : {}),
        ...(offset > 0 ? { previous: R.encodeSessionCursor(Math.max(0, offset - limit)) } : {}),
      },
    })
  })

  register('GET', '/experimental/session', 'json', async (req, ctx) => {
    const search = req.query.get('search')
    let all: SessionSummary[] = await R.cachedSessionList(ctx)
    if (search !== null && search.length > 0) {
      const results = await R.rpc<{ items: Array<{ sessionId: string }> }>(ctx, 'session.search', { query: search })
      const ids = new Set(results.items.map((item) => String(item.sessionId)))
      all = all.filter((item) => ids.has(String(item.sessionId)))
    }
    const filtered = R.filterSessionsByDirectory(all, req.query.get('directory') ?? undefined, ctx.cwd)
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100
    const page = filtered.slice(0, limit)
    R.recordSessionSummaries(ctx, page)
    await R.warmListTitles(ctx, page)
    return R.json(200, page.map((item) => convertSessionSummary(item, {
      cwd: ctx.state.sessionDirectories.get(String(item.sessionId)) ?? ctx.cwd,
      title: ctx.state.sessionTitleFor(String(item.sessionId)),
      ...(ctx.state.sessionAgentFor(String(item.sessionId)) === undefined
        ? {}
        : { agent: ctx.state.sessionAgentFor(String(item.sessionId)) }),
    })))
  })

  register('POST', '/api/session', 'json', (req, ctx) => R.createSession(req, ctx))

  register('GET', '/api/session/active', 'json', async (_req, ctx) => {
    const id = ctx.state.currentSessionId
    if (id === undefined) return R.json(200, { data: {} })
    const list = await R.cachedSessionList(ctx)
    const item = list.find((entry) => String(entry.sessionId) === id)
    if (item === undefined || !item.running) return R.json(200, { data: {} })
    return R.json(200, { data: { [id]: { type: 'running' } } })
  })

  register('POST', '/api/session/:sessionID/wait', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const list = await R.rpc<{ items: Array<{ sessionId: string; running: boolean }> }>(ctx, 'session.list', {})
      const item = list.items.find((entry) => String(entry.sessionId) === id)
      if (item === undefined) throw notFound('session not found', { sessionID: id })
      if (!item.running) return R.json(204)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return R.json(503, { name: 'ServiceUnavailableError', message: 'session still busy' })
  })

  register('POST', '/api/session/:sessionID/fork', 'json', (req, ctx) => R.forkSession(req, ctx))

  register('POST', '/api/session/:sessionID/compact', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    await R.runCompactCommand(ctx, id)
    // The v2 client unwraps `data` from the compaction inbox item.
    return R.json(200, {
      data: {
        id: `msg_${randomUUID()}`,
        sessionID: id,
        time: { created: Date.now() },
        type: 'compaction',
        payload: {},
        delivery: 'queue',
      },
    })
  })

  register('POST', '/api/session/:sessionID/prompt', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const body = R.bodyAsRecord(req.body)
    // OpenCode commits a staged revert when the next prompt arrives: the
    // transcript is cut at the boundary before the new turn starts.
    await R.commitStagedRevert(ctx, id)
    // The v2 client sends `{ text, files, agents, skills }`; the v1 `parts`
    // array stays accepted so a v1-shaped caller keeps working.
    const content = Array.isArray(body.parts)
      ? R.parsePromptParts(body.parts, ctx.cwd)
      : R.parseV2PromptInput(body, ctx.cwd)
    const slash = R.slashPromptCapture(content)
    if (slash !== undefined) {
      const outcome = await R.runSlashCommand(ctx, id, slash)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(200, {
        data: {
          id: `msg_${randomUUID()}`,
          sessionID: id,
          time: { created: Date.now() },
          type: 'user',
          payload: { text: promptText(content) },
          delivery: 'queue',
        },
      })
    }
    // The v2 client names the message `id`; the v1 TUI used `messageID`.
    const rawPromptID = typeof body.id === 'string' && body.id.length > 0
      ? body.id
      : typeof body.messageID === 'string' && body.messageID.length > 0
        ? body.messageID
        : `msg_${randomUUID()}`
    const createdAt = Date.now()
    const promptUserID = rawPromptID
    ctx.state.registerPromptMessageId(id, promptUserID, createdAt)
    const assistantID = `msg_${randomUUID()}`
    ctx.state.registerAssistantIdForUser(id, promptUserID, assistantID)
    await R.applyAgentFromBody(ctx, id, req.body)
    if (!(await R.applyModelSelection(ctx, id, req.body))) {
      await R.reconcileModelSelection(ctx, id)
    }
    await R.broadcastPromptUserMessage(
      ctx,
      id,
      promptUserID,
      promptText(content),
      createdAt,
      R.promptModelRef(ctx, id, req.body),
      body.delivery === 'queue' ? 'queue' : 'steer',
    )
    // The v2 client picks the delivery; `steer` reaches a running turn and
    // `queue` waits for the current one to finish.
    const delivery = body.delivery === 'queue' ? 'queue' : 'steer'
    await R.rpc(ctx, 'session.prompt', {
      sessionId: R.sid(id),
      requestId: promptUserID,
      mode: delivery,
      content,
    })
    ctx.state.markInput()
    ctx.state.invalidateSession(id)
    return R.json(200, {
      data: {
        id: promptUserID,
        sessionID: id,
        time: { created: createdAt },
        type: 'user',
        payload: { text: promptText(content) },
        delivery,
      },
    })
  })

  register('GET', '/api/session/:sessionID', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const view = await R.sessionView(ctx, id)
    return R.json(200, { data: R.toV2Session(view, id, ctx) })
  })

  register('POST', '/api/session/:sessionID/model', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    try {
      await R.applyModelSelection(ctx, id, req.body)
    } catch (error) {
      // dsh only lists a provider's models once it has a usable credential.
      // "Select an available model" alone does not say what to fix, so the
      // missing credential is named here.
      const message = error instanceof Error ? error.message : String(error)
      if (/model-unavailable|Select an available model/i.test(message)) {
        throw badRequest(
          `model is not available: ${message} `
          + 'The provider has no usable credential; set its API key (for the DeepSeek route, DEEPSEEK_API_KEY) '
          + 'and restart dsh.',
          { code: 'session/model-unavailable', sessionID: id },
        )
      }
      throw error
    }
    return R.json(204)
  })

  register('GET', '/api/session/:sessionID/event', 'sse', async () => ({ status: 200 }))

  register('POST', '/api/session/:sessionID/agent', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const agent = typeof R.bodyAsRecord(req.body).agent === 'string'
      ? (R.bodyAsRecord(req.body).agent as string)
      : ''
    if (agent === '') throw badRequest('agent switch requires a string agent')
    await R.switchAgentPreset(ctx, id, agent)
    R.broadcastSessionAgent(ctx, id, agent)
    ctx.state.invalidateSession(id)
    return R.json(204)
  })

  register('POST', '/api/session/:sessionID/interrupt', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    // An owned `!` shell runs outside the model turn, so the interrupt has to
    // stop its child process as well.
    R.abortShellCommand(ctx, id)
    await R.rpc(ctx, 'session.cancel', { sessionId: R.sid(id) })
    // The v2 client reads `interrupted` from the response body.
    return R.json(200, { interrupted: true })
  })

  register('GET', '/api/session/:sessionID/message', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : undefined
    const cursorRaw = req.query.get('cursor')
    const beforeSeq = cursorRaw === null ? undefined : R.decodeMessageCursor(cursorRaw)
    const history = await R.cachedSessionHistory(ctx, id, { maxMessages: limit, beforeSeq })
    await R.ensureSubagentHistoryContext(ctx, id, history.events)
    const defaultModel = await R.sessionModelRef(ctx, id)
    const entries = history.events
    const oldest = R.oldestSurfaceSeq(entries)
    const data = convertMessagesV2(
      entries.map((entry) => entry.event),
      {
        sessionId: id,
        cwd: ctx.cwd,
        defaultModel,
        subagentForCall: (call) => R.subagentMetadataForHistory(ctx, id, call),
        onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`),
      },
      entries.map((entry) => entry.view),
    )
    mergeCommandResultsV2(data as unknown as SessionMessagesResponse['data'], ctx.state.commandResultsFor(id))
    const remapped = remapV2Messages(ctx, id, data as unknown as SessionMessagesResponse['data'])
    R.mergePendingAssistantV2(ctx, id, remapped as unknown as Array<Record<string, unknown>>)
    const response: SessionMessagesResponse = {
      data: req.query.get('order') === 'desc' ? remapped.reverse() : remapped,
      cursor: {
        ...(history.hasMore && oldest !== undefined ? { previous: R.encodeMessageCursor(oldest) } : {}),
      },
    }
    return R.json(200, response)
  })

  register('GET', '/api/session/:sessionID/history', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const limitRaw = req.query.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100
    const afterRaw = req.query.get('after')
    const after = afterRaw === null ? undefined : Number(afterRaw)
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) {
      throw badRequest('after must be a non-negative integer')
    }
    // dsh session.history supports `beforeSeq` (older events) but not a
    // forward cursor, so `after` is the exclusive upper event seq: fetch the
    // page BEFORE the cursor, in chronological order. Page 1 (no after)
    // returns the newest `limit` messages.
    const history = await R.cachedSessionHistory(ctx, id, {
      maxMessages: limit,
      ...(after === undefined ? {} : { beforeSeq: after }),
    })
    await R.ensureSubagentHistoryContext(ctx, id, history.events)
    const defaultModel = await R.sessionModelRef(ctx, id)
    const entries = history.events
    const anchorSeqs: number[] = []
    const data = convertMessagesV2(
      entries.map((entry) => entry.event),
      {
        sessionId: id,
        cwd: ctx.cwd,
        defaultModel,
        subagentForCall: (call) => R.subagentMetadataForHistory(ctx, id, call),
        onSkip: (type, reason) => ctx.log(`[bridge/history-v2] ${type}: ${reason}`),
      },
      entries.map((entry) => entry.view),
      anchorSeqs,
    )
    const withSeq = data.map((message, index) => ({ message, seq: anchorSeqs[index] ?? 0 }))
    const oldest = withSeq.reduce((min, entry) => Math.min(min, entry.seq), Number.MAX_SAFE_INTEGER)
    const next = !history.hasMore || withSeq.length === 0
      ? null
      : oldest
    return R.json(200, {
      data: remapV2Messages(ctx, id, withSeq.map((entry) => entry.message) as any) as any,
      hasMore: history.hasMore,
      next,
    })
  })

  register('GET', '/api/session/:sessionID/context', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const history = await R.cachedSessionHistory(ctx, id, { maxMessages: 500 })
    await R.ensureSubagentHistoryContext(ctx, id, history.events)
    const defaultModel = await R.sessionModelRef(ctx, id)
    const entries = history.events
    const data = convertMessagesV2(
      entries.map((entry) => entry.event),
      {
        sessionId: id,
        cwd: ctx.cwd,
        defaultModel,
        subagentForCall: (call) => R.subagentMetadataForHistory(ctx, id, call),
        onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`),
      },
      entries.map((entry) => entry.view),
    )
    return R.json(200, { data })
  })

  register('GET', '/api/session/:sessionID/message/:messageID', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const messageID = req.params.messageID as string
    const history = await R.cachedSessionHistory(ctx, id, { maxMessages: 500 })
    await R.ensureSubagentHistoryContext(ctx, id, history.events)
    const defaultModel = await R.sessionModelRef(ctx, id)
    const entries = history.events
    const data = convertMessagesV2(
      entries.map((entry) => entry.event),
      {
        sessionId: id,
        cwd: ctx.cwd,
        defaultModel,
        subagentForCall: (call) => R.subagentMetadataForHistory(ctx, id, call),
        onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`),
      },
      entries.map((entry) => entry.view),
    )
    const remapped = remapV2Messages(ctx, id, data as unknown as SessionMessagesResponse['data'])
    R.mergePendingAssistantV2(ctx, id, remapped as unknown as Array<Record<string, unknown>>)
    const found = remapped.find((message) => (message as { id?: unknown }).id === messageID)
    if (found === undefined) throw notFound('message not found', { messageID })
    return R.json(200, { data: found })
  })

  register('GET', '/api/session/:sessionID/diff', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const history = await R.cachedSessionHistory(ctx, id)
    // The v2 client unwraps `data` from the diff list.
    return R.json(200, { data: filterGitTrackedDiffs(ctx.cwd, R.historyFileDiffs(history)) })
  })

  register('GET', '/api/session/:sessionID/permission', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    return R.json(200, { data: ctx.state.permissionsForSession(id).map(toPermissionV2) })
  })

  register('GET', '/api/session/:sessionID/permission/:requestID', 'json', async (req, ctx) => {
    const sessionID = req.params.sessionID as string
    const requestID = req.params.requestID as string
    const entry = ctx.state.permissionByOpenCodeId(requestID)
    if (entry === undefined || entry.sessionId !== sessionID) {
      throw notFound('permission request not found', { requestID })
    }
    return R.json(200, { data: toPermissionV2(entry) })
  })

  register('POST', '/api/session/:sessionID/permission/:requestID/reply', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await R.permissionReply(ctx, requestID, req.body)
    return R.json(204)
  })

  register('GET', '/api/session/:sessionID/question', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    return R.json(200, { data: ctx.state.questionsForSession(id).map(toQuestionV2) })
  })

  register('POST', '/api/session/:sessionID/question/:requestID/reply', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await R.questionReply(ctx, requestID, req.body)
    return R.json(204)
  })

  register('POST', '/api/session/:sessionID/question/:requestID/reject', 'json', async (req, ctx) => {
    const requestID = req.params.requestID as string
    await R.questionReject(ctx, requestID)
    return R.json(204)
  })

  // ---- revert (rewind via sessionController.fork) ----
  register('POST', '/api/session/:sessionID/revert/stage', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const body = R.bodyAsRecord(req.body)
    const messageID = typeof body.messageID === 'string' ? body.messageID : ''
    if (messageID.length === 0) {
      throw badRequest('revert stage needs a message id', { sessionID: id })
    }
    // The boundary is exclusive: the named message and everything after it
    // disappear when the revert commits. The files the turns after the
    // boundary changed are rolled back right away, as OpenCode does, so the
    // workspace already shows the state the revert restores.
    const location = await R.locateMessage(ctx, id, messageID)
    // OpenCode rolls back the files of the assistant messages that come
    // after the boundary. A user prompt is followed by its own turn's
    // assistant reply, so that turn rolls back too; an assistant reply is
    // the last message of its turn, so it does not.
    const boundary = {
      turn: location.turn,
      includeTurn: location.role === 'user',
    }
    // The file snapshots are keyed by the dsh session the turn ran in, so
    // they are looked up under the session the opencode id points at.
    const dshId = ctx.state.resolveSessionId(id)
    // The diffs are computed before the rollback: afterwards the files
    // already carry the restored content and the diff would be empty.
    const files = ctx.api.rewind?.filesAfter(dshId, boundary) ?? []
    // Roll the files back right away, as OpenCode does: the workspace shows
    // the state the revert restores while the boundary is still staged.
    const restored = ctx.api.rewind?.restoreFilesAfter(dshId, boundary) ?? []
    if (restored.length > 0) {
      ctx.log(`[bridge/revert] rolled ${restored.length} file(s) back for session ${id}`)
    }
    ctx.state.stageRevert(id, { messageID, turn: boundary.turn, includeTurn: boundary.includeTurn, files })
    const revert = {
      messageID,
      ...(files.length === 0 ? {} : { files }),
    }
    R.publishV2Event(ctx, 'session.revert.staged', { sessionID: id, revert }, id)
    return R.json(200, { data: revert })
  })

  // The v2 client clears a staged revert with DELETE on the revert resource.
  register('DELETE', '/api/session/:sessionID/revert', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const staged = ctx.state.revertBoundary(id)
    ctx.state.clearRevert(id)
    if (staged === undefined) return R.json(204)
    // A cleared revert puts the rolled-back files back.
    const restored = ctx.api.rewind?.undoRestore(ctx.state.resolveSessionId(id)) ?? []
    if (restored.length > 0) {
      ctx.log(`[bridge/revert] put ${restored.length} file(s) back for session ${id}`)
    }
    R.publishV2Event(ctx, 'session.revert.cleared', { sessionID: id }, id)
    return R.json(204)
  })

  register('POST', '/api/session/:sessionID/revert/commit', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    // A failed fork leaves the transcript untouched and the boundary staged,
    // so the error propagates and the client knows the commit did not
    // happen.
    await R.commitStagedRevert(ctx, id)
    return R.json(204)
  })

}
