import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Tool, ToolApprovalActions, ToolHeader, ToolContent, ToolOutput } from '../tool'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useToolApproval } from '@/hooks/useToolApproval'

const h = vi.hoisted(() => ({
  surface: 'main' as 'main' | 'status-popup',
  invoke: vi.fn(),
}))

vi.mock('@/lib/window-surface', () => ({
  currentWindowSurface: () => h.surface,
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { toolApproval: 'tool-approval-settings' },
}))
vi.mock('zustand/middleware', () => ({
  persist: (fn: unknown) => fn,
  createJSONStorage: () => ({
    getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(),
  }),
}))

describe('ToolApprovalActions', () => {
  beforeEach(() => {
    h.surface = 'main'
    h.invoke.mockReset()
    useToolApprovalRequests.getState().resetForTests()
    useToolApproval.setState({ approvedTools: {}, allowAllMCPPermissions: false })
  })

  it('keeps details controlled by the caller across approval and execution updates', () => {
    const view = (state: 'input-available' | 'output-available', approvalPending = false) => (
      <Tool state={state} defaultOpen={false} approvalPending={approvalPending}>
        <ToolHeader title="检查磁盘" type="tool-terminal" state={state} />
        <ToolContent title="检查磁盘">磁盘输出</ToolContent>
      </Tool>
    )
    const { rerender } = render(view('input-available'))
    const trigger = screen.getByRole('button', { expanded: false })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    rerender(view('input-available', true))
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    rerender(view('output-available'))
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(trigger)
    rerender(view('input-available', true))
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('工具输出在用户上翻后保留位置，返回最新后恢复跟随', () => {
    const view = (output: string) => <Tool state="input-available" defaultOpen>
      <ToolOutput output={output} errorText={undefined} resolver={async value => value} followOutput />
    </Tool>
    const { rerender } = render(view('first'))
    const content = screen.getByTestId('tool-output-scroll')
    Object.defineProperties(content, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    })
    content.scrollTop = 100
    fireEvent.scroll(content)
    rerender(view('second'))
    expect(content.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(content.scrollTop).toBe(1000)
    Object.defineProperty(content, 'scrollHeight', { value: 1200 })
    rerender(view('third'))
    expect(content.scrollTop).toBe(1200)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument()
  })

  it('renders the PermissionPresenterHost decision UI on the real inline path', async () => {
    const approval = useToolApprovalRequests.getState().requestApproval(
      'tc-inline',
      'shell',
      'thread-1',
      { command: 'private command' }
    )
    render(
      <Tool state="input-available" toolCallId="tc-inline">
        <ToolApprovalActions />
      </Tool>
    )

    fireEvent.click(screen.getByRole('button', {
      name: 'Deny',
    }))
    await expect(approval).resolves.toBe(false)
    expect(useToolApprovalRequests.getState().pending['tc-inline']).toBeUndefined()
  })

  it('keeps approval read-only inside the status popup', () => {
    h.surface = 'status-popup'
    void useToolApprovalRequests.getState().requestApproval(
      'tc-popup',
      'shell',
      'thread-1'
    )

    render(
      <Tool state="input-available" toolCallId="tc-popup">
        <ToolApprovalActions />
      </Tool>
    )

    expect(screen.getByText('Awaiting approval in the main window')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Deny' })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open main window' }))
    expect(h.invoke).toHaveBeenCalledWith('open_main_window')
    expect(
      useToolApprovalRequests.getState().pending['tc-popup']
    ).toBeDefined()
  })
})
