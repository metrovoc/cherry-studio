import { BaseService } from '@main/core/lifecycle'
import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { platform, outsideClicks, windowManager } = vi.hoisted(() => ({
  platform: { isMac: true, isWin: false },
  outsideClicks: new Set<() => void>(),
  windowManager: { open: vi.fn(), close: vi.fn(), getWindow: vi.fn(), onWindowCreatedByType: vi.fn() }
}))

vi.mock('@cherrystudio/macos-panel', () => ({
  watchOutsideClicks: (_handle: Buffer, callback: () => void) => {
    outsideClicks.add(callback)
    return () => outsideClicks.delete(callback)
  }
}))

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
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1 })
  },
  shell: { openExternal: vi.fn() }
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

  public getNativeWindowHandle() {
    return Buffer.alloc(8)
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

  const clickOutside = () => outsideClicks.forEach((callback) => callback())
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
    outsideClicks.clear()
    windows.clear()
    createdListeners.clear()
    mainWindow = new TestWindow()
    mainWindow.show()
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

  it('keeps the panel open when another launcher takes keyboard focus', async () => {
    await start()
    quickWindow.focused = false
    quickWindow.emit('blur')
    vi.runAllTimers()

    expect(quickWindow.visible).toBe(true)
  })

  it('dismisses on an outside click regardless of main-window focus', async () => {
    await start()
    mainWindow.focused = true
    clickOutside()
    expect(quickWindow.visible).toBe(false)

    service.showQuickAssistant()
    mainWindow.focused = false
    clickOutside()
    expect(quickWindow.visible).toBe(false)
  })

  it('preserves a pinned panel on outside clicks and restores dismissal after unpinning', async () => {
    await start()
    service.setPinQuickAssistant(true)
    clickOutside()
    expect(quickWindow.visible).toBe(true)

    service.setPinQuickAssistant(false)
    clickOutside()
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

  it('recreates a closed window on the next toggle and attaches outside-click dismissal to the replacement', async () => {
    await start()
    const closedWindow = quickWindow
    closedWindow.destroy()
    expect(outsideClicks.size).toBe(0)

    service.toggleQuickAssistant()

    expect(quickWindow).not.toBe(closedWindow)
    expect(quickWindow.visible).toBe(true)
    expect(quickWindow.focused).toBe(true)
    quickWindow.focused = false
    clickOutside()
    vi.runAllTimers()
    expect(quickWindow.visible).toBe(false)
  })

  it('releases the click monitor when disabled, without recreating on toggle', async () => {
    await start()
    quickWindow.focused = false

    await service._doDeactivate()
    service.toggleQuickAssistant()

    expect(quickWindow.destroyed).toBe(true)
    expect(windows.size).toBe(1)
    expect(outsideClicks.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases listeners on service shutdown so later windows cannot acquire stale auto-hide handlers', async () => {
    await start()
    await service._doStop()

    expect(quickWindow.destroyed).toBe(true)
    expect(outsideClicks.size).toBe(0)
    expect(createdListeners.size).toBe(0)
    expect(mainWindow.listenerCount('show')).toBe(0)
    expect(mainWindow.listenerCount('restore')).toBe(0)
  })

  it.each(['show', 'restore'])('keeps the panel open when the main window emits %s', async (event) => {
    await start()
    mainWindow.emit(event)

    expect(quickWindow.visible).toBe(true)
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
    expect(outsideClicks.size).toBe(0)
  })
})
