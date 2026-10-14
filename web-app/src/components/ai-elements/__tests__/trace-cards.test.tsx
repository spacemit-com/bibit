import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from '@/i18n/setup'
import { describeToolRow, type TraceGroupItem } from '@/lib/trace-presentation'
import { TraceGroup } from '../trace-group'
import { Tool, ToolHeader } from '../tool'

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options)
beforeAll(() => {
  i18n.changeLanguage('zh-CN')
})

const done: TraceGroupItem = {
  kind: 'tool',
  name: 'read_file',
  input: { path: 'src/app.ts' },
  status: 'completed',
}
const running: TraceGroupItem = {
  ...done,
  status: 'running',
}

describe('TraceGroup', () => {
  it('keeps a settled run collapsed and counts its steps', () => {
    render(
      <TraceGroup items={[done, done]}>
        <p>row one</p>
      </TraceGroup>
    )
    const header = screen.getByTestId('trace-group-header')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(header).toHaveTextContent('已完成 2 步')
    expect(screen.queryByText('row one')).not.toBeInTheDocument()

    fireEvent.click(header)
    expect(screen.getByText('row one')).toBeInTheDocument()
  })

  it('announces the current step while the run is live, without opening itself', () => {
    render(
      <TraceGroup items={[done, running]} isStreaming>
        <p>row one</p>
      </TraceGroup>
    )
    const header = screen.getByTestId('trace-group-header')
    expect(header).toHaveTextContent('正在工作 · 第 2 步 · 读取 src/app.ts')
    // Icon plus colour carry the state alongside the words, so the row is still
    // readable in greyscale.
    expect(header.querySelector('svg.lucide-loader-circle')).toHaveClass(
      'text-trace-status-running'
    )
    expect(header).toHaveAttribute('aria-expanded', 'false')
  })

  it('names the thought itself when the thought is the live step', () => {
    render(
      <TraceGroup
        items={[{ kind: 'reasoning', streaming: true }, done]}
        isStreaming
      >
        <p>row one</p>
      </TraceGroup>
    )
    expect(screen.getByTestId('trace-group-header')).toHaveTextContent(
      '正在思考 · 第 1 步'
    )
  })

  it('reports the wall-clock duration it actually watched', () => {
    vi.useFakeTimers()
    const view = (streaming: boolean) => (
      <TraceGroup items={[done, done]} isStreaming={streaming}>
        <p>row one</p>
      </TraceGroup>
    )
    const { rerender } = render(view(true))
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    rerender(view(false))
    expect(screen.getByTestId('trace-group-header')).toHaveTextContent(
      '已完成 2 步 · 用时 3 秒'
    )
    vi.useRealTimers()
  })

  it('keeps counting from the first live frame when the group pauses and resumes', () => {
    vi.useFakeTimers()
    const view = (streaming: boolean) => (
      <TraceGroup items={[done, done]} isStreaming={streaming}>
        <p>row one</p>
      </TraceGroup>
    )
    const { rerender } = render(view(true))
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    rerender(view(false))
    expect(screen.getByTestId('trace-group-header')).toHaveTextContent(
      '已完成 2 步 · 用时 3 秒'
    )

    // The model thinks between two tool calls, then one delta closes the group
    // a moment later. That last flicker must not become the reported duration.
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    rerender(view(true))
    act(() => {
      vi.advanceTimersByTime(500)
    })
    rerender(view(false))
    expect(screen.getByTestId('trace-group-header')).toHaveTextContent(
      '已完成 2 步 · 用时 8 秒'
    )
    vi.useRealTimers()
  })

  it('leaves the duration out of a group that was live for under a second', () => {
    vi.useFakeTimers()
    const view = (streaming: boolean) => (
      <TraceGroup items={[done, done]} isStreaming={streaming}>
        <p>row one</p>
      </TraceGroup>
    )
    const { rerender } = render(view(true))
    act(() => {
      vi.advanceTimersByTime(400)
    })
    rerender(view(false))
    const header = screen.getByTestId('trace-group-header')
    expect(header).toHaveTextContent('已完成 2 步')
    expect(header).not.toHaveTextContent('秒')
    vi.useRealTimers()
  })

  it('pins itself open for a pending approval and never closes on its own', () => {
    const items: TraceGroupItem[] = [done, { kind: 'permission', pending: true }]
    const { rerender } = render(
      <TraceGroup items={items} forceOpen>
        <p>row one</p>
      </TraceGroup>
    )
    expect(screen.getByTestId('trace-group-header')).toHaveTextContent(
      '1 个操作等待审批'
    )
    expect(screen.getByText('row one')).toBeInTheDocument()

    rerender(
      <TraceGroup items={[done, { kind: 'permission', pending: false }]}>
        <p>row one</p>
      </TraceGroup>
    )
    expect(screen.getByTestId('trace-group-header')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('opens for a diagnostic so a stopped run still says what happened', () => {
    render(
      <TraceGroup items={[done, { kind: 'diagnostic' }]}>
        <p>任务已停止。</p>
      </TraceGroup>
    )
    expect(screen.getByTestId('trace-group-header')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('任务已停止。')).toBeInTheDocument()
  })

  it('leaves each row its own toggle', async () => {
    const user = userEvent.setup()
    render(
      <TraceGroup items={[done, done]}>
        <Tool state="output-available">
          <ToolHeader
            title="read_file"
            type="tool-read_file"
            state="output-available"
            input={{ path: 'a.ts' }}
          />
        </Tool>
        <Tool state="output-available">
          <ToolHeader
            title="read_file"
            type="tool-read_file"
            state="output-available"
            input={{ path: 'b.ts' }}
          />
        </Tool>
      </TraceGroup>
    )
    fireEvent.click(screen.getByTestId('trace-group-header'))
    const rows = screen.getAllByRole('button', { expanded: false })
    const [first] = rows
    await user.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'true')
    expect(rows[1]).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('trace rows', () => {
  it('offers the chevron as the expand affordance and honours the keyboard', async () => {
    const user = userEvent.setup()
    render(
      <TraceGroup items={[done, done]}>
        <p>row one</p>
      </TraceGroup>
    )
    const header = screen.getByTestId('trace-group-header')
    expect(header.querySelector('svg.lucide-chevron-right')).toHaveClass(
      'group-data-[state=open]/trace:rotate-90'
    )
    header.focus()
    await user.keyboard('{Enter}')
    expect(header).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('{Escape}')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(header).toHaveFocus()
  })

  it('builds the tool row from the request and never leaks JSON', () => {
    render(
      <Tool state="output-available">
        <ToolHeader
          title="read_file"
          type="tool-read_file"
          state="output-available"
          input={{ path: '/tmp/notes.md' }}
        />
      </Tool>
    )
    const header = screen.getByRole('button', { expanded: false })
    expect(header).toHaveTextContent('读取 /tmp/notes.md')
    expect(header).toHaveTextContent('read file')
    expect(header).toHaveTextContent('已完成')
    expect(header.textContent ?? '').not.toMatch(/[{}"]/)
  })

  it('shows the failure reason instead of a second status word', () => {
    const row = describeToolRow(
      {
        name: 'terminal',
        input: { command: 'rm -rf build' },
        error: 'permission denied',
        status: 'failed',
      },
      t
    )
    render(
      <Tool state="output-error">
        <ToolHeader
          title="terminal"
          type="tool-terminal"
          state="output-error"
          row={row}
        />
      </Tool>
    )
    const header = screen.getByRole('button', { expanded: false })
    expect(within(header).getByText('permission denied')).toBeInTheDocument()
    expect(within(header).getByText('执行失败')).toBeInTheDocument()
    expect(header).toHaveTextContent('执行命令 rm -rf build')
  })
})
