import { beforeEach, describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
const sessionHarness = vi.hoisted(() => ({ enabled: false, durable: false, listeners: [] as Array<(event: { payload: unknown }) => void>, fetch: vi.fn(), messages: vi.fn(async () => [] as any[]), setThreads: vi.fn() }))
vi.mock('@/stores/runtime-store', () => ({ useRuntimeStore: (select: any) => select({ capabilities: { sessionEvents: sessionHarness.enabled, durableSessions: sessionHarness.durable }, runtimeEpoch: 'e' }) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ targetId: 'target-a' })) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_name, handler) => { sessionHarness.listeners.push(handler); return vi.fn() }) }))
vi.mock('@/hooks/useServiceHub', () => { const hub = { threads: () => ({ fetchThreads: sessionHarness.fetch }), messages: () => ({ fetchMessages: sessionHarness.messages }) }; return { useServiceHub: () => hub } })
import ThreadList from '../ThreadList'
import { useConversationAttentionStore } from '@/features/conversation/conversationAttentionStore'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className, title }: any) => (
    <a className={className} title={title}>
      {children}
    </a>
  ),
  useParams: ({ select }: any = {}) =>
    select ? select({ threadId: undefined }) : { threadId: undefined },
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: Object.assign((selector: any) =>
    selector({
      deleteThread: vi.fn(),
      renameThread: vi.fn(),
      updateThread: vi.fn(),
    }), { getState: () => ({ setThreads: sessionHarness.setThreads }) }),
}))

vi.mock('@/hooks/useMessages', () => ({
  useMessages: (selector: any) =>
    selector({
      getMessages: () => [],
      setMessages: vi.fn(),
    }),
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenuItem: ({ children }: any) => <li>{children}</li>,
  SidebarMenuButton: ({ children }: any) => <div>{children}</div>,
  SidebarMenuAction: ({ children }: any) => <button>{children}</button>,
  useSidebar: () => ({ isMobile: false }),
}))

vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = ({ children }: any) => <>{children}</>
  return {
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: ({ children, disabled, onSelect }: any) => (
      <button disabled={disabled} onClick={onSelect}>{children}</button>
    ),
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuSub: Passthrough,
    DropdownMenuSubContent: Passthrough,
    DropdownMenuSubTrigger: Passthrough,
  }
})

vi.mock('@/containers/dialogs', () => ({
  RenameThreadDialog: () => null,
  DeleteThreadDialog: ({ open }: any) => open ? <div role="dialog">Confirm deletion</div> : null,
}))

const longUrl = 'https://example.com/' + 'a'.repeat(300)

const makeThread = (overrides: Partial<Thread> = {}): Thread =>
  ({
    id: 't1',
    title: longUrl,
    updated: 0,
    metadata: {},
    ...overrides,
  }) as Thread

const flushEffects = () => act(() => Promise.resolve())

