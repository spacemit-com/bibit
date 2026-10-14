import { create } from 'zustand'

export type VoiceStatus = {
  wake: boolean
  asr: boolean
  audio_ready: boolean
  kws_loaded: boolean
  asr_loaded: boolean
  asr_model_type: string
  mode: string
  /** 服务端在途的能力变更（识别引擎切换 / 打开识别），见 bibit-voice/docs/protocol.md 4.3。 */
  switching?: VoiceSwitchSnapshot | null
  /** 服务端给出的未达成意图（本次改造新增）。 */
  desired?: { asr_model_type: string; pending: boolean } | null
  /** 能力位：服务端接受省略 wake/asr 的字段级提交（见 bibit-voice/docs/protocol.md §4.4）。 */
  partial_switches?: boolean
  /** 能力位：在途切换时提交的新目标会被记录并在提交点后收敛。 */
  queued_model_switch?: boolean
}

export type VoiceServiceState =
  | 'connecting'
  | 'offline'
  | 'asr-disabled'
  | 'loading-models'
  | 'mic-unavailable'
  | 'ready'

/** 服务端切换快照：`to` 是目标引擎，`status.asr_model_type` 始终是生效引擎。 */
export type VoiceSwitchSnapshot = {
  kind: string
  from: string
  to: string
  request_id?: string
  elapsed_ms?: number
}

/** 在途切换：可能来自服务端快照，也可能是点击后的乐观置位。 */
export type VoiceInflightSwitch = {
  kind: string
  target: string
  requestId?: string
  /** 以服务端 elapsed_ms 对齐的开始时刻，重复快照不会延长超时窗口。 */
  startedAt: number
}

export type VoiceSwitchError = { code: string; detail: string }

/**
 * 开关意图：点击后立即呈现的值，按字段独立保存，收到生效快照或结果回执后收敛。
 * 两个开关各自持有在途意图，互不覆盖。
 */
export type VoiceSwitchIntent = {
  wake?: { value: boolean; requestId: string }
  asr?: { value: boolean; requestId: string }
  startedAt: number
}

export type VoiceStatusState = {
  status: VoiceStatus | null
  offline: boolean
  switching: VoiceInflightSwitch | null
  switchError: VoiceSwitchError | null
  switchIntent: VoiceSwitchIntent | null
  /**
   * 已经判过超时、正在等服务端给终态的切换目标。这一轮的后续快照不再把界面拉回
   * 「切换中」：75s 窗口按 elapsed_ms 算出来已经是 0，拉回去就等于每轮对账都再触发
   * 一次超时。换目标或用户重新点击开新一轮时清空。
   */
  unconfirmedSwitchTarget: string | null
}

export const useVoiceStatusStore = create<VoiceStatusState>(() => ({
  status: null,
  offline: false,
  switching: null,
  switchError: null,
  switchIntent: null,
  unconfirmedSwitchTarget: null,
}))

/** 切换超时上限：服务端 qwen3 启动超时 60s + 15s 余量（有界乐观，不做轮询）。 */
export const SWITCH_TIMEOUT_MS = 75_000

/** 只有这些错误属于「识别引擎」的范畴，才在设置页提示；会话/解码类错误另有归属。 */
export const SWITCH_ERROR_CODES = [
  'ASR_MODEL_SWITCH_FAILED',
  'ASR_MODEL_FILES_MISSING',
  'ASR_MODEL_PERSIST_FAILED',
  'ASR_INIT_FAILED',
  'UNSUPPORTED_ASR_MODEL',
  'SWITCH_UNCONFIRMED',
  // 开关路径本身的失败：用户需要知道「开关生效了但没保存」或「麦克风没起来」。
  'SWITCH_PERSIST_FAILED',
  'AUDIO_OPEN_FAILED',
] as const

/** 只由开关命令触发的错误：不能拿它去熄掉引擎切换的在途状态，那是另一条链路。 */
export const SWITCH_ONLY_ERROR_CODES = [
  'SWITCH_PERSIST_FAILED',
  'AUDIO_OPEN_FAILED',
] as const

/** 开关意图的兜底窗口：服务端丢弃或回 BAD_COMMAND 时，界面不能永远停在「正在应用」。 */
export const SWITCH_INTENT_TIMEOUT_MS = 15_000

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function inflightFromSnapshot(snapshot: VoiceSwitchSnapshot): VoiceInflightSwitch | null {
  if (!snapshot.to) return null
  return {
    kind: snapshot.kind || 'asr_model',
    target: snapshot.to,
    requestId: snapshot.request_id,
    startedAt: Date.now() - Number(snapshot.elapsed_ms || 0),
  }
}

