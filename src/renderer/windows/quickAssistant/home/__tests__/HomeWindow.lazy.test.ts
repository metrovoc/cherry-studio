import { describe, expect, it, vi } from 'vitest'

// Evaluating large module graphs (icon barrels, chat chain) under full-suite
// concurrency can blow past the global testTimeout — pin a generous bound.
const PROBE_TIMEOUT = 45_000

const chatWindowEvaluated = vi.hoisted(() => vi.fn())

vi.mock('../../chat/ChatWindow', () => {
  chatWindowEvaluated()
  return { default: () => null }
})

/**
 * The quick assistant boots on route='home' and must not statically evaluate
 * the chat branch, which carries the heavy message rendering chain.
 */
describe('HomeWindow lazy boundaries', () => {
  it(
    'importing HomeWindow does not evaluate the chat branch',
    async () => {
      await import('../HomeWindow')
      expect(chatWindowEvaluated).not.toHaveBeenCalled()
    },
    PROBE_TIMEOUT
  )

  it(
    'positive control: the branch modules load on demand',
    async () => {
      await import('../../chat/ChatWindow')
      expect(chatWindowEvaluated).toHaveBeenCalledTimes(1)
    },
    PROBE_TIMEOUT
  )
})
