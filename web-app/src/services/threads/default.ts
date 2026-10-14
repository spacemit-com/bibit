/**
 * Default Threads Service - Web implementation
 */

import { sessionUnread } from '@/hooks/useSessionReadState'
import { invoke } from '@tauri-apps/api/core'
import { withRuntimeController } from '@/lib/runtime-controller'
import { useRuntimeStore } from '@/stores/runtime-store'
import { ExtensionManager } from '@/lib/extension'
import { ConversationalExtension, ExtensionTypeEnum } from '@janhq/core'
import type { ThreadsService } from './types'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import i18n from '@/i18n/setup'
import type { RuntimeSession } from '@/lib/runtime-contract'
import { readSessionTitle, sessionTitleKey, sessionTitleRequests } from '@/lib/session-title'

export function runtimeThread(session: RuntimeSession, targetId?: string): Thread {
  const runtimeId = useRuntimeStore.getState().runtimeId ?? 'bianbu'
  const model = { id: session.agentId, provider: 'runtime' }
  return {
    id: session.id,
    object: 'thread',
    // ponytail: 同 useThreads——默认标题按当前语言落库，切语言后不追溯。
    title: session.title?.trim() || i18n.t('common:newThread'),
    created: session.createdAt,
    updated: session.updatedAt,
    model,
    metadata: { ...session.metadata, ...(targetId ? { targetId } : {}), runtime: runtimeId, agentId: session.agentId,
      runtimeSession: { id: session.id, latestRun: session.latestRun, running: session.running, waiting: session.waiting, failed: session.failed,
        completedUnread: targetId ? sessionUnread(targetId, session) : session.completedUnread, activeRunId: session.activeRunId, pendingInteraction: session.pendingInteraction } },
  } as Thread
}

function normalizeCreatedThread(e: Thread, fallback: Thread): Thread {
  return {
    ...e,
    updated: e.updated,
    model: e.model ?? fallback.model,
    order: e.metadata?.order ?? fallback.order,
  } as Thread
}

function isRuntimeThread(thread: Thread): boolean {
  return thread.model?.provider === 'runtime'
}

export class DefaultThreadsService implements ThreadsService {
  private runtimeBacked() {
    const runtime = useRuntimeStore.getState()
    return runtime.capabilities?.durableSessions ?? false
  }

  async fetchThreads(): Promise<Thread[]> {
    if (!this.runtimeBacked()) {
      const extension = ExtensionManager.getInstance().get<ConversationalExtension>(
        ExtensionTypeEnum.Conversational
      )
      if (!extension) throw new Error(i18n.t('chat:conversationStorageNotReady'))
      return extension.listThreads()
    }
    const identity = useRuntimeStore.getState().capabilities.sessionEvents
      ? await invoke<{ targetId: string; runtimeEpoch?: string }>('runtime_target_identity') : undefined
    const sessions = await invoke<RuntimeSession[]>('runtime_sessions_list')
    if (identity) {
      const current = await invoke<{ targetId: string; runtimeEpoch?: string }>('runtime_target_identity')
      if (current.targetId !== identity.targetId || current.runtimeEpoch !== identity.runtimeEpoch) throw new Error(i18n.t('chat:threadsTargetSwitched'))
    }
    return sessions.map(session => runtimeThread(session, identity?.targetId))
  }

  async createThread(thread: Thread): Promise<Thread> {
    // For temporary threads, bypass the conversational extension (in-memory only)
    if (thread.id === TEMPORARY_CHAT_ID) {
      return thread
    }
    if (this.runtimeBacked()) {
      const expectedTargetId = thread.metadata?.targetId as string | undefined
        ?? (await invoke<{ targetId: string }>('runtime_target_identity')).targetId
      if (!expectedTargetId) throw new Error(i18n.t('chat:threadsTargetUnavailable'))
      return withRuntimeController(async () => {
        await invoke('runtime_start')
        await invoke('runtime_session_create', {
          expectedTargetId,
          request: {
            sessionId: thread.id,
            agentId: thread.metadata?.agentId as string | undefined,
            title: thread.title?.trim() || undefined,
          },
        })
        return thread.metadata?.targetId === expectedTargetId
          ? thread
          : { ...thread, metadata: { ...thread.metadata, targetId: expectedTargetId } }
      })
    }

    const threadPayload = {
      ...thread,
      metadata: {
        ...thread.metadata,
        order: thread.order,
      },
    } as Thread

    try {
      const createdThread = await ExtensionManager.getInstance()
        .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
        ?.createThread(threadPayload)
      if (createdThread) return normalizeCreatedThread(createdThread, thread)
    } catch {
      if (!isRuntimeThread(thread)) return thread
    }

    if (!isRuntimeThread(thread)) return thread

    const createdThread = await invoke<Thread>('create_thread', {
      thread: threadPayload,
    })
    return normalizeCreatedThread(createdThread, thread)
  }

  async updateThread(thread: Thread): Promise<void> {
    // For temporary threads, skip updating via conversational extension
    if (thread.id === TEMPORARY_CHAT_ID) {
      return
    }

    if (this.runtimeBacked()) {
      const expectedTargetId = thread.metadata?.targetId as string | undefined
      if (!expectedTargetId) throw new Error(i18n.t('chat:threadsMissingTargetIdentity'))
      const key = sessionTitleKey(expectedTargetId, thread.id)
      localStorage.setItem(key, JSON.stringify({ ...readSessionTitle(key), manual: true }))
      await sessionTitleRequests.get(key)
      await this.withController(() => invoke('runtime_session_rename', {
        sessionId: thread.id,
        title: thread.title ?? '',
        expectedTargetId,
      }))
      return
    }

    await ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
      ?.modifyThread({
        ...thread,
        // Legacy ConversationalExtension contract still requires the field; the
        // runtime path keeps no per-thread assistant.
        assistants: [],
        metadata: {
          ...thread.metadata,
          is_favorite: thread.isFavorite,
          order: thread.order,
        },
        object: 'thread',
        created: Date.now() / 1000,
        updated: Date.now() / 1000,
      })
  }

  private async withController<T>(action: () => Promise<T>): Promise<T> {
    return withRuntimeController(action)
  }

  async deleteThread(threadId: string, expectedTargetId?: string): Promise<void> {
    // For temporary threads, skip deleting via conversational extension
    if (threadId === TEMPORARY_CHAT_ID) {
      return
    }

    if (this.runtimeBacked()) {
      if (!expectedTargetId) throw new Error(i18n.t('chat:threadsMissingTargetIdentity'))
      await this.withController(() => invoke('runtime_session_delete', { sessionId: threadId, expectedTargetId }))
      return
    }

    await ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
      ?.deleteThread(threadId)
  }
}
