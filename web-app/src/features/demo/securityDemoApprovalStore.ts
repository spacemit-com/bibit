import { create } from 'zustand'
import type {
  PermissionDecisionReceiptV1,
  PermissionDecisionV1,
} from '@bibit/feature-contracts'
import { useConversationAttentionStore } from '@/features/conversation/conversationAttentionStore'

export type SecurityDemoApprovalStatus = 'pending' | 'allowed' | 'denied'

export type SecurityDemoApprovalEvent = {
  id: string
  threadId: string
  afterMessageId?: string
  status: SecurityDemoApprovalStatus
  createdAt: string
  expiresAt: string
}

export type SecurityDemoApprovalThread = {
  byId: Record<string, SecurityDemoApprovalEvent>
  order: string[]
  pendingIds: Record<string, true>
}

type SecurityDemoApprovalState = {
  threads: Record<string, SecurityDemoApprovalThread>
  request(threadId: string, afterMessageId?: string): string
  decide(
    threadId: string,
    eventId: string,
    decision: PermissionDecisionV1
  ): Promise<PermissionDecisionReceiptV1>
  resetForTests(): void
}

let requestSequence = 0
const ATTENTION_SOURCE_ID = 'security-demo'

const identityFor = (event: SecurityDemoApprovalEvent) => ({
  runtimeInstanceId: 'security-demo-runtime:development',
  runtimeId: 'security-demo-runtime',
  runtimeEpoch: 'development',
  sessionId: event.threadId,
  threadId: event.threadId,
  runId: `security-demo:${event.threadId}:${event.id}`,
  requestId: event.id,
  toolCallId: event.id,
})

const syncAttention = (
  threadId: string,
  get: () => SecurityDemoApprovalState
) => {
  const count = Object.keys(get().threads[threadId]?.pendingIds ?? {}).length
  useConversationAttentionStore
    .getState()
    .setPendingPermissionCount(threadId, ATTENTION_SOURCE_ID, count)
}

export const useSecurityDemoApprovalStore =
  create<SecurityDemoApprovalState>()((set, get) => ({
    threads: {},
    request: (threadId, afterMessageId) => {
      requestSequence += 1
      const id = `security-demo-${threadId}-${requestSequence}`
      const createdAt = new Date().toISOString()
      const event: SecurityDemoApprovalEvent = {
        id,
        threadId,
        afterMessageId,
        status: 'pending',
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + 5 * 60_000).toISOString(),
      }
      set((state) => {
        const current = state.threads[threadId] ?? {
          byId: {},
          order: [],
          pendingIds: {},
        }
        return {
          threads: {
            ...state.threads,
            [threadId]: {
              byId: { ...current.byId, [id]: event },
              order: [...current.order, id],
              pendingIds: { ...current.pendingIds, [id]: true },
            },
          },
        }
      })
      syncAttention(threadId, get)
      return id
    },
    decide: async (threadId, eventId, decision) => {
      const event = get().threads[threadId]?.byId[eventId]
      const fallbackIdentity = {
        runtimeInstanceId: 'security-demo-runtime:development',
        runtimeId: 'security-demo-runtime',
        runtimeEpoch: 'development',
        sessionId: threadId,
        threadId,
        runId: `security-demo:${threadId}:${eventId}`,
        requestId: eventId,
        toolCallId: eventId,
      }
      const identity = event ? identityFor(event) : fallbackIdentity
      const matches = Object.entries(identity).every(
        ([field, value]) => decision[field as keyof PermissionDecisionV1] === value
      )
      if (!event || !matches) {
        return { version: 1, ...identity, decision: decision.decision, status: 'stale' }
      }
      if (
        event.status === 'pending' &&
        Date.parse(event.expiresAt) <= Date.now()
      ) {
        set((state) => {
          const current = state.threads[threadId]
          if (!current?.pendingIds[eventId]) return state
          const pendingIds = { ...current.pendingIds }
          delete pendingIds[eventId]
          return {
            threads: {
              ...state.threads,
              [threadId]: {
                ...current,
                byId: {
                  ...current.byId,
                  [eventId]: { ...current.byId[eventId], status: 'denied' },
                },
                pendingIds,
              },
            },
          }
        })
        syncAttention(threadId, get)
        return {
          version: 1,
          ...identity,
          decision: decision.decision,
          status: 'expired',
        }
      }
      if (event.status !== 'pending') {
        const previous = event.status === 'allowed' ? 'allow_once' : 'deny'
        return {
          version: 1,
          ...identity,
          decision: decision.decision,
          status: previous === decision.decision ? 'duplicate' : 'rejected',
        }
      }

      set((state) => {
        const current = state.threads[threadId]
        if (!current?.pendingIds[eventId]) return state
        const pendingIds = { ...current.pendingIds }
        delete pendingIds[eventId]
        return {
          threads: {
            ...state.threads,
            [threadId]: {
              ...current,
              byId: {
                ...current.byId,
                [eventId]: {
                  ...current.byId[eventId],
                  status: decision.decision === 'allow_once' ? 'allowed' : 'denied',
                },
              },
              pendingIds,
            },
          },
        }
      })
      syncAttention(threadId, get)
      return { version: 1, ...identity, decision: decision.decision, status: 'accepted' }
    },
    resetForTests: () => {
      requestSequence = 0
      useConversationAttentionStore
        .getState()
        .clearPendingPermissionSource(ATTENTION_SOURCE_ID)
      set({ threads: {} })
    },
  }))
