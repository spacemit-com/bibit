import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { formatRuntimeCommandError } from '@/lib/runtime-contract'
import i18n from '@/i18n/setup'
import { appendFolded, foldSessionEvents } from '@/lib/runtime-session-fold'
import type { SessionEvent } from '@/lib/runtime-session-projection'
import { markStreamArrival } from '@/lib/stream-timings'

type FeedConnection = { status: 'connected' | 'reconnecting' | 'disconnected'; message?: string }
type PersistenceState = {
  state: 'saved' | 'pending' | 'error'; durable_events: number; pending_events: number
  error?: { code: string; message: string; details?: Record<string, unknown> } | null
}
export type SessionFeed = {
  resourceBaseUrl?: string; targetId: string; runtimeEpoch: string; sessionId: string
  events: SessionEvent[]; hiddenRunIds: string[]; baseSeq: number; lastSeq: number
  hasMore: boolean; connectionStatus: 'connected' | 'reconnecting' | 'disconnected'
  paused?: boolean
  globalConnection?: FeedConnection; sessionConnection?: FeedConnection
  summaryVersion?: number
  kind?: 'events' | 'summary' | 'connection' | 'reset'; message?: string
  persistence?: PersistenceState | null
  // 摘要帧是 Runtime 的权威执行状态载体：除可用性信息外还带 running / waiting /
  // active_run_id，忙碌判据直接消费它们，不再靠内容事件推断。
  summary?: {
    sessions?: Array<{
      id: string
      persistence?: PersistenceState
      running?: boolean
      waiting?: boolean
      active_run_id?: string | null
    }>
  } | null
}
// 首屏快照到达前的缓冲上限。这段窗口只有几秒，但期间不能无界堆积。
// 只按字节和事件数设界：慢读时推送帧会堆到远超百条，按帧数设界会把「读得慢」误判成
// 「缓冲已满」，而内存本来由下面两个量守住。
const BUFFER_MAX_BYTES = 32 * 1024 * 1024
const BUFFER_MAX_EVENTS = 200_000
// 首屏读的活性预算：Rust 侧命令自带 15s 超时，这里再兜一层（命令入口本身也可能挂起），
// 并给整段读一个总预算——超出就落到停止态，不让视图无限停在加载中。
const READ_ATTEMPT_TIMEOUT_MS = 20_000
const READ_BUDGET_MS = 30_000
// 自动重试次数与退避。客户端超时不会中止 Runtime 侧已经在跑的窗口读，密集重试只会
// 往已经排队的 Runtime 上再加一份，所以次数少、退避起步大，把「再试」留给用户主动点。
const READ_RETRIES = 2
const READ_RETRY_BASE_MS = 2_000
const READ_RETRY_MAX_MS = 8_000
// 同一浏览器帧内到达的纯 delta 只通知 React 一次。事件本身总是同步合进 feedRef，
// 所以压的只是 setState 次数：渲染慢一点也不会有批次被丢掉或乱序。
const NOTIFY_FRAME_MS = 16
const DELTA_EVENT_TYPES = new Set(['assistant/text.delta', 'assistant/reasoning.delta'])
const encoder = new TextEncoder()
/** 帧里最后一条 delta：计时样本按它标注 run/seq。 */
function lastDelta(events: readonly SessionEvent[]) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === 'assistant/text.delta') return events[index]
  }
  return undefined
}
/** 读超时按可重试错误收尾；code 与 Rust 侧 read_timeout 对齐，文案按界面语言给。 */
function readTimeout(): Error & { code: string; recoverable: boolean } {
  return Object.assign(new Error(i18n.t('chat:sessionReadTimeout')), { code: 'read_timeout', recoverable: true })
}
/** 给单个 promise 加截止时间；到期后原请求的结果不再参与状态更新。 */
function withDeadline<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(readTimeout()), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      cause => { clearTimeout(timer); reject(cause) },
    )
  })
}
/** 一条事件覆盖到的最新 seq：折叠组记在 `seq_range` 末尾，其余就是它自己。 */
function coveredEnd(event: SessionEvent) {
  const span = event.data.seq_range
  return Array.isArray(span) && span.length === 2 && Number.isSafeInteger(span[1]) ? Number(span[1]) : event.seq
}
/** 折叠组已经代表它区间内的全部事件，落在区间里的实时帧是重复的。 */
function coveredByLast(event: SessionEvent | undefined, seq: number) {
  if (!event) return false
  const span = event.data.seq_range
  if (!Array.isArray(span) || span.length !== 2) return false
  const [start, end] = span.map(Number)
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && seq >= start && seq <= end
}
export function mergeSessionFeed(previous: SessionFeed | undefined, frame: SessionFeed): SessionFeed {
  if (!previous) return { ...frame, events: frame.events ?? [], hiddenRunIds: frame.hiddenRunIds ?? [], summaryVersion: frame.kind === 'summary' ? 1 : 0 }
  const global = !frame.sessionId && (frame.kind === 'connection' || frame.kind === 'summary')
  if (previous.targetId !== frame.targetId || previous.runtimeEpoch !== frame.runtimeEpoch || (!global && previous.sessionId !== frame.sessionId)) return previous
  // 尾部回退：Runtime 重启后只恢复到最后一个完整批次，它和我们的游标已经不是同一段
  // 历史。丢掉旧窗口和游标，让随后的窗口帧从服务端重新装一次，而不是把两段历史按
  // seq 硬拼在一起——这也是「界面看到过、重启后没有」在客户端唯一合法的收场方式。
  if (frame.kind === 'reset') {
    return { ...previous, ...frame, events: [], hiddenRunIds: [], baseSeq: 0, lastSeq: 0,
      hasMore: false, sessionConnection: undefined, paused: false }
  }
  const persistence = frame.kind === 'summary'
    ? frame.summary?.sessions?.find(session => session.id === previous.sessionId)?.persistence ?? previous.persistence
    : frame.persistence ?? previous.persistence
  let events = previous.events
  const last = events.at(-1)
  // 窗口是折叠表示：装载期间缓冲的实时原始帧可能落在某个折叠组区间内（组首那条不在帧里，
  // 按 seq 覆盖去重挡不住），直接并上去会把这段正文再拼一遍。
  const incoming = (frame.events ?? []).filter(event => !coveredByLast(last, event.seq))
  if (incoming.length) {
    if (incoming.every((event, index) => event.seq > (index ? incoming[index - 1].seq : (last ? coveredEnd(last) : -1)))) {
      // 实时增量按服务端同一规则折叠，窗口体积因此与消息数成正比。
      const appended = [...events]
      for (const event of incoming) appendFolded(appended, event)
      events = appended
    } else {
      const bySeq = new Map(events.map(event => [event.seq, event]))
      for (const event of incoming) bySeq.set(event.seq, event)
      events = foldSessionEvents([...bySeq.values()].sort((a, b) => a.seq - b.seq))
    }
  }
  let hiddenRunIds = previous.hiddenRunIds
  if (frame.hiddenRunIds?.some(id => !hiddenRunIds.includes(id))) hiddenRunIds = [...new Set([...hiddenRunIds, ...frame.hiddenRunIds])]
  let globalConnection = previous.globalConnection ?? { status: previous.connectionStatus, message: previous.message }
  let sessionConnection = previous.sessionConnection
  if (frame.kind === 'connection') {
    const connection = { status: frame.connectionStatus, message: frame.connectionStatus === 'connected' ? undefined : frame.message }
    if (global) globalConnection = connection
    else sessionConnection = connection
  }
  const connection = sessionConnection?.status === 'disconnected' ? sessionConnection
    : globalConnection.status !== 'connected' ? globalConnection : (sessionConnection ?? globalConnection)
  return { ...previous, ...frame, sessionId: previous.sessionId, events, hiddenRunIds,
    persistence,
    globalConnection, sessionConnection, connectionStatus: connection.status, message: connection.message,
    paused: sessionConnection?.status === 'disconnected',
    summaryVersion: (previous.summaryVersion ?? 0) + (frame.kind === 'summary' ? 1 : 0),
    baseSeq: Math.min(previous.baseSeq, frame.baseSeq ?? previous.baseSeq),
    lastSeq: Math.max(previous.lastSeq, frame.lastSeq ?? previous.lastSeq) }
}
function isNotFound(cause: unknown) {
  const detail = cause && typeof cause === 'object' ? cause as Record<string, unknown> : {}
  const details = detail.details && typeof detail.details === 'object' ? detail.details as Record<string, unknown> : {}
  // 不能按错误码区分「路由不存在」和「会话不存在」：Runtime 对两者都回
  // `{"error":{"code":"not_found"}}`（设备实测）。因此任何 404 都退回
  // 原始事件窗口再确认一次——路由缺失时它救回旧 Runtime，会话确实不存在时它也回 404，
  // 用户看到的是同一个错误，代价只是一次多余的请求。
  return Number(details.httpStatus ?? detail.status) === 404
}
/** 展示读服务端折叠后的紧凑序列；实时增量仍走原始事件（seq 游标依赖它不被打断）。 */
async function readHistoryWindow(sessionId: string, beforeSeq?: number) {
  const args = beforeSeq === undefined ? { sessionId } : { sessionId, beforeSeq }
  try {
    const page = await invoke<SessionFeed>('runtime_session_history_window', args)
    return { ...page, events: foldSessionEvents(page.events ?? []) }
  } catch (cause) {
    // 早于本客户端的 Runtime 没有 /history；退回原始事件窗口，行为与旧版一致。
    if (!isNotFound(cause)) throw cause
    console.warn('[SessionFeed] Runtime 未提供 /history，退回原始事件窗口')
    const page = await invoke<SessionFeed>('runtime_session_feed', args)
    return { ...page, events: foldSessionEvents(page.events ?? []) }
  }
}
/**
 * `anchorSeq` 把首屏窗口从「最新」换成「以这条消息结尾」的历史窗口，用于从搜索结果
 * 跳进旧对话。锚定期间不合并实时帧：尾窗没装进来，硬拼实时增量会让中间整段缺失，
 * 用户点「回到最新」时再按尾窗重读一次（`readHistoryWindow` 不带 before_seq）。
 */
