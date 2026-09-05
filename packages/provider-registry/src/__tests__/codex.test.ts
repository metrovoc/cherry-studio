import { describe, expect, it } from 'vitest'

import { PROVIDER_SERVER_TOOL_MODEL_IDS } from '../patterns/server-tool-models.gen'
import codex from '../providers/openai-codex'

// Codex's serving limits and effort choices differ from the platform API.
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
describe('OpenAI Codex serving contract', () => {
  it.each([
    ['gpt-6-astra', 'gpt-6-astra', 'low'],
    ['gpt-5-6-sol', 'gpt-5.6-sol', 'low'],
    ['gpt-5-6-terra', 'gpt-5.6-terra', 'medium'],
    ['gpt-5-6-luna', 'gpt-5.6-luna', 'medium']
  ])('offers the supported Codex reasoning range and context for %s', (modelId, apiModelId, defaultEffort) => {
    const model = codex.overrides?.find((entry) => entry.modelId === modelId)
    expect(model).toMatchObject({
      apiModelId,
      endpointTypes: ['openai-responses'],
      limits: { contextWindow: 272000 },
      supportsFastMode: true,
      reasoningContracts: {
        'openai-responses': {
          support: {
            controls: [{ kind: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'], default: defaultEffort }],
            defaultEffort
          }
        }
      }
    })
  })

  it.each(['gpt-5-5', 'gpt-5-4', 'gpt-5-4-mini'])(
    'keeps %s available with its Codex context and effort range',
    (modelId) => {
      const model = codex.overrides?.find((entry) => entry.modelId === modelId)
      expect(model?.limits?.contextWindow).toBe(272000)
      expect(model?.reasoningContracts?.['openai-responses']?.support?.controls).toEqual([
        { kind: 'effort', values: ['low', 'medium', 'high', 'xhigh'], default: 'medium' }
      ])
    }
  )

  it('makes built-in web search available for Astra', () => {
    expect(PROVIDER_SERVER_TOOL_MODEL_IDS['openai-codex']?.['web-search']).toContain('gpt-6-astra')
  })
})
