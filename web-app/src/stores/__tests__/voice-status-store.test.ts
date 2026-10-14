import { describe, expect, it } from 'vitest'
import {
  applyVoiceEvent,
  beginSwitchIntent,
  beginVoiceSwitch,
  isVoiceTransportError,
  noteVoiceSwitchTimeout,
  projectVoiceServiceState,
  SWITCH_TIMEOUT_MS,
  useVoiceStatusStore,
  type VoiceStatus,
  voiceServiceMessageState,
} from '@/stores/voice-status-store'

const ready: VoiceStatus = {
  wake: true,
  asr: true,
  audio_ready: true,
  kws_loaded: true,
  asr_loaded: true,
  asr_model_type: 'qwen3_asr_0.6b',
  mode: 'idle',
}

describe('projectVoiceServiceState', () => {
  it('treats a failed probe as offline even before any status arrives', () => {
    expect(projectVoiceServiceState({ status: null, offline: true })).toBe('offline')
  })

  it('reports connecting until the first status arrives', () => {
    expect(projectVoiceServiceState({ status: null, offline: false })).toBe('connecting')
  })

  it('reports loading models while KWS or ASR is not loaded', () => {
    expect(
      projectVoiceServiceState({ status: { ...ready, kws_loaded: false }, offline: false })
    ).toBe('loading-models')
    expect(
      projectVoiceServiceState({ status: { ...ready, asr_loaded: false }, offline: false })
    ).toBe('loading-models')
  })

  it('reports microphone trouble once models are loaded but audio is not ready', () => {
    expect(
      projectVoiceServiceState({ status: { ...ready, audio_ready: false }, offline: false })
    ).toBe('mic-unavailable')
  })

  it('reports ready only when models are loaded and audio is ready', () => {
    expect(projectVoiceServiceState({ status: ready, offline: false })).toBe('ready')
  })

  it('reports a disabled recognizer instead of a loading model', () => {
    // 用户主动关闭识别时能力确实不可用，不能显示成「模型加载中」。
    expect(
      projectVoiceServiceState({ status: { ...ready, asr: false }, offline: false })
    ).toBe('asr-disabled')
  })
})

describe('isVoiceTransportError', () => {
  it('recognizes connection-level failures', () => {
    for (const message of [
      'Voice Tool 未连接: 没有那个文件或目录 (os error 2)',
      '语音 Socket 目录不可用: No such file or directory (os error 2)',
      '语音命令失败: SERVICE_OFFLINE',
      'Connection refused (os error 111)',
      '语音服务连接中断',
    ]) {
      expect(isVoiceTransportError(message), message).toBe(true)
    }
  })

  it('leaves session-level failures alone', () => {
    for (const message of [
      '上一条语音未发送，请重试',
      '语音会话已过期',
      'Runtime 目标已改变，请重新录音',
    ]) {
      expect(isVoiceTransportError(message), message).toBe(false)
    }
  })
})

describe('voiceServiceMessageState', () => {
  it('treats a transport error as offline even when the stored state is stale', () => {
    const stale = 'ready' as const
    expect(voiceServiceMessageState(stale, 'Voice Tool 未连接: 连接被拒绝 (os error 111)')).toBe(
      'offline'
    )
    expect(voiceServiceMessageState('connecting', '语音命令失败: SERVICE_OFFLINE')).toBe('offline')
  })

  it('keeps a more specific degradation when the service reports one', () => {
    expect(voiceServiceMessageState('loading-models', '语音命令失败: SERVICE_OFFLINE')).toBe(
      'loading-models'
    )
    expect(voiceServiceMessageState('mic-unavailable', '语音命令失败: SERVICE_OFFLINE')).toBe(
      'mic-unavailable'
    )
  })

  it('leaves session-level errors to the stored state', () => {
    expect(voiceServiceMessageState('ready', '语音会话已过期')).toBe('ready')
  })
})

const resetSwitch = () =>
  useVoiceStatusStore.setState({ status: ready, offline: false, switching: null, switchError: null })

describe('switch intent bookkeeping', () => {
  it('clears a stale failure alert when a new intent starts', () => {
    useVoiceStatusStore.setState({
      switchIntent: null,
      switchError: { code: 'SWITCH_PERSIST_FAILED', detail: 'disk full' },
    })
    beginSwitchIntent('asr', false, 'sw-1')
    expect(useVoiceStatusStore.getState().switchError).toBeNull()
  })

  it('keeps an in-flight engine switch when a switch-only error arrives', () => {
    useVoiceStatusStore.setState({
      switching: { kind: 'asr_model', target: 'qwen3_asr_0.6b', startedAt: Date.now() },
      switchError: null,
    })
    applyVoiceEvent({ event: 'error', code: 'AUDIO_OPEN_FAILED', message: 'mic busy' })
    const state = useVoiceStatusStore.getState()
    // 开关类失败不该熄掉引擎切换的转圈：两条链路互不干扰。
    expect(state.switching).not.toBeNull()
    expect(state.switchError?.code).toBe('AUDIO_OPEN_FAILED')
  })
})

