import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'

const h = vi.hoisted(() => ({
  handler: undefined as
    | ((event: { payload: unknown }) => void)
    | undefined,
  invoke: vi.fn(),
  unlisten: vi.fn(),
  mode: 'streaming' as 'fixed' | 'streaming',
  windowLabel: 'main',
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    h.handler = handler
    return h.unlisten
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: h.windowLabel }),
}))

vi.mock('@/stores/demo-runtime-store', () => ({
  useDemoRuntimeStore: {
    getState: () => ({ mode: h.mode }),
  },
}))

import { DemoChatTransport } from '@/lib/demo-chat-transport'

const options = (abortSignal?: AbortSignal) => ({
  trigger: 'submit-message' as const,
  chatId: 'session-1',
  messageId: undefined,
  messages: [
    {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: '你好' }],
    },
  ] as UIMessage[],
  abortSignal,
})

const event = (
  type: string,
  sequence: number,
  extra: Record<string, unknown> = {}
) => ({
  type,
  runId: 'run-1',
  sessionId: 'session-1',
  sequence,
  ...extra,
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

describe('DemoChatTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.handler = undefined
    h.mode = 'streaming'
    h.invoke.mockImplementation(async (command: string) => {
      if (
        command === 'start_demo_runtime' ||
        command === 'start_demo_conversation'
      ) {
        queueMicrotask(() => {
          h.handler?.({ payload: event('run_started', 0) })
          h.handler?.({
            payload: event('message_delta', 1, { delta: '已收到' }),
          })
          h.handler?.({
            payload: event('message_delta', 2, { delta: '你的消息' }),
          })
          h.handler?.({
            payload: event('message_completed', 3, {
              content: '已收到你的消息',
            }),
          })
        })
        return 'run-1'
      }
      return true
    })
  })

  it('maps streaming events to one AI SDK text part', async () => {
    const stream = await new DemoChatTransport().sendMessages(options())
    const chunks = await drain(stream)

    expect(chunks).toEqual([
      { type: 'start', messageId: 'run-1' },
      { type: 'text-start', id: 'run-1' },
      { type: 'text-delta', id: 'run-1', delta: '已收到' },
      { type: 'text-delta', id: 'run-1', delta: '你的消息' },
      { type: 'text-end', id: 'run-1' },
      { type: 'finish', finishReason: 'stop' },
    ])
    expect(h.unlisten).toHaveBeenCalledOnce()
    expect(h.invoke).toHaveBeenCalledWith('start_demo_conversation', {
      request: {
        sessionId: 'session-1',
        userMessageId: 'user-1',
        prompt: '你好',
        mode: 'streaming',
      },
      originWindow: 'main',
    })
  })

  it('emits completed content in fixed mode', async () => {
    h.mode = 'fixed'
    h.invoke.mockImplementationOnce(async () => {
      queueMicrotask(() => {
        h.handler?.({ payload: event('run_started', 0) })
        h.handler?.({
          payload: event('message_completed', 1, { content: '固定回复' }),
        })
      })
      return 'run-1'
    })

    const chunks = await drain(
      await new DemoChatTransport().sendMessages(options())
    )

    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'run-1',
      delta: '固定回复',
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' })
  })

  it('ignores events from other sessions and runs', async () => {
    h.invoke.mockImplementationOnce(async () => {
      queueMicrotask(() => {
        h.handler?.({
          payload: { ...event('run_started', 0), sessionId: 'other-session' },
        })
        h.handler?.({ payload: event('run_started', 0) })
        h.handler?.({
          payload: { ...event('message_delta', 1), runId: 'other-run', delta: '错误' },
        })
        h.handler?.({
          payload: event('message_completed', 1, { content: '正确' }),
        })
      })
      return 'run-1'
    })

    const chunks = await drain(
      await new DemoChatTransport().sendMessages(options())
    )

    expect(chunks).not.toContainEqual(expect.objectContaining({ delta: '错误' }))
    expect(chunks).toContainEqual(expect.objectContaining({ delta: '正确' }))
  })

  it('maps runtime failures to an error chunk', async () => {
    h.invoke.mockImplementationOnce(async () => {
      queueMicrotask(() => {
        h.handler?.({ payload: event('run_started', 0) })
        h.handler?.({
          payload: event('run_failed', 1, { message: '启动失败' }),
        })
      })
      return 'run-1'
    })

    const chunks = await drain(
      await new DemoChatTransport().sendMessages(options())
    )

    expect(chunks.at(-1)).toEqual({ type: 'error', errorText: '启动失败' })
  })

  it('cancels the active run once when aborted', async () => {
    const controller = new AbortController()
    h.invoke.mockImplementation(async (command: string) => {
      if (
        command === 'start_demo_runtime' ||
        command === 'start_demo_conversation'
      ) {
        queueMicrotask(() => {
          h.handler?.({ payload: event('run_started', 0) })
          controller.abort()
          h.handler?.({ payload: event('run_cancelled', 1) })
        })
        return 'run-1'
      }
      return true
    })

    const chunks = await drain(
      await new DemoChatTransport().sendMessages(options(controller.signal))
    )

    expect(h.invoke).toHaveBeenCalledWith('cancel_demo_runtime', {
      runId: 'run-1',
    })
    expect(
      h.invoke.mock.calls.filter(([command]) => command === 'cancel_demo_runtime')
    ).toHaveLength(1)
    expect(chunks.at(-1)).toEqual({ type: 'abort', reason: '已取消' })
  })
})
