import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { useSessionSearch } from '../useSessionSearch'
import { useRuntimeStore } from '@/stores/runtime-store'

const hit = {
  sessionId: 'session-1',
  title: 'Bibit 使用说明',
  updatedAt: 1,
  seq: 42,
  role: 'user',
  snippet: '…提到 Runtime 的地方…',
  matchStart: 4,
  matchLength: 7,
}

const withCapability = (sessionSearch: boolean) =>
  useRuntimeStore.setState({
    enabled: true,
    capabilities: {
      durableSessions: true,
      detachedRuns: true,
      replayableEvents: true,
      runtimeOwnedApprovals: true,
      sessionSearch,
    },
  })

describe('会话正文检索', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.invoke.mockReset()
    withCapability(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('能力位关闭时不问 Runtime，也不展示任何命中', () => {
    withCapability(false)
    const { result } = renderHook(() => useSessionSearch('runtime', true))
    act(() => vi.advanceTimersByTime(1000))
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(result.current.hits).toEqual([])
  })

  it('输入停顿后才发起检索，并把命中交回界面', async () => {
    mocks.invoke.mockResolvedValue([hit])
    const { result } = renderHook(() => useSessionSearch('runtime', true))
    expect(mocks.invoke).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(mocks.invoke).toHaveBeenCalledWith('runtime_sessions_search', { query: 'runtime', limit: 20 })
    expect(result.current.hits).toEqual([hit])
    expect(result.current.loading).toBe(false)
  })

  it('旧 Runtime 没有检索端点时安静退回：只标记不可用，不冒泡错误', async () => {
    mocks.invoke.mockRejectedValue({ code: 'unsupported_operation', details: { httpStatus: 404 } })
    const { result } = renderHook(() => useSessionSearch('runtime', true))
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current.hits).toEqual([])
    expect(result.current.unavailable).toBe(true)
  })

  it('查询被清空后不再保留上一次的命中', async () => {
    mocks.invoke.mockResolvedValue([hit])
    const { result, rerender } = renderHook(({ query }) => useSessionSearch(query, true), {
      initialProps: { query: 'runtime' },
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current.hits).toHaveLength(1)
    rerender({ query: '   ' })
    expect(result.current.hits).toEqual([])
  })
})
