import { useVoiceInputStore } from '@/stores/voice-input-store'
import { handoffOverlay } from '@/lib/overlay-handoff'
import { NEW_THREAD_ATTACHMENT_KEY, useChatAttachments } from '@/hooks/useChatAttachments'
import { useNavigate } from '@tanstack/react-router'
import { clearOverlayConversation, overlayHasUnfinishedWork, useOverlayConversationStore } from '@/stores/overlay-conversation-store'
import { invoke } from '@tauri-apps/api/core'
import {
  Check,
  ChevronDown,
  ExternalLink,
  MessageSquareText,
  Minus,
  Pin,
  PinOff,
  X,
} from 'lucide-react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useState } from 'react'
import { toast } from 'sonner'
import { isPlatformTauri } from '@/lib/platform/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { formatRuntimeCommandError } from '@/lib/runtime-contract'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useConversationSyncStore } from '@/stores/conversation-sync-store'
import { useDemoRuntimeStore } from '@/stores/demo-runtime-store'
import { useRuntimeStore } from '@/stores/runtime-store'
import { currentWindowSurface } from '@/lib/window-surface'
import { CliHandoffButton } from '@/components/CliHandoffButton'
import { VoiceOverlaySessionSwitcher } from '@/components/VoiceOverlaySessionSwitcher'
import {
  startPopupGeometryDrag,
  startVoiceOverlayDrag,
} from '@/components/WindowResizeGrips'

