// Catch-all stubs for OpenCode v2 routes that dsh-oc does not yet implement
// with real data. These return schema-valid empty responses so OpenChamber can
// bootstrap and render without 404/501. Real implementations land in their own
// route modules over time.
//
// For every route the official `@opencode/client@2.1.0` can call, the method,
// the path shape, the success status and the `empty` flag follow the client
// route table, and the response body follows the matching `*Output` type of the
// generated wire types. A route the client declares as `empty: true` answers
// with 204 and no body; a route it reads as `{ data }` answers with that
// envelope.
import * as R from '../router.js'
import { locationInfo } from '../router.js'
import type { RouteRegistrar } from '../routes.js'
import type { BridgeRouteContext } from '../router.js'
import { badRequest, notFound } from '../errors.js'
import { externalProviderId } from '../convert/common.js'
import { applyShell, availableShells, readServerConfig, serverConfigPath } from '../config-store.js'
import { convertToV2Models } from '../convert/model.js'
import {
  emptyCredentialEntry,
  emptyIntegrationInfo,
  emptyPersistentPtyInfo,
  emptySessionInfo,
  emptySessionStats,
  emptyShellInfo,
  logStub,
} from './v2-shapes.js'

export function registerV2StubRoutes(register: RouteRegistrar): void {
  const L = (ctx: any) => (typeof locationInfo === 'function' ? locationInfo(ctx) : {})

  // project — the 2.1.0 client reads a bare `Project[]` / `Project`.
  // The official server derives the list from the directories it serves, so
  // the bridge publishes the working directory it runs in. A browser UI shows
  // the project list to pick a workspace from.
  register('GET', '/api/project', 'json', async (_req, ctx) => R.json(200, [R.projectInfo(ctx)]))
  register('GET', '/api/project/:projectID', 'json', async (req, ctx) => {
    const projectID = req.params.projectID as string
    const project = R.projectInfo(ctx)
    if (project.id !== projectID) throw notFound('project not found', { projectID })
    return R.json(200, project)
  })
  register('PATCH', '/api/project/:projectID', 'json', async (req, ctx) => {
    const projectID = req.params.projectID as string
    const project = R.projectInfo(ctx)
    if (project.id !== projectID) throw notFound('project not found', { projectID })
    return R.json(200, project)
  })

  // config — the 2.1.0 client reads a bare `ConfigEntry[]`. The TUI takes its
  // default model and agent from the document entry, so the deployment
  // selection is published here instead of an empty list.
  register('GET', '/api/config', 'json', async (_req, ctx) => {
    const fallback = await R.modelCatalogDefault(ctx)
    const agent = ctx.api.agentPresets?.defaultId
    const stored = readServerConfig()
    const info = {
      ...(fallback === undefined
        ? {}
        : { model: { providerID: externalProviderId(fallback.provider), model: fallback.model } }),
      ...(agent === undefined ? {} : { default_agent: agent }),
      ...(stored.shell === undefined ? {} : { shell: stored.shell }),
    }
    if (Object.keys(info).length === 0) return R.json(200, [])
    return R.json(200, [{ type: 'document', path: serverConfigPath(), info }])
  })
  // The client writes `{ shell }`; dsh owns models, agents and permissions, so
  // this is the only value the bridge stores.
  register('PATCH', '/api/config', 'json', async (req) => {
    const body = R.bodyAsRecord(req.body)
    const result = applyShell('shell' in body ? body.shell : undefined)
    if (!result.ok) throw badRequest(result.message, { code: 'config/shell-invalid' })
    return R.json(204)
  })
  register('GET', '/api/config/shell', 'json', async () => R.json(200, availableShells()))
  register('GET', '/api/config/shells', 'json', async () => R.json(200, availableShells()))

  // model default — the model dsh uses for a session without a selection
  register('GET', '/api/model/default', 'json', async (_req, ctx) => {
    const fallback = await R.modelCatalogDefault(ctx)
    if (fallback === undefined) return R.json(200, { location: L(ctx), data: null })
    const groups = await R.modelGroupsForClients(ctx)
    const models = convertToV2Models(groups)
    const model = models.find((item) =>
      item.providerID === externalProviderId(fallback.provider) && item.id === fallback.model)
    return R.json(200, { location: L(ctx), data: model ?? null })
  })

  // session active
  register('GET', '/api/session/active', 'json', async (_req, ctx) => {
    const fn = (ctx.state as { activeSessions?: () => unknown }).activeSessions
    return R.json(200, fn ? fn() : {})
  })

  // permission (list/get/reply/create)
  register('GET', '/api/permission', 'json', async (_req, ctx) => R.json(200, { location: L(ctx), data: [...ctx.state.permissions.values()] }))
  register('GET', '/api/permission/:requestID', 'json', async (req, ctx) => {
    const p = ctx.state.permissions.get(req.params.requestID as string)
    if (!p) throw notFound('not found')
    return R.json(200, { location: L(ctx), data: p })
  })
  register('POST', '/api/permission/:requestID/reply', 'json', async () => R.json(200))
  register('POST', '/api/permission', 'json', async () => R.json(200, { id: '', effect: 'allow' }))

  // form (list/create/get/reply/cancel)
  register('GET', '/api/form', 'json', async (_req, ctx) => R.json(200, { location: L(ctx), data: [...ctx.state.questions.values()] }))
  register('POST', '/api/form', 'json', async () => R.json(200, { id: '' }))
  register('GET', '/api/form/:formID', 'json', async () => R.json(200, { id: '' }))
  register('POST', '/api/form/:formID/reply', 'json', async () => R.json(200))
  register('POST', '/api/form/:formID/cancel', 'json', async () => R.json(200))

  // vcs reads live in routes/vcs.ts; only the write stays here because dsh owns
  // the working copy.
  register('POST', '/api/vcs/init', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/vcs/init', 'dsh owns the working copy; the bridge cannot create one')
    return R.json(204)
  })

  // worktree — the 2.1.0 client reads a bare `WorktreeDirectory[]`
  register('GET', '/api/worktree', 'json', async (_req, ctx) => R.json(200, []))
  register('POST', '/api/worktree', 'json', async (_req, ctx) => R.json(200, { directory: ctx.cwd ?? '' }))
  register('DELETE', '/api/worktree', 'json', async (_req, ctx) => {
    logStub(ctx, 'DELETE /api/worktree', 'dsh owns the working copy; the bridge cannot remove it')
    return R.json(204)
  })
  register('POST', '/api/worktree/refresh', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/worktree/refresh', 'dsh owns the working copy; there is nothing to refresh')
    return R.json(204)
  })

  // mcp — the 2.1.0 client reads `McpServer[]`. dsh configures each server as
  // an `mcp-client` plugin and its tools land on the shared registry, so the
  // list is derived from the tools that are actually registered.
  register('GET', '/api/mcp', 'json', async (_req, ctx) => {
    const servers = ctx.api.mcp?.servers() ?? []
    return R.json(200, {
      location: R.locationInfo(ctx),
      data: servers.map((server) => ({ name: server.name, status: { status: 'connected' } })),
    })
  })
  // MCP servers are profile configuration, not runtime state: dsh has no
  // registry to add one to. Say so instead of accepting a change that would
  // not happen.
  const mcpRuntime = (ctx: Pick<BridgeRouteContext, 'log'>, action: string): never => {
    const message = 'MCP servers are configured in the dsh profile as mcp-client plugins; '
      + `the bridge cannot ${action} at runtime. Add or remove the entry in the profile's `
      + 'cordis.patch.yml and restart dsh.'
    logStub(ctx, `POST /api/mcp (${action})`, message)
    throw badRequest(message, { code: 'mcp/profile-configured' })
  }
  register('POST', '/api/mcp', 'json', async (_req, ctx) => mcpRuntime(ctx, 'add a server'))
  register('DELETE', '/api/mcp/:name', 'json', async (_req, ctx) => mcpRuntime(ctx, 'remove a server'))
  register('POST', '/api/mcp/:name/connect', 'json', async (_req, ctx) => mcpRuntime(ctx, 'connect a server'))
  register('POST', '/api/mcp/:name/disconnect', 'json', async (_req, ctx) => mcpRuntime(ctx, 'disconnect a server'))
  register('GET', '/api/mcp/resource', 'json', async () => R.json(200, { location: {}, data: { resources: [], templates: [] } }))

  // credential — the 2.1.0 client unwraps `{ data }`
  register('GET', '/api/credential', 'json', async () => R.json(200, { data: [] }))
  register('POST', '/api/credential', 'json', async () => R.json(200, { data: emptyCredentialEntry('') }))
  register('PATCH', '/api/credential/:id', 'json', async (_req, ctx) => {
    logStub(ctx, 'PATCH /api/credential/:id', 'dsh has no credential store')
    return R.json(204)
  })
  register('POST', '/api/credential/:id/activate', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/credential/:id/activate', 'dsh has no credential store')
    return R.json(204)
  })
  register('DELETE', '/api/credential/:id', 'json', async (_req, ctx) => {
    logStub(ctx, 'DELETE /api/credential/:id', 'dsh has no credential store')
    return R.json(204)
  })

  // shell — the 2.1.0 client reads `{ location, data: ShellInfo }`
  register('GET', '/api/shell', 'json', async () => R.json(200, { location: {}, data: [] }))
  register('POST', '/api/shell', 'json', async (_req, ctx) => R.json(200, { location: L(ctx), data: emptyShellInfo('', ctx.cwd) }))
  register('GET', '/api/shell/:shellID', 'json', async (req, ctx) => R.json(200, { location: L(ctx), data: emptyShellInfo(req.params.shellID as string, ctx.cwd) }))
  register('GET', '/api/shell/:shellID/output', 'json', async () => R.json(200, { location: {}, data: { output: '', cursor: 0, size: 0, truncated: false } }))
  register('DELETE', '/api/shell/:shellID', 'json', async (_req, ctx) => {
    logStub(ctx, 'DELETE /api/shell/:shellID', 'dsh has no persistent shell registry')
    return R.json(204)
  })

  // debug location
  register('GET', '/api/debug/location', 'json', async () => R.json(200, []))
  register('POST', '/api/debug/location/evict', 'json', async () => R.json(200))

  // migration
  register('GET', '/api/migration/v1/status', 'json', async () => R.json(200, { status: 'completed' }))

  // websearch
  register('GET', '/api/websearch/providers', 'json', async () => R.json(200, { location: {}, data: [] }))
  register('POST', '/api/websearch/query', 'json', async () => R.json(200, { location: {}, data: { text: '' } }))

  // generate
  register('POST', '/api/generate', 'json', async () => R.json(200, { text: '' }))
  register('POST', '/api/generate/text', 'json', async () => R.json(200, { text: '' }))

  // rpc
  register('POST', '/api/rpc/:method', 'json', async () => R.json(200, { data: null }))

  // pair / server
  register('POST', '/api/pair', 'json', async () => R.json(200, { code: '', expires_in: 0 }))
  register('POST', '/api/server/connect', 'json', async () => R.json(200, { token: '' }))

  // plugin
  register('GET', '/api/plugin', 'json', async () => R.json(200, { location: {}, data: [] }))
  register('POST', '/api/plugin/check', 'json', async () => R.json(200, { location: {}, data: [] }))
  register('POST', '/api/plugin/update', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/plugin/update', 'dsh-oc installs no opencode plugin')
    return R.json(204)
  })

  // integration
  register('GET', '/api/integration/:id', 'json', async (req) => R.json(200, { location: {}, data: emptyIntegrationInfo(req.params.id as string) }))
  register('POST', '/api/integration/wellknown', 'json', async () => R.json(200))

  // experimental
  register('GET', '/api/experimental/config', 'json', async () => R.json(200, { location: {}, data: {} }))
  register('POST', '/api/experimental/fs/write', 'json', async (req, ctx) => {
    const body = R.bodyAsRecord(req.body)
    const path = typeof body.path === 'string' ? body.path : ''
    logStub(ctx, 'POST /api/experimental/fs/write', 'dsh owns the file tools; the bridge does not write files itself')
    return R.json(200, { location: L(ctx), data: { path } })
  })
  register('GET', '/api/experimental/session/stats', 'json', async () => R.json(200, { data: emptySessionStats() }))
  register('POST', '/api/experimental/session/import', 'json', async (_req, ctx) => R.json(200, { data: emptySessionInfo('', ctx.cwd) }))
  register('POST', '/api/experimental/session/export', 'json', async () => R.json(200, {}))
  register('GET', '/api/experimental/session/log', 'json', async () => R.json(200, { location: {}, data: [] }))
  register('POST', '/api/experimental/generate', 'json', async () => R.json(200, { data: { text: '' } }))
  register('GET', '/api/experimental/mcp', 'json', async () => R.json(200, { location: {}, data: [] }))
  register('GET', '/api/experimental/migration/v1', 'json', async () => R.json(200, { status: 'completed' }))
  register('POST', '/api/experimental/voice/session', 'json', async () => R.json(200, { data: { transport: { type: 'websocket', url: '', token: '', expiresAt: 0 } } }))
  register('GET', '/api/experimental/terminal', 'json', async () => R.json(200, { location: {}, data: [] }))
  register('POST', '/api/experimental/session/wait', 'json', async () => R.json(200))
  register('POST', '/api/experimental/persistent-pty', 'json', async () => R.json(200, { id: '' }))
  register('GET', '/api/experimental/persistent-pty', 'json', async () => R.json(200, { location: {}, data: [] }))
  register('GET', '/api/experimental/persistent-pty/:id', 'json', async (req, ctx) => R.json(200, { data: emptyPersistentPtyInfo(req.params.id as string, '', ctx.cwd) }))
  register('DELETE', '/api/experimental/persistent-pty/:id', 'json', async (_req, ctx) => {
    logStub(ctx, 'DELETE /api/experimental/persistent-pty/:id', 'dsh has no persistent pty; nothing is killed')
    return R.json(204)
  })
  register('POST', '/api/experimental/persistent-pty/:id/connect-token', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/experimental/persistent-pty/:id/connect-token', 'dsh has no persistent pty; no terminal ticket is issued')
    return R.json(200, { data: { ticket: '', expires_in: 0 } })
  })

  // location reload
  register('POST', '/api/location/reload', 'json', async (_req, ctx) => {
    logStub(ctx, 'POST /api/location/reload', 'the bridge serves a single location; there is nothing to reload')
    return R.json(204)
  })
}