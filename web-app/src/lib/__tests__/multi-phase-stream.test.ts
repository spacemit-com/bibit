import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Chat } from '@ai-sdk/react'

const h = vi.hoisted(() => ({
  handler: undefined as
    | ((event: { payload: unknown }) => void)
    | undefined,
  invoke: vi.fn(),
  unlisten: vi.fn(),
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

import { RuntimeChatTransport } from '@/lib/runtime-chat-transport'

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

function setupInvoke(events: unknown[]) {
  h.invoke.mockImplementation(async (command: string) => {
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

const partsSnapshot = (chat: Chat) => {
  const assistant = chat.messages.find((m) => m.role === 'assistant')
  if (!assistant) return null
  return assistant.parts.map((p: any) => ({
    type: p.type,
    text: p.text ?? '',
    state: p.state ?? undefined,
  }))
}

describe('multi-phase reasoning stream (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.handler = undefined
  })

  it('never drops reasoning text and never leaves streaming mid-turn', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('reasoning_delta', 1, { messageId: 'thought-1', delta: '思考1' }),
      envelope('text_delta', 2, { messageId: 'answer-1', delta: '正文1' }),
      envelope('reasoning_delta', 3, { messageId: 'thought-2', delta: '思考2' }),
      envelope('text_delta', 4, { messageId: 'answer-1', delta: '正文2' }),
      envelope('run_completed', 5, { stopReason: 'end_turn' }),
    ])

    const chat = new Chat({
      id: 'session-1',
      transport: new RuntimeChatTransport(),
    })

    const statusHistory: string[] = []
    const snapshots: ReturnType<typeof partsSnapshot>[] = []

    const unsubStatus = (chat as any)['~registerStatusCallback'](() => {
      statusHistory.push(chat.status)
    })
    const unsubMsg = (chat as any)['~registerMessagesCallback'](() => {
      snapshots.push(partsSnapshot(chat))
    })

    await chat.sendMessage({ text: '测试' })

    unsubStatus()
    unsubMsg()

    // The turn is a single run, so status must be submitted → streaming → ready
    // with NO ready/reset in between (that flicker would collapse the card).
    const middle = statusHistory.slice(1, -1)
    expect(middle).not.toContain('ready')

    // Reasoning text must only ever grow; a drop to empty would mean the
    // reasoning part was removed and re-created (the "text disappears" bug).
    let lastReasoningText = ''
    for (const snap of snapshots) {
      if (!snap) continue
      const reasoning = snap.filter((p) => p.type === 'reasoning')
      const total = reasoning.map((p) => p.text).join('')
      if (total.length < lastReasoningText.length) {
        throw new Error(
          `reasoning text shrank from ${JSON.stringify(lastReasoningText)} to ${JSON.stringify(total)}`
        )
      }
      lastReasoningText = total
    }

    // Final parts must preserve both reasoning segments and both text bodies.
    const final = snapshots.at(-1)
    expect(final).toBeTruthy()
    // The phase-boundary close splits body text too, so the parts alternate
    // reasoning → text → reasoning → text (thought → body → thought → body).
    expect(final!.map((p) => p.type)).toEqual([
      'reasoning',
      'text',
      'reasoning',
      'text',
    ])
    expect(final!.filter((p) => p.type === 'text').map((p) => p.text)).toEqual([
      '正文1',
      '正文2',
    ])
    expect(
      final!.filter((p) => p.type === 'reasoning').map((p) => p.text).join('')
    ).toBe('思考1思考2')
  })

  it('keeps status streaming across a tool call (no ready flicker)', async () => {
    setupInvoke([
      envelope('run_started', 0, { userMessageId: 'user-1' }),
      envelope('reasoning_delta', 1, { messageId: 'thought-1', delta: '分析' }),
      envelope('tool_started', 2, {
        toolCallId: 'tool-1',
        name: 'web_search',
        input: { query: 'AI' },
      }),
      envelope('tool_completed', 3, {
        toolCallId: 'tool-1',
        result: { count: 3 },
      }),
      envelope('reasoning_delta', 4, { messageId: 'thought-2', delta: '继续' }),
      envelope('text_delta', 5, { messageId: 'answer-1', delta: '完成' }),
      envelope('run_completed', 6, { stopReason: 'end_turn' }),
    ])

    const chat = new Chat({
      id: 'session-1',
      transport: new RuntimeChatTransport(),
    })

    const statusHistory: string[] = []
    const unsub = (chat as any)['~registerStatusCallback'](() => {
      statusHistory.push(chat.status)
    })

    await chat.sendMessage({ text: '测试' })
    unsub()

    // One run = one turn: status must be submitted → streaming → ready with no
    // intermediate 'ready' (a tool completing mid-run must not flip it).
    const middle = statusHistory.slice(1, -1)
    expect(middle).not.toContain('ready')

    const assistant = chat.messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeTruthy()
    expect(assistant!.parts.map((part) => part.type)).toEqual([
      'reasoning',
      'data-runtime-tool',
      'reasoning',
      'text',
    ])
    expect(
      assistant!.parts.find((part) => part.type === 'data-runtime-tool')
    ).toMatchObject({
      data: {
        input: { query: 'AI' },
        result: { count: 3 },
        status: 'completed',
      },
    })
    expect(
      assistant!.parts
        .filter((p: any) => p.type === 'reasoning')
        .map((p: any) => p.text)
        .join('')
    ).toBe('分析继续')
  })
})
