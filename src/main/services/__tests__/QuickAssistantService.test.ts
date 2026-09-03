import { BaseService } from '@main/core/lifecycle'
import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { platform, notifications, systemPreferences, windowManager, mainWindowService } = vi.hoisted(() => {
  const notifications = new Map<number, () => void>()
  let subscriptionId = 0
  return {
    platform: { isMac: true, isWin: false },
    notifications,
    systemPreferences: {
      subscribeLocalNotification: vi.fn((name: string, callback: () => void) => {
        if (name !== 'NSWindowDidResignKeyNotification') throw new Error(`Unexpected notification: ${name}`)
        notifications.set(++subscriptionId, callback)
        return subscriptionId
      }),
      unsubscribeLocalNotification: vi.fn((id: number) => notifications.delete(id))
    },
    windowManager: { open: vi.fn(), close: vi.fn(), getWindow: vi.fn(), onWindowCreatedByType: vi.fn() },
    mainWindowService: { onMainWindowCreated: vi.fn() }
  }
})

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({ WindowManager: windowManager, MainWindowService: mainWindowService })
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
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1 })
  },
  shell: { openExternal: vi.fn() },
  systemPreferences
}))

import { QuickAssistantService } from '../QuickAssistantService'

class TestWindow extends EventEmitter {
  public focused = false
  public visible = false
  public destroyed = false
  public minimized = false
  public opacity = 1
  public readonly webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() }

  public show() {
    this.visible = true
    this.focused = true
    this.minimized = false
    this.emit('show')
  }

  public hide() {
    this.visible = false
    this.focused = false
    this.emit('hide')
  }

  public destroy() {
    this.destroyed = true
    this.hide()
    this.emit('closed')
  }

  public isDestroyed() {
    return this.destroyed
  }

  public isFocused() {
    return this.focused
  }

  public isVisible() {
    return this.visible
  }

  public isMinimized() {
    return this.minimized
  }

  public minimize() {
    this.minimized = true
    this.focused = false
  }

  public setOpacity(opacity: number) {
    this.opacity = opacity
  }

  public getBounds() {
    return { x: 0, y: 0, width: 550, height: 400 }
  }
}

