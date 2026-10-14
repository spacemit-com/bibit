import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionDecisionV1 } from '@bibit/feature-contracts'
import type {
  RuntimeEventEnvelope,
  RuntimePermissionData,
} from '@/lib/runtime-contract'
import { useConversationAttentionStore } from '../conversationAttentionStore'

const h = vi.hoisted(() => ({ invoke: vi.fn(), emit: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ emit: (...args: unknown[]) => h.emit(...args) }))
import { useRuntimeStore } from '@/stores/runtime-store'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

import {
  applyRuntimePermissionSnapshot,
  applyRuntimePermissionEnvelope,
  observeRuntimePermission,
  resetRuntimePermissionControllerForTests,
  resolveRuntimePermission,
  runtimePermissionIdentityKey,
  useRuntimePermissionController,
} from '../runtimePermissionController'

const data: RuntimePermissionData = {
  runtimeId: 'hermes',
  runtimeEpoch: 'epoch-1',
  sessionId: 'thread-1',
  runId: 'run-1',
  createdAt: '2026-08-20T00:00:00.000Z',
  expiresAt: '2026-08-20T00:01:00.000Z',
  requestId: 'permission-1',
  toolCallId: 'tool-1',
  title: '允许工具调用',
  description: 'Hermes 请求执行工具',
  toolName: 'terminal',
  canAllowOnce: true,
  canDeny: true,
  status: 'pending',
}

const decision: PermissionDecisionV1 = {
  version: 1,
  runtimeInstanceId: 'hermes:epoch-1',
  runtimeId: 'hermes',
  runtimeEpoch: 'epoch-1',
  sessionId: 'thread-1',
  threadId: 'thread-1',
  runId: 'run-1',
  requestId: 'permission-1',
  toolCallId: 'tool-1',
  decision: 'allow_once',
}

const receipt = {
  ...decision,
  version: 1 as const,
  status: 'accepted' as const,
}

