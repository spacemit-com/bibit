import { useVoiceSubmission } from '../useVoiceSubmission'
import { useVoiceInputStore } from '@/stores/voice-input-store'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionFeed } from '../useSessionFeed'

const h = vi.hoisted(() => ({ invoke: vi.fn(), loadOlder: vi.fn(), observe: vi.fn(), feed: undefined as SessionFeed | undefined, epoch: 'e1', selection: {} as Record<string, unknown> }))
vi.mock('../useThreads', () => ({ useThreads: { setState: (value: object) => Object.assign(h.selection, value), getState: () => h.selection } }))
vi.mock('@/features/conversation/runtimePermissionController', () => ({ observeRuntimePermission: h.observe }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@/stores/runtime-store', () => ({ useRuntimeStore: (select: any) => select({ runtimeEpoch: h.epoch, runtimeId: 'bianbu' }) }))
vi.mock('../useSessionFeed', () => ({ useSessionFeed: (_id: string, _epoch: string, enabled: boolean) => ({ feed: enabled ? h.feed : undefined, error: '', loadOlder: h.loadOlder, retry: vi.fn() }) }))
import { useSessionConversation } from '../useSessionConversation'
import { sessionUnread } from '../useSessionReadState'
import type { RuntimeSession } from '@/lib/runtime-contract'
import { usePrompt } from '../usePrompt'
import { sessionTitleKey, sessionTitleRequests } from '@/lib/session-title'
import { useConversationSyncStore } from '@/stores/conversation-sync-store'
import { saveSessionKnowledge } from '@/lib/session-knowledge'
import { useSessionExecutionStore } from '@/stores/session-execution-store'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  useSessionExecutionStore.setState({ executions: {} })
  sessionTitleRequests.clear()
  usePrompt.getState().resetPrompt()
  useConversationSyncStore.getState().reset()
  h.selection = {}
  h.loadOlder.mockReset().mockResolvedValue(true)
  h.observe.mockReset()
  h.epoch = 'e1'
  h.feed = { targetId: 'target-a', runtimeEpoch: 'e1', sessionId: 's1', events: [], hiddenRunIds: [], baseSeq: 0, lastSeq: 0, hasMore: false, connectionStatus: 'connected' }
  h.invoke.mockReset().mockImplementation(async (name: string) => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    if (name === 'runtime_session_pending' || name === 'runtime_sessions_list') return []
    return { accepted: true, status: 'claimed' }
  })
})

it('Runtime 执行视图报告运行中时，没有助手事件也保持 streaming', async () => {
  // 钩子阶段：Runtime 已认领但没有正文/思考事件，摘要帧是唯一的忙碌依据。
  h.feed = { ...h.feed!, summary: { sessions: [{ id: 's1', running: true, waiting: false, active_run_id: 'run-1' }] } }
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(view.result.current.status).toBe('streaming')
})

it('权威视图空闲且无未认领输入后回到 ready', async () => {
  h.feed = { ...h.feed!, summary: { sessions: [{ id: 's1', running: false, waiting: false, active_run_id: null }] } }
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(view.result.current.status).toBe('ready')
})

it('提交回执先到时不能释放仍在生成标题的窗口租约', async () => {
  let held = false
  let finishSubmit!: (value: unknown) => void
  let finishTitle!: () => void
  h.invoke.mockImplementation(async (name: string) => {
    if (name === 'runtime_controller_acquire') {
      const duplicate = held
      held = true
      return { accepted: true, duplicate }
    }
    if (name === 'runtime_controller_release') { held = false; return }
    if (name === 'runtime_session_pending' || name === 'runtime_sessions_list') return []
    if (name === 'runtime_session_submit') return new Promise(resolve => { finishSubmit = resolve })
    if (name === 'runtime_session_generate_title') {
      await new Promise<void>(resolve => { finishTitle = resolve })
      if (!held) throw new Error('controller_required')
      return { accepted: true }
    }
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  let sending!: Promise<unknown>
  await act(async () => { sending = view.result.current.send('并发标题验证') })
  const input = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')![1].request
  h.feed = { ...h.feed!, events: [{ seq: 1, time: 1, type: 'user/message', data: { message_id: input.messageId, content: input.content } }] }
  view.rerender()
  await act(async () => {})
  await act(async () => { finishSubmit({ accepted: true, status: 'claimed' }); await sending })
  const heldDuringTitle = held
  await act(async () => { finishTitle() })
  expect(heldDuringTitle).toBe(true)
  expect(held).toBe(false)
})

it('首条输入持久化后生成标题；重开不重复生成', async () => {
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => view.result.current.send('给项目起名'))
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_generate_title')).toBe(false)
  const input = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')![1].request
  h.feed = { ...h.feed!, events: [{ seq: 1, time: 1, type: 'user/message', data: { message_id: input.messageId, content: input.content } }] }
  view.rerender()
  await act(async () => {})
  expect(h.invoke).toHaveBeenCalledWith('runtime_session_generate_title', { expectedTargetId: 'target-a', sessionId: 's1', messageId: input.messageId, content: input.content })
  view.unmount()
  renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(h.invoke.mock.calls.filter(([name]) => name === 'runtime_session_generate_title')).toHaveLength(1)
})

it('手动改名标记阻止迟到输入事件触发自动标题', async () => {
  localStorage.setItem(sessionTitleKey('target-a', 's1'), JSON.stringify({ messageId: 'm1', content: '首条消息', manual: true }))
  h.feed!.events = [{ seq: 1, time: 1, type: 'user/message', data: { message_id: 'm1', content: '首条消息' } }]
  renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_generate_title')).toBe(false)
})

it('首条消息仅在绑定目标发送一次，接受后清理暂存', async () => {
  sessionStorage.setItem('initial-message-s1', JSON.stringify({ targetId: 'target-a', sessionId: 's1', messageId: 'first-1', text: '首页消息' }))
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  view.rerender()
  await act(async () => {})
  const calls = h.invoke.mock.calls.filter(([name]) => name === 'runtime_session_submit')
  expect(calls).toHaveLength(1)
  expect(calls[0][1].request).toMatchObject({ targetId: 'target-a', sessionId: 's1', messageId: 'first-1', content: '首页消息' })
  expect(sessionStorage.getItem('initial-message-s1')).toBeNull()
  expect(usePrompt.getState().prompt).toBe('')
})

it.each([
  { targetId: 'target-b', sessionId: 's1', messageId: 'first-1', text: '其他目标' },
  { text: '未绑定的旧输入' },
])('不自动发送其他目标或未绑定的首条消息 %j', async payload => {
  sessionStorage.setItem('initial-message-s1', JSON.stringify(payload))
  renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)
  expect(sessionStorage.getItem('initial-message-s1')).not.toBeNull()
})

