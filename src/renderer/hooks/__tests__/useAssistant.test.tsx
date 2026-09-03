import { MockUseDataApiUtils, mockUseQuery } from '@test-mocks/renderer/useDataApi'
import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAssistant, useAssistants } from '../useAssistant'

function queryResult(data?: unknown, options: { isLoading?: boolean } = {}) {
  return {
    data,
    isLoading: options.isLoading ?? false,
    isRefreshing: false,
    error: undefined,
    refetch: vi.fn().mockResolvedValue(data),
    mutate: vi.fn().mockResolvedValue(data)
  } as never
}

function resetQueryMock() {
  mockUseQuery.mockImplementation(() => queryResult())
}

describe('useAssistants', () => {
  beforeEach(() => {
    MockUseDataApiUtils.resetMocks()
    vi.clearAllMocks()
    resetQueryMock()
    MockUsePreferenceUtils.resetMocks()
  })

  it('queries the assistant list from DataApi', () => {
    const assistant = { id: 'assistant-1', name: 'Assistant 1' }
    mockUseQuery.mockReturnValue(queryResult({ items: [assistant], total: 1 }))

    const { result } = renderHook(() => useAssistants())

    expect(mockUseQuery).toHaveBeenCalledWith('/assistants', {
      enabled: true,
      query: { limit: 500 }
    })
    expect(result.current.assistants).toEqual([assistant])
    expect(result.current.hasLoaded).toBe(true)
  })

  it('reports the assistant list as unresolved before DataApi returns data', () => {
    mockUseQuery.mockReturnValue(queryResult(undefined, { isLoading: false }))

    const { result } = renderHook(() => useAssistants())

    expect(result.current.assistants).toEqual([])
    expect(result.current.hasLoaded).toBe(false)
  })
})

