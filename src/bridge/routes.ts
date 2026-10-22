// Route registrations for the dsh-oc bridge.
// Aggregates domain route modules; see src/bridge/routes/*.ts.
import type { Route } from './router.js'
import { registerBootRoutes } from './routes/boot.js'
import { registerFsRoutes } from './routes/fs.js'
import { registerVcsRoutes } from './routes/vcs.js'
import { registerSessionV2Routes } from './routes/session-v2.js'
import { registerSessionV2ExtraRoutes } from './routes/session-v2-extra.js'
import { registerV2StubRoutes } from './routes/v2-stubs.js'
import { registerV2ClientCompatRoutes } from './routes/v2-client-compat.js'

export type RouteRegistrar = (
  method: string,
  pattern: string,
  kind: Route['kind'],
  handler: Route['handler'],
) => void

export function registerRoutes(register: RouteRegistrar): void {
  registerBootRoutes(register)
  registerSessionV2Routes(register)
  registerSessionV2ExtraRoutes(register)
  registerFsRoutes(register)
  registerVcsRoutes(register)
  registerV2StubRoutes(register)
  registerV2ClientCompatRoutes(register)
  register('GET', '/api/event', 'sse', async () => ({ status: 200 }))
}
