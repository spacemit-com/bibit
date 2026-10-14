import { useEffect, useRef, useState } from 'react'
import {
  isRuntimePermissionCurrent,
  runtimePermissionIdentityKey,
  useRuntimePermissionController,
} from '@/features/conversation/runtimePermissionController'
import type { SessionFeed } from '@/hooks/useSessionFeed'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Props = {
  feed: SessionFeed
  ready: boolean
  loadOlder: () => Promise<boolean>
  /**
   * 让列表露出最新内容。长会话由虚拟列表渲染，视口外的行不在 DOM 里，
   * 待审批卡片通常就在尾部，先滚过去再重试查询即可命中。
   */
  revealLatest?: () => void
}

export function PendingApprovalNavigation({ feed, ready, loadOlder, revealLatest }: Props) {
  const { t } = useTranslation()
  const entries = useRuntimePermissionController(state => state.entries)
  const pending = Object.values(entries).filter(entry =>
    entry.data.targetId === feed.targetId &&
    entry.data.runtimeEpoch === feed.runtimeEpoch &&
    entry.data.sessionId === feed.sessionId &&
    !feed.hiddenRunIds.includes(entry.data.runId) &&
    entry.status !== 'resolved' && entry.data.status === 'pending' &&
    isRuntimePermissionCurrent(entry.data)
  ).sort((a, b) => a.data.createdAt.localeCompare(b.data.createdAt))
  const firstKey = pending[0] && runtimePermissionIdentityKey(pending[0].data)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const mounted = useRef(true)
  const lastPage = useRef<number | undefined>(undefined)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; clearTimeout(retryTimer.current) }
  }, [])

  useEffect(() => {
    if (!locating) return
    if (!firstKey) { setLocating(false); return }
    const card = Array.from(document.querySelectorAll<HTMLElement>('[data-runtime-permission-key]'))
      .find(element => element.getAttribute('data-runtime-permission-key') === firstKey)
    const title = card?.querySelector<HTMLElement>('[data-runtime-permission-title]')
    if (title) {
      title.scrollIntoView({ block: 'center', behavior: 'smooth' })
      title.focus({ preventScroll: true })
      setLocating(false)
      return
    }
    if (loading) return
    if (revealLatest && !revealed) {
      revealLatest()
      retryTimer.current = setTimeout(() => { if (mounted.current) setRevealed(true) }, 0)
      return
    }
    if (!ready || !feed.hasMore || lastPage.current === feed.baseSeq) {
      setError(t('common:pendingApprovalLocateUnavailable'))
      setLocating(false)
      return
    }
    lastPage.current = feed.baseSeq
    setLoading(true)
    void loadOlder().then(ok => {
      if (!mounted.current) return
      if (!ok) { setError(t('common:pendingApprovalHistoryFailed')); setLocating(false) }
    }).catch(() => {
      if (mounted.current) { setError(t('common:pendingApprovalHistoryFailed')); setLocating(false) }
    }).finally(() => { if (mounted.current) setLoading(false) })
  }, [locating, loading, firstKey, feed.baseSeq, feed.hasMore, ready, loadOlder, revealLatest, revealed, t])

  if (!pending.length) return null
  return (
    <div className="px-4 py-2 text-sm" aria-live="polite">
      <button type="button" className="text-primary underline underline-offset-4"
        disabled={locating || !ready}
        onClick={() => { lastPage.current = undefined; setRevealed(false); setError(''); setLocating(true) }}>
        {locating ? t('common:pendingApprovalLocating') : t('common:pendingApprovalLocateAction', { count: pending.length })}
      </button>
      {error && <p role="status" className="text-destructive">{error}</p>}
    </div>
  )
}
