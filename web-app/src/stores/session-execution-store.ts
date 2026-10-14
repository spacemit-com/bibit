/**
 * 每个会话的执行状态：忙碌判据的唯一来源。
 *
 * 进入可以来自本地提交、内容投影的提前信号，或 Runtime 的会话执行视图；退出必须等到
 * 权威视图空闲且本地没有未认领输入与待决审批，并且跨过一个最小保持窗口。事件流的空档
 * （回合前置钩子、模型首 token 等待、工具执行、上下文压缩）因此不会翻转忙碌状态。
 */
import { create } from 'zustand'
import { recordBusyTransition, type SessionBusyPhase, type SessionBusySource } from '@/lib/session-busy-timings'

export type SessionExecutionPhase = SessionBusyPhase

/** Runtime 会话执行视图；字段缺失表示该 Runtime 不上报执行状态。 */
export type SessionExecutionView = {
  running?: boolean
  waiting?: boolean
  activeRunId?: string | null
}

export type SessionExecutionSignal = {
  view?: SessionExecutionView
  unclaimedInputs?: number
  pendingApprovals?: number
  /** 内容投影当前是否判定有 Run 在跑；仅作进入信号，权威视图在场时不阻止退出。 */
  contentRunning?: boolean
}

type Entry = {
  phase: SessionExecutionPhase
  runId?: string
  source: SessionBusySource
  enteredAt: number
  exitTimer?: ReturnType<typeof setTimeout>
  /** 该会话是否见过 Runtime 的执行视图（决定退出能否由权威判定）。 */
  sawView?: boolean
  /** 是否见过内容投影的忙碌信号（旧 Runtime 的回退依据）。 */
  sawContent?: boolean
}

type SessionExecutionState = {
  executions: Record<string, Entry>
  observe: (key: string, signal: SessionExecutionSignal) => void
  markSubmit: (key: string) => void
  markStopping: (key: string) => void
  clear: (key: string) => void
}

/** 保持窗口：权威说空闲后仍显示忙碌这么久，避免亚秒级闪烁被看见。 */
export const MIN_BUSY_HOLD_MS = 400

export function sessionExecutionHoldsBusy(signal: SessionExecutionSignal): boolean {
  const view = signal.view
  if (view?.running || view?.waiting) return true
  if ((signal.unclaimedInputs ?? 0) > 0) return true
  if ((signal.pendingApprovals ?? 0) > 0) return true
  // 视图在场时以它为准；只有当 Runtime 不上报执行状态时才回退到内容投影。
  return !view && Boolean(signal.contentRunning)
}

const phaseFor = (signal: SessionExecutionSignal): SessionExecutionPhase =>
  signal.view?.waiting ? 'waiting_approval' : 'running'

const sourceFor = (signal: SessionExecutionSignal): SessionBusySource =>
  signal.view ? 'runtime-view' : 'content'

export const useSessionExecutionStore = create<SessionExecutionState>((set, get) => ({
  executions: {},

  observe: (key, signal) => {
    const entry = get().executions[key]
    const view = signal.view
    const unclaimedInputs = signal.unclaimedInputs ?? 0
    const pendingApprovals = signal.pendingApprovals ?? 0
    const contentRunning = Boolean(signal.contentRunning)
    const holds = sessionExecutionHoldsBusy(signal)
    const sawView = Boolean(entry?.sawView || view)
    const sawContent = Boolean(entry?.sawContent || contentRunning)
    const runId = signal.view?.activeRunId ?? undefined

    if (holds) {
      if (entry?.exitTimer) clearTimeout(entry.exitTimer)
      if (entry && entry.phase !== 'idle') {
        const phase = phaseFor(signal)
        if (!entry.exitTimer && entry.phase === phase && entry.runId === runId
          && entry.sawView === sawView && entry.sawContent === sawContent) return
        set(state => ({
          executions: {
            ...state.executions,
            [key]: { ...entry, phase, runId, exitTimer: undefined, sawView, sawContent },
          },
        }))
        return
      }
      const phase = phaseFor(signal)
      const source = sourceFor(signal)
      recordBusyTransition({ key, phase, source, at: performance.now() })
      set(state => ({
        executions: {
          ...state.executions,
          [key]: { phase, runId, source, enteredAt: performance.now(), sawView, sawContent },
        },
      }))
      return
    }

    if (!entry || entry.phase === 'idle' || entry.exitTimer) return
    // 退出只认两种依据：权威视图明确空闲，或该 Runtime 不上报视图时、内容忙碌信号
    // 已经出现过又结束。两者都不成立时保持忙碌，否则提交后的钩子空档会被判成空闲。
    const authorityIdle = Boolean(view) && !view?.running && !view?.waiting
    const fallbackIdle = !view && sawContent && !contentRunning && unclaimedInputs === 0 && pendingApprovals === 0
    if (!authorityIdle && !fallbackIdle) return
    const remaining = Math.max(0, MIN_BUSY_HOLD_MS - (performance.now() - entry.enteredAt))
    if (remaining === 0) {
      recordBusyTransition({ key, phase: 'idle', source: 'hold', at: performance.now() })
      set(state => ({ executions: { ...state.executions, [key]: { ...entry, phase: 'idle', exitTimer: undefined, sawView, sawContent } } }))
      return
    }
    const exitTimer = setTimeout(() => {
      const current = get().executions[key]
      if (!current || current.exitTimer !== exitTimer) return
      recordBusyTransition({ key, phase: 'idle', source: 'hold', at: performance.now() })
      set(state => ({ executions: { ...state.executions, [key]: { ...current, phase: 'idle', exitTimer: undefined } } }))
    }, remaining)
    set(state => ({ executions: { ...state.executions, [key]: { ...entry, exitTimer, sawView, sawContent } } }))
  },

  markSubmit: key => {
    const entry = get().executions[key]
    if (entry?.exitTimer) clearTimeout(entry.exitTimer)
    if (entry && entry.phase !== 'idle') return
    recordBusyTransition({ key, phase: 'submitting', source: 'submit', at: performance.now() })
    set(state => ({
      executions: {
        ...state.executions,
        [key]: { phase: 'submitting', source: 'submit', enteredAt: performance.now() },
      },
    }))
  },

  markStopping: key => {
    const entry = get().executions[key]
    if (!entry || entry.phase === 'idle') return
    set(state => ({ executions: { ...state.executions, [key]: { ...entry, phase: 'stopping' } } }))
  },

  clear: key => {
    const entry = get().executions[key]
    if (entry?.exitTimer) clearTimeout(entry.exitTimer)
    if (!entry) return
    set(state => {
      const executions = { ...state.executions }
      delete executions[key]
      return { executions }
    })
  },
}))
