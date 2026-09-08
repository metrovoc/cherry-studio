import { projectStreamChunkForRenderer } from '@main/utils/messageOutputProjection'
import type { CherryUIMessage } from '@shared/data/types/message'
import type { UniqueModelId } from '@shared/data/types/model'
import type { IpcEventName } from '@shared/ipc/schemas/ipcSchemas'
import type { EventPayload } from '@shared/ipc/types'
import { IpcChannel } from '@shared/IpcChannel'
import type { UIMessageChunk } from 'ai'

import { projectStreamMessageForRenderer } from '../rendererPayload'
import type { StreamDoneResult, StreamErrorResult, StreamListener, StreamPausedResult } from '../types'

const COALESCE_WINDOW_MS = 16
const MAX_COALESCE_AGE_MS = 16
const MAX_COALESCE_CHARS = 2048

/** Id prefix for renderer (WebContents) listeners — full form `wc:${wc.id}:${topicId}`. */
const RENDERER_LISTENER_ID_PREFIX = 'wc:'

/**
 * True if `listener` streams to a renderer window (as opposed to an internal persistence / trace /
 * channel listener). Carried-forward filtering (e.g. a steer continuation re-attaching the prior
 * turn's windows) keys off this — using the predicate instead of an inline `'wc:'` literal keeps it
 * in lockstep with the id format, so a future id-format change can't silently stop windows
 * re-attaching to a continuation.
 */
export function isRendererListener(listener: Pick<StreamListener, 'id'>): boolean {
  return listener.id.startsWith(RENDERER_LISTENER_ID_PREFIX)
}

interface PendingDelta {
  type: 'text-delta' | 'reasoning-delta' | 'tool-input-delta'
  identifier: string
  sourceModelId: UniqueModelId | undefined
  anchorMessageId: string | undefined
  attemptId: number | undefined
  text: string
  initialMessage?: CherryUIMessage | null
}

type CoalescableChunk =
  | { type: 'text-delta'; id: string; delta: string; providerMetadata?: undefined }
  | { type: 'reasoning-delta'; id: string; delta: string; providerMetadata?: undefined }
  | { type: 'tool-input-delta'; toolCallId: string; inputTextDelta: string }

/** One instance per (topic, window). Id `wc:${wc.id}:${topicId}` is stable across re-attach. */
export class WebContentsListener implements StreamListener {
  readonly id: string