export function recordVoiceStatus(payload: VoiceStatus) {
  useVoiceStatusStore.setState((state) => {
    const hasSwitchField = 'switching' in payload
    const inflight = payload.switching ? inflightFromSnapshot(payload.switching) : null
    // 这一轮已经判过超时：仍以服务端快照为权威，但不重新进入「切换中」等待。
    if (inflight && inflight.target === state.unconfirmedSwitchTarget) {
      return { status: payload, offline: false }
    }
    // 服务端快照是在途切换的权威来源，顺带清掉上一次的失败提示。
    if (inflight) {
      return { status: payload, offline: false, switching: inflight, switchError: null }
    }
    if (hasSwitchField) {
      return { status: payload, offline: false, switching: null, unconfirmedSwitchTarget: null }
    }
    // 旧版服务没有 switching 字段：只有快照里已经是目标引擎才算切换完成。
    if (state.switching && payload.asr_model_type === state.switching.target) {
      return {
        status: payload,
        offline: false,
        switching: null,
        switchError: null,
        unconfirmedSwitchTarget: null,
      }
    }
    return { status: payload, offline: false }
  })
}

export function recordVoiceStatusUnavailable() {
  useVoiceStatusStore.setState({ status: null, offline: true })
}

/** 点击后的乐观置位：不等毫秒级的 invoke 返回就先呈现「正在切换到 X」。 */
export function beginVoiceSwitch(target: string) {
  useVoiceStatusStore.setState({
    switching: { kind: 'asr_model', target, startedAt: Date.now() },
    switchError: null,
    unconfirmedSwitchTarget: null,
  })
}

/** 开关点击后的乐观置位：界面立即显示用户意图值，收到生效快照后收敛。 */
export function beginSwitchIntent(
  field: 'wake' | 'asr',
  value: boolean,
  requestId: string
) {
  useVoiceStatusStore.setState((state) => ({
    switchIntent: {
      ...(state.switchIntent ?? {}),
      [field]: { value, requestId },
      startedAt: Date.now(),
    },
    // 新的开关意图开始：上一次的失败提示已经过期，别让它继续挂在横幅上。
    switchError: null,
  }))
}

/** 提交失败时回退该字段的乐观态，让控件回到真实生效值。 */
export function clearSwitchIntent(field: 'wake' | 'asr') {
  useVoiceStatusStore.setState((state) => {
    if (!state.switchIntent?.[field]) return {}
    const next = { ...state.switchIntent }
    delete next[field]
    return { switchIntent: next.wake || next.asr ? next : null }
  })
}

/** 超时兜底：清掉所有未确认的开关意图，让界面回到服务端快照。 */
export function clearSwitchIntents() {
  useVoiceStatusStore.setState({ switchIntent: null })
}

/** 生效快照确认意图已经落地：只清掉被确认的字段，未确认的继续显示意图值。 */
export function settleSwitchIntent(status: { wake: boolean; asr: boolean }) {
  useVoiceStatusStore.setState((state) => {
    const intent = state.switchIntent
    if (!intent) return {}
    const next = { ...intent }
    if (next.wake && status.wake === next.wake.value) delete next.wake
    if (next.asr && status.asr === next.asr.value) delete next.asr
    return { switchIntent: next.wake || next.asr ? next : null }
  })
}

/** 超时且对账也没能确认：转成「未确认」提示，不永久转圈。 */
export function noteVoiceSwitchTimeout() {
  useVoiceStatusStore.setState((state) =>
    state.switching
      ? {
          switching: null,
          switchError: { code: 'SWITCH_UNCONFIRMED', detail: '' },
          unconfirmedSwitchTarget: state.switching.target,
        }
      : {}
  )
}

/**
 * `voice-tool-event` 的单一归约点：状态快照、切换事件与切换失败都从这里进 store。
 * 视图不再各自监听，避免同一次切换在两处各记一半状态。
 */