export function StatusPopupHeader() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const previousSessionId = useOverlayConversationStore(state => state.previousSessionId)
  const previousTargetId = useOverlayConversationStore(state => state.previousTargetId)
  const windowSurface = currentWindowSurface()
  const isVoiceOverlay = windowSurface === 'voice-overlay'
  const [isPinned, setIsPinned] = useState(isVoiceOverlay)

  const legacySessionId = useConversationSyncStore(
    (state) => state.selectedSessionId
  )
  const mode = useDemoRuntimeStore((state) => state.mode)
  const sessionEvents = useRuntimeStore(
    (state) => state.capabilities.sessionEvents
  )
  const currentThreadId = useThreads((state) => state.currentThreadId)
  const targetId = useThreads((state) => state.currentThreadTargetId)
  const threads = useThreads((state) => state.threads)
  const setCurrentThreadId = useThreads((state) => state.setCurrentThreadId)
  const draft = usePrompt((state) => state.prompt)
  const currentSessionId = sessionEvents || isVoiceOverlay ? currentThreadId : legacySessionId
  const active = useConversationSyncStore((state) =>
    currentSessionId ? Boolean(state.activeRuns[currentSessionId]) : false
  )
  const sessions = Object.values(threads)
    .filter(
      (thread) =>
        thread.id !== TEMPORARY_CHAT_ID &&
        thread.title &&
        (!sessionEvents ||
          (Boolean(targetId) && thread.metadata?.targetId === targetId))
    )
    .sort((left, right) => right.updated - left.updated)
    .slice(0, 8)

  const flushDraft = () =>
    sessionEvents && currentSessionId && targetId
      ? invoke('conversation_update_draft', {
          originWindow: windowSurface,
          sessionId: currentSessionId,
          draft,
          expectedTargetId: targetId,
        })
      : Promise.resolve()

  const runWindowAction = async (command: string) => {
    if (isVoiceOverlay && command === 'open_main_window') {
      if (useOverlayConversationStore.getState().handingOff > 0) {
        toast.info(t('common:statusPopup.handoffInputBusy'))
        return
      }
      const selected = useThreads.getState()
      const runtime = useRuntimeStore.getState()
      const sessionId = selected.currentThreadId
      const target = selected.currentThreadTargetId
      const input = usePrompt.getState().prompt
      const key = runtime.enabled ? JSON.stringify([target ?? '', sessionId ?? NEW_THREAD_ATTACHMENT_KEY]) : sessionId ?? NEW_THREAD_ATTACHMENT_KEY
      const attachments = useChatAttachments.getState().getAttachments(key)
      const generation = useOverlayConversationStore.getState().generation
      useOverlayConversationStore.setState(state => ({ handingOff: state.handingOff + 1 }))
      try {
        if (attachments.some(item => item.processing)) throw new Error(t('common:statusPopup.waitAttachments'))
        if (sessionEvents && sessionId && target) await invoke('conversation_update_draft', {
          originWindow: windowSurface, sessionId, draft: input, expectedTargetId: target,
        })
        await invoke('open_main_window')
        await handoffOverlay({ sessionId, targetId: target, runtimeEnabled: runtime.enabled, runtimeEpoch: runtime.runtimeEpoch, draft: input, attachments })
        const current = useThreads.getState()
        const currentRuntime = useRuntimeStore.getState()
        if (current.currentThreadId !== sessionId || current.currentThreadTargetId !== target ||
          currentRuntime.enabled !== runtime.enabled || currentRuntime.runtimeEpoch !== runtime.runtimeEpoch ||
          useOverlayConversationStore.getState().generation !== generation ||
          usePrompt.getState().prompt !== input || useChatAttachments.getState().getAttachments(key) !== attachments) {
          throw new Error(t('common:statusPopup.inputChangedDuringHandoff'))
        }
        await invoke('hide_voice_overlay', { reason: 'handoff' })
      } catch (cause) {
        toast.error(formatRuntimeCommandError(cause))
      } finally {
        useOverlayConversationStore.setState(state => ({ handingOff: state.handingOff - 1 }))
      }
      return
    }
    try {
      await flushDraft()
      await invoke(command)
    } catch (cause) {
      toast.error(formatRuntimeCommandError(cause))
    }
  }

  const selectSession = async (sessionId: string) => {
    try {
      await flushDraft()
      setCurrentThreadId(sessionId)
    } catch (cause) {
      toast.error(formatRuntimeCommandError(cause))
    }
  }

  const togglePinned = () => {
    const nextPinned = !isPinned
    setIsPinned(nextPinned)
    if (isPlatformTauri()) {
      void getCurrentWebviewWindow()
        .setAlwaysOnTop(nextPinned)
        .catch((error) => {
          setIsPinned(!nextPinned)
          console.error('无法设置窗口置顶状态', error)
        })
    }
  }

  return (
    <header
      data-testid="status-popup-header"
      onPointerDown={(event) => {
        if (isVoiceOverlay) startVoiceOverlayDrag(event)
        else startPopupGeometryDrag(event, 'Move')
      }}
      className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 bg-background/95 px-3"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-[11px] font-semibold text-background">
          B
        </div>
        <span className="truncate text-sm font-semibold tracking-tight">BiBit</span>
        {isVoiceOverlay ? (
          // 会话名即窗口标题：点它切换语音输入的发送目标，不再单占一行下拉框。
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                active ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/30'
              }`}
              aria-hidden="true"
            />
            <span className="sr-only">{active ? t('common:statusPopup.running') : ''}</span>
            <VoiceOverlaySessionSwitcher />
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className={`size-1.5 rounded-full ${
                active ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/45'
              }`}
              aria-hidden="true"
            />
            {active ? t('common:statusPopup.running') : mode === 'streaming' ? t('common:statusPopup.streaming') : t('common:statusPopup.pinned')}
          </span>
        )}
      </div>
      {isVoiceOverlay && currentSessionId && <Button variant="ghost" size="sm" onClick={async () => {
        if (useOverlayConversationStore.getState().handingOff > 0 || useVoiceInputStore.getState().pending.length > 0) {
          toast.info(t('common:statusPopup.submitBusy'))
          return
        }
        if (!sessionEvents && overlayHasUnfinishedWork()) {
          toast.info(t('common:statusPopup.pendingWork'))
          return
        }
        const phase = useVoiceInputStore.getState().phase
        if (phase === 'listening' || phase === 'recognizing') {
          useVoiceInputStore.setState({ phase: 'idle' })
          try { await invoke('voice_tool_cancel_current') } catch (cause) {
            toast.error(formatRuntimeCommandError(cause))
            return
          }
        }
        clearOverlayConversation()
        void navigate({ to: '/status-popup', replace: true })
      }}>{t('chat:newConversation')}</Button>}
      {isVoiceOverlay && !currentSessionId && previousSessionId && <Button variant="ghost" size="sm" onClick={async () => {
        if (overlayHasUnfinishedWork()) {
          toast.info(t('common:statusPopup.clearDraftFirst'))
          return
        }
        try {
          if (sessionEvents) {
            const identity = await invoke<{ targetId: string }>('runtime_target_identity')
            if (identity.targetId !== previousTargetId) throw new Error(t('common:statusPopup.runtimeSwitched'))
          }
          useThreads.setState({ currentThreadId: previousSessionId, currentThreadTargetId: previousTargetId })
          usePrompt.setState({ prompt: useOverlayConversationStore.getState().previousDraft ?? '' })
          await navigate({ to: '/threads/$threadId', params: { threadId: previousSessionId } })
        } catch (cause) { toast.error(formatRuntimeCommandError(cause)) }
      }}>{t('common:statusPopup.continueLast')}</Button>}
      {!isVoiceOverlay && sessionEvents && sessions.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('common:statusPopup.selectSession')}
              title={t('common:statusPopup.selectSession')}
            >
              <MessageSquareText className="size-4" />
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {sessions.map((thread) => (
              <DropdownMenuItem
                key={thread.id}
                onSelect={() => void selectSession(thread.id)}
              >
                <span className="truncate">{thread.title}</span>
                {thread.id === currentSessionId ? (
                  <Check className="ml-auto size-4" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={isPinned ? t('common:statusPopup.unpin') : t('common:statusPopup.pinWindow')}
        title={isPinned ? t('common:statusPopup.unpin') : t('common:statusPopup.pinWindow')}
        aria-pressed={isPinned}
        onClick={togglePinned}
      >
        {isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('common:statusPopup.openMainWindow')}
        title={t('common:statusPopup.openMainWindow')}
        onClick={() => void runWindowAction('open_main_window')}
      >
        <ExternalLink className="size-4" />
      </Button>
      {!isVoiceOverlay && <CliHandoffButton sessionId={currentSessionId} />}
      {!isVoiceOverlay ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('common:statusPopup.minimizeQuickChat')}
          title={t('common:statusPopup.minimizeQuickChat')}
          onClick={() => void runWindowAction('minimize_status_popup')}
        >
          <Minus className="size-4" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={isVoiceOverlay ? t('common:statusPopup.closeInputPopup') : t('common:statusPopup.hideQuickChat')}
        title={isVoiceOverlay ? t('common:statusPopup.closeInputPopup') : t('common:statusPopup.hideQuickChat')}
        onClick={() =>
          void (isVoiceOverlay
            ? invoke('hide_voice_overlay')
            : runWindowAction('hide_status_popup'))
        }
      >
        <X className="size-4" />
      </Button>
    </header>
  )
}
