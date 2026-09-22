import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isServerToolModelEligible } from '../patterns/serverToolModelEligibility'
import { RegistryLoader } from '../registry-loader'

const dataDir = join(fileURLToPath(import.meta.url), '..', '..', '..', 'data')
const loader = new RegistryLoader({
  models: join(dataDir, 'models.json'),
  providers: join(dataDir, 'providers.json'),
  providerModels: join(dataDir, 'provider-models.json')
})

describe('OpenAI catalog', () => {
  it('catalogs GPT-6 Astra with its documented capabilities, limits, and reasoning controls', () => {
    expect(loader.findModel('gpt-6-astra')).toMatchObject({
      id: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      ownedBy: 'openai',
      capabilities: expect.arrayContaining([
        'reasoning',
        'function-call',
        'image-recognition',
        'structured-output',
        'file-search'
      ]),
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      contextWindow: 1050000,
      maxInputTokens: 922000,
      maxOutputTokens: 128000,
      pricing: {
        input: { currency: 'USD', perMillionTokens: 10 },
        cacheRead: { currency: 'USD', perMillionTokens: 1 },
        cacheWrite: { currency: 'USD', perMillionTokens: 12.5 },
        output: { currency: 'USD', perMillionTokens: 50 },
        inputTokenTiers: [
          {
            minInputTokens: 272001,
            input: { currency: 'USD', perMillionTokens: 20 },
            cacheRead: { currency: 'USD', perMillionTokens: 2 },
            cacheWrite: { currency: 'USD', perMillionTokens: 25 },
            output: { currency: 'USD', perMillionTokens: 75 }
          }
        ]
      },
      parameterSupport: {
        frequencyPenalty: false,
        maxTokens: true,
        presencePenalty: false,
        stopSequences: false,
        systemMessage: true,
        temperature: { supported: false },
        topK: { supported: false },
        topP: { supported: false }
      },
      reasoning: {
        controls: [{ kind: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }]
      }
    })
  })

  it.each([
    { modelId: 'gpt-6-sol', name: 'GPT-6 Sol', rates: [2, 0.2, 2.5, 10], longRates: [4, 0.4, 5, 15] },
    { modelId: 'gpt-6-luna', name: 'GPT-6 Luna', rates: [0.1, 0.01, 0.125, 0.5], longRates: [0.2, 0.02, 0.25, 0.75] }
  ])(
    'keeps $modelId selectable with its official API limits, controls, and pricing',
    ({ modelId, name, rates, longRates }) => {
      expect(loader.findModel(modelId)).toMatchObject({
        id: modelId,
        name,
        ownedBy: 'openai',
        capabilities: expect.arrayContaining(['reasoning', 'function-call', 'image-recognition', 'structured-output']),
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        contextWindow: 1050000,
        maxInputTokens: 922000,
        maxOutputTokens: 128000,
        parameterSupport: {
          temperature: { supported: true },
          topP: { supported: true }
        },
        reasoning: {
          controls: [{ kind: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' }],
          defaultEffort: 'medium'
        },
        pricing: {
          input: { currency: 'USD', perMillionTokens: rates[0] },
          cacheRead: { currency: 'USD', perMillionTokens: rates[1] },
          cacheWrite: { currency: 'USD', perMillionTokens: rates[2] },
          output: { currency: 'USD', perMillionTokens: rates[3] },
          inputTokenTiers: [
            {
              minInputTokens: 272001,
              input: { currency: 'USD', perMillionTokens: longRates[0] },
              cacheRead: { currency: 'USD', perMillionTokens: longRates[1] },
              cacheWrite: { currency: 'USD', perMillionTokens: longRates[2] },
              output: { currency: 'USD', perMillionTokens: longRates[3] }
            }
          ]
        }
      })
      expect(loader.findModel(modelId)?.capabilities).not.toContain('image-generation')
    }
  )

  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])(
    'routes %s reasoning and tools through OpenAI Responses',
    (modelId) => {
      expect(loader.findProvider('openai')).toMatchObject({
        defaultChatEndpoint: 'openai-responses',
        endpointConfigs: {
          'openai-responses': { adapterFamily: 'openai' }
        }
      })
      expect(loader.findModel(modelId)?.endpointTypes).toEqual(['openai-responses'])
      expect(loader.findOverride('openai', modelId)).toBeNull()
    }
  )

  it.each([
    ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-luna', ['low', 'medium', 'high', 'xhigh', 'max']]
  ] as const)('offers %s through ChatGPT Codex with its subscription limits and controls', (modelId, values) => {
    expect(loader.findOverride('openai-codex', modelId)).toMatchObject({
      apiModelId: modelId,
      endpointTypes: ['openai-responses'],
      limits: { contextWindow: 272000, maxInputTokens: 144000 },
      modelId,
      providerId: 'openai-codex',
      reasoningContracts: {
        'openai-responses': {
          support: {
            controls: [
              {
                default: 'medium',
                kind: 'effort',
                values
              }
            ],
            defaultEffort: 'medium'
          }
        }
      },
      supportsFastMode: true
    })
  })

  // Codex exposes a per-model effort ladder distinct from the platform API catalog.
  it.each([
    ['gpt-5-6-sol', ['low', 'medium', 'high', 'xhigh', 'max'], 'low'],
    ['gpt-5-6-terra', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['gpt-5-6-luna', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['gpt-5-5', ['low', 'medium', 'high', 'xhigh'], 'medium']
  ])('serves %s on Codex with the backend ladder, not the platform one', (modelId, values, defaultEffort) => {
    const contract = loader.findOverride('openai-codex', modelId)?.reasoningContracts?.['openai-responses']

    expect(contract?.support?.controls).toEqual([{ default: defaultEffort, kind: 'effort', values }])
    expect(contract?.support?.defaultEffort).toBe(defaultEffort)
  })

  it('does not offer orchestration-only ultra as a Codex backend effort', () => {
    const invalid = loader
      .getOverridesForProvider('openai-codex')
      .filter((override) =>
        override.reasoningContracts?.['openai-responses']?.support?.controls?.some(
          (control) => control.kind === 'effort' && control.values.includes('ultra')
        )
      )

    expect(invalid.map((override) => override.modelId)).toEqual([])
  })

  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])('enables web search for %s on OpenAI and Codex', (modelId) => {
    expect(isServerToolModelEligible(modelId, 'openai', 'web-search')).toBe(true)
    expect(isServerToolModelEligible(modelId, 'openai-codex', 'web-search')).toBe(true)
  })
})
