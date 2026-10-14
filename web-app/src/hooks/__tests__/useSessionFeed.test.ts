import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), handler: undefined as undefined | ((event: { payload: unknown }) => void) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
import { mergeSessionFeed, useSessionFeed, type SessionFeed } from '../useSessionFeed'
const base: SessionFeed = { targetId: 'a', runtimeEpoch: '1', sessionId: 's', events: [{ seq: 2, type: 'run/completed', time: 0, data: {} }], hiddenRunIds: [], baseSeq: 2, lastSeq: 2, hasMore: true, connectionStatus: 'connected' }

it('保存失败通过独立摘要显示原因，恢复后清除提示且正文保持不变', async () => {
  mocks.invoke.mockResolvedValue(base)
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  const persistence = { state: 'error' as const, durable_events: 3, pending_events: 2,
    error: { code: 'session_log_write_failed', message: '无法保存对话；底层原因：No space left on device', details: { cause: 'No space left on device' } } }
  act(() => mocks.handler?.({ payload: { ...base, sessionId: '', kind: 'summary', events: [],
    summary: { sessions: [{ id: 's', persistence }] } } }))
  expect(result.current.error).toContain('No space left on device')
  expect(result.current.feed?.events).toEqual(base.events)
  expect(result.current.halted).toBe(false)
  act(() => mocks.handler?.({ payload: { ...base, sessionId: '', kind: 'summary', events: [],
    summary: { sessions: [{ id: 'other', persistence }] } } }))
  expect(result.current.error).toContain('No space left on device')
  act(() => mocks.handler?.({ payload: { ...base, sessionId: '', kind: 'summary', events: [],
    summary: { sessions: [{ id: 's', persistence: { state: 'saved', error: null } }] } } }))
  expect(result.current.error).toBe('')
  expect(result.current.feed?.events).toEqual(base.events)
})
it('尾部回退按重置处理：旧窗口被丢掉，随后的窗口帧从服务端重装', () => {
  const previous: SessionFeed = { ...base, events: [{ seq: 7, type: 'run/completed', time: 9, data: {} }], baseSeq: 7, lastSeq: 7, paused: true }
  const reset = mergeSessionFeed(previous, { ...base, kind: 'reset', events: [], hiddenRunIds: [], baseSeq: 0, lastSeq: 0, hasMore: false })
  expect(reset.events).toEqual([])
  expect(reset.lastSeq).toBe(0)
  expect(reset.paused).toBe(false)
  const reloaded = mergeSessionFeed(reset, { ...base, events: [{ seq: 0, type: 'user/message', time: 1, data: {} }], baseSeq: 0, lastSeq: 0, hasMore: false })
  expect(reloaded.events.map(event => event.seq)).toEqual([0])
})
describe('Session 事件窗', () => {
  it('摘要和后续事件被批量合并后仍保留刷新水位', () => {
    const summary = mergeSessionFeed(base, { ...base, kind: 'summary', events: [] })
    const merged = mergeSessionFeed(summary, { ...base, kind: 'events' })
    expect(merged.summaryVersion).toBe(1)
    expect(mergeSessionFeed(merged, { ...base, kind: 'summary' }).summaryVersion).toBe(2)
  })
  it('乱序分页去重，拒绝旧目标与旧连接', () => {
    const merged = mergeSessionFeed(base, { ...base, events: [{ seq: 1, type: 'user/message', time: 0, data: {} }, ...base.events], baseSeq: 1, lastSeq: 1 })
    expect(merged.events.map(event => event.seq)).toEqual([1, 2])
    expect(merged.lastSeq).toBe(2)
    expect(mergeSessionFeed(base, { ...base, targetId: 'other' })).toBe(base)
    expect(mergeSessionFeed(base, { ...base, runtimeEpoch: 'old' })).toBe(base)
  })
})

