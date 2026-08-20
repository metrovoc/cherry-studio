import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appListeners, appMock, platformMock, systemPreferencesMock, windowManagerMock, workspaceCallbacks } =
  vi.hoisted(() => {
    const appListeners = new Map<string, Set<(...args: unknown[]) => void>>()
    return {
      appListeners,
      appMock: {
        emit: (event: string, ...args: unknown[]) => appListeners.get(event)?.forEach((listener) => listener(...args)),
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
      platformMock: { isMac: true, isWin: false },
      systemPreferencesMock: {
        subscribeWorkspaceNotification: vi.fn(
          (_event: string, callback: (_event: string, userInfo: Record<string, unknown>) => void) => {
            workspaceCallbacks.push(callback)
            return workspaceCallbacks.length
          }
        ),
        unsubscribeWorkspaceNotification: vi.fn()
      },
      windowManagerMock: {
        getWindow: vi.fn()
      },
      workspaceCallbacks: [] as Array<(_event: string, userInfo: Record<string, unknown>) => void>
    }
  })

vi.mock('@application', () => ({
  application: {
    get: vi.fn((name: string) => {
      if (name === 'WindowManager') return windowManagerMock
      throw new Error(`Unexpected service: ${name}`)
    })
  }
}))

vi.mock('@main/core/platform', () => ({
  get isMac() {
    return platformMock.isMac
  },
  get isWin() {
    return platformMock.isWin
  }
}))

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
  app: appMock,
  BrowserWindow: { getFocusedWindow: vi.fn() },
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getDisplayNearestPoint: vi.fn(() => ({ id: 1 }))
  },
  shell: { openExternal: vi.fn() },
  systemPreferences: systemPreferencesMock
}))

import { QuickAssistantService } from '../QuickAssistantService'

class MockQuickAssistantWindow extends EventEmitter {
  private focused = true
  private visible = true

  public readonly focus = vi.fn(() => this.setFocused(true))
  public readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 550, height: 400 }))
  public readonly hide = vi.fn(() => {
    this.visible = false
  })
  public readonly isDestroyed = vi.fn(() => false)
  public readonly isFocused = vi.fn(() => this.focused)
  public readonly isMinimized = vi.fn(() => false)
  public readonly isVisible = vi.fn(() => this.visible)
  public readonly setOpacity = vi.fn()
  public readonly show = vi.fn(() => {
    this.visible = true
  })
  public readonly webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn()
  }

  public setFocused(focused: boolean) {
    this.focused = focused
  }
}

describe('QuickAssistantService focus transfer', () => {
  let service: QuickAssistantService
  let window: MockQuickAssistantWindow

  beforeEach(() => {
    vi.useFakeTimers()
    platformMock.isMac = true
    workspaceCallbacks.length = 0
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
    appListeners.clear()
  })

  it('keeps the window visible while an auxiliary panel temporarily owns focus', () => {
    window.setFocused(false)
    window.emit('blur')
    vi.advanceTimersByTime(1_000)

    expect(window.hide).not.toHaveBeenCalled()
  })

  it('hides the window when another application activates', () => {
    window.setFocused(false)
    window.emit('blur')
    platformMock.isMac = false
    workspaceCallbacks[0]('NSWorkspaceDidActivateApplicationNotification', {
      NSWorkspaceApplicationKey: '<NSRunningApplication: 0x1 (com.example.Other - 123)>'
    })

    expect(window.hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)

    expect(window.hide).toHaveBeenCalledOnce()
  })

  it('keeps and refocuses the window when a transient activation returns to Cherry', () => {
    workspaceCallbacks[0]('NSWorkspaceDidActivateApplicationNotification', {
      NSWorkspaceApplicationKey: '<NSRunningApplication: 0x1 (com.example.Utility - 123)>'
    })
    window.setFocused(false)
    window.emit('blur')
    workspaceCallbacks[0]('NSWorkspaceDidActivateApplicationNotification', {
      NSWorkspaceApplicationKey: `<NSRunningApplication: 0x2 (com.kangfenmao.CherryStudio - ${process.pid})>`
    })
    vi.advanceTimersByTime(1_000)

    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('hides the window when another Cherry window receives focus', () => {
    platformMock.isMac = false
    appMock.emit('browser-window-focus', {}, new EventEmitter())

    expect(window.hide).toHaveBeenCalledOnce()
  })

  it('activates Cherry and restores panel focus when shown', () => {
    window.setFocused(false)
    ;(service as any).proceedShow()

    expect(window.show).toHaveBeenCalled()
    expect(appMock.focus).toHaveBeenCalledWith({ steal: true })
    expect(window.focus).toHaveBeenCalled()
  })

  it('releases the workspace observer when the window closes', () => {
    window.emit('closed')

    expect(systemPreferencesMock.unsubscribeWorkspaceNotification).toHaveBeenCalledWith(1)
  })
})
