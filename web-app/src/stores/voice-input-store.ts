import { create } from 'zustand'

export type VoiceInput = {
  id: string
  sessionId: string
  targetId?: string
  runtimeEpoch?: string
  windowGeneration?: number
  text: string
}

/**
 * `error` 保留原始诊断文本（只进日志），界面文案由 `lib/voice-feedback.ts` 投影。
 * 这一条只在"识别到了但没发出去"时出现：那种失败必须带上识别原文——用户说过的
 * 话不能因为一次发送失败就消失。
 */
export type VoiceInputFailure = { kind: 'send'; text: string }

type VoiceInputState = {
  mode: 'voice' | 'keyboard'
  phase: 'idle' | 'listening' | 'recognizing' | 'error'
  error: string
  failure: VoiceInputFailure | null
  pending: VoiceInput[]
  readyId?: string
}

export const useVoiceInputStore = create<VoiceInputState>(() => ({
  mode: 'voice',
  phase: 'idle',
  error: '',
  failure: null,
  pending: [],
  readyId: undefined,
}))
