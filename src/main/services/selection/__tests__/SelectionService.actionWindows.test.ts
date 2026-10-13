import { EventEmitter } from 'node:events'

import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import type { BrowserWindow, Rectangle } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { BaseService } from '@main/core/lifecycle'
import type { ManagedWindow } from '@main/core/window/types'
import { WindowType } from '@main/core/window/types'
import type { SelectionActionWindowData } from '@shared/ipc/schemas/selection'

import { SelectionService } from '../SelectionService'

const platform = vi.hoisted(() => ({ isMac: true }))

vi.mock('@application', async () => {
  const { defaultServiceInstances, mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({
    WindowManager: { ...defaultServiceInstances.WindowManager, getInitData: vi.fn() }
  })
})
vi.mock('electron', () => ({
  screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 300 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  }
}))
vi.mock('@main/core/platform', () => ({
  isDev: false,
  isLinux: false,
  get isMac() {
    return platform.isMac
  },
  get isWin() {
    return !platform.isMac
  }
}))

class NativeWindow extends EventEmitter {
  visible = false
  destroyed = false
  minimized = false
  level = 0
  bounds = { x: 0, y: 0, width: 500, height: 400 }
  showCount = 0
  isVisible = () => this.visible
  isDestroyed = () => this.destroyed
  isMinimized = () => this.minimized
  setPosition = (x: number, y: number) => {
    this.bounds = { ...this.bounds, x, y }
  }
  setBounds = (bounds: Rectangle) => {
    this.bounds = bounds
  }
  getNormalBounds = () => this.bounds
  setAlwaysOnTop = (enabled: boolean, _level = 'floating', relativeLevel = 0) => {
    this.level = enabled ? 3 + relativeLevel : 0
  }
  show = () => {
    this.visible = true
    this.showCount++
    this.emit('show')
  }
  showInactive = () => {
    this.visible = true
  }
  hide = () => {
    if (!this.visible) return
    this.visible = false
    this.emit('hide')
  }
  minimize = () => {
    this.minimized = true
    this.emit('minimize')
  }
  restore = () => {
    this.minimized = false
    this.emit('restore')
  }
  close = () => {
    this.visible = false
    this.destroyed = true
    this.emit('closed')
  }
}

const action = { id: 'translate', name: 'Translate', enabled: true, isBuiltIn: true, selectedText: 'Hello' }

