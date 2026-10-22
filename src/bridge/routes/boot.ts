// boot routes for the dsh-oc bridge.
import * as R from '../router.js'
import { convertToV2Models, convertToV2Providers } from '../convert/model.js'
import { OPENCODE_VERSION, projectIdFor } from '../convert/common.js'
import { permissionActionFromTool } from '../convert/permission.js'
import { toPermissionV2 } from '../convert/permission.js'
import { toQuestionV2 } from '../convert/question.js'
import { notFound } from '../errors.js'
import type { RouteRegistrar } from '../routes.js'

export function registerBootRoutes(register: RouteRegistrar): void {
  // ---- v2 boot / catalog routes ----
  register('GET', '/api/info', 'json', async () => R.json(200, {
    version: OPENCODE_VERSION,
    pid: process.pid,
    urls: [],
    paths: { tmp: (process.env.TMPDIR ?? process.env.TMP ?? '/tmp') },
  }))

  register('GET', '/api/location', 'json', async (_req, ctx) => R.json(200, R.locationInfo(ctx)))

  register('GET', '/api/agent', 'json', async (_req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: await R.v2AgentList(ctx),
  }))

  register('GET', '/api/command', 'json', async (_req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: [
      R.PRESET_COMMAND_V2,
      R.GOAL_COMMAND_V2,
      R.HELP_COMMAND_V2,
      ...(await R.skillCommandsV2(ctx, _req.query.get('directory') ?? undefined)),
    ],
  }))
  register('GET', '/api/skill', 'json', async (req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: await R.skillList(ctx, req.query.get('directory') ?? undefined),
  }))
  register('GET', '/api/reference', 'json', async (_req, ctx) => R.json(200, R.v2LocationBody(ctx)))
  register('GET', '/api/integration', 'json', async (_req, ctx) => R.json(200, R.v2LocationBody(ctx)))

  register('GET', '/api/model', 'json', async (_req, ctx) => {
    const groups = await R.modelGroups(ctx)
    return R.json(200, { location: R.locationInfo(ctx), data: convertToV2Models(groups) })
  })

  register('GET', '/api/provider', 'json', async (_req, ctx) => {
    const groups = await R.modelGroups(ctx)
    return R.json(200, { location: R.locationInfo(ctx), data: convertToV2Providers(groups) })
  })

  register('GET', '/api/provider/:providerID', 'json', async (req, ctx) => {
    const providerID = req.params.providerID as string
    const groups = await R.modelGroups(ctx)
    const providers = convertToV2Providers(groups)
    const found = providers.find((provider) => provider.id === providerID)
    if (found === undefined) throw notFound('provider not found', { providerID })
    return R.json(200, { location: R.locationInfo(ctx), data: found })
  })

  register('GET', '/api/permission/request', 'json', async (_req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: [...ctx.state.permissions.values()].map(toPermissionV2),
  }))

  register('GET', '/api/question/request', 'json', async (_req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: [...ctx.state.questions.values()].map(toQuestionV2),
  }))

  register('GET', '/api/permission/saved', 'json', async (_req, ctx) => R.json(200, {
    data: ctx.state.savedPermissionsList().map((saved) => ({
      id: ctx.state.savedPermissionId(saved),
      projectID: projectIdFor(ctx.cwd),
      action: permissionActionFromTool(saved.toolName),
      resource: saved.toolName,
      sessionID: saved.sessionId,
      grantedAt: saved.grantedAt,
    })),
  }))

  register('DELETE', '/api/permission/saved/:permissionID', 'json', async (req, ctx) => {
    const permissionID = req.params.permissionID as string
    if (!ctx.state.removeSavedPermission(permissionID)) {
      throw notFound('saved permission not found', { permissionID })
    }
    return R.json(204)
  })

  // The 2.1 client can narrow a remembered grant.
  register('PATCH', '/api/permission/saved/:permissionID', 'json', async (req, ctx) => {
    const permissionID = req.params.permissionID as string
    const body = R.bodyAsRecord(req.body)
    const saved = ctx.state.updateSavedPermission(permissionID, {
      ...(typeof body.action === 'string' ? { action: body.action } : {}),
      ...(typeof body.resource === 'string' ? { resource: body.resource } : {}),
    })
    if (saved === undefined) {
      throw notFound('saved permission not found', { permissionID })
    }
    return R.json(200, {
      data: {
        id: ctx.state.savedPermissionId(saved),
        projectID: projectIdFor(ctx.cwd),
        action: permissionActionFromTool(saved.toolName),
        resource: saved.toolName,
        sessionID: saved.sessionId,
        grantedAt: saved.grantedAt,
      },
    })
  })

  register('GET', '/api/health', 'json', async () => R.json(200, { healthy: true }))

  register('GET', '/global/health', 'json', async () => R.json(200, {
    healthy: true,
    version: OPENCODE_VERSION,
  }))

  // dsh owns the bridge/process lifecycle; client dispose requests are
  // acknowledged and ignored so the profile keeps running.
  register('POST', '/global/dispose', 'json', async () => R.json(200, true))
  register('POST', '/instance/dispose', 'json', async () => R.json(200, true))

  // dsh sessions are always server-side and the `subagent` tool already runs
  // in the background, so "detach into background" is a no-op success.
  register('POST', '/experimental/session/:sessionID/background', 'json', async () => R.json(200, true))

}