describe('QuickAssistantService window lifecycle', () => {
  let service: QuickAssistantService
  let mainWindow: TestWindow
  let quickWindow: TestWindow
  const windows = new Map<string, TestWindow>()
  const createdListeners = new Set<(event: { window: TestWindow }) => void>()

  const resignKey = () => notifications.forEach((callback) => callback())
  const start = async () => {
    service = new QuickAssistantService()
    await service._doInit()
    service.showQuickAssistant()
  }

  beforeEach(() => {
    BaseService.resetInstances()
    MockMainPreferenceServiceUtils.resetMocks()
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.quick_assistant.enabled', true)
    vi.useFakeTimers()
    platform.isMac = true
    platform.isWin = false
    notifications.clear()
    windows.clear()
    createdListeners.clear()
    mainWindow = new TestWindow()
    mainWindow.show()
    mainWindowService.onMainWindowCreated.mockImplementation((listener) => {
      listener(mainWindow)
      return { dispose() {} }
    })
    windowManager.onWindowCreatedByType.mockImplementation((_type, listener) => {
      createdListeners.add(listener)
      return { dispose: () => createdListeners.delete(listener) }
    })
    windowManager.open.mockImplementation(() => {
      quickWindow = new TestWindow()
      const id = `quick-assistant-${windows.size}`
      windows.set(id, quickWindow)
      createdListeners.forEach((listener) => listener({ window: quickWindow }))
      return id
    })
    windowManager.getWindow.mockImplementation((id) => windows.get(id))
    windowManager.close.mockImplementation((id) => windows.get(id)?.destroy())
  })

  afterEach(async () => {
    await service?._doDestroy()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('hides on native key loss even when the foreground app and Electron blur do not change', async () => {
    await start()
    quickWindow.focused = false
    resignKey()
    vi.runAllTimers()

    expect(quickWindow.visible).toBe(false)
    expect(mainWindow.visible).toBe(true)
  })

  it('lets Cocoa complete a key-window handoff before deciding to hide', async () => {
    await start()
    quickWindow.focused = false
    resignKey()
    quickWindow.focused = true
    vi.runAllTimers()

    expect(quickWindow.visible).toBe(true)
    expect(quickWindow.focused).toBe(true)
  })

  it('keeps the panel open when an auxiliary window resigns key but the panel retains input focus', async () => {
    await start()
    resignKey()
    quickWindow.emit('blur')
    vi.runAllTimers()

    expect(quickWindow.visible).toBe(true)
    expect(quickWindow.focused).toBe(true)
  })

  it('preserves a pinned panel on key loss and restores auto-hide after unpinning', async () => {
    await start()
    service.setPinQuickAssistant(true)
    quickWindow.focused = false
    resignKey()
    vi.runAllTimers()
    expect(quickWindow.visible).toBe(true)

    service.setPinQuickAssistant(false)
    resignKey()
    vi.runAllTimers()
    expect(quickWindow.visible).toBe(false)
  })

  it('reclaims input focus on toggle when a pinned panel is already visible', async () => {
    await start()
    service.setPinQuickAssistant(true)
    quickWindow.focused = false

    service.toggleQuickAssistant()

    expect(quickWindow.visible).toBe(true)
    expect(quickWindow.focused).toBe(true)
  })

  it('hides only the panel when toggling a focused panel', async () => {
    await start()
    service.toggleQuickAssistant()

    expect(quickWindow.visible).toBe(false)
    expect(mainWindow.visible).toBe(true)
    expect(quickWindow.destroyed).toBe(false)
  })

  it('recreates a closed window on the next toggle and attaches auto-hide to the replacement', async () => {
    await start()
    const closedWindow = quickWindow
    closedWindow.destroy()
    expect(notifications.size).toBe(0)

    service.toggleQuickAssistant()

    expect(quickWindow).not.toBe(closedWindow)
    expect(quickWindow.visible).toBe(true)
    expect(quickWindow.focused).toBe(true)
    quickWindow.focused = false
    resignKey()
    vi.runAllTimers()
    expect(quickWindow.visible).toBe(false)
  })

  it('releases native observers and pending focus checks when disabled, without recreating on toggle', async () => {
    await start()
    quickWindow.focused = false
    resignKey()

    await service._doDeactivate()
    service.toggleQuickAssistant()

    expect(quickWindow.destroyed).toBe(true)
    expect(windows.size).toBe(1)
    expect(notifications.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases listeners on service shutdown so later windows cannot acquire stale auto-hide handlers', async () => {
    await start()
    await service._doStop()

    expect(quickWindow.destroyed).toBe(true)
    expect(notifications.size).toBe(0)
    expect(createdListeners.size).toBe(0)
    expect(mainWindow.listenerCount('show')).toBe(0)
    expect(mainWindow.listenerCount('restore')).toBe(0)
  })

  it.each(['show', 'restore'])('hides the panel when the main window emits %s', async (event) => {
    await start()
    mainWindow.emit(event)

    expect(quickWindow.visible).toBe(false)
    expect(mainWindow.visible).toBe(true)
  })

  it('retains the minimize and opacity recovery path on Windows', async () => {
    platform.isMac = false
    platform.isWin = true
    await start()
    quickWindow.focused = false
    quickWindow.emit('blur')

    expect(quickWindow.minimized).toBe(true)
    expect(quickWindow.opacity).toBe(0)
    service.toggleQuickAssistant()
    expect(quickWindow.minimized).toBe(false)
    expect(quickWindow.opacity).toBe(1)
    expect(quickWindow.focused).toBe(true)
    expect(notifications.size).toBe(0)
  })
})
