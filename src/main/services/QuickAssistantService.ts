/**
 * QuickAssistantService — business orchestration for the quick assistant window.
 *
 * Window infrastructure (BrowserWindow construction options, preload, HTML entry,
 * Dock visibility, macOS alwaysOnTop reapply) is owned by WindowManager via the
 * `WindowType.QuickAssistant` registry entry. This service keeps the per-feature
 * business policy:
 *
 *   - feature flag gate (`feature.quick_assistant.enabled`)
 *   - pin / blur auto-hide
 *   - cursor-aware repositioning across displays
 *   - platform-specific hide branch (Windows minimize+opacity)
 *   - mainWindow lifecycle coupling (auto-hide when main window appears)
 *   - strict navigation safety (block navigation outside the renderer origin)
 *   - bounds persistence (via WindowManager's rememberBounds capability)
 */
import { application } from '@application'
import { loggerService } from '@logger'
import { type Activatable, BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { isMac, isWin } from '@main/core/platform'
import { isAppRendererUrl } from '@main/core/security/validateSender'
import { WindowType } from '@main/core/window/types'
import type { BrowserWindow } from 'electron'
import { screen, shell, systemPreferences } from 'electron'

import { isSafeExternalUrl } from '../utils/externalUrlSafety'

const MACOS_WINDOW_RESIGNED_KEY_NOTIFICATION = 'NSWindowDidResignKeyNotification'

const logger = loggerService.withContext('QuickAssistantService')

@Injectable('QuickAssistantService')
@ServicePhase(Phase.WhenReady)
@DependsOn(['MainWindowService', 'WindowManager'])
export class QuickAssistantService extends BaseService implements Activatable {
  private windowId: string | null = null
  private isPinnedQuickAssistant = false
  private disposeWindowListeners: (() => void) | null = null

  protected async onInit() {
    this.registerDisposable(() => this.disposeWindowListeners?.())
    this.subscribeMainWindowLifecycle()

    // Attach per-instance behavior to each fresh QuickAssistant window. Fires exactly
    // once per BrowserWindow creation (never on singleton reopen) — pairs with
    // wm.open() in createQuickAssistant() so the setup covers both the primary path
    // and any future re-creation path uniformly.
    const wm = application.get('WindowManager')
    this.registerDisposable(
      wm.onWindowCreatedByType(WindowType.QuickAssistant, ({ window }) => {
        this.setupQuickAssistant(window)
      })
    )

    // Preference toggle drives activate/deactivate of heavy resources (BrowserWindow).
    // IPC handlers remain registered regardless, so the settings panel switch and global
    // shortcut continue to function; they simply become no-ops while deactivated.
    const preferenceService = application.get('PreferenceService')
    this.registerDisposable({
      dispose: preferenceService.subscribeChange('feature.quick_assistant.enabled', (enabled: boolean) => {
        if (enabled) void this.activate()
        else void this.deactivate()
      })
    })
  }

  protected async onReady() {
    const preferenceService = application.get('PreferenceService')
    if (preferenceService.get('feature.quick_assistant.enabled')) {
      await this.activate()
    }
  }

  /**
   * Load heavy resources: the BrowserWindow and its bounds-tracking state. If creation
   * fails partway, releaseActivationResources() cleans up so the next activate() starts
   * from a clean slate (Activatable failure contract).
   */
  async onActivate(): Promise<void> {
    try {
      this.createQuickAssistant()
    } catch (error) {
      this.releaseActivationResources()
      throw error
    }
  }

  /**
   * Release heavy resources: destroy the BrowserWindow (ending its Chromium renderer
   * process). Also invoked automatically by BaseService._doStop() on service shutdown.
   */
  async onDeactivate(): Promise<void> {
    this.releaseActivationResources()
  }

  private releaseActivationResources(): void {
    if (this.windowId) {
      // QuickAssistant is a singleton — wm.close() falls through to destroyWindow()
      // just like wm.destroy() would, but stays in the Consumer API layer. The
      // registered 'closed' listener clears this.windowId via onClosed in setupQuickAssistant.
      const wm = application.get('WindowManager')
      wm.close(this.windowId)
      this.windowId = null
    }
    this.isPinnedQuickAssistant = false
  }

  /**
   * Subscribe to mainWindow lifecycle through MainWindowService's event API (loose coupling).
   *   - Hide quickWindow when mainWindow becomes visible ('show') or is restored from
   *     minimized ('restore'). Both are required: MainWindowService.showMainWindow calls
   *     mainWindow.restore() for the minimized branch, which does NOT fire 'show'.
   */
  private subscribeMainWindowLifecycle() {
    const windowService = application.get('MainWindowService')

    const attach = (mainWindow: BrowserWindow) => {
      const onMainVisible = () => {
        const window = this.getQuickAssistant()
        if (window) window.hide()
      }

      mainWindow.on('show', onMainVisible)
      mainWindow.on('restore', onMainVisible)
      this.registerDisposable(() => {
        mainWindow.removeListener('show', onMainVisible)
        mainWindow.removeListener('restore', onMainVisible)
      })
    }

    this.registerDisposable(windowService.onMainWindowCreated((w) => attach(w)))
  }

  /**
   * Strict navigation safety for the quick window. Quick window is a single-page SPA;
   * any will-navigate that does not target the app's own renderer is treated as an
   * attempt to leave the SPA shell and is either re-routed to the system browser
   * (when safe) or denied.
   *
   * Coexists with WindowManager's default handlers (WindowManager.ts: createWindow):
   *   - will-navigate: both listeners fire; this stricter preventDefault wins.
   *   - setWindowOpenHandler: last-call-wins per Electron contract; this overrides
   *     WindowManager's default and applies the stricter safe-URL check.
   */
  private setupQuickAssistantWebContents(window: BrowserWindow) {
    window.webContents.on('will-navigate', (event, url) => {
      // In-app navigation (dev-server origin, or a packaged page under the app root).
      if (isAppRendererUrl(url)) {
        return
      }

      event.preventDefault()
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url)
      } else {
        logger.warn(`Blocked navigation to untrusted URL scheme: ${url}`)
      }
    })

    window.webContents.setWindowOpenHandler((details) => {
      if (isSafeExternalUrl(details.url)) {
        void shell.openExternal(details.url)
      } else {
        logger.warn(`Blocked shell.openExternal for untrusted URL scheme: ${details.url}`)
      }
      return { action: 'deny' }
    })
  }

  /**
   * Idempotently ensure the quick window exists. Safe to call from any code path —
   * if the window is already alive (this.windowId set), this is a no-op.
   *
   * Position/size are restored by WindowManager (rememberBounds) at construction,
   * so no bounds options are passed here.
   *
   * wm.open() fires _onWindowCreated synchronously during createWindow(), so by
   * the time it returns both the BrowserWindow and our setup listeners (blur,
   * closed, show) are attached. We then assign this.windowId and proceed.
   */
  private createQuickAssistant() {
    if (this.windowId) return

    const wm = application.get('WindowManager')
    this.windowId = wm.open(WindowType.QuickAssistant)
  }

  /**
   * Attach all quick-window-specific behavior to a freshly created BrowserWindow:
   * navigation safety, OS workspace visibility, alwaysOnTop level, blur/show
   * listeners. Invoked once per fresh window from the onWindowCreatedByType
   * subscription registered in onInit.
   */
  private setupQuickAssistant(window: BrowserWindow) {
    this.disposeWindowListeners?.()
    this.setupQuickAssistantWebContents(window)

    // Declarative window infra (initial alwaysOnTop level, cross-workspace visibility,
    // macOS level reapply across show cycles) is owned by WindowManager via the
    // `WindowType.QuickAssistant` registry entry (`behavior` + `quirks`).

    // Windows needs minimize + opacity; macOS panels need Cocoa key-window events.
    const onBlur = () => {
      if (!isMac && !this.isPinnedQuickAssistant) {
        this.hideQuickAssistant()
      }
    }
    // The renderer refreshes its clipboard and input focus on each show.
    const onShow = () => {
      if (this.windowId && !window.isDestroyed()) {
        application.get('IpcApiService').send(this.windowId, 'quick_assistant.shown', undefined)
      }
    }
    let keyWindowSubscription: number | null = null
    let focusCheck: ReturnType<typeof setImmediate> | null = null
    const cancelFocusCheck = () => {
      if (focusCheck) {
        clearImmediate(focusCheck)
        focusCheck = null
      }
    }
    const dispose = () => {
      cancelFocusCheck()
      if (keyWindowSubscription !== null) {
        systemPreferences.unsubscribeLocalNotification(keyWindowSubscription)
        keyWindowSubscription = null
      }
      this.disposeWindowListeners = null
      if (window.isDestroyed()) return
      window.removeListener('blur', onBlur)
      window.removeListener('show', onShow)
      window.removeListener('hide', cancelFocusCheck)
      window.removeListener('closed', onClosed)
    }
    const onClosed = () => {
      this.windowId = null
      dispose()
    }

    window.on('blur', onBlur)
    window.on('show', onShow)
    window.on('hide', cancelFocusCheck)
    window.once('closed', onClosed)

    if (isMac) {
      // Electron's blur follows the main window, while a panel can lose key focus independently.
      keyWindowSubscription = systemPreferences.subscribeLocalNotification(
        MACOS_WINDOW_RESIGNED_KEY_NOTIFICATION,
        () => {
          cancelFocusCheck()
          // Cocoa resigns the old key window before assigning the new one during show().
          focusCheck = setImmediate(() => {
            focusCheck = null
            if (!window.isDestroyed() && window.isVisible() && !window.isFocused() && !this.isPinnedQuickAssistant) {
              this.hideQuickAssistant()
            }
          })
        }
      )
    }

    this.disposeWindowListeners = dispose
  }

  /** Returns the live quick window or null if not created / already destroyed. */
  private getQuickAssistant(): BrowserWindow | null {
    if (!this.windowId) return null
    const window = application.get('WindowManager').getWindow(this.windowId)
    if (!window || window.isDestroyed()) return null
    return window
  }

  public showQuickAssistant() {
    // A closed window may be recreated only while the feature remains enabled.
    if (!this.isActivated) return

    this.createQuickAssistant()
    this.proceedShow()
  }

  /** Inner show pipeline. Assumes the quick window exists and its content is ready. */
  private proceedShow() {
    const window = this.getQuickAssistant()
    if (!window) return

    // [Windows] Recovery from the minimize-instead-of-hide branch in hideQuickAssistant.
    // Note: do NOT use restore() — Electron has a bug across screens with different scale
    // factors. Use show() then setPosition/setBounds. setOpacity(0) hides the visual
    // glitch while we reposition.
    if (window.isMinimized()) {
      window.setOpacity(0)
      window.show()
    }

    this.repositionToCursorDisplay(window)

    window.setOpacity(1)
    window.show()
  }

  /**
   * If the cursor is on a different display than the quick window, move the window
   * to the center of the cursor's display. setPosition + setBounds works around an
   * Electron scale-factor bug between displays.
   */
  private repositionToCursorDisplay(window: BrowserWindow) {
    const bounds = window.getBounds()
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const windowDisplay = screen.getDisplayNearestPoint(bounds)

    if (cursorDisplay.id === windowDisplay.id) return

    const workArea = cursorDisplay.bounds
    const { width, height } = bounds
    const x = Math.round(workArea.x + (workArea.width - width) / 2)
    const y = Math.round(workArea.y + (workArea.height - height) / 2)

    window.setPosition(x, y, false)
    window.setBounds({ x, y, width, height })
  }

  public hideQuickAssistant() {
    const window = this.getQuickAssistant()
    if (!window) return

    if (isWin) {
      // Hide() vs minimize() on Windows: minimize avoids a visible flicker on next show
      // and skipTaskbar:true keeps it out of the taskbar. setOpacity(0) hides the
      // minimize animation entirely.
      window.setOpacity(0)
      window.minimize()
      return
    }

    window.hide()
  }

  /**
   * Hides the quick window rather than destroying it. The quick window is a
   * high-frequency toggle surface; destroy + recreate would cause a blank-flash
   * on next show (loadURL is async and ready-to-show races the show() call) and
   * waste the preload work. The renderer call sites (settings panel toggles)
   * only need the window to disappear — hide() satisfies that. True teardown
   * happens in onDeactivate() when the feature preference is turned off, and
   * as a final fallback in WindowManager.onDestroy() at app quit.
   */
  public closeQuickAssistant() {
    this.getQuickAssistant()?.hide()
  }

  public toggleQuickAssistant() {
    const window = this.getQuickAssistant()
    if (window?.isVisible() && window.isFocused()) {
      this.hideQuickAssistant()
      return
    }
    this.showQuickAssistant()
  }

  public setPinQuickAssistant(isPinned: boolean) {
    this.isPinnedQuickAssistant = isPinned
  }
}