export function applyVoiceEvent(event: Record<string, unknown>) {
  switch (text(event.event)) {
    case 'status':
    case 'ready':
      recordVoiceStatus(event as unknown as VoiceStatus)
      settleSwitchIntent(event as unknown as VoiceStatus)
      return
    case 'switches_applied':
      // 结果回执带全量 wake/asr：直接落到快照上，界面不会在回执与下一次广播之间闪回。
      useVoiceStatusStore.setState((state) => {
        const wake = event['wake']
        const asr = event['asr']
        const status =
          state.status && typeof wake === 'boolean' && typeof asr === 'boolean'
            ? { ...state.status, wake, asr }
            : state.status
        const intent = state.switchIntent
        if (!intent) return { status }
        // 回执不带 request_id（旧服务端）：无法归属，整体收敛兜底。
        const appliedId = text(event['request_id'])
        if (!appliedId) return { status, switchIntent: null }
        // 只清这次回执真正对应的字段意图：别的窗口或 CLI 触发的回执不能动本窗口的在途意图，
        // 否则界面会先被别人的值带偏一拍、再跳回自己的值。
        const next = { ...intent }
        if (next.wake?.requestId === appliedId) delete next.wake
        if (next.asr?.requestId === appliedId) delete next.asr
        return { status, switchIntent: next.wake || next.asr ? next : null }
      })
      return
    case 'model_switching':
      useVoiceStatusStore.setState({
        switching: {
          kind: 'asr_model',
          target: text(event.to) || text(event.model),
          requestId: text(event.request_id) || undefined,
          startedAt: Date.now(),
        },
        switchError: null,
        unconfirmedSwitchTarget: null,
      })
      return
    case 'model_switched': {
      const applied = text(event.to) || text(event.model)
      useVoiceStatusStore.setState((state) => ({
        status:
          state.status && applied && state.status.asr_model_type !== applied
            ? { ...state.status, asr_model_type: applied, asr_loaded: true, switching: null }
            : state.status,
        switching: null,
        switchError: null,
        offline: false,
        unconfirmedSwitchTarget: null,
      }))
      return
    }
    case 'error': {
      const code = text(event.code)
      // 忙碌不是失败：按服务端给的快照校正乐观状态；没有快照就不改口。
      if (code === 'ASR_MODEL_SWITCH_BUSY') {
        const snapshot = (event.switching ?? null) as VoiceSwitchSnapshot | null
        const inflight = snapshot ? inflightFromSnapshot(snapshot) : null
        if (inflight) {
          useVoiceStatusStore.setState({
            switching: inflight,
            switchError: null,
            unconfirmedSwitchTarget: null,
          })
        }
        return
      }
      if (!(SWITCH_ERROR_CODES as readonly string[]).includes(code)) return
      const clearsSwitching = !(SWITCH_ONLY_ERROR_CODES as readonly string[]).includes(code)
      useVoiceStatusStore.setState((state) => ({
        switching: clearsSwitching ? null : state.switching,
        switchError: { code, detail: text(event.message) },
        unconfirmedSwitchTarget: clearsSwitching ? null : state.unconfirmedSwitchTarget,
      }))
      return
    }
    default:
      return
  }
}

/**
 * 语音可用性只在这一处判定。设置页、浮窗与输入区都消费同一个投影，
 * 避免同一台机器在两处给出互相矛盾的说法。
 */
export function projectVoiceServiceState(state: VoiceStatusState): VoiceServiceState {
  if (state.offline) return 'offline'
  if (!state.status) return 'connecting'
  // 用户主动关闭识别：能力就是不可用，不能显示成「模型加载中」。
  if (!state.status.asr) return 'asr-disabled'
  if (!state.status.kws_loaded || !state.status.asr_loaded) return 'loading-models'
  if (state.status.audio_ready) return 'ready'
  return 'mic-unavailable'
}

export const VOICE_SERVICE_MESSAGE_KEYS: Record<VoiceServiceState, string> = {
  connecting: 'settings:general.voiceServiceLoading',
  offline: 'settings:general.voiceServiceOffline',
  'asr-disabled': 'settings:general.voiceAsrDisabled',
  'loading-models': 'settings:general.voiceModelLoading',
  'mic-unavailable': 'settings:general.voiceMicUnavailable',
  ready: 'settings:general.voiceServiceReady',
}

export function useVoiceServiceState(): VoiceServiceState {
  return useVoiceStatusStore((state) => projectVoiceServiceState(state))
}

/**
 * 只有连接层失败才把界面推进离线态：socket 不存在/被拒、上游离线、连接中断。
 * 命令超时属于「未确认」——服务端可能只是在执行一条慢命令，把它当成掉线会让
 * 界面显示一个假的"未连接"；会话级错误（例如"上一条语音未发送"）同样保留原文。
 */
export function isVoiceTransportError(message: string): boolean {
  return /Voice Tool 未连接|语音 Socket|语音服务连接中断|SERVICE_OFFLINE|SERVICE_DISCONNECTED|Connection refused|os error (2|111)/i.test(
    message
  )
}

/**
 * 连接层失败发生时该显示哪一句。
 *
 * 状态可能已经过期：浮窗是常驻窗口，启动时探测过一次，之后语音服务挂掉不会再有
 * 状态推送，store 里仍是上一次的 ready。此时以错误事实为准——连接层失败就意味着
 * 服务不可用。反过来，若 store 里是更具体的降级（模型加载中、麦克风未就绪），
 * 保留它，那比一句笼统的"未连接"更有用。
 */
export function voiceServiceMessageState(
  state: VoiceServiceState,
  error: string
): VoiceServiceState {
  if (!isVoiceTransportError(error)) return state
  return state === 'loading-models' || state === 'mic-unavailable' ? state : 'offline'
}
