/**
 * 会话忙碌状态的时间线探针：记录忙碌进入、退出与来源。
 *
 * 默认关闭，显式打开才采样（`localStorage['bibit:session-busy'] = '1'`，或控制台
 * `__bibitSessionBusy.enable()`），因此正常会话不付采集开销。样本只留在内存且有上限。
 *
 * 语义边界：这里记的是前端派生的忙碌状态，不是屏幕绘制，也不能替代实机观感结论。
 */
export type SessionBusyPhase = 'idle' | 'submitting' | 'running' | 'waiting_approval' | 'stopping'
export type SessionBusySource = 'submit' | 'runtime-view' | 'content' | 'hold' | 'clear'

export type SessionBusyTransition = {
  key: string
  phase: SessionBusyPhase
  source: SessionBusySource
  at: number
}

export type SessionBusyReport = {
  enabled: boolean
  transitions: number
  /** 每个会话的忙碌进入与退出次数；正常一次回答应是 1 进 1 出。 */
  sessions: { key: string; entries: number; exits: number }[]
  timeline: SessionBusyTransition[]
}

const FLAG = 'bibit:session-busy'
const MAX_SAMPLES = 2_000

let enabled = false
const transitions: SessionBusyTransition[] = []

function fromStorage() {
  try { return localStorage.getItem(FLAG) === '1' } catch { return false }
}
if (fromStorage()) enabled = true

export function sessionBusyTimingsEnabled() { return enabled }

export function setSessionBusyTimingsEnabled(value: boolean) {
  enabled = value
  if (!value) transitions.length = 0
  try {
    if (value) localStorage.setItem(FLAG, '1')
    else localStorage.removeItem(FLAG)
  } catch { /* 无存储时只影响下次启动。 */ }
}

export function resetSessionBusyTimings() { transitions.length = 0 }

export function recordBusyTransition(transition: SessionBusyTransition) {
  if (!enabled) return
  transitions.push(transition)
  if (transitions.length > MAX_SAMPLES) transitions.splice(0, transitions.length - MAX_SAMPLES)
}

export function sessionBusyReport(key?: string): SessionBusyReport {
  const timeline = key ? transitions.filter(transition => transition.key === key) : transitions
  const sessions = new Map<string, { key: string; entries: number; exits: number }>()
  const busy = new Map<string, boolean>()
  for (const transition of timeline) {
    const entry = sessions.get(transition.key) ?? { key: transition.key, entries: 0, exits: 0 }
    const wasBusy = busy.get(transition.key) ?? false
    // 只统计真正的进出：提交到运行这类阶段推进不算第二次进入。
    if (!wasBusy && transition.phase !== 'idle') entry.entries += 1
    else if (wasBusy && transition.phase === 'idle') entry.exits += 1
    busy.set(transition.key, transition.phase !== 'idle')
    sessions.set(transition.key, entry)
  }
  return { enabled, transitions: timeline.length, sessions: [...sessions.values()], timeline: [...timeline] }
}

declare global {
  interface Window {
    __bibitSessionBusy?: {
      enable: () => void
      disable: () => void
      reset: () => void
      report: (key?: string) => SessionBusyReport
    }
  }
}

if (typeof window !== 'undefined') {
  window.__bibitSessionBusy = {
    enable: () => setSessionBusyTimingsEnabled(true),
    disable: () => setSessionBusyTimingsEnabled(false),
    reset: () => resetSessionBusyTimings(),
    report: (key?: string) => sessionBusyReport(key),
  }
}
