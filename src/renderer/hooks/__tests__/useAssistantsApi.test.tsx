import { MockDataApiUtils } from '@test-mocks/renderer/DataApiService'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dataApiService } from '@data/DataApiService'
import { createSWRTestWrapper } from '@renderer/data/hooks/__tests__/testUtils'

vi.unmock('@data/hooks/useDataApi')

import { useAssistantsApi } from '../useAssistant'

describe('useAssistantsApi collection changes', () => {
  beforeEach(() => {
    MockDataApiUtils.resetMocks()
  })

  it('removes an archived assistant from a mounted list after another window changes it', async () => {
    const archived = { id: 'archived-assistant', name: 'Archived assistant' }
    const remaining = { id: 'remaining-assistant', name: 'Remaining assistant' }
    MockDataApiUtils.setCustomResponse('/assistants', 'GET', { items: [archived, remaining], total: 2, page: 1 })
    const { Wrapper } = createSWRTestWrapper()
    const { result } = renderHook(() => useAssistantsApi(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.assistants).toEqual([archived, remaining]))

    MockDataApiUtils.setCustomResponse('/assistants', 'GET', { items: [remaining], total: 1, page: 1 })
    act(() => {
      MockDataApiUtils.emitDataChange([{ endpoint: '/assistants', kind: 'membership', entityIds: [archived.id] }])
    })

    await waitFor(() => expect(result.current.assistants).toEqual([remaining]))
    expect(result.current.total).toBe(1)
  })

  it('does not fetch a disabled list when a collection notification arrives', async () => {
    const { Wrapper } = createSWRTestWrapper()
    renderHook(() => useAssistantsApi({ enabled: false }), { wrapper: Wrapper })

    await act(async () => {
      MockDataApiUtils.emitDataChange([{ endpoint: '/assistants', kind: 'membership' }])
    })

    expect(dataApiService.get).not.toHaveBeenCalled()
  })
})
