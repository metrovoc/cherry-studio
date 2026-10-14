import type { LanguageModelV3 } from '@ai-sdk/provider'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRetryableWrap } from '../createRetryableWrap'

const networkChanged = () => new Error('net::ERR_NETWORK_CHANGED')
const content = { type: 'text-delta', id: 'text', delta: 'Recovered answer' }

function wrap(doStream: ReturnType<typeof vi.fn>) {
  return createRetryableWrap({
    fallbacks: [],
    retryPolicy: { enabled: true, maxAttempts: 1, backoffEnabled: false, fallbackModelIds: [] }
  })!({
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'test',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream
  } as unknown as LanguageModelV3)
}

function response(parts: unknown[]) {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part)
        controller.close()
      }
    })
  }
}

async function collect(model: LanguageModelV3, abortSignal?: AbortSignal) {
  const result = await model.doStream({ prompt: [], abortSignal })
  const reader = result.stream.getReader()
  const parts: unknown[] = []
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return parts
      parts.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
}

afterEach(() => vi.useRealTimers())

describe('network change recovery', () => {
  it('recovers a failed connection with the same model after the retry delay', async () => {
    vi.useFakeTimers()
    const send = vi
      .fn()
      .mockRejectedValueOnce(networkChanged())
      .mockResolvedValue(response([content]))
    const pending = collect(wrap(send)).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(999)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual([content])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('recovers a stream read failure before content arrives', async () => {
    vi.useFakeTimers()
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        stream: new ReadableStream({
          start(controller) {
            controller.error(networkChanged())
          }
        })
      })
      .mockResolvedValue(response([content]))
    const pending = collect(wrap(send)).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toEqual([content])
  })

  it('preserves partial content without replaying the request', async () => {
    const failure = networkChanged()
    const send = vi.fn().mockResolvedValue(response([content, { type: 'error', error: failure }]))
    expect(await collect(wrap(send))).toEqual([content, { type: 'error', error: failure }])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('stops at the configured retry limit', async () => {
    vi.useFakeTimers()
    const failure = networkChanged()
    const send = vi.fn().mockRejectedValue(failure)
    const pending = collect(wrap(send)).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10000)
    expect(await pending).toMatchObject({ errors: [failure, failure] })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending retry when the user stops generation', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const send = vi.fn().mockRejectedValue(networkChanged())
    const pending = collect(wrap(send), controller.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.advanceTimersByTimeAsync(10000)
    expect(await pending).toBeInstanceOf(Error)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_INVALID_ARGUMENT', 'unrelated failure'])(
    'does not retry %s',
    async (message) => {
      const failure = new Error(message)
      const send = vi.fn().mockRejectedValue(failure)
      await expect(collect(wrap(send))).rejects.toBe(failure)
      expect(send).toHaveBeenCalledTimes(1)
    }
  )
})