describe('selection action presentation', () => {
  const wm = application.get('WindowManager')
  let service: SelectionService
  let windows: Map<string, NativeWindow>
  let data: Map<string, SelectionActionWindowData>
  let created: Map<WindowType, (window: ManagedWindow) => void>
  let quick: NativeWindow | undefined
  let nextId: string

  const createWindow = (id: string, type = WindowType.SelectionAction) => {
    const window = new NativeWindow()
    windows.set(id, window)
    created.get(type)?.({ id, window } as unknown as ManagedWindow)
    return window
  }
  const openAction = (id = nextId) => {
    nextId = id
    service.processAction(action)
    return { window: windows.get(id)!, requestId: data.get(id)!.requestId }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    platform.isMac = true
    BaseService.resetInstances()
    MockMainPreferenceServiceUtils.resetMocks()
    vi.mocked(application.get('PreferenceService').get).mockImplementation((key) =>
      MockMainPreferenceServiceUtils.getPreferenceValue(key)
    )
    windows = new Map()
    data = new Map()
    created = new Map()
    quick = undefined
    nextId = 'result'
    vi.mocked(wm.onWindowCreatedByType).mockImplementation((type, listener) => {
      created.set(type, listener)
      return {
        dispose: () => {
          created.delete(type)
        }
      }
    })
    vi.mocked(wm.getWindowsByType).mockImplementation((type) =>
      type === WindowType.QuickAssistant && quick ? [quick as unknown as BrowserWindow] : []
    )
    vi.mocked(wm.getWindow).mockImplementation((id) => windows.get(id) as unknown as BrowserWindow)
    vi.mocked(wm.getInitData).mockImplementation((id) => data.get(id) ?? null)
    vi.mocked(wm.open).mockImplementation((_type, options) => {
      if (!windows.has(nextId)) createWindow(nextId)
      data.set(nextId, options!.initData as SelectionActionWindowData)
      return nextId
    })
    vi.mocked(wm.close).mockImplementation((id) => {
      data.delete(id)
      windows.get(id)?.hide()
      return true
    })
    vi.mocked(wm.behavior.setAlwaysOnTop).mockImplementation((id, enabled) => {
      windows.get(id)?.setAlwaysOnTop(enabled)
    })
    service = new SelectionService()
  })

  afterEach(async () => {
    await service._doDestroy()
    BaseService.resetInstances()
    vi.restoreAllMocks()
  })

  it.each(['fresh', 'standby', 'reused'] as const)(
    'keeps a %s result hidden until its own header is ready',
    async (mode) => {
      await service._doInit()
      if (mode !== 'fresh') createWindow('result')
      if (mode === 'reused') {
        const previous = openAction()
        service.markActionWindowReady('result', previous.requestId)
        wm.close('result')
      }
      const { window, requestId } = openAction()
      const previousShows = window.showCount
      window.emit('ready-to-show')
      expect(window.visible).toBe(false)
      service.markActionWindowReady('result', 'a different selection')
      expect(window.visible).toBe(false)
      service.markActionWindowReady('result', requestId)
      expect(window.visible).toBe(true)
      expect(window.showCount).toBe(previousShows + 1)
      service.markActionWindowReady('result', requestId)
      expect(window.showCount).toBe(previousShows + 1)
    }
  )

  it('ignores readiness from a previous use of the same pooled window', async () => {
    await service._doInit()
    const first = openAction()
    wm.close('result')
    const next = openAction()
    expect(next.requestId).not.toBe(first.requestId)
    service.markActionWindowReady('result', first.requestId)
    expect(next.window.visible).toBe(false)
    service.markActionWindowReady('result', next.requestId)
    expect(next.window.visible).toBe(true)
  })

  it.each(['close', 'close all', 'hide', 'destroy'] as const)(
    'does not resurrect an action after %s',
    async (operation) => {
      await service._doInit()
      const { window, requestId } = openAction()
      if (operation === 'close') wm.close('result')
      if (operation === 'close all') service.closeActionWindows()
      if (operation === 'hide') {
        window.show()
        window.hide()
      }
      if (operation === 'destroy') window.close()
      service.markActionWindowReady('result', requestId)
      expect(window.visible).toBe(false)
    }
  )

  it.each([false, true])('sets auto-pin %s before the first presentation', async (autoPin) => {
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.selection.auto_pin', autoPin)
    await service._doInit()
    const { window, requestId } = openAction()
    window.on('show', () => expect(window.level > 0).toBe(autoPin))
    service.markActionWindowReady('result', requestId)
    expect(window.visible).toBe(true)
    expect(window.level > 0).toBe(autoPin)
  })

  it.each(['existing', 'created'] as const)(
    'keeps results above an %s Quick Assistant and restores individual pins',
    async (mode) => {
      if (mode === 'existing') quick = createWindow('quick', WindowType.QuickAssistant)
      await service._doInit()
      if (mode === 'created') quick = createWindow('quick', WindowType.QuickAssistant)
      const pinned = openAction('pinned')
      const unpinned = openAction('unpinned')
      service.markActionWindowReady('pinned', pinned.requestId)
      service.markActionWindowReady('unpinned', unpinned.requestId)
      service.setActionWindowPinned('pinned', true)
      quick!.show()
      // Quick's show wrapper reapplies its level after emitting the show event.
      quick!.setAlwaysOnTop(true)
      expect(pinned.window.level).toBeGreaterThan(quick!.level)
      expect(unpinned.window.level).toBeGreaterThan(quick!.level)
      service.setActionWindowPinned('pinned', false)
      service.setActionWindowPinned('unpinned', true)
      expect(pinned.window.level).toBeGreaterThan(quick!.level)
      quick!.hide()
      expect(pinned.window.level).toBe(0)
      expect(unpinned.window.level).toBe(3)
      expect(application.get('PreferenceService').get('feature.selection.auto_pin')).toBe(false)
      quick!.show()
      quick!.close()
      expect(pinned.window.level).toBe(0)
      expect(unpinned.window.level).toBe(3)
      expect(quick!.eventNames()).toEqual([])
    }
  )

  it('resets a reused action’s pin after a temporarily elevated session', async () => {
    await service._doInit()
    quick = createWindow('quick', WindowType.QuickAssistant)
    quick.show()
    const first = openAction()
    service.markActionWindowReady('result', first.requestId)
    service.setActionWindowPinned('result', true)
    wm.close('result')
    const next = openAction()
    service.markActionWindowReady('result', next.requestId)
    expect(next.window.level).toBeGreaterThan(quick.level)
    quick.hide()
    expect(next.window.level).toBe(0)
  })

  it('restores pins when Windows dismisses Quick by minimizing and elevates results again on restore', async () => {
    platform.isMac = false
    await service._doInit()
    quick = createWindow('quick', WindowType.QuickAssistant)
    quick.show()
    const unpinned = openAction('unpinned')
    const pinned = openAction('pinned')
    service.markActionWindowReady('unpinned', unpinned.requestId)
    service.markActionWindowReady('pinned', pinned.requestId)
    service.setActionWindowPinned('pinned', true)
    expect(unpinned.window.level).toBe(3)
    quick.minimize()
    expect(quick.isVisible()).toBe(true)
    expect(unpinned.window.level).toBe(0)
    expect(pinned.window.level).toBe(3)
    const next = openAction('next')
    service.markActionWindowReady('next', next.requestId)
    expect(next.window.level).toBe(0)
    quick.restore()
    expect(unpinned.window.level).toBe(3)
    expect(next.window.level).toBe(3)
    quick.minimize()
    expect(unpinned.window.level).toBe(0)
    expect(next.window.level).toBe(0)
    expect(pinned.window.level).toBe(3)
  })

  it('releases window subscriptions when the service stops', async () => {
    await service._doInit()
    quick = createWindow('quick', WindowType.QuickAssistant)
    const { window } = openAction()
    await service._doStop()
    expect(quick.eventNames()).toEqual([])
    expect(window.eventNames()).toEqual([])
  })
})
