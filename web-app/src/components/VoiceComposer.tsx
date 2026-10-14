import type { ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Keyboard, Square } from 'lucide-react'
import { VoiceBall } from '@/components/VoiceBall'
import { VoiceFeedbackBubble } from '@/components/VoiceFeedbackBubble'
import { Button } from '@/components/ui/button'
import { useOverlayConversationStore } from '@/stores/overlay-conversation-store'
import { useVoiceInputStore } from '@/stores/voice-input-store'
import {
  useVoiceServiceState,
  VOICE_SERVICE_MESSAGE_KEYS,
} from '@/stores/voice-status-store'
import { describeVoiceFeedback } from '@/lib/voice-feedback'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** 两种输入布局共用会话、输入框和小球，不创建另一套聊天。 */
export function VoiceComposer({ children, busy = false, waiting = false, onStop }: {
  children: ReactNode
  busy?: boolean
  waiting?: boolean
  onStop?: () => void
}) {
  const { t } = useTranslation()
  const mode = useVoiceInputStore(state => state.mode)
  const phase = useVoiceInputStore(state => state.phase)
  const error = useVoiceInputStore(state => state.error)
  const failure = useVoiceInputStore(state => state.failure)
  // 定稿交接到会话真正开跑之间有几百毫秒空档，这段也要算思考，
  // 否则球会在"转文本成功→回答开始"之间闪一下空闲态。
  const handingOff = useOverlayConversationStore(state => state.handingOff) > 0
  const listening = phase === 'listening'
  const active = listening || phase === 'recognizing'
  const changeMode = async (next: 'voice' | 'keyboard') => {
    try {
      if (next === 'keyboard') {
        // 原生层选取当前语音会话并验证取消权限。
        useVoiceInputStore.setState({ mode: next, phase: 'idle', failure: null })
        await invoke('voice_tool_cancel_current')
      } else {
        useVoiceInputStore.setState({ mode: next, error: '', failure: null })
        if (active) {
          useVoiceInputStore.setState({ phase: 'idle' })
          await invoke('voice_tool_cancel_current')
        } else {
          await invoke('voice_tool_start_manual_asr')
        }
      }
    } catch (cause) {
      useVoiceInputStore.setState({ phase: 'error', error: String(cause), failure: null })
    }
  }
  // 语音不可用/未就绪时，提示语先说明原因，用户不必先点一次失败。
  const serviceState = useVoiceServiceState()
  let statusText =
    serviceState === 'ready'
      ? t('chat:tapBallToSpeak')
      : t(VOICE_SERVICE_MESSAGE_KEYS[serviceState])
  if (listening) statusText = t('chat:listening')
  else if (phase === 'recognizing') statusText = t('chat:recognizing')
  else if (waiting) statusText = t('chat:waitingForConfirmation')
  else if (busy) statusText = t('chat:running')
  // 失败与状态提示共用同一个位置：失败在哪儿发生，提示就出现在哪儿。
  // 旧录音的交接失败会在新一轮录音进行中保留显示（只保存事实，不改当前状态）。
  const feedback =
    failure || phase === 'error' ? describeVoiceFeedback(failure, error, serviceState) : null
  const dismissFeedback = () =>
    useVoiceInputStore.setState({ phase: 'idle', error: '', failure: null })
  const bubble = feedback ? (
    <VoiceFeedbackBubble feedback={feedback} onRetry={() => void changeMode('voice')} onDismiss={dismissFeedback} />
  ) : null
  const ball = (
    <VoiceBall embedded mode={listening ? 'listening' : phase === 'recognizing' || handingOff || (busy && !waiting) ? 'thinking' : 'idle'}
      label={active ? t('chat:stopRecording') : t('chat:startVoiceInput')} onActivate={() => void changeMode('voice')} />
  )
  return (
    <div data-testid="voice-composer" data-input-mode={mode}>
      {/* 气泡长高只会吃掉上方的会话内容：球与输入框贴底不动，出现/消失都不跳。
          只按当前布局渲染一次，两种布局各留一份会让同一句话在 DOM 里出现两次。 */}
      {mode === 'keyboard' && bubble && <div className="mb-2 flex justify-center">{bubble}</div>}
      <div className={mode === 'keyboard' ? 'flex items-end gap-3' : 'hidden'} aria-hidden={mode !== 'keyboard'}>
        <div className="min-w-0 flex-1">{children}</div>
        {mode === 'keyboard' && <div className="mb-2 size-10 shrink-0">{ball}</div>}
      </div>
      {mode === 'voice' && (
        <div className="flex flex-col items-center gap-2 py-3">
          {bubble && <div className="flex w-full justify-center px-1">{bubble}</div>}
          <div className="grid grid-cols-[40px_72px_40px] items-center justify-items-center gap-3">
            <div>{busy && onStop && <Button size="icon-lg" variant="ghost" aria-label={t('chat:stopRunning')} onClick={onStop}><Square className="size-[18px]" /></Button>}</div>
            <div className="size-[72px]">{ball}</div>
            <Button size="icon-lg" variant="ghost" aria-label={t('chat:switchToKeyboard')} onClick={() => void changeMode('keyboard')}><Keyboard className="size-[18px]" /></Button>
          </div>
          {/* 有气泡时这行只当副标题：让读屏只播报一条，别把两句话叠在一起。 */}
          <p {...(bubble ? {} : { role: 'status' as const })} className="text-xs text-muted-foreground">{statusText}</p>
        </div>
      )}
    </div>
  )
}
