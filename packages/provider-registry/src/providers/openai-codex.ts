import type { ReasoningEffort } from '../schemas/enums'
import { defineProvider } from './types'
import { openaiResponsesSummaryWire } from './wires'

// Codex defaults and effort levels come from openai/codex's models-manager/models.json.
const models: Array<{
  modelId: string
  apiModelId: string
  defaultEffort: ReasoningEffort
  efforts: ReasoningEffort[]
  contextWindow: number
  supportsFastMode?: boolean
}> = [
  {
    modelId: 'gpt-6-astra',
    apiModelId: 'gpt-6-astra',
    defaultEffort: 'low',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contextWindow: 272000,
    supportsFastMode: true
  },
  {
    modelId: 'gpt-5-6-sol',
    apiModelId: 'gpt-5.6-sol',
    defaultEffort: 'low',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contextWindow: 272000,
    supportsFastMode: true
  },
  {
    modelId: 'gpt-5-6-terra',
    apiModelId: 'gpt-5.6-terra',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contextWindow: 272000,
    supportsFastMode: true
  },
  {
    modelId: 'gpt-5-6-luna',
    apiModelId: 'gpt-5.6-luna',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contextWindow: 272000,
    supportsFastMode: true
  },
  {
    modelId: 'gpt-5-5',
    apiModelId: 'gpt-5.5',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contextWindow: 272000,
    supportsFastMode: true
  },
  {
    modelId: 'gpt-5-4',
    apiModelId: 'gpt-5.4',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contextWindow: 272000,
    supportsFastMode: true
  },
  {
    modelId: 'gpt-5-4-mini',
    apiModelId: 'gpt-5.4-mini',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contextWindow: 272000
  },
  {
    modelId: 'gpt-5-3-codex-spark',
    apiModelId: 'gpt-5.3-codex-spark',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contextWindow: 128000
  }
]

export default defineProvider({
  id: 'openai-codex',
  name: 'OpenAI Codex',
  availableInEditions: ['global'],
  defaultChatEndpoint: 'openai-responses',
  modelListSource: 'registry',
  authMethods: ['oauth'],
  fastMode: { transport: 'openai-priority' },
  endpointConfigs: {
    'openai-responses': {
      adapterFamily: 'openai',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      reasoningFormat: { type: 'openai-responses', wire: openaiResponsesSummaryWire }
    }
  },
  serverTools: [
    {
      id: 'web-search',
      modelScope: 'model-dependent',
      modelIds: models.map(({ modelId }) => modelId),
      endpointTypes: ['openai-responses']
    }
  ],
  metadata: {
    website: {
      official: 'https://openai.com/codex',
      docs: 'https://developers.openai.com/codex/models'
    }
  },
  overrides: models.map(({ modelId, apiModelId, defaultEffort, efforts, contextWindow, supportsFastMode }) => ({
    modelId,
    apiModelId,
    ...(supportsFastMode ? { supportsFastMode } : {}),
    limits: { contextWindow },
    endpointTypes: ['openai-responses'],
    reasoningContracts: {
      'openai-responses': {
        support: {
          controls: [{ kind: 'effort', values: efforts, default: defaultEffort }],
          defaultEffort
        }
      }
    }
  }))
})