describe('ThreadList — long-URL overflow guard (#7959)', () => {
  beforeEach(() => {
    useConversationAttentionStore.getState().resetForTests()
  })

  it('allows deleting a former Jan welcome thread without the removed setup flag', async () => {
    localStorage.removeItem('setup-completed')
    render(<ThreadList threads={[makeThread({ title: 'What is Jan?' })]} />)
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(screen.getByRole('dialog')).toHaveTextContent('Confirm deletion')
  })

  it('offers only rename and delete in the session menu', async () => {
    render(<ThreadList threads={[makeThread({ title: 'What is Jan?' })]} />)
    await flushEffects()

    const labels = screen
      .getAllByRole('button')
      .map((el) => el.textContent?.trim())
      .filter((label): label is string => Boolean(label) && label !== 'More')

    expect(labels).toEqual(['Rename', 'Delete'])
  })

  it('shows the pending approval count on the affected conversation only', async () => {
    useConversationAttentionStore
      .getState()
      .setPendingPermissionCount('t1', 'runtime-hermes', 2)
    render(
      <ThreadList
        threads={[makeThread({ id: 't1' }), makeThread({ id: 't2' })]}
      />
    )
    await flushEffects()

    expect(screen.getByLabelText('2 action(s) need approval')).toBeInTheDocument()
    expect(screen.getAllByLabelText(/action\(s\) need approval/)).toHaveLength(1)
  })

  it('truncates long thread titles and exposes full text via title attribute', async () => {
    render(<ThreadList threads={[makeThread()]} />)
    await flushEffects()

    const titleSpans = screen
      .getAllByText(longUrl)
      .filter((el) => el.tagName === 'SPAN')
    expect(titleSpans.length).toBeGreaterThan(0)

    const titleEl = titleSpans[0]
    expect(titleEl).toHaveClass('block', 'truncate')
    expect(titleEl).toHaveAttribute('title', longUrl)
  })

it('falls back to the new-thread label when the title is empty and still truncates', async () => {
    render(<ThreadList threads={[makeThread({ title: '' })]} />)
    await flushEffects()

    const titleEl = screen
      .getAllByText('New Thread')
      .find((el) => el.tagName === 'SPAN')
    expect(titleEl).toBeDefined()
    expect(titleEl).toHaveClass('block', 'truncate')
  expect(titleEl).toHaveAttribute('title', 'New Thread')
})

it('运行时就绪前不给侧栏每个会话预取全量历史', async () => {
  sessionHarness.enabled = false
  sessionHarness.durable = false
  sessionHarness.messages.mockClear()

  // 本地（非运行时）模式仍然按会话拉取，保证预览能力没被过度跳过。
  const legacy = render(
    <ThreadList threads={[makeThread({ id: 'legacy-1' }), makeThread({ id: 'legacy-2' })]} />
  )
  await flushEffects()
  await waitFor(() => expect(sessionHarness.messages).toHaveBeenCalledTimes(2))
  legacy.unmount()

  // 运行时已接管会话：即便 capabilities 还没带回 sessionEvents，也不能预取，
  // 否则启动瞬间会对列表里每个会话各发一次 /events 全量拉取。
  sessionHarness.durable = true
  sessionHarness.messages.mockClear()
  const runtime = render(
    <ThreadList
      threads={[
        makeThread({ id: 'runtime-1', metadata: { targetId: 'target-a' } }),
        makeThread({ id: 'runtime-2', metadata: { targetId: 'target-a' } }),
      ]}
    />
  )
  await flushEffects()
  expect(sessionHarness.messages).not.toHaveBeenCalled()
  runtime.unmount()
  sessionHarness.durable = false
})
})


it('Session侧栏目标隔离且host摘要刷新运行状态，复用持久未读水位', async () => {
  sessionHarness.enabled = true
  sessionHarness.listeners = []
  sessionHarness.fetch.mockResolvedValue([])
  const thread = makeThread({ id: 's', title: '目标会话', metadata: { targetId: 'target-a', runtimeSession: { id: 's', running: true } } })
  const wrong = makeThread({ id: 'wrong', title: '其他目标', metadata: { targetId: 'target-b' } })
  const { rerender, unmount } = render(<ThreadList threads={[thread, wrong]} />)
  await screen.findByText('Running')
  expect(screen.queryByText('其他目标')).not.toBeInTheDocument()
  await waitFor(() => expect(sessionHarness.fetch).toHaveBeenCalled())
  const count = sessionHarness.fetch.mock.calls.length
  act(() => sessionHarness.listeners.forEach(listener => listener({ payload: { targetId: 'target-a', kind: 'summary' } })))
  await waitFor(() => expect(sessionHarness.fetch.mock.calls.length).toBeGreaterThan(count))
  localStorage.setItem('bibit:session-read:["target-a","s"]', JSON.stringify({ readSeq: 0, terminalSeq: 9 }))
  rerender(<ThreadList threads={[{ ...thread, metadata: { ...thread.metadata, runtimeSession: { id: 's', running: false } } }]} />)
  await screen.findByText('Done, unread')
  act(() => { localStorage.setItem('bibit:session-read:["target-a","s"]', JSON.stringify({ readSeq: 9, terminalSeq: 9 })); window.dispatchEvent(new Event('bibit-session-read-changed')) })
  expect(screen.queryByText('Done, unread')).not.toBeInTheDocument()
  unmount()
  sessionHarness.enabled = false
  localStorage.clear()
})
