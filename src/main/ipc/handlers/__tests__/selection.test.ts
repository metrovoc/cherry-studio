import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetMock } = vi.hoisted(() => ({ appGetMock: vi.fn() }))
vi.mock('@application', () => ({ application: { get: appGetMock } }))

import { selectionHandlers } from '../selection'

const selectionService = {
  hideToolbar: vi.fn(),
  writeToClipboard: vi.fn(() => true),
  determineToolbarSize: vi.fn(),
  processAction: vi.fn(),
  setActionWindowPinned: vi.fn(),
  markActionWindowReady: vi.fn(),
  getLinuxEnvInfo: vi.fn(() => ({
    isLinuxWaylandDisplay: false,
    isLinuxXWaylandMode: false,
    hasLinuxInputDeviceAccess: true,
    isLinuxCompositorCompatible: true
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  appGetMock.mockImplementation((name: string) => {
    if (name === 'SelectionService') return selectionService
    throw new Error(`Unexpected application.get(${name})`)
  })
})

const ctx = (senderId: string | null) => ({ senderId })

describe('selectionHandlers', () => {
  it('hide_toolbar delegates to SelectionService.hideToolbar', async () => {
    await selectionHandlers['selection.hide_toolbar'](undefined, ctx('w1'))
    expect(selectionService.hideToolbar).toHaveBeenCalledOnce()
  })

  it('write_to_clipboard forwards the text and returns the boolean result', async () => {
    const result = await selectionHandlers['selection.write_to_clipboard']('copy me', ctx('w1'))
    expect(selectionService.writeToClipboard).toHaveBeenCalledWith('copy me')
    expect(result).toBe(true)
  })

  it('write_to_clipboard coerces an undefined result to false', async () => {
    selectionService.writeToClipboard.mockReturnValueOnce(undefined as unknown as boolean)
    const result = await selectionHandlers['selection.write_to_clipboard']('x', ctx('w1'))
    expect(result).toBe(false)
  })

  it('determine_toolbar_size forwards width and height', async () => {
    await selectionHandlers['selection.determine_toolbar_size']({ width: 800, height: 40 }, ctx('w1'))
    expect(selectionService.determineToolbarSize).toHaveBeenCalledWith(800, 40)
  })

  it('pin_action_window updates only the caller’s pin choice', async () => {
    await selectionHandlers['selection.pin_action_window'](true, ctx('action-7'))
    expect(selectionService.setActionWindowPinned).toHaveBeenCalledWith('action-7', true)
  })

  it('pin_action_window is a no-op when the caller is not a tracked window (senderId null)', async () => {
    await selectionHandlers['selection.pin_action_window'](true, ctx(null))
    expect(selectionService.setActionWindowPinned).not.toHaveBeenCalled()
  })

  it('accepts readiness only from a tracked sender', async () => {
    await selectionHandlers['selection.action_window_ready']({ requestId: 'session-1' }, ctx(null))
    expect(selectionService.markActionWindowReady).not.toHaveBeenCalled()
    await selectionHandlers['selection.action_window_ready']({ requestId: 'session-1' }, ctx('action-7'))
    expect(selectionService.markActionWindowReady).toHaveBeenCalledWith('action-7', 'session-1')
  })

  it('get_linux_env_info returns the service env probe', async () => {
    const result = await selectionHandlers['selection.get_linux_env_info'](undefined, ctx('w1'))
    expect(result).toEqual({
      isLinuxWaylandDisplay: false,
      isLinuxXWaylandMode: false,
      hasLinuxInputDeviceAccess: true,
      isLinuxCompositorCompatible: true
    })
  })
})
