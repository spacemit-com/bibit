import { create } from 'zustand'
import { ulid } from 'ulidx'
import { getServiceHub } from '@/hooks/useServiceHub'
import { Fzf } from 'fzf'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useAgentMode } from '@/hooks/useAgentMode'
import { ExtensionManager } from '@/lib/extension'
import { ExtensionTypeEnum, VectorDBExtension } from '@janhq/core'
import { useChatSessions } from '@/stores/chat-session-store'
import { useAppState } from '@/hooks/useAppState'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useConversationCardState } from '@/stores/conversation-card-state'
import i18n from '@/i18n/setup'

type ThreadState = {
  threads: Record<string, Thread>
  isLoadingThreads: boolean
  setThreadsLoading: (loading: boolean) => void
  currentThreadId?: string
  currentThreadTargetId?: string
  getCurrentThread: () => Thread | undefined
  setThreads: (threads: Thread[]) => void
  getFavoriteThreads: () => Thread[]
  getThreadById: (threadId: string) => Thread | undefined
  toggleFavorite: (threadId: string) => void
  deleteThread: (threadId: string) => Promise<void>
  renameThread: (threadId: string, newTitle: string) => void
  deleteAllThreads: () => void
  clearAllThreads: () => void
  unstarAllThreads: () => void
  setCurrentThreadId: (threadId?: string) => void
  createThread: (
    model: ThreadModel,
    title?: string,
    isTemporary?: boolean,
    expectedTargetId?: string
  ) => Promise<Thread>
  updateCurrentThreadModel: (model: ThreadModel) => void
  getFilteredThreads: (searchTerm: string) => Thread[]
  updateThreadTimestamp: (threadId: string) => void
  updateThread: (threadId: string, updates: Partial<Thread>) => void
  searchIndex: Fzf<Thread[]> | null
}

/**
 * 标题索引。`casing: 'case-insensitive'` 是刻意的：fzf 默认的 smart-case 会让
 * 「Runtime」这类带大写字母的查询变成大小写敏感，用户输入 bibit 就搜不到 Bibit。
 * 索引在 8 处构建，规则只能有一份。
 */
const titleSearchIndex = (threads: Thread[]) =>
  new Fzf<Thread[]>(threads, {
    selector: (item: Thread) => item.title ?? '',
    casing: 'case-insensitive',
  })

// Helper function to clean up vector DB collection for a thread
const cleanupVectorDB = async (threadId: string) => {
  try {
    const vec = ExtensionManager.getInstance().get<VectorDBExtension>(
      ExtensionTypeEnum.VectorDB
    )
    if (vec?.deleteCollection) {
      await vec.deleteCollection(`attachments_${threadId}`)
    }
  } catch (e) {
    console.warn(
      `[Threads] Failed to delete vector DB collection for thread ${threadId}:`,
      e
    )
  }
}

