import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  assistantMessageFromEvent,
  convertMessagesV2,
  userMessageFromEvent,
} from '../../src/bridge/convert/message.js'
import { makeAssistantEvent, makeUserEvent, sessionEvent } from '../helpers.js'

const opts = { sessionId: 's1', cwd: '/work' }

function chunkRow(
  type: 'text-chunks' | 'reasoning-chunks',
  texts: string[],
  time0: number,
  seq = 10,
  index = 0,
  turn = 1,
  step = 1,
): SessionEvent {
  return {
    type,
    seq,
    time: time0,
    time0,
    data: {
      turn,
      step,
      index,
      dt: texts.length > 1 ? texts.slice(1).map(() => 0) : [],
      texts,
    },
  } as unknown as SessionEvent
}

describe('convert/message (SSE projection)', () => {
  it('exposes single-event converters for SSE', () => {
    const user = userMessageFromEvent(makeUserEvent('hi'), opts)
    expect(user.info.id).toBe('msg-user-1')
    const assistant = assistantMessageFromEvent(makeAssistantEvent([{ type: 'text', text: 'ok' }]), opts)
    expect(assistant.info.id).toBe('msg-assistant-1')
    expect(assistant.parts[0]).toMatchObject({ type: 'text', text: 'ok' })
  })
})

describe('convert/message (v2)', () => {
  it('records anchor event seqs alongside v2 messages', () => {
    const anchorSeqs: number[] = []
    const messages = convertMessagesV2([
      makeUserEvent('hello', 'm1', 1000),
      makeAssistantEvent([
        { type: 'text', text: 'answer' },
      ], 'm2', 1100),
    ], opts, undefined, anchorSeqs)
    expect(messages).toHaveLength(2)
    expect(anchorSeqs).toEqual([2, 3])
  })

  it('converts user and assistant events to SessionMessage[]', () => {
    const messages = convertMessagesV2([
      makeUserEvent('hello', 'm1', 1000),
      makeAssistantEvent([
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: 'c9' as never, name: 'bash', arguments: '{}' },
      ], 'm2', 1100, { inputTokens: 10, outputTokens: 5 }),
    ], opts)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ type: 'user', text: 'hello' })
    expect(messages[1]).toMatchObject({
      type: 'assistant',
      agent: 'build',
      model: { id: 'deepseek-chat', providerID: 'deepseek' },
    })
    const assistant = messages[1]
    if (assistant?.type === 'assistant') {
      expect(assistant.content.map((part) => part.type)).toEqual(['text', 'tool'])
      expect(assistant.tokens).toEqual({
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      })
    }
  })

  it('updates a v2 tool part when the result arrives', () => {
    const messages = convertMessagesV2([
      makeAssistantEvent([
        { type: 'tool-call', id: 'c3' as never, name: 'bash', arguments: '{}' },
      ], 'm3', 1000),
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 't3' as never,
          role: 'user',
          toolCallId: 'c3' as never,
          content: [{ type: 'text', text: 'out' }],
          source: { kind: 'tool', callId: 'c3' as never },
        },
      }, 4, 1200),
    ], opts)
    const assistant = messages[0]
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type === 'assistant') {
      const tool = assistant.content.find((part) => part.type === 'tool')
      expect(tool?.type).toBe('tool')
      if (tool?.type === 'tool') {
        expect(tool.state.status).toBe('completed')
        if (tool.state.status === 'completed') {
          expect(tool.state.content[0]).toMatchObject({ type: 'text', text: 'out' })
        }
        expect(tool.time.completed).toBe(1200)
      }
    }
  })

  it('fixes v2 assistant created/completed and reasoning part times', () => {
    const messages = convertMessagesV2([
      sessionEvent('turn/start', { turn: 1 }, 1, 1000),
      makeAssistantEvent(
        [
          { type: 'reasoning', text: 'think' },
          { type: 'text', text: 'answer' },
        ],
        'm-v2-duration',
        2000,
        undefined,
        [
          { type: 'chunk', time: 1100, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        ],
      ),
    ], opts)
    const assistant = messages[0]
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type === 'assistant') {
      expect(assistant.time).toEqual({ created: 1100, completed: 2000 })
      const reasoning = assistant.content.find((part) => part.type === 'reasoning')
      expect(reasoning?.type).toBe('reasoning')
      if (reasoning?.type === 'reasoning') {
        expect(reasoning.time).toEqual({ created: 1100, completed: 2000 })
      }
    }
  })

  it('keeps a v2 no-chunk assistant strictly after a same-time user', () => {
    const messages = convertMessagesV2([
      sessionEvent('turn/start', { turn: 1 }, 1, 1010),
      makeUserEvent('hello', 'm-user-order-v2', 1010),
      makeAssistantEvent([{ type: 'text', text: 'answer' }], 'm-assistant-order-v2', 1200),
    ], opts)
    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
    expect(messages[1]?.time.created).toBeGreaterThanOrEqual(messages[0]?.time.created ?? 0)
    expect(messages[1]?.time.created).toBe(1011)
  })

  it('hydrates v2 in-flight text/reasoning chunks as a provisional assistant message', () => {
    const events = [
      makeUserEvent('hello', 'm-user', 1000),
      sessionEvent('turn/start', { turn: 1 }, 1, 1010),
      chunkRow('text-chunks', ['hel'], 1020, 10, 0),
      chunkRow('text-chunks', ['lo '], 1030, 11, 0),
      chunkRow('reasoning-chunks', ['think'], 1040, 12, 1),
    ]
    const messages = convertMessagesV2(events, opts)
    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
    const assistant = messages[1]
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type === 'assistant') {
      expect(assistant.id).toBe('msg_pending:s1:1:1')
      expect(assistant.time).toEqual({ created: 1020 })
      expect(assistant.time.completed).toBeUndefined()
      expect(assistant.content.map((part) => part.type)).toEqual(['text', 'reasoning'])
      const text = assistant.content[0]
      expect(text?.type).toBe('text')
      if (text?.type === 'text') {
        expect(text.id).toBe('prt_stream:s1:1:1:text:0')
        expect(text.text).toBe('hello ')
      }
      const reasoning = assistant.content[1]
      expect(reasoning?.type).toBe('reasoning')
      if (reasoning?.type === 'reasoning') {
        expect(reasoning.id).toBe('prt_stream:s1:1:1:reasoning:1')
        expect(reasoning.text).toBe('think')
        expect(reasoning.time).toEqual({ created: 1040 })
        expect(reasoning.time?.completed).toBeUndefined()
      }
    }
  })

  it('replaces the v2 provisional assistant message once the final message arrives', () => {
    const events = [
      makeUserEvent('hello', 'm-user', 1000),
      sessionEvent('turn/start', { turn: 1 }, 1, 1010),
      chunkRow('text-chunks', ['hel'], 1020, 10, 0),
      chunkRow('text-chunks', ['lo '], 1030, 11, 0),
      chunkRow('reasoning-chunks', ['think'], 1040, 12, 1),
      makeAssistantEvent([
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'hello ' },
      ], 'm-final', 2000),
    ]
    const messages = convertMessagesV2(events, opts)
    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
    expect(messages[1]?.type).toBe('assistant')
    if (messages[1]?.type === 'assistant') {
      expect(messages[1].id).toBe('m-final')
      expect(messages[1].time).toEqual({ created: 1020, completed: 2000 })
    }
    expect(messages.some((message) => message.id.startsWith('msg_pending:'))).toBe(false)
  })

  it('returns [] for empty history', () => {
    expect(convertMessagesV2([], opts)).toEqual([])
  })
})
