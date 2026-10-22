import * as R from '../router.js'
import type { RouteRegistrar } from '../routes.js'
import { badRequest } from '../errors.js'
import { vcsBase, vcsBranches, vcsDiff, vcsDirectory, vcsInfo, vcsStatus } from '../vcs.js'

const MODES = ['working', 'branch', 'committed'] as const
type Mode = (typeof MODES)[number]

/** The location query is `directory`, or `location[directory]` for nested refs. */
function directoryOf(req: R.BridgeRequest, ctx: R.BridgeRouteContext): string {
  const query = req.query
  const requested = query.get('directory') ?? query.get('location[directory]')
  return vcsDirectory(requested, ctx.cwd)
}

export function registerVcsRoutes(register: RouteRegistrar): void {
  register('GET', '/api/vcs', 'json', async (req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: vcsInfo(directoryOf(req, ctx)) ?? null,
  }))

  register('GET', '/api/vcs/base', 'json', async (req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: vcsBase(directoryOf(req, ctx)) ?? null,
  }))

  register('GET', '/api/vcs/status', 'json', async (req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: vcsStatus(directoryOf(req, ctx)),
  }))

  register('GET', '/api/vcs/branch', 'json', async (req, ctx) => R.json(200, {
    location: R.locationInfo(ctx),
    data: vcsBranches(directoryOf(req, ctx)),
  }))

  register('GET', '/api/vcs/diff', 'json', async (req, ctx) => {
    const raw = req.query.get('mode') ?? 'working'
    if (!(MODES as readonly string[]).includes(raw)) {
      throw badRequest(`unknown diff mode: ${raw}`, { mode: raw })
    }
    const context = Number.parseInt(req.query.get('context') ?? '3', 10)
    const base = req.query.get('base') ?? undefined
    return R.json(200, {
      location: R.locationInfo(ctx),
      data: vcsDiff(directoryOf(req, ctx), raw as Mode, base, Number.isNaN(context) ? 3 : context),
    })
  })
}
