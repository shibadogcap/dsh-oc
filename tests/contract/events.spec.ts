// Contract: the OpenCode 2.x native event vocabulary the bridge publishes.
//
// The OpenChamber 2.5 UI reduces the 2.x wire events (`session.text.delta`,
// `session.tool.called`, `session.step.ended`, ...); it does not understand
// the 1.18.18 names the bundled TUI reads. These tests feed dsh events
// through the bridge translator and assert the 2.x event names and the
// `data` payload each one carries.
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { OpenCode } from '@opencode/client'
import { MuxEventTranslator, type BridgeGlobalEvent } from '../../src/bridge/events.js'
import { InteractionState } from '../../src/bridge/state.js'
import { createBridgeRouter } from '../../src/bridge/router.js'
import { startBridgeServer } from '../../src/bridge/http.js'
import type { BridgeFrame } from '../../src/bridge/dsh-types.js'
import { fakeApi, makeAssistantEvent, makeUserEvent, sessionEvent } from '../helpers.js'

interface Translator {
  state: InteractionState
  /**
   * The 2.x-native events: the names the 1.18.18 vocabulary does not use
   * (`session.text.delta`, `session.tool.called`, ...).
   */
  native: BridgeGlobalEvent[]
  /** The 1.18.18 events the translator published. */
  events: BridgeGlobalEvent[]
  translate(frames: BridgeFrame[]): BridgeGlobalEvent[]
  /** The names of the 2.x-native events published so far. */
  types(): string[]
  /**
   * The 2.x payload of the named event. The events both vocabularies name
   * (`permission.asked`, `session.status`, ...) carry the 2.x payload in
   * their `data`; the 2.x-native ones carry it in the native channel.
   */
  data(type: string): Array<Record<string, unknown>>
  /** The first 2.x payload of the named event. */
  first(type: string): Record<string, unknown>
}

function translator(state = new InteractionState()): Translator {
  const native: BridgeGlobalEvent[] = []
  const instance = new MuxEventTranslator({
    cwd: '/work',
    state,
    defaultModel: { providerID: 'deepseek', modelID: 'deepseek-chat' },
    log: () => {},
    onV2Event: (event) => native.push(event),
  })
  const events: BridgeGlobalEvent[] = []
  const all = (): BridgeGlobalEvent[] => [...native, ...events]
  return {
    state,
    native,
    events,
    translate: (frames) => {
      const translated = frames.flatMap((frame) => instance.translate(frame))
      events.push(...translated)
      return translated
    },
    types: () => native.map((event) => event.payload.type),
    data: (type) => all()
      .filter((event) => event.payload.type === type)
      .map((event) => event.payload.data),
    first: (type) => {
      const found = all().find((event) => event.payload.type === type)
      if (found === undefined) throw new Error(`no 2.x event named ${type} in ${all().map((e) => e.payload.type).join(', ')}`)
      return found.payload.data
    },
  }
}

function frame(payload: BridgeFrame): BridgeFrame {
  return payload
}

function sessionFrame(sessionId: string, event: SessionEvent): BridgeFrame {
  return frame({ type: 'session/event', sessionId, event } as unknown as BridgeFrame)
}

/** One packed dsh chunk row (`text-chunks` / `reasoning-chunks`). */
function chunkRow(
  type: 'text-chunks' | 'reasoning-chunks',
  texts: string[],
  options: { index?: number; turn?: number; step?: number; seq?: number; time?: number } = {},
): SessionEvent {
  const time = options.time ?? 1200
  return sessionEvent(type, {
    turn: options.turn ?? 1,
    step: options.step ?? 1,
    index: options.index ?? 0,
    dt: [],
    texts,
  }, options.seq ?? 10, time)
}

