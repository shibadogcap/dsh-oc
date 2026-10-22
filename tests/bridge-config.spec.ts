import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBridgeRouter } from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import { availableShells } from '../src/bridge/config-store.js'
import { fakeApi } from './helpers.js'

// The 2.1.0 client writes exactly one setting: `{ shell }` on
// `PATCH /api/experimental/config`. It must persist, or the shell choice is lost
// on every restart, and it must reject a shell that cannot run.
const servers: BridgeServerHandle[] = []
let home = ''
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-oc-config-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

async function bridge() {
  const router = createBridgeRouter(fakeApi(), { cwd: '/work' })
  const server = await startBridgeServer(router)
  servers.push(server)
  return server
}

describe('bridge: the shell setting', () => {
  it('lists the available shells from /etc/shells and $SHELL', async () => {
    const server = await bridge()
    const body = (await (await fetch(`${server.url}/api/config/shell`)).json()) as Array<{
      path: string
      name: string
      acceptable: boolean
    }>
    expect(body.length).toBeGreaterThan(0)
    expect(body.every((option) => option.acceptable)).toBe(true)
    expect(body.map((option) => option.path)).toEqual(availableShells().map((option) => option.path))
  })

  it('persists the shell and serves it back in the config document', async () => {
    const shell = availableShells().find((option) => option.acceptable)?.path
    expect(shell).toBeDefined()
    const server = await bridge()
    const response = await fetch(`${server.url}/api/experimental/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shell }),
    })
    expect(response.status).toBe(204)
    expect(JSON.parse(readFileSync(join(home, 'opencode/config/opencode.json'), 'utf8'))).toEqual({ shell })

    const body = (await (await fetch(`${server.url}/api/config`)).json()) as Array<{
      type: string
      path: string
      info: { shell?: string; model?: { model: string }; default_agent?: string }
    }>
    expect(body).toHaveLength(1)
    expect(body[0]?.type).toBe('document')
    expect(body[0]?.path).toBe(join(home, 'opencode/config/opencode.json'))
    expect(body[0]?.info.shell).toBe(shell)
    expect(body[0]?.info.model?.model).toBe('mock-model')
  })

  it('rejects a shell that cannot run', async () => {
    const server = await bridge()
    const response = await fetch(`${server.url}/api/experimental/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shell: '/nope/sh' }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { data: { code: string } }
    expect(body.data.code).toBe('config/shell-invalid')
  })

  it('rejects a body without a shell value', async () => {
    const server = await bridge()
    const response = await fetch(`${server.url}/api/experimental/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
  })
})
