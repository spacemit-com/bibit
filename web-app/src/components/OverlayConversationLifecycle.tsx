import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useNavigate } from '@tanstack/react-router'
import { useVoiceInputStore } from '@/stores/voice-input-store'
import { clearOverlayConversation, overlayHasUnfinishedWork } from '@/stores/overlay-conversation-store'

export function OverlayConversationLifecycle() {
  const navigate = useNavigate()
  useEffect(() => {
    let disposed = false
    const cleanups: Array<() => void> = []
    const register = async () => {
      for (const [name, callback] of [
        ['voice-overlay-dismissed', () => {
          if (overlayHasUnfinishedWork()) return
          clearOverlayConversation()
          void navigate({ to: '/status-popup', replace: true })
        }],
        ['voice-overlay-opened', ({ payload }: { payload: { mode?: string } }) => {
          if (payload?.mode === 'keyboard') {
            const phase = useVoiceInputStore.getState().phase
            useVoiceInputStore.setState({ mode: 'keyboard', phase: 'idle' })
            if (phase === 'listening' || phase === 'recognizing') {
              void invoke('voice_tool_cancel_current').catch(cause => useVoiceInputStore.setState({ phase: 'error', error: String(cause) }))
            }
          }
          else if (payload?.mode === 'voice') useVoiceInputStore.setState({ mode: 'voice' })
        }],
      ] as const) {
        const cleanup = await listen(name, callback)
        if (disposed) cleanup()
        else cleanups.push(cleanup)
      }
    }
    void register().catch(console.error)
    return () => { disposed = true; cleanups.forEach(cleanup => cleanup()) }
  }, [navigate])
  return null
}