describe('contract: the OpenCode 2.x event vocabulary', () => {
  it('opens and closes a turn with the 2.x execution events', () => {
    const { translate, types, data } = translator()
    translate([
      sessionFrame('s1', sessionEvent('turn/start', { turn: 1 }, 1, 1100)),
      sessionFrame('s1', sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 1300)),
    ])
    expect(types()).toContain('session.execution.started')
    expect(types()).toContain('session.execution.succeeded')
    expect(data('session.execution.started')).toEqual([{ sessionID: 's1' }])
    expect(data('session.execution.succeeded')).toEqual([{ sessionID: 's1' }])
  })

  it('reports a failed turn with the 2.x execution failure', () => {
    const { translate, types, first } = translator()
    translate([
      sessionFrame('s1', sessionEvent('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'provider-unavailable', message: 'the provider is down' } },
      }, 2, 1300)),
    ])
    expect(types()).toContain('session.execution.failed')
    expect(first('session.execution.failed')).toEqual({
      sessionID: 's1',
      error: { type: 'provider-unavailable', message: 'the provider is down' },
    })
  })

  it('reports an aborted turn as an interrupted execution', () => {
    const { translate, types, first } = translator()
    translate([
      sessionFrame('s1', sessionEvent('turn/end', {
        turn: 1,
        reason: { kind: 'aborted', reason: { kind: 'user' } },
      }, 2, 1300)),
    ])
    expect(types()).toContain('session.execution.interrupted')
    expect(first('session.execution.interrupted')).toEqual({ sessionID: 's1', reason: 'user' })
  })

  it('streams a text block as the 2.x text events of one step', () => {
    const { translate, types, data } = translator()
    translate([
      sessionFrame('s1', chunkRow('text-chunks', ['hel'])),
      sessionFrame('s1', chunkRow('text-chunks', ['lo'], { seq: 11, time: 1250 })),
    ])
    expect(types()).toEqual([
      'session.step.started',
      'session.text.started',
      'session.text.delta',
      'session.text.delta',
    ])
    const started = data('session.text.started')[0] as Record<string, unknown>
    expect(started.ordinal).toBe(0)
    expect(started.sessionID).toBe('s1')
    expect(typeof started.assistantMessageID).toBe('string')
    expect(data('session.text.delta')).toEqual([
      { ...started, delta: 'hel' },
      { ...started, delta: 'lo' },
    ])
  })

  it('numbers the text and the reasoning blocks of a message separately', () => {
    const { translate, data } = translator()
    translate([
      sessionFrame('s1', chunkRow('reasoning-chunks', ['think'], { index: 0 })),
      sessionFrame('s1', chunkRow('text-chunks', ['one'], { index: 1, seq: 11 })),
      sessionFrame('s1', chunkRow('text-chunks', ['two'], { index: 2, seq: 12 })),
    ])
    // The reasoning block is the first block of the message but the first
    // reasoning block too; the text blocks count on their own.
    expect((data('session.reasoning.started')[0] as Record<string, unknown>).ordinal).toBe(0)
    expect((data('session.text.started')[0] as Record<string, unknown>).ordinal).toBe(0)
    expect((data('session.text.started')[1] as Record<string, unknown>).ordinal).toBe(1)
  })

  it('closes the blocks and the step when the assistant message lands', () => {
    const { translate, types, data } = translator()
    translate([
      sessionFrame('s1', chunkRow('text-chunks', ['hi'])),
      sessionFrame('s1', makeAssistantEvent([{ type: 'text', text: 'hi' }], 'msg-a1')),
    ])
    expect(types()).toContain('session.text.ended')
    expect(types()).toContain('session.step.ended')
    expect(data('session.text.ended')[0]).toMatchObject({ ordinal: 0, text: 'hi' })
    const ended = data('session.step.ended')[0] as Record<string, unknown>
    expect(ended.finish).toBe('stop')
    expect(ended.sessionID).toBe('s1')
    expect(typeof ended.assistantMessageID).toBe('string')
    expect(ended.tokens).toMatchObject({ input: 0, output: 0 })
  })

  it('opens a step for a message that never streamed', () => {
    const { translate, types, data } = translator()
    translate([
      sessionFrame('s1', makeAssistantEvent([{ type: 'text', text: 'cold' }], 'msg-a1')),
    ])
    expect(types()).toContain('session.step.started')
    expect(types()).toContain('session.text.started')
    expect(types()).toContain('session.text.ended')
    expect(data('session.text.ended')[0]).toMatchObject({ ordinal: 0, text: 'cold' })
  })

  it('streams a tool call as the 2.x tool input events', () => {
    const { translate, types, data } = translator()
    translate([
      sessionFrame('s1', sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'bash',
        arguments: '{"command":"ls"}',
      }, 3, 1200)),
    ])
    expect(types()).toContain('session.tool.input.started')
    expect(types()).toContain('session.tool.input.ended')
    expect(types()).toContain('session.tool.called')
    const started = data('session.tool.input.started')[0] as Record<string, unknown>
    expect(started).toMatchObject({ sessionID: 's1', id: 'c1', name: 'bash' })
    expect(data('session.tool.input.ended')[0]).toMatchObject({ id: 'c1', text: '{"command":"ls"}' })
    expect(data('session.tool.called')[0]).toMatchObject({
      id: 'c1',
      name: 'bash',
      input: { command: 'ls' },
    })
  })

  it('reports a tool result as the 2.x tool success and failure', () => {
    const { translate, types, data } = translator()
    translate([
      sessionFrame('s1', sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'bash',
        arguments: '{"command":"ls"}',
      }, 3, 1200)),
      sessionFrame('s1', sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 't1' as never,
          role: 'tool',
          toolCallId: 'c1' as never,
          content: [{ type: 'text', text: 'done' }],
          source: { kind: 'tool', callId: 'c1' as never },
        },
      }, 4, 1300)),
    ])
    expect(types()).toContain('session.tool.success')
    expect(data('session.tool.success')[0]).toMatchObject({
      sessionID: 's1',
      id: 'c1',
      name: 'bash',
      output: 'done',
      executed: true,
    })

    const failed = translator()
    failed.translate([
      sessionFrame('s2', sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'c2',
        name: 'bash',
        arguments: '{"command":"ls"}',
      }, 3, 1200)),
      sessionFrame('s2', sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 't2' as never,
          role: 'tool',
          toolCallId: 'c2' as never,
          content: [{ type: 'text', text: 'denied' }],
          source: { kind: 'tool', callId: 'c2' as never },
        },
        error: { name: 'permission denied', code: 'tool-rejected' },
      }, 4, 1300)),
    ])
    expect(failed.types()).toContain('session.tool.failed')
    expect(failed.data('session.tool.failed')[0]).toMatchObject({
      id: 'c2',
      error: { type: 'tool-rejected', message: 'permission denied' },
    })
  })

  it('delivers the user message to the 2.x inbox', () => {
    const { translate, types, data } = translator()
    translate([sessionFrame('s1', makeUserEvent('hello', 'msg-u1'))])
    expect(types()).toContain('session.inbox.delivered')
    expect(data('session.inbox.delivered')[0]).toEqual({ sessionID: 's1', inboxID: 'msg-u1' })
  })

  it('renames a session and reports the agent and the model switch', () => {
    const { translate, types, data } = translator()
    translate([
      sessionFrame('s1', sessionEvent('session/title', { time: 1200, title: 'Renamed' }, 4, 1200)),
      sessionFrame('s1', sessionEvent('agent-preset/selected', { agentPreset: 'plan' }, 5, 1250)),
      sessionFrame('s1', sessionEvent('model/selection', {
        provider: 'deepseek-official',
        model: 'deepseek-reasoner',
        reasoningEffort: 'high',
      }, 6, 1300)),
    ])
    expect(data('session.renamed')[0]).toEqual({ sessionID: 's1', title: 'Renamed' })
    expect(data('session.agent.selected')[0]).toMatchObject({ sessionID: 's1', agent: 'plan' })
    expect(data('session.model.selected')[0]).toMatchObject({
      sessionID: 's1',
      model: { id: 'deepseek-reasoner', providerID: 'deepseek', variant: 'high' },
    })
    expect(types()).toContain('session.renamed')
  })

  it('asks for a permission with the 2.x permission request', () => {
    const { translate, types, data } = translator()
    translate([
      frame({
        type: 'approval/requested',
        rpcId: 'rpc-approval',
        sessionId: 's1',
        approvalId: 'a1',
        toolName: 'bash',
        callId: 'c1',
      } as unknown as BridgeFrame),
    ])
    expect(data('permission.asked')).toHaveLength(1)
    const asked = data('permission.asked')[0] as Record<string, unknown>
    expect(asked).toMatchObject({ sessionID: 's1', action: 'bash', resources: [] })
    expect(typeof asked.id).toBe('string')
  })

  it('replies to a permission with the 2.x permission reply', () => {
    const { translate, types, data } = translator()
    translate([
      frame({
        type: 'approval/requested',
        rpcId: 'rpc-approval',
        sessionId: 's1',
        approvalId: 'a1',
        toolName: 'bash',
        callId: 'c1',
      } as unknown as BridgeFrame),
      frame({
        type: 'approval/resolved',
        rpcId: 'rpc-approval',
        sessionId: 's1',
        approvalId: 'a1',
        outcome: 'allowed-once',
      } as unknown as BridgeFrame),
    ])
    expect(data('permission.replied')).toHaveLength(1)
    expect(data('permission.replied')[0]).toMatchObject({ sessionID: 's1' })
  })

  it('shows a question as the 2.x form and settles it', () => {
    const { translate, types, data } = translator()
    translate([
      frame({
        type: 'question/requested',
        rpcId: 'rpc-q1',
        sessionId: 's1',
        questions: [{ id: 'dq1', question: 'Go?', options: [{ label: 'Yes' }] }],
      } as unknown as BridgeFrame),
    ])
    expect(types()).toContain('form.created')
    const form = (data('form.created')[0] as { form: Record<string, unknown> }).form
    expect(form).toMatchObject({ sessionID: 's1', title: 'Go?' })
    expect(form.fields).toEqual([
      { key: 'dq1', title: 'Go?', type: 'multiselect', options: [{ value: 'Yes', label: 'Yes' }], maxItems: 1 },
    ])

    translate([
      frame({
        type: 'question/resolved',
        rpcId: 'rpc-q1',
        sessionId: 's1',
        questionRpcId: 'rpc-q1',
        outcome: 'answered',
        answers: [['Yes']],
      } as unknown as BridgeFrame),
    ])
    expect(types()).toContain('form.replied')
    expect(data('form.replied')[0]).toMatchObject({ sessionID: 's1', answer: { dq1: ['Yes'] } })

    const cancelled = translator()
    cancelled.translate([
      frame({
        type: 'question/requested',
        rpcId: 'rpc-q2',
        sessionId: 's1',
        questions: [{ id: 'dq2', question: 'No?', options: [{ label: 'N' }] }],
      } as unknown as BridgeFrame),
      frame({
        type: 'question/resolved',
        rpcId: 'rpc-q2',
        sessionId: 's1',
        questionRpcId: 'rpc-q2',
        outcome: 'cancelled',
      } as unknown as BridgeFrame),
    ])
    expect(cancelled.types()).toContain('form.cancelled')
    expect(cancelled.data('form.cancelled')[0]).toMatchObject({ sessionID: 's1' })
  })

  it('reports a compaction as the 2.x compaction events', () => {
    const { translate, types, data } = translator()
    translate([
      sessionFrame('s1', sessionEvent('compaction/start', { compactionId: 'cp1' }, 4, 1200)),
      sessionFrame('s1', sessionEvent('compaction/summary', {
        compactionId: 'cp1',
        summary: [{ type: 'text', text: 'summary' }],
      }, 5, 1250)),
      sessionFrame('s1', sessionEvent('compaction/end', { compactionId: 'cp1' }, 6, 1300)),
    ])
    expect(types()).toContain('session.compaction.started')
    expect(types()).toContain('session.compaction.delta')
    expect(types()).toContain('session.compaction.ended')
    expect(data('session.compaction.started')[0]).toMatchObject({ sessionID: 's1', reason: 'auto' })
    expect(data('session.compaction.delta')[0]).toEqual({ sessionID: 's1', text: 'summary' })
    expect(data('session.compaction.ended')[0]).toMatchObject({ sessionID: 's1', text: 'summary' })
  })

  it('numbers the durable sequence per session', () => {
    const { translate, native } = translator()
    translate([
      sessionFrame('s1', sessionEvent('turn/start', { turn: 1 }, 1, 1100)),
      sessionFrame('s1', sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, 1300)),
    ])
    const seqs = native.map((event) => event.payload.durable?.seq ?? 0)
    expect(seqs.length).toBeGreaterThan(1)
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]!).toBeGreaterThan(seqs[index - 1]!)
    }
    for (const event of native) {
      expect(event.payload.durable?.aggregateID).toBe('s1')
      expect(event.payload.durable?.version).toBe(1)
    }
  })

  it('carries the 2.x payload of an event that both dialects name', () => {
    const { translate } = translator()
    const events = translate([
      frame({
        type: 'approval/requested',
        rpcId: 'rpc-approval',
        sessionId: 's1',
        approvalId: 'a1',
        toolName: 'bash',
        callId: 'c1',
      } as unknown as BridgeFrame),
    ])
    const asked = events.find((event) => event.payload.type === 'permission.asked')
    expect(asked).toBeDefined()
    // The 1.18.18 TUI reads the 1.x projection, the 2.x client the 2.x one.
    expect(asked?.payload.properties).toHaveProperty('permission', 'bash')
    expect(asked?.payload.data).toMatchObject({ action: 'bash', resources: [] })
  })

  it('publishes the 2.x events of a whole turn in order', () => {
    const { translate, types } = translator()
    translate([
      sessionFrame('s1', sessionEvent('turn/start', { turn: 1 }, 1, 1100)),
      sessionFrame('s1', chunkRow('text-chunks', ['working'])),
      sessionFrame('s1', sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'bash',
        arguments: '{"command":"ls"}',
      }, 3, 1250)),
      sessionFrame('s1', sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 't1' as never,
          role: 'tool',
          toolCallId: 'c1' as never,
          content: [{ type: 'text', text: 'done' }],
          source: { kind: 'tool', callId: 'c1' as never },
        },
      }, 4, 1300)),
      sessionFrame('s1', makeAssistantEvent([{ type: 'text', text: 'working' }], 'msg-a1')),
      sessionFrame('s1', sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5, 1400)),
    ])
    expect(types()).toEqual([
      'session.execution.started',
      'session.step.started',
      'session.text.started',
      'session.text.delta',
      'session.tool.input.started',
      'session.tool.input.ended',
      'session.tool.called',
      'session.tool.progress',
      'session.tool.success',
      'session.text.ended',
      'session.step.ended',
      'session.execution.succeeded',
    ])
  })
})