export function useSessionFeed(
  sessionId: string,
  epoch?: string,
  enabled = true,
  anchorSeq?: number,
) {
  const generation = useRef(0)
  const anchored = anchorSeq !== undefined
  const [retryGeneration, retry] = useState(0)
  const [feed, setFeed] = useState<SessionFeed>()
  /**
   * 当前这份快照是按哪个锚点读出来的。`feed` 本身分不出「尾窗」和「锚定窗口」，
   * 而跳到命中消息的滚动必须等锚定窗口真的落地，否则会先滚到尾窗底部。
   */
  const [loadedAnchor, setLoadedAnchor] = useState<number | undefined>(undefined)
  const feedRef = useRef<SessionFeed | undefined>(undefined)
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastNotifyAt = useRef(0)
  /** 立即发布当前 feed：控制帧、终态、以及距上次发布已隔一帧的 delta 都走这里。 */
  const publishFeed = () => {
    if (notifyTimer.current !== undefined) { clearTimeout(notifyTimer.current); notifyTimer.current = undefined }
    lastNotifyAt.current = performance.now()
    setFeed(feedRef.current)
  }
  const installFeed = (value: SessionFeed | undefined) => { feedRef.current = value; publishFeed() }
  /**
   * 纯 delta 帧合帧通知。批次状态已经落在 feedRef，这里只决定什么时候让 React 看到它：
   * 空闲时立刻发布（首段文字不额外等待），连续时每帧最多一次。
   */
  const queueFeed = (payload: SessionFeed) => {
    const events = payload.events ?? []
    const control = (payload.kind ?? 'events') !== 'events' || events.some(event => !DELTA_EVENT_TYPES.has(event.type))
    const elapsed = performance.now() - lastNotifyAt.current
    if (control || elapsed >= NOTIFY_FRAME_MS) publishFeed()
    else if (notifyTimer.current === undefined) notifyTimer.current = setTimeout(publishFeed, NOTIFY_FRAME_MS - elapsed)
  }
  const [error, setError] = useState('')
  // 读取已经停止且不会再自动重试：此时没有 feed，也就永远不会有快照落地。
  // 视图必须靠它区分「还在读」和「读不动了」，否则会一直显示加载态。
  const [halted, setHalted] = useState(false)
  useEffect(() => {
    generation.current++
    setHalted(false)
    setLoadedAnchor(undefined)
    if (!enabled) {
      installFeed(undefined)
      setError('')
      return
    }
    let disposed = false
    let paused = false
    let ready = false
    const startedAt = Date.now()
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const buffered: SessionFeed[] = []
    let bufferedEvents = 0
    let bufferedBytes = 2
    let unlisten: (() => void) | undefined
    // 同一会话因 Runtime 重连而刷新 epoch 时，历史页仍可能暂时不可用。
    // 保留上一个已验证快照直到新快照抵达，避免把整段对话替换成加载提示。
    if (feedRef.current?.sessionId !== sessionId) installFeed(undefined)
    setError('')
    // 后台窗口的定时器会被系统拉长，回到前台立刻补上最新状态。
    const onVisible = () => { if (document.visibilityState === 'visible') publishFeed() }
    document.addEventListener('visibilitychange', onVisible)
    void (async () => {
      unlisten = await listen<SessionFeed>('runtime-session-event', ({ payload }) => {
        // 锚定读是一份历史快照：实时帧属于尾窗，装进锚定窗口只会得到一段错位的对话。
        if (disposed || paused || anchored || (payload.sessionId !== sessionId && !(['summary', 'connection'].includes(payload.kind ?? '') && !payload.sessionId))) return
        const delta = lastDelta(payload.events ?? [])
        if (delta) markStreamArrival(sessionId, delta.run_id ?? undefined, coveredEnd(delta))
        if (!ready) {
          buffered.push({ ...payload, events: payload.events ?? [] })
          bufferedEvents += payload.events?.length ?? 0
          bufferedBytes += encoder.encode(JSON.stringify(buffered[buffered.length - 1])).length + (buffered.length > 1 ? 1 : 0)
          if (bufferedEvents > BUFFER_MAX_EVENTS || bufferedBytes > BUFFER_MAX_BYTES) {
            paused = true; buffered.length = 0; unlisten?.()
            setHalted(true)
            // 控制台诊断不进界面，保持中文原文。
            console.warn(`[SessionFeed] 初始化事件缓冲溢出（积压 ${bufferedEvents} 事件 / ${(bufferedBytes / 1024 / 1024).toFixed(1)}MiB），读取已暂停`)
            setError(i18n.t('chat:feedBufferFull'))
          }
        }
        else {
          // 先同步合并，再决定何时通知 React：慢渲染不会拖慢事件消费，也不会积压成数组。
          feedRef.current = mergeSessionFeed(feedRef.current, payload)
          queueFeed(payload)
        }
      })
      if (disposed) { unlisten(); return }
      const load = async (attemptIndex = 0) => {
        const remaining = READ_BUDGET_MS - (Date.now() - startedAt)
        try {
          if (remaining <= 0) throw readTimeout()
          const initial = await withDeadline(
            readHistoryWindow(sessionId, anchored ? anchorSeq + 1 : undefined),
            Math.min(READ_ATTEMPT_TIMEOUT_MS, remaining),
          )
          if (disposed || paused) return
          if (buffered.length > 0) console.warn(`[SessionFeed] 首屏读期间积压 ${buffered.length} 帧 / ${bufferedEvents} 事件 / ${(bufferedBytes / 1024 / 1024).toFixed(1)}MiB`)
          const snapshot = anchored
            ? initial
            : buffered.reduce<SessionFeed>((current, frame) => mergeSessionFeed(current, frame), initial)
          installFeed(snapshot)
          setLoadedAnchor(anchored ? anchorSeq : undefined)
          buffered.length = 0
          ready = true
          setError('')
        } catch (cause) {
          if (disposed || paused) return
          const detail = cause && typeof cause === 'object' ? cause as Record<string, unknown> : {}
          const details = detail.details && typeof detail.details === 'object' ? detail.details as Record<string, unknown> : {}
          const status = Number(details.httpStatus ?? detail.status)
          const permanent = detail.recoverable === false || (status >= 400 && status < 500 && ![408, 429].includes(status)) || ['session_not_found', 'session_conflict', 'unsupported_operation', 'invalid_request'].includes(String(detail.code))
          const retryable = !permanent && attemptIndex < READ_RETRIES && Date.now() - startedAt < READ_BUDGET_MS
          setError(i18n.t(retryable ? 'chat:feedReadRetrying' : 'chat:feedReadRetryStopped', { error: formatRuntimeCommandError(cause) }))
          if (retryable) retryTimer = setTimeout(() => { void load(attemptIndex + 1) }, Math.min(READ_RETRY_BASE_MS * 2 ** attemptIndex, READ_RETRY_MAX_MS))
          else { buffered.length = 0; unlisten?.(); setHalted(true) }
        }
      }
      await load()
    })().catch(cause => { if (!disposed) { setError(formatRuntimeCommandError(cause)); setHalted(true) } })
    return () => {
      disposed = true
      clearTimeout(retryTimer)
      buffered.length = 0
      document.removeEventListener('visibilitychange', onVisible)
      if (notifyTimer.current !== undefined) { clearTimeout(notifyTimer.current); notifyTimer.current = undefined }
      unlisten?.()
    }
  }, [sessionId, epoch, retryGeneration, enabled, anchorSeq])
  const loadOlder = async () => {
    const current = feedRef.current
    if (!enabled) return false
    if (!current?.hasMore) return true
    if (current.paused) return false
    const currentGeneration = generation.current
    try {
      const older = await readHistoryWindow(sessionId, current.baseSeq)
      if (generation.current !== currentGeneration) return false
      if (feedRef.current?.paused) return false
      installFeed(mergeSessionFeed(feedRef.current, older))
      return true
    } catch (cause) { if (generation.current === currentGeneration) setError(formatRuntimeCommandError(cause)); return false }
  }
  // epoch 变化会启动新的权威读取；在它完成前，旧 epoch 的同一会话快照仍可安全展示。
  // 会话 ID 变化时已在 effect 开头清空，因此不会串到另一段会话。
  const currentFeed = enabled && feed?.sessionId === sessionId ? feed : undefined
  const persistenceError = currentFeed?.persistence?.error
  const visibleError = [error, persistenceError?.message].filter(Boolean).join('\n')
  return {
    feed: currentFeed,
    error: visibleError,
    halted,
    loadOlder,
    retry: () => retry(value => value + 1),
    /** 锚定窗口是否已经成为当前展示的快照。 */
    anchored: anchorSeq !== undefined && loadedAnchor === anchorSeq,
  }
}
