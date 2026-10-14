import { create } from 'zustand'
import { useToolApproval } from './useToolApproval'
import { createPermissionRequestLedger } from '@/features/conversation/permissionRequestLedger'

export type PendingApproval = {
  toolCallId: string
  toolName: string
  threadId: string
  toolParameters?: Readonly<Record<string, unknown>>
  createdAt: string
}

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

type ToolApprovalRequestsState = {
  // In-flight per-tool-call approval prompts. Kept out of the persisted
  // useToolApproval store so approval churn never flushes to disk (the
  // resolve callbacks are non-serializable anyway).
  pending: Record<string, PendingApproval>

  requestApproval: (
    toolCallId: string,
    toolName: string,
    threadId: string,
    toolParameters?: Readonly<Record<string, unknown>>
  ) => Promise<boolean>
  resolveApproval: (toolCallId: string, decision: ApprovalDecision) => void
  clearPendingForThread: (threadId: string) => void
  clearAllPending: () => void
  resetForTests: () => void
}

const requestLedger = createPermissionRequestLedger<boolean>()

export const useToolApprovalRequests = create<ToolApprovalRequestsState>()(
  (set, get) => ({
    pending: {},

    requestApproval: (toolCallId, toolName, threadId, toolParameters) => {
      const ticket = requestLedger.request(toolCallId, threadId)
      if (!ticket.isNew) return ticket.promise
      const settings = useToolApproval.getState()
      if (
        settings.allowAllMCPPermissions ||
        settings.isToolApproved(threadId, toolName)
      ) {
        requestLedger.decide(toolCallId, true)
        return ticket.promise
      }
      set((s) => ({
        pending: {
          ...s.pending,
          [toolCallId]: {
            toolCallId,
            toolName,
            threadId,
            toolParameters,
            createdAt: new Date().toISOString(),
          },
        },
      }))
      return ticket.promise
    },

    resolveApproval: (toolCallId, decision) => {
      const entry = get().pending[toolCallId]
      if (!entry) return
      if (decision === 'allow-always') {
        useToolApproval.getState().approveToolForThread(entry.threadId, entry.toolName)
      }
      set((s) => {
        const next = { ...s.pending }
        delete next[toolCallId]
        return { pending: next }
      })
      requestLedger.decide(toolCallId, decision !== 'deny')
    },

    clearPendingForThread: (threadId) => {
      const { pending } = get()
      const stranded = Object.values(pending).filter(
        (entry) => entry.threadId === threadId
      )
      if (stranded.length > 0) {
        set((s) => {
          const next = { ...s.pending }
          for (const entry of stranded) delete next[entry.toolCallId]
          return { pending: next }
        })
      }
      // Resolve as denied so any awaiting tool loop unblocks instead of hanging.
      requestLedger.clearThread(threadId, false)
    },
    clearAllPending: () => {
      set({ pending: {} })
      requestLedger.clear(false)
    },
    resetForTests: () => {
      requestLedger.reset()
      set({ pending: {} })
    },
  })
)
