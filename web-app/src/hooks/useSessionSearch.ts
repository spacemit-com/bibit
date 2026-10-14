import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useRuntimeStore } from '@/stores/runtime-store'

/**
 * 一条正文命中。`seq` 是消息锚点，`endSeq` 是这条消息覆盖到的最后一条分片；
 * 打开历史窗口用的是 `endSeq`，只读到 `seq` 会把助手回答截在第一个分片。
 */
export type SessionSearchHit = {
  sessionId: string
  title: string
  updatedAt: number
  runId?: string
  seq: number
  endSeq: number
  role: string
  snippet: string
  matchStart: number
  matchLength: number
}

/** 输入停顿多久才去问 Runtime。检索是本地进程内的正文扫描，按键即查没有必要。 */
const SEARCH_DEBOUNCE_MS = 250
const SEARCH_LIMIT = 20

type State = {
  hits: SessionSearchHit[]
  loading: boolean
  /** Runtime 没有检索端点（旧版本）：界面保留标题结果，不显示必然失败的空结果。 */
  unavailable: boolean
}

const EMPTY: State = { hits: [], loading: false, unavailable: false }

function isMissingEndpoint(cause: unknown) {
  const detail = (cause && typeof cause === 'object' ? cause : {}) as Record<string, unknown>
  const details = (detail.details && typeof detail.details === 'object' ? detail.details : {}) as Record<string, unknown>
  const status = Number(details.httpStatus ?? detail.status)
  return status === 404 || status === 405 || detail.code === 'unsupported_operation'
}

/**
 * 跨会话正文检索。能力位关闭、查询为空或 Runtime 不提供端点时都安静地退回空结果，
 * 由调用方决定要不要展示这个分组。
 */
export function useSessionSearch(query: string, enabled: boolean): State {
  const supported = useRuntimeStore(state => Boolean(state.enabled && state.capabilities?.sessionSearch))
  const [state, setState] = useState<State>(EMPTY)
  const generation = useRef(0)
  const active = enabled && supported && query.trim().length > 0

  useEffect(() => {
    if (!active) {
      generation.current++
      setState(EMPTY)
      return
    }
    const current = ++generation.current
    setState(previous => ({ ...previous, loading: true }))
    const timer = setTimeout(() => {
      void invoke<SessionSearchHit[]>('runtime_sessions_search', { query, limit: SEARCH_LIMIT })
        .then(hits => {
          if (generation.current !== current) return
          setState({ hits: Array.isArray(hits) ? hits : [], loading: false, unavailable: false })
        })
        .catch(cause => {
          if (generation.current !== current) return
          // 旧 Runtime 没有 /sessions/search：这不是错误状态，界面只少一个分组。
          if (isMissingEndpoint(cause)) {
            setState({ hits: [], loading: false, unavailable: true })
            return
          }
          console.warn('[SessionSearch] 正文检索失败', cause)
          setState({ hits: [], loading: false, unavailable: false })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, active])

  return state
}
