import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { SessionFeed } from './useSessionFeed'
import type { RuntimeSession } from '@/lib/runtime-contract'

type Watermark = { readSeq: number; terminalSeq: number; readRunId?: string }
const key = (targetId: string, sessionId: string) => `bibit:session-read:${JSON.stringify([targetId, sessionId])}`
function read(targetId: string, sessionId: string): Watermark {
  try { return { readSeq: -1, terminalSeq: -1, ...JSON.parse(localStorage.getItem(key(targetId, sessionId)) ?? '{}') } }
  catch { return { readSeq: -1, terminalSeq: -1 } }
}
export function sessionUnread(targetId: string, session: RuntimeSession): boolean {
  const mark = read(targetId, session.id)
  const latest = session.latestRun
  return mark.terminalSeq > mark.readSeq || Boolean(latest && ['completed', 'failed', 'cancelled'].includes(latest.status) && latest.id !== mark.readRunId)
}
export function useSessionReadState(targetId: string | undefined, sessionId?: string, feed?: SessionFeed, sessions: RuntimeSession[] = []) {
  const [, refresh] = useState(0)
  const latestRunId = sessions.find(session => session.id === sessionId)?.latestRun?.id
  const visibleEvents = feed && feed.targetId === targetId && feed.sessionId === sessionId ? feed.events ?? [] : []
  const renderedSeq = Math.max(-1, ...visibleEvents.map(event => event.seq))
  const completedRunId = visibleEvents.some(event => event.run_id === latestRunId && ['run/completed', 'run/failed', 'run/cancelled'].includes(event.type)) ? latestRunId : undefined
  useEffect(() => {
    if (!targetId) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const changed = () => refresh(value => value + 1)
    void listen<SessionFeed>('runtime-session-event', ({ payload }) => {
      if (disposed || payload.targetId !== targetId || !payload.sessionId) return
      const terminalSeq = Math.max(-1, ...(payload.events ?? []).filter(event => ['run/completed', 'run/failed', 'run/cancelled'].includes(event.type)).map(event => event.seq))
      if (terminalSeq < 0) return
      const previous = read(targetId, payload.sessionId)
      if (terminalSeq > previous.terminalSeq) {
        localStorage.setItem(key(targetId, payload.sessionId), JSON.stringify({ ...previous, terminalSeq }))
        changed()
        window.dispatchEvent(new Event('bibit-session-read-changed'))
      }
    }).then(stop => { if (disposed) stop(); else unlisten = stop }).catch(() => { /* 已读水位仍由权威feed/会话列表恢复。 */ })
    window.addEventListener('storage', changed)
    window.addEventListener('bibit-session-read-changed', changed)
    return () => { disposed = true; unlisten?.(); window.removeEventListener('storage', changed); window.removeEventListener('bibit-session-read-changed', changed) }
  }, [targetId])
  useEffect(() => {
    const markRead = () => {
      if (!targetId || !sessionId || renderedSeq < 0 || document.visibilityState === 'hidden' || !document.hasFocus()) return
      const previous = read(targetId, sessionId)
      const next = { ...previous, readSeq: Math.max(previous.readSeq, renderedSeq), readRunId: completedRunId ?? previous.readRunId }
      if (JSON.stringify(next) !== JSON.stringify(previous)) {
        localStorage.setItem(key(targetId, sessionId), JSON.stringify(next))
        window.dispatchEvent(new Event('bibit-session-read-changed'))
      }
    }
    window.addEventListener('focus', markRead)
    document.addEventListener('visibilitychange', markRead)
    markRead()
    return () => { window.removeEventListener('focus', markRead); document.removeEventListener('visibilitychange', markRead) }
  }, [targetId, sessionId, renderedSeq, completedRunId])
  return (session: RuntimeSession) => targetId ? sessionUnread(targetId, session) : false
}
