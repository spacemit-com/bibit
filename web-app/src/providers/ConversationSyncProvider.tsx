import type { OverlayHandoff } from '@/lib/overlay-handoff'
import { NEW_THREAD_ATTACHMENT_KEY, useChatAttachments } from '@/hooks/useChatAttachments'
import { useEffect, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useNavigate } from '@tanstack/react-router'
import {
  isConversationEvent,
  reconcileSnapshot,
  type ConversationEvent,
  type ConversationProjection,
  type ConversationSnapshot,
} from '@/lib/conversation-sync'
import { useConversationSyncStore } from '@/stores/conversation-sync-store'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useThreads } from '@/hooks/useThreads'
import { usePrompt } from '@/hooks/usePrompt'
import { useMessages } from '@/hooks/useMessages'
import { useChatSessions } from '@/stores/chat-session-store'
import { getServiceHub } from '@/hooks/useServiceHub'
import { resolveWindowSurface } from '@/lib/window-surface'
import i18n from '@/i18n'

type ConversationSyncProviderProps = {
  children: ReactNode
  enabled?: boolean
}

const DRAFT_DEBOUNCE_MS = 120
const OVERLAY_WINDOW = 'voice-overlay'

export function ConversationSyncProvider({
  children,
  enabled = IS_TAURI,
}: ConversationSyncProviderProps) {
  const navigate = useNavigate()
  const sessionEvents = useRuntimeStore(state => state.capabilities.sessionEvents)
  const runtimeEpoch = useRuntimeStore(state => state.runtimeEpoch)

  useEffect(() => {
    if (!enabled) return

    const windowSurface = resolveWindowSurface(getCurrentWebviewWindow().label)
    const windowLabel = windowSurface
    const ownsSelection = windowSurface === OVERLAY_WINDOW
    let targetId: string | undefined
    let disposed = false
    let initialized = false
    let snapshotInFlight = false
    let refreshRequested = false
    let applyingRemote = false
    let navigationVersion = 0
    let unlistenConversation: UnlistenFn | undefined
    let unlistenVisibility: UnlistenFn | undefined
    let unlistenHandoff: UnlistenFn | undefined
    let unlistenThreadCreated: UnlistenFn | undefined
    let unsubscribeThreads: (() => void) | undefined
    let unsubscribePrompt: (() => void) | undefined
    let draftTimer: ReturnType<typeof setTimeout> | undefined
    const bufferedEvents: ConversationEvent[] = []

    const withRemoteUpdate = (update: () => void) => {
      applyingRemote = true
      try {
        update()
      } finally {
        applyingRemote = false
      }
    }

    const navigateToSession = async (sessionId?: string) => {
      const version = ++navigationVersion
      if (!sessionId) {
        if (disposed || version !== navigationVersion) return false
        await navigate({
          to: windowSurface === 'status-popup' || windowSurface === 'voice-overlay' ? '/status-popup' : '/',
          replace: true,
        })
        return !disposed && version === navigationVersion && !useThreads.getState().currentThreadId
      }

      if (
        windowSurface !== 'status-popup' &&
        !useThreads.getState().threads[sessionId]
      ) {
        try {
          const threads = await getServiceHub().threads().fetchThreads()
          if (disposed || version !== navigationVersion || useThreads.getState().currentThreadId !== sessionId) return false
          useThreads.getState().setThreads(threads)
        } catch (error) {
          console.error('Failed to refresh conversations for window sync:', error)
          return false
        }
      }
      if (
        disposed ||
        version !== navigationVersion ||
        useThreads.getState().currentThreadId !== sessionId ||
        windowSurface !== 'status-popup' &&
        !useThreads.getState().threads[sessionId]
      ) {
        return false
      }
      await navigate({
        to: '/threads/$threadId',
        params: { threadId: sessionId },
        replace: true,
      })
      return !disposed && version === navigationVersion && useThreads.getState().currentThreadId === sessionId
    }

    const applyDraft = (prompt: string, sessionId?: string) => {
      let draftToken: string = crypto.randomUUID()
      if (sessionEvents && targetId && sessionId) {
        try {
          const saved = JSON.parse(localStorage.getItem(`bibit:session-draft:${JSON.stringify([targetId, sessionId])}`) ?? '{}')
          if (saved.content === prompt) {
            if (typeof saved.draftToken === 'string') draftToken = saved.draftToken
          }
        } catch { /* 损坏的附件状态不能阻止正文同步。 */ }
      }
      usePrompt.setState({ prompt, draftToken })
    }

    const applyRemoteSelection = (sessionId?: string) => {
      const draft = sessionId
        ? useConversationSyncStore.getState().drafts[sessionId] ?? ''
        : ''
      withRemoteUpdate(() => {
        useThreads.setState({ currentThreadId: sessionId, ...(sessionEvents ? { currentThreadTargetId: targetId } : {}) })
        applyDraft(draft, sessionId)
      })
      void navigateToSession(sessionId)
    }

    const applyProjection = (
      projection: ConversationProjection,
      requestedSessionId?: string
    ) => {
      if (sessionEvents) {
        if (projection.targetId !== targetId) return
        if (ownsSelection) withRemoteUpdate(() => useThreads.setState({ currentThreadTargetId: targetId }))
        useConversationSyncStore.getState().applySnapshot(projection)
        const selectedSessionId = ownsSelection ? useThreads.getState().currentThreadId : projection.selectedSessionId
        if (selectedSessionId !== useThreads.getState().currentThreadId) {
          applyRemoteSelection(selectedSessionId)
        } else if (selectedSessionId) {
          withRemoteUpdate(() => applyDraft(projection.drafts[selectedSessionId] ?? '', selectedSessionId))
        }
        return
      }
      useConversationSyncStore.getState().applySnapshot(projection)
      const selectedSessionId = ownsSelection ? useThreads.getState().currentThreadId : projection.selectedSessionId
      const previousSelectedSessionId =
        useThreads.getState().currentThreadId
      const messageSessionId =
        projection.messages[0]?.thread_id ??
        requestedSessionId ??
        selectedSessionId

      withRemoteUpdate(() => {
        useThreads.setState({ currentThreadId: selectedSessionId })
        if (!ownsSelection || selectedSessionId) {
          applyDraft(selectedSessionId ? projection.drafts[selectedSessionId] ?? '' : '', selectedSessionId)
        }
      })

      if (messageSessionId) {
        const messages = useMessages.getState()
        messages.setMessages(messageSessionId, projection.messages)
        for (const message of projection.messages) {
          useChatSessions
            .getState()
            .syncPersistentMessage(messageSessionId, message)
        }
      }
      if (projection.activeRun) {
        useChatSessions
          .getState()
          .syncMirroredRuntimeProjection(projection.activeRun)
      } else {
        const authoritativeSessionId = requestedSessionId ?? selectedSessionId
        if (authoritativeSessionId) {
          useChatSessions
            .getState()
            .clearMirroredRuntimeProjection(authoritativeSessionId)
        }
      }
      if (selectedSessionId !== previousSelectedSessionId) {
        void navigateToSession(selectedSessionId)
      }
    }

    const applyEvent = (event: ConversationEvent) => {
      if (sessionEvents) {
        if (event.targetId !== targetId) return
        if (!useConversationSyncStore.getState().applyEvent(event)) return
        const remote = event.originWindow !== windowLabel
        if (
          event.type === 'conversation.selected' &&
          !ownsSelection && remote && event.originWindow !== OVERLAY_WINDOW &&
          event.sessionId !== useThreads.getState().currentThreadId
        ) {
          applyRemoteSelection(event.sessionId ?? undefined)
        } else if (
          event.type === 'conversation.draft_changed' &&
          remote &&
          event.sessionId === useThreads.getState().currentThreadId
        ) {
          withRemoteUpdate(() => applyDraft(event.draft, event.sessionId))
        }
        return
      }
      if (!useConversationSyncStore.getState().applyEvent(event)) return
      const remote = event.originWindow !== windowLabel

      switch (event.type) {
        case 'conversation.selected':
          // 浮窗那一份选中是它自己的，换会话不该把主窗口拽过去。
          if (remote && !ownsSelection && event.originWindow !== OVERLAY_WINDOW) {
            applyRemoteSelection(event.sessionId ?? undefined)
          }
          break
        case 'conversation.draft_changed':
          if (
            remote &&
            event.sessionId === useThreads.getState().currentThreadId
          ) {
            withRemoteUpdate(() => applyDraft(event.draft, event.sessionId))
          }
          break
        case 'conversation.message_created':
        case 'conversation.message_updated':
          useMessages.getState().upsertLocalMessage(event.message)
          useChatSessions
            .getState()
            .syncPersistentMessage(event.message.thread_id, event.message)
          break
        case 'conversation.message_deleted':
          useMessages
            .getState()
            .removeLocalMessage(event.sessionId, event.messageId)
          break
        case 'runtime.event':
          if (remote) {
            useChatSessions
              .getState()
              .applyMirroredRuntimeEnvelope(event.event)
          }
          break
      }
    }

    const requestedSessionIdForSnapshot = () =>
      windowSurface === 'status-popup'
        ? undefined
        : useThreads.getState().currentThreadId

    const synchronizeSnapshot = async () => {
      if (snapshotInFlight) {
        refreshRequested = true
        return
      }

      snapshotInFlight = true
      try {
        do {
          refreshRequested = false
          const requestedSessionId = requestedSessionIdForSnapshot()
          const snapshot = await invoke<ConversationSnapshot>(
            'conversation_snapshot',
            {
              sessionId: requestedSessionId,
              originWindow: windowLabel,
              ...(sessionEvents ? { expectedTargetId: targetId } : {}),
            }
          )
          if (disposed) return

          const pendingEvents = bufferedEvents
            .splice(0)
            .filter((event) => event.cursor > snapshot.cursor)
          const projection = reconcileSnapshot(snapshot, pendingEvents)
          applyProjection(projection, requestedSessionId)
          initialized = true

          // Events emitted after the snapshot response but before the next
          // refresh iteration must still be applied in cursor order.
          for (const event of bufferedEvents
            .splice(0)
            .sort((left, right) => left.cursor - right.cursor)) {
            applyEvent(event)
          }
        } while (refreshRequested && !disposed)
      } finally {
        snapshotInFlight = false
      }
    }

    const startLocalSubscriptions = () => {
      unsubscribeThreads = useThreads.subscribe((state, previous) => {
        if (
          applyingRemote ||
          (state.currentThreadId === previous.currentThreadId && (!sessionEvents || state.currentThreadTargetId === previous.currentThreadTargetId))
        ) {
          return
        }
        navigationVersion += 1
        if (sessionEvents && state.currentThreadTargetId !== targetId) return
        const sessionId = state.currentThreadId
        if (ownsSelection && !sessionId) return
        if (!sessionId) {
          withRemoteUpdate(() => {
            applyDraft('')
          })
        } else {
          withRemoteUpdate(() => applyDraft(useConversationSyncStore.getState().drafts[sessionId] ?? '', sessionId))
        }
        if (windowSurface === 'status-popup') void navigateToSession(sessionId)
        // 浮窗的会话选择是它自己的事：广播出去会让主窗口跟着跳走，打断用户
        // 正在进行的对话。主窗口只应在 handoff 时被拉过来——那条路径由
        // voice-overlay-handoff 监听自己调 select，不依赖这里。
        if (ownsSelection) return
        void invoke('conversation_select_session', {
          originWindow: windowLabel,
          sessionId,
          ...(sessionEvents ? { expectedTargetId: targetId } : {}),
        }).catch((error) =>
          console.error('Failed to synchronize selected conversation:', error)
        )
      })

      unsubscribePrompt = usePrompt.subscribe((state, previous) => {
        if (applyingRemote || state.prompt === previous.prompt) return
        const threads = useThreads.getState()
        const sessionId = threads.currentThreadId
        if (!sessionId) return
        if (sessionEvents && threads.currentThreadTargetId !== targetId) return
        const draft = state.prompt
        if (draftTimer) clearTimeout(draftTimer)
        draftTimer = setTimeout(() => {
          void invoke('conversation_update_draft', {
            originWindow: windowLabel,
            sessionId,
            draft,
            ...(sessionEvents ? { expectedTargetId: targetId } : {}),
          }).catch((error) =>
            console.error('Failed to synchronize conversation draft:', error)
          )
        }, DRAFT_DEBOUNCE_MS)
      })
    }

    const initialize = async () => {
      if (sessionEvents) {
        const identity = await invoke<{ targetId: string }>('runtime_target_identity')
        if (disposed) return
        targetId = identity.targetId
      }
      unlistenConversation = await listen<ConversationEvent>(
        'conversation-event',
        ({ payload }) => {
          if (!isConversationEvent(payload)) return
          if (!initialized || snapshotInFlight) bufferedEvents.push(payload)
          else applyEvent(payload)
        }
      )
      if (disposed) {
        unlistenConversation()
        unlistenConversation = undefined
        return
      }

      if (windowSurface === 'status-popup') {
        const visibilityUnlisten = await listen<boolean>(
          'popup_visibility_changed',
          ({ payload }) => {
            if (!payload) return
            void synchronizeSnapshot().catch((error) =>
              console.error(
                'Failed to refresh status popup conversation snapshot:',
                error
              )
            )
          }
        )
        if (disposed) {
          visibilityUnlisten()
          return
        }
        unlistenVisibility = visibilityUnlisten
      }

      await synchronizeSnapshot()
      if (disposed) return
      startLocalSubscriptions()
      if (windowSurface === 'main') {
        void listen('conversation-thread-created', async () => {
          try {
            const threads = await getServiceHub().threads().fetchThreads()
            if (disposed) return
            const replaceThreads = useThreads.getState().setThreads
            if (typeof replaceThreads === 'function') replaceThreads(threads)
          } catch (error) {
            console.error('Failed to refresh threads after overlay session creation:', error)
          }
        }).then(unlisten => {
          if (disposed) unlisten()
          else unlistenThreadCreated = unlisten
        })
      }
      if (windowSurface === 'main') {
        unlistenHandoff = await listen<OverlayHandoff>('voice-overlay-handoff', ({ payload }) => {
          void (async () => {
            try {
              if (!payload || typeof payload.id !== 'string' || typeof payload.draft !== 'string' ||
                !Array.isArray(payload.attachments) || typeof payload.runtimeEnabled !== 'boolean' ||
                (payload.sessionId !== undefined && typeof payload.sessionId !== 'string') ||
                (payload.targetId !== undefined && typeof payload.targetId !== 'string')) {
                throw new Error(i18n.t('common:handoffPayloadInvalid'))
              }
              if (payload.runtimeEnabled !== useRuntimeStore.getState().enabled) throw new Error(i18n.t('common:handoffRuntimeMismatch'))
              if (payload.runtimeEnabled) {
                const identity = await invoke<{ targetId: string; runtimeEpoch?: string }>('runtime_target_identity')
                if (identity.targetId !== payload.targetId || identity.runtimeEpoch !== payload.runtimeEpoch) throw new Error(i18n.t('common:handoffRuntimeSwitched'))
              }
              await invoke('conversation_select_session', {
                originWindow: windowLabel, sessionId: payload.sessionId,
                ...(sessionEvents ? { expectedTargetId: payload.targetId } : {}),
              })
              withRemoteUpdate(() => {
                useThreads.setState({ currentThreadId: payload.sessionId, currentThreadTargetId: payload.targetId })
                usePrompt.setState({ prompt: payload.draft })
              })
              const key = payload.runtimeEnabled
                ? JSON.stringify([payload.targetId ?? '', payload.sessionId ?? NEW_THREAD_ATTACHMENT_KEY])
                : payload.sessionId ?? NEW_THREAD_ATTACHMENT_KEY
              useChatAttachments.getState().setAttachments(key, payload.attachments)
              if (!await navigateToSession(payload.sessionId)) throw new Error(i18n.t('common:handoffTargetSessionFailed'))
              await emitTo('voice-overlay', 'voice-overlay-handoff-ack', { id: payload.id })
            } catch (cause) {
              await emitTo('voice-overlay', 'voice-overlay-handoff-ack', { id: payload?.id, error: String(cause) })
            }
          })()
        })
        if (disposed) { unlistenHandoff(); return }
      }

      const selected = useThreads.getState()
      if (sessionEvents && selected.currentThreadId && selected.currentThreadTargetId === targetId) {
        await invoke('conversation_select_session', { originWindow: windowLabel, sessionId: selected.currentThreadId, expectedTargetId: targetId })
      }
    }

    void initialize().catch((error) =>
      console.error('Failed to initialize conversation window sync:', error)
    )

    return () => {
      disposed = true
      navigationVersion += 1
      if (draftTimer) clearTimeout(draftTimer)
      unsubscribeThreads?.()
      unsubscribePrompt?.()
      unlistenConversation?.()
      unlistenVisibility?.()
      unlistenThreadCreated?.()
      unlistenHandoff?.()
    }
  }, [enabled, navigate, sessionEvents, runtimeEpoch])

  return <>{children}</>
}
