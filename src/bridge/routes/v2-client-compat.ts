// Client-compat routes for the official OpenCode 2.1.0 client.
//
// `@opencode/client@2.1.0` can call 137 routes. This file registers the ones
// the bridge did not answer yet: the method, the path shape (including the
// `/api/experimental/...` prefixes and the two-segment `/api/rpc/:rpcID/:method`
// shape), the success status and the `empty` flag are copied from the client
// route table (`node_modules/@opencode/client/dist/chunks/shared-events-hqeq47hr.js`),
// and the response body shape comes from the matching `*Output` type of the
// generated wire types.
//
// dsh has no equivalent for most of these domains (pty, integrations, mcp
// servers, websearch, session inbox, instruction entries, ...). Those routes
// answer with a schema-valid empty value and log the limitation through
// `ctx.log`, so the bridge log shows exactly what is stubbed instead of
// pretending the data exists.
import * as R from '../router.js'
import { locationInfo } from '../router.js'
import type { RouteRegistrar } from '../routes.js'
import { notFound } from '../errors.js'
import { convertMessagesV2 } from '../convert/message.js'
import {
  emptyPersistentPtyInfo,
  emptyPersistentPtyRead,
  emptyPty,
  logStub,
} from './v2-shapes.js'
import { randomUUID } from 'node:crypto'

