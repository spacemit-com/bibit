import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  hits: [] as Array<Record<string, unknown>>,
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('@/hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({ hits: mocks.hits, loading: false, unavailable: false }),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      threads: { 'thread-1': { id: 'thread-1', title: 'Bibit 标题命中' } },
      getFilteredThreads: () => [{ id: 'thread-1', title: 'Bibit 标题命中' }],
    }),
}))

import { SearchDialog } from '../SearchDialog'

const hit = {
  sessionId: 'thread-2',
  title: 'runtime 排查记录',
  updatedAt: 1,
  seq: 42,
  endSeq: 57,
  role: 'assistant',
  snippet: '…结论是 Runtime 侧没有索引…',
  matchStart: 6,
  matchLength: 7,
}

describe('搜索面板', () => {
  it('标题命中与正文命中分两组展示，点正文命中带上消息游标', () => {
    mocks.hits = [hit]
    render(<SearchDialog open onOpenChange={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'runtime' } })

    expect(screen.getByText('Bibit 标题命中')).toBeInTheDocument()
    const contentHit = screen.getByTestId('search-content-hit')
    expect(contentHit).toHaveTextContent('runtime 排查记录')
    expect(contentHit).toHaveTextContent('Runtime')

    fireEvent.click(contentHit)
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'thread-2' },
      // 用消息覆盖的最后一条分片开窗：只读到 seq 会截断助手回答。
      search: { seq: 57 },
    })
  })

  it('只有标题命中时不渲染正文分组', () => {
    mocks.hits = []
    mocks.navigate.mockClear()
    render(<SearchDialog open onOpenChange={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bibit' } })

    expect(screen.getByText('Bibit 标题命中')).toBeInTheDocument()
    expect(screen.queryByTestId('search-content-hit')).not.toBeInTheDocument()
  })
})
