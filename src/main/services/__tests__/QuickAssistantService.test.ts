import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { windowManagerMock } = vi.hoisted(() => ({
  windowManagerMock: {
    getWindow: vi.fn()
  }
}))

vi.mock('@application', () => ({
  application: {
    get: vi.fn((name: string) => {
      if (name === 'WindowManager') return windowManagerMock
      throw new Error(`Unexpected service: ${name}`)
    })
  }
}))

vi.mock('@main/core/platform', () => ({ isMac: false, isWin: false }))

vi.mock('@main/core/lifecycle', () => {
  class MockBaseService {
    protected registerDisposable<T>(disposable: T): T {
      return disposable
    }
  }

  return {
    BaseService: MockBaseService,
    Injectable: () => (target: unknown) => target,
    ServicePhase: () => (target: unknown) => target,
    DependsOn: () => (target: unknown) => target,
    Phase: { WhenReady: 'whenReady' }
  }
})

vi.mock('electron', () => ({
  app: { hide: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn() },
  screen: {},
  shell: { openExternal: vi.fn() }
}))

import { QuickAssistantService } from '../QuickAssistantService'

class MockQuickAssistantWindow extends EventEmitter {
  private focused = true

  public readonly hide = vi.fn()
  public readonly isDestroyed = vi.fn(() => false)
  public readonly isFocused = vi.fn(() => this.focused)
  public readonly webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn()
  }

  public setFocused(focused: boolean) {
    this.focused = focused
  }
}

describe('QuickAssistantService blur auto-hide', () => {
  let service: QuickAssistantService
  let window: MockQuickAssistantWindow

  beforeEach(() => {
    vi.useFakeTimers()
    window = new MockQuickAssistantWindow()
    windowManagerMock.getWindow.mockReturnValue(window)
    service = new QuickAssistantService()
    ;(service as any).windowId = 'quick-assistant'
    ;(service as any).setupQuickAssistant(window)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('keeps the window open when focus returns during a transient blur', () => {
    window.setFocused(false)
    window.emit('blur')

    vi.advanceTimersByTime(80)
    window.setFocused(true)
    window.emit('focus')
    vi.advanceTimersByTime(100)

    expect(window.hide).not.toHaveBeenCalled()
  })

  it('hides the window when focus remains elsewhere after the grace period', () => {
    window.setFocused(false)
    window.emit('blur')

    vi.advanceTimersByTime(149)
    expect(window.hide).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(window.hide).toHaveBeenCalledOnce()
  })
})
