import { act, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SelectionActionWindowData } from '@shared/ipc/schemas/selection'

import ActionWindow from '../ActionWindow'

const { ipcRequest, listeners } = vi.hoisted(() => ({
  ipcRequest: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>()
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: ipcRequest },
  useIpcOn: (channel: string, listener: (payload: unknown) => void) => {
    useEffect(() => {
      listeners.set(channel, listener)
      return () => {
        listeners.delete(channel)
      }
    }, [channel, listener])
  }
}))
vi.mock('../components/ActionGeneral', () => ({ default: () => null }))
vi.mock('../components/ActionTranslate', () => ({ default: () => null }))

const action: SelectionActionWindowData = {
  id: 'test-action',
  name: 'Test action',
  enabled: true,
  isBuiltIn: false,
  requestId: 'first-selection'
}

describe('selection action renderer readiness', () => {
  let initialData: SelectionActionWindowData | null
  let laidOutHeaders: Set<Element>
  let readySessions: string[]

  beforeEach(() => {
    initialData = action
    laidOutHeaders = new Set()
    readySessions = []
    listeners.clear()
    ipcRequest.mockReset()
    ipcRequest.mockImplementation(async (channel, input) => {
      if (channel === 'window.get_init_data') return initialData
      if (channel === 'selection.action_window_ready') {
        const laidOutHeader = [...laidOutHeaders].find((element) =>
          element.classList.contains('[-webkit-app-region:drag]')
        )
        expect(laidOutHeader).toBeInTheDocument()
        expect(laidOutHeader).toHaveClass('[-webkit-app-region:drag]')
        expect(laidOutHeader).toHaveTextContent(action.name)
        readySessions.push(input.requestId)
        laidOutHeaders = new Set()
      }
      return undefined
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      laidOutHeaders.add(this)
      return new DOMRect(0, 0, 500, 32)
    })
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('announces a fresh action only after its draggable header exists and layout is flushed', async () => {
    render(<ActionWindow />)
    await waitFor(() => expect(readySessions).toEqual(['first-selection']))
  })

  it('does not announce an empty standby renderer, then announces its first action and each reuse', async () => {
    initialData = null
    const { container, unmount } = render(<ActionWindow />)
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
    expect(readySessions).toEqual([])
    act(() => listeners.get('window.reused')?.(action))
    expect(readySessions).toEqual(['first-selection'])
    act(() => listeners.get('window.reused')?.({ ...action, requestId: 'next-selection' }))
    expect(readySessions).toEqual(['first-selection', 'next-selection'])
    unmount()
    expect(listeners.has('window.reused')).toBe(false)
  })
})
