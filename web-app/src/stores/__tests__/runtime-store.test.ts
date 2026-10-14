import { beforeEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_SESSION_ID,
  type RuntimeEventEnvelope,
  type RuntimeSnapshot,
  type RuntimeStatus,
} from '@/lib/runtime-contract'
import { useRuntimeStore } from '@/stores/runtime-store'

const statusEnvelope = (
  runtimeEpoch: string,
  sequence: number,
  status: RuntimeStatus,
  message?: string
): RuntimeEventEnvelope => ({
  schemaVersion: '1.0',
  eventId: `${runtimeEpoch}-${sequence}`,
  runtimeId: 'hermes',
  runtimeEpoch,
  sessionId: RUNTIME_SESSION_ID,
  sequence,
  timestamp: '2026-08-05T00:00:00.000Z',
  event: {
    type: 'runtime_status_changed',
    status,
    ...(message === undefined ? {} : { message }),
  },
})

const snapshot = (
  runtimeEpoch: string,
  sequence: number,
  status: RuntimeSnapshot['status'],
  message?: string
): RuntimeSnapshot => ({
  runtimeId: 'hermes',
  runtimeEpoch,
  sequence,
  status,
  ...(message === undefined ? {} : { message }),
})

describe('runtime store', () => {
  beforeEach(() => {
    useRuntimeStore.setState({
      enabled: true,
      runtimeId: 'bianbu',
      availableRuntimes: [],
      capabilities: { durableSessions: true, detachedRuns: true, replayableEvents: true, runtimeOwnedApprovals: true },
      status: 'stopped',
      runtimeEpoch: undefined,
      lastSequence: -1,
      message: undefined,
      retiredEpochs: new Set(),
    })
  })

  it('atomically replaces capabilities on envelope and snapshot identity changes', () => {
    const durable = { durableSessions: true, detachedRuns: true, replayableEvents: true, runtimeOwnedApprovals: true }
    const transient = { durableSessions: false, detachedRuns: false, replayableEvents: false, runtimeOwnedApprovals: false }
    useRuntimeStore.setState({ runtimeId: 'bianbu', runtimeEpoch: 'bianbu-a', capabilities: durable, availableRuntimes: [
      { id: 'bianbu', displayName: 'Bianbu', available: true, capabilities: durable },
      { id: 'hermes', displayName: 'Hermes', available: true, capabilities: transient },
    ] })
    useRuntimeStore.getState().applyEnvelope(statusEnvelope('hermes-a', 0, 'starting'))
    expect(useRuntimeStore.getState().capabilities).toEqual(transient)
    useRuntimeStore.getState().applySnapshot({ ...snapshot('bianbu-b', 1, 'ready'), runtimeId: 'bianbu' })
    expect(useRuntimeStore.getState().capabilities).toEqual(durable)
    useRuntimeStore.getState().applyAvailableRuntimes([])
    useRuntimeStore.getState().applySnapshot(snapshot('unknown-a', 0, 'starting'))
    expect(useRuntimeStore.getState().capabilities).toEqual(transient)
    // 同 profile 换 endpoint 时 epoch 变化，不能保留旧连接能力。
    useRuntimeStore.getState().applyCapabilities(durable, { runtimeId: 'hermes', runtimeEpoch: 'unknown-a' })
    useRuntimeStore.getState().applySnapshot(snapshot('unknown-b', 0, 'starting'))
    expect(useRuntimeStore.getState().capabilities).toEqual(transient)
  })

  it('starts enabled with a stopped Runtime and no observed sequence', () => {
    const state = useRuntimeStore.getState()
    expect(state.enabled).toBe(true)
    expect(state.status).toBe('stopped')
    expect(state.lastSequence).toBe(-1)
    expect(state.retiredEpochs.size).toBe(0)
  })

  it('applies ordered status envelopes and ignores duplicate sequences', () => {
    useRuntimeStore
      .getState()
      .applyEnvelope(statusEnvelope('epoch-a', 2, 'checking', '检查中'))
    useRuntimeStore
      .getState()
      .applyEnvelope(statusEnvelope('epoch-a', 2, 'failed', '重复事件'))
    useRuntimeStore
      .getState()
      .applyEnvelope(statusEnvelope('epoch-a', 1, 'failed', '旧事件'))

    expect(useRuntimeStore.getState()).toMatchObject({
      status: 'checking',
      runtimeEpoch: 'epoch-a',
      lastSequence: 2,
      message: '检查中',
    })
  })

  it('retires the prior epoch and ignores its late status events', () => {
    useRuntimeStore
      .getState()
      .applyEnvelope(statusEnvelope('epoch-a', 4, 'starting'))
    useRuntimeStore
      .getState()
      .applyEnvelope(statusEnvelope('epoch-b', 0, 'ready'))
    useRuntimeStore
      .getState()
      .applyEnvelope(statusEnvelope('epoch-a', 5, 'failed', '迟到'))

    const state = useRuntimeStore.getState()
    expect(state).toMatchObject({
      status: 'ready',
      runtimeEpoch: 'epoch-b',
      lastSequence: 0,
    })
    expect(state.retiredEpochs.has('epoch-a')).toBe(true)
  })

  it('ignores non-Runtime sessions and non-status events', () => {
    useRuntimeStore.getState().applyEnvelope({
      ...statusEnvelope('epoch-a', 0, 'ready'),
      sessionId: 'thread-1',
    })
    useRuntimeStore.getState().applyEnvelope({
      ...statusEnvelope('epoch-a', 0, 'ready'),
      sessionId: 'thread-1',
      runId: 'run-1',
      event: { type: 'run_started', userMessageId: 'user-1' },
    })

    expect(useRuntimeStore.getState()).toMatchObject({
      status: 'stopped',
      runtimeEpoch: undefined,
      lastSequence: -1,
    })
  })

  it('applies snapshots without allowing stale or retired epochs to win', () => {
    useRuntimeStore
      .getState()
      .applySnapshot(snapshot('epoch-a', 5, 'starting', '启动中'))
    useRuntimeStore
      .getState()
      .applySnapshot(snapshot('epoch-a', 4, 'failed', '旧快照'))
    useRuntimeStore
      .getState()
      .applySnapshot(snapshot('epoch-b', 1, 'ready', '已连接'))
    useRuntimeStore
      .getState()
      .applySnapshot(snapshot('epoch-a', 6, 'failed', '已退休'))

    const state = useRuntimeStore.getState()
    expect(state).toMatchObject({
      status: 'ready',
      runtimeEpoch: 'epoch-b',
      lastSequence: 1,
      message: '已连接',
    })
    expect(state.retiredEpochs.has('epoch-a')).toBe(true)
  })
})