describe('runtimePermissionController', () => {
  beforeEach(() => {
    resetRuntimePermissionControllerForTests()
    h.invoke.mockReset()
    h.emit.mockReset()
    useRuntimeStore.setState(state => ({ capabilities: { ...state.capabilities, sessionEvents: false } }))
    h.invoke.mockResolvedValue(receipt)
  })

  it('deduplicates concurrent decisions and keeps the accepted result', async () => {
    const first = resolveRuntimePermission(data, decision)
    const second = resolveRuntimePermission(data, decision)

    await expect(first).resolves.toEqual(receipt)
    await expect(second).resolves.toEqual(receipt)
    expect(h.invoke).toHaveBeenCalledOnce()
    expect(
      useRuntimePermissionController.getState().entries[
        runtimePermissionIdentityKey(data)
      ]?.status
    ).toBe('resolved')
  })

  it('accepts a session approval acknowledgement as a versioned receipt', async () => {
    useRuntimeStore.setState(state => ({ capabilities: { ...state.capabilities, sessionEvents: true } }))
    h.invoke.mockResolvedValue({ accepted: true, duplicate: false })
    await expect(resolveRuntimePermission({ ...data, targetId: 'target-1' }, decision)).resolves.toMatchObject({ version: 1, status: 'accepted' })
  })

  it.each(['permission_expired', 'session_conflict'])('refreshes authoritative history after %s without reviving a resolved card', async (code) => {
    useRuntimeStore.setState(state => ({ capabilities: { ...state.capabilities, sessionEvents: true } }))
    const requestData = { ...data, targetId: 'target-1' }
    const feed = { targetId: 'target-1', runtimeEpoch: data.runtimeEpoch, sessionId: data.sessionId, events: [] }
    h.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
      if (name === 'runtime_session_approval') throw { code, details: { httpStatus: 409 } }
      if (name === 'runtime_session_feed') return feed
    })
    h.emit.mockImplementation(async () => { observeRuntimePermission({ ...requestData, status: 'resolved' }) })
    const result = resolveRuntimePermission(requestData, decision)
    if (code === 'permission_expired') await expect(result).resolves.toMatchObject({ status: 'expired' })
    else await expect(result).rejects.toMatchObject({ code })
    expect(h.emit).toHaveBeenCalledWith('runtime-session-event', { ...feed, kind: 'summary' })
    observeRuntimePermission(requestData)
    expect(useRuntimePermissionController.getState().entries[runtimePermissionIdentityKey(requestData)].status).toBe('resolved')
    expect(useConversationAttentionStore.getState().pendingPermissionCounts[data.sessionId]).toBeUndefined()
    expect(h.invoke.mock.calls.filter(([name]) => name === 'runtime_session_approval')).toHaveLength(1)
  })

  it('keeps an IPC failure retryable across component lifetimes', async () => {
    h.invoke.mockRejectedValueOnce({
      code: 'process_exited',
      message: '连接已断开',
      recoverable: true,
    })

    await expect(resolveRuntimePermission(data, decision)).rejects.toEqual(
      expect.objectContaining({ code: 'process_exited' })
    )
    expect(
      useRuntimePermissionController.getState().entries[
        runtimePermissionIdentityKey(data)
      ]
    ).toMatchObject({ status: 'error', error: 'process_exited: 连接已断开' })

    await expect(resolveRuntimePermission(data, decision)).resolves.toEqual(
      receipt
    )
    expect(h.invoke).toHaveBeenCalledTimes(2)
  })

  it.each(['expired', 'stale'] as const)(
    'closes attention for a terminal %s receipt',
    async (status) => {
      h.invoke.mockResolvedValueOnce({ ...receipt, status })

      await expect(resolveRuntimePermission(data, decision)).resolves.toMatchObject({
        status,
      })

      expect(
        useRuntimePermissionController.getState().entries[
          runtimePermissionIdentityKey(data)
        ]
      ).toMatchObject({ status: 'resolved', data: { status: 'resolved' } })
      expect(
        useConversationAttentionStore.getState().pendingPermissionCounts[
          'thread-1'
        ]
      ).toBeUndefined()
    }
  )

  it('keeps equal request ids isolated by the composite identity', () => {
    const other = { ...data, sessionId: 'thread-2', runId: 'run-2' }
    observeRuntimePermission(data)
    observeRuntimePermission(other)

    expect(
      Object.keys(useRuntimePermissionController.getState().entries)
    ).toHaveLength(2)
  })

  it('keeps permissions with distinct thread ids isolated', () => {
    observeRuntimePermission({ ...data, threadId: 'thread-a' })
    observeRuntimePermission({ ...data, threadId: 'thread-b' })

    expect(
      Object.keys(useRuntimePermissionController.getState().entries)
    ).toHaveLength(2)
  })

  it('reopens approval when the action digest changes after a stale receipt', async () => {
    const first = { ...data, actionSetDigest: 'a'.repeat(64) }
    const second = { ...data, actionSetDigest: 'b'.repeat(64) }
    h.invoke.mockResolvedValueOnce({ ...receipt, status: 'stale' })

    await expect(resolveRuntimePermission(first, decision)).resolves.toMatchObject({
      status: 'stale',
    })
    observeRuntimePermission(second)
    expect(
      useRuntimePermissionController.getState().entries[
        runtimePermissionIdentityKey(second)
      ]
    ).toMatchObject({ status: 'pending', data: { actionSetDigest: 'b'.repeat(64) } })

    await expect(resolveRuntimePermission(second, { ...decision, actionSetDigest: 'b'.repeat(64) })).resolves.toMatchObject({
      status: 'accepted',
    })
    expect(h.invoke).toHaveBeenCalledTimes(2)
  })

  it('removes projections from a retired Runtime epoch on snapshot reconcile', () => {
    observeRuntimePermission(data)
    observeRuntimePermission({ ...data, runtimeEpoch: 'epoch-2' })

    applyRuntimePermissionSnapshot({
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-2',
      sequence: 0,
      status: 'ready',
    })

    const entries = useRuntimePermissionController.getState().entries
    expect(Object.keys(entries)).toHaveLength(1)
    expect(entries[runtimePermissionIdentityKey(data)]).toBeUndefined()
    expect(
      entries[runtimePermissionIdentityKey({ ...data, runtimeEpoch: 'epoch-2' })]
    ).toMatchObject({ status: 'pending' })
  })

  it('does not resurrect a retired epoch when a persisted part remounts', () => {
    observeRuntimePermission(data)
    applyRuntimePermissionSnapshot({
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-2',
      sequence: 0,
      status: 'ready',
    })

    observeRuntimePermission(data)

    expect(
      useRuntimePermissionController.getState().entries[
        runtimePermissionIdentityKey(data)
      ]
    ).toBeUndefined()
    expect(
      useConversationAttentionStore.getState().pendingPermissionCounts['thread-1']
    ).toBeUndefined()
  })

  it('returns stale without IPC when code resolves a retired epoch', async () => {
    applyRuntimePermissionSnapshot({
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-2',
      sequence: 0,
      status: 'ready',
    })

    await expect(resolveRuntimePermission(data, decision)).resolves.toMatchObject({
      status: 'stale',
      runtimeEpoch: 'epoch-1',
    })
    expect(h.invoke).not.toHaveBeenCalled()
    expect(
      useRuntimePermissionController.getState().entries[
        runtimePermissionIdentityKey(data)
      ]
    ).toBeUndefined()
  })

  it('preserves an explicit thread id in stale receipts', async () => {
    const threadedData = { ...data, threadId: 'thread-a' }
    const threadedDecision = { ...decision, threadId: 'thread-a' }
    applyRuntimePermissionSnapshot({
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-2',
      sequence: 0,
      status: 'ready',
    })

    await expect(
      resolveRuntimePermission(threadedData, threadedDecision)
    ).resolves.toMatchObject({
      status: 'stale',
      sessionId: 'thread-1',
      threadId: 'thread-a',
    })
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('binds presenter-failed fallback requests to the explicit thread id', async () => {
    const threadedData = { ...data, threadId: 'thread-a' }
    const fallbackReceipt = {
      ...decision,
      threadId: 'thread-a',
      decision: 'deny' as const,
      reason: 'presenter-failed' as const,
      status: 'accepted' as const,
    }
    h.invoke.mockResolvedValueOnce(fallbackReceipt)

    await expect(
      resolveRuntimePermission(threadedData, {
        ...decision,
        threadId: 'wrong-thread',
      })
    ).resolves.toEqual(fallbackReceipt)
    expect(h.invoke).toHaveBeenCalledWith('runtime_permission_resolve', {
      request: expect.objectContaining({
        sessionId: 'thread-1',
        threadId: 'thread-a',
        decision: 'deny',
        reason: 'presenter-failed',
      }),
    })
  })

  it('ignores a late receipt after the Runtime epoch changes', async () => {
    let settle: ((value: typeof receipt) => void) | undefined
    h.invoke.mockReturnValueOnce(
      new Promise<typeof receipt>((resolve) => {
        settle = resolve
      })
    )
    const pending = resolveRuntimePermission(data, decision)
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledOnce())

    applyRuntimePermissionSnapshot({
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-2',
      sequence: 1,
      status: 'ready',
    })
    settle?.(receipt)
    await expect(pending).resolves.toEqual(receipt)

    expect(
      useRuntimePermissionController.getState().entries[
        runtimePermissionIdentityKey(data)
      ]
    ).toBeUndefined()
    expect(
      useConversationAttentionStore.getState().pendingPermissionCounts['thread-1']
    ).toBeUndefined()
  })

  it('projects a backend resolution event without submitting a decision', () => {
    observeRuntimePermission(data)
    expect(
      useConversationAttentionStore.getState().pendingPermissionCounts['thread-1']
    ).toEqual({ 'runtime-hermes': 1 })
    applyRuntimePermissionEnvelope({
      schemaVersion: '1.0',
      eventId: 'event-2',
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-1',
      sessionId: 'thread-1',
      runId: 'run-1',
      sequence: 2,
      timestamp: '2026-08-20T00:00:05.000Z',
      event: {
        type: 'permission_resolved',
        requestId: 'permission-1',
        decision: 'deny',
      },
    } satisfies RuntimeEventEnvelope)

    expect(
      useRuntimePermissionController.getState().entries[
        runtimePermissionIdentityKey(data)
      ]
    ).toMatchObject({
      status: 'resolved',
      data: { status: 'resolved', decision: 'deny' },
    })
    expect(h.invoke).not.toHaveBeenCalled()
    expect(
      useConversationAttentionStore.getState().pendingPermissionCounts['thread-1']
    ).toBeUndefined()
  })

  it.each([
    { type: 'run_completed' as const, stopReason: 'end_turn' },
    { type: 'run_cancelled' as const, reason: 'user_cancelled' },
    {
      type: 'run_failed' as const,
      error: {
        code: 'run_failed' as const,
        message: 'agent failed',
        recoverable: false,
      },
    },
  ])('closes pending projections when a run emits $type', (event) => {
    observeRuntimePermission(data)

    applyRuntimePermissionEnvelope({
      schemaVersion: '1.0',
      eventId: `event-${event.type}`,
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-1',
      sessionId: 'thread-1',
      runId: 'run-1',
      sequence: 3,
      timestamp: '2026-08-20T00:00:06.000Z',
      event,
    } satisfies RuntimeEventEnvelope)

    expect(
      useRuntimePermissionController.getState().entries[
        runtimePermissionIdentityKey(data)
      ]
    ).toMatchObject({ status: 'resolved', data: { status: 'resolved' } })
    expect(h.invoke).not.toHaveBeenCalled()
    expect(
      useConversationAttentionStore.getState().pendingPermissionCounts['thread-1']
    ).toBeUndefined()
  })
})
