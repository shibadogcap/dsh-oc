import { afterEach, describe, expect, it } from 'vitest'
import { createBridgeRouter, type BridgeRouter } from '../../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../../src/bridge/http.js'
import type { BridgeApi } from '../../src/bridge/rpc.js'
import type { BridgeGlobalEvent } from '../../src/bridge/events.js'
import { fakeApi, makeAssistantEvent, makeUserEvent, okRpc, sessionEvent } from '../helpers.js'

// OpenCode's revert boundary is exclusive in both shapes that use it:
//
// - `session.revert.stage` names the message the transcript is cut at, and
//   `session.revert.commit` deletes that message and everything after it.
// - `session.fork` with `before` copies the messages before the named one.
//
// dsh's `session.fork` takes an inclusive event seq, so the bridge has to
// move the cut one event back. These tests pin that behaviour and the three
// `session.revert.*` events the 2.x clients read.
const servers: BridgeServerHandle[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function request(
  server: BridgeServerHandle,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(server.url + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

/** Collect the types of every event the bridge broadcasts. */
function captureEvents(router: BridgeRouter): Array<{ type: string; data: Record<string, unknown> }> {
  const hub = router.ctx.hub
  const originalBroadcast = hub.broadcast.bind(hub)
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  ;(hub as unknown as {
    broadcast(events: Array<BridgeGlobalEvent>): void
  }).broadcast = (batch) => {
    for (const event of batch) {
      events.push({
        type: String(event.payload.type),
        data: event.payload.data as Record<string, unknown>,
      })
    }
    originalBroadcast(batch as never)
  }
  return events
}

/**
 * A session whose history is one turn: a user message at seq 2 and the
 * assistant reply at seq 3. The fork of a boundary at the user message has
 * to cut at seq 1, the fork of a boundary at the assistant message at seq 2.
 */
function historyApi(base: BridgeApi, calls: Array<{ method: string; payload: unknown }>): BridgeApi {
  return {
    ...base,
    sessionController: {
      ...base.sessionController,
      fork: async (request) => {
        calls.push({ method: 'session.fork', payload: request })
        return okRpc({ sessionId: 'fork-session' as never })
      },
      list: async () => okRpc({ items: [] }),
      history: async () => okRpc({
        events: [
          { event: sessionEvent('turn/start', { turn: 1 }, 1, 900) },
          { event: makeUserEvent('hello', 'msg-user-1', 1000) },
          { event: makeAssistantEvent([{ type: 'text', text: 'hi' }], 'msg-assistant-1', 1100) },
        ],
        hasMore: false,
      }),
    },
  }
}

describe('bridge: the OpenCode 2.x revert boundary', () => {
  it('stages the boundary and publishes session.revert.staged', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const api = historyApi(fakeApi(), calls)
    const router = createBridgeRouter(api, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)
    const events = captureEvents(router)

    const response = await request(server, 'POST', '/api/session/s1/revert/stage', {
      messageID: 'msg-user-1',
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { messageID: 'msg-user-1' } })

    const staged = events.find((event) => event.type === 'session.revert.staged')
    expect(staged).toBeDefined()
    expect(staged?.data).toMatchObject({
      sessionID: 's1',
      revert: { messageID: 'msg-user-1' },
    })
  })

  it('reports the staged boundary on the session record', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const api = historyApi(fakeApi(), calls)
    const router = createBridgeRouter(api, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)

    const before = await request(server, 'GET', '/api/session/s1')
    expect(before.body).not.toMatchObject({ data: { revert: expect.anything() } })

    await request(server, 'POST', '/api/session/s1/revert/stage', { messageID: 'msg-user-1' })
    const after = await request(server, 'GET', '/api/session/s1')
    expect(after.body).toMatchObject({ data: { revert: { messageID: 'msg-user-1' } } })
  })

  it('clears the boundary and publishes session.revert.cleared', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const api = historyApi(fakeApi(), calls)
    const router = createBridgeRouter(api, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)
    const events = captureEvents(router)

    await request(server, 'POST', '/api/session/s1/revert/stage', { messageID: 'msg-user-1' })
    const response = await request(server, 'DELETE', '/api/session/s1/revert')
    expect(response.status).toBe(204)
    expect(events.some((event) => event.type === 'session.revert.cleared')).toBe(true)

    const after = await request(server, 'GET', '/api/session/s1')
    expect(after.body).not.toMatchObject({ data: { revert: expect.anything() } })
  })

  it('cuts the fork before the boundary message and publishes session.revert.committed', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const api = historyApi(base, calls)
    const forked: string[] = []
    const apiWithRewind: BridgeApi = {
      ...api,
      rewind: {
        fork: async (sessionId, atSeq) => {
          forked.push(`${sessionId}@${atSeq}`)
          return 'fork-session'
        },
        resolveAlias: (sessionId) => sessionId,
        setAlias: () => {},
        filesAfter: () => [],
        restoreFilesAfter: () => [],
        undoRestore: () => [],
        commitRestore: () => {},
        forgetFiles: () => {},
      },
    }
    const router = createBridgeRouter(apiWithRewind, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)
    const events = captureEvents(router)

    await request(server, 'POST', '/api/session/s1/revert/stage', { messageID: 'msg-user-1' })
    const response = await request(server, 'POST', '/api/session/s1/revert/commit')
    expect(response.status).toBe(204)

    // The user message sits at event seq 2, so the fork cuts at seq 1: the
    // message itself and everything after it are dropped.
    expect(forked).toEqual(['s1@1'])
    const committed = events.find((event) => event.type === 'session.revert.committed')
    expect(committed?.data).toMatchObject({ sessionID: 's1', to: 'msg-user-1' })
  })

  it('cuts the fork before an assistant message at the end of the turn', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const api = historyApi(base, calls)
    const forked: string[] = []
    const apiWithRewind: BridgeApi = {
      ...api,
      rewind: {
        fork: async (sessionId, atSeq) => {
          forked.push(`${sessionId}@${atSeq}`)
          return 'fork-session'
        },
        resolveAlias: (sessionId) => sessionId,
        setAlias: () => {},
        filesAfter: () => [],
        restoreFilesAfter: () => [],
        undoRestore: () => [],
        commitRestore: () => {},
        forgetFiles: () => {},
      },
    }
    const router = createBridgeRouter(apiWithRewind, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)

    await request(server, 'POST', '/api/session/s1/revert/stage', { messageID: 'msg-assistant-1' })
    await request(server, 'POST', '/api/session/s1/revert/commit')

    // The assistant message sits at event seq 3, so the fork cuts at seq 2
    // and keeps the user message.
    expect(forked).toEqual(['s1@2'])
  })

  it('keeps the session id while the transcript moves to the fork', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    // The fork has the trimmed history; the source keeps the full one.
    const histories: Record<string, unknown[]> = {
      s1: [
        { event: sessionEvent('turn/start', { turn: 1 }, 1, 900) },
        { event: makeUserEvent('hello', 'msg-user-1', 1000) },
        { event: makeAssistantEvent([{ type: 'text', text: 'hi' }], 'msg-assistant-1', 1100) },
      ],
      'fork-session': [
        { event: sessionEvent('turn/start', { turn: 1 }, 1, 900) },
        { event: makeUserEvent('hello', 'msg-user-1', 1000) },
      ],
    }
    const api: BridgeApi = {
      ...base,
      sessionController: {
        ...base.sessionController,
        fork: async (request) => {
          calls.push({ method: 'session.fork', payload: request })
          return okRpc({ sessionId: 'fork-session' as never })
        },
        list: async () => okRpc({
          items: [
            { sessionId: 's1' as never, updatedAt: 2000, running: false, blank: false, agentAvailable: true, cwd: '/work' },
            { sessionId: 'fork-session' as never, updatedAt: 3000, running: false, blank: false, agentAvailable: true, cwd: '/work' },
          ],
        }),
        history: async (request) => okRpc({
          events: histories[String((request as { sessionId?: string }).sessionId)] ?? [],
          hasMore: false,
        } as never),
      },
      rewind: {
        fork: async () => 'fork-session',
        resolveAlias: (sessionId) => sessionId,
        setAlias: () => {},
        filesAfter: () => [],
        restoreFilesAfter: () => [],
        undoRestore: () => [],
        commitRestore: () => {},
        forgetFiles: () => {},
      },
    }
    const router = createBridgeRouter(api, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)

    const before = await request(server, 'GET', '/api/session/s1/message')
    expect((before.body as { data: unknown[] }).data).toHaveLength(2)

    await request(server, 'POST', '/api/session/s1/revert/stage', { messageID: 'msg-assistant-1' })
    await request(server, 'POST', '/api/session/s1/revert/commit')

    // The transcript is trimmed, but the session keeps the id the client
    // knows: the fork is published under the original id.
    const after = await request(server, 'GET', '/api/session/s1/message')
    expect((after.body as { data: unknown[] }).data).toHaveLength(1)

    const list = await request(server, 'GET', '/api/session')
    const ids = (list.body as { data: Array<{ id: string }> }).data.map((item) => item.id)
    expect(ids).toContain('s1')
    expect(ids).not.toContain('fork-session')
  })

  it('keeps the boundary turn files when the boundary is the assistant reply', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const api = historyApi(base, calls)
    const restored: Array<[string, number, boolean]> = []
    const apiWithRewind: BridgeApi = {
      ...api,
      rewind: {
        fork: async () => 'fork-session',
        resolveAlias: (sessionId) => sessionId,
        setAlias: () => {},
        filesAfter: () => [],
        restoreFilesAfter: (sessionId, boundary) => {
          restored.push([sessionId, boundary.turn, boundary.includeTurn])
          return []
        },
        undoRestore: () => [],
        commitRestore: () => {},
        forgetFiles: () => {},
      },
    }
    const router = createBridgeRouter(apiWithRewind, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)

    await request(server, 'POST', '/api/session/s1/revert/stage', { messageID: 'msg-assistant-1' })
    // The assistant reply is the last message of its turn, so the turn's own
    // file changes stay on disk.
    expect(restored).toEqual([['s1', 1, false]])
  })

  it('rolls the files of the later turns back when the revert is staged', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const base = fakeApi()
    const api = historyApi(base, calls)
    const restored: Array<[string, number, boolean]> = []
    const undone: string[] = []
    const apiWithRewind: BridgeApi = {
      ...api,
      rewind: {
        fork: async () => 'fork-session',
        resolveAlias: (sessionId) => sessionId,
        setAlias: () => {},
        filesAfter: (_sessionId, boundary) => {
          restored.push([_sessionId, boundary.turn, boundary.includeTurn])
          return [
            { file: 'a.ts', patch: '--- a/a.ts\n', additions: 1, deletions: 0, status: 'modified' as const },
          ]
        },
        restoreFilesAfter: (sessionId, boundary) => {
          restored.push([sessionId, boundary.turn, boundary.includeTurn])
          return ['a.ts']
        },
        undoRestore: (sessionId) => {
          undone.push(sessionId)
          return ['a.ts']
        },
        commitRestore: () => {},
        forgetFiles: () => {},
      },
    }
    const router = createBridgeRouter(apiWithRewind, { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)

    const staged = await request(server, 'POST', '/api/session/s1/revert/stage', {
      messageID: 'msg-user-1',
    })
    // The boundary is the user prompt of turn 1, so the files of turn 1 roll
    // back with it: the assistant reply comes after the prompt.
    expect(restored).toEqual([
      ['s1', 1, true],
      ['s1', 1, true],
    ])
    expect(staged.body).toMatchObject({
      data: {
        messageID: 'msg-user-1',
        files: [{ file: 'a.ts', additions: 1, deletions: 0, status: 'modified' }],
      },
    })

    await request(server, 'DELETE', '/api/session/s1/revert')
    expect(undone).toEqual(['s1'])
  })
})
