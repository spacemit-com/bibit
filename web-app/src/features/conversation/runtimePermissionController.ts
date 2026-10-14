import { invoke } from '@tauri-apps/api/core'
import { withRuntimeController } from '@/lib/runtime-controller'
import { emit } from '@tauri-apps/api/event'
import type { SessionFeed } from '@/hooks/useSessionFeed'
import { create } from 'zustand'
import { useRuntimeStore } from '@/stores/runtime-store'
import type {
  PermissionDecisionReceiptV1,
  PermissionDecisionV1,
} from '@bibit/feature-contracts'
import {
  formatRuntimeCommandError,
  parsePermissionDecisionReceipt,
  type PermissionResolveRequest,
  type RuntimeEventEnvelope,
  type RuntimePermissionData,
  type RuntimeSnapshot,
} from '@/lib/runtime-contract'
import { toRuntimePermissionResolveRequest } from './adapters/runtimePermissionAdapter'
import { useConversationAttentionStore } from './conversationAttentionStore'

export type RuntimePermissionControllerStatus =
  | 'pending'
  | 'submitting'
  | 'resolved'
  | 'error'

export type RuntimePermissionControllerEntry = {
  data: RuntimePermissionData
  status: RuntimePermissionControllerStatus
  error?: string
  receipt?: PermissionDecisionReceiptV1
}

type RuntimePermissionControllerState = {
  entries: Record<string, RuntimePermissionControllerEntry>
}

export const runtimePermissionIdentityKey = (
  data: Pick<
    RuntimePermissionData,
    | 'targetId'
    | 'runtimeId'
    | 'runtimeEpoch'
    | 'sessionId'
    | 'runId'
    | 'requestId'
    | 'toolCallId'
    | 'actionSetDigest'
    | 'threadId'
  >
) =>
  [
    data.targetId ?? `${data.runtimeId}:${data.runtimeEpoch}`,
    data.runtimeId,
    data.runtimeEpoch,
    data.sessionId,
    data.threadId ?? data.sessionId,
    data.runId,
    data.requestId,
    data.toolCallId,
    data.actionSetDigest ?? '',
  ].join('\u0000')

export const useRuntimePermissionController =
  create<RuntimePermissionControllerState>(() => ({ entries: {} }))

const inFlight = new Map<string, Promise<PermissionDecisionReceiptV1>>()
const ATTENTION_SOURCE_ID = 'runtime-hermes'
let attentionThreads = new Set<string>()
const activeRuntimeEpochs = new Map<string, string | null>()

export const isRuntimePermissionCurrent = (
  data: Pick<RuntimePermissionData, 'runtimeId' | 'runtimeEpoch'>
) => {
  if (!activeRuntimeEpochs.has(data.runtimeId)) return true
  return activeRuntimeEpochs.get(data.runtimeId) === data.runtimeEpoch
}

const syncAttention = () => {
  const counts = new Map<string, number>()
  for (const entry of Object.values(
    useRuntimePermissionController.getState().entries
  )) {
    if (entry.status === 'resolved' || entry.data.status === 'resolved') continue
    counts.set(
      entry.data.sessionId,
      (counts.get(entry.data.sessionId) ?? 0) + 1
    )
  }
  const nextThreads = new Set(counts.keys())
  for (const threadId of new Set([...attentionThreads, ...nextThreads])) {
    useConversationAttentionStore
      .getState()
      .setPendingPermissionCount(
        threadId,
        ATTENTION_SOURCE_ID,
        counts.get(threadId) ?? 0
      )
  }
  attentionThreads = nextThreads
}

const updateEntry = (
  key: string,
  update: (
    current: RuntimePermissionControllerEntry | undefined
  ) => RuntimePermissionControllerEntry
) => {
  useRuntimePermissionController.setState((state) => ({
    entries: { ...state.entries, [key]: update(state.entries[key]) },
  }))
  syncAttention()
}

export const observeRuntimePermission = (data: RuntimePermissionData) => {
  const key = runtimePermissionIdentityKey(data)
  if (!isRuntimePermissionCurrent(data)) return key
  updateEntry(key, (current) => {
    if (!current) {
      return {
        data,
        status: data.status === 'resolved' ? 'resolved' : 'pending',
      }
    }
    if (data.status === 'resolved') {
      return { ...current, data, status: 'resolved', error: undefined }
    }
    return current.status === 'resolved' ? current : { ...current, data }
  })
  return key
}

