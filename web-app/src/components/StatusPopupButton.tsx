import { invoke } from '@tauri-apps/api/core'
import { MessageSquareText } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { formatRuntimeCommandError } from '@/lib/runtime-contract'
import { currentWindowSurface } from '@/lib/window-surface'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function StatusPopupButton() {
  const { t } = useTranslation()
  const sessionEvents = useRuntimeStore((state) => state.capabilities.sessionEvents)
  const sessionId = useThreads((state) => state.currentThreadId)
  const targetId = useThreads((state) => state.currentThreadTargetId)
  const draft = usePrompt((state) => state.prompt)

  const open = async () => {
    try {
      if (sessionEvents && sessionId && targetId) {
        await invoke('conversation_update_draft', {
          originWindow: currentWindowSurface(),
          sessionId,
          draft,
          expectedTargetId: targetId,
        })
      }
      await invoke('show_status_popup')
    } catch (cause) {
      toast.error(formatRuntimeCommandError(cause))
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t('common:statusPopup.openQuickChat')}
      title={t('common:statusPopup.openQuickChat')}
      onClick={() => void open()}
    >
      <MessageSquareText className="size-4" />
    </Button>
  )
}
