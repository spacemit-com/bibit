import { emitTo, listen } from '@tauri-apps/api/event'
import type { Attachment } from '@/types/attachment'
import i18n from '@/i18n/setup'

export type OverlayHandoff = {
  id: string
  sessionId?: string
  targetId?: string
  runtimeEnabled: boolean
  runtimeEpoch?: string
  draft: string
  attachments: Attachment[]
}

export async function handoffOverlay(input: Omit<OverlayHandoff, 'id'>) {
  const id = crypto.randomUUID()
  let stop: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      void listen<{ id: string; error?: string }>('voice-overlay-handoff-ack', ({ payload }) => {
        if (payload.id !== id) return
        if (payload.error) reject(new Error(payload.error))
        else resolve()
      }).then(unlisten => {
        stop = unlisten
        timer = setTimeout(() => reject(new Error(i18n.t('chat:overlayHandoffTimeout'))), 5000)
        return emitTo('main', 'voice-overlay-handoff', { ...input, id })
      }).catch(reject)
    })
  } finally {
    stop?.()
    if (timer) clearTimeout(timer)
  }
}