it('首条消息回执丢失后重开保留草稿，手动重试使用原 ID', async () => {
  sessionStorage.setItem('initial-message-s1', JSON.stringify({ targetId: 'target-a', sessionId: 's1', messageId: 'first-1', text: '首页消息' }))
  h.invoke.mockImplementation(async (name: string) => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    if (name === 'runtime_session_pending' || name === 'runtime_sessions_list') return []
    if (name === 'runtime_session_submit') throw new Error('回执丢失')
  })
  const first = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  first.unmount()
  const second = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(h.invoke.mock.calls.filter(([name]) => name === 'runtime_session_submit')).toHaveLength(1)
  expect(usePrompt.getState().prompt).toBe('首页消息')
  expect(sessionStorage.getItem('initial-message-s1')).not.toBeNull()
  await act(async () => { await expect(second.result.current.send('首页消息')).rejects.toThrow('回执丢失') })
  const requests = h.invoke.mock.calls.filter(([name]) => name === 'runtime_session_submit').map(([, args]) => args.request)
  expect(requests[0]).toEqual(requests[1])
})

it('首条消息已有持久化事件时只清暂存，不再次发送', async () => {
  sessionStorage.setItem('initial-message-s1', JSON.stringify({ targetId: 'target-a', sessionId: 's1', messageId: 'first-1', text: '首页消息' }))
  h.feed!.events = [{ seq: 1, time: 1, type: 'user/message', data: { message_id: 'first-1', content: '首页消息' } }]
  renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)
  expect(sessionStorage.getItem('initial-message-s1')).toBeNull()
})

it('禁用时不发送命令；会话或 epoch 不匹配时不暴露消息', async () => {
  const { result, rerender } = renderHook(({ enabled }) => useSessionConversation('s1', enabled), { initialProps: { enabled: false } })
  await act(async () => {})
  expect(h.invoke).not.toHaveBeenCalled()
  h.feed = { ...h.feed!, sessionId: 'old', events: [{ seq: 1, time: 1, type: 'user/message', data: { message_id: 'old', content: '旧消息' } }] }
  rerender({ enabled: true })
  expect(result.current.messages).toEqual([])
  expect(result.current.ready).toBe(false)
})

it('未知回执原样重试复用 message ID，成功后同内容可作为新消息', async () => {
  let failed = true
  h.invoke.mockImplementation(async (name: string) => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    if (name === 'runtime_session_pending' || name === 'runtime_sessions_list') return []
    if (name === 'runtime_session_submit' && failed) { failed = false; throw new Error('回执丢失') }
    return { accepted: true, status: 'claimed' }
  })
  const { result, rerender } = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => { await expect(result.current.send('测试', undefined, [], ['skill-1', 'skill-1'])).rejects.toThrow('回执丢失') })
  h.epoch = 'e2'
  h.feed = { ...h.feed!, runtimeEpoch: 'e2' }
  rerender()
  await act(async () => {})
  await act(async () => { expect(await result.current.send('测试', undefined, [], ['skill-2'])).toEqual({ skillIds: ['skill-1'] }) })
  const submitted = () => h.invoke.mock.calls.filter(([name]) => name === 'runtime_session_submit').map(([, args]) => args.request)
  expect(submitted()[0]).toEqual(submitted()[1])
  expect(submitted()[0]).toMatchObject({ targetId: 'target-a', sessionId: 's1', content: '测试', skillIds: ['skill-1'] })
  await act(async () => { await result.current.send('测试', undefined, [], ['skill-2']) })
  expect(submitted()[2].skillIds).toEqual(['skill-2'])
  expect(submitted()[2].messageId).not.toBe(submitted()[0].messageId)
})

it('附件引用随未知回执持久化，重试沿用原引用和 message ID', async () => {
  let failed = true
  h.invoke.mockImplementation(async (name: string) => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    if (name === 'runtime_session_pending' || name === 'runtime_sessions_list') return []
    if (name === 'runtime_session_submit' && failed) { failed = false; throw new Error('回执丢失') }
    return { accepted: true, status: 'claimed' }
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => {
    await expect(view.result.current.send('读取附件', undefined, [{ resourceId: 'resource-1' }])).rejects.toThrow('回执丢失')
  })
  await act(async () => { await view.result.current.send('读取附件') })
  const requests = h.invoke.mock.calls
    .filter(([name]) => name === 'runtime_session_submit')
    .map(([, args]) => args.request)
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(requests[0]).toMatchObject({
    messageId: expect.any(String),
    attachments: [{ resourceId: 'resource-1' }],
  })
})

it('提交前按 resource ID 去重附件引用', async () => {
  h.invoke.mockImplementation(async (name: string) => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    if (name === 'runtime_session_pending' || name === 'runtime_sessions_list') return []
    return { accepted: true, status: 'claimed' }
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => {
    await view.result.current.send('读取附件', undefined, [
      { resourceId: 'resource-1' },
      { resourceId: 'resource-1' },
    ])
  })

  const request = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')?.[1].request
  expect(request.attachments).toEqual([{ resourceId: 'resource-1' }])
})

it('从 Session 投影正文并按当前 Run 取消，不调用旧 Run 发送接口', async () => {
  h.feed!.events = [{ seq: 1, time: 1, type: 'assistant/text.delta', run_id: 'r1', data: { text: '正在输出' } }]
  const { result } = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(result.current.messages[0].parts).toContainEqual(expect.objectContaining({ type: 'text', text: '正在输出' }))
  expect(result.current.status).toBe('streaming')
  await act(async () => { await result.current.stop() })
  expect(h.invoke).toHaveBeenCalledWith('runtime_session_cancel', { sessionId: 's1', runId: 'r1', expectedTargetId: 'target-a' })
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_run_start')).toBe(false)
})

