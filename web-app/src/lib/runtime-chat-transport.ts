import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  ChatRequestOptions,
  ChatTransport,
  LanguageModelUsage,
  UIMessage,
  UIMessageChunk,
} from 'ai'
import { buildRuntimePrompt, type KnowledgeContext } from '@/lib/knowledge-retrieval'
import { extractLatestUserMessage } from '@/lib/demo-runtime'
import { InlineThinkSplitter } from '@/lib/inline-think-splitter'
import {
  RUNTIME_EVENT_NAME,
  RUNTIME_SESSION_ID,
  formatRuntimeCommandError,
  parseRunStartResult,
  parseRuntimeEventEnvelope,
  parseRuntimeSnapshot,
  parseSessionCreateResult,
  runtimeDataPartType,
  type RuntimeEventEnvelope,
  type RuntimeCapabilities,
  type RuntimePermissionData,
  type RuntimeSession,
  type RuntimeToolData,
} from '@/lib/runtime-contract'
import { useRuntimeStore } from '@/stores/runtime-store'

function mergeUpdate(previous: unknown, next: unknown): unknown {
  if (
    typeof previous === 'object' &&
    previous !== null &&
    !Array.isArray(previous) &&
    typeof next === 'object' &&
    next !== null &&
    !Array.isArray(next)
  ) {
    return { ...previous, ...next }
  }
  return next
}

function protocolError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `acp_protocol_error: ${detail}`
}

function runSnapshotError(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown } | undefined
  return typeof value?.code === 'string' && typeof value.message === 'string'
    ? `${value.code}: ${value.message}`
    : 'run_failed: Runtime Run failed'
}

export function shouldCancelRuntimeOnStreamClose(durableSessions: boolean) {
  return !durableSessions
}

function currentDurableSessions() {
  const capabilities = useRuntimeStore.getState().capabilities
  return capabilities?.durableSessions ?? false
}

/**
 * Streaming coalescer.
 *
 * The Hermes ACP runtime emits text/reasoning deltas at ~15 chunks/s. Every
 * chunk becomes an AI SDK message mutation, a full React reconcile of the
 * thread tree, and a Tauri persistence IPC — on this riscv64 board that alone
 * keeps the renderer at ~1 core while an answer streams. The upstream AI SDK
 * `experimental_throttle: 50` does not help: its leading-edge throttle is no
 * throttle at all when chunks arrive faster than 50ms apart, which they do.
 *
 * So we coalesce here, in the fork-owned transport, before anything downstream
 * sees the stream: deltas accumulate per part and flush on a fixed cadence.
 * The UI lags by at most one window and converges exactly at stream end. To
 * keep a reply from sitting blank for a full window, the first delta of each
 * window is emitted immediately (lead edge) — see DeltaCoalescer.push.
 */
// Halved window: still merges deltas that arrive back-to-back in one batch,
// but the first text of a burst shows sooner. Measured against 250ms and a
// 50ms probe on the SpacemiT K3 board — 50ms sits below the ~66ms mean spacing of
// the ~15 ACP chunks/s this fork sees, which collapses back to the
// uncoalesced path the coalescer exists to avoid.
const STREAM_COALESCE_MS = 100

/**
 * Master switch for the streaming coalescer.
 *
 * When false every ACP delta is enqueued to the AI SDK immediately, i.e. the
 * upstream (uncoalesced) behaviour. This exists as a build-time control so we
 * can A/B a coalesced build against a plain build on identical input — flip
 * it to `false`, rebuild, and compare WebKit/renderer stability under a long
 * stream. Shipping builds keep it `true`.
 */
const STREAM_COALESCE_ENABLED = true

type CoalescedPart =
  | { type: 'text-delta'; id: string }
  | { type: 'reasoning-delta'; id: string }