  private pending: PendingDelta | null = null
  private pendingStartedAt = 0
  private flushTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly wc: Electron.WebContents,
    private readonly topicId: string,
    readonly subscriptionId?: string
  ) {
    this.id = `${RENDERER_LISTENER_ID_PREFIX}${wc.id}:${topicId}`
  }

  startReplay(replay: Pick<EventPayload<'ai.stream.attached'>, 'bufferedChunks' | 'terminals' | 'seeds'>): void {
    if (this.subscriptionId) {
      this.emit('ai.stream.attached', { topicId: this.topicId, subscriptionId: this.subscriptionId, ...replay })
    }
  }

  dispose(): void {
    this.disposed = true
    this.discardPending()
  }

  onChunk(
    chunk: UIMessageChunk,
    sourceModelId?: UniqueModelId,
    anchorMessageId?: string,
    attemptId?: number,
    initialMessage?: CherryUIMessage | null
  ): void {
    if (this.disposed || this.wc.isDestroyed()) {
      this.discardPending()
      return
    }

    const coalescable = toCoalescable(chunk)
    if (coalescable) {
      const next = normalizePending(coalescable, sourceModelId, anchorMessageId, attemptId)
      next.initialMessage = initialMessage
      if (
        this.pending &&
        this.pending.type === next.type &&
        this.pending.identifier === next.identifier &&
        this.pending.sourceModelId === next.sourceModelId &&
        this.pending.anchorMessageId === next.anchorMessageId &&
        this.pending.attemptId === next.attemptId
      ) {
        this.pending.text += next.text
        if (
          performance.now() - this.pendingStartedAt >= MAX_COALESCE_AGE_MS ||
          this.pending.text.length >= MAX_COALESCE_CHARS
        ) {
          this.flushPending()
        }
        return
      }
      this.flushPending()
      this.pending = next
      this.pendingStartedAt = performance.now()
      this.flushTimer = setTimeout(() => this.flushPending(), COALESCE_WINDOW_MS)
      return
    }

    this.flushPending()
    this.sendChunk(chunk, sourceModelId, anchorMessageId, attemptId, initialMessage)
  }

  onDone(result: StreamDoneResult): void {
    if (this.disposed || this.wc.isDestroyed()) {
      this.discardPending()
      return
    }
    this.flushPending()
    this.emit('ai.stream.done', {
      topicId: this.topicId,
      executionId: result.modelId,
      ...(result.attemptId !== undefined ? { attemptId: result.attemptId } : {}),
      ...(result.topicAttemptWatermark !== undefined ? { topicAttemptWatermark: result.topicAttemptWatermark } : {}),
      anchorMessageId: result.anchorMessageId,
      status: result.status,
      isTopicDone: result.isTopicDone
    })
  }

  onPaused(result: StreamPausedResult): void {
    if (this.disposed || this.wc.isDestroyed()) {
      this.discardPending()
      return
    }
    this.flushPending()
    this.emit('ai.stream.done', {
      topicId: this.topicId,
      executionId: result.modelId,
      ...(result.attemptId !== undefined ? { attemptId: result.attemptId } : {}),
      ...(result.topicAttemptWatermark !== undefined ? { topicAttemptWatermark: result.topicAttemptWatermark } : {}),
      anchorMessageId: result.anchorMessageId,
      status: result.status,
      isTopicDone: result.isTopicDone
    })
  }

  onError(result: StreamErrorResult): void {
    if (this.disposed || this.wc.isDestroyed()) {
      this.discardPending()
      return
    }
    this.flushPending()
    // `result.finalMessage` is not forwarded — the renderer keeps its own accumulated state.
    this.emit('ai.stream.error', {
      topicId: this.topicId,
      executionId: result.modelId,
      ...(result.attemptId !== undefined ? { attemptId: result.attemptId } : {}),
      ...(result.topicAttemptWatermark !== undefined ? { topicAttemptWatermark: result.topicAttemptWatermark } : {}),
      anchorMessageId: result.anchorMessageId,
      isTopicDone: result.isTopicDone,
      error: result.error
    })
  }

  isAlive(): boolean {
    const alive = !this.disposed && !this.wc.isDestroyed()
    if (!alive) this.discardPending()
    return alive
  }

  private flushPending(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const p = this.pending
    if (!p) return
    this.pending = null
    this.sendChunk(rebuildChunk(p), p.sourceModelId, p.anchorMessageId, p.attemptId, p.initialMessage)
  }

  private discardPending(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pending = null
  }

  private sendChunk(
    chunk: UIMessageChunk,
    sourceModelId?: UniqueModelId,
    anchorMessageId?: string,
    attemptId?: number,
    initialMessage?: CherryUIMessage | null
  ): void {
    if (this.wc.isDestroyed()) return
    this.emit('ai.stream.chunk', {
      topicId: this.topicId,
      executionId: sourceModelId,
      ...(attemptId !== undefined ? { attemptId } : {}),
      anchorMessageId,
      ...(initialMessage !== undefined
        ? { initialMessage: initialMessage && projectStreamMessageForRenderer(this.topicId, initialMessage) }
        : {}),
      chunk: projectStreamChunkForRenderer(chunk, this.topicId, anchorMessageId)
    })
  }

  /**
   * Directed send of a typed AI stream event on the single IpcApi event channel — the
   * class-B topic-stream transport: this per-(topic,window) listener `send`s straight to its
   * own `WebContents` (preserving the coalescing/liveness above) instead of `broadcast`ing.
   * Wire-identical to `IpcApiService.send`, but keyed by the held `WebContents`, not a WindowId.
   */
  private emit<E extends IpcEventName>(event: E, payload: EventPayload<E>): void {
    this.wc.send(IpcChannel.IpcApi_Event, event, payload)
  }
}

function toCoalescable(chunk: UIMessageChunk): CoalescableChunk | null {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    if ('providerMetadata' in chunk && chunk.providerMetadata !== undefined) return null
    return chunk as CoalescableChunk
  }
  if (chunk.type === 'tool-input-delta') {
    return chunk as CoalescableChunk
  }
  return null
}

function normalizePending(
  chunk: CoalescableChunk,
  sourceModelId: UniqueModelId | undefined,
  anchorMessageId: string | undefined,
  attemptId: number | undefined
): PendingDelta {
  if (chunk.type === 'tool-input-delta') {
    return {
      type: 'tool-input-delta',
      identifier: chunk.toolCallId,
      sourceModelId,
      anchorMessageId,
      attemptId,
      text: chunk.inputTextDelta
    }
  }
  return {
    type: chunk.type,
    identifier: chunk.id,
    sourceModelId,
    anchorMessageId,
    attemptId,
    text: chunk.delta
  }
}

function rebuildChunk(p: PendingDelta): UIMessageChunk {
  if (p.type === 'tool-input-delta') {
    return { type: 'tool-input-delta', toolCallId: p.identifier, inputTextDelta: p.text } as UIMessageChunk
  }
  return { type: p.type, id: p.identifier, delta: p.text } as UIMessageChunk
}
