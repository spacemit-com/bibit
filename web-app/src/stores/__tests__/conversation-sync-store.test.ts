import { beforeEach, describe, expect, it } from 'vitest'
import { useConversationSyncStore } from '@/stores/conversation-sync-store'

describe('conversation sync store', () => {
  beforeEach(() => useConversationSyncStore.getState().reset())

  it('keeps per-session drafts and active runtime projections', () => {
    useConversationSyncStore.getState().applySnapshot({
      cursor: 3,
      selectedSessionId: 'thread-1',
      drafts: { 'thread-1': '草稿' },
      messages: [],
      activeRun: {
        runId: 'run-1',
        sessionId: 'thread-1',
        lastSequence: 1,
        content: '你',
        status: 'running',
      },
    })

    const state = useConversationSyncStore.getState()
    expect(state.cursor).toBe(3)
    expect(state.drafts['thread-1']).toBe('草稿')
    expect(state.activeRuns['thread-1']?.content).toBe('你')
  })

  it('ignores duplicate cursors and removes a terminal runtime projection', () => {
    const store = useConversationSyncStore.getState()
    store.applyEvent({
      type: 'runtime.event',
      cursor: 1,
      originWindow: 'main',
      event: {
        schemaVersion: '1.0',
        eventId: 'event-1',
        runtimeId: 'hermes',
        runtimeEpoch: 'epoch-1',
        sessionId: 'thread-1',
        runId: 'run-1',
        sequence: 0,
        timestamp: '2026-08-06T00:00:00.000Z',
        event: { type: 'run_started', userMessageId: 'user-1' },
      },
    })
    store.applyEvent({
      type: 'runtime.event',
      cursor: 2,
      originWindow: 'main',
      event: {
        schemaVersion: '1.0',
        eventId: 'event-2',
        runtimeId: 'hermes',
        runtimeEpoch: 'epoch-1',
        sessionId: 'thread-1',
        runId: 'run-1',
        sequence: 1,
        timestamp: '2026-08-06T00:00:01.000Z',
        event: { type: 'run_completed', stopReason: 'end_turn' },
      },
    })
    store.applyEvent({
      type: 'conversation.selected',
      cursor: 2,
      originWindow: 'status-popup',
      sessionId: 'stale',
    })

    const state = useConversationSyncStore.getState()
    expect(state.activeRuns['thread-1']).toBeUndefined()
    expect(state.selectedSessionId).toBeUndefined()
    expect(state.cursor).toBe(2)
  })
})
