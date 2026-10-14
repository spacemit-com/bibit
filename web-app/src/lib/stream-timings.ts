/**
 * 流式会话的端到端计时：事件进入前端 → 投影完成 → 流式正文 DOM 提交。
 *
 * 默认关闭，只有显式打开才采样（`localStorage['bibit:stream-timings'] = '1'`，
 * 或控制台 `__bibitStreamTimings.enable()`），因此正常会话不付采集开销。
 * 采样只留在内存里且有上限，不做逐 token 的磁盘日志。
 *
 * 语义边界：这里量到的是 DOM 提交，不是真实屏幕绘制。K3 上的观感结论仍要由实机
 * 链路对照给出，不能拿本文件的数据替代。
 */
import type { SessionEvent, SessionMessage } from './runtime-session-projection'

const FLAG = 'bibit:stream-timings'
const MAX_SAMPLES = 2_000
const MAX_PENDING = 128

export type StreamTimingSample = {
  sessionId: string
  runId?: string
  seq?: number
  /** 事件进入前端到流式正文提交的延迟。 */
  commitLatencyMs: number
  projectionMs?: number
}

export type StreamTimingPercentiles = { count: number; p50: number; p95: number; max: number }
export type StreamTimingReport = {
  enabled: boolean
  samples: number
  commitLatencyMs: StreamTimingPercentiles | null
  projectionMs: StreamTimingPercentiles | null
}

type OpenBatch = { sessionId: string; runId: string; seq: number; at: number }
type ProjectedBatch = OpenBatch & { messageId: string; content: string; projectionMs: number }

const samples: StreamTimingSample[] = []
let enabled = false
const arrivals = new Map<string, OpenBatch>()
let pending: ProjectedBatch[] = []
const batchKey = (sessionId: string, runId: string, seq: number) => JSON.stringify([sessionId, runId, seq])

function fromStorage() {
  try { return localStorage.getItem(FLAG) === '1' } catch { return false }
}
/** 验收构建可以在打包时打开采样（`web-app/.env` 里 `VITE_BIBIT_STREAM_TIMINGS=1`），
 *  免得在真机上还要先想办法在控制台里按一次开关。 */
function fromBuild() {
  try { return import.meta.env?.VITE_BIBIT_STREAM_TIMINGS === '1' } catch { return false }
}
if (fromStorage() || fromBuild()) enabled = true

function percentiles(values: number[]): StreamTimingPercentiles | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const pick = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
  return { count: sorted.length, p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1] }
}

export function streamTimingsEnabled() { return enabled }

export function setStreamTimingsEnabled(value: boolean) {
  enabled = value
  arrivals.clear()
  pending = []
  try {
    if (value) localStorage.setItem(FLAG, '1')
    else localStorage.removeItem(FLAG)
  } catch { /* 无存储时只影响下次启动。 */ }
}

export function resetStreamTimings() { samples.length = 0; arrivals.clear(); pending = [] }

/** 按正文事件身份保留到达时间；后到事件不能冒充已显示的正文。 */
export function markStreamArrival(sessionId: string, runId?: string, seq?: number) {
  if (!enabled || !runId || seq === undefined) return
  const key = batchKey(sessionId, runId, seq)
  if (!arrivals.has(key)) arrivals.set(key, { sessionId, runId, seq, at: performance.now() })
  if (arrivals.size > MAX_PENDING) arrivals.delete(arrivals.keys().next().value!)
}

export function markProjectionDone(durationMs: number, sessionId?: string,
  events: readonly SessionEvent[] = [], messages: readonly SessionMessage[] = []) {
  if (!enabled || !sessionId) return
  let event: SessionEvent | undefined
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === 'assistant/text.delta') { event = events[index]; break }
  }
  if (!event?.run_id) return
  const span = event.data.seq_range
  const seq = Array.isArray(span) ? Number(span[1]) : event.seq
  const arrival = arrivals.get(batchKey(sessionId, event.run_id, seq))
  if (!arrival) return
  const message = messages.find(message => message.role === 'assistant' && message.runId === event.run_id)
  const item = message?.turn?.items.at(-1)
  if (!message || item?.kind !== 'answer') return
  if (pending.some(batch => batch.messageId === message.id && batch.content === item.markdown)) return
  pending.push({ ...arrival, messageId: message.id, content: item.markdown, projectionMs: durationMs })
  if (pending.length > MAX_PENDING) pending.shift()
}

/** 节流窗口真的发出了一个新值（用来把「节流没发」和「下游把它吞了」分开）。 */
export function noteThrottledEmit(length: number) {
  if (!enabled) return
  console.info(`[stream-timings] throttle len=${length} at=${performance.now().toFixed(1)}`)
}

/** 只消费实际显示的正文快照。MessageItem 流式时可能补一个尾部换行。 */
export function markStreamCommit(messageId: string | undefined, content: string) {
  if (!enabled || !messageId) return
  const batch = pending.find(batch => batch.messageId === messageId &&
    (batch.content === content || `${batch.content}\n` === content))
  if (!batch) return
  const { sessionId, runId, seq, projectionMs } = batch
  const commitLatencyMs = performance.now() - batch.at
  samples.push({ sessionId, runId, seq, commitLatencyMs, projectionMs })
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES)
  pending = pending.filter(other => other.sessionId !== sessionId || other.runId !== runId || other.seq > seq)
  for (const [key, arrival] of arrivals) {
    if (arrival.sessionId === sessionId && arrival.runId === runId && arrival.seq <= seq) arrivals.delete(key)
  }
  // 采样打开时把每次提交写进行为日志（验收读法：`at` 是相对 timeOrigin 的毫秒，
  // `latency` 是这一批 delta 到落入 DOM 的延迟）。默认关闭时不产生任何日志。
  console.info(`[stream-timings] commit seq=${seq} at=${performance.now().toFixed(1)} latency=${commitLatencyMs.toFixed(1)} len=${content.length}`)
}

export function streamTimingReport(): StreamTimingReport {
  return { enabled, samples: samples.length,
    commitLatencyMs: percentiles(samples.map(sample => sample.commitLatencyMs)),
    projectionMs: percentiles(samples.map(sample => sample.projectionMs).filter((value): value is number => typeof value === 'number')) }
}

declare global {
  interface Window { __bibitStreamTimings?: { enable: () => void; disable: () => void; reset: () => void; report: () => StreamTimingReport } }
}

if (typeof window !== 'undefined') {
  window.__bibitStreamTimings = {
    enable: () => setStreamTimingsEnabled(true),
    disable: () => setStreamTimingsEnabled(false),
    reset: resetStreamTimings,
    report: streamTimingReport,
  }
}
