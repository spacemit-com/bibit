import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useVoiceInputStore } from '@/stores/voice-input-store'
import i18n from '@/i18n/setup'

// 每个识别结果仅自动尝试一次；失败由现有聊天输入回执/重试界面处理。
const attempted = new Set<string>()
export function useVoiceSubmission(sessionId: string, ready: boolean, submit: (text: string, id: string) => Promise<unknown>) {
  const pending = useVoiceInputStore(state => state.pending)
  const readyId = useVoiceInputStore(state => state.readyId)
  useEffect(() => {
    if (!ready) return
    const input = pending.find(item => item.sessionId === sessionId)
    if (!input || readyId !== input.id || attempted.has(input.id)) return
    attempted.add(input.id)
    // ponytail: 保留最近 256 次自动尝试，覆盖原生层 128 条回放；持久恢复由发送回执负责。
    if (attempted.size > 256) attempted.delete(attempted.values().next().value!)
    void (async () => {
      if (input.targetId) {
        const identity = await invoke<{ targetId: string; runtimeEpoch?: string }>('runtime_target_identity')
        if (identity.targetId !== input.targetId || identity.runtimeEpoch !== input.runtimeEpoch) {
          throw new Error(i18n.t('chat:runtimeTargetChanged'))
        }
      }
      await submit(input.text, input.id)
    })().catch(cause => {
      console.error('语音发送失败', cause)
      useVoiceInputStore.setState(state => ({
        ...(state.phase === 'listening' || state.phase === 'recognizing' ? {} : { mode: 'keyboard' as const, phase: 'error' as const }),
        error: cause instanceof Error ? cause.message : String(cause),
        failure: { kind: 'send', text: input.text },
      }))
    }).finally(() => {
      useVoiceInputStore.setState(state => ({ pending: state.pending.filter(item => item.id !== input.id) }))
    })
  }, [pending, readyId, ready, sessionId, submit])
}