it('折叠窗口与装载期间缓冲的实时帧合并不重复正文', () => {
  const folded = { ...base, events: [{ seq: 100, type: 'assistant/reasoning.delta', time: 0, run_id: 'run-1', data: { text: 'ABCDEF', seq_range: [100, 105] } }], baseSeq: 100, lastSeq: 105 }
  // 装载期间到达的原始 delta：组首那条(100)不在帧里，按 seq 覆盖去重挡不住。
  const merged = mergeSessionFeed(folded, { ...base, events: [{ seq: 101, type: 'assistant/reasoning.delta', time: 1, run_id: 'run-1', data: { text: 'B' } }, { seq: 102, type: 'assistant/reasoning.delta', time: 2, run_id: 'run-1', data: { text: 'C' } }], baseSeq: 100, lastSeq: 105 })
  expect(merged.events).toHaveLength(1)
  expect(merged.events[0].data.text).toBe('ABCDEF')
  // 水位之后的实时增量仍并进同一条，且水位按区间末尾推进。
  const grown = mergeSessionFeed(merged, { ...base, events: [{ seq: 106, type: 'assistant/reasoning.delta', time: 6, run_id: 'run-1', data: { text: 'G' } }], baseSeq: 100, lastSeq: 106 })
  expect(grown.events).toHaveLength(1)
  expect(grown.events[0].data.text).toBe('ABCDEFG')
  expect(grown.events[0].data.seq_range).toEqual([100, 106])
})
beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.listen.mockReset().mockImplementation((_name, handler) => { mocks.handler = handler; return Promise.resolve(vi.fn()) })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('搜索结果锚定窗口', () => {
  it('按锚点读一份以该消息结尾的窗口，并标记为已锚定', async () => {
    mocks.invoke.mockResolvedValue(base)
    const { result } = renderHook(() => useSessionFeed('s', '1', true, 9))
    await act(async () => {})
    expect(mocks.invoke).toHaveBeenCalledWith('runtime_session_history_window', { sessionId: 's', beforeSeq: 10 })
    expect(result.current.feed?.sessionId).toBe('s')
    expect(result.current.anchored).toBe(true)
  })
  it('锚定期间丢开实时帧，回到最新时重读尾窗', async () => {
    mocks.invoke.mockResolvedValue(base)
    const { result, rerender } = renderHook(
      ({ seq }: { seq?: number }) => useSessionFeed('s', '1', true, seq),
      { initialProps: { seq: 9 as number | undefined } },
    )
    await act(async () => {})
    expect(result.current.anchored).toBe(true)
    // 尾窗的实时增量属于最新窗口，装进锚定窗口只会得到一段错位的对话。
    act(() => mocks.handler?.({ payload: { ...base, seq: undefined, events: [{ seq: 30, type: 'assistant/text.delta', time: 30, data: { text: '新内容' } }], baseSeq: 30, lastSeq: 30 } }))
    expect(result.current.feed?.events.map(event => event.seq)).toEqual([2])
    mocks.invoke.mockClear()
    rerender({ seq: undefined })
    await act(async () => {})
    expect(mocks.invoke).toHaveBeenCalledWith('runtime_session_history_window', { sessionId: 's' })
    expect(result.current.anchored).toBe(false)
  })
})
it('未启用 Session 时不监听或请求事件，关闭后不泄露旧 feed', async () => {
  mocks.invoke.mockResolvedValue(base)
  const { result, rerender } = renderHook(({ enabled }) => useSessionFeed('s', '1', enabled), { initialProps: { enabled: false } })
  await act(async () => {})
  expect(mocks.listen).not.toHaveBeenCalled()
  expect(mocks.invoke).not.toHaveBeenCalled()
  rerender({ enabled: true })
  await act(async () => {})
  expect(result.current.feed?.sessionId).toBe('s')
  rerender({ enabled: false })
  expect(result.current.feed).toBeUndefined()
})
it('切换会话的首次渲染不能暴露旧会话事件', async () => {
  mocks.invoke.mockResolvedValueOnce(base).mockReturnValue(new Promise(() => {}))
  const seen: Array<string | undefined> = []
  const { rerender } = renderHook(({ sessionId }) => {
    const state = useSessionFeed(sessionId, '1')
    if (sessionId === 'new') seen.push(state.feed?.sessionId)
    return state
  }, { initialProps: { sessionId: 's' } })
  await act(async () => {})
  rerender({ sessionId: 'new' })
  expect(seen).not.toContain('s')
})
it('同一会话重连且首个读取失败时保留上一份快照', async () => {
  vi.useFakeTimers()
  mocks.invoke.mockResolvedValueOnce(base)
    .mockRejectedValueOnce({ code: 'E0107', details: { httpStatus: 503 }, message: '服务暂不可用' })
  const { result, rerender } = renderHook(({ epoch }) => useSessionFeed('s', epoch), { initialProps: { epoch: '1' } })
  await act(async () => {})
  expect(result.current.feed?.events).toEqual(base.events)
  rerender({ epoch: '2' })
  await act(async () => {})
  expect(result.current.feed?.events).toEqual(base.events)
  expect(result.current.error).toContain('retrying to read the session')
})
it('首次503后退避恢复快照并应用监听期间的事件和全局连接状态', async () => {
  vi.useFakeTimers()
  mocks.invoke.mockRejectedValueOnce({ code: 'E0107', details: { httpStatus: 503 }, message: '服务暂不可用' }).mockResolvedValueOnce(base)
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  expect(result.current.error).toContain('retrying to read the session')
  act(() => mocks.handler?.({ payload: { ...base, events: [{ seq: 3, type: 'assistant/text.delta', time: 1, data: { text: '恢复文本' } }], kind: 'events' } }))
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(result.current.feed?.events.map(event => event.seq)).toEqual([2, 3])
  expect(result.current.error).toBe('')
  act(() => mocks.handler?.({ payload: { ...base, sessionId: '', events: [], kind: 'connection', connectionStatus: 'disconnected' } }))
  expect(result.current.feed?.connectionStatus).toBe('disconnected')
  expect(mocks.listen).toHaveBeenCalledTimes(1)
})
it('永久404不进行自动重试', async () => {
  vi.useFakeTimers()
  mocks.invoke.mockRejectedValue({ details: { httpStatus: 404, backendCode: 'not_found' }, message: '会话不存在' })
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => vi.advanceTimersByTimeAsync(20000))
  // 折叠端点 404 后退回原始事件窗口确认一次，两次都 404 才算永久失败，此后不再自动重试。
  expect(mocks.invoke.mock.calls.map(([name]) => name)).toEqual(['runtime_session_history_window', 'runtime_session_feed'])
  expect(result.current.error).toContain('retry or switch session')
})
it('历史窗口读折叠端点，路由不存在时退回原始事件窗口', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const deltas = Array.from({ length: 500 }, (_, index) => ({ seq: index + 1, type: 'assistant/reasoning.delta', time: 0, run_id: 'run-1', data: { text: '片段' } }))
  mocks.invoke.mockResolvedValueOnce({ ...base, events: deltas, baseSeq: 1, lastSeq: 500 })
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  expect(mocks.invoke).toHaveBeenCalledWith('runtime_session_history_window', { sessionId: 's' })
  expect(result.current.feed?.events).toHaveLength(1)
  expect(result.current.feed?.events[0].data.text).toHaveLength(500 * 2)
  expect(warn).not.toHaveBeenCalled()
  // 旧 Runtime 没有该路由：带回 code 的 404。
  mocks.invoke.mockReset()
  // Runtime 对「路由不存在」和「会话不存在」都回 code=not_found：只能按 404 判定。
  mocks.invoke.mockRejectedValueOnce({ code: 'run_failed', details: { httpStatus: 404, backendCode: 'not_found' }, message: 'Not Found' })
    .mockResolvedValueOnce({ ...base, events: deltas, baseSeq: 1, lastSeq: 500 })
  const fallback = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'runtime_session_history_window', { sessionId: 's' })
  expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'runtime_session_feed', { sessionId: 's' })
  expect(fallback.result.current.feed?.events).toHaveLength(1)
  expect(warn).toHaveBeenCalledTimes(1)
})
it('初始化缓冲溢出明确暂停，不能裁剪后假装已连接', async () => {
  let resolve!: (value: SessionFeed) => void
  mocks.invoke.mockReturnValue(new Promise<SessionFeed>(done => { resolve = done }))
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  act(() => mocks.handler?.({ payload: { ...base, events: Array.from({ length: 200001 }, (_, seq) => ({ seq, type: 'assistant/text.delta', time: 1, data: { text: '片段' } })) } }))
  await act(async () => resolve(base))
  expect(result.current.feed).toBeUndefined()
  expect(result.current.error).toContain('initial event buffer is full')
  expect(result.current.halted).toBe(true)
})
it('慢读期间堆积的帧不再按帧数暂停', async () => {
  mocks.invoke.mockReturnValue(new Promise<SessionFeed>(() => {}))
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  act(() => {
    for (let index = 0; index < 300; index++) mocks.handler?.({ payload: { ...base, kind: 'summary', events: [] } })
  })
  expect(result.current.feed).toBeUndefined()
  expect(result.current.halted).toBe(false)
  expect(result.current.error).toBe('')
})
it('重试读取会话清除停止态', async () => {
  mocks.invoke.mockReturnValue(new Promise<SessionFeed>(() => {}))
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  act(() => mocks.handler?.({ payload: { ...base, events: Array.from({ length: 200001 }, (_, seq) => ({ seq, type: 'assistant/text.delta', time: 1, data: { text: '片段' } })) } }))
  expect(result.current.halted).toBe(true)
  act(() => result.current.retry())
  await act(async () => {})
  expect(result.current.halted).toBe(false)
  expect(result.current.error).toBe('')
})
it('自动重试耗尽后才进入停止态', async () => {
  vi.useFakeTimers()
  mocks.invoke.mockRejectedValue({ code: 'E0107', recoverable: true, message: '读取超时' })
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  expect(result.current.halted).toBe(false)
  expect(result.current.error).toContain('retrying to read the session')
  await act(async () => vi.advanceTimersByTimeAsync(10000))
  expect(mocks.invoke).toHaveBeenCalledTimes(3)
  expect(result.current.halted).toBe(true)
  vi.useRealTimers()
})
it('不可恢复错误即使没有HTTP状态也不自动重试', async () => {
  vi.useFakeTimers()
  mocks.invoke.mockRejectedValue({ code: 'E0107', recoverable: false, message: '访问被拒绝' })
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => vi.advanceTimersByTimeAsync(30000))
  expect(mocks.invoke).toHaveBeenCalledTimes(1)
  expect(result.current.error).not.toContain('retrying to read the session')
})
it('仅连接恢复帧清除旧连接错误，普通事件不能将其隐藏', () => {
  const failed = mergeSessionFeed(base, { ...base, kind: 'connection', sessionId: '', events: [], message: '连接失败', connectionStatus: 'disconnected' })
  const event = mergeSessionFeed(failed, { ...base, kind: 'events' })
  expect(event.message).toBe('连接失败')
  expect(event.connectionStatus).toBe('disconnected')
  const recovered = mergeSessionFeed(event, { ...base, kind: 'connection', sessionId: '' })
  expect(recovered.message).toBeUndefined()
  expect(mergeSessionFeed(recovered, { ...base, kind: 'connection', connectionStatus: 'disconnected' }).message).toBeUndefined()
})
it('历史请求等待时到达的实时帧不会被较早分页覆盖', async () => {
  const event = (seq: number) => ({ seq, type: 'run/event', time: 0, data: {} })
  const initial: SessionFeed = { ...base, events: [event(1)], baseSeq: 1, lastSeq: 1 }
  const live = { ...base, events: [event(2)], lastSeq: 2 }
  const older = { ...base, events: [event(0)], baseSeq: 0, hasMore: false }
  let resolveOlder!: (value: SessionFeed) => void
  mocks.invoke.mockResolvedValueOnce(initial).mockReturnValueOnce(new Promise<SessionFeed>(done => { resolveOlder = done }))
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  let loading!: Promise<boolean>
  act(() => { loading = result.current.loadOlder() })
  act(() => mocks.handler?.({ payload: live }))
  expect(result.current.feed?.events.at(-1)?.seq).toBe(2)
  let accepted: boolean | undefined
  await act(async () => { resolveOlder(older); accepted = await loading })
  // 较早分页必须落在实时帧之前，且不能把已经在窗口里的 seq=2 丢掉。
  expect(accepted).toBe(true)
  expect(result.current.feed?.events.map(event => event.seq)).toEqual([0, 1, 2])
  expect(result.current.feed?.baseSeq).toBe(0)
  expect(result.current.error).toBe('')
})

