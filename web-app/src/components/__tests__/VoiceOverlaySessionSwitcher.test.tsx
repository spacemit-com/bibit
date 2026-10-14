import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VoiceOverlaySessionSwitcher } from '../VoiceOverlaySessionSwitcher'
import { useThreads } from '@/hooks/useThreads'
import { useRuntimeStore } from '@/stores/runtime-store'

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))

vi.mock('@/hooks/useThreads')
vi.mock('@/stores/runtime-store')
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }))

describe('VoiceOverlaySessionSwitcher', () => {
  const mockSetCurrentThreadId = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(useThreads).mockReturnValue({
      threads: {
        'thread-1': {
          id: 'thread-1',
          title: 'K3 性能讨论',
          updated: 2000,
        },
        'thread-2': {
          id: 'thread-2',
          title: 'Python 脚本开发',
          updated: 1000,
        },
      },
      currentThreadId: undefined,
      setCurrentThreadId: mockSetCurrentThreadId,
    } as any)

    vi.mocked(useRuntimeStore).mockImplementation(
      (selector: any) => selector({ enabled: false })
    )
  })

    it('应该显示"新建对话"作为默认选项', async () => {
    render(<VoiceOverlaySessionSwitcher />)
    expect(screen.getByText('New Conversation')).toBeInTheDocument()
  })

    it('应该显示当前选中会话的标题', async () => {
    vi.mocked(useThreads).mockReturnValue({
      threads: {
        'thread-1': {
          id: 'thread-1',
          title: 'K3 性能讨论',
          updated: 2000,
        },
      },
      currentThreadId: 'thread-1',
      setCurrentThreadId: mockSetCurrentThreadId,
    } as any)

    render(<VoiceOverlaySessionSwitcher />)
    expect(screen.getByText('K3 性能讨论')).toBeInTheDocument()
  })

    it('点击下拉菜单应该显示会话列表', async () => {
    render(<VoiceOverlaySessionSwitcher />)

    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: /New Conversation/i })
    await user.click(trigger)

    // 应该显示两个历史会话
    expect(screen.getByText('K3 性能讨论')).toBeInTheDocument()
    expect(screen.getByText('Python 脚本开发')).toBeInTheDocument()
  })

    it('选择会话后应该调用 setCurrentThreadId', async () => {
    render(<VoiceOverlaySessionSwitcher />)

    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: /New Conversation/i })
    await user.click(trigger)

    const threadOption = screen.getByText('K3 性能讨论')
    await user.click(threadOption)

    expect(mockSetCurrentThreadId).toHaveBeenCalledWith('thread-1')
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'thread-1' },
      replace: true,
    })
  })

    it('应该按更新时间倒序排列会话', async () => {
    render(<VoiceOverlaySessionSwitcher />)

    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: /New Conversation/i })
    await user.click(trigger)

    const items = screen.getAllByRole('menuitem')
    // 第一个是"新建对话"
    expect(items[0]).toHaveTextContent('New Conversation')
    // 第二个应该是最新的 thread-1
    expect(items[1]).toHaveTextContent('K3 性能讨论')
    // 第三个是较旧的 thread-2
    expect(items[2]).toHaveTextContent('Python 脚本开发')
  })

    it('在 Runtime 模式下应该只显示 Runtime 会话', async () => {
 vi.mocked(useRuntimeStore).mockImplementation(
      (selector: any) => selector({ enabled: true })
    )

    vi.mocked(useThreads).mockReturnValue({
      threads: {
        'thread-1': {
          id: 'thread-1',
          title: 'Runtime 会话',
          metadata: { targetId: 'agent-1' },
          updated: 2000,
        },
        'thread-2': {
          id: 'thread-2',
          title: '本地会话',
          updated: 1000,
        },
      },
      currentThreadId: undefined,
      setCurrentThreadId: mockSetCurrentThreadId,
    } as any)

    render(<VoiceOverlaySessionSwitcher />)

    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: /New Conversation/i })
    await user.click(trigger)

    // 应该只显示 Runtime 会话
    expect(screen.getByText('Runtime 会话')).toBeInTheDocument()
    expect(screen.queryByText('本地会话')).not.toBeInTheDocument()
  })
})
