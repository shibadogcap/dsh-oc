import { afterEach, describe, expect, it } from 'vitest'
import { createBridgeRouter } from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import { fakeApi } from './helpers.js'

// dsh configures each MCP server as an `mcp-client` plugin whose tools land on
// the shared registry as `mcp__<server>__<tool>`. The bridge publishes the
// servers it can see so the OpenCode MCP panel lists them; adding, removing or
// toggling one is profile configuration, which the bridge cannot do at runtime.
const servers: BridgeServerHandle[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function bridgeWith(api = fakeApi()) {
  const router = createBridgeRouter(api, { cwd: '/work' })
  const server = await startBridgeServer(router)
  servers.push(server)
  return server
}

describe('bridge: MCP servers', () => {
  it('publishes the connected servers from the tool registry', async () => {
    const server = await bridgeWith(fakeApi({
      mcp: {
        servers: () => [
          { name: 'github', tools: ['create_issue', 'search'] },
          { name: 'web', tools: ['fetch'] },
        ],
      },
    }))
    const response = await fetch(`${server.url}/api/mcp`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      location: { directory: string }
      data: Array<{ name: string; status: { status: string } }>
    }
    expect(body.data).toEqual([
      { name: 'github', status: { status: 'connected' } },
      { name: 'web', status: { status: 'connected' } },
    ])
    expect(body.location.directory).toBe('/work')
  })

  it('publishes an empty list when no MCP server is configured', async () => {
    const server = await bridgeWith()
    const body = (await (await fetch(`${server.url}/api/mcp`)).json()) as { data: unknown[] }
    expect(body.data).toEqual([])
  })

  it('refuses a runtime toggle and names the profile as the place to change it', async () => {
    const server = await bridgeWith(fakeApi({
      mcp: { servers: () => [{ name: 'github', tools: ['create_issue'] }] },
    }))
    const response = await fetch(`${server.url}/api/mcp/github/disconnect`, { method: 'POST' })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { message: string; data: { code: string } }
    expect(body.message).toContain('cordis.patch.yml')
    expect(body.data.code).toBe('mcp/profile-configured')
  })
})
