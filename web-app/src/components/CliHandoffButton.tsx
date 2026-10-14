import { invoke } from '@tauri-apps/api/core'
import { SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { formatRuntimeCommandError } from '@/lib/runtime-contract'
import { currentWindowSurface } from '@/lib/window-surface'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function CliHandoffButton({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const currentSessionId = useThreads((state) => state.currentThreadId)
  const targetId = useThreads((state) => state.currentThreadTargetId)
  const runtimeEpoch = useRuntimeStore((state) => state.runtimeEpoch)
  const sessionEvents = useRuntimeStore((state) => state.capabilities.sessionEvents)
  const draft = usePrompt((state) => state.prompt)
  const [busy, setBusy] = useState(false)
  const selectedSessionId = sessionId ?? currentSessionId

  if (!sessionEvents || !selectedSessionId || !targetId || !runtimeEpoch) return null

  const handoff = async () => {
    if (busy) return
    setBusy(true)
    try {
      await invoke('conversation_update_draft', {
        originWindow: currentWindowSurface(),
        sessionId: selectedSessionId,
        draft,
        expectedTargetId: targetId,
      })
      await invoke('runtime_cli_handoff', {
        sessionId: selectedSessionId,
        targetId,
        runtimeEpoch,
        draft,
      })
    } catch (cause) {
      toast.error(formatRuntimeCommandError(cause))
      setBusy(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t('chat:continueInCli')}
      title={t('chat:continueInCli')}
      disabled={busy}
      onClick={() => void handoff()}
    >
      <SquareTerminal className="size-4" />
    </Button>
  )
}
