import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCode } from '@opencode/client'
import { createBridgeRouter, hostSessionAddedEvents, type BridgeRouter } from '../../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../../src/bridge/http.js'
import type { BridgeApi } from '../../src/bridge/rpc.js'
import { fakeApi, makeAssistantEvent, makeUserEvent, sessionEvent } from '../helpers.js'

// The official OpenCode 2.1.0 client, driven against the bridge. Every
// operation it can call must answer with the status and envelope the client
// expects, otherwise the OpenChamber UI sees a transport error.
const servers: BridgeServerHandle[] = []
const tempDirs: string[] = []

async function boot(
  api: BridgeApi = fakeApi(),
  cwd = '/work',
): Promise<{ server: BridgeServerHandle; router: BridgeRouter }> {
  const router: BridgeRouter = createBridgeRouter(api, { cwd })
  const server = await startBridgeServer(router)
  servers.push(server)
  return { server, router }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function clientFor(server: BridgeServerHandle): ReturnType<typeof OpenCode.make> {
  return OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}/` })
}

describe('contract: the official OpenCode client against the bridge', () => {
  it('reports a server version the OpenChamber UI accepts', async () => {
    const { server } = await boot()
    const info = await clientFor(server).server.info()
    expect(info.version).toMatch(/^2\.\d+\.\d+$/)
  })

  it('answers the location and project reads', async () => {
    const { server } = await boot()
    const client = clientFor(server)
    const location = await client.location.get()
    expect(location.directory).toBe('/work')
    expect(location.project.directory).toBe('/work')
    const projects = await client.project.list()
    expect(Array.isArray(projects)).toBe(true)
  })

  it('answers the catalog reads', async () => {
    const { server } = await boot()
    const client = clientFor(server)
    // The client leaves the `{ location, data }` envelope in place for these.
    expect(Array.isArray((await client.model.list()).data)).toBe(true)
    expect(Array.isArray((await client.provider.list()).data)).toBe(true)
    expect(Array.isArray((await client.agent.list()).data)).toBe(true)
    expect(Array.isArray((await client.command.list()).data)).toBe(true)
    expect(Array.isArray((await client.skill.list()).data)).toBe(true)
    expect(Array.isArray((await client.reference.list()).data)).toBe(true)
  })

  it('creates a session and lists it', async () => {
    const api = fakeApi({
      sessionController: {
        ...fakeApi().sessionController,
        list: async () => ({
          items: [{
            sessionId: 's1' as never,
            updatedAt: 1,
            running: false,
            agentAvailable: false,
            blank: true,
          }],
        }),
        create: async () => ({ sessionId: 's1' as never }),
      },
    })
    const { server } = await boot(api)
    const client = clientFor(server)
    const created = await client.session.create({ agent: 'minimal' })
    expect(created.id).toBe('s1')
    const listed = await client.session.list()
    expect(listed.data.map((entry) => entry.id)).toContain('s1')
  })

  it('returns the session message list in the client envelope', async () => {
    const api = fakeApi({
      sessionController: {
        ...fakeApi().sessionController,
        history: async () => ({
          events: [
            { event: makeUserEvent('hello', 'msg-u1') },
            { event: makeAssistantEvent([{ type: 'text', text: 'hi' }], 'msg-a1') },
          ],
          hasMore: false,
        }),
      },
    })
    const { server } = await boot(api)
    const client = clientFor(server)
    const messages = await client.message.list({ sessionID: 's1' })
    expect(messages.data.length).toBe(2)
    const user = messages.data[0]
    if (user?.type === 'user') {
      expect(user.text).toBe('hello')
    } else {
      throw new Error('expected the first message to be a user message')
    }
  })

  it('accepts the v2 prompt body the OpenChamber client sends', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const api = fakeApi({
      sessionController: {
        ...fakeApi().sessionController,
        prompt: async (request: unknown) => {
          calls.push({ method: 'session.prompt', payload: request })
          return { accepted: true } as never
        },
      },
    })
    const { server } = await boot(api)
    const client = clientFor(server)
    const inbox = await client.session.prompt({ sessionID: 's1', text: 'hello' })
    expect(inbox.type).toBe('user')
    expect(inbox.payload.text).toBe('hello')
    expect(calls[0]).toMatchObject({ method: 'session.prompt' })
  })

  it('answers the session action routes with the client envelope', async () => {
    const { server } = await boot()
    const client = clientFor(server)
    expect((await client.session.interrupt({ sessionID: 's1' })).interrupted).toBe(true)
    expect(Array.isArray(await client.session.diff({ sessionID: 's1' }))).toBe(true)
  })

  it('reports the compact conflict the client declares when the session is detached', async () => {
    const { server } = await boot()
    const client = clientFor(server)
    // The client declares 409 for a detached session; dsh refuses the same way.
    await expect(client.session.compact({ sessionID: 's1' })).rejects.toThrow()
  })

  it('answers the interaction reads', async () => {
    const { server } = await boot()
    const client = clientFor(server)
    expect(Array.isArray((await client.permission.request.list()).data)).toBe(true)
    expect(Array.isArray(await client.permission.saved.list())).toBe(true)
    expect(Array.isArray((await client.form.list()).data)).toBe(true)
  })

  it('answers the workspace reads', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-oc-contract-'))
    tempDirs.push(work)
    const { server } = await boot(fakeApi(), work)
    const client = clientFor(server)
    expect(Array.isArray((await client.file.list({ path: '.' })).data)).toBe(true)
    expect(Array.isArray((await client.vcs.status()).data)).toBe(true)
    expect(Array.isArray(await client.worktree.list({ projectID: 'p1' }))).toBe(true)
  })

  it('streams events on the v2 event route', async () => {
    const { server, router } = await boot()
    const client = clientFor(server)
    const seen: string[] = []
    const stream = client.event.subscribe()
    const reader = stream[Symbol.asyncIterator]()
    const next = reader.next()
    // The SSE hub delivers the session status snapshot the bridge already
    // knows about; a host session event produces a second frame.
    hostSessionAddedEvents(router.ctx, { sessionId: 's1', blank: true })
    for (let i = 0; i < 5; i++) {
      const result = await Promise.race([
        next,
        new Promise<{ done: true, value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 1000)),
      ])
      if (result.done) break
      seen.push(result.value.type)
      break
    }
    await reader.return?.()
    expect(seen.length).toBeGreaterThan(0)
  })
})

describe('contract: the tool/result surface dsh 0.2.1 exposes', () => {
  it('reads the call id from the message, not from a content block', () => {
    const event = sessionEvent('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'tool-msg-1' as never,
        role: 'tool',
        toolCallId: 'c1' as never,
        content: [{ type: 'text', text: 'done' }],
        source: { kind: 'tool', callId: 'c1' as never },
      },
    }, 5, 1500)
    const message = (event.data as { message: { toolCallId?: unknown; source?: { callId?: unknown } } }).message
    expect(String(message.toolCallId ?? message.source?.callId)).toBe('c1')
  })
})
