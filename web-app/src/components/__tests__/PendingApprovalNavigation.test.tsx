import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { PendingApprovalNavigation } from '../PendingApprovalNavigation'
import { useRuntimePermissionController, runtimePermissionIdentityKey } from '@/features/conversation/runtimePermissionController'
import type { RuntimePermissionData } from '@/lib/runtime-contract'
import type { SessionFeed } from '@/hooks/useSessionFeed'

const feed: SessionFeed = {
  targetId: 'target', runtimeEpoch: 'epoch', sessionId: 'session',
  events: [], hiddenRunIds: [], baseSeq: 20, lastSeq: 30,
  hasMore: true, connectionStatus: 'connected',
}
const permission = (requestId: string): RuntimePermissionData => ({
  targetId: 'target', runtimeId: 'runtime', runtimeEpoch: 'epoch',
  sessionId: 'session', runId: 'run', requestId, toolCallId: requestId,
  createdAt: requestId, title: '审批', description: '', toolName: 'shell',
  canAllowOnce: true, canDeny: true, status: 'pending',
})
const install = (...items: RuntimePermissionData[]) => useRuntimePermissionController.setState({
  entries: Object.fromEntries(items.map(data => [runtimePermissionIdentityKey(data), { data, status: 'pending' as const }])),
})
beforeEach(() => {
  install(permission('1'), permission('2'))
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
describe('待审批定位', () => {
  it('定位最早原位标题，不点击审批或展开详情', () => {
    const decide = vi.fn()
    const { rerender } = render(<>
      <PendingApprovalNavigation feed={feed} ready loadOlder={vi.fn()} />
      <div data-runtime-permission-key={runtimePermissionIdentityKey(permission('1'))}>
        <h3 data-runtime-permission-title tabIndex={-1}>原位审批</h3>
        <button onClick={decide}>批准</button>
      </div>
    </>)
    fireEvent.click(screen.getByRole('button', { name: '2 pending approval(s) · Locate' }))
    expect(screen.getByText('原位审批')).toHaveFocus()
    expect(decide).not.toHaveBeenCalled()
    act(() => install())
    rerender(<PendingApprovalNavigation feed={feed} ready loadOlder={vi.fn()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('虚拟列表没挂载卡片时先露出尾部再重试，不向前翻页', async () => {
    const loadOlder = vi.fn().mockResolvedValue(true)
    const key = runtimePermissionIdentityKey(permission('1'))
    let host: HTMLElement | undefined
    const revealLatest = vi.fn(() => {
      // 回到尾部后这一行才真正挂载（identity key 含 NUL，不能用 HTML 字符串拼）。
      const row = document.createElement('div')
      row.setAttribute('data-runtime-permission-key', key)
      const title = document.createElement('h3')
      title.setAttribute('data-runtime-permission-title', '')
      title.tabIndex = -1
      title.textContent = '尾部审批'
      row.append(title)
      ;(host ?? document.body).append(row)
    })
    host = render(<PendingApprovalNavigation feed={feed} ready loadOlder={loadOlder} revealLatest={revealLatest} />).container
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByText('尾部审批')).toHaveFocus())
    expect(revealLatest).toHaveBeenCalledTimes(1)
    expect(loadOlder).not.toHaveBeenCalled()
  })
  it('读取失败显示可重试提示，不无限加载', async () => {
    const loadOlder = vi.fn().mockResolvedValue(false)
    render(<PendingApprovalNavigation feed={feed} ready loadOlder={loadOlder} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Failed to load the history around the approval'))
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button')).toBeEnabled()
  })
  it('读取成功但游标没有前进时停止，不重复请求同一页', async () => {
    const loadOlder = vi.fn().mockResolvedValue(true)
    render(<PendingApprovalNavigation feed={feed} ready loadOlder={loadOlder} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Could not locate the approval yet'))
    expect(loadOlder).toHaveBeenCalledTimes(1)
  })
  it('补页期间最早审批已处理时，定位下一项且不再次加载', async () => {
    let finish!: (ok: boolean) => void
    const loadOlder = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { rerender } = render(<PendingApprovalNavigation feed={feed} ready loadOlder={loadOlder} />)
    fireEvent.click(screen.getByRole('button'))
    expect(loadOlder).toHaveBeenCalledTimes(1)
    act(() => install(permission('2')))
    rerender(<>
      <PendingApprovalNavigation feed={{ ...feed, baseSeq: 10 }} ready loadOlder={loadOlder} />
      <div data-runtime-permission-key={runtimePermissionIdentityKey(permission('2'))}>
        <h3 data-runtime-permission-title tabIndex={-1}>下一项审批</h3>
      </div>
    </>)
    await act(async () => { finish(true) })
    expect(screen.getByText('下一项审批')).toHaveFocus()
    expect(screen.getByRole('button', { name: '1 pending approval(s) · Locate' })).toBeEnabled()
    expect(loadOlder).toHaveBeenCalledTimes(1)
  })
  it('补页期间所有审批已处理时，完成回调不恢复入口', async () => {
    let finish!: (ok: boolean) => void
    const loadOlder = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    render(<PendingApprovalNavigation feed={feed} ready loadOlder={loadOlder} />)
    fireEvent.click(screen.getByRole('button'))
    act(() => install())
    await act(async () => { finish(true) })
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled()
  })
})
