import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeSession } from '@/lib/runtime-contract'
const mocks = vi.hoisted(() => ({ handler: undefined as undefined | ((event: { payload: unknown }) => void) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_name, handler) => { mocks.handler = handler; return vi.fn() }) }))
import { useSessionReadState } from '../useSessionReadState'
beforeEach(() => { localStorage.clear() })
it('切换会话时不把迟到旧feed的水位记到新会话', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const feed = { targetId: 'a', sessionId: 'old', events: [{ seq: 99, type: 'run/completed' }] } as never
  const hook = renderHook(() => useSessionReadState('a', 'new', feed))
  await act(async () => {})
  expect(localStorage.getItem('bibit:session-read:["a","new"]')).toBeNull()
  hook.unmount()
  vi.restoreAllMocks()
})
it('终态seq去重持久且目标隔离，聚焦已展示会话推进已读水位', async () => {
  const session = { id: 's', latestRun: undefined } as RuntimeSession
  const hook = renderHook(() => useSessionReadState('a'))
  await act(async () => {})
  act(() => { mocks.handler?.({ payload: { targetId: 'a', sessionId: 's', events: [{ seq: 5, type: 'run/completed' }] } }); mocks.handler?.({ payload: { targetId: 'a', sessionId: 's', events: [{ seq: 5, type: 'run/completed' }] } }) })
  expect(hook.result.current(session)).toBe(true)
  const persisted = localStorage.getItem('bibit:session-read:["a","s"]')
  expect(JSON.parse(persisted!).terminalSeq).toBe(5)
  hook.unmount()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const focused = renderHook(() => useSessionReadState('a', 's', { targetId: 'a', sessionId: 's', lastSeq: 999, events: [{ seq: 5, type: 'run/completed' }] } as never, [session]))
  await act(async () => {})
  expect(focused.result.current(session)).toBe(false)
  expect(JSON.parse(localStorage.getItem('bibit:session-read:[\"a\",\"s\"]')!).readSeq).toBe(5)
  focused.unmount()
  const other = renderHook(() => useSessionReadState('b'))
  expect(other.result.current(session)).toBe(false)
  vi.restoreAllMocks()
})
