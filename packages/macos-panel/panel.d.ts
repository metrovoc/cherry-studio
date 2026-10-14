/** Attach non-key native panels to this Electron window while it owns keyboard focus. */
export function trackAuxiliaryPanels(handle: Buffer): () => void

/** Initialize a fresh nonactivating panel before its first show on macOS 27 and later. */
export function preventWindowActivation(handle: Buffer): void

/** Prevent title-bar double-click Fill while preserving other double-click actions and ordinary resizing. */
export function preventWindowFill(handle: Buffer): () => void

/** Observe clicks outside this window and its native children without taking focus. */
export function watchOutsideClicks(
  handle: Buffer,
  callback: () => void
): {
  setCompanions(handles: Buffer[]): void
  dispose(): void
}
