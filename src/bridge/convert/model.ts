import type {
  ModelCatalogModel,
  ModelProviderGroup,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  ModelInfo as ClientModelInfo,
  ProviderInfo as ClientProviderInfo,
} from '@opencode/client'
import {
  externalProviderId,
  externalProviderName,
} from './common.js'

const DEFAULT_CONTEXT = 128000
const DEFAULT_OUTPUT = 8192

/** Known dsh-official model capacities, matching dsh-llm-deepseek defaults. */
const DEEPSEEK_LIMITS: Record<string, { context: number; output: number }> = {
  'deepseek-v4-flash': { context: 1_000_000, output: 256_000 },
  'deepseek-v4-pro': { context: 1_000_000, output: 256_000 },
}

function limitFor(groupId: string, modelId: string) {
  if (groupId === 'deepseek-official') {
    const known = DEEPSEEK_LIMITS[modelId]
    if (known) return known
  }
  return { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT }
}

/**
 * Match opencode's DeepSeek naming for the official dsh route:
 * `DeepSeek-V4-Flash` → `DeepSeek V4 Flash`.
 */
function modelNameFor(groupId: string, modelId: string, modelName?: string) {
  if (groupId === 'deepseek-official') return (modelName ?? modelId).replaceAll('-', ' ')
  return modelName ?? modelId
}

function v2VariantsFor(model: ModelCatalogModel): ClientModelInfo['variants'] {
  return (model.reasoning?.efforts ?? []).map((effort) => ({
    id: effort.id,
    headers: {},
    body: { reasoningEffort: effort.id, name: effort.name },
  }))
}

/** `GET /api/model` → `ClientModelInfo[]`. */
export function convertToV2Models(groups: readonly ModelProviderGroup[]): ClientModelInfo[] {
  return groups.flatMap((group) => {
    const providerId = externalProviderId(group.id)
    return group.models.map((model) => {
      const limit = limitFor(group.id, model.id)
      return {
        id: model.id,
        modelID: model.id,
        providerID: providerId,
        name: modelNameFor(group.id, model.id, model.name),
        api: {
          id: providerId,
          type: 'native',
          url: '',
          settings: {},
        },
        capabilities: {
          tools: true,
          input: ['text'],
          output: ['text'],
        },
        request: { headers: {}, body: {} },
        variants: v2VariantsFor(model),
        time: { released: 0 },
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
        status: 'active',
        enabled: true,
        limit,
      }
    })
  })
}

/** `GET /api/provider` → `ClientProviderInfo[]`. */
export function convertToV2Providers(groups: readonly ModelProviderGroup[]): ClientProviderInfo[] {
  return groups.map((group) => ({
    id: externalProviderId(group.id),
    name: externalProviderName(group.id, group.name),
    activation: 'enabled',
    package: '@deepseek-ai/dsh',
    api: {
      type: 'native',
      url: '',
      settings: {},
    },
    request: { headers: {}, body: {} },
  }))
}
