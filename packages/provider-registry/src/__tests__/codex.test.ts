import { describe, expect, it } from 'vitest'

import { PROVIDER_SERVER_TOOL_MODEL_IDS } from '../patterns/server-tool-models.gen'

// Codex's serving limits and effort choices differ from the platform API.
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
describe('OpenAI Codex serving contract', () => {
  it.each(['gpt-6-astra', 'gpt-6-1-sol'])('makes built-in web search available for %s', (modelId) => {
    expect(PROVIDER_SERVER_TOOL_MODEL_IDS['openai-codex']?.['web-search']).toContain(modelId)
  })
})
