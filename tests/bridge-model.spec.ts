import { afterEach, describe, expect, it } from 'vitest'
import { createBridgeRouter } from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import { fakeApi } from './helpers.js'

// dsh only lists a provider's models once the provider has a usable
// credential. Without one the catalog is empty, and a client that resolves
// its model against that catalog (the TUI does) has nothing to select: it
// shows "No provider selected" and offers the OpenCode integration flow, which
// dsh does not use. The bridge publishes the configured default instead, so
// the model stays visible and the missing credential surfaces on the prompt.
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

describe('bridge: the configured model without a catalog', () => {
  it('publishes the deployment default when the catalog is empty', async () => {
    const server = await bridgeWith()
    const response = await fetch(`${server.url}/api/model`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string; name: string; providerID: string }> }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      id: 'mock-model',
      providerID: 'deepseek',
      name: 'Mock Model',
    })
  })

  it('publishes the provider of the configured model', async () => {
    const server = await bridgeWith()
    const body = (await (await fetch(`${server.url}/api/provider`)).json()) as {
      data: Array<{ id: string; name: string }>
    }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ id: 'deepseek', name: 'DeepSeek' })
  })

  it('reports the default model', async () => {
    const server = await bridgeWith()
    const body = (await (await fetch(`${server.url}/api/model/default`)).json()) as {
      data: { id: string } | null
    }
    expect(body.data?.id).toBe('mock-model')
  })

  it('publishes the configured model and agent in the config document', async () => {
    const server = await bridgeWith()
    const body = (await (await fetch(`${server.url}/api/config`)).json()) as Array<{
      type: string
      info: { model?: { providerID: string; model: string }; default_agent?: string }
    }>
    expect(body).toHaveLength(1)
    expect(body[0]?.type).toBe('document')
    expect(body[0]?.info.model).toEqual({ providerID: 'deepseek', model: 'mock-model' })
    expect(body[0]?.info.default_agent).toBe('minimal')
  })

  it('prefers a real catalog group over the configured default', async () => {
    const base = fakeApi()
    const server = await bridgeWith({
      ...base,
      sessionController: {
        ...base.sessionController,
        modelCatalog: async () => ({
          default: { provider: 'deepseek-official', model: 'deepseek-flash' },
          routableProviders: ['deepseek-official'],
          groups: [{
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }],
          }],
          failures: [],
        }),
      },
    })
    const body = (await (await fetch(`${server.url}/api/model`)).json()) as {
      data: Array<{ id: string; name: string }>
    }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' })
  })
})
