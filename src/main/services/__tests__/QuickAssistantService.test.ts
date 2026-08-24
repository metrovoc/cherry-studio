import { BaseService } from '@main/core/lifecycle'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { app, appListeners, emitAppEvent, platform, systemPreferences, windowManager, workspaceCallbacks } = vi.hoisted(
  () => {
    const appListeners = new Map<string, Set<(...args: unknown[]) => void>>()
    return {
      app: {
        focus: vi.fn(),
        hide: vi.fn(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          const listeners = appListeners.get(event) ?? new Set()
          listeners.add(listener)
          appListeners.set(event, listeners)
        }),
        removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          appListeners.get(event)?.delete(listener)
        })
      },
      appListeners,
      emitAppEvent: (event: string, ...args: unknown[]) => {
        appListeners.get(event)?.forEach((listener) => listener(...args))
      },
      platform: { isMac: true, isWin: false },
      systemPreferences: {
        subscribeWorkspaceNotification: vi.fn(
          (_name: string, callback: (_event: string, userInfo: Record<string, unknown>) => void) => {
            workspaceCallbacks.push(callback)
            return workspaceCallbacks.length
          }
        ),
        unsubscribeWorkspaceNotification: vi.fn()
      },
      windowManager: { getWindow: vi.fn() },
      workspaceCallbacks: [] as Array<(_event: string, userInfo: Record<string, unknown>) => void>
    }
  }
)

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({ WindowManager: windowManager })
})

vi.mock('@main/core/platform', () => ({
  get isMac() {
    return platform.isMac
  },
  get isWin() {
    return platform.isWin
  }
}))

vi.mock('electron', () => ({
  app,
  screen: {},
  shell: { openExternal: vi.fn() },
  systemPreferences
}))

import { QuickAssistantService } from '../QuickAssistantService'

class TestWindow extends EventEmitter {
  private focused = true
  private visible = true

  public readonly focus = vi.fn(() => {
    this.focused = true
  })

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

describe('QuickAssistantService macOS focus transfer', () => {
  let service: QuickAssistantService
  let window: TestWindow

  beforeEach(() => {
    BaseService.resetInstances()
    vi.useFakeTimers()
    platform.isMac = true
    platform.isWin = false
    workspaceCallbacks.length = 0
    Object.defineProperty(process, 'getSystemVersion', { configurable: true, value: () => '26.0.0' })
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
    window.emit('hide')
    vi.useRealTimers()
    vi.clearAllMocks()
    appListeners.clear()
    Reflect.deleteProperty(process, 'getSystemVersion')
  })

  it('restores the quick window when app activation returns through the main window', () => {
    workspaceCallbacks[0]('NSWorkspaceDidActivateApplicationNotification', {
      NSWorkspaceApplicationKey: '<NSRunningApplication: 0x1 (com.runjuu.Input-Source-Pro - 123)>'
    })
    window.setFocused(false)
    window.emit('blur')
    emitAppEvent('browser-window-focus', {}, new EventEmitter())

    expect(window.isVisible()).toBe(true)

    workspaceCallbacks[0]('NSWorkspaceDidActivateApplicationNotification', {
      NSWorkspaceApplicationKey: `<NSRunningApplication: 0x2 (com.kangfenmao.CherryStudio - ${process.pid})>`
    })
    vi.runAllTimers()

    expect(window.focus).toHaveBeenCalled()
    expect(window.isVisible()).toBe(true)
  })

  it('restores the quick window when the workspace event arrives before main-window focus', () => {
    workspaceCallbacks[0]('NSWorkspaceDidActivateApplicationNotification', {
      NSWorkspaceApplicationKey: '<NSRunningApplication: 0x1 (com.runjuu.Input-Source-Pro - 123)>'
    })
    window.setFocused(false)
    window.emit('blur')
    workspaceCallbacks[0]('NSWorkspaceDidActivateApplicationNotification', {
      NSWorkspaceApplicationKey: `<NSRunningApplication: 0x2 (com.kangfenmao.CherryStudio - ${process.pid})>`
    })
    window.setFocused(false)
    emitAppEvent('browser-window-focus', {}, new EventEmitter())
    vi.runAllTimers()

    expect(window.focus).toHaveBeenCalledTimes(2)
    expect(window.isVisible()).toBe(true)
  })

  it('hides after focus moves to another application without returning', () => {
    workspaceCallbacks[0]('NSWorkspaceDidActivateApplicationNotification', {
      NSWorkspaceApplicationKey: '<NSRunningApplication: 0x1 (com.example.Other - 123)>'
    })
    window.setFocused(false)
    window.emit('blur')
    vi.runAllTimers()

    expect(window.isVisible()).toBe(false)
  })

  it('hides immediately when another Cherry window receives intentional focus', () => {
    emitAppEvent('browser-window-focus', {}, new EventEmitter())

    expect(window.isVisible()).toBe(false)
  })

  it('does not treat a native auxiliary panel blur as leaving Cherry', () => {
    window.setFocused(false)
    window.emit('blur')
    vi.runAllTimers()

    expect(window.isVisible()).toBe(true)
  })

  it('brings a visible but unfocused quick window forward on shortcut toggle', () => {
    window.setFocused(false)
    const show = vi.spyOn(service, 'showQuickAssistant').mockImplementation(() => undefined)
    const hide = vi.spyOn(service, 'hideQuickAssistant').mockImplementation(() => undefined)

    service.toggleQuickAssistant()

    expect(show).toHaveBeenCalledOnce()
    expect(hide).not.toHaveBeenCalled()
  })

  it('releases the workspace observer when the quick window closes', () => {
    window.emit('closed')

    expect(systemPreferences.unsubscribeWorkspaceNotification).toHaveBeenCalledWith(1)
  })
})