it.each([['reject', 'deny'], ['approve', 'allow_once']] as const)('恢复审批时遵守服务端允许的决定，并显示解决结果 %s', async (decision, expectedDecision) => {
  h.feed!.events = [{ seq: 1, time: 1788600000, type: 'approval/requested', run_id: 'r1', data: {
    approval_id: 'approval-1', tool_call_id: 'tool-1', title: '文件访问',
    actions: [{ kind: 'filesystem', name: 'read', allowed_decisions: ['reject'], arguments: { path: '/tmp/test', token: 'secret-value' } }],
  } }]
  const { result, rerender } = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(h.observe).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'target-a', sessionId: 's1', requestId: 'approval-1', runId: 'r1', canAllowOnce: false, canDeny: true, status: 'pending' }))
  expect(h.observe.mock.calls[0][0].actions[0].summary).not.toContain('secret-value')
  expect(result.current.messages[0].parts[0]).toMatchObject({ type: 'data-runtime-permission', data: h.observe.mock.calls[0][0] })
  await act(async () => { await expect(result.current.send('继续')).rejects.toThrow('Wait for the approval to be resolved') })
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)
  h.feed = { ...h.feed!, events: [...h.feed!.events, { seq: 2, time: 1788600001, type: 'approval/resolved', run_id: 'r1', data: { approval_id: 'approval-1', decision } }] }
  rerender()
  await act(async () => {})
  expect(h.observe).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'approval-1', status: 'resolved', decision: expectedDecision }))
  expect(result.current.messages[0].parts[0]).toMatchObject({ type: 'data-runtime-permission', data: h.observe.mock.calls.at(-1)![0] })
  expect(result.current.waiting).toBe(false)
})

it('草稿跨重开恢复，按目标隔离，导航造成的清空不能覆盖旧会话草稿', async () => {
  const first = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  act(() => usePrompt.getState().setPrompt('目标 A 草稿'))
  h.selection.currentThreadId = 's2'
  act(() => usePrompt.getState().setPrompt(''))
  first.unmount()
  const next = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(usePrompt.getState().prompt).toBe('目标 A 草稿')
  h.feed = { ...h.feed!, targetId: 'target-b' }
  next.rerender()
  await act(async () => {})
  expect(usePrompt.getState().prompt).toBe('')
  act(() => usePrompt.getState().setPrompt('目标 B 草稿'))
  h.feed = { ...h.feed!, targetId: 'target-a' }
  next.rerender()
  await act(async () => {})
  expect(usePrompt.getState().prompt).toBe('目标 A 草稿')
})

it('窗口同步草稿在 Session 页面挂载时优先于本地旧值并持久化', async () => {
  const key = 'bibit:session-draft:["target-a","s1"]'
  localStorage.setItem(key, JSON.stringify({ content: '旧草稿' }))
  useConversationSyncStore.setState({ drafts: { s1: '你好，我是语音自测' } })

  renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})

  expect(usePrompt.getState().prompt).toBe('你好，我是语音自测')
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ content: '你好，我是语音自测', draftToken: expect.any(String) })
})


it('历史操作缺少前页目标时先加载依赖，不显示错误分支且不允许发送', async () => {
  const change = { seq: 5, time: 5, type: 'conversation/changed', data: {
    action: 'edit', operation_id: 'edit', message_id: 'u', content: '修订问题' } }
  h.feed = { ...h.feed!, baseSeq: 5, lastSeq: 5, hasMore: true, events: [change] }
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(h.loadOlder).toHaveBeenCalledTimes(1)
  expect(view.result.current.ready).toBe(false)
  expect(view.result.current.messages).toEqual([])
  view.rerender()
  await act(async () => {})
  expect(h.loadOlder).toHaveBeenCalledTimes(1)
  h.feed = { ...h.feed!, baseSeq: 0, hasMore: false, events: [
    { seq: 0, time: 0, type: 'user/message', run_id: 'r', data: { message_id: 'u', content: '原问题' } }, change] }
  view.rerender()
  await act(async () => {})
  expect(view.result.current.ready).toBe(true)
  expect(view.result.current.messages[0].parts).toContainEqual({ type: 'text', text: '修订问题' })
})

it('生成缺少历史操作时补页，加载失败不循环请求或发送', async () => {
  h.loadOlder.mockResolvedValue(false)
  h.feed = { ...h.feed!, baseSeq: 8, lastSeq: 9, hasMore: true, events: [
    { seq: 8, time: 8, type: 'user/message', run_id: 'r2', data: { message_id: 'u', content: '原问题',
      request: { metadata: { history_operation_id: 'continue-op' } } } },
    { seq: 9, time: 9, type: 'run/completed', run_id: 'r2', data: { content: '新增正文' } }] }
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await expect(view.result.current.send('不能误发')).rejects.toThrow('Session is not ready yet')
  view.rerender()
  await act(async () => {})
  expect(h.loadOlder).toHaveBeenCalledTimes(1)
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)
  expect(view.result.current.messages).toEqual([])
  h.feed = { ...h.feed!, hasMore: false }
  view.rerender()
  expect(view.result.current.error).toContain('has no history action')
  expect(view.result.current.ready).toBe(false)
})

it('历史命令未知回执重开后复用操作 ID，原事件确认后清理', async () => {
  h.feed = { ...h.feed!, lastSeq: 99, events: [
    { seq: 0, time: 0, type: 'user/message', run_id: 'r', data: { message_id: 'u', content: '原问题' } },
    { seq: 2, time: 2, type: 'run/completed', run_id: 'r', data: { content: '回答' } }] }
  h.invoke.mockImplementation(async (name: string, args: any) => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    if (name === 'runtime_session_pending' || name === 'runtime_sessions_list') return []
    if (name === 'runtime_session_history') throw new Error('连接中断')
    return { accepted: true }
  })
  let view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => { await expect(view.result.current.changeHistory('edit', 'u', '新问题')).rejects.toThrow() })
  const first = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_history')![1].request
  expect(first).toMatchObject({ targetId: 'target-a', sessionId: 's1', expectedSeq: 2, action: 'edit', messageId: 'u', content: '新问题' })
  view.unmount()
  view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(view.result.current.pendingHistory?.operationId).toBe(first.operationId)
  await act(async () => { await expect(view.result.current.retryHistory()).rejects.toThrow() })
  const calls = h.invoke.mock.calls.filter(([name]) => name === 'runtime_session_history')
  expect(calls[1][1].request).toEqual(first)
  h.feed = { ...h.feed!, lastSeq: 3, events: [...h.feed!.events, { seq: 3, time: 3, type: 'conversation/changed', data: {
    operation_id: first.operationId, action: 'edit', message_id: 'u', content: '新问题' } }] }
  view.rerender()
  await act(async () => {})
  expect(localStorage.getItem('bibit:session-history:' + JSON.stringify(['target-a', 's1']))).toBeNull()
})