export const useThreads = create<ThreadState>()((set, get) => ({
  threads: {},
  isLoadingThreads: true,
  setThreadsLoading: (loading) => set({ isLoadingThreads: loading }),
  searchIndex: null,
  setThreads: (threads) => {
    const threadMap = threads.reduce(
      (acc: Record<string, Thread>, thread) => {
        acc[thread.id] = {
          ...thread,
          model: thread.model
            ? {
                provider:
                  thread.model?.provider?.replace('llama.cpp', 'llamacpp') ??
                  'llamacpp',
                // Cortex migration: take first two parts of the ID (the last is file name which is not needed)
                id:
                  thread.model?.provider === 'llama.cpp' ||
                  thread.model?.provider === 'llamacpp'
                    ? thread.model?.id
                        ?.split(':')
                        .slice(0, 2)
                        .join(getServiceHub().path().sep())
                    : thread.model?.id,
              }
            : undefined,
        }
        return acc
      },
      {} as Record<string, Thread>
    )
    // Filter out threads without valid titles for search index
    const filteredForSearch = Object.values(threadMap).filter(
      (t) => t.id !== TEMPORARY_CHAT_ID && t.title
    )

    set({
      threads: threadMap,
      searchIndex: titleSearchIndex(filteredForSearch),
    })
  },
  getFilteredThreads: (searchTerm: string) => {
    const { threads, searchIndex } = get()

    // Filter out temporary chat from all operations
    const filteredThreadsValues = Object.values(threads).filter(
      (t) => t.id !== TEMPORARY_CHAT_ID
    )

    // If no search term, return all threads
    if (!searchTerm) {
      // return all threads
      return filteredThreadsValues
    }

    let currentIndex = searchIndex
    if (!currentIndex?.find) {
      currentIndex = titleSearchIndex(filteredThreadsValues.filter(t => t.title))
      set({ searchIndex: currentIndex })
    }

    // Use the index to search and return matching threads
    const fzfResults = currentIndex.find(searchTerm)
    return fzfResults.map(
      (result: { item: Thread; positions: Set<number> }) => {
        const thread = result.item // Fzf stores the original item here

        return {
          ...thread,
          title: thread.title, // Override title with highlighted version
        }
      }
    )
  },
  toggleFavorite: (threadId) => {
    set((state) => {
      getServiceHub()
        .threads()
        .updateThread({
          ...state.threads[threadId],
          isFavorite: !state.threads[threadId].isFavorite,
        })
      return {
        threads: {
          ...state.threads,
          [threadId]: {
            ...state.threads[threadId],
            isFavorite: !state.threads[threadId].isFavorite,
            updated: Date.now() / 1000,
          },
        },
      }
    })
  },
  deleteThread: async (threadId) => {
    const thread = get().threads[threadId]
    if (!thread) return
    await getServiceHub().threads().deleteThread(
      threadId,
      thread.metadata?.targetId as string | undefined
    )
    if (get().threads[threadId] !== thread) return

    useConversationCardState.getState().clearSession(threadId, thread.metadata?.targetId as string | undefined)

    useAgentMode.getState().removeThread(threadId)
    useChatSessions.getState().removeSession(threadId)
    useAppState.getState().clearThreadState(threadId)
    await cleanupVectorDB(threadId)
    set((state) => {
      const remainingThreads = { ...state.threads }
      delete remainingThreads[threadId]
      return {
        threads: remainingThreads,
        searchIndex: titleSearchIndex(
          Object.values(remainingThreads).filter(
            (t) => t.id !== TEMPORARY_CHAT_ID && t.title
          )
        ),
      }
    })
  },
  deleteAllThreads: () => {
    set((state) => {
      const allThreadIds = Object.keys(state.threads)

      const threadsToKeepIds = allThreadIds.filter(
        (threadId) => state.threads[threadId].isFavorite
      )
      const threadsToDeleteIds = allThreadIds.filter(
        (threadId) => !state.threads[threadId].isFavorite
      )

      // Delete threads and clean up their vector DB collections
      threadsToDeleteIds.forEach((threadId) => {
        cleanupVectorDB(threadId)
        const targetId = state.threads[threadId]?.metadata?.targetId as string | undefined
        void getServiceHub().threads().deleteThread(threadId, targetId)
          .then(() => useConversationCardState.getState().clearSession(threadId, targetId))
          .catch((error: unknown) => console.error('Failed to delete thread', error))
      })

      const remainingThreads = threadsToKeepIds.reduce(
        (acc, threadId) => {
          acc[threadId] = state.threads[threadId]
          return acc
        },
        {} as Record<string, Thread>
      )

      return {
        threads: remainingThreads,
        searchIndex: titleSearchIndex(
          Object.values(remainingThreads).filter(
            (t) => t.id !== TEMPORARY_CHAT_ID && t.title
          )
        ),
      }
    })
  },
  clearAllThreads: () => {
    set((state) => {
      const allThreadIds = Object.keys(state.threads)

      allThreadIds.forEach((threadId) => {
        useAgentMode.getState().removeThread(threadId)
        useChatSessions.getState().removeSession(threadId)
        useAppState.getState().clearThreadState(threadId)
        cleanupVectorDB(threadId)
        const targetId = state.threads[threadId]?.metadata?.targetId as string | undefined
        void getServiceHub().threads().deleteThread(threadId, targetId)
          .then(() => useConversationCardState.getState().clearSession(threadId, targetId))
          .catch((error: unknown) => console.error('Failed to delete thread', error))
      })

      return {
        threads: {},
        currentThreadId: undefined,
        searchIndex: titleSearchIndex([]),
      }
    })
  },
  unstarAllThreads: () => {
    set((state) => {
      const updatedThreads = Object.keys(state.threads).reduce(
        (acc, threadId) => {
          acc[threadId] = {
            ...state.threads[threadId],
            isFavorite: false,
          }
          return acc
        },
        {} as Record<string, Thread>
      )
      Object.values(updatedThreads).forEach((thread) => {
        getServiceHub()
          .threads()
          .updateThread({ ...thread, isFavorite: false })
      })
      return { threads: updatedThreads }
    })
  },
  getFavoriteThreads: () => {
    return Object.values(get().threads).filter((thread) => thread.isFavorite)
  },
  getThreadById: (threadId: string) => {
    return get().threads[threadId]
  },
  setCurrentThreadId: (threadId) => {
    if (threadId !== get().currentThreadId) set({ currentThreadId: threadId })
  },
  createThread: async (
    model,
    title,
    isTemporary,
    expectedTargetId
  ) => {
    const runtime = useRuntimeStore.getState()
    const sourceEpoch = runtime.runtimeEpoch
    const sourceRuntimeId = runtime.runtimeId
    const selectedTargetId = get().currentThreadTargetId
    const newThread: Thread = {
      id: isTemporary ? TEMPORARY_CHAT_ID : ulid(),
      // ponytail: 默认标题按创建时的语言落库，切语言后老会话标题不变；
      // 要根治得改成"标题留空 + 渲染方兜底 common:newThread"。
      title:
        title ??
        (isTemporary
          ? i18n.t('common:temporaryChat')
          : i18n.t('common:newThread')),
      model,
      updated: Date.now() / 1000,
      ...(model.provider === 'runtime' && {
        metadata: { agentId: model.id, ...((expectedTargetId ?? get().currentThreadTargetId) && { targetId: expectedTargetId ?? get().currentThreadTargetId }) },
      }),
      ...(isTemporary && {
        metadata: { isTemporary: true },
      }),
    }
    return await getServiceHub()
      .threads()
      .createThread(newThread)
      .then((createdThread) => {
        if (model.provider === 'runtime' && runtime.capabilities.sessionEvents) {
          const current = useRuntimeStore.getState()
          if (current.runtimeEpoch !== sourceEpoch || current.runtimeId !== sourceRuntimeId ||
            (get().currentThreadTargetId !== selectedTargetId && get().currentThreadTargetId !== createdThread.metadata?.targetId)) {
            // 创建已在原目标完成，返回结果供调用者保存首条输入，但不污染当前目标列表。
            return createdThread
          }
        }
        set((state) => {
          // Get all existing threads as an array
          const existingThreads = Object.values(state.threads)

          // Create new array with the new thread at the beginning
          const reorderedThreads = [createdThread, ...existingThreads]

          // Use setThreads to handle proper ordering (this will assign order 1, 2, 3...)
          get().setThreads(reorderedThreads)

          return {
            currentThreadId: createdThread.id,
          }
        })
        return createdThread
      })
  },
  updateCurrentThreadModel: (model) => {
    set((state) => {
      if (!state.currentThreadId) return { ...state }
      const currentThread = state.getCurrentThread()
      if (currentThread)
        getServiceHub()
          .threads()
          .updateThread({ ...currentThread, model })
      return {
        threads: {
          ...state.threads,
          [state.currentThreadId as string]: {
            ...state.threads[state.currentThreadId as string],
            model,
          },
        },
      }
    })
  },
  renameThread: (threadId, newTitle) => {
    set((state) => {
      const thread = state.threads[threadId]
      if (!thread) return state
      const updatedThread = {
        ...thread,
        title: newTitle,
        updated: Date.now() / 1000,
        metadata: { ...thread.metadata, titleSetManually: true },
      }
      getServiceHub().threads().updateThread(updatedThread) // External call, order is fine
      const newThreads = { ...state.threads, [threadId]: updatedThread }
      return {
        threads: newThreads,
        searchIndex: titleSearchIndex(
          Object.values(newThreads).filter((t) => t.id !== TEMPORARY_CHAT_ID && t.title)
        ),
      }
    })
  },
  getCurrentThread: () => {
    const { currentThreadId, threads } = get()
    return currentThreadId ? threads[currentThreadId] : undefined
  },
  updateThreadTimestamp: (threadId) => {
    set((state) => {
      const thread = state.threads[threadId]
      if (!thread) return state

      // Update the thread with new timestamp and set it to order 1 (top)
      const updatedThread = {
        ...thread,
        updated: Date.now() / 1000,
      }

      // Update all other threads to increment their order by 1
      const updatedThreads = { ...state.threads }
      updatedThreads[threadId] = updatedThread

      // Update the backend for the main thread
      getServiceHub().threads().updateThread(updatedThread)

      return {
        threads: updatedThreads,
        searchIndex: titleSearchIndex(
          Object.values(updatedThreads).filter(
            (t) => t.id !== TEMPORARY_CHAT_ID && t.title
          )
        ),
      }
    })
  },
  updateThread: (threadId, updates) => {
    set((state) => {
      const thread = state.threads[threadId]
      if (!thread) return state

      const updatedThread = {
        ...thread,
        ...updates,
        updated: Date.now() / 1000,
      }

      getServiceHub().threads().updateThread(updatedThread)

      const newThreads = { ...state.threads, [threadId]: updatedThread }
      return {
        threads: newThreads,
        searchIndex: titleSearchIndex(
          Object.values(newThreads).filter((t) => t.id !== TEMPORARY_CHAT_ID && t.title)
        ),
      }
    })
  },
}))
