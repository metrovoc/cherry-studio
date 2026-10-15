import path from 'node:path'

import { setupTestDatabase } from '@test-helpers/db'
import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { assistantDataService } from '@data/services/AssistantService'
import { modelService } from '@data/services/ModelService'
import { temporaryChatService } from '@data/services/TemporaryChatService'
import { topicService } from '@data/services/TopicService'
import { temporaryChatContextProvider } from '@main/ai/streamManager/context/TemporaryChatContextProvider'
import { DataApiErrorFactory } from '@shared/data/api/errors'
import { type Assistant, DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'
import { ENDPOINT_TYPE, MODEL_CAPABILITY } from '@shared/data/types/model'

import { makeProvider } from '../../../../__tests__/fixtures'
import { createAutomationReplToolEntries } from '../../../../tools/adapters/aiSdk/builtin/AutomationReplTools'
import { registry } from '../../../../tools/adapters/aiSdk/registry'
import { buildAgentParams, type BuildAgentParamsInput, resolveTools } from '../buildAgentParams'

vi.mock('../../../../provider/config', () => ({
  resolveProviderAiSdkConfig: vi.fn(async () => ({
    config: { providerId: 'openrouter', providerSettings: {} },
    credentialReceipt: { attribution: 'unknown' }
  }))
}))

describe('conversation-owned automation tools', () => {
  const dbh = setupTestDatabase()
  const modelId = 'openrouter::openai/gpt-6-luna'
  const temporaryTopicIds = new Set<string>()
  let assistant: Assistant

  beforeEach(() => {
    MockMainPreferenceServiceUtils.resetMocks()
    MockMainPreferenceServiceUtils.setPreferenceValue('app.browser.agent_control.enabled', true)
    MockMainPreferenceServiceUtils.setPreferenceValue('app.computer_use.agent_control.enabled', true)
    MockMainPreferenceServiceUtils.setPreferenceValue('chat.web_search.model_tools_preferred', true)
    MockMainPreferenceServiceUtils.setPreferenceValue('chat.context_settings.enabled', false)
    vi.spyOn(application, 'getPath').mockImplementation((_namespace, filename = '') =>
      path.join(process.cwd(), 'packages/provider-registry/data', filename)
    )
    dbh.db.insert(userProviderTable).values({ providerId: 'openrouter', name: 'OpenRouter', orderKey: 'a0' }).run()
    dbh.db
      .insert(userModelTable)
      .values({
        id: modelId,
        providerId: 'openrouter',
        modelId: 'openai/gpt-6-luna',
        name: 'GPT-6 Luna',
        capabilities: [MODEL_CAPABILITY.FUNCTION_CALL],
        supportsStreaming: true,
        orderKey: 'a0'
      })
      .run()
    assistant = assistantDataService.create({
      name: 'Assistant',
      modelId,
      settings: { ...DEFAULT_ASSISTANT_SETTINGS, enableWebSearch: true, mcpMode: 'disabled' }
    })
    for (const entry of createAutomationReplToolEntries()) registry.register(entry)
  })

  afterEach(() => {
    for (const id of temporaryTopicIds) {
      if (temporaryChatService.hasTopic(id)) temporaryChatService.deleteTopic(id)
    }
    temporaryTopicIds.clear()
    for (const entry of createAutomationReplToolEntries()) registry.deregister(entry.name)
    vi.restoreAllMocks()
    MockMainPreferenceServiceUtils.resetMocks()
  })

  function selectTools(request: BuildAgentParamsInput['request'], currentAssistant: Assistant | undefined = assistant) {
    return resolveTools(request, currentAssistant, modelService.getByKey('openrouter', 'openai/gpt-6-luna'), false, [])
  }

  it.each([
    { browser: true, computer: false },
    { browser: false, computer: true },
    { browser: true, computer: true }
  ])('waits for persistence without suppressing native web search: %j', async ({ browser, computer }) => {
    MockMainPreferenceServiceUtils.setPreferenceValue('app.browser.agent_control.enabled', browser)
    MockMainPreferenceServiceUtils.setPreferenceValue('app.computer_use.agent_control.enabled', computer)
    const topic = temporaryChatService.createTopic({ assistantId: assistant.id })
    temporaryTopicIds.add(topic.id)
    const dispatch = await temporaryChatContextProvider.prepareDispatch(
      {
        id: 'subscriber',
        onChunk: vi.fn(),
        onDone: vi.fn(),
        onPaused: vi.fn(),
        onError: vi.fn(),
        isAlive: () => true
      },
      { trigger: 'submit-message', topicId: topic.id, userMessageParts: [{ type: 'text', text: 'Translate this.' }] },
      { hasLiveStream: false }
    )
    const request = dispatch.models[0].request
    expect(request.conversation).toEqual({ id: topic.id, topicId: topic.id })
    const input: BuildAgentParamsInput = {
      request,
      assistant,
      model: modelService.getByKey('openrouter', 'openai/gpt-6-luna'),
      provider: makeProvider({
        id: 'openrouter',
        defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
        endpointConfigs: { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { adapterFamily: 'openrouter' } },
        serverTools: [{ id: 'web-search', modelScope: 'all-chat-models' }]
      }),
      signal: undefined
    }

    const temporary = await buildAgentParams(input)
    expect(temporary.tools).toBeUndefined()
    expect(temporary.plugins.some((plugin) => plugin.name === 'webSearch')).toBe(true)

    temporaryChatService.persist(topic.id)
    const saved = await buildAgentParams(input)
    expect(saved.tools).toHaveProperty('automation_repl')
    expect(saved.tools).toHaveProperty('automation_repl_reset')
    expect(saved.plugins.some((plugin) => plugin.name === 'webSearch')).toBe(true)
  })

  it.each(['missing', 'deleted', 'other-assistant'] as const)('omits automation for a %s topic', async (state) => {
    const owner = state === 'other-assistant' ? assistantDataService.create({ name: 'Other' }) : assistant
    const topicId = state === 'missing' ? 'missing-topic' : topicService.create({ assistantId: owner.id }).id
    if (state === 'deleted') topicService.delete(topicId)

    const result = await selectTools({ conversation: { id: topicId, topicId } })
    expect(result.tools).toBeUndefined()
    expect(result.deferredEntries).toEqual([])
  })

  it('does not query topic ownership for caller-owned context', async () => {
    const topic = topicService.create({ assistantId: assistant.id })
    vi.spyOn(topicService, 'getById').mockImplementation(() => {
      throw new Error('Caller-owned context must not query persisted topics')
    })

    const result = await selectTools({ conversation: { id: topic.id, topicId: topic.id }, contextOwner: 'caller' })
    expect(result.tools).toBeUndefined()
  })

  it.each([new Error('Database unavailable'), DataApiErrorFactory.database(new Error('Database unavailable'), 'read')])(
    'propagates unexpected topic lookup errors: %s',
    async (error) => {
      const topic = topicService.create({ assistantId: assistant.id })
      vi.spyOn(topicService, 'getById').mockImplementation(() => {
        throw error
      })

      await expect(selectTools({ conversation: { id: topic.id, topicId: topic.id } })).rejects.toBe(error)
    }
  )

  it('respects the browser setting independently of the computer setting', async () => {
    const topic = topicService.create({ assistantId: assistant.id })
    const request = { conversation: { id: topic.id, topicId: topic.id } }
    const browserDisabled = { ...assistant, settings: { ...assistant.settings, enableBrowser: false } }

    expect((await selectTools(request, browserDisabled)).tools).toHaveProperty('automation_repl')
    MockMainPreferenceServiceUtils.setPreferenceValue('app.computer_use.agent_control.enabled', false)
    expect((await selectTools(request, browserDisabled)).tools).toBeUndefined()
    expect((await selectTools(request)).tools).toHaveProperty('automation_repl')
    MockMainPreferenceServiceUtils.setPreferenceValue('app.browser.agent_control.enabled', false)
    expect((await selectTools(request)).tools).toBeUndefined()
  })
})