it('现场会话的 45k delta 窗口折叠到消息级，不再锁死会话', async () => {
  // 现场会话 01M24G65RBER4AB72956KVR2H7 的 max_messages=50 窗口是 45179 条事件 / 7.39 MiB，
  // 单个 assistant 回合的 reasoning delta 就占 43511 条，旧上限(10000 事件)会永久锁死该会话。
  const events = Array.from({ length: 45179 }, (_, index) => ({ seq: index + 1, type: 'assistant/reasoning.delta', time: 0, data: { text: 'r'.repeat(80) } }))
  events[events.length - 1] = { ...events[events.length - 1], type: 'run/completed' }
  mocks.invoke.mockResolvedValue({ ...base, events, baseSeq: 2, lastSeq: 45180, hasMore: false })
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  expect(result.current.feed?.events).toHaveLength(2)
  expect(result.current.feed?.events[0].data.text).toHaveLength(45178 * 80)
  expect(result.current.feed?.paused).not.toBe(true)
  expect(result.current.error).toBe('')
})

it('控制帧保留事件与相同隐藏集合引用，普通摘要不能洗掉断线状态', () => {
  const previous = { ...base, hiddenRunIds: ['run-1'] }
  const failed = mergeSessionFeed(previous, { ...base, sessionId: '', kind: 'connection', events: [], connectionStatus: 'reconnecting', message: '全局重连' })
  const summary = mergeSessionFeed(failed, { ...base, kind: 'summary', events: [], hiddenRunIds: ['run-1'] })
  expect(summary.events).toBe(previous.events)
  expect(summary.hiddenRunIds).toBe(previous.hiddenRunIds)
  expect(summary.connectionStatus).toBe('reconnecting')
  expect(summary.message).toBe('全局重连')
})
it('单会话暂停与全局连接分别恢复，不能互相覆盖', () => {
  const frame = (sessionId: string, connectionStatus: SessionFeed['connectionStatus'], message?: string): SessionFeed => ({ ...base, sessionId, kind: 'connection', events: [], connectionStatus, message })
  const isolated = mergeSessionFeed(base, frame('s', 'disconnected', '会话缺口，已暂停'))
  const globalDown = mergeSessionFeed(isolated, frame('', 'reconnecting', '全局重连'))
  const globalUp = mergeSessionFeed(globalDown, frame('', 'connected'))
  expect(globalUp.connectionStatus).toBe('disconnected')
  expect(globalUp.message).toBe('会话缺口，已暂停')
  expect(globalUp.paused).toBe(true)
  const sessionUp = mergeSessionFeed(globalDown, frame('s', 'connected'))
  expect(sessionUp.connectionStatus).toBe('reconnecting')
  expect(sessionUp.message).toBe('全局重连')
  expect(sessionUp.paused).toBe(false)
  expect(mergeSessionFeed(globalUp, frame('s', 'connected')).message).toBeUndefined()
  expect(mergeSessionFeed(sessionUp, frame('', 'connected')).connectionStatus).toBe('connected')
})
it('递增追加无需重排旧窗口，重复覆盖和乱序分页仍按seq合并', () => {
  const sort = vi.spyOn(Array.prototype, 'sort')
  const appended = mergeSessionFeed(base, { ...base, events: [{ ...base.events[0], seq: 3 }] })
  expect(sort).not.toHaveBeenCalled()
  sort.mockRestore()
  expect(appended.events.map(event => event.seq)).toEqual([2, 3])
  const replaced = { ...base.events[0], data: { text: '修订' } }
  const paged = mergeSessionFeed(appended, { ...base, events: [replaced, { ...replaced, seq: 1 }], baseSeq: 1 })
  expect(paged.events.map(event => event.seq)).toEqual([1, 2, 3])
  expect(paged.events[1]).toBe(replaced)
})
it('控制帧和追加事件不重复序列化已有窗口，重载可清理会话隔离', async () => {
  mocks.invoke.mockResolvedValue(base)
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  const stringify = vi.spyOn(JSON, 'stringify')
  act(() => mocks.handler?.({ payload: { ...base, kind: 'connection', events: [], connectionStatus: 'disconnected', message: '会话暂停' } }))
  act(() => mocks.handler?.({ payload: { ...base, kind: 'summary', events: [] } }))
  act(() => mocks.handler?.({ payload: { ...base, kind: 'events', events: [{ ...base.events[0], seq: 3 }] } }))
  expect(stringify.mock.calls.some(([value]) => value === base.events || value === base.events[0] || (Array.isArray(value) && value.some(event => event === base.events[0])))).toBe(false)
  stringify.mockRestore()
  expect(result.current.feed?.paused).toBe(true)
  act(() => result.current.retry())
  await act(async () => {})
  expect(result.current.feed?.connectionStatus).toBe('connected')
  expect(result.current.feed?.paused).not.toBe(true)
  expect(result.current.feed?.message).toBeUndefined()
})

