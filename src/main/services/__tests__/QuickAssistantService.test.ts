import { BaseService } from '@main/core/lifecycle'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { windowManager } = vi.hoisted(() => ({
  windowManager: { getWindow: vi.fn() }
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({ WindowManager: windowManager })
})

vi.mock('@main/core/platform', () => ({ isMac: false, isWin: false }))

import { QuickAssistantService } from '../QuickAssistantService'

class TestWindow extends EventEmitter {
  private focused = true
  private visible = true

  public readonly webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn()
  }

  public hide() {
    this.visible = false
  }

  public isDestroyed() {
    return false
  }

  public isFocused() {
    return this.focused
  }

  public isVisible() {
    return this.visible
  }

  public setFocused(focused: boolean) {
    this.focused = focused
  }
}

describe('QuickAssistantService blur grace', () => {
  let service: QuickAssistantService
  let window: TestWindow

  beforeEach(() => {
    BaseService.resetInstances()
    vi.useFakeTimers()
    window = new TestWindow()
    windowManager.getWindow.mockReturnValue(window)
    service = new QuickAssistantService()
    const testSubject = service as unknown as {
      windowId: string
      setupQuickAssistant(window: TestWindow): void
    }
    testSubject.windowId = 'quick-assistant'
    testSubject.setupQuickAssistant(window)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('stays visible when focus returns during an input-source switch', () => {
    window.setFocused(false)
    window.emit('blur')
    window.setFocused(true)
    window.emit('focus')
    vi.advanceTimersByTime(150)

    expect(window.isVisible()).toBe(true)
  })

  it('hides after focus moves elsewhere', () => {
    window.setFocused(false)
    window.emit('blur')
    vi.advanceTimersByTime(150)

    expect(window.isVisible()).toBe(false)
  })
})