class DeltaCoalescer {
  private pending = new Map<string, { part: CoalescedPart; delta: string }>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly enqueue: (chunk: UIMessageChunk) => void,
    private readonly windowMs: number = STREAM_COALESCE_MS,
    private readonly enabled: boolean = STREAM_COALESCE_ENABLED
  ) {}

  push(part: CoalescedPart, delta: string) {
    if (!this.enabled) {
      // Uncoalesced path: hand each delta straight to the consumer, matching
      // upstream behaviour (used for the A/B comparison build).
      this.enqueue({ ...part, delta })
      return
    }
    const key = `${part.type}:${part.id}`
    const existing = this.pending.get(key)
    if (existing) {
      existing.delta += delta
    } else {
      this.pending.set(key, { part, delta })
    }
    // Lead edge: when nothing has been coalesced in the current window, emit
    // this delta immediately instead of waiting for the window timer — the
    // first content shows up the moment the model starts producing it (without
    // this, a warm-model reply sat blank for a whole window, which read as
    // "not streaming"). Everything that follows still coalesces on the timer,
    // so the per-window enqueue count stays low.
    if (this.timer === undefined && this.pending.size === 1) {
      const first = this.pending.get(key)!
      this.pending.clear()
      this.enqueue({ ...first.part, delta: first.delta })
    }
    this.arm()
  }

  /** Emit accumulated deltas now, preserving per-part arrival order. */
  flush() {
    if (!this.enabled) return
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.pending.size === 0) return
    for (const { part, delta } of this.pending.values()) {
      this.enqueue({ ...part, delta })
    }
    this.pending.clear()
  }

  private arm() {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.windowMs)
  }

  /** Drop everything without emitting — for a stream the consumer cancelled. */
  dispose() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.pending.clear()
  }
}

export class RuntimeChatTransport implements ChatTransport<UIMessage> {
  private detachActiveStream?: () => void
  private activeChatId?: string

  isActivelyDriving(chatId: string): boolean {
    return this.activeChatId === chatId
  }

  detach() {
    this.activeChatId = undefined
    const detach = this.detachActiveStream
    this.detachActiveStream = undefined
    detach?.()
  }