it('历史事件先确认后网络才报错时保留成功结果', async () => {
  h.feed = { ...h.feed!, events: [{ seq: 0, time: 0, type: 'user/message', run_id: 'r', data: { message_id: 'u', content: '原问题' } }] }
  let rejectRequest!: (error: Error) => void
  h.invoke.mockImplementation(async (name: string) => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    if (name === 'runtime_session_pending' || name === 'runtime_sessions_list') return []
    if (name === 'runtime_session_history') return new Promise((_resolve, reject) => { rejectRequest = reject })
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  let pending!: Promise<void>
  await act(async () => { pending = view.result.current.changeHistory('edit', 'u', '修订') })
  const request = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_history')![1].request
  h.feed = { ...h.feed!, events: [...h.feed!.events, { seq: 1, time: 1, type: 'conversation/changed', data: {
    operation_id: request.operationId, action: 'edit', message_id: 'u', content: '修订' } }] }
  view.rerender()
  await act(async () => { rejectRequest(new Error('迟到的网络错误')); await pending })
  expect(view.result.current.error).toBe('')
  expect(view.result.current.pendingHistory).toBeNull()
  expect(view.result.current.messages[0].parts).toContainEqual({ type: 'text', text: '修订' })
})

it('版本切换提交相邻版本 ID，越界不提交', async () => {
  h.feed = { ...h.feed!, events: [
    { seq: 0, time: 0, type: 'user/message', data: { message_id: 'u', content: '原问题' } },
    { seq: 1, time: 1, type: 'conversation/changed', data: { operation_id: 'edit', action: 'edit', message_id: 'u', content: '修订' } }] }
  h.invoke.mockImplementation(async (name: string, args: any) => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    if (name === 'runtime_session_pending' || name === 'runtime_sessions_list') return []
    if (name === 'runtime_session_history') return { accepted: true, operationId: args.request.operationId }
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  expect(view.result.current.versions['history:edit']).toMatchObject({ index: 2, count: 2 })
  await act(async () => view.result.current.switchVersion('history:edit', 1))
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_history')).toBe(false)
  await act(async () => view.result.current.switchVersion('history:edit', -1))
  expect(h.invoke.mock.calls.find(([name]) => name === 'runtime_session_history')![1].request).toMatchObject({ action: 'switch_version', messageId: 'u' })
})

it('知识库首页首发经过检索，保留输入ID、回放原问题与引用', async () => {
  const fallback = h.invoke.getMockImplementation()!
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') return { status: 'succeeded', data: { code: 0, data: { chunks: [{ id: 'c1', content: '测试参考内容', document_id: 'd1', document_keyword: '手册' }] } } }
    return fallback(name, args)
  })
  sessionStorage.setItem('initial-message-s1', JSON.stringify({ targetId: 'target-a', sessionId: 's1', messageId: 'kb-first', text: '问题', enableKnowledge: true }))
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  const request = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')![1].request
  expect(request.messageId).toBe('kb-first')
  expect(request.content).toContain('测试参考内容')
  h.feed!.events = [{ seq: 1, time: 1, type: 'user/message', data: { message_id: request.messageId, content: request.content } }]
  view.unmount()
  const restored = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(restored.result.current.messages[0].parts).toContainEqual({ type: 'text', text: '问题' })
  expect(restored.result.current.messages[0].metadata).toMatchObject({ knowledgeContext: { status: 'succeeded' } })
})

it('知识库检索失败保留草稿且不产生待确认提交', async () => {
  const fallback = h.invoke.getMockImplementation()!
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') throw new Error('离线')
    return fallback(name, args)
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  usePrompt.setState({ prompt: '问题' })
  await act(async () => { await expect(view.result.current.send('问题', undefined, [], [], true)).rejects.toThrow() })
  expect(usePrompt.getState().prompt).toBe('问题')
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)
  expect(view.result.current.pending).toHaveLength(0)
})

it('知识库未知回执再次发送冻结正文与ID，保留附件技能', async () => {
  const fallback = h.invoke.getMockImplementation()!
  let retrieved = 0
  let submissions = 0
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') return { status: 'succeeded', data: { code: 0, data: { chunks: [{ id: 'c1', content: `参考版本${++retrieved}`, document_id: 'd1', document_keyword: '手册' }] } } }
    if (name === 'runtime_session_submit' && ++submissions === 1) throw new Error('回执丢失')
    return fallback(name, args)
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => { await expect(view.result.current.send('问题', undefined, [{ resourceId: 'r1' }], ['skill-a'], true)).rejects.toThrow('回执丢失') })
  await act(async () => view.result.current.send('问题', undefined, [], [], true))
  const calls = h.invoke.mock.calls.filter(([name]) => name === 'runtime_session_submit')
  expect(calls).toHaveLength(2)
  expect(calls[1][1].request).toEqual(calls[0][1].request)
  expect(calls[1][1].request).toMatchObject({ attachments: [{ resourceId: 'r1' }], skillIds: ['skill-a'] })
  expect(retrieved).toBe(1)
})