describe('contract: the 2.x envelope on the wire', () => {
  it('publishes the 2.x event shape the official 2.1.0 client reads', async () => {
    const router = createBridgeRouter(fakeApi(), { cwd: '/work' })
    const server = await startBridgeServer(router)
    try {
      // A running session makes the bridge publish its status snapshot on
      // connect, which proves the SSE connection is live before the turn
      // starts.
      router.ctx.state.setSessionRunning('s1', true, Date.now())
      const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}/` })
      const stream = client.event.subscribe()
      const reader = stream[Symbol.asyncIterator]()
      const first = await reader.next()
      // The 2.x client refuses a stream that does not open this way.
      expect(first.value.type).toBe('server.connected')

      const second = await reader.next()
      expect(second.value.type).toBe('session.status')

      await router.feed({
        type: 'session/event',
        sessionId: 's1',
        event: sessionEvent('turn/start', { turn: 1 }, 1, 1100),
      } as unknown as BridgeFrame)

      const third = await reader.next()
      await reader.return?.()
      // The 2.x client reads the payload of the flat envelope, not the
      // 1.18.18 wrapper.
      expect(third.value.type).toBe('session.execution.started')
      expect(third.value.data).toEqual({ sessionID: 's1' })
      expect(typeof third.value.id).toBe('string')
    } finally {
      await server.close()
    }
  })
})