  async sendMessages(
    options: {
      trigger: 'submit-message' | 'regenerate-message'
      chatId: string
      messageId: string | undefined
      messages: UIMessage[]
      abortSignal: AbortSignal | undefined
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    this.activeChatId = options.chatId
    const userMessage = extractLatestUserMessage(options.messages)
    let unlisten: UnlistenFn | undefined
    let activeRunId: string | undefined
    let returnedRunId: string | undefined
    let runtimeEpoch: string | undefined
    let runtimeId: RuntimeEventEnvelope['runtimeId'] | undefined
    let runtimeReady = false
    let runStartIssued = false
    const queuedRunEvents: RuntimeEventEnvelope[] = []
    let expectedSequence = 0
    let openTextId: string | undefined
    let openReasoningId: string | undefined
    // The agent reuses one message id for every phase of a turn, so a turn that
    // alternates thought → body → thought → body sends all four phases under the
    // same id. AI SDK part ids must be unique per part: `reasoning-end` deletes
    // the id from its active map, and a later `reasoning-delta` on a deleted id
    // throws UIMessageStreamError, killing the stream mid-answer (the thinking
    // card vanishes from the DOM). Segments therefore carry a `#r<n>` / `#t<n>`
    // suffix from the second occurrence onward, so a repeat phase is a genuinely
    // new part rather than a re-open of a closed one. The channel letter is part
    // of the suffix because reasoning and text share one id space in the SDK —
    // without it the second thought and the second body would collide on the
    // same id and the answer text would stream into the thinking card.
    // The first segment keeps the bare message id, which is what a single-phase
    // turn (the common case) emits.
    const segmentCounts = new Map<string, number>()
    const openSegmentIds = new Map<string, string>()
    const segmentId = (kind: 'r' | 't', baseId: string) => {
      const key = `${kind}:${baseId}`
      const open = openSegmentIds.get(key)
      if (open) return open
      const n = (segmentCounts.get(key) ?? 0) + 1
      segmentCounts.set(key, n)
      const id = n === 1 ? baseId : `${baseId}#${kind}${n}`
      openSegmentIds.set(key, id)
      return id
    }
    // Drop the open-segment entry at a phase boundary, so the next delta on the
    // same base id allocates a fresh part instead of reviving the closed one.
    const retireSegment = (kind: 'r' | 't', baseId: string) => {
      openSegmentIds.delete(`${kind}:${baseId}`)
    }
    // Maps an emitted part id back to the base message id it came from, so a
    // phase-boundary close knows which segment entry to retire.
    const segmentBase = new Map<string, { kind: 'r' | 't'; baseId: string }>()
    // Created inside the stream's `start` once the controller exists; the stream
    // `cancel` method reaches it through this outer variable to stop its timer.
    let coalescer: DeltaCoalescer | undefined
    // Splits inline `<think>` blocks out of the text channel, one per message id.
    const thinkSplitters = new Map<string, InlineThinkSplitter>()
    let terminal = false
    let cancelPending = false
    let cancelRequested = false
    let cancelRequest: Promise<void> | undefined
    let reportCancelFailure: ((error: unknown) => void) | undefined
    let detachStream: (() => void) | undefined
    const seenEventIds = new Set<string>()
    const tools = new Map<string, RuntimeToolData>()
    const permissions = new Map<string, RuntimePermissionData>()

    const cleanup = () => {
      if (this.activeChatId === options.chatId) {
        this.activeChatId = undefined
      }
      options.abortSignal?.removeEventListener('abort', onAbort)
      unlisten?.()
      unlisten = undefined
      if (this.detachActiveStream === detachStream) {
        this.detachActiveStream = undefined
      }
    }

    const cancelRun = (): Promise<void> => {
      cancelPending = true
      const runId = activeRunId ?? returnedRunId
      if (!runId) return Promise.resolve()
      if (cancelRequested) return cancelRequest ?? Promise.resolve()
      cancelRequested = true
      const request = invoke('runtime_run_cancel', {
        request: { sessionId: options.chatId, runId },
      })
        .then(() => undefined)
        .catch((error) => {
          cancelRequested = false
          throw error
        })
        .finally(() => {
          if (cancelRequest === request) cancelRequest = undefined
        })
      cancelRequest = request
      return request
    }

    const onAbort = () => {
      void cancelRun().catch((error) => reportCancelFailure?.(error))
    }

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        // All text/reasoning deltas flow through the coalescer so the AI SDK
        // and React see ~4 updates/s instead of one per ACP chunk.
        const c = new DeltaCoalescer((chunk) => {
          controller.enqueue(chunk)
        })
        coalescer = c

        /**
         * Close whichever part is open, retiring its segment id so the next
         * delta on that base id opens a fresh part instead of reviving a part
         * the SDK has already deleted from its active map.
         */
        const closeReasoning = () => {
          if (!openReasoningId) return
          // Flush first: `-end` markers bypass the coalescer, so a delta still
          // sitting in the 250ms window would otherwise land *after* its `-end`
          // and the AI SDK throws "delta for missing part", killing the stream.
          c.flush()
          const base = segmentBase.get(openReasoningId)
          if (base) retireSegment(base.kind, base.baseId)
          controller.enqueue({ type: 'reasoning-end', id: openReasoningId })
          openReasoningId = undefined
        }

        const closeText = () => {
          if (!openTextId) return
          c.flush()
          const base = segmentBase.get(openTextId)
          if (base) retireSegment(base.kind, base.baseId)
          controller.enqueue({ type: 'text-end', id: openTextId })
          openTextId = undefined
        }

        /**
         * Open (or keep) the body-text part for `baseId` and return the part id
         * its deltas must carry. Opening body text first closes any open
         * reasoning part, so reasoning/body cards alternate in message order
         * (thought → body → thought → body) instead of merging into one part.
         */
        const openText = (baseId: string): string => {
          const id = segmentId('t', baseId)
          if (openTextId === id) return id
          closeReasoning()
          closeText()
          openTextId = id
          segmentBase.set(id, { kind: 't', baseId })
          controller.enqueue({ type: 'text-start', id })
          return id
        }

        /**
         * Open (or keep) the reasoning part for `baseId` and return the part id
         * its deltas must carry. Mirrors openText at the other phase boundary.
         */
        const openReasoning = (baseId: string): string => {
          const id = segmentId('r', baseId)
          if (openReasoningId === id) return id
          closeText()
          closeReasoning()
          openReasoningId = id
          segmentBase.set(id, { kind: 'r', baseId })
          controller.enqueue({ type: 'reasoning-start', id })
          return id
        }

        /**
         * Route one text-channel delta, peeling off any inline `<think>` block.
         * Reasoning extracted here gets its own `:think` id so it renders as a
         * part separate from the agent's own thought channel, whose decorative
         * status line would otherwise be concatenated with the real reasoning.
         */
        const emitTextDelta = (messageId: string, delta: string) => {
          let splitter = thinkSplitters.get(messageId)
          if (!splitter) {
            splitter = new InlineThinkSplitter()
            thinkSplitters.set(messageId, splitter)
          }
          for (const piece of splitter.push(delta)) {
            if (!piece.delta) continue
            if (piece.channel === 'reasoning') {
              const id = openReasoning(`${messageId}:think`)
              c.push({ type: 'reasoning-delta', id }, piece.delta)
            } else {
              const id = openText(messageId)
              c.push({ type: 'text-delta', id }, piece.delta)
            }
          }
        }

        const closeOpenParts = () => {
          // Emit anything a splitter or the coalescer is still holding, so a
          // truncated turn does not silently drop the tail of its text.
          for (const [messageId, splitter] of thinkSplitters) {
            for (const piece of splitter.flush()) {
              if (!piece.delta) continue
              if (piece.channel === 'reasoning') {
                const id = openReasoning(`${messageId}:think`)
                c.push({ type: 'reasoning-delta', id }, piece.delta)
              } else {
                const id = openText(messageId)
                c.push({ type: 'text-delta', id }, piece.delta)
              }
            }
          }
          thinkSplitters.clear()
          closeReasoning()
          closeText()
        }

        const finishOnce = (chunk: UIMessageChunk) => {
          if (terminal) return
          terminal = true
          closeOpenParts()
          controller.enqueue(chunk)
          controller.close()
          cleanup()
        }
        detachStream = () =>
          finishOnce({ type: 'abort', reason: '客户端已分离' })
        this.detach()
        this.detachActiveStream = detachStream

        reportCancelFailure = (error) => {
          finishOnce({
            type: 'error',
            errorText: `runtime_run_cancel failed: ${formatRuntimeCommandError(error)}`,
          })
        }

        const failProtocol = (error: unknown) => {
          if (shouldCancelRuntimeOnStreamClose(currentDurableSessions())) {
            void cancelRun().catch(() => undefined)
          }
          finishOnce({ type: 'error', errorText: protocolError(error) })
        }

        const emitTool = (data: RuntimeToolData) => {
          tools.set(data.toolCallId, data)
          controller.enqueue({
            type: runtimeDataPartType.tool,
            id: data.toolCallId,
            data,
          })
        }

        const emitPermission = (data: RuntimePermissionData) => {
          permissions.set(data.requestId, data)
          controller.enqueue({
            type: runtimeDataPartType.permission,
            id: data.requestId,
            data,
          })
        }

        const receiveEvent = (envelope: RuntimeEventEnvelope) => {
          if (terminal) return
          if (envelope.sessionId === RUNTIME_SESSION_ID) return
          if (envelope.sessionId !== options.chatId) return
          if (!runtimeReady || !runStartIssued) return
          if (!runtimeEpoch || envelope.runtimeEpoch !== runtimeEpoch) return
          if (!runtimeId || envelope.runtimeId !== runtimeId) return
          if (!returnedRunId) {
            queuedRunEvents.push(envelope)
            return
          }
          if (seenEventIds.has(envelope.eventId)) return

          const isRunStart = envelope.event.type === 'run_started'
          if (isRunStart) {
            if (activeRunId && envelope.runId !== activeRunId) return
            if (returnedRunId && envelope.runId !== returnedRunId) {
              failProtocol(new Error('runtime_run_start returned a different runId'))
              return
            }
          } else if (!activeRunId) {
            if (returnedRunId && envelope.runId !== returnedRunId) return
            failProtocol(new Error('the first run event must be run_started'))
            return
          } else if (envelope.runId !== activeRunId) {
            return
          }

          if (envelope.sequence < expectedSequence) return
          if (envelope.sequence > expectedSequence) {
            failProtocol(
              new Error(
                `sequence gap: expected ${expectedSequence}, received ${envelope.sequence}`
              )
            )
            return
          }

          seenEventIds.add(envelope.eventId)
          expectedSequence += 1
          const event = envelope.event

          switch (event.type) {
            case 'run_started':
              activeRunId = envelope.runId
              runtimeEpoch = envelope.runtimeEpoch
              controller.enqueue({
                type: 'start',
                messageId: envelope.runId,
                messageMetadata: {
                  runtime: envelope.runtimeId,
                  runtimeEpoch: envelope.runtimeEpoch,
                },
              })
              if (cancelPending) {
                void cancelRun().catch((error) => reportCancelFailure?.(error))
              }
              return
            case 'text_delta':
              emitTextDelta(event.messageId, event.delta)
              return
            case 'reasoning_delta': {
              const id = openReasoning(event.messageId)
              c.push({ type: 'reasoning-delta', id }, event.delta)
              return
            }
            case 'tool_started':
              // A tool call is a hard phase boundary: close any open reasoning
              // or text part so the tool renders between reasoning/body segments
              // rather than being swallowed into an open text part.
              closeReasoning()
              closeText()
              emitTool({
                toolCallId: event.toolCallId,
                name: event.name,
                status: 'running',
                ...(event.input === undefined ? {} : { input: event.input }),
              })
              return
            case 'tool_updated': {
              const current = tools.get(event.toolCallId)
              if (!current) {
                failProtocol(new Error('tool_updated arrived before tool_started'))
                return
              }
              emitTool({
                ...current,
                status: 'running',
                update: mergeUpdate(current.update, event.update),
              })
              return
            }
            case 'tool_completed': {
              const current = tools.get(event.toolCallId)
              if (!current) {
                failProtocol(new Error('tool_completed arrived before tool_started'))
                return
              }
              emitTool({
                ...current,
                status: event.error ? 'failed' : 'completed',
                ...(event.result === undefined ? {} : { result: event.result }),
                ...(event.error === undefined ? {} : { error: event.error }),
              })
              return
            }
            case 'permission_requested':
              emitPermission({
                ...event.request,
                runtimeId: envelope.runtimeId,
                runtimeEpoch: envelope.runtimeEpoch,
                sessionId: envelope.sessionId,
                runId: envelope.runId!,
                createdAt: envelope.timestamp,
                status: 'pending',
              })
              return
            case 'permission_resolved': {
              const current = permissions.get(event.requestId)
              if (!current) {
                failProtocol(
                  new Error('permission_resolved arrived before permission_requested')
                )
                return
              }
              emitPermission({
                ...current,
                status: 'resolved',
                decision: event.decision,
              })
              return
            }
            case 'diagnostic_notice':
              controller.enqueue({
                type: runtimeDataPartType.diagnostic,
                id: envelope.eventId,
                data: { level: event.level, message: event.message },
              })
              return
            case 'run_completed':
              finishOnce({ type: 'finish', finishReason: 'stop' })
              return
            case 'run_cancelled':
              finishOnce({ type: 'abort', reason: event.reason ?? '已取消' })
              return
            case 'run_failed':
              finishOnce({
                type: 'error',
                errorText: `${event.error.code}: ${event.error.message}`,
              })
              return
            case 'runtime_status_changed':
            case 'connection_status_changed':
              return
          }
        }

        try {
          unlisten = await listen(RUNTIME_EVENT_NAME, ({ payload }) => {
            try {
              receiveEvent(parseRuntimeEventEnvelope(payload))
            } catch (error) {
              failProtocol(error)
            }
          })
          if (terminal) {
            cleanup()
            return
          } else {
            options.abortSignal?.addEventListener('abort', onAbort, {
              once: true,
            })
            if (options.abortSignal?.aborted) {
              void cancelRun().catch((error) => reportCancelFailure?.(error))
              finishOnce({ type: 'abort', reason: '已取消' })
              return
            }
          }

          await invoke('runtime_controller_acquire')
          const snapshot = parseRuntimeSnapshot(await invoke('runtime_start'))
          runtimeId = snapshot.runtimeId
          runtimeEpoch = snapshot.runtimeEpoch
          if (snapshot.status !== 'ready' || !runtimeEpoch) {
            throw new Error('Runtime is not ready')
          }
          runtimeReady = true

          const session = parseSessionCreateResult(
            await invoke('runtime_session_create', {
              request: { sessionId: options.chatId },
            })
          )
          if (
            session.sessionId !== options.chatId ||
            session.runtimeEpoch !== runtimeEpoch
          ) {
            throw new Error('Runtime session does not match the active runtime')
          }

          runStartIssued = true
          const returnedRun = parseRunStartResult(
            await invoke('runtime_run_start', {
              request: {
                sessionId: options.chatId,
                userMessageId: userMessage.id,
                prompt: buildRuntimePrompt(userMessage.prompt, userMessage.knowledgeContext as KnowledgeContext | undefined),
              },
            })
          )
          returnedRunId = returnedRun.runId
          if (activeRunId && activeRunId !== returnedRunId) {
            failProtocol(new Error('runtime_run_start returned a different runId'))
          } else {
            const queuedEvents = queuedRunEvents.splice(0)
            for (const envelope of queuedEvents) {
              if (envelope.runId === returnedRunId) receiveEvent(envelope)
            }
          }
          if (cancelPending) await cancelRun()
        } catch (error) {
          if (!terminal) {
            finishOnce({
              type: 'error',
              errorText:
                error instanceof Error
                  ? error.message
                  : formatRuntimeCommandError(error),
            })
          }
        }
      },
      cancel: () => {
        if (!shouldCancelRuntimeOnStreamClose(currentDurableSessions())) {
          terminal = true
          coalescer?.dispose()
          cleanup()
          return
        }
        if (!terminal) {
          void cancelRun().catch(() => undefined)
          terminal = true
        }
        coalescer?.dispose()
        cleanup()
      },
    })
  }

  async reconnectToStream(options: {
    chatId: string
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    // 重连既有会话的流是读操作：不申请工作台控制权，控制权只在写入时申请。
    const snapshot = parseRuntimeSnapshot(await invoke('runtime_start'))
    const capabilities = await invoke<RuntimeCapabilities>(
      'runtime_capabilities'
    )
    if (
      snapshot.status !== 'ready' ||
      !snapshot.runtimeEpoch ||
      !capabilities.detachedRuns ||
      !capabilities.replayableEvents
    ) {
      return null
    }
    const session = await invoke<RuntimeSession>('runtime_session_restore', {
      sessionId: options.chatId,
    })
    const run = session.latestRun
    if (!run) {
      return null
    }

    const runtimeEpoch = snapshot.runtimeEpoch
    const runtimeId = snapshot.runtimeId
    const runId = run.id
    const chatId = options.chatId
    if (run.status === 'failed') {
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({
            type: 'start',
            messageId: runId,
            messageMetadata: { runtime: runtimeId, runtimeEpoch },
          })
          controller.enqueue({
            type: 'error',
            errorText: runSnapshotError(run.error),
          })
          controller.close()
        },
      })
    }
    if (run.status === 'completed' || run.status === 'cancelled') {
      return null
    }
    let reconnectUnlisten: UnlistenFn | undefined
    let streamCancelled = false
    let detachStream: (() => void) | undefined
    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        let unlisten: UnlistenFn | undefined
        let closed = streamCancelled
        let expectedSequence = 0
        const seenEventIds = new Set<string>()
        const tools = new Map<string, RuntimeToolData>()
        const permissions = new Map<string, RuntimePermissionData>()
        let openTextId: string | undefined
        let openTextBase: string | undefined
        let openReasoningId: string | undefined
        let openReasoningBase: string | undefined
        let segment = 0

        const closeParts = () => {
          if (openReasoningId) {
            controller.enqueue({ type: 'reasoning-end', id: openReasoningId })
            openReasoningId = undefined
            openReasoningBase = undefined
          }
          if (openTextId) {
            controller.enqueue({ type: 'text-end', id: openTextId })
            openTextId = undefined
            openTextBase = undefined
          }
        }
        const stopListening = () => {
          const listener = unlisten
          unlisten = undefined
          if (reconnectUnlisten === listener) reconnectUnlisten = undefined
          listener?.()
          if (this.detachActiveStream === detachStream) {
            this.detachActiveStream = undefined
          }
        }
        const finish = (chunk: UIMessageChunk) => {
          if (closed) return
          closed = true
          if (streamCancelled) {
            stopListening()
            return
          }
          closeParts()
          controller.enqueue(chunk)
          controller.close()
          stopListening()
        }
        detachStream = () =>
          finish({ type: 'abort', reason: '客户端已分离' })
        this.detach()
        this.detachActiveStream = detachStream
        const fail = (error: unknown) =>
          finish({
            type: 'error',
            errorText:
              error instanceof Error
                ? error.message
                : formatRuntimeCommandError(error),
          })
        const emitTool = (data: RuntimeToolData) => {
          tools.set(data.toolCallId, data)
          controller.enqueue({
            type: runtimeDataPartType.tool,
            id: data.toolCallId,
            data,
          })
        }
        const emitPermission = (data: RuntimePermissionData) => {
          permissions.set(data.requestId, data)
          controller.enqueue({
            type: runtimeDataPartType.permission,
            id: data.requestId,
            data,
          })
        }
        const receive = (envelope: RuntimeEventEnvelope) => {
          if (
            closed ||
            envelope.sessionId !== chatId ||
            envelope.runId !== runId ||
            envelope.runtimeId !== runtimeId ||
            envelope.runtimeEpoch !== runtimeEpoch ||
            seenEventIds.has(envelope.eventId)
          ) {
            return
          }
          if (envelope.sequence < expectedSequence) return
          if (envelope.sequence > expectedSequence) {
            fail(
              new Error(
                `sequence gap: expected ${expectedSequence}, received ${envelope.sequence}`
              )
            )
            return
          }
          expectedSequence += 1
          seenEventIds.add(envelope.eventId)

          const event = envelope.event
          switch (event.type) {
            case 'run_started':
            case 'runtime_status_changed':
              return
            case 'connection_status_changed':
              controller.enqueue({
                type: runtimeDataPartType.diagnostic,
                id: envelope.eventId,
                data: {
                  level:
                    event.status === 'connected' ? 'info' : 'warning',
                  message: event.message ?? `Runtime ${event.status}`,
                },
              })
              return
            case 'text_delta':
              if (openTextBase !== event.messageId) {
                closeParts()
                openTextBase = event.messageId
                openTextId = `${event.messageId}:t${++segment}`
                controller.enqueue({ type: 'text-start', id: openTextId })
              }
              controller.enqueue({
                type: 'text-delta',
                id: openTextId!,
                delta: event.delta,
              })
              return
            case 'reasoning_delta':
              if (openReasoningBase !== event.messageId) {
                closeParts()
                openReasoningBase = event.messageId
                openReasoningId = `${event.messageId}:r${++segment}`
                controller.enqueue({
                  type: 'reasoning-start',
                  id: openReasoningId,
                })
              }
              controller.enqueue({
                type: 'reasoning-delta',
                id: openReasoningId!,
                delta: event.delta,
              })
              return
            case 'tool_started':
              closeParts()
              emitTool({
                toolCallId: event.toolCallId,
                name: event.name,
                status: 'running',
                ...(event.input === undefined ? {} : { input: event.input }),
              })
              return
            case 'tool_updated': {
              const current = tools.get(event.toolCallId)
              if (!current) return fail(new Error('tool update without start'))
              emitTool({
                ...current,
                update: mergeUpdate(current.update, event.update),
              })
              return
            }
            case 'tool_completed': {
              const current = tools.get(event.toolCallId)
              if (!current) return fail(new Error('tool completion without start'))
              emitTool({
                ...current,
                status: event.error ? 'failed' : 'completed',
                ...(event.result === undefined ? {} : { result: event.result }),
                ...(event.error === undefined ? {} : { error: event.error }),
              })
              return
            }
            case 'permission_requested':
              emitPermission({
                ...event.request,
                runtimeId: envelope.runtimeId,
                runtimeEpoch: envelope.runtimeEpoch,
                sessionId: envelope.sessionId,
                runId,
                createdAt: envelope.timestamp,
                status: 'pending',
              })
              return
            case 'permission_resolved': {
              const current = permissions.get(event.requestId)
              if (!current) return fail(new Error('permission resolution without request'))
              emitPermission({
                ...current,
                status: 'resolved',
                decision: event.decision,
              })
              return
            }
            case 'diagnostic_notice':
              controller.enqueue({
                type: runtimeDataPartType.diagnostic,
                id: envelope.eventId,
                data: { level: event.level, message: event.message },
              })
              return
            case 'run_completed':
              finish({ type: 'finish', finishReason: 'stop' })
              return
            case 'run_cancelled':
              finish({ type: 'abort', reason: event.reason ?? '已取消' })
              return
            case 'run_failed':
              finish({
                type: 'error',
                errorText: `${event.error.code}: ${event.error.message}`,
              })
          }
        }

        try {
          unlisten = await listen(RUNTIME_EVENT_NAME, ({ payload }) => {
            try {
              receive(parseRuntimeEventEnvelope(payload))
            } catch (error) {
              fail(error)
            }
          })
          reconnectUnlisten = unlisten
          if (streamCancelled) {
            stopListening()
            return
          }
          controller.enqueue({
            type: 'start',
            messageId: runId,
            messageMetadata: { runtime: runtimeId, runtimeEpoch },
          })
          const attached = await invoke<RuntimeSession>(
            'runtime_session_attach',
            { sessionId: chatId }
          )
          const attachedRun = attached.latestRun
          if (!attachedRun || attachedRun.id !== runId) {
            fail(new Error('attached Runtime Run changed during reconnect'))
          } else if (attachedRun.status === 'completed') {
            finish({ type: 'finish', finishReason: 'stop' })
          } else if (attachedRun.status === 'cancelled') {
            finish({ type: 'abort', reason: '已取消' })
          } else if (attachedRun.status === 'failed') {
            finish({
              type: 'error',
              errorText: runSnapshotError(attachedRun.error),
            })
          }
        } catch (error) {
          fail(error)
        }
      },
      cancel: () => {
        // Stream cancellation is a frontend detach, never a Runtime cancel.
        streamCancelled = true
        const listener = reconnectUnlisten
        reconnectUnlisten = undefined
        listener?.()
        if (this.detachActiveStream === detachStream) {
          this.detachActiveStream = undefined
        }
      },
    })
  }

  updateSystemMessage(systemMessage?: string) {
    void systemMessage
  }

  setOnTokenUsage(
    callback?: (usage: LanguageModelUsage, messageId: string) => void
  ) {
    void callback
  }

  refreshTools() {}

  setContinueFromContent(content: unknown) {
    void content
  }

  async updateRagToolsAvailability(
    hasDocuments: boolean,
    modelSupportsTools: boolean,
    ragFeatureAvailable: boolean
  ) {
    void hasDocuments
    void modelSupportsTools
    void ragFeatureAvailable
  }
}
