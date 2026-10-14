import {
  isVoiceTransportError,
  VOICE_SERVICE_MESSAGE_KEYS,
  voiceServiceMessageState,
  type VoiceServiceState,
} from '@/stores/voice-status-store'
import type { VoiceInputFailure } from '@/stores/voice-input-store'

export type VoiceFeedbackTone = 'neutral' | 'error'

export type VoiceFeedback = {
  tone: VoiceFeedbackTone
  /** 要显示的一句话：给了 literal 就直接用它（我们自己写的中文说明），否则用 messageKey 走 i18n。 */
  literal?: string
  /** i18n key，已含命名空间前缀。 */
  messageKey?: string
  params?: Record<string, string>
  /** 是否给「重新录音」这个动作。 */
  retryable: boolean
  /** 无故障的中性提示自动收起的毫秒数；undefined = 留到下一次录音或状态改变。 */
  autoHideMs?: number
}

/**
 * 语音服务真实的失败码 → 用户读得懂的一句话。
 *
 * 码来自 `bibit-voice` 的 pipeline/main 广播（见 `src/audio/pipeline.cpp`），
 * 浮窗以前把它们原样显示成 `NO_SPEECH`、`QWEN3_ASR_FAILED` 这类词。
 * 文案能复用设置页已有的就复用，只有语音识别路径特有的才新增。
 */
type CodeFeedback = Omit<VoiceFeedback, 'params' | 'literal'>

const CODE_FEEDBACK: Record<string, CodeFeedback> = {
  // 没说话/说得太短：这是最常见的一次正常操作，不该按故障报警。
  NO_SPEECH: {
    tone: 'neutral',
    messageKey: 'chat:voiceNoSpeech',
    retryable: false,
    autoHideMs: 2600,
  },
  AUDIO_OPEN_FAILED: {
    tone: 'error',
    messageKey: 'settings:general.voiceMicUnavailable',
    retryable: true,
  },
  ASR_DISABLED: {
    tone: 'error',
    messageKey: 'chat:voiceAsrDisabled',
    retryable: false,
  },
  ASR_NOT_LOADED: {
    tone: 'error',
    messageKey: 'chat:voiceModelNotReady',
    retryable: true,
  },
  ASR_INIT_FAILED: {
    tone: 'error',
    messageKey: 'settings:general.voiceSwitchInitFailed',
    retryable: true,
  },
  ASR_MODEL_FILES_MISSING: {
    tone: 'error',
    messageKey: 'chat:voiceModelIncomplete',
    retryable: false,
  },
  UNSUPPORTED_ASR_MODEL: {
    tone: 'error',
    messageKey: 'chat:voiceModelIncomplete',
    retryable: false,
  },
  ASR_MODEL_SWITCH_BUSY: {
    tone: 'error',
    messageKey: 'chat:voiceSwitchBusy',
    retryable: true,
  },
  ASR_MODEL_SWITCH_FAILED: {
    tone: 'error',
    messageKey: 'chat:voiceModelNotReady',
    retryable: true,
  },
  ASR_MODEL_PERSIST_FAILED: {
    tone: 'error',
    messageKey: 'settings:general.voiceSwitchPersistFailed',
    retryable: false,
  },
  THRESHOLD_APPLY_FAILED: {
    tone: 'error',
    messageKey: 'settings:general.voiceSwitchPersistFailed',
    retryable: false,
  },
  SESSION_MISMATCH: {
    tone: 'error',
    messageKey: 'chat:voiceSessionExpired',
    retryable: true,
  },
  ASR_STREAM_CREATE_FAILED: {
    tone: 'error',
    messageKey: 'chat:voiceRecognizeFailed',
    retryable: true,
  },
  ASR_STREAM_MISSING: {
    tone: 'error',
    messageKey: 'chat:voiceRecognizeFailed',
    retryable: true,
  },
  QWEN3_ASR_FAILED: {
    tone: 'error',
    messageKey: 'chat:voiceRecognizeFailed',
    retryable: true,
  },
}

/**
 * 服务端会把码夹在前缀里（`语音命令失败: SESSION_MISMATCH`）。取第一个「大写 + 下划线」
 * 形态的词：要求至少一段下划线，免得把 `Failed to fetch` 这类普通英文当成错误码。
 */
const CODE_PATTERN = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/

/** 我们自己写的中文说明（例如"上一条语音未发送，请重试"）保留原文；平台报错一律换成通用文案。 */
const CJK_PATTERN = /[\u4e00-\u9fff]/

export function voiceFeedbackFromCode(code: string): VoiceFeedback | null {
  const feedback = CODE_FEEDBACK[code]
  return feedback ? { ...feedback } : null
}

/**
 * 浮窗与输入区共用的失败投影：把结构化失败（或原始诊断文本）变成一句用户能懂的话。
 *
 * 判定顺序：结构化"发送失败" → 连接层不可用 → 服务端错误码 → 我们自己的中文说明 →
 * 兜底通用文案。原始文本永远不进入界面，只留在日志里。
 */
export function describeVoiceFeedback(
  failure: VoiceInputFailure | null | undefined,
  rawError: string,
  serviceState: VoiceServiceState
): VoiceFeedback | null {
  if (failure?.kind === 'send') {
    return {
      tone: 'error',
      messageKey: 'chat:voiceInputNotSent',
      params: { text: failure.text },
      retryable: true,
    }
  }

  const raw = rawError
  if (!raw) return null

  // 连接层失败先于状态：服务挂掉后不会再推状态，store 里可能仍是上一次的 ready。
  if (isVoiceTransportError(raw)) {
    return {
      tone: 'error',
      messageKey: VOICE_SERVICE_MESSAGE_KEYS[voiceServiceMessageState(serviceState, raw)],
      retryable: false,
    }
  }

  const code = CODE_PATTERN.exec(raw)?.[1]
  if (code) {
    // 认得出"码"的形状就走码这条路：表里没有（服务端新加的码）宁可给通用文案，
    // 也不要把码连同它旁边的原始文本一起显示出去。
    return voiceFeedbackFromCode(code) ?? {
      tone: 'error',
      messageKey: 'chat:voiceFailedGeneric',
      retryable: true,
    }
  }

  // 我们自己写的中文说明（"上一条语音未发送，请重试"）比一句通用文案有用，原样保留。
  if (CJK_PATTERN.test(raw)) {
    return { tone: 'error', literal: raw, retryable: true }
  }

  return { tone: 'error', messageKey: 'chat:voiceFailedGeneric', retryable: true }
}