export const applyRuntimePermissionEnvelope = (
  envelope: RuntimeEventEnvelope
) => {
  if (envelope.event.type === 'permission_requested' && envelope.runId) {
    observeRuntimePermission({
      ...envelope.event.request,
      runtimeId: envelope.runtimeId,
      runtimeEpoch: envelope.runtimeEpoch,
      sessionId: envelope.sessionId,
      runId: envelope.runId,
      createdAt: envelope.timestamp,
      status: 'pending',
    })
    return
  }
  if (
    envelope.runId &&
    (envelope.event.type === 'run_completed' ||
      envelope.event.type === 'run_cancelled' ||
      envelope.event.type === 'run_failed')
  ) {
    useRuntimePermissionController.setState((state) => {
      let changed = false
      const entries = { ...state.entries }
      for (const [key, entry] of Object.entries(entries)) {
        const matchesRun =
          entry.data.runtimeId === envelope.runtimeId &&
          entry.data.runtimeEpoch === envelope.runtimeEpoch &&
          entry.data.sessionId === envelope.sessionId &&
          entry.data.runId === envelope.runId
        if (!matchesRun || entry.status === 'resolved') continue
        changed = true
        entries[key] = {
          ...entry,
          data: { ...entry.data, status: 'resolved' },
          status: 'resolved',
          error: undefined,
        }
      }
      return changed ? { entries } : state
    })
    syncAttention()
    return
  }
  if (envelope.event.type !== 'permission_resolved' || !envelope.runId) return
  const resolvedEvent = envelope.event

  useRuntimePermissionController.setState((state) => {
    let changed = false
    const entries = { ...state.entries }
    for (const [key, entry] of Object.entries(entries)) {
      const matches =
        entry.data.runtimeId === envelope.runtimeId &&
        entry.data.runtimeEpoch === envelope.runtimeEpoch &&
        entry.data.sessionId === envelope.sessionId &&
        entry.data.runId === envelope.runId &&
        entry.data.requestId === resolvedEvent.requestId
      if (!matches) continue
      changed = true
      entries[key] = {
        ...entry,
        data: {
          ...entry.data,
          status: 'resolved',
          decision: resolvedEvent.decision,
        },
        status: 'resolved',
        error: undefined,
      }
    }
    return changed ? { entries } : state
  })
  syncAttention()
}

export const applyRuntimePermissionSnapshot = (snapshot: RuntimeSnapshot) => {
  activeRuntimeEpochs.set(
    snapshot.runtimeId,
    snapshot.runtimeEpoch && snapshot.status !== 'stopped' && snapshot.status !== 'failed'
      ? snapshot.runtimeEpoch
      : null
  )
  useRuntimePermissionController.setState((state) => {
    if (!snapshot.runtimeEpoch || snapshot.status === 'stopped' || snapshot.status === 'failed') {
      return Object.keys(state.entries).length > 0 ? { entries: {} } : state
    }
    const entries = Object.fromEntries(
      Object.entries(state.entries).filter(
        ([, entry]) =>
          entry.data.runtimeId === snapshot.runtimeId &&
          entry.data.runtimeEpoch === snapshot.runtimeEpoch
      )
    )
    return Object.keys(entries).length === Object.keys(state.entries).length
      ? state
      : { entries }
  })
  syncAttention()
}

const assertReceiptMatchesRequest = (
  receipt: PermissionDecisionReceiptV1,
  request: PermissionResolveRequest
) => {
  const fields = [
    'runtimeInstanceId',
    'runtimeId',
    'runtimeEpoch',
    'sessionId',
    'threadId',
    'runId',
    'requestId',
    'toolCallId',
    'decision',
  ] as const
  if (fields.some((field) => receipt[field] !== request[field])) {
    throw new Error('Permission decision receipt identity mismatch')
  }
}

