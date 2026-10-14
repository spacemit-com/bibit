import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useThreads } from '../useThreads'

// 这个文件刻意用真实的 fzf：大小写只取决于索引配置，替身会把它掩盖掉。
vi.mock('@/services/threads', () => ({
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  updateThread: vi.fn(),
}))

global.__TAURI_INTERNALS__ = {
  plugins: {
    path: {
      sep: '/',
    },
  },
}

const titles = [
  { id: 't-bibit', title: 'Bibit 使用说明' },
  { id: 't-runtime', title: 'runtime 性能排查' },
  { id: 't-other', title: '会议记录' },
]

describe('会话标题检索', () => {
  it('大小写都命中同一批标题', () => {
    const { result } = renderHook(() => useThreads())
    act(() => {
      result.current.setThreads(titles as never)
    })

    // fzf 默认的 smart-case 会让带大写字母的查询变成大小写敏感，
    // 于是 bibit 搜不到 Bibit，Runtime 也搜不到 runtime。
    expect(result.current.getFilteredThreads('bibit').map((thread) => thread.id)).toContain('t-bibit')
    expect(result.current.getFilteredThreads('BIBIT').map((thread) => thread.id)).toContain('t-bibit')
    expect(result.current.getFilteredThreads('Runtime').map((thread) => thread.id)).toContain('t-runtime')
    expect(result.current.getFilteredThreads('runtime').map((thread) => thread.id)).toContain('t-runtime')
    expect(result.current.getFilteredThreads('bibit').map((thread) => thread.id)).not.toContain('t-other')
  })

  it('中文标题仍按子串命中', () => {
    const { result } = renderHook(() => useThreads())
    act(() => {
      result.current.setThreads(titles as never)
    })

    expect(result.current.getFilteredThreads('会议').map((thread) => thread.id)).toEqual(['t-other'])
  })
})