it.each(['stop', 'switch'] as const)('知识库等待期间%s，结果到达后不能发送', async action => {
  const fallback = h.invoke.getMockImplementation()!
  let finish!: (value: unknown) => void
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') return new Promise(resolve => { finish = resolve })
    return fallback(name, args)
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  let request!: Promise<unknown>
  await act(async () => { request = view.result.current.send('问题', undefined, [], [], true).catch(error => error) })
  expect(view.result.current.status).toBe('submitted')
  expect(view.result.current.messages.at(-1)?.metadata).toMatchObject({ knowledgeRetrieving: true })
  await act(async () => {
    if (action === 'stop') await view.result.current.stop()
    else { h.epoch = 'e2'; view.rerender() }
  })
  await act(async () => { finish({ status: 'succeeded', data: { code: 0, data: { chunks: [] } } }); await request })
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)
})

it('知识库缓存不覆盖编辑后的正文，也不跨目标恢复引用', async () => {
  localStorage.setItem('bibit:session-knowledge:["target-a","s1","m1"]', JSON.stringify({
    version: 1, originalInput: '原问题', question: '原问题', prompt: '旧正文参考',
    context: { type: 'knowledge_retrieval', status: 'empty', chunks: [] },
  }))
  h.feed!.events = [{ seq: 1, time: 1, type: 'user/message', data: { message_id: 'm1', content: '已编辑的正文' } }]
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(view.result.current.messages[0].parts).toContainEqual({ type: 'text', text: '已编辑的正文' })
  expect(view.result.current.messages[0].metadata).not.toHaveProperty('knowledgeContext')
  h.feed = { ...h.feed!, targetId: 'target-b', events: [{ seq: 1, time: 1, type: 'user/message', data: { message_id: 'm1', content: '旧正文参考' } }] }
  await act(async () => view.rerender())
  expect(view.result.current.messages[0].metadata).not.toHaveProperty('knowledgeContext')
})

it('取消首页检索后重开只恢复草稿，不自动发送', async () => {
  const fallback = h.invoke.getMockImplementation()!
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') return new Promise(() => {})
    return fallback(name, args)
  })
  sessionStorage.setItem('initial-message-s1', JSON.stringify({ targetId: 'target-a', sessionId: 's1', messageId: 'kb-first', text: '问题', enableKnowledge: true }))
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => view.result.current.stop())
  expect(sessionStorage.getItem('initial-message-s1')).toBeNull()
  view.unmount()
  renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(usePrompt.getState().prompt).toBe('问题')
  expect(h.invoke.mock.calls.filter(([name]) => name === 'knowledge_retrieve')).toHaveLength(1)
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)
})

it('控制权回执迟到时已取消的输入不能提交', async () => {
  const fallback = h.invoke.getMockImplementation()!
  let grant!: (value: unknown) => void
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'runtime_controller_acquire') return new Promise(resolve => { grant = resolve })
    return fallback(name, args)
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  let request!: Promise<unknown>
  await act(async () => { request = view.result.current.send('问题').catch(error => error) })
  await act(async () => view.result.current.stop())
  await act(async () => { grant({ accepted: true, duplicate: false }); await request })
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_controller_release')).toBe(true)
  expect(view.result.current.pending.every(input => input.status !== 'unknown')).toBe(true)
})

it('迟到的知识库输入事件确认后清理原草稿', async () => {
  const fallback = h.invoke.getMockImplementation()!
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') return { status: 'succeeded', data: { code: 0, data: { chunks: [{ id: 'c', content: '实际资料', document_id: 'd', document_keyword: '手册' }] } } }
    if (name === 'runtime_session_submit') throw new Error('未知回执')
    return fallback(name, args)
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  usePrompt.setState({ prompt: '@kb:kb1 问题' })
  await act(async () => { await view.result.current.send('@kb:kb1 问题').catch(() => {}) })
  const input = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')![1].request
  h.feed!.events = [{ seq: 1, time: 1, type: 'user/message', data: { message_id: input.messageId, content: input.content } }]
  await act(async () => view.rerender())
  expect(usePrompt.getState().prompt).toBe('')
})

it('未知输入的重试在控制权阶段失败，仍保留原身份和冻结资料', async () => {
  const fallback = h.invoke.getMockImplementation()!
  let retrievals = 0
  let acquire = 0
  let submissions = 0
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') { retrievals++; return { status: 'succeeded', data: { code: 0, data: { chunks: [{ id: 'c', content: '实际资料', document_id: 'd', document_keyword: '手册' }] } } } }
    if (name === 'runtime_controller_acquire' && ++acquire === 2) return { accepted: false }
    if (name === 'runtime_session_submit' && ++submissions === 1) throw new Error('未知回执')
    return fallback(name, args)
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => { await expect(view.result.current.send('问题', undefined, [], [], true)).rejects.toThrow('未知回执') })
  await act(async () => { await expect(view.result.current.send('问题', undefined, [], [], true)).rejects.toThrow('Another Bibit client is using this workbench') })
  expect(view.result.current.pending[0].status).toBe('unknown')
  await act(async () => view.result.current.send('问题', undefined, [], [], true))
  const sent = h.invoke.mock.calls.filter(([name]) => name === 'runtime_session_submit')
  expect(sent).toHaveLength(2)
  expect(sent[0][1].request).toEqual(sent[1][1].request)
  expect(retrievals).toBe(1)
})

it('旧版本未知输入没有开关字段时也必须原样重试', async () => {
  const input = { targetId: 'target-a', sessionId: 's1', messageId: 'old-input', content: '原文', skillIds: [], attachments: [] }
  localStorage.setItem('bibit:session-input:["target-a","s1"]', JSON.stringify(input))
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => view.result.current.send(input.content))
  expect(h.invoke.mock.calls.some(([name]) => name === 'knowledge_retrieve')).toBe(false)
  expect(h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')![1].request).toEqual(input)
})

it('知识库开关只随本次发送，检索结果随问题恢复且不污染下一条消息', async () => {
  const fallback = h.invoke.getMockImplementation()!
  h.invoke.mockImplementation(async (name, args) => name === 'knowledge_retrieve'
    ? { status: 'succeeded', data: { code: 0, data: { chunks: [{ id: 'c', content: 'USB 接口', document_id: 'd', document_keyword: 'K3.md' }] } } }
    : fallback(name, args))
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => view.result.current.send('K3 接口', undefined, [], [], true))
  const input = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')![1].request
  expect(input.content).toContain('USB 接口')
  h.feed!.events = [
    { seq: 1, time: 1, type: 'user/message', run_id: 'r', data: { message_id: input.messageId, content: input.content } },
    { seq: 2, time: 2, type: 'llm/response', run_id: 'r', data: { content: '接口回答' } },
  ]
  await act(async () => view.rerender())
  expect((view.result.current.messages[0].metadata as any).knowledgeContext.chunks[0].content).toBe('USB 接口')
  view.unmount()
  const restored = renderHook(() => useSessionConversation('s1', true))
  expect((restored.result.current.messages[0].metadata as any).knowledgeContext.chunks[0].content).toBe('USB 接口')
})

