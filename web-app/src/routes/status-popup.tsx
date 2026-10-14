import { VoiceComposer } from '@/components/VoiceComposer'
import { useEffect } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { MessageSquareText } from 'lucide-react'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useThreads } from '@/hooks/useThreads'
import ChatInput from '@/containers/ChatInput'
import { RuntimeControls } from '@/components/RuntimeControls'
import { route } from '@/constants/routes'
import { useConversationSyncStore } from '@/stores/conversation-sync-store'
import { currentWindowSurface } from '@/lib/window-surface'
import { useTranslation } from '@/i18n/react-i18next-compat'

export const Route = createFileRoute(route.statusPopup)({
  component: StatusPopup,
})

function StatusPopup() {
  const { t } = useTranslation()
  const isVoiceOverlay = currentWindowSurface() === 'voice-overlay'
  const navigate = useNavigate()
  const sessionEvents = useRuntimeStore(state => state.capabilities.sessionEvents)
  const currentThreadId = useThreads(state => state.currentThreadId)
  const legacySessionId = useConversationSyncStore(
    (state) => state.selectedSessionId
  )
  const selectedSessionId = sessionEvents || isVoiceOverlay ? currentThreadId : legacySessionId
  console.info(
    '[status-popup-route] surface=',
    currentWindowSurface(),
    'isVoiceOverlay=',
    isVoiceOverlay,
    'selectedSessionId=',
    selectedSessionId
  )

  useEffect(() => {
    if (!selectedSessionId) return
    void navigate({
      to: route.threadsDetail,
      params: { threadId: selectedSessionId },
      replace: true,
    })
  }, [navigate, selectedSessionId, isVoiceOverlay])

  if (selectedSessionId) return null

  return (
    <div className="flex h-full flex-col justify-end bg-background">
      <div hidden>
        <RuntimeControls />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-6 text-center">
        <div className="grid size-11 place-items-center rounded-full bg-muted/70 text-muted-foreground">
          <MessageSquareText className="size-5" />
        </div>
        <div className="space-y-1">
          <h1 className="text-sm font-semibold tracking-tight">{t('chat:startNewConversation')}</h1>
          <p className="max-w-60 text-xs leading-5 text-muted-foreground">
            {isVoiceOverlay
              ? t('chat:voiceOverlayEmptyHint')
              : t('chat:submitToChatHint')}
          </p>
        </div>
      </div>

      <div className="px-3 pb-3">
        {isVoiceOverlay ? (
          <VoiceComposer><ChatInput surface="overlay" showSpeedToken={false} initialMessage /></VoiceComposer>
        ) : <ChatInput surface="main" showSpeedToken={false} initialMessage />}
      </div>
    </div>
  )
}
