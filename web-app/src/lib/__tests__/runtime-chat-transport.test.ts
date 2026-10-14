import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'
import { useRuntimeStore } from '@/stores/runtime-store'

const h = vi.hoisted(() => ({
  handler: undefined as
    | ((event: { payload: unknown }) => void)
    | undefined,
  invoke: vi.fn(),
  unlisten: vi.fn(),
  order: [] as string[],
  runStart: undefined as (() => void) | undefined,
  listenGate: undefined as Promise<void> | undefined,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    h.order.push('listen')
    await h.listenGate
    h.handler = handler
    return h.unlisten
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

import {
  RuntimeChatTransport,
  shouldCancelRuntimeOnStreamClose,
} from '@/lib/runtime-chat-transport'

const options = (abortSignal?: AbortSignal) => ({
  trigger: 'submit-message' as const,
  chatId: 'session-1',
  messageId: undefined,
  messages: [
    {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: '搜索 AI' }],
    },
  ] as UIMessage[],
  abortSignal,
})

const envelope = (
  type: string,
  sequence: number,
  extra: Record<string, unknown> = {},
  eventId = `event-${sequence}-${type}`
) => ({
  schemaVersion: '1.0',
  eventId,
  runtimeId: 'hermes',
  runtimeEpoch: 'epoch-1',
  sessionId: 'session-1',
  runId: 'run-1',
  sequence,
  timestamp: '2026-08-05T00:00:00.000Z',
  event: { type, ...extra },
})

const permissionRequest = () => ({
  requestId: 'permission-1',
  toolCallId: 'tool-1',
  title: '允许搜索',
  description: 'Hermes 请求执行搜索',
  toolName: 'web_search',
  inputSummary: { query: 'AI' },
  canAllowOnce: true,
  canDeny: true,
  expiresAt: '2026-08-05T00:01:00.000Z',
})

async function drain(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  while (true) {
    const result = await reader.read()
    if (result.done) return chunks
    chunks.push(result.value)
  }
}

function setupInvoke(events: unknown[]) {
  h.invoke.mockImplementation(async (command: string) => {
    h.order.push(command)
    if (command === 'runtime_start') {
      return {
        runtimeId: 'hermes',
        status: 'ready',
        runtimeEpoch: 'epoch-1',
        sequence: 2,
      }
    }
    if (command === 'runtime_session_create') {
      return {
        sessionId: 'session-1',
        runtimeSessionId: 'driver-session-1',
        runtimeEpoch: 'epoch-1',
        reused: false,
      }
    }
    if (command === 'runtime_run_start') {
      queueMicrotask(() => {
        for (const event of events) h.handler?.({ payload: event })
      })
      return { runId: 'run-1' }
    }
    return { accepted: true, duplicate: false }
  })
}

describe('RuntimeChatTransport', () => {
  beforeEach(() => {
    useRuntimeStore.setState({
      runtimeId: 'hermes',
      capabilities: {
        durableSessions: false,
        detachedRuns: false,
        replayableEvents: false,
        runtimeOwnedApprovals: false,
      },
    })
  })

  it('treats Bianbu stream close as detach, not cancel', () => {
    expect(shouldCancelRuntimeOnStreamClose(true)).toBe(false)
    expect(shouldCancelRuntimeOnStreamClose(false)).toBe(true)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    h.handler = undefined
    h.order = []
    h.runStart = undefined
    h.listenGate = undefined
  })

  it('maps text reasoning tools permission and completion into one stream', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('reasoning_delta', 1, { messageId: 'thought-1', delta: '分析' }),
      envelope('tool_started', 2, {
        toolCallId: 'tool-1',
        name: 'web_search',
        input: { query: 'AI' },
      }),
      envelope('permission_requested', 3, { request: permissionRequest() }),
      envelope('permission_resolved', 4, {
        requestId: 'permission-1',
        decision: 'allow_once',
      }),
      envelope('tool_completed', 5, {
        toolCallId: 'tool-1',
        result: { count: 3 },
      }),
      envelope('text_delta', 6, { messageId: 'answer-1', delta: '完成' }),
      envelope('run_completed', 7, { stopReason: 'end_turn' }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks).toContainEqual({
      type: 'reasoning-delta',
      id: 'thought-1',
      delta: '分析',
    })
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'data-runtime-tool', id: 'tool-1' })
    )
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'data-runtime-permission', id: 'permission-1' })
    )
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' })
  })

  it('registers the listener and commands in the fixed order', async () => {
    setupInvoke([envelope('run_started', 0, { userMessageId: 'user-1' })])
    const transport = new RuntimeChatTransport()
    const stream = await transport.sendMessages(options())
    const reader = stream.getReader()
    await reader.read()
    reader.cancel()

    expect(h.order.slice(0, 5)).toEqual([
      'listen',
      'runtime_controller_acquire',
      'runtime_start',
      'runtime_session_create',
      'runtime_run_start',
    ])
  })

  it('ignores duplicate events, old sequences, other sessions and other runs', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('text_delta', 1, { messageId: 'answer-1', delta: '正确' }),
      envelope('text_delta', 1, { messageId: 'answer-1', delta: '重复' }),
      envelope('text_delta', 0, { messageId: 'answer-1', delta: '旧' }),
      { ...envelope('text_delta', 2, { messageId: 'answer-1', delta: '外部' }), sessionId: 'other' },
      { ...envelope('text_delta', 2, { messageId: 'answer-1', delta: '外部 run' }), runId: 'other-run' },
      envelope('run_completed', 2, { stopReason: 'end_turn' }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks).toContainEqual({ type: 'text-delta', id: 'answer-1', delta: '正确' })
    expect(chunks).not.toContainEqual(expect.objectContaining({ delta: '重复' }))
    expect(chunks).not.toContainEqual(expect.objectContaining({ delta: '旧' }))
    expect(chunks).not.toContainEqual(expect.objectContaining({ delta: '外部' }))
    expect(chunks).toContainEqual({ type: 'finish', finishReason: 'stop' })
  })

  it('ignores stale events delivered before the runtime epoch is known', async () => {
    const stale = envelope(
      'run_started',
      0,
      { userMessageId: 'old-user' },
      'stale-before-start'
    )
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(command)
      if (command === 'runtime_start') {
        h.handler?.({ payload: stale })
        return {
          runtimeId: 'hermes',
          status: 'ready',
          runtimeEpoch: 'epoch-1',
          sequence: 2,
        }
      }
      if (command === 'runtime_session_create') {
        return {
          sessionId: 'session-1',
          runtimeSessionId: 'driver-session-1',
          runtimeEpoch: 'epoch-1',
          reused: false,
        }
      }
      if (command === 'runtime_run_start') {
        queueMicrotask(() => {
          h.handler?.({
            payload: envelope('run_started', 0, { userMessageId: 'user-1' }),
          })
          h.handler?.({
            payload: envelope('run_completed', 1, { stopReason: 'end_turn' }),
          })
        })
        return { runId: 'run-1' }
      }
      return { accepted: true, duplicate: false }
    })

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks).toContainEqual({ type: 'start', messageId: 'run-1', messageMetadata: { runtime: 'hermes', runtimeEpoch: 'epoch-1' } })
    expect(chunks).toContainEqual({ type: 'finish', finishReason: 'stop' })
    expect(chunks).not.toContainEqual(expect.objectContaining({ messageId: 'old-user' }))
  })

  it('ignores stale events delivered after startup but before run start', async () => {
    const staleRun = envelope(
      'run_started',
      0,
      { userMessageId: 'old-user' },
      'stale-before-run-start'
    )
    const staleText = envelope(
      'text_delta',
      1,
      { messageId: 'old-answer', delta: '旧事件不应显示' },
      'stale-text-before-run-start'
    )
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(command)
      if (command === 'runtime_start') {
        return {
          runtimeId: 'hermes',
          status: 'ready',
          runtimeEpoch: 'epoch-1',
          sequence: 2,
        }
      }
      if (command === 'runtime_session_create') {
        h.handler?.({ payload: staleRun })
        h.handler?.({ payload: staleText })
        return {
          sessionId: 'session-1',
          runtimeSessionId: 'driver-session-1',
          runtimeEpoch: 'epoch-1',
          reused: false,
        }
      }
      if (command === 'runtime_run_start') {
        queueMicrotask(() => {
          h.handler?.({
            payload: envelope('run_started', 0, { userMessageId: 'user-1' }),
          })
          h.handler?.({
            payload: envelope('text_delta', 1, { messageId: 'answer-1', delta: '新事件' }),
          })
          h.handler?.({
            payload: envelope('run_completed', 2, { stopReason: 'end_turn' }),
          })
        })
        return { runId: 'run-1' }
      }
      return { accepted: true, duplicate: false }
    })

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks).toContainEqual({ type: 'text-delta', id: 'answer-1', delta: '新事件' })
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ id: 'old-answer', delta: '旧事件不应显示' })
    )
    expect(chunks).toContainEqual({ type: 'finish', finishReason: 'stop' })
  })

  it('buffers events until the returned run id filters a startup race', async () => {
    const stale = envelope(
      'run_started',
      0,
      { userMessageId: 'old-user' },
      'stale-during-run-start'
    )
    stale.runId = 'old-run'
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(command)
      if (command === 'runtime_start') {
        return { runtimeId: 'hermes', status: 'ready', runtimeEpoch: 'epoch-1', sequence: 2 }
      }
      if (command === 'runtime_session_create') {
        return {
          sessionId: 'session-1',
          runtimeSessionId: 'driver-session-1',
          runtimeEpoch: 'epoch-1',
          reused: false,
        }
      }
      if (command === 'runtime_run_start') {
        h.handler?.({ payload: stale })
        h.handler?.({
          payload: envelope('run_started', 0, { userMessageId: 'user-1' }),
        })
        h.handler?.({
          payload: envelope('run_completed', 1, { stopReason: 'end_turn' }),
        })
        await Promise.resolve()
        return { runId: 'run-1' }
      }
      return { accepted: true, duplicate: false }
    })

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks).toContainEqual({ type: 'start', messageId: 'run-1', messageMetadata: { runtime: 'hermes', runtimeEpoch: 'epoch-1' } })
    expect(chunks).toContainEqual({ type: 'finish', finishReason: 'stop' })
    expect(chunks).not.toContainEqual(expect.objectContaining({ messageId: 'old-user' }))
  })

  it('reports a sequence gap and cancels exactly once', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('text_delta', 2, { messageId: 'answer-1', delta: '缺口' }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks).toContainEqual(expect.objectContaining({ type: 'error' }))
    expect(
      h.invoke.mock.calls.filter(([command]) => command === 'runtime_run_cancel')
    ).toHaveLength(1)
  })

  it('does not cancel a detached Bianbu run when local event projection fails', async () => {
    useRuntimeStore.setState({
      runtimeId: 'bianbu',
      capabilities: {
        durableSessions: true,
        detachedRuns: true,
        replayableEvents: true,
        runtimeOwnedApprovals: true,
      },
    })
    setupInvoke([])
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(command)
      if (command === 'runtime_start') {
        return {
          runtimeId: 'bianbu',
          status: 'ready',
          runtimeEpoch: 'epoch-1',
          sequence: 2,
        }
      }
      if (command === 'runtime_session_create') {
        return {
          sessionId: 'session-1',
          runtimeSessionId: 'session-1',
          runtimeEpoch: 'epoch-1',
          reused: false,
        }
      }
      if (command === 'runtime_run_start') {
        queueMicrotask(() => {
          h.handler?.({
            payload: {
              ...envelope('run_started', 0, { userMessageId: 'user-1' }),
              runtimeId: 'bianbu',
            },
          })
          h.handler?.({
            payload: {
              ...envelope('text_delta', 2, {
                messageId: 'answer-1',
                delta: '缺口',
              }),
              runtimeId: 'bianbu',
            },
          })
        })
        return { runId: 'run-1' }
      }
      return { accepted: true, duplicate: false }
    })

    const chunks = await drain(
      await new RuntimeChatTransport().sendMessages(options())
    )

    expect(chunks).toContainEqual(expect.objectContaining({ type: 'error' }))
    expect(h.order).not.toContain('runtime_run_cancel')
  })

  it('cancels after abort even when the run id arrives after the abort', async () => {
    const controller = new AbortController()
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(command)
      if (command === 'runtime_start') {
        return { runtimeId: 'hermes', status: 'ready', runtimeEpoch: 'epoch-1', sequence: 2 }
      }
      if (command === 'runtime_session_create') {
        return {
          sessionId: 'session-1',
          runtimeSessionId: 'driver-session-1',
          runtimeEpoch: 'epoch-1',
          reused: false,
        }
      }
      if (command === 'runtime_run_start') {
        controller.abort()
        return new Promise((resolve) => {
          h.runStart = () => {
            queueMicrotask(() => h.handler?.({ payload: envelope('run_started', 0, { userMessageId: 'user-1' }) }))
            resolve({ runId: 'run-1' })
          }
        })
      }
      return { accepted: true, duplicate: false }
    })

    const streamPromise = new RuntimeChatTransport().sendMessages(options(controller.signal))
    await vi.waitFor(() => expect(h.runStart).toBeTypeOf('function'))
    h.runStart?.()
    const reader = (await streamPromise).getReader()
    await reader.cancel()

    expect(
      h.invoke.mock.calls.filter(([command]) => command === 'runtime_run_cancel')
    ).toHaveLength(1)
  })

  it('closes the stream and unlistens on malformed protocol data', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      { ...envelope('text_delta', 1, { messageId: 'answer-1', delta: 'x' }), event: { type: 'unknown' } },
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks).toContainEqual(expect.objectContaining({ type: 'error' }))
    expect(h.unlisten).toHaveBeenCalledOnce()
  })

  it('does not emit a second terminal after cancellation', async () => {
    const controller = new AbortController()
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('run_cancelled', 1, { reason: 'user' }),
      envelope('run_completed', 2, { stopReason: 'end_turn' }),
    ])

    const stream = await new RuntimeChatTransport().sendMessages(options(controller.signal))
    controller.abort()
    const chunks = await drain(stream)

    expect(chunks.filter((chunk) => chunk.type === 'abort')).toHaveLength(1)
    expect(chunks.filter((chunk) => chunk.type === 'finish')).toHaveLength(0)
  })

  it('merges tool updates into one cumulative data part', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('tool_started', 1, {
        toolCallId: 'tool-1',
        name: 'web_search',
        input: { query: 'AI' },
      }),
      envelope('tool_updated', 2, {
        toolCallId: 'tool-1',
        update: { progress: 1 },
      }),
      envelope('tool_updated', 3, {
        toolCallId: 'tool-1',
        update: { source: 'example.com' },
      }),
      envelope('tool_completed', 4, {
        toolCallId: 'tool-1',
        result: { count: 3 },
      }),
      envelope('run_completed', 5, { stopReason: 'end_turn' }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))
    const toolChunks = chunks.filter(
      (chunk) => chunk.type === 'data-runtime-tool'
    )

    expect(toolChunks).toHaveLength(4)
    expect(toolChunks.at(-1)).toEqual({
      type: 'data-runtime-tool',
      id: 'tool-1',
      data: {
        toolCallId: 'tool-1',
        name: 'web_search',
        status: 'completed',
        input: { query: 'AI' },
        update: { progress: 1, source: 'example.com' },
        result: { count: 3 },
      },
    })
  })

  it('ends an open text or reasoning part before starting the next id', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('reasoning_delta', 1, { messageId: 'thought-1', delta: '一' }),
      envelope('reasoning_delta', 2, { messageId: 'thought-2', delta: '二' }),
      envelope('text_delta', 3, { messageId: 'answer-1', delta: '甲' }),
      envelope('text_delta', 4, { messageId: 'answer-2', delta: '乙' }),
      envelope('run_completed', 5, { stopReason: 'end_turn' }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: 'reasoning-end', id: 'thought-1' },
        { type: 'reasoning-start', id: 'thought-2' },
        { type: 'text-end', id: 'answer-1' },
        { type: 'text-start', id: 'answer-2' },
      ])
    )
    expect(
      chunks.findIndex(
        (chunk) => chunk.type === 'reasoning-end' && chunk.id === 'thought-1'
      )
    ).toBeLessThan(
      chunks.findIndex(
        (chunk) => chunk.type === 'reasoning-start' && chunk.id === 'thought-2'
      )
    )
    expect(
      chunks.findIndex(
        (chunk) => chunk.type === 'text-end' && chunk.id === 'answer-1'
      )
    ).toBeLessThan(
      chunks.findIndex(
        (chunk) => chunk.type === 'text-start' && chunk.id === 'answer-2'
      )
    )
  })

  it('sends one cancel when abort and stream cancellation race', async () => {
    const abortController = new AbortController()
    setupInvoke([envelope('run_started', 0, { userMessageId: 'user-1' })])
    const reader = (
      await new RuntimeChatTransport().sendMessages(options(abortController.signal))
    ).getReader()
    await reader.read()

    abortController.abort()
    await reader.cancel()
    await vi.waitFor(() => {
      expect(
        h.invoke.mock.calls.filter(([command]) => command === 'runtime_run_cancel')
      ).toHaveLength(1)
    })
    expect(h.unlisten).toHaveBeenCalledOnce()
  })

  it('reports a failed runtime cancellation without an unhandled rejection', async () => {
    const abortController = new AbortController()
    setupInvoke([envelope('run_started', 0, { userMessageId: 'user-1' })])
    const invoke = h.invoke.getMockImplementation()
    h.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === 'runtime_run_cancel') {
        return Promise.reject({
          code: 'cancel_timeout',
          message: 'Hermes did not stop',
          recoverable: true,
        })
      }
      return invoke?.(command, ...args)
    })
    const stream = await new RuntimeChatTransport().sendMessages(
      options(abortController.signal)
    )
    const reader = stream.getReader()
    await reader.read()

    abortController.abort()
    const remaining: UIMessageChunk[] = []
    while (true) {
      const result = await reader.read()
      if (result.done) break
      remaining.push(result.value)
    }

    expect(remaining).toContainEqual({
      type: 'error',
      errorText: 'runtime_run_cancel failed: cancel_timeout: Hermes did not stop',
    })
    expect(h.unlisten).toHaveBeenCalledOnce()
  })

  it('does not start the runtime after abort before startup completes', async () => {
    const controller = new AbortController()
    controller.abort()
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(command)
      return { accepted: true, duplicate: false }
    })

    const stream = await new RuntimeChatTransport().sendMessages(
      options(controller.signal)
    )
    const chunks = await drain(stream)

    expect(chunks).toContainEqual({ type: 'abort', reason: '已取消' })
    expect(h.invoke.mock.calls.map(([command]) => command)).not.toContain(
      'runtime_session_create'
    )
    expect(h.invoke.mock.calls.map(([command]) => command)).not.toContain(
      'runtime_run_start'
    )
  })

  it('shows stable runtime error codes and messages', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('run_failed', 1, {
        error: {
          code: 'process_exited',
          message: 'Hermes exited',
          recoverable: true,
        },
      }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks.at(-1)).toEqual({
      type: 'error',
      errorText: 'process_exited: Hermes exited',
    })
  })

  it('formats a structured Tauri command error without losing its code', async () => {
    h.invoke.mockRejectedValueOnce({
      code: 'hermes_not_found',
      message: 'Hermes is not installed',
      recoverable: true,
    })

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks).toEqual([
      {
        type: 'error',
        errorText: 'hermes_not_found: Hermes is not installed',
      },
    ])
    expect(h.unlisten).toHaveBeenCalledOnce()
  })

  it('fails immediately when the first run event skips run_started', async () => {
    setupInvoke([
      envelope('text_delta', 1, { messageId: 'answer-1', delta: '缺少开始事件' }),
    ])

    const reader = (
      await new RuntimeChatTransport().sendMessages(options())
    ).getReader()
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('stream remained open')), 100)
      ),
    ])

    expect(first.value).toEqual(expect.objectContaining({ type: 'error' }))
    expect(
      h.invoke.mock.calls.filter(([command]) => command === 'runtime_run_cancel')
    ).toHaveLength(1)
  })

  it('unlistens without starting Runtime when cancelled before listen resolves', async () => {
    let releaseListen: (() => void) | undefined
    h.listenGate = new Promise<void>((resolve) => {
      releaseListen = resolve
    })
    setupInvoke([])
    const reader = (await new RuntimeChatTransport().sendMessages(options())).getReader()

    await reader.cancel()
    releaseListen?.()

    await vi.waitFor(() => expect(h.unlisten).toHaveBeenCalledOnce())
    expect(h.order).not.toContain('runtime_controller_acquire')
    expect(h.order).not.toContain('runtime_run_cancel')
  })

  it('detaches before a delayed listener can reacquire the controller', async () => {
    let releaseListen: (() => void) | undefined
    h.listenGate = new Promise<void>((resolve) => {
      releaseListen = resolve
    })
    setupInvoke([])
    const transport = new RuntimeChatTransport()
    const stream = await transport.sendMessages(options())
    const drained = drain(stream)

    transport.detach()
    releaseListen?.()

    expect(await drained).toContainEqual({
      type: 'abort',
      reason: '客户端已分离',
    })
    await vi.waitFor(() => expect(h.unlisten).toHaveBeenCalledOnce())
    expect(h.order).not.toContain('runtime_controller_acquire')
    expect(h.order).not.toContain('runtime_run_cancel')
  })

  // Hermes + MiniMax puts only a decorative status line in the thought channel
  // and streams the real reasoning inline in the message channel, wrapped in
  // literal <think> tags. Those must reach the UI as reasoning, not as answer
  // text, or the tags render verbatim until the message is persisted.
  it('routes inline think tags in the text channel to reasoning', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('reasoning_delta', 1, { messageId: 'thought-1', delta: '正在思考' }),
      envelope('text_delta', 2, { messageId: 'answer-1', delta: '<think>用户在问' }),
      envelope('text_delta', 3, { messageId: 'answer-1', delta: '天气</think>今天' }),
      envelope('text_delta', 4, { messageId: 'answer-1', delta: '晴天' }),
      envelope('run_completed', 5, { stopReason: 'end_turn' }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    const textOf = (id: string) =>
      chunks
        .filter((c) => c.type === 'text-delta' && c.id === id)
        .map((c) => (c as { delta: string }).delta)
        .join('')
    const reasoningOf = (id: string) =>
      chunks
        .filter((c) => c.type === 'reasoning-delta' && c.id === id)
        .map((c) => (c as { delta: string }).delta)
        .join('')

    // Inline reasoning lands on its own id, kept apart from the agent's own
    // thought channel so the status line is not glued onto the real reasoning.
    expect(reasoningOf('answer-1:think')).toBe('用户在问天气')
    expect(reasoningOf('thought-1')).toBe('正在思考')
    // The answer keeps no tag residue.
    expect(textOf('answer-1')).toBe('今天晴天')
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' })
  })

  // Regression for the "thinking card blinks in and out during the answer" bug.
  // The agent sends every phase of a turn under one message id, so a
  // thought → body → thought → body turn reuses that id four times. AI SDK part
  // ids must be unique per part: `reasoning-end` deletes the id from its active
  // map and a later delta on a deleted id throws UIMessageStreamError, tearing
  // down the stream (and the card) mid-answer. Each repeat phase must therefore
  // get its own part id.
  it('gives each phase its own part id when one message id repeats', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('reasoning_delta', 1, { messageId: 'M1', delta: '思考A' }),
      envelope('text_delta', 2, { messageId: 'M1', delta: '正文A' }),
      envelope('reasoning_delta', 3, { messageId: 'M1', delta: '思考B' }),
      envelope('text_delta', 4, { messageId: 'M1', delta: '正文B' }),
      envelope('run_completed', 5, { stopReason: 'end_turn' }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    // Replay the stream through the AI SDK's part state machine. A delta or an
    // `-end` for an id that is not open is exactly what makes the SDK throw.
    const activeReasoning = new Map<string, { type: string; text: string }>()
    const activeText = new Map<string, { type: string; text: string }>()
    const parts: { type: string; text: string }[] = []
    for (const chunk of chunks as (UIMessageChunk & { id?: string; delta?: string })[]) {
      const id = chunk.id as string
      switch (chunk.type) {
        case 'reasoning-start': {
          const part = { type: 'reasoning', text: '' }
          activeReasoning.set(id, part)
          parts.push(part)
          break
        }
        case 'text-start': {
          const part = { type: 'text', text: '' }
          activeText.set(id, part)
          parts.push(part)
          break
        }
        case 'reasoning-delta':
          expect(activeReasoning.has(id), `reasoning-delta for closed part ${id}`).toBe(true)
          activeReasoning.get(id)!.text += chunk.delta
          break
        case 'text-delta':
          expect(activeText.has(id), `text-delta for closed part ${id}`).toBe(true)
          activeText.get(id)!.text += chunk.delta
          break
        case 'reasoning-end':
          expect(activeReasoning.has(id), `reasoning-end for closed part ${id}`).toBe(true)
          activeReasoning.delete(id)
          break
        case 'text-end':
          expect(activeText.has(id), `text-end for closed part ${id}`).toBe(true)
          activeText.delete(id)
          break
      }
    }

    // Four parts alternating thought → body → thought → body, each holding only
    // its own segment's text (a shared id would merge body text into the card).
    expect(parts).toEqual([
      { type: 'reasoning', text: '思考A' },
      { type: 'text', text: '正文A' },
      { type: 'reasoning', text: '思考B' },
      { type: 'text', text: '正文B' },
    ])
  })

  // A single-phase turn — by far the common case — must keep the bare message
  // id, so ids stay readable and nothing downstream that keys off them shifts.
  it('keeps the bare message id when a phase occurs only once', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('reasoning_delta', 1, { messageId: 'thought-1', delta: '思考' }),
      envelope('text_delta', 2, { messageId: 'answer-1', delta: '正文' }),
      envelope('run_completed', 3, { stopReason: 'end_turn' }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))
    const ids = new Set(
      (chunks as { id?: string }[]).map((c) => c.id).filter(Boolean)
    )

    expect(ids).toEqual(new Set(['thought-1', 'answer-1']))
  })

  it('closes an unterminated think block when the run ends', async () => {    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('text_delta', 1, { messageId: 'answer-1', delta: '<think>被截断' }),
      envelope('run_completed', 2, { stopReason: 'end_turn' }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    expect(chunks).toContainEqual({
      type: 'reasoning-delta',
      id: 'answer-1:think',
      delta: '被截断',
    })
    expect(chunks).toContainEqual({ type: 'reasoning-end', id: 'answer-1:think' })
  })

  it('coalesces rapid deltas per part and flushes them at stream end', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      // Six deltas arrive inside one coalescing window (the transport coalesces
      // on a 250ms cadence). The first delta per stream emits immediately (lead
      // edge) so the reply starts on-screen the moment the model talks; the
      // rest coalesce and flush at stream end.
      envelope('reasoning_delta', 1, { messageId: 'thought-1', delta: 'a' }),
      envelope('reasoning_delta', 2, { messageId: 'thought-1', delta: 'b' }),
      envelope('text_delta', 3, { messageId: 'answer-1', delta: '1' }),
      envelope('text_delta', 4, { messageId: 'answer-1', delta: '2' }),
      envelope('text_delta', 5, { messageId: 'answer-1', delta: '3' }),
      envelope('run_completed', 6, { stopReason: 'end_turn' }),
    ])

    const chunks = await drain(await new RuntimeChatTransport().sendMessages(options()))

    const textDeltas = chunks.filter(
      (c) => c.type === 'text-delta' && c.id === 'answer-1'
    )
    const reasoningDeltas = chunks.filter(
      (c) => c.type === 'reasoning-delta' && c.id === 'thought-1'
    )
    // Content arrives in arrival order and the tail is never dropped: the
    // reasoning part split into its lead-edge 'a' plus the window-flushed 'b'.
    // The phase-boundary close flushes the reasoning part the moment the text
    // part opens, which starts a fresh coalescing window — so the text's first
    // delta '1' emits as the lead edge of that new window and '2','3' coalesce
    // into the stream-end flush. Total text content is still '123'.
    expect(textDeltas).toHaveLength(2)
    expect(
      textDeltas.map((c) => (c as { delta: string }).delta).join('')
    ).toBe('123')
    expect(
      reasoningDeltas
        .map((c) => (c as { delta: string }).delta)
        .join('')
    ).toBe('ab')
    expect(reasoningDeltas[0]).toEqual({
      type: 'reasoning-delta',
      id: 'thought-1',
      delta: 'a',
    })
  })

  it('flushes accumulated deltas when the coalescing window elapses', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('text_delta', 1, { messageId: 'answer-1', delta: 'x' }),
      envelope('text_delta', 2, { messageId: 'answer-1', delta: 'y' }),
    ])

    const stream = await new RuntimeChatTransport().sendMessages(options())
    const reader = stream.getReader()

    // Drive the run events to completion, then let the 250ms window elapse.
    await vi.waitFor(() => {
      expect(h.handler).toBeTruthy()
    })
    // The stream stays open (no run_completed), so the lead-edge delta emits
    // immediately ('x') and the accumulated tail flushes on the timer ('y').
    await new Promise((resolve) => setTimeout(resolve, 300))
    const emitted: UIMessageChunk[] = []
    while (true) {
      const result = await reader.read()
      if (result.done) break
      emitted.push(result.value)
      // Stop once both segments of the text part have been seen.
      const deltas = emitted
        .filter((c) => c.type === 'text-delta' && c.id === 'answer-1')
        .map((c) => (c as { delta: string }).delta)
      if (deltas.join('') === 'xy') break
    }

    expect(emitted).toContainEqual({
      type: 'text-delta',
      id: 'answer-1',
      delta: 'x',
    })
    expect(emitted).toContainEqual({
      type: 'text-delta',
      id: 'answer-1',
      delta: 'y',
    })
    await reader.cancel()
  })

  it('keeps every reasoning delta ahead of its part end when the id switches mid-window', async () => {
    // The agent interleaves its thought channel (reasoning_delta, id
    // 'thought-1') with inline `<think>` blocks (id 'answer-1:think'). The
    // switch must flush the coalescer before emitting reasoning-end, so a delta
    // buffered in the 250ms window never lands after its part's -end marker —
    // the AI SDK rejects that as "reasoning-delta for missing reasoning part"
    // and corrupts the stream, which read as the thinking card flickering.
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('reasoning_delta', 1, { messageId: 'thought-1', delta: 'a' }),
      envelope('reasoning_delta', 2, { messageId: 'thought-1', delta: 'b' }),
      envelope('text_delta', 3, {
        messageId: 'answer-1',
        delta: '<think>内联</think>回答',
      }),
      envelope('run_completed', 4, { stopReason: 'end_turn' }),
    ])

    const chunks = await drain(
      await new RuntimeChatTransport().sendMessages(options())
    )

    const endIdx = chunks.findIndex(
      (c) => c.type === 'reasoning-end' && c.id === 'thought-1'
    )
    expect(endIdx).toBeGreaterThan(-1)

    // Every reasoning-delta for 'thought-1' (lead-edge 'a' and buffered 'b')
    // must precede its -end marker.
    for (const [i, c] of chunks.entries()) {
      if (c.type === 'reasoning-delta' && c.id === 'thought-1') {
        expect(i).toBeLessThan(endIdx)
      }
    }

    // The buffered 'b' was flushed, not dropped.
    expect(
      chunks
        .filter((c) => c.type === 'reasoning-delta' && c.id === 'thought-1')
        .map((c) => (c as { delta: string }).delta)
        .join('')
    ).toBe('ab')
  })

  it('replays an attached Bianbu run without starting or cancelling a second run', async () => {
    const replay = [
      {
        ...envelope('reasoning_delta', 0, {
          messageId: 'assistant',
          delta: '继续分析',
        }),
        runtimeId: 'bianbu',
      },
      {
        ...envelope('text_delta', 1, {
          messageId: 'assistant',
          delta: '已恢复',
        }),
        runtimeId: 'bianbu',
      },
      {
        ...envelope('run_completed', 2, { stopReason: 'end_turn' }),
        runtimeId: 'bianbu',
      },
    ]
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(command)
      if (command === 'runtime_start') {
        return {
          runtimeId: 'bianbu',
          status: 'ready',
          runtimeEpoch: 'epoch-1',
          sequence: 2,
        }
      }
      if (command === 'runtime_capabilities') {
        return {
          durableSessions: true,
          detachedRuns: true,
          replayableEvents: true,
          runtimeOwnedApprovals: true,
        }
      }
      if (command === 'runtime_session_restore') {
        return {
          id: 'session-1',
          title: '恢复会话',
          agentId: 'default',
          metadata: {},
          createdAt: 1,
          updatedAt: 2,
          latestRun: {
            id: 'run-1',
            sessionId: 'session-1',
            agentId: 'default',
            status: 'running',
            content: '',
            pendingActions: [],
            eventCursor: 2,
            createdAt: 1,
            updatedAt: 2,
          },
        }
      }
      if (command === 'runtime_session_attach') {
        queueMicrotask(() => {
          for (const event of replay) h.handler?.({ payload: event })
        })
      }
      return { accepted: true, duplicate: false }
    })

    const stream = await new RuntimeChatTransport().reconnectToStream({
      chatId: 'session-1',
    })
    expect(stream).not.toBeNull()
    const chunks = await drain(stream!)

    expect(chunks).toContainEqual({
      type: 'reasoning-delta',
      id: 'assistant:r1',
      delta: '继续分析',
    })
    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'assistant:t2',
      delta: '已恢复',
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' })
    expect(h.order).toContain('runtime_session_attach')
    expect(h.order).not.toContain('runtime_run_start')
    expect(h.order).not.toContain('runtime_run_cancel')
    // 重连既有会话的流是读操作，不得申请工作台控制权。
    expect(h.order).not.toContain('runtime_controller_acquire')
  })

  it('surfaces a failed persisted run when reconnecting', async () => {
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(command)
      if (command === 'runtime_start') {
        return {
          runtimeId: 'bianbu',
          status: 'ready',
          runtimeEpoch: 'epoch-1',
          sequence: 2,
        }
      }
      if (command === 'runtime_capabilities') {
        return {
          durableSessions: true,
          detachedRuns: true,
          replayableEvents: true,
          runtimeOwnedApprovals: true,
        }
      }
      if (command === 'runtime_session_restore') {
        return {
          id: 'session-1',
          title: '中断会话',
          agentId: 'default',
          metadata: {},
          createdAt: 1,
          updatedAt: 2,
          latestRun: {
            id: 'run-1',
            sessionId: 'session-1',
            agentId: 'default',
            status: 'failed',
            content: '',
            error: {
              code: 'run_interrupted',
              message: 'runtime restarted',
            },
            pendingActions: [],
            eventCursor: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        }
      }
      return { accepted: true, duplicate: false }
    })

    const stream = await new RuntimeChatTransport().reconnectToStream({
      chatId: 'session-1',
    })
    const chunks = await drain(stream!)

    expect(chunks).toEqual([
      {
        type: 'start',
        messageId: 'run-1',
        messageMetadata: { runtime: 'bianbu', runtimeEpoch: 'epoch-1' },
      },
      { type: 'error', errorText: 'run_interrupted: runtime restarted' },
    ])
  })

  it('closes reconnect when the run becomes terminal during attach', async () => {
    let restores = 0
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(command)
      if (command === 'runtime_start') {
        return {
          runtimeId: 'bianbu',
          status: 'ready',
          runtimeEpoch: 'epoch-1',
          sequence: 2,
        }
      }
      if (command === 'runtime_capabilities') {
        return {
          durableSessions: true,
          detachedRuns: true,
          replayableEvents: true,
          runtimeOwnedApprovals: true,
        }
      }
      if (command === 'runtime_session_restore') {
        restores += 1
        return {
          id: 'session-1',
          title: '恢复会话',
          agentId: 'default',
          metadata: {},
          createdAt: 1,
          updatedAt: 2,
          latestRun: {
            id: 'run-1',
            sessionId: 'session-1',
            agentId: 'default',
            status: 'running',
            content: '',
            pendingActions: [],
            eventCursor: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        }
      }
      if (command === 'runtime_session_attach') {
        return {
          id: 'session-1',
          title: '恢复会话',
          agentId: 'default',
          metadata: {},
          createdAt: 1,
          updatedAt: 3,
          latestRun: {
            id: 'run-1',
            sessionId: 'session-1',
            agentId: 'default',
            status: 'completed',
            content: '完成',
            pendingActions: [],
            eventCursor: 2,
            createdAt: 1,
            updatedAt: 3,
          },
        }
      }
      return { accepted: true, duplicate: false }
    })

    const stream = await new RuntimeChatTransport().reconnectToStream({
      chatId: 'session-1',
    })
    const chunks = await Promise.race([
      drain(stream!),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('reconnect stream stayed open')), 200)
      ),
    ])

    expect(restores).toBe(1)
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' })
    expect(h.unlisten).toHaveBeenCalledOnce()
  })

  it('restores one pending approval when reconnecting an attached Bianbu run', async () => {
    const requested = {
      ...envelope('permission_requested', 1, {
        request: permissionRequest(),
      }),
      runtimeId: 'bianbu',
    }
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(command)
      if (command === 'runtime_start') {
        return {
          runtimeId: 'bianbu',
          status: 'ready',
          runtimeEpoch: 'epoch-1',
          sequence: 2,
        }
      }
      if (command === 'runtime_capabilities') {
        return {
          durableSessions: true,
          detachedRuns: true,
          replayableEvents: true,
          runtimeOwnedApprovals: true,
        }
      }
      if (command === 'runtime_session_restore') {
        return {
          id: 'session-1',
          title: '等待审批',
          agentId: 'default',
          metadata: {},
          createdAt: 1,
          updatedAt: 2,
          latestRun: {
            id: 'run-1',
            sessionId: 'session-1',
            agentId: 'default',
            status: 'waiting',
            content: '',
            pendingActions: [{ type: 'approval_required' }],
            eventCursor: 2,
            createdAt: 1,
            updatedAt: 2,
          },
        }
      }
      if (command === 'runtime_session_attach') {
        queueMicrotask(() => {
          h.handler?.({
            payload: {
              ...envelope('run_started', 0, { userMessageId: 'user-1' }),
              runtimeId: 'bianbu',
            },
          })
          h.handler?.({ payload: requested })
          h.handler?.({ payload: requested })
        })
        return {
          id: 'session-1',
          title: '等待审批',
          agentId: 'default',
          metadata: {},
          createdAt: 1,
          updatedAt: 2,
          latestRun: {
            id: 'run-1',
            sessionId: 'session-1',
            agentId: 'default',
            status: 'waiting',
            content: '',
            pendingActions: [{ type: 'approval_required' }],
            eventCursor: 2,
            createdAt: 1,
            updatedAt: 2,
          },
        }
      }
      return { accepted: true, duplicate: false }
    })

    const stream = await new RuntimeChatTransport().reconnectToStream({
      chatId: 'session-1',
    })
    expect(stream).not.toBeNull()
    const reader = stream!.getReader()
    const chunks = [(await reader.read()).value, (await reader.read()).value]
    await reader.cancel()

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'data-runtime-permission',
        id: 'permission-1',
        data: expect.objectContaining({
          requestId: 'permission-1',
          runId: 'run-1',
          runtimeId: 'bianbu',
          status: 'pending',
        }),
      })
    )
    expect(h.order).toContain('runtime_session_attach')
    expect(h.order).not.toContain('runtime_permission_resolve')
    expect(h.order).not.toContain('runtime_run_cancel')
    expect(h.unlisten).toHaveBeenCalledOnce()
  })
})