it('技能引用取自 Runtime 回执，重挂载后仍随消息显示', async () => {
  h.feed!.events = [
    { seq: 1, time: 1, type: 'agent/inbox/spliced', run_id: null, data: { message: { message_id: 'm1', content: '审查这段代码', skill_ids: ['bianbu.audit/audit-guide'] } } },
    { seq: 2, time: 2, type: 'user/message', run_id: 'r1', data: { message_id: 'm1', content: '审查这段代码' } },
    { seq: 3, time: 3, type: 'llm/response', run_id: 'r1', data: { content: '结论' } },
  ]
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect((view.result.current.messages[0].metadata as any).citedSkillIds).toEqual(['bianbu.audit/audit-guide'])
  // 引用只标在用户消息上，助手回复不带这份元数据。
  expect(view.result.current.messages.filter(message => (message.metadata as any)?.citedSkillIds).map(message => message.id))
    .toEqual(['m1'])
  view.unmount()
  const restored = renderHook(() => useSessionConversation('s1', true))
  expect((restored.result.current.messages[0].metadata as any).citedSkillIds).toEqual(['bianbu.audit/audit-guide'])
  await act(async () => {})
})

it('无匹配不会提交，保留草稿供用户重试', async () => {
  const fallback = h.invoke.getMockImplementation()!
  h.invoke.mockImplementation(async (name, args) => name === 'knowledge_retrieve'
    ? { status: 'succeeded', data: { code: 0, data: { chunks: [] } } } : fallback(name, args))
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  usePrompt.setState({ prompt: '问题' })
  await act(async () => { await expect(view.result.current.send('问题', undefined, [], [], true)).rejects.toThrow('No related material found in the knowledge base') })
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)
  expect(usePrompt.getState().prompt).toBe('问题')
  expect(view.result.current.error).toContain('No related material found in the knowledge base')
})

it('旧回执到达时不清除用户重新输入的同文草稿', async () => {
  const fallback = h.invoke.getMockImplementation()!
  h.invoke.mockImplementation(async (name, args) => { if (name === 'runtime_session_submit') throw new Error('未知回执'); return fallback(name, args) })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  usePrompt.getState().setPrompt('同一个问题')
  await act(async () => { await view.result.current.send('同一个问题').catch(() => {}) })
  const input = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')![1].request
  usePrompt.getState().setPrompt('另一个问题')
  usePrompt.getState().setPrompt('同一个问题')
  h.feed!.events = [{ seq: 1, time: 1, type: 'user/message', data: { message_id: input.messageId, content: input.content } }]
  await act(async () => view.rerender())
  expect(usePrompt.getState().prompt).toBe('同一个问题')
})

it('首次语音输入携带原 ID，明确未发送时不误判为未知回执', async () => {
  h.invoke.mockImplementation(async (name: string) => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    if (name === 'runtime_session_pending' || name === 'runtime_sessions_list') return []
    if (name === 'runtime_session_submit') throw { details: { submissionState: 'not_sent' }, message: '尚未发送' }
    return { accepted: true }
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => { await expect(view.result.current.send('语音内容', undefined, [], { messageId: 'voice-input-1', preserveDraft: true })).rejects.toMatchObject({ message: '尚未发送' }) })
  expect(h.invoke).toHaveBeenCalledWith('runtime_session_submit', { request: expect.objectContaining({ messageId: 'voice-input-1', content: '语音内容' }) })
  expect(view.result.current.pending[0].status).toBe('failed')
  expect(localStorage.getItem('bibit:session-input:["target-a","s1"]')).toBeNull()
})

it('语音队列通过共享会话提交且不清除同内容的键盘草稿', async () => {
  const base = h.invoke.getMockImplementation()!
  h.invoke.mockImplementation(async (name: string, args: unknown) => name === 'runtime_target_identity' ? { targetId: 'target-a', runtimeEpoch: 'e1' } : base(name, args))
  const input = { id: crypto.randomUUID(), sessionId: 's1', targetId: 'target-a', runtimeEpoch: 'e1', text: '同样文字' }
  useConversationSyncStore.setState({ drafts: { s1: input.text } })
  useVoiceInputStore.setState({ pending: [input], readyId: input.id })
  renderHook(() => {
    const session = useSessionConversation('s1', true)
    useVoiceSubmission('s1', session.ready, (text, id) => session.send(text, undefined, [], { messageId: id, preserveDraft: true }))
  })
  await act(async () => {})
  expect(h.invoke).toHaveBeenCalledWith('runtime_session_submit', { request: expect.objectContaining({ messageId: input.id, content: input.text, attachments: [] }) })
  expect(useVoiceInputStore.getState().pending).toHaveLength(0)
  expect(usePrompt.getState().prompt).toBe(input.text)
})

it('语音输入事件先于 HTTP 回执时也保留键盘草稿', async () => {
  let resolveSubmit!: (receipt: unknown) => void
  const base = h.invoke.getMockImplementation()!
  h.invoke.mockImplementation(async (name: string, args: unknown) => name === 'runtime_session_submit'
    ? new Promise(resolve => { resolveSubmit = resolve }) : base(name, args))
  useConversationSyncStore.setState({ drafts: { s1: '保留草稿' } })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  let sending!: Promise<void>
  await act(async () => { sending = view.result.current.send('保留草稿', undefined, [], { messageId: 'voice-early', preserveDraft: true }) })
  h.feed = { ...h.feed!, events: [{ seq: 1, time: 1, type: 'user/message', data: { message_id: 'voice-early', content: '保留草稿' } }] }
  view.rerender()
  await act(async () => {})
  expect(usePrompt.getState().prompt).toBe('保留草稿')
  await act(async () => { resolveSubmit({ accepted: true, status: 'claimed' }); await sending })
  expect(usePrompt.getState().prompt).toBe('保留草稿')
})