it.each(['事件数', 'UTF-8字节'])('初始化缓冲保留%s上限', async (limit) => {
  mocks.invoke.mockReturnValue(new Promise(() => {}))
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  act(() => {
    if (limit === '事件数') {
      mocks.handler?.({ payload: { ...base, events: Array.from({ length: 200001 }, (_, seq) => ({ seq, type: 'assistant/text.delta', time: 1, data: { text: '片段' } })) } })
    } else {
      mocks.handler?.({ payload: { ...base, events: [{ ...base.events[0], data: { text: '中'.repeat(11 * 1024 * 1024) } }] } })
    }
  })
  expect(result.current.feed).toBeUndefined()
  expect(result.current.error).toContain('initial event buffer is full')
  expect(result.current.halted).toBe(true)
})
it('监听保留全局作用域，并拒绝其它会话与旧epoch的连接帧', async () => {
  mocks.invoke.mockResolvedValue(base)
  const { result } = renderHook(() => useSessionFeed('s', '1'))
  await act(async () => {})
  const connection = { ...base, kind: 'connection', events: [], connectionStatus: 'disconnected', message: '会话暂停' }
  act(() => mocks.handler?.({ payload: connection }))
  act(() => mocks.handler?.({ payload: { ...connection, sessionId: '', connectionStatus: 'connected' } }))
  expect(result.current.feed?.paused).toBe(true)
  expect(result.current.feed?.message).toBe('会话暂停')
  act(() => mocks.handler?.({ payload: { ...connection, sessionId: 'other', connectionStatus: 'connected' } }))
  act(() => mocks.handler?.({ payload: { ...connection, runtimeEpoch: 'old', connectionStatus: 'connected' } }))
  expect(result.current.feed?.paused).toBe(true)
  act(() => mocks.handler?.({ payload: { ...connection, connectionStatus: 'connected' } }))
  expect(result.current.feed?.connectionStatus).toBe('connected')
  expect(result.current.feed?.message).toBeUndefined()
})

