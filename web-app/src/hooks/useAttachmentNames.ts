import { useEffect } from 'react'
import { create } from 'zustand'
import { ExtensionTypeEnum, VectorDBExtension } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'

type AttachmentNamesState = {
  byId: Record<string, string>
  loading: Record<string, boolean>
  loadedScopes: Record<string, boolean>
  ensure: (threadId: string) => void
}

const scopeKey = (threadId: string) => `thread:${threadId}`

export const useAttachmentNamesStore = create<AttachmentNamesState>(
  (set, get) => ({
    byId: {},
    loading: {},
    loadedScopes: {},

    ensure: (id) => {
      if (!id) return
      const key = scopeKey(id)
      const state = get()
      if (state.loadedScopes[key] || state.loading[key]) return

      set((s) => ({ loading: { ...s.loading, [key]: true } }))
      const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
        ExtensionTypeEnum.VectorDB
      )
      const fetcher = ext?.listAttachments?.bind(ext)

      if (!fetcher) {
        set((s) => ({
          loading: { ...s.loading, [key]: false },
          loadedScopes: { ...s.loadedScopes, [key]: true },
        }))
        return
      }

      fetcher(id)
        .then((files) => {
          const next: Record<string, string> = {}
          for (const f of files || []) {
            if (f?.id && f?.name) next[f.id] = f.name
          }
          set((s) => ({
            byId: { ...s.byId, ...next },
            loading: { ...s.loading, [key]: false },
            loadedScopes: { ...s.loadedScopes, [key]: true },
          }))
        })
        .catch(() => {
          set((s) => ({
            loading: { ...s.loading, [key]: false },
            loadedScopes: { ...s.loadedScopes, [key]: true },
          }))
        })
    },
  })
)

export function useAttachmentName(fileId: string | undefined): string | undefined {
  return useAttachmentNamesStore((s) => (fileId ? s.byId[fileId] : undefined))
}

export function useEnsureAttachmentNames(
  threadId: string | undefined
) {
  const ensure = useAttachmentNamesStore((s) => s.ensure)
  useEffect(() => {
    if (threadId) ensure(threadId)
  }, [threadId, ensure])
}
