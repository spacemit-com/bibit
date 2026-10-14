import { describe, expect, it } from 'vitest'
import type { ThreadMessage } from '@janhq/core'
import {
  applyRuntimeEnvelope,
  applyRuntimeEvents,
  isConversationEvent,
  reconcileSnapshot,
  upsertMessage,
  type ConversationEvent,
  type ConversationSnapshot,
  type RuntimeProjection,
} from '@/lib/conversation-sync'
import type { DemoRuntimeEvent } from '@/lib/demo-runtime'
import type { RuntimeEventEnvelope } from '@/lib/runtime-contract'

const snapshot = (cursor: number): ConversationSnapshot => ({
  cursor,
  selectedSessionId: 'old',
  drafts: {},
  messages: [],
})

const selected = (cursor: number, sessionId: string): ConversationEvent => ({
  type: 'conversation.selected',
  cursor,
  originWindow: 'main',
  sessionId,
})

const runtimeEvent = (
  type: DemoRuntimeEvent['type'],
  sequence: number,
  extra: Record<string, unknown> = {}
): DemoRuntimeEvent =>
  ({
    type,
    runId: 'run-1',
    sessionId: 'thread-1',
    sequence,
    ...extra,
  }) as DemoRuntimeEvent

const formalRuntimeEvent = (
  event: RuntimeEventEnvelope['event'],
  sequence: number,
  runId = 'run-1'
): RuntimeEventEnvelope => ({
  schemaVersion: '1.0',
  eventId: `event-${sequence}`,
  runtimeId: 'hermes',
  runtimeEpoch: 'epoch-1',
  sessionId: 'thread-1',
  runId,
  sequence,
  timestamp: '2026-08-06T00:00:00.000Z',
  event,
})

const message = (id: string, value: string): ThreadMessage =>
  ({
    id,
    object: 'thread.message',
    thread_id: 'thread-1',
    role: 'assistant',
    content: [
      { type: 'text', text: { value, annotations: [] } },
    ],
    status: 'ready',
    created_at: 1,
    completed_at: 1,
  }) as ThreadMessage

describe('conversation sync projection', () => {
  it('applies only buffered events newer than the snapshot cursor', () => {
    const result = reconcileSnapshot(snapshot(5), [
      selected(4, 'stale'),
      selected(6, 'new'),
    ])

    expect(result.selectedSessionId).toBe('new')
    expect(result.cursor).toBe(6)
  })

  it('deduplicates runtime deltas by run and sequence', () => {
    const state = applyRuntimeEvents(undefined, [
      runtimeEvent('run_started', 0),
      runtimeEvent('message_delta', 1, { delta: '你' }),
      runtimeEvent('message_delta', 1, { delta: '你' }),
      runtimeEvent('message_delta', 2, { delta: '好' }),
    ])

    expect(state?.content).toBe('你好')
    expect(state?.lastSequence).toBe(2)
  })

  it('drops an active runtime projection after its first terminal event', () => {
    const running: RuntimeProjection = {
      runId: 'run-1',
      sessionId: 'thread-1',
      lastSequence: 1,
      content: '完成',
      status: 'running',
    }

    expect(
      applyRuntimeEvents(running, [
        runtimeEvent('message_completed', 2, { content: '完成' }),
        runtimeEvent('message_delta', 3, { delta: '错误' }),
      ])
    ).toBeUndefined()
  })

  it('upserts the same persisted message id instead of appending twice', () => {
    expect(upsertMessage([message('m1', '旧')], message('m1', '新'))).toEqual([
      message('m1', '新'),
    ])
  })

  it('projects formal runtime envelopes for the status popup', () => {
    const started = formalRuntimeEvent(
      { type: 'run_started', userMessageId: 'user-1' },
      0
    )
    const delta = formalRuntimeEvent(
      { type: 'text_delta', messageId: 'assistant-1', delta: '你好' },
      1
    )
    const completed = formalRuntimeEvent(
      { type: 'run_completed', stopReason: 'end_turn' },
      2
    )

    expect(
      applyRuntimeEnvelope(undefined, started)
    ).toEqual(expect.objectContaining({ runId: 'run-1', content: '' }))
    const running = applyRuntimeEnvelope(undefined, started)
    const withDelta = applyRuntimeEnvelope(running, delta)
    expect(withDelta?.content).toBe('你好')
    expect(applyRuntimeEnvelope(withDelta, completed)).toBeUndefined()
  })

  it.each([
    ['empty event id', { eventId: '' }],
    ['empty run id', { runId: '' }],
    [
      'invalid permission decision',
      {
        event: {
          type: 'permission_resolved',
          requestId: 'permission-1',
          decision: 'always_allow',
        },
      },
    ],
    [
      'incomplete runtime error',
      { event: { type: 'run_failed', error: { message: '失败' } } },
    ],
    ['unknown envelope field', { unexpected: true }],
  ])('rejects a runtime event with %s', (_name, override) => {
    const envelope = {
      ...formalRuntimeEvent(
        { type: 'run_started', userMessageId: 'user-1' },
        0
      ),
      ...override,
    }

    expect(
      isConversationEvent({
        type: 'runtime.event',
        cursor: 1,
        originWindow: 'main',
        event: envelope,
      })
    ).toBe(false)
  })
})