// 合帧压的是 setState 次数：事件永远同步并进 feedRef，慢渲染不会丢批次或乱序。
describe('流式帧合帧通知', () => {
  const delta = (seq: number, text: string) =>
    ({ seq, type: 'assistant/text.delta', time: seq, run_id: 'run-1', data: { text } })
  const frame = (seq: number, text: string): SessionFeed =>
    ({ ...base, kind: 'events', events: [delta(seq, text)], baseSeq: 0, lastSeq: seq })

  it('同帧到达的多个 delta 至多通知两次，正文一条不少', async () => {
    vi.useFakeTimers()
    mocks.invoke.mockResolvedValue(base)
    let renders = 0
    const { result } = renderHook(() => { renders++; return useSessionFeed('s', '1') })
    await act(async () => {})
    const settled = renders
    act(() => mocks.handler?.({ payload: frame(3, 'A') }))
    act(() => mocks.handler?.({ payload: frame(4, 'B') }))
    act(() => mocks.handler?.({ payload: frame(5, 'C') }))
    expect(renders - settled).toBeLessThanOrEqual(2)
    act(() => { vi.advanceTimersByTime(16) })
    expect(result.current.feed?.events.at(-1)?.data.text).toBe('ABC')
    expect(renders - settled).toBeLessThanOrEqual(2)
  })

  it('终态帧不等待合帧窗口，立即发布最新状态', async () => {
    vi.useFakeTimers()
    mocks.invoke.mockResolvedValue(base)
    let renders = 0
    const { result } = renderHook(() => { renders++; return useSessionFeed('s', '1') })
    await act(async () => {})
    act(() => mocks.handler?.({ payload: frame(3, 'A') }))
    const beforeTerminal = renders
    act(() => mocks.handler?.({ payload: { ...base, kind: 'events', baseSeq: 0, lastSeq: 4,
      events: [{ seq: 4, type: 'run/completed', time: 4, run_id: 'run-1', data: {} }] } }))
    expect(renders).toBe(beforeTerminal + 1)
    expect(result.current.feed?.events.at(-1)?.type).toBe('run/completed')
  })

  it('卸载时取消待发布通知与前台监听', async () => {
    vi.useFakeTimers()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const unlisten = vi.fn()
    mocks.listen.mockImplementation((_name, handler) => { mocks.handler = handler; return Promise.resolve(unlisten) })
    mocks.invoke.mockResolvedValue(base)
    const added = vi.spyOn(document, 'addEventListener')
    const removed = vi.spyOn(document, 'removeEventListener')
    let renders = 0
    const view = renderHook(() => { renders++; return useSessionFeed('s', '1') })
    await act(async () => {})
    act(() => mocks.handler?.({ payload: frame(3, 'A') }))
    expect(vi.getTimerCount()).toBe(1)
    const settled = renders
    const visible = added.mock.calls.find(([name]) => name === 'visibilitychange')?.[1]
    view.unmount()
    expect(unlisten).toHaveBeenCalledOnce()
    expect(removed).toHaveBeenCalledWith('visibilitychange', visible)
    expect(vi.getTimerCount()).toBe(0)
    act(() => {
      vi.advanceTimersByTime(16)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(renders).toBe(settled)
  })

  it('窗口回到前台时立即补上待发布状态', async () => {
    vi.useFakeTimers()
    mocks.invoke.mockResolvedValue(base)
    const { result } = renderHook(() => useSessionFeed('s', '1'))
    await act(async () => {})
    act(() => mocks.handler?.({ payload: frame(3, 'A') }))
    act(() => mocks.handler?.({ payload: frame(4, 'B') }))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current.feed?.events.at(-1)?.data.text).toBe('AB')
    delete (document as unknown as Record<string, unknown>).visibilityState
  })
})