describe('useAssistant', () => {
  beforeEach(() => {
    MockUseDataApiUtils.resetMocks()
    vi.clearAllMocks()
    resetQueryMock()
    MockUsePreferenceUtils.resetMocks()
  })

  it('disables the DataApi query when id is null', () => {
    renderHook(() => useAssistant(null))

    expect(mockUseQuery).toHaveBeenCalledWith('/assistants/:id', {
      params: { id: '' },
      enabled: false,
      swrOptions: { keepPreviousData: false }
    })
  })

  it('returns assistant: undefined for a topic without an assistant', () => {
    const { result } = renderHook(() => useAssistant(null))

    expect(result.current.assistant).toBeUndefined()
  })

  it('uses the default model only when the topic has no persisted assistant', () => {
    MockUsePreferenceUtils.setPreferenceValue('chat.default_model_id', 'provider::default-model')

    renderHook(() => useAssistant(null))

    expect(mockUseQuery).toHaveBeenCalledWith('/models/provider::default-model', {
      enabled: true,
      swrOptions: { keepPreviousData: false }
    })
  })

  it('can skip the default model lookup for callers that only need persisted assistants', () => {
    MockUsePreferenceUtils.setPreferenceValue('chat.default_model_id', 'provider::default-model')

    renderHook(() => useAssistant(null, { loadDefaultModel: false }))

    expect(mockUseQuery).not.toHaveBeenCalledWith('/models/provider::default-model', expect.anything())
    expect(mockUseQuery).toHaveBeenCalledWith('/models/', {
      enabled: false,
      swrOptions: { keepPreviousData: false }
    })
  })

  it('does not fall back to the default model when a persisted assistant has no model', () => {
    MockUsePreferenceUtils.setPreferenceValue('chat.default_model_id', 'provider::default-model')
    mockUseQuery.mockImplementation((path, options) => {
      if (options?.enabled === false) return queryResult()
      if (path === '/assistants/:id') {
        return queryResult({
          id: 'assistant-1',
          name: 'Assistant 1',
          modelId: null,
          settings: {},
          mcpServerIds: [],
          knowledgeBaseIds: []
        })
      }
      if (String(path).startsWith('/models/provider::default-model')) {
        return queryResult({ id: 'provider::default-model', name: 'Default Model' })
      }
      return queryResult()
    })

    const { result } = renderHook(() => useAssistant('assistant-1'))

    expect(result.current.assistant).toBeDefined()
    expect(result.current.model).toBeUndefined()
    expect(result.current.isModelPending).toBe(false)
    expect(result.current.isModelMissing).toBe(true)
    expect(mockUseQuery).toHaveBeenCalledWith('/models/', {
      enabled: false,
      swrOptions: { keepPreviousData: false }
    })
  })

  it('marks the model pending while a persisted assistant is loading', () => {
    mockUseQuery.mockImplementation((path, options) => {
      if (options?.enabled === false) return queryResult()
      if (path === '/assistants/:id') return queryResult(undefined, { isLoading: true })
      return queryResult()
    })

    const { result } = renderHook(() => useAssistant('assistant-1'))

    expect(result.current.isModelPending).toBe(true)
    expect(result.current.isModelMissing).toBe(false)
  })

  it('marks the model pending while the assistant model record is loading', () => {
    mockUseQuery.mockImplementation((path, options) => {
      if (options?.enabled === false) return queryResult()
      if (path === '/assistants/:id') {
        return queryResult({
          id: 'assistant-1',
          name: 'Assistant 1',
          modelId: 'provider::model-a',
          settings: {},
          mcpServerIds: [],
          knowledgeBaseIds: []
        })
      }
      if (path === '/models/provider::model-a') return queryResult(undefined, { isLoading: true })
      return queryResult()
    })

    const { result } = renderHook(() => useAssistant('assistant-1'))

    expect(result.current.isModelPending).toBe(true)
    expect(result.current.isModelMissing).toBe(false)
  })

  it('disables previous data for assistant identity switches', () => {
    renderHook(() => useAssistant('assistant-new'))

    expect(mockUseQuery).toHaveBeenCalledWith('/assistants/:id', {
      params: { id: 'assistant-new' },
      enabled: true,
      swrOptions: { keepPreviousData: false }
    })
  })

  it('refreshes only when the selected assistant changes in another window', () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    mockUseQuery.mockImplementation((path) => {
      if (path === '/assistants/:id') {
        return {
          ...(queryResult({ id: 'assistant-1', modelId: null, settings: {} }) as unknown as Record<string, unknown>),
          mutate
        } as never
      }
      return queryResult()
    })
    renderHook(() => useAssistant('assistant-1'))

    MockUseDataApiUtils.emitDataChange([
      { endpoint: '/assistants/:id', entityIds: ['assistant-2'] },
      { endpoint: '/assistants', kind: 'projection', entityIds: ['assistant-2'] }
    ])
    expect(mutate).not.toHaveBeenCalled()

    MockUseDataApiUtils.emitDataChange([{ endpoint: '/assistants/:id', entityIds: ['assistant-1'] }])
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('keeps assistant mutation callbacks stable across rerenders', () => {
    mockUseQuery.mockImplementation((path, options) => {
      if (options?.enabled === false) return queryResult()
      if (path === '/assistants/:id') {
        return queryResult({
          id: 'assistant-1',
          name: 'Assistant 1',
          modelId: 'provider::model-a',
          settings: {},
          mcpServerIds: [],
          knowledgeBaseIds: []
        })
      }
      if (path === '/models/provider::model-a') return queryResult({ id: 'provider::model-a', name: 'Model A' })
      return queryResult()
    })

    const { rerender, result } = renderHook(() => useAssistant('assistant-1'))
    const firstSetModel = result.current.setModel
    const firstUpdateAssistant = result.current.updateAssistant
    const firstUpdateAssistantSettings = result.current.updateAssistantSettings

    rerender()

    expect(result.current.setModel).toBe(firstSetModel)
    expect(result.current.updateAssistant).toBe(firstUpdateAssistant)
    expect(result.current.updateAssistantSettings).toBe(firstUpdateAssistantSettings)
  })
})
