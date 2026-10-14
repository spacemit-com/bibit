import { create } from 'zustand'
import {
  applyRuntimeEnvelope,
  type ConversationEvent,
  type ConversationProjection,
  type RuntimeProjection,
} from '@/lib/conversation-sync'

type ConversationSyncState = {
  cursor: number
  selectedSessionId?: string
  drafts: Record<string, string>
  activeRuns: Record<string, RuntimeProjection>
  applySnapshot: (snapshot: ConversationProjection) => void
  applyEvent: (event: ConversationEvent) => boolean
  reset: () => void
}

const initialState = {
  cursor: 0,
  selectedSessionId: undefined,
  drafts: {},
  activeRuns: {},
}

export const useConversationSyncStore = create<ConversationSyncState>()(
  (set, get) => ({
    ...initialState,
    applySnapshot: (snapshot) => {
      set({
        cursor: snapshot.cursor,
        selectedSessionId: snapshot.selectedSessionId,
        drafts: { ...snapshot.drafts },
        activeRuns: snapshot.activeRun
          ? { [snapshot.activeRun.sessionId]: snapshot.activeRun }
          : {},
      })
    },
    applyEvent: (event) => {
      if (event.cursor <= get().cursor) return false

      set((state) => {
        switch (event.type) {
          case 'conversation.selected':
            return {
              cursor: event.cursor,
              selectedSessionId: event.sessionId ?? undefined,
            }
          case 'conversation.draft_changed':
            return {
              cursor: event.cursor,
              drafts: {
                ...state.drafts,
                [event.sessionId]: event.draft,
              },
            }
          case 'runtime.event': {
            const sessionId = event.event.sessionId
            const current = state.activeRuns[sessionId]
            const next = applyRuntimeEnvelope(current, event.event)
            if (next === current) return { cursor: event.cursor }
            const activeRuns = { ...state.activeRuns }
            if (next) activeRuns[sessionId] = next
            else delete activeRuns[sessionId]
            return { cursor: event.cursor, activeRuns }
          }
          default:
            return { cursor: event.cursor }
        }
      })
      return true
    },
    reset: () => set({ ...initialState, drafts: {}, activeRuns: {} }),
  })
)