export function registerV2ClientCompatRoutes(register: RouteRegistrar): void {
  const L = (ctx: R.BridgeRouteContext) => locationInfo(ctx)

  // ---- agent (real: the dsh agent preset roster) ----
  register('GET', '/api/agent/:agentID', 'json', async (req, ctx) => {
    const agentID = req.params.agentID as string
    const agents = await R.v2AgentList(ctx)
    const found = agents.find((agent) => agent.id === agentID)
    if (found === undefined) throw notFound('agent not found', { agentID })
    // 2.1.0 names every agent; the SDK roster only carries the id.
    const agent = { ...found, name: (found as { name?: string }).name ?? found.id }
    return R.json(200, { location: L(ctx), data: agent })
  })

  // ---- reference / websearch (dsh has neither) ----
  register('GET', '/api/websearch/provider', 'json', async (_req, ctx) => {
    logStub(ctx, 'GET /api/websearch/provider', 'dsh has no web search provider')
    return R.json(200, { location: L(ctx), data: [] })
  })
  register('POST', '/api/websearch', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/websearch', 'dsh has no web search provider; the query returns no results')
    return R.json(200, { location: L(ctx), data: { providerID: '', results: [] } })
  })

  // ---- pairing (dsh-oc runs in-process, there is no remote server to pair) ----
  register('GET', '/auth/connect/:code', 'json', async (req, ctx) => {
    logStub(ctx, 'GET /auth/connect/:code', 'dsh-oc runs in-process; there is no remote server to pair with')
    return R.json(200, { token: '' })
  })

  // ---- rpc (the two-segment shape carries an rpc target id) ----
  register('POST', '/api/rpc/:rpcID/:method', 'json', async (req, ctx) => {
    const rpcID = req.params.rpcID as string
    const method = req.params.method as string
    logStub(ctx, 'POST /api/rpc/:rpcID/:method', `dsh has no rpc target "${rpcID}"; method "${method}" is not dispatched`)
    return R.json(200, { output: null })
  })

  // ---- pty (dsh has no pty) ----
  register('GET', '/api/pty', 'json', async (_req, ctx) => {
    logStub(ctx, 'GET /api/pty', 'dsh has no pty')
    return R.json(200, { location: L(ctx), data: [] })
  })
  register('POST', '/api/pty', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/pty', 'dsh has no pty; no terminal is started')
    return R.json(200, { location: L(ctx), data: emptyPty(`pty_${randomUUID()}`, ctx.cwd) })
  })
  register('GET', '/api/pty/:ptyID', 'json', async (req, ctx) => {
    const ptyID = req.params.ptyID as string
    logStub(ctx, 'GET /api/pty/:ptyID', 'dsh has no pty')
    return R.json(200, { location: L(ctx), data: emptyPty(ptyID, ctx.cwd) })
  })
  register('PUT', '/api/pty/:ptyID', 'json', async (req, ctx) => {
    const ptyID = req.params.ptyID as string
    logStub(ctx, 'PUT /api/pty/:ptyID', 'dsh has no pty; the title/size change is not stored')
    return R.json(200, { location: L(ctx), data: emptyPty(ptyID, ctx.cwd) })
  })
  register('DELETE', '/api/pty/:ptyID', 'json', async (req, ctx) => {
    logStub(ctx, 'DELETE /api/pty/:ptyID', 'dsh has no pty; nothing is killed')
    return R.json(204)
  })
  register('POST', '/api/pty/:ptyID/connect-token', 'json', async (req, ctx) => {
    logStub(ctx, 'POST /api/pty/:ptyID/connect-token', 'dsh has no pty; no terminal ticket is issued')
    return R.json(200, { location: L(ctx), data: { ticket: '', expires_in: 0 } })
  })

  // ---- persistent pty (dsh has no persistent terminal) ----
  register('GET', '/api/experimental/persistent-pty/:ptyID/snapshot', 'json', async (req, ctx) => {
    const ptyID = req.params.ptyID as string
    logStub(ctx, 'GET /api/experimental/persistent-pty/:ptyID/snapshot', 'dsh has no persistent pty')
    return R.json(200, {
      data: {
        info: emptyPersistentPtyInfo(ptyID, '', ctx.cwd),
        text: '',
        checkpoint: '',
        cursor: { x: 0, y: 0 },
      },
    })
  })
  register('PUT', '/api/experimental/persistent-pty/:ptyID', 'json', async (req, ctx) => {
    const ptyID = req.params.ptyID as string
    logStub(ctx, 'PUT /api/experimental/persistent-pty/:ptyID', 'dsh has no persistent pty')
    return R.json(200, { data: emptyPersistentPtyInfo(ptyID, '', ctx.cwd) })
  })
  register('POST', '/api/experimental/persistent-pty/handoff', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/experimental/persistent-pty/handoff', 'dsh has no persistent pty; there is nothing to hand off')
    return R.json(200, { handoff: null })
  })
  register('POST', '/api/experimental/persistent-pty/shutdown', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/experimental/persistent-pty/shutdown', 'dsh has no persistent pty; nothing is shut down')
    return R.json(204)
  })

  // ---- session terminal (dsh has no per-session terminal) ----
  register('GET', '/api/experimental/session/:sessionID/terminal', 'json', async (_req, ctx) => {
    logStub(ctx, 'GET /api/experimental/session/:sessionID/terminal', 'dsh has no per-session terminal')
    return R.json(200, { data: [] as unknown[] })
  })
  register('GET', '/api/experimental/session/:sessionID/terminal/read', 'json', async (_req, ctx) => {
    logStub(ctx, 'GET /api/experimental/session/:sessionID/terminal/read', 'dsh has no per-session terminal')
    return R.json(200, { data: emptyPersistentPtyRead('', ctx.cwd) })
  })
  register('POST', '/api/experimental/session/:sessionID/terminal', 'json', async (req, ctx) => {
    const sessionID = req.params.sessionID as string
    logStub(ctx, 'POST /api/experimental/session/:sessionID/terminal', 'dsh has no per-session terminal; no process is started')
    return R.json(200, { data: emptyPersistentPtyInfo(`pty_${randomUUID()}`, sessionID, ctx.cwd) })
  })

  // ---- session instruction entries (dsh keeps instructions in AGENTS.md) ----
  register('GET', '/api/experimental/session/:sessionID/instructions/entries', 'json', async (req, ctx) => {
    logStub(ctx, 'GET /api/experimental/session/:sessionID/instructions/entries', 'dsh keeps instructions in AGENTS.md files, not per session')
    return R.json(200, { data: [] })
  })
  register('PUT', '/api/experimental/session/:sessionID/instructions/entries/:key', 'json', async (_req, ctx) => {
    logStub(ctx, 'PUT /api/experimental/session/:sessionID/instructions/entries/:key', 'dsh keeps instructions in AGENTS.md files, not per session')
    return R.json(204)
  })
  register('DELETE', '/api/experimental/session/:sessionID/instructions/entries/:key', 'json', async (_req, ctx) => {
    logStub(ctx, 'DELETE /api/experimental/session/:sessionID/instructions/entries/:key', 'dsh keeps instructions in AGENTS.md files, not per session')
    return R.json(204)
  })

  // ---- session inbox (dsh has no client visible inbox) ----
  register('DELETE', '/api/session/:sessionID/inbox/:inboxID', 'json', async (_req, ctx) => {
    logStub(ctx, 'DELETE /api/session/:sessionID/inbox/:inboxID', 'dsh has no client visible inbox; queued follow-ups are delivered by the bridge itself')
    return R.json(204)
  })
  register('PATCH', '/api/session/:sessionID/inbox/:inboxID', 'json', async (_req, ctx) => {
    logStub(ctx, 'PATCH /api/session/:sessionID/inbox/:inboxID', 'dsh has no client visible inbox; the delivery mode cannot be changed')
    return R.json(204)
  })

  // ---- session wait (real: dsh reports the running state of a session) ----
  register('POST', '/api/experimental/session/:sessionID/wait', 'json', async (req, ctx) => {
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

  // ---- session skill (real: dsh exposes the session skill catalog) ----
  register('POST', '/api/experimental/session/:sessionID/skill', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const body = R.bodyAsRecord(req.body)
    const skillID = typeof body.id === 'string' ? body.id : ''
    if (skillID === '') throw notFound('skill not found', { skill: skillID })
    const skills = await R.skillListForSession(ctx, id)
    const skill = skills.find((entry) => entry.name === skillID)
    if (skill === undefined) throw notFound('skill not found', { skill: skillID })
    // dsh runs a skill as a slash command prompt, the same way the session
    // command route does it.
    await R.rpc(ctx, 'session.prompt', {
      sessionId: R.sid(id),
      mode: 'steer',
      content: [{ type: 'text', text: `/${skill.name}` }],
    })
    ctx.state.invalidateSession(id)
    return R.json(204)
  })

  // ---- session export (real: dsh session history) ----
  register('GET', '/api/experimental/session/:sessionID/export', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const view = await R.sessionView(ctx, id)
    const info = R.toV2Session(view, id, ctx)
    const history = await R.cachedSessionHistory(ctx, id, { maxMessages: 500 })
    await R.ensureSubagentHistoryContext(ctx, id, history.events)
    const defaultModel = await R.sessionModelRef(ctx, id)
    const messages = convertMessagesV2(
      history.events.map((entry) => entry.event),
      {
        sessionId: id,
        cwd: ctx.cwd,
        defaultModel,
        subagentForCall: (call) => R.subagentMetadataForHistory(ctx, id, call),
        onSkip: (type, reason) => ctx.log(`[bridge/export-v2] ${type}: ${reason}`),
      },
      history.events.map((entry) => entry.view),
    )
    const sanitize = req.query.get('sanitize') === 'true'
    return R.json(200, {
      data: {
        info,
        messages: sanitize ? redactMessages(messages) : messages,
      },
    })
  })

  // ---- session permission create (bridge local request) ----
  register('POST', '/api/session/:sessionID/permission', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const body = R.bodyAsRecord(req.body)
    const action = typeof body.action === 'string' ? body.action : ''
    const resources = Array.isArray(body.resources) ? body.resources.map((entry) => String(entry)) : []
    const requestID = typeof body.id === 'string' && body.id.length > 0
      ? body.id
      : `perm_${randomUUID()}`
    // dsh raises approvals from its own tools, so a client created request can
    // never be answered by the host. It is still registered so the client can
    // list it, and the reply route answers with the declared 409 conflict.
    const saved = ctx.state.savedPermissionFor(id, action)
    const effect = saved !== undefined ? 'allow' : 'ask'
    ctx.state.registerApproval({
      opencodeId: requestID,
      rpcId: `client:${requestID}`,
      sessionId: id,
      approvalId: `client:${requestID}`,
      toolName: action,
      ...(resources.length === 0 ? {} : { reason: resources.join(' ') }),
    })
    ctx.log(`[bridge/compat] POST /api/session/:sessionID/permission registered a bridge local request (${requestID}); dsh cannot raise approvals on demand`)
    return R.json(200, { data: { id: requestID, effect } })
  })

  // ---- integrations (dsh has none) ----
  register('POST', '/api/experimental/integration/wellknown', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/experimental/integration/wellknown', 'dsh has no integration registry')
    return R.json(204)
  })
  register('POST', '/api/integration/:integrationID/connect/key', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/integration/:integrationID/connect/key', 'dsh has no integration registry')
    return R.json(204)
  })
  register('POST', '/api/integration/:integrationID/connect/external', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/integration/:integrationID/connect/external', 'dsh has no integration registry')
    return R.json(204)
  })
  register('POST', '/api/integration/:integrationID/connect/oauth', 'json', async (req, ctx) => {
    logStub(ctx, 'POST /api/integration/:integrationID/connect/oauth', 'dsh has no integration registry; no oauth attempt is started')
    return R.json(200, {
      location: L(ctx),
      data: {
        attemptID: `attempt_${randomUUID()}`,
        url: '',
        instructions: '',
        mode: 'code',
        time: { created: Date.now(), expires: 0 },
      },
    })
  })
  register('GET', '/api/integration/:integrationID/connect/oauth/:attemptID', 'json', async (_req, ctx) => {
    logStub(ctx, 'GET /api/integration/:integrationID/connect/oauth/:attemptID', 'dsh has no integration registry; no oauth attempt is alive')
    return R.json(200, {
      location: L(ctx),
      data: { status: 'expired', time: { created: 0, expires: 0 } },
    })
  })
  register('POST', '/api/integration/:integrationID/connect/oauth/:attemptID/complete', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/integration/:integrationID/connect/oauth/:attemptID/complete', 'dsh has no integration registry')
    return R.json(204)
  })
  register('DELETE', '/api/integration/:integrationID/connect/oauth/:attemptID', 'json', async (_req, ctx) => {
    logStub(ctx, 'DELETE /api/integration/:integrationID/connect/oauth/:attemptID', 'dsh has no integration registry')
    return R.json(204)
  })
  register('POST', '/api/integration/:integrationID/connect/command', 'json', async (req, ctx) => {
    logStub(ctx, 'POST /api/integration/:integrationID/connect/command', 'dsh has no integration registry; no command attempt is started')
    return R.json(200, {
      location: L(ctx),
      data: { attemptID: `attempt_${randomUUID()}`, time: { created: Date.now(), expires: 0 } },
    })
  })
  register('GET', '/api/integration/:integrationID/connect/command/:attemptID', 'json', async (_req, ctx) => {
    logStub(ctx, 'GET /api/integration/:integrationID/connect/command/:attemptID', 'dsh has no integration registry; no command attempt is alive')
    return R.json(200, {
      location: L(ctx),
      data: { status: 'expired', time: { created: 0, expires: 0 } },
    })
  })
  register('DELETE', '/api/integration/:integrationID/connect/command/:attemptID', 'json', async (_req, ctx) => {
    logStub(ctx, 'DELETE /api/integration/:integrationID/connect/command/:attemptID', 'dsh has no integration registry')
    return R.json(204)
  })

  // ---- experimental mcp servers (dsh has none) ----
  register('PUT', '/api/experimental/mcp/:server', 'json', async (_req, ctx) => {
    logStub(ctx, 'PUT /api/experimental/mcp/:server', 'dsh has no mcp server registry')
    return R.json(204)
  })
  register('DELETE', '/api/experimental/mcp/:server', 'json', async (_req, ctx) => {
    logStub(ctx, 'DELETE /api/experimental/mcp/:server', 'dsh has no mcp server registry')
    return R.json(204)
  })
  register('POST', '/api/experimental/mcp/:server/connect', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/experimental/mcp/:server/connect', 'dsh has no mcp server registry')
    return R.json(204)
  })
  register('POST', '/api/experimental/mcp/:server/disconnect', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/experimental/mcp/:server/disconnect', 'dsh has no mcp server registry')
    return R.json(204)
  })

  // ---- debug location eviction (dsh has one location per bridge) ----
  register('DELETE', '/api/debug/location', 'json', async (_req, ctx) => {
    logStub(ctx, 'DELETE /api/debug/location', 'the bridge owns exactly one location; there is nothing to evict')
    return R.json(204)
  })

  // ---- config update (dsh-oc config is derived from the dsh deployment) ----
  register('PATCH', '/api/experimental/config', 'json', async (_req, ctx) => {
    logStub(ctx, 'PATCH /api/experimental/config', 'dsh-oc has no writable config file; the shell setting is ignored')
    return R.json(204)
  })
}

/**
 * Blank every free-text field of an exported message list.
 *
 * `GET /api/experimental/session/:sessionID/export?sanitize=true` asks the
 * server for a redacted export. dsh-oc has no per-message redaction flag, so
 * the text fields are emptied instead of being shipped verbatim.
 */
function redactMessages(messages: unknown): unknown {
  const REDACTED_KEYS = new Set(['text', 'output', 'reasoning', 'description'])
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (value === null || typeof value !== 'object') return value
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(source)) {
      out[key] = REDACTED_KEYS.has(key) && typeof entry === 'string' ? '' : walk(entry)
    }
    return out
  }
  return walk(messages)
}
