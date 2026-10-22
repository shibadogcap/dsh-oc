import { describe, expect, it } from 'vitest'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  convertToV2Models,
  convertToV2Providers,
} from '../../src/bridge/convert/model.js'

const groups: ModelProviderGroup[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek Official',
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
  },
]

describe('convert/model', () => {
  it('exposes deepseek-official as deepseek and keeps other ids', () => {
    const providers = convertToV2Providers(groups)
    expect(providers.map((provider) => provider.id)).toEqual(['deepseek', 'openai'])
    expect(providers[0]?.name).toBe('DeepSeek')
  })

  it('fills safe default limits and capabilities', () => {
    const model = convertToV2Models(groups)[0]
    expect(model?.limit).toEqual({ context: 128000, output: 8192 })
    expect(model?.capabilities).toEqual({ tools: true, input: ['text'], output: ['text'] })
    expect(model?.status).toBe('active')
  })

  it('uses dsh-llm-deepseek capacities and opencode naming for v4 models', () => {
    const deepseekGroups: ModelProviderGroup[] = [
      {
        id: 'deepseek-official',
        name: 'DeepSeek Official',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
      },
    ]
    expect(convertToV2Models(deepseekGroups)[0]).toMatchObject({
      name: 'DeepSeek V4 Flash',
      limit: { context: 1_000_000, output: 256_000 },
    })
  })

  it('maps dsh reasoning efforts to v2 variant rows', () => {
    const deepseekGroups: ModelProviderGroup[] = [
      {
        id: 'deepseek-official',
        name: 'DeepSeek Official',
        models: [{
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          reasoning: {
            efforts: [
              { id: 'off', name: 'Off' },
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'high',
          },
        }],
      },
    ]
    expect(convertToV2Models(deepseekGroups)[0]?.variants).toEqual([
      { id: 'off', headers: {}, body: { reasoningEffort: 'off', name: 'Off' } },
      { id: 'high', headers: {}, body: { reasoningEffort: 'high', name: 'High' } },
      { id: 'max', headers: {}, body: { reasoningEffort: 'max', name: 'Max' } },
    ])
  })

  it('converts to v2 ModelV2Info[] and ProviderV2Info[]', () => {
    const models = convertToV2Models(groups)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      id: 'deepseek-chat',
      providerID: 'deepseek',
      enabled: true,
      limit: { context: 128000, output: 8192 },
    })
    expect(models[0]?.capabilities).toEqual({ tools: true, input: ['text'], output: ['text'] })
    const providers = convertToV2Providers(groups)
    expect(providers).toHaveLength(2)
    expect(providers[0]).toMatchObject({ id: 'deepseek', name: 'DeepSeek' })
  })

  it('handles an empty catalog', () => {
    expect(convertToV2Models([])).toEqual([])
    expect(convertToV2Providers([])).toEqual([])
  })
})
