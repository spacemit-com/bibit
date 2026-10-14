import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ invoke: vi.fn(), epoch: 'e1' }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@/stores/runtime-store', () => ({ useRuntimeStore: (select: any) => select({ runtimeEpoch: h.epoch, runtimeId: 'bianbu' }) }))
import { useRuntimeAgents } from '../useRuntimeAgents'
const agent = (id: string, available = true, unavailableReason = available ? '' : '离线') => ({ id, name: id, zhName: '', available, unavailableReason })
beforeEach(() => {
  localStorage.clear()
  h.epoch = 'e1'
  h.invoke.mockReset().mockImplementation(async name => name === 'runtime_agents_list' ? [agent('a')] : { targetId: 't1', runtimeEpoch: h.epoch })
})
it('禁用不请求；唯一可用 Agent 自动选中', async () => {
  const view = renderHook(({ enabled }) => useRuntimeAgents(enabled), { initialProps: { enabled: false } })
  await act(async () => {})
  expect(h.invoke).not.toHaveBeenCalled()
  view.rerender({ enabled: true })
  await act(async () => {})
  expect(view.result.current.selected?.id).toBe('a')
  expect(view.result.current.targetId).toBe('t1')
})
it('多个 Agent 需选择，只恢复当前目标有效的上次选择', async () => {
  h.invoke.mockImplementation(async name => name === 'runtime_agents_list' ? [agent('a'), agent('b'), agent('c', false)] : { targetId: 't1', runtimeEpoch: h.epoch })
  localStorage.setItem('bibit:agent:t1', 'c')
  const first = renderHook(() => useRuntimeAgents(true))
  await act(async () => {})
  expect(first.result.current.selected).toBeUndefined()
  act(() => first.result.current.select('c'))
  expect(first.result.current.selected).toBeUndefined()
  act(() => first.result.current.select('b'))
  expect(first.result.current.selected?.id).toBe('b')
  first.unmount()
  const next = renderHook(() => useRuntimeAgents(true))
  await act(async () => {})
  expect(next.result.current.selected?.id).toBe('b')
  h.epoch = 'e2'
  h.invoke.mockImplementation(async name => name === 'runtime_agents_list' ? [agent('a'), agent('b')] : { targetId: 't2', runtimeEpoch: h.epoch })
  next.rerender()
  expect(next.result.current.selected).toBeUndefined()
  await act(async () => {})
  expect(next.result.current.selected).toBeUndefined()
})
it('列表读取途中身份变化拒绝使用列表；刷新可恢复', async () => {
  let calls = 0
  h.invoke.mockImplementation(async name => name === 'runtime_agents_list' ? [agent('a')] : { targetId: ++calls === 1 ? 'old' : 'new', runtimeEpoch: 'e1' })
  const view = renderHook(() => useRuntimeAgents(true))
  await act(async () => {})
  expect(view.result.current.selected).toBeUndefined()
  expect(view.result.current.reason).toContain('The service changed')
  act(() => view.result.current.refresh())
  await act(async () => {})
  expect(view.result.current.selected?.id).toBe('a')
  expect(view.result.current.targetId).toBe('new')
})
it('无可用 Agent 保留不可用原因，禁止选中', async () => {
  h.invoke.mockImplementation(async name => name === 'runtime_agents_list' ? [agent('a', false)] : { targetId: 't1', runtimeEpoch: 'e1' })
  const view = renderHook(() => useRuntimeAgents(true))
  await act(async () => {})
  expect(view.result.current.reason).toBe('No assistants available')
  expect(view.result.current.agents[0].unavailableReason).toBe('离线')
  expect(view.result.current.selected).toBeUndefined()
})

it('允许选择缺少模型的助手并提示前往专家设置', async () => {
  h.invoke.mockImplementation(async name => name === 'runtime_agents_list' ? [agent('draft', false, 'agent_model_required')] : { targetId: 't1', runtimeEpoch: 'e1' })
  const view = renderHook(() => useRuntimeAgents(true))
  await act(async () => {})
  act(() => view.result.current.select('draft'))
  expect(view.result.current.selected?.id).toBe('draft')
  expect(view.result.current.modelRequired).toBe(true)
  expect(view.result.current.reason).toBe(
    'This assistant has no model configured yet. Configure one on the Experts page in Settings.'
  )
})

it('目标切换后旧列表迟到不能覆盖新目标的选择', async () => {
  let finishOld!: (value: unknown) => void
  let listCalls = 0
  h.invoke.mockImplementation(async name => name === 'runtime_agents_list'
    ? ++listCalls === 1 ? new Promise(resolve => { finishOld = resolve }) : [agent('new-agent')]
    : { targetId: h.epoch === 'e1' ? 'old-target' : 'new-target', runtimeEpoch: h.epoch })
  const view = renderHook(() => useRuntimeAgents(true))
  await act(async () => {})
  h.epoch = 'e2'
  view.rerender()
  await act(async () => {})
  expect(view.result.current.selected?.id).toBe('new-agent')
  await act(async () => finishOld([agent('old-agent')]))
  expect(view.result.current.selected?.id).toBe('new-agent')
  expect(view.result.current.targetId).toBe('new-target')
})

it('未选择时使用 Runtime 内置专家，其他专家与默认助手分开，且可恢复默认', async () => {
  h.invoke.mockImplementation(async name => name === 'runtime_agents_list'
    ? [{ ...agent('builtin'), origin: 'system' }, { ...agent('expert-b'), origin: 'user' }]
    : { targetId: 't1', runtimeEpoch: h.epoch })
  const view = renderHook(() => useRuntimeAgents(true))
  await act(async () => {})
  expect(view.result.current.selected?.id).toBe('builtin')
  expect(view.result.current.usingDefault).toBe(true)
  expect(view.result.current.defaultAgent?.id).toBe('builtin')
  expect(view.result.current.experts.map(item => item.id)).toEqual(['expert-b'])
  // 外部写入内置专家 ID 时，界面仍按“当前是默认助手”呈现，而不是当成自选专家。
  act(() => view.result.current.select('builtin'))
  expect(view.result.current.selected?.id).toBe('builtin')
  expect(view.result.current.usingDefault).toBe(true)
  act(() => view.result.current.select('expert-b'))
  expect(view.result.current.selected?.id).toBe('expert-b')
  expect(view.result.current.usingDefault).toBe(false)
  expect(localStorage.getItem('bibit:agent:t1')).toBe('expert-b')
  view.unmount()
  const next = renderHook(() => useRuntimeAgents(true))
  await act(async () => {})
  expect(next.result.current.selected?.id).toBe('expert-b')
  act(() => next.result.current.useDefault())
  expect(next.result.current.selected?.id).toBe('builtin')
  expect(next.result.current.usingDefault).toBe(true)
  expect(localStorage.getItem('bibit:agent:t1')).toBeNull()
})
