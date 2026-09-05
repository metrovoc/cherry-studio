/** Attach non-key native panels to this Electron window while it owns keyboard focus. */
export function trackAuxiliaryPanels(handle: Buffer): () => void

/** Observe clicks outside this window and its native children without taking focus. */
export function watchOutsideClicks(handle: Buffer, callback: () => void): () => void
