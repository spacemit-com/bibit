import { create } from 'zustand'

type ConversationAttentionState = {
  pendingPermissionCounts: Record<string, Record<string, number>>
  setPendingPermissionCount(
    threadId: string,
    sourceId: string,
    count: number
  ): void
  clearPendingPermissionSource(sourceId: string): void
  resetForTests(): void
}

export const useConversationAttentionStore =
  create<ConversationAttentionState>()((set) => ({
    pendingPermissionCounts: {},
    setPendingPermissionCount: (threadId, sourceId, count) =>
      set((state) => {
        const currentSources = state.pendingPermissionCounts[threadId] ?? {}
        if ((currentSources[sourceId] ?? 0) === count) return state

        const pendingPermissionCounts = { ...state.pendingPermissionCounts }
        const sources = { ...currentSources }
        if (count > 0) sources[sourceId] = count
        else delete sources[sourceId]
        if (Object.keys(sources).length > 0) {
          pendingPermissionCounts[threadId] = sources
        } else {
          delete pendingPermissionCounts[threadId]
        }
        return { pendingPermissionCounts }
      }),
    clearPendingPermissionSource: (sourceId) =>
      set((state) => {
        let changed = false
        const pendingPermissionCounts = Object.fromEntries(
          Object.entries(state.pendingPermissionCounts).flatMap(
            ([threadId, currentSources]) => {
              if (!(sourceId in currentSources)) {
                return [[threadId, currentSources]]
              }
              changed = true
              const sources = { ...currentSources }
              delete sources[sourceId]
              return Object.keys(sources).length > 0 ? [[threadId, sources]] : []
            }
          )
        )
        return changed ? { pendingPermissionCounts } : state
      }),
    resetForTests: () => set({ pendingPermissionCounts: {} }),
  }))
