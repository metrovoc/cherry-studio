import { trackAuxiliaryPanels } from '@cherrystudio/macos-panel'
import { isMac } from '@main/core/platform'
import type { AlwaysOnTopLevel, WindowBehavior, WindowQuirks } from '@main/core/window/types'
import type { BrowserWindow } from 'electron'

/**
 * Apply declarative OS quirks to a freshly-created window by monkey-patching
 * the native instance methods. Consumers continue calling `window.hide()` /
 * `window.show()` as usual; the wrappers transparently run the pre/post hooks.
 *
 * The native method is captured via `.bind(w)` so inner Electron C++ bindings
 * still see the correct `this`; other properties (`webContents`, EventEmitter
 * `.on/.once`, etc.) remain untouched.
 *
 * Distinct from `applyWindowBehavior`: this module holds **OS-specific hacks**
 * (workarounds for OS window-manager bugs). Non-hacky declarative behavior
 * (hideOnBlur, initial setVisibleOnAllWorkspaces, etc.) lives in `behavior.ts`.
 *
 * Must be called AFTER `applyWindowBehavior` so that the behavior layer's
 * initial setter calls (e.g. the first `setAlwaysOnTop(true, level)`) do not
 * accidentally re-trigger the monkey-patched show/showInactive hooks.
 *
 * @param window - The BrowserWindow instance
 * @param quirks - The OS workaround flags (undefined skips all work)
 * @param behavior - The declarative behavior layer, consulted for the level
 *   to re-apply under `reapplyAlwaysOnTop` (single source of truth for
 *   level/relativeLevel — see `behavior.alwaysOnTop`).
 * @param getLevelOverride - Closure returning the runtime level override for this
 *   window, or undefined when none is set. Re-applying the declared level would
 *   otherwise silently undo an override on the next show.
 */
export function applyWindowQuirks(
  window: BrowserWindow,
  quirks: WindowQuirks | undefined,
  behavior: WindowBehavior | undefined,
  getLevelOverride?: () => AlwaysOnTopLevel | undefined
): void {
  if (!quirks) return

  if (isMac && quirks.macAttachAuxiliaryPanels) {
    window.once('closed', trackAuxiliaryPanels(window.getNativeWindowHandle()))
  }

  if (isMac && quirks.macClearHoverOnHide) {
    const originalHide = window.hide.bind(window)
    window.hide = () => {
      originalHide()
      if (!window.isDestroyed()) {
        window.webContents.sendInputEvent({ type: 'mouseMove', x: -1, y: -1 })
      }
    }
  }

  // ── reapplyAlwaysOnTop ───────────────────────────────────────────────
  // Why:   [macOS] the level passed to setAlwaysOnTop() is not sticky across
  //        hide/show cycles — after the next show() it can silently demote,
  //        sliding the window behind fullscreen apps or the menu bar.
  //        [Windows] z-order among topmost windows is last-writer-wins, so a
  //        window that only asserts topmost at creation ends up behind any
  //        third-party floating window shown after it.
  // Does:  After show() / showInactive(), re-applies
  //        setAlwaysOnTop(true, level, relativeLevel) with values read from
  //        `behavior.alwaysOnTop` (single source of truth). The level argument
  //        is macOS-only; Windows ignores it and just re-asserts topmost.
  // When:  Window types that must retain an elevated stacking level
  //        (screen-saver for overlays on top of fullscreen apps; floating otherwise).
  //        No-op when `behavior.alwaysOnTop.level` / `relativeLevel` are unset.
  if (quirks.reapplyAlwaysOnTop) {
    // When behavior doesn't declare a level, fall back to 'floating' explicitly
    // rather than relying on Electron's internal default — this keeps the
    // re-apply call signature stable across Electron upgrades.
    const declaredLevel = behavior?.alwaysOnTop?.level ?? 'floating'
    const declaredRelativeLevel = behavior?.alwaysOnTop?.relativeLevel
    const originalShow = window.show.bind(window)
    const originalShowInactive = window.showInactive.bind(window)
    const reapply = () => {
      if (window.isDestroyed()) return
      // Read at fire time, not at patch time: the override is set long after this runs.
      const override = getLevelOverride?.()
      const level = override ?? declaredLevel
      // An override replaces the declared offset rather than stacking onto it.
      const relativeLevel = override !== undefined ? undefined : declaredRelativeLevel
      // Pass relativeLevel only when declared — avoids polluting the call
      // site with a trailing `undefined` that changes spy signatures.
      if (relativeLevel !== undefined) {
        window.setAlwaysOnTop(true, level, relativeLevel)
      } else {
        window.setAlwaysOnTop(true, level)
      }
    }
    window.show = () => {
      originalShow()
      reapply()
    }
    window.showInactive = () => {
      originalShowInactive()
      reapply()
    }
  }
}