it('查看并聚焦会话时，把当前 feed 的终态水位推进到已读', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  // 会话已完整送达：终态事件在 feed 里，latestRun 也已终态
  h.feed = { ...h.feed!, lastSeq: 5, events: [
    { seq: 1, time: 1, type: 'user/message', run_id: 'r1', data: { message_id: 'u', content: '问题' } },
    { seq: 5, time: 5, type: 'run/completed', run_id: 'r1', data: { content: '回答' } },
  ] }
  // 会话列表接口返回带 latestRun 的会话，使 useSessionReadState 拿到 sessions 参数
  h.invoke.mockImplementation(async (name: string) => {
    if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
    if (name === 'runtime_session_pending') return []
    if (name === 'runtime_sessions_list') return [{ id: 's1', title: '会话', agentId: 'a', metadata: {}, createdAt: 1, updatedAt: 2, latestRun: { id: 'r1', sessionId: 's1', agentId: 'a', status: 'completed', content: '回答', pendingActions: [], eventCursor: 5, createdAt: 1, updatedAt: 5 } }]
    return { accepted: true, status: 'claimed' }
  })
  renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  await act(async () => {})
  const saved = JSON.parse(localStorage.getItem('bibit:session-read:["target-a","s1"]') ?? 'null')
  expect(saved).not.toBeNull()
  // markRead 用当前 feed 的 renderedSeq 推进已读进度与最新终态 run
  expect(saved.readSeq).toBe(5)
  expect(saved.readRunId).toBe('r1')
  // 已读后（readRunId = 最新终态 run），侧栏不应再判定为“完成未读”
  expect(sessionUnread('target-a', { id: 's1', title: '会话', agentId: 'a', metadata: {}, createdAt: 1, updatedAt: 2, latestRun: { id: 'r1', sessionId: 's1', agentId: 'a', status: 'completed', content: '回答', pendingActions: [], eventCursor: 5, createdAt: 1, updatedAt: 5 } } as RuntimeSession)).toBe(false)
  vi.restoreAllMocks()
})

it('重连保留旧快照时，退役 epoch 的审批不得按当前 epoch 重新登记', async () => {
  h.feed = { ...h.feed!, events: [
    { seq: 1, time: 1, run_id: 'r1', type: 'user/message', data: { message_id: 'm1', content: '重启前的正文' } },
    { seq: 2, time: 2, run_id: 'r1', type: 'approval/requested', data: { approval_id: 'a1', actions: [{ name: 'write', allowed_decisions: ['approve', 'reject'] }] } },
  ] }
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  expect(h.observe.mock.calls.map(([data]) => data.runtimeEpoch)).toEqual(['e1'])
  h.observe.mockClear()
  // Runtime 重启：epoch 前进，但同一会话的旧快照仍被保留。
  h.epoch = 'e2'
  view.rerender()
  await act(async () => {})
  // 快照里的审批必须仍带自己的 e1，否则会绕过 controller 的退役 epoch 守卫。
  expect(h.observe.mock.calls.map(([data]) => data.runtimeEpoch)).toEqual(['e1'])
  expect(view.result.current.projection.messages.map(message => message.content)).toContain('重启前的正文')
})
it('会话流重订阅不应取消在途的知识库检索', async () => {
  const fallback = h.invoke.getMockImplementation()!
  let finishRetrieval!: (value: unknown) => void
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') return new Promise(resolve => { finishRetrieval = resolve })
    return fallback(name, args)
  })
  const ready = h.feed!
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  usePrompt.setState({ prompt: 'K3 的 DDR 带宽怎么测？' })
  let sending!: Promise<unknown>
  await act(async () => { sending = view.result.current.send('K3 的 DDR 带宽怎么测？', undefined, [], [], true).catch(() => undefined) })
  expect(view.result.current.messages.at(-1)).toMatchObject({ role: 'user', metadata: { knowledgeRetrieving: true } })

  // 检索未返回时会话流重订阅：useSessionFeed 每次订阅都先 installFeed(undefined)。
  h.feed = undefined
  view.rerender()
  await act(async () => {})
  h.feed = ready
  view.rerender()
  await act(async () => {})

  await act(async () => {
    finishRetrieval({ status: 'succeeded', data: { code: 0, data: { chunks: [{ id: 'c1', content: '测试参考内容', document_id: 'd1', document_keyword: '手册' }] } } })
    await sending
  })

  const submit = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')
  expect({
    submitted: submit?.[1].request.content ?? null,
    pending: view.result.current.pending.length,
    error: view.result.current.error,
    draftKept: usePrompt.getState().prompt,
  }).toEqual({ submitted: expect.stringContaining('测试参考内容'), pending: 1, error: '', draftKept: '' })
})

it('换会话仍要取消在途的知识库检索', async () => {
  const fallback = h.invoke.getMockImplementation()!
  let finishRetrieval!: (value: unknown) => void
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') return new Promise(resolve => { finishRetrieval = resolve })
    return fallback(name, args)
  })
  const view = renderHook((id: string) => useSessionConversation(id, true), { initialProps: 's1' })
  await act(async () => {})
  let sending!: Promise<unknown>
  await act(async () => { sending = view.result.current.send('K3 的 DDR 带宽怎么测？', undefined, [], [], true).catch(() => undefined) })
  view.rerender('s2')
  await act(async () => {})
  await act(async () => {
    finishRetrieval({ status: 'succeeded', data: { code: 0, data: { chunks: [{ id: 'c1', content: '测试参考内容', document_id: 'd1', document_keyword: '手册' }] } } })
    await sending
  })
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)
})