describe('recognition engine switching', () => {
  it('adopts the server snapshot as the in-flight switch and keeps the effective engine', () => {
    resetSwitch()
    applyVoiceEvent({
      event: 'status',
      ...ready,
      switching: {
        kind: 'asr_model',
        from: 'qwen3_asr_0.6b',
        to: 'sensevoice',
        request_id: 'sw-1',
        elapsed_ms: 800,
      },
    })
    const state = useVoiceStatusStore.getState()
    expect(state.switching?.target).toBe('sensevoice')
    // 快照里的生效引擎仍是旧引擎：界面不允许提前把目标引擎当成已生效。
    expect(state.status?.asr_model_type).toBe('qwen3_asr_0.6b')
    // 超时窗口按服务端 elapsed_ms 对齐，重复快照不会延长等待。
    expect(state.switching!.startedAt).toBeLessThanOrEqual(Date.now() - 799)
    expect(state.switching!.startedAt).toBeGreaterThanOrEqual(Date.now() - 800 - SWITCH_TIMEOUT_MS)
  })

  it('takes the optimistic switch from the click and clears it on completion', () => {
    resetSwitch()
    beginVoiceSwitch('sensevoice')
    expect(useVoiceStatusStore.getState().switching?.target).toBe('sensevoice')
    applyVoiceEvent({ event: 'model_switched', from: 'qwen3_asr_0.6b', to: 'sensevoice', duration_ms: 6900 })
    const state = useVoiceStatusStore.getState()
    expect(state.switching).toBeNull()
    expect(state.switchError).toBeNull()
    expect(state.status?.asr_model_type).toBe('sensevoice')
  })

  it('treats a busy rejection as in-flight, and a real failure as an alert', () => {
    resetSwitch()
    beginVoiceSwitch('qwen3_asr_0.6b')
    applyVoiceEvent({
      event: 'error',
      code: 'ASR_MODEL_SWITCH_BUSY',
      switching: { kind: 'asr_model', from: 'sensevoice', to: 'qwen3_asr_0.6b', elapsed_ms: 20 },
    })
    expect(useVoiceStatusStore.getState().switchError).toBeNull()
    expect(useVoiceStatusStore.getState().switching?.target).toBe('qwen3_asr_0.6b')

    applyVoiceEvent({ event: 'error', code: 'ASR_MODEL_FILES_MISSING', message: 'missing' })
    const failed = useVoiceStatusStore.getState()
    expect(failed.switching).toBeNull()
    expect(failed.switchError).toEqual({ code: 'ASR_MODEL_FILES_MISSING', detail: 'missing' })
  })

  it('ignores session-level errors and keeps a failure alert across status broadcasts', () => {
    resetSwitch()
    applyVoiceEvent({ event: 'error', code: 'SESSION_MISMATCH' })
    expect(useVoiceStatusStore.getState().switchError).toBeNull()

    applyVoiceEvent({ event: 'error', code: 'ASR_MODEL_SWITCH_FAILED', message: 'boom' })
    // 服务端在失败后还会广播一次状态快照，告警不能被它顺手清掉。
    applyVoiceEvent({ event: 'status', ...ready, switching: null })
    expect(useVoiceStatusStore.getState().switchError?.code).toBe('ASR_MODEL_SWITCH_FAILED')
  })

  it('turns an unconfirmed switch into an alert instead of spinning forever', () => {
    resetSwitch()
    beginVoiceSwitch('sensevoice')
    noteVoiceSwitchTimeout()
    const state = useVoiceStatusStore.getState()
    expect(state.switching).toBeNull()
    expect(state.switchError?.code).toBe('SWITCH_UNCONFIRMED')
  })

  it('keeps the unconfirmed alert when the reconcile still reports that switch', () => {
    resetSwitch()
    applyVoiceEvent({
      event: 'model_switching',
      from: 'qwen3_asr_0.6b',
      to: 'sensevoice',
      request_id: 'sw-2',
    })
    noteVoiceSwitchTimeout()
    // 对账读回来的快照说这次切换还在进行（elapsed_ms 已经超过 75s 窗口）。
    // 若把它当权威重新置回「切换中」，剩余时间会按 elapsed_ms 立刻算成 0，
    // 于是每次对账都再触发一次超时 —— 变成轮询，而不是「只读一次」。
    applyVoiceEvent({
      event: 'status',
      ...ready,
      switching: {
        kind: 'asr_model',
        from: 'qwen3_asr_0.6b',
        to: 'sensevoice',
        request_id: 'sw-2',
        elapsed_ms: 75_500,
      },
    })
    const state = useVoiceStatusStore.getState()
    expect(state.switching).toBeNull()
    expect(state.switchError?.code).toBe('SWITCH_UNCONFIRMED')
  })

  it('shows a later attempt again after one was declared unconfirmed', () => {
    resetSwitch()
    beginVoiceSwitch('sensevoice')
    noteVoiceSwitchTimeout()
    applyVoiceEvent({
      event: 'status',
      ...ready,
      switching: {
        kind: 'asr_model',
        from: 'qwen3_asr_0.6b',
        to: 'sensevoice',
        request_id: 'sw-2',
        elapsed_ms: 75_500,
      },
    })
    expect(useVoiceStatusStore.getState().switching).toBeNull()
    // 换一个目标就是新的一次切换：照常进入「切换中」。
    applyVoiceEvent({
      event: 'status',
      ...ready,
      switching: {
        kind: 'asr_model',
        from: 'sensevoice',
        to: 'qwen3_asr_0.6b',
        request_id: 'sw-3',
        elapsed_ms: 400,
      },
    })
    expect(useVoiceStatusStore.getState().switching?.target).toBe('qwen3_asr_0.6b')
    expect(useVoiceStatusStore.getState().switchError).toBeNull()
  })

  it('falls back to the target engine match when an older service omits the snapshot', () => {
    resetSwitch()
    beginVoiceSwitch('sensevoice')
    // 旧版服务的快照里没有 switching 字段。
    applyVoiceEvent({ event: 'status', ...ready })
    expect(useVoiceStatusStore.getState().switching?.target).toBe('sensevoice')
    applyVoiceEvent({ event: 'status', ...ready, asr_model_type: 'sensevoice' })
    expect(useVoiceStatusStore.getState().switching).toBeNull()
  })
})
