import { afterEach, describe, expect, it } from 'vitest'
import { createBridgeRouter } from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import { fakeApi } from './helpers.js'

// dsh keeps provider credentials in its own profile, so the OpenCode
// integration dialog has nothing to connect. The bridge publishes the providers
// that already have a credential: the sidebar's onboarding keys off
// `connections.length`, so the row also stops the "Connect provider" prompt from
// appearing next to a working model.
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

const catalogWith = (group: { id: string; name: string }) => {
  const base = fakeApi()
  return {
    ...base,
    sessionController: {
      ...base.sessionController,
      modelCatalog: async () => ({
        default: { provider: group.id, model: 'deepseek-flash' },
        routableProviders: [group.id],
        groups: [{
          id: group.id,
          name: group.name,
          models: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }],
        }],
        failures: [],
      }),
    },
  }
}

describe('bridge: integrations', () => {
  it('publishes a connected entry for a provider that has a credential', async () => {
    const server = await bridgeWith(catalogWith({ id: 'opencode-go', name: 'opencode-go' }))
    const body = (await (await fetch(`${server.url}/api/integration`)).json()) as {
      location: { directory: string }
      data: Array<{
        id: string
        name: string
        methods: unknown[]
        connections: Array<{ type: string; label?: string; name?: string }>
      }>
    }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      id: 'dsh-profile-opencode-go',
      name: 'opencode-go (dsh profile)',
      methods: [],
    })
    // `hasConnectedProvider` reads this length; an empty list keeps the
    // sidebar onboarding visible next to a working model.
    // The dialog hides rows whose methods and credential connections are both
    // empty, so the connection is what keeps this row visible.
    expect(body.data[0]?.connections).toEqual([
      { type: 'credential', id: 'dsh-profile-opencode-go', label: 'dsh profile', method: 'key' },
    ])
  })

  it('publishes a hint instead of an empty list when no provider has a credential', async () => {
    const server = await bridgeWith()
    const body = (await (await fetch(`${server.url}/api/integration`)).json()) as {
      data: Array<{ id: string; name: string; connections: unknown[] }>
    }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.id).toBe('dsh-profile')
    expect(body.data[0]?.connections).toEqual([])
  })

  it('refuses a runtime connect and names the profile', async () => {
    const server = await bridgeWith(catalogWith({ id: 'opencode-go', name: 'opencode-go' }))
    const response = await fetch(`${server.url}/api/integration/dsh-profile-opencode-go/connect/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-test' }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { message: string; data: { code: string } }
    expect(body.message).toContain('dsh profile')
    expect(body.data.code).toBe('integration/profile-configured')
  })
})