export const resolveRuntimePermission = (
  data: RuntimePermissionData,
  decision: PermissionDecisionV1
): Promise<PermissionDecisionReceiptV1> => {
  if (!isRuntimePermissionCurrent(data)) {
    return Promise.resolve({
      version: 1,
      runtimeInstanceId: `${data.runtimeId}:${data.runtimeEpoch}`,
      runtimeId: data.runtimeId,
      runtimeEpoch: data.runtimeEpoch,
      sessionId: data.sessionId,
      threadId: data.threadId ?? data.sessionId,
      runId: data.runId,
      requestId: data.requestId,
      toolCallId: data.toolCallId,
      decision: decision.decision,
      status: 'stale',
    })
  }
  const key = observeRuntimePermission(data)
  const active = inFlight.get(key)
  if (active) return active

  updateEntry(key, (current) => ({
    data: current?.data ?? data,
    status: 'submitting',
  }))
  const pending = Promise.resolve()
    .then(async () => {
      let request: PermissionResolveRequest
      try {
        request = toRuntimePermissionResolveRequest(data, decision)
      } catch (cause) {
        if (!data.canDeny) throw cause
        request = toRuntimePermissionResolveRequest(data, {
          version: 1,
          runtimeInstanceId: `${data.runtimeId}:${data.runtimeEpoch}`,
          runtimeId: data.runtimeId,
          runtimeEpoch: data.runtimeEpoch,
          sessionId: data.sessionId,
          threadId: data.threadId ?? data.sessionId,
          runId: data.runId,
          requestId: data.requestId,
          toolCallId: data.toolCallId,
          decision: 'deny',
          reason: 'presenter-failed',
        })
      }
      const receipt = parsePermissionDecisionReceipt(
        useRuntimeStore.getState().capabilities.sessionEvents
          ? await withRuntimeController(async () => {
              try {
                const ack = await invoke<{ accepted: boolean }>('runtime_session_approval', { expectedTargetId: data.targetId, sessionId: data.sessionId, approvalId: data.requestId, decision: request.decision })
                return { ...request, version: 1, status: ack.accepted ? 'accepted' : 'rejected' }
              } catch (cause) {
                const error = cause as { code?: string; details?: { httpStatus?: number } } | null
                const expired = error?.code === 'permission_expired'
                if (expired || error?.details?.httpStatus === 409) {
                  // 冲突后读取权威事件，即使 WS 丢失解决帧也让所有窗口关闭旧卡。
                  // 展示读折叠视图，对账读真源：这条读要的是权威状态，不是展示表示。
                  try {
                    const feed = await invoke<SessionFeed>('runtime_session_feed', { sessionId: data.sessionId })
                    if (feed.targetId === data.targetId && feed.runtimeEpoch === data.runtimeEpoch && feed.sessionId === data.sessionId) {
                      await emit('runtime-session-event', { ...feed, kind: 'summary' })
                    }
                  } catch { /* 保留原审批错误，连接恢复后继续对账。 */ }
                  if (expired) return { ...request, version: 1, status: 'expired' }
                }
                throw cause
              }
            })
          : await invoke('runtime_permission_resolve', { request })
      )
      assertReceiptMatchesRequest(receipt, request)
      if (!isRuntimePermissionCurrent(data)) return receipt
      const resolved =
        receipt.status === 'accepted' ||
        receipt.status === 'duplicate' ||
        receipt.status === 'expired' ||
        receipt.status === 'stale'
      updateEntry(key, (current) => ({
        data: resolved
          ? { ...(current?.data ?? data), status: 'resolved' }
          : (current?.data ?? data),
        status: resolved ? 'resolved' : 'error',
        ...(resolved ? { receipt } : { error: receipt.status, receipt }),
      }))
      return receipt
    })
    .catch((error: unknown) => {
      if (!isRuntimePermissionCurrent(data)) throw error
      updateEntry(key, (current) => current?.status === 'resolved' ? current : ({
        data: current?.data ?? data,
        status: 'error',
        error: formatRuntimeCommandError(error),
      }))
      throw error
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, pending)
  void pending.catch(() => {})
  return pending
}

export const resetRuntimePermissionControllerForTests = () => {
  inFlight.clear()
  activeRuntimeEpochs.clear()
  useRuntimePermissionController.setState({ entries: {} })
  attentionThreads = new Set()
  useConversationAttentionStore
    .getState()
    .clearPendingPermissionSource(ATTENTION_SOURCE_ID)
}