it('检索结果到达时身份已漂移，发送照常提交而不是被丢掉', async () => {
  const fallback = h.invoke.getMockImplementation()!
  let finishRetrieval!: (value: unknown) => void
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') return new Promise(resolve => { finishRetrieval = resolve })
    return fallback(name, args)
  })
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  let sending!: Promise<unknown>
  await act(async () => { sending = view.result.current.send('K3 的 DDR 带宽怎么测？', undefined, [], [], true).catch(() => undefined) })

  // 检索未返回时会话流归零（重订阅、能力位抖动都会这样）：身份只是订阅态的派生量，
  // 结果到达后仍要按原计划提交，否则用户看到的就是“消息没发出去”的空会话。
  h.feed = undefined
  view.rerender()
  await act(async () => {})
  await act(async () => {
    finishRetrieval({ status: 'succeeded', data: { code: 0, data: { chunks: [{ id: 'c1', content: '测试参考内容', document_id: 'd1', document_keyword: '手册' }] } } })
    await sending
  })
  const submit = h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')
  expect(submit?.[1].request).toMatchObject({ targetId: 'target-a', sessionId: 's1' })
  expect(submit?.[1].request.content).toContain('测试参考内容')
})

it('换 epoch（Runtime 重建）仍要取消在途检索，取消的输入留下可重试的终态', async () => {
  const fallback = h.invoke.getMockImplementation()!
  let finishRetrieval!: (value: unknown) => void
  let retrievals = 0
  h.invoke.mockImplementation(async (name, args) => {
    if (name === 'knowledge_retrieve') {
      if (++retrievals > 1) return { status: 'succeeded', data: { code: 0, data: { chunks: [{ id: 'c2', content: '重试参考内容', document_id: 'd1', document_keyword: '手册' }] } } }
      return new Promise(resolve => { finishRetrieval = resolve })
    }
    return fallback(name, args)
  })
  const ready = h.feed!
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  let sending!: Promise<unknown>
  await act(async () => { sending = view.result.current.send('K3 的 DDR 带宽怎么测？', undefined, [], [], true).catch(() => undefined) })

  // epoch 是真正的生命周期变化：旧 Runtime 已经不在，提交必须放弃，但要用可见的
  // 失败态把正文和重试入口还给用户，不能像以前那样静默丢掉。
  h.epoch = 'e2'
  view.rerender()
  await act(async () => {})
  await act(async () => {
    finishRetrieval({ status: 'succeeded', data: { code: 0, data: { chunks: [{ id: 'c1', content: '测试参考内容', document_id: 'd1', document_keyword: '手册' }] } } })
    await sending
  })
  expect(h.invoke.mock.calls.some(([name]) => name === 'runtime_session_submit')).toBe(false)

  h.epoch = 'e1'
  view.rerender()
  await act(async () => {})
  expect(h.feed).toEqual(ready)
  // 之后再重订阅一次：pending 重建（runtime_session_pending）不能抹掉这个重试入口。
  h.feed = undefined
  view.rerender()
  await act(async () => {})
  h.feed = { ...ready, events: [] }
  view.rerender()
  await act(async () => {})

  expect(view.result.current.pending).toHaveLength(1)
  const retry = view.result.current.pending[0]
  expect(retry).toMatchObject({ status: 'failed', content: 'K3 的 DDR 带宽怎么测？', enableKnowledge: true })

  await act(async () => { await view.result.current.send(retry.content, retry).catch(() => undefined) })
  expect(h.invoke.mock.calls.find(([name]) => name === 'runtime_session_submit')?.[1].request.content).toContain('重试参考内容')
})

// 增量路径要求前缀引用不变：这里刻意只重建尾部折叠组，与 mergeSessionFeed 的追加方式一致。
const streamingUser = { seq: 0, time: 0, type: 'user/message', data: { message_id: 'u1', content: '问题' } }
const streamingFeed = (text: string, seqRange?: [number, number]): SessionFeed => ({
  targetId: 'target-a', runtimeEpoch: 'e1', sessionId: 's1', hiddenRunIds: [], baseSeq: 0, hasMore: false,
  connectionStatus: 'connected', lastSeq: 1, events: [
    streamingUser,
    { seq: 1, time: 1, type: 'assistant/text.delta', run_id: 'r1', data: seqRange ? { text, seq_range: seqRange } : { text } },
  ],
})

it('纯尾部 delta 增量更新时历史消息的 UIMessage 保持同一对象', async () => {
  h.feed = streamingFeed('前')
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  const before = view.result.current.messages
  h.feed = streamingFeed('前半', [1, 2])
  view.rerender()
  await act(async () => {})
  const after = view.result.current.messages
  expect(after[0]).toBe(before[0])
  expect(after.at(-1)).not.toBe(before.at(-1))
  expect((after.at(-1)!.parts[0] as { text: string }).text).toBe('前半')
})

it('知识上下文后到时按原文换键重建，历史消息不停在旧内容', async () => {
  h.feed = streamingFeed('前')
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  const before = view.result.current.messages
  saveSessionKnowledge('target-a', 's1', 'u1', { version: 1, originalInput: '问题', question: '带知识的问法', prompt: '问题',
    context: { type: 'knowledge_retrieval', status: 'succeeded', question: '带知识的问法', total: 1,
      chunks: [{ id: 'c1', content: '参考', documentName: '手册', similarity: 0.9 }] } })
  h.feed = streamingFeed('前半', [1, 2])
  view.rerender()
  await act(async () => {})
  const after = view.result.current.messages
  expect(after[0]).not.toBe(before[0])
  expect((after[0].parts[0] as { text: string }).text).toBe('带知识的问法')
})

it('父问题正文被修订后，未变化的助手消息也移除过期知识引用', async () => {
  saveSessionKnowledge('target-a', 's1', 'u1', { version: 1, originalInput: '问题', question: '原问题', prompt: '问题',
    context: { type: 'knowledge_retrieval', status: 'empty', question: '原问题', total: 0, chunks: [] } })
  h.feed = streamingFeed('回答')
  const view = renderHook(() => useSessionConversation('s1', true))
  await act(async () => {})
  const before = view.result.current.messages.at(-1)!
  expect(before.metadata).toHaveProperty('knowledgeContext')
  h.feed = { ...h.feed!, events: [
    { ...streamingUser, data: { message_id: 'u1', content: '修改的问题' } }, h.feed!.events[1],
  ] }
  await act(async () => view.rerender())
  const after = view.result.current.messages.at(-1)!
  expect(after).not.toBe(before)
  expect(after.metadata).not.toHaveProperty('knowledgeContext')
})
