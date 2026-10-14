import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ create: vi.fn(), runtime: { runtimeId: 'bianbu', runtimeEpoch: 'e1', capabilities: { sessionEvents: true } } }))
vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({ threads: () => ({ createThread: h.create }) }) }))
vi.mock('@/stores/runtime-store', () => ({ useRuntimeStore: { getState: () => h.runtime } }))
vi.mock('@/hooks/useAgentMode', () => ({ useAgentMode: {} }))
import { useThreads } from '../useThreads'

beforeEach(() => {
  h.runtime = { runtimeId: 'bianbu', runtimeEpoch: 'e1', capabilities: { sessionEvents: true } }
  h.create.mockReset().mockImplementation(async thread => thread)
  useThreads.setState({ threads: {}, currentThreadId: undefined, currentThreadTargetId: 'stale-target' })
})

it('创建明确绑定所选目标与真实 Agent', async () => {
  const created = await useThreads.getState().createThread({ id: 'agent-a', provider: 'runtime' }, '会话', false, 'target-a')
  expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: { targetId: 'target-a', agentId: 'agent-a' } }))
  expect(useThreads.getState().currentThreadId).toBe(created.id)
  expect(useThreads.getState().threads[created.id]).toBeDefined()
})

it.each(['epoch', 'target'] as const)('创建完成前切换 %s，不把旧结果插入或选中', async change => {
  let finish!: (value: Thread) => void
  let request!: Thread
  h.create.mockImplementation(thread => { request = thread; return new Promise(resolve => { finish = resolve }) })
  const creating = useThreads.getState().createThread({ id: 'agent-a', provider: 'runtime' }, '旧会话', false, 'target-a')
  if (change === 'epoch') h.runtime = { ...h.runtime, runtimeEpoch: 'e2' }
  useThreads.setState({ currentThreadId: 'new-session', currentThreadTargetId: change === 'target' ? 'target-b' : 'stale-target' })
  finish(request)
  expect((await creating).metadata?.targetId).toBe('target-a')
  expect(useThreads.getState().currentThreadId).toBe('new-session')
  expect(useThreads.getState().threads).toEqual({})
})
