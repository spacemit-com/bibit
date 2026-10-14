import { describe, expect, it } from 'vitest'
import { describeVoiceFeedback } from '@/lib/voice-feedback'

const ready = 'ready' as const
const describe_ = (raw: string, serviceState = ready) =>
  describeVoiceFeedback(null, raw, serviceState)

describe('describeVoiceFeedback', () => {
  it('把服务端错误码换成用户读得懂的一句话', () => {
    expect(describe_('NO_SPEECH')).toMatchObject({
      tone: 'neutral',
      messageKey: 'chat:voiceNoSpeech',
      retryable: false,
      autoHideMs: 2600,
    })
    expect(describe_('QWEN3_ASR_FAILED')).toMatchObject({
      tone: 'error',
      messageKey: 'chat:voiceRecognizeFailed',
      retryable: true,
    })
    expect(describe_('AUDIO_OPEN_FAILED')).toMatchObject({
      tone: 'error',
      messageKey: 'settings:general.voiceMicUnavailable',
    })
  })

  it('码夹在中文前缀里也能认出来，且不把原始文本带进界面', () => {
    const feedback = describe_('语音会话失败: SESSION_MISMATCH')
    expect(feedback).toMatchObject({ messageKey: 'chat:voiceSessionExpired', retryable: true })
    expect(JSON.stringify(feedback)).not.toContain('SESSION_MISMATCH')
  })

  it('未登记的英文平台报错退到通用文案，而不是原样上屏', () => {
    const feedback = describe_('failed to open /dev/snd/pcmC0D0p: No such file or directory')
    expect(feedback).toMatchObject({ tone: 'error', messageKey: 'chat:voiceFailedGeneric' })
    expect(JSON.stringify(feedback)).not.toContain('/dev/snd')
  })

  it('没登记的码不把码和它的中文前缀一起端出去', () => {
    const feedback = describe_('语音会话失败: NEW_FUTURE_CODE')
    expect(feedback).toMatchObject({ tone: 'error', messageKey: 'chat:voiceFailedGeneric' })
    expect(JSON.stringify(feedback)).not.toContain('NEW_FUTURE_CODE')
    expect(JSON.stringify(feedback)).not.toContain('语音会话失败')
  })

  it('连接层失败以服务状态文案呈现，且不出现 os error', () => {
    const feedback = describeVoiceFeedback(null, 'Voice Tool 未连接: 没有那个文件或目录 (os error 2)', 'offline')
    expect(feedback?.messageKey).toBe('settings:general.voiceServiceOffline')
    expect(JSON.stringify(feedback)).not.toContain('os error')
    // 服务状态本身更具体（模型加载中 / 麦克风未就绪）时保留它，别一律说"未连接"。
    expect(describeVoiceFeedback(null, 'Voice Tool 未连接 (os error 2)', 'loading-models')?.messageKey)
      .toBe('settings:general.voiceModelLoading')
  })

  it('我们自己的中文说明原样保留', () => {
    expect(describe_('上一条语音未发送，请重试')).toMatchObject({
      tone: 'error',
      literal: '上一条语音未发送，请重试',
    })
  })

  it('识别成功但发送失败时带上识别原文', () => {
    const feedback = describeVoiceFeedback({ kind: 'send', text: '需要保留的语音' }, 'fetch failed', ready)
    expect(feedback).toMatchObject({
      tone: 'error',
      messageKey: 'chat:voiceInputNotSent',
      params: { text: '需要保留的语音' },
    })
    expect(JSON.stringify(feedback)).not.toContain('fetch failed')
  })

  it('没有失败就没有气泡', () => {
    expect(describeVoiceFeedback(null, '', ready)).toBeNull()
  })
})
