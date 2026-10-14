import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  type Listener = (event: { payload: unknown }) => void
  let listener: Listener | undefined
  let threadState = {
    currentThreadId: undefined as string | undefined,
    threads: { 'thread-1': { id: 'thread-1' } } as Record<string, any>,
    setThreads: vi.fn((next: any[]) => {
      threadState = { ...threadState, threads: Object.fromEntries(next.map(thread => [thread.id, thread])) }
    }),
  }
  let promptState = { prompt: '' }
  const threadSubscribers = new Set<(state: any, previous: any) => void>()
  const promptSubscribers = new Set<(state: any, previous: any) => void>()
  const order: string[] = []
  const invocations: Array<{
    command: string
    args?: Record<string, unknown>
  }> = []
  const unlisten = vi.fn()
  const unlistenPopupVisibility = vi.fn()
  const navigate = vi.fn()
  const upsertLocalMessage = vi.fn()
  const removeLocalMessage = vi.fn()
  const setMessages = vi.fn()
  const syncPersistentMessage = vi.fn()
  const applyMirroredRuntimeEnvelope = vi.fn()
  const syncMirroredRuntimeProjection = vi.fn()
  const clearMirroredRuntimeProjection = vi.fn()
  const fetchThreads = vi.fn().mockResolvedValue([])
  let snapshotActiveRun: Record<string, unknown> | null = {
    runId: 'run-1',
    sessionId: 'thread-1',
    lastSequence: 1,
    content: '你',
    status: 'running',
  }

  const threads = {
    getState: () => threadState,
    setState: (partial: any) => {
      const previous = threadState
      threadState = { ...threadState, ...partial }
      threadSubscribers.forEach((subscriber) => subscriber(threadState, previous))
    },
    subscribe: (subscriber: (state: any, previous: any) => void) => {
      threadSubscribers.add(subscriber)
      return () => threadSubscribers.delete(subscriber)
    },
  }
  const prompt = {
    getState: () => promptState,
    setState: (partial: any) => {
      const previous = promptState
      promptState = { ...promptState, ...partial }
      promptSubscribers.forEach((subscriber) => subscriber(promptState, previous))
    },
    subscribe: (subscriber: (state: any, previous: any) => void) => {
      promptSubscribers.add(subscriber)
      return () => promptSubscribers.delete(subscriber)
    },
  }

  return {
    handoffListener: undefined as Listener | undefined,
    emitTo: vi.fn(),
    get listener() {
      return listener
    },
    set listener(value: Listener | undefined) {
      listener = value
    },
    popupVisibilityListener: undefined as Listener | undefined,
    threadCreatedListener: undefined as Listener | undefined,
    windowLabel: 'main',
    sessionEvents: false,
    threads,
    prompt,
    order,
    invocations,
    unlisten,
    unlistenPopupVisibility,
    navigate,
    upsertLocalMessage,
    removeLocalMessage,
    setMessages,
    syncPersistentMessage,
    applyMirroredRuntimeEnvelope,
    syncMirroredRuntimeProjection,
    clearMirroredRuntimeProjection,
    fetchThreads,
    get snapshotActiveRun() {
      return snapshotActiveRun
    },
    set snapshotActiveRun(value: Record<string, unknown> | null) {
      snapshotActiveRun = value
    },
    reset: () => {
      listener = undefined
      threadState = {
        currentThreadId: undefined,
        threads: { 'thread-1': { id: 'thread-1' } },
        setThreads: threadState.setThreads,
      }
      promptState = { prompt: '' }
      threadSubscribers.clear()
      promptSubscribers.clear()
      order.length = 0
      invocations.length = 0
      h.popupVisibilityListener = undefined
      h.threadCreatedListener = undefined
      h.windowLabel = 'main'
      h.sessionEvents = false
      fetchThreads.mockReset().mockResolvedValue([])
      threadState.setThreads.mockClear()
      snapshotActiveRun = {
        runId: 'run-1',
        sessionId: 'thread-1',
        lastSequence: 1,
        content: '你',
        status: 'running',
      }
    },
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: (...args: unknown[]) => h.emitTo(...args),
  listen: vi.fn(async (name: string, listener: any) => {
    h.order.push(`listen:${name}`)
    if (name === 'popup_visibility_changed') {
      h.popupVisibilityListener = listener
      return h.unlistenPopupVisibility
    }
    if (name === 'conversation-thread-created') {
      h.threadCreatedListener = listener
      return vi.fn()
    }
    if (name === 'voice-overlay-handoff') { h.handoffListener = listener; return vi.fn() }
    h.listener = listener
    return h.unlisten
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    h.order.push(command)
    h.invocations.push({ command, args })
    if (command === 'runtime_target_identity') return { targetId: 'target-a' }
    if (command === 'conversation_snapshot') {
      h.listener?.({
        payload: {
          type: 'conversation.selected',
          ...(h.sessionEvents ? { targetId: 'target-a' } : {}),
          cursor: 2,
          originWindow: 'status-popup',
          sessionId: 'thread-1',
        },
      })
      return {
        ...(h.sessionEvents ? { targetId: 'target-a' } : {}),
        cursor: 1,
        selectedSessionId: undefined,
        drafts: { 'thread-1': '草稿' },
        messages: [],
        activeRun: h.snapshotActiveRun,
      }
    }
    return undefined
  }),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: h.windowLabel }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    threads: () => ({ fetchThreads: h.fetchThreads }),
  }),
}))

vi.mock('@/stores/runtime-store', () => ({ useRuntimeStore: Object.assign((select: any) => select({ capabilities: { sessionEvents: h.sessionEvents }, runtimeEpoch: h.sessionEvents ? 'epoch' : undefined }), { getState: () => ({ enabled: h.sessionEvents }) }) }))
vi.mock('@/hooks/useThreads', () => ({ useThreads: h.threads }))
vi.mock('@/hooks/usePrompt', () => ({ usePrompt: h.prompt }))
vi.mock('@/hooks/useMessages', () => ({
  useMessages: {
    getState: () => ({
      upsertLocalMessage: h.upsertLocalMessage,
      removeLocalMessage: h.removeLocalMessage,
      setMessages: h.setMessages,
    }),
  },
}))
vi.mock('@/stores/chat-session-store', () => ({
  useChatSessions: {
    getState: () => ({
      syncPersistentMessage: h.syncPersistentMessage,
      applyMirroredRuntimeEnvelope: h.applyMirroredRuntimeEnvelope,
      syncMirroredRuntimeProjection: h.syncMirroredRuntimeProjection,
      clearMirroredRuntimeProjection: h.clearMirroredRuntimeProjection,
    }),
  },
}))

import { useConversationSyncStore } from '@/stores/conversation-sync-store'
import { ConversationSyncProvider } from '@/providers/ConversationSyncProvider'

describe('ConversationSyncProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.reset()
    useConversationSyncStore.getState().reset()
  })

  it('subscribes before snapshot and replays only the newer buffered event', async () => {
    render(
      <ConversationSyncProvider enabled>
        <div>child</div>
      </ConversationSyncProvider>
    )

    await waitFor(() => {
      expect(useConversationSyncStore.getState().cursor).toBe(2)
    })
    expect(h.order.slice(0, 2)).toEqual([
      'listen:conversation-event',
      'conversation_snapshot',
    ])
    expect(h.threads.getState().currentThreadId).toBe('thread-1')
    expect(h.navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'thread-1' },
      replace: true,
    })
    expect(h.syncMirroredRuntimeProjection).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', content: '你' })
    )
  })

  it('projects remote messages and runtime events, then cleans up', async () => {
    const view = render(
      <ConversationSyncProvider enabled>
        <div>child</div>
      </ConversationSyncProvider>
    )
    await waitFor(() => expect(h.listener).toBeTypeOf('function'))
    await waitFor(() => expect(useConversationSyncStore.getState().cursor).toBe(2))

    act(() => {
      h.listener?.({
        payload: {
          type: 'conversation.message_created',
          cursor: 3,
          originWindow: 'status-popup',
          message: {
            id: 'm1',
            thread_id: 'thread-1',
            role: 'assistant',
          },
        },
      })
      h.listener?.({
        payload: {
          type: 'runtime.event',
          cursor: 4,
          originWindow: 'status-popup',
          event: {
            schemaVersion: '1.0',
            eventId: 'event-2',
            runtimeId: 'hermes',
            runtimeEpoch: 'epoch-1',
            sessionId: 'thread-1',
            runId: 'run-1',
            sequence: 2,
            timestamp: '2026-08-06T00:00:00.000Z',
            event: {
              type: 'text_delta',
              messageId: 'assistant-1',
              delta: '好',
            },
          },
        },
      })
    })

    expect(h.upsertLocalMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1' })
    )
    expect(h.syncPersistentMessage).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ id: 'm1' })
    )
    expect(h.applyMirroredRuntimeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'thread-1',
        event: expect.objectContaining({ type: 'text_delta', delta: '好' }),
      })
    )

    view.unmount()
    expect(h.unlisten).toHaveBeenCalledOnce()
  })

  it('refreshes an authoritative snapshot when the status popup is shown', async () => {
    h.windowLabel = 'status-popup'
    h.threads.setState({ currentThreadId: 'stale-thread' })

    const view = render(
      <ConversationSyncProvider enabled>
        <div>child</div>
      </ConversationSyncProvider>
    )

    await waitFor(() =>
      expect(
        h.invocations.filter(
          ({ command }) => command === 'conversation_snapshot'
        )
      ).toHaveLength(1)
    )
    expect(h.invocations[0]).toEqual({
      command: 'conversation_snapshot',
      args: { sessionId: undefined, originWindow: 'status-popup' },
    })
    expect(h.order).toContain('listen:popup_visibility_changed')

    h.snapshotActiveRun = null
    act(() => {
      h.popupVisibilityListener?.({ payload: true })
    })

    await waitFor(() =>
      expect(
        h.invocations.filter(
          ({ command }) => command === 'conversation_snapshot'
        )
      ).toHaveLength(2)
    )
    expect(h.clearMirroredRuntimeProjection).toHaveBeenCalledWith('thread-1')

    view.unmount()
    expect(h.unlistenPopupVisibility).toHaveBeenCalledOnce()
  })

  it('navigates the status popup without fetching threads during extension startup', async () => {
    h.windowLabel = 'status-popup'
    h.threads.setState({ currentThreadId: undefined, threads: {} })
    h.fetchThreads.mockRejectedValue(
      new Error('Conversational extension not available yet')
    )

    render(
      <ConversationSyncProvider enabled>
        <div>child</div>
      </ConversationSyncProvider>
    )

    await waitFor(() => {
      expect(useConversationSyncStore.getState().cursor).toBe(2)
    })
    expect(h.fetchThreads).not.toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'thread-1' },
      replace: true,
    })
  })

  it('captures the session and text together when debouncing draft updates', async () => {
    render(
      <ConversationSyncProvider enabled>
        <div>child</div>
      </ConversationSyncProvider>
    )

    await waitFor(() => expect(useConversationSyncStore.getState().cursor).toBe(2))

    act(() => {
      h.prompt.setState({ prompt: '草稿 A' })
      h.threads.setState({ currentThreadId: 'thread-2' })
    })

    await waitFor(() =>
      expect(h.invocations).toContainEqual({
        command: 'conversation_update_draft',
        args: {
          originWindow: 'main',
          sessionId: 'thread-1',
          draft: '草稿 A',
        },
      })
    )
  })
})


it('Session 快速窗选择只接受同target且不写入旧纯文本投影', async () => {
  h.reset()
  h.sessionEvents = true
  h.windowLabel = 'status-popup'
  h.navigate.mockClear()
  h.syncPersistentMessage.mockClear()
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(h.threads.getState().currentThreadId).toBe('thread-1'))
  expect(h.invocations).toContainEqual({ command: 'conversation_snapshot', args: expect.objectContaining({ expectedTargetId: 'target-a' }) })
  h.navigate.mockClear()
  act(() => h.listener?.({ payload: { type: 'conversation.selected', targetId: 'target-other', cursor: 3, originWindow: 'main', sessionId: 'wrong' } }))
  expect(h.threads.getState().currentThreadId).toBe('thread-1')
  expect(h.navigate).not.toHaveBeenCalled()
  act(() => h.threads.setState({ currentThreadId: 'next', currentThreadTargetId: 'target-a' }))
  await waitFor(() => expect(h.invocations).toContainEqual({ command: 'conversation_select_session', args: { originWindow: 'status-popup', sessionId: 'next', expectedTargetId: 'target-a' } }))
  await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({
    to: '/threads/$threadId',
    params: { threadId: 'next' },
    replace: true,
  }))
  expect(h.syncPersistentMessage).not.toHaveBeenCalled()
})

it('Session 草稿只在同一 Runtime target 的窗口间同步', async () => {
  h.reset()
  h.sessionEvents = true
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(h.threads.getState().currentThreadId).toBe('thread-1'))

  act(() => h.prompt.setState({ prompt: '本地草稿' }))
  await waitFor(() => expect(h.invocations).toContainEqual({
    command: 'conversation_update_draft',
    args: {
      originWindow: 'main',
      sessionId: 'thread-1',
      draft: '本地草稿',
      expectedTargetId: 'target-a',
    },
  }))

  act(() => h.listener?.({ payload: {
    type: 'conversation.draft_changed',
    targetId: 'target-other',
    cursor: 4,
    originWindow: 'voice-overlay',
    sessionId: 'thread-1',
    draft: '串线草稿',
  } }))
  expect(h.prompt.getState().prompt).toBe('本地草稿')

  act(() => h.listener?.({ payload: {
    type: 'conversation.draft_changed',
    targetId: 'target-a',
    cursor: 5,
    originWindow: 'voice-overlay',
    sessionId: 'thread-1',
    draft: '语音草稿',
  } }))
  expect(h.prompt.getState().prompt).toBe('语音草稿')
})

it('does not navigate a stale remote selection over a newer local selection', async () => {
  h.reset()
  h.sessionEvents = true
  h.threads.setState({ threads: { 'thread-1': { id: 'thread-1' }, next: { id: 'next' } } })
  let finish!: (threads: any[]) => void
  h.fetchThreads.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(h.threads.getState().currentThreadId).toBe('thread-1'))
  h.navigate.mockClear()

  act(() => h.listener?.({ payload: { type: 'conversation.selected', targetId: 'target-a', cursor: 3, originWindow: 'other', sessionId: 'slow' } }))
  await waitFor(() => expect(h.fetchThreads).toHaveBeenCalledOnce())
  act(() => h.threads.setState({ currentThreadId: 'next', currentThreadTargetId: 'target-a' }))
  finish([{ id: 'slow' }, { id: 'next' }])

  await waitFor(() => expect(h.invocations).toContainEqual({ command: 'conversation_select_session', args: { originWindow: 'main', sessionId: 'next', expectedTargetId: 'target-a' } }))
  expect(h.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ params: { threadId: 'slow' } }))
})

it('重复远程选择当前 Session 不覆盖当前及持久草稿，返回首页仍清空输入框', async () => {
  h.reset()
  h.sessionEvents = true
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(h.threads.getState().currentThreadId).toBe('thread-1'))
  act(() => h.prompt.setState({ prompt: 'print("hello")' }))
  let savedDraft = h.prompt.getState().prompt
  const unsubscribe = h.prompt.subscribe(state => {
    if (h.threads.getState().currentThreadId === 'thread-1') savedDraft = state.prompt
  })
  act(() => h.listener?.({ payload: { type: 'conversation.selected', targetId: 'target-a', cursor: 5, originWindow: 'status-popup', sessionId: 'thread-1' } }))
  expect(h.prompt.getState().prompt).toBe('print("hello")')
  expect(savedDraft).toBe('print("hello")')
  act(() => h.threads.setState({ currentThreadId: undefined }))
  expect(h.prompt.getState().prompt).toBe('')
  expect(savedDraft).toBe('print("hello")')
  unsubscribe()
})

it.each(['matching', 'different-text', 'corrupt', 'other-target'])('草稿同步按目标和正文隔离：%s', async kind => {
  h.reset()
  h.sessionEvents = true
  const key = `bibit:session-draft:${JSON.stringify([kind === 'other-target' ? 'target-b' : 'target-a', 'thread-1'])}`
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(h.threads.getState().currentThreadId).toBe('thread-1'))
  localStorage.setItem(key, kind === 'corrupt' ? '{bad' : JSON.stringify({ content: kind === 'different-text' ? '旧正文' : '同步正文', draftToken: 'draft-v1' }))
  act(() => h.listener?.({ payload: { type: 'conversation.draft_changed', targetId: 'target-a', cursor: 20, originWindow: 'voice-overlay', sessionId: 'thread-1', draft: '同步正文' } }))
  expect(h.prompt.getState().prompt).toBe('同步正文')
  localStorage.removeItem(key)
})

it('浮窗不继承主窗口选择，清空后远端选择也不会拉回旧会话', async () => {
  vi.clearAllMocks()
  h.reset()
  useConversationSyncStore.getState().reset()
  h.windowLabel = 'voice-overlay'
  h.prompt.setState({ prompt: '尚未提交的草稿' })
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(useConversationSyncStore.getState().cursor).toBeGreaterThan(0))
  expect(h.threads.getState().currentThreadId).toBeUndefined()
  expect(h.prompt.getState().prompt).toBe('尚未提交的草稿')
  act(() => h.listener?.({ payload: {
    type: 'conversation.selected', cursor: 99, originWindow: 'main', sessionId: 'thread-1',
  } }))
  expect(h.threads.getState().currentThreadId).toBeUndefined()
  expect(h.navigate).not.toHaveBeenCalled()
})

it('浮窗切会话不广播选择，主窗口不会被拉走', async () => {
vi.clearAllMocks()
  h.reset()
  useConversationSyncStore.getState().reset()
  h.windowLabel = 'voice-overlay'
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(useConversationSyncStore.getState().cursor).toBeGreaterThan(0))
  h.invocations.length = 0

  // 用户在浮窗里挑了一个目标会话。
  act(() => h.threads.setState({ currentThreadId: 'thread-7' }))

  // 这一步绝不能广播出去：主窗口正在别的会话里干活。
  await waitFor(() => expect(h.threads.getState().currentThreadId).toBe('thread-7'))
  expect(h.invocations.filter(i => i.command === 'conversation_select_session')).toEqual([])
})

it('主窗口收到浮窗的选择广播时不会被拉走', async () => {
  vi.clearAllMocks()
  h.reset()
  useConversationSyncStore.getState().reset()
  h.windowLabel = 'main'
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(useConversationSyncStore.getState().cursor).toBeGreaterThan(0))
  h.navigate.mockClear()

  act(() => h.listener?.({ payload: {
    type: 'conversation.selected', cursor: 777, originWindow: 'voice-overlay', sessionId: 'thread-voice',
  } }))

  expect(h.threads.getState().currentThreadId).not.toBe('thread-voice')
  expect(h.navigate).not.toHaveBeenCalled()
})

it('主窗口切会话照旧广播（隔离只针对浮窗）', async () => {
  vi.clearAllMocks()
  h.reset()
  useConversationSyncStore.getState().reset()
  h.windowLabel = 'main'
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(useConversationSyncStore.getState().cursor).toBeGreaterThan(0))
  h.invocations.length = 0

  act(() => h.threads.setState({ currentThreadId: 'thread-9' }))

  await waitFor(() => expect(
    h.invocations.filter(i => i.command === 'conversation_select_session'),
  ).not.toEqual([]))
})

it('主窗口导航失败返回错误 ACK，不把失败交接报告为成功', async () => {
  vi.clearAllMocks()
  h.reset()
  h.sessionEvents = true
  h.handoffListener = undefined
  h.fetchThreads.mockRejectedValueOnce(new Error('会话不可用'))
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(h.handoffListener).toBeDefined())
  act(() => h.handoffListener?.({ payload: {
    id: 'handoff-failure', sessionId: 'missing', targetId: 'target-a', runtimeEnabled: true,
    draft: '保留输入', attachments: [],
  } }))
  await waitFor(() => expect(h.emitTo).toHaveBeenCalledWith('voice-overlay', 'voice-overlay-handoff-ack', {
    id: 'handoff-failure', error: expect.stringContaining('The main window could not open the target conversation'),
  }))
  expect(h.emitTo).not.toHaveBeenCalledWith('voice-overlay', 'voice-overlay-handoff-ack', { id: 'handoff-failure' })
})

it('尚无会话的草稿直接交给主窗口，确认后仍不创建会话', async () => {
  vi.clearAllMocks()
  h.reset()
  h.sessionEvents = true
  h.handoffListener = undefined
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(h.handoffListener).toBeDefined())
  act(() => h.handoffListener?.({ payload: {
    id: 'blank-handoff', targetId: 'target-a', runtimeEnabled: true,
    draft: '没有提交的草稿', attachments: [],
  } }))
  await waitFor(() => expect(h.emitTo).toHaveBeenCalledWith('voice-overlay', 'voice-overlay-handoff-ack', { id: 'blank-handoff' }))
  expect(h.prompt.getState().prompt).toBe('没有提交的草稿')
  expect(h.threads.getState().currentThreadId).toBeUndefined()
  expect(h.navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  expect(h.invocations.some(call => /create/.test(call.command))).toBe(false)
})

it('浮窗创建会话后刷新主窗口列表但不改变主窗口选择', async () => {
  vi.clearAllMocks()
  h.reset()
  h.threads.setState({ currentThreadId: 'thread-1' })
  render(<ConversationSyncProvider enabled><div /></ConversationSyncProvider>)
  await waitFor(() => expect(h.threadCreatedListener).toBeDefined())
  h.fetchThreads.mockClear()
  h.fetchThreads.mockResolvedValueOnce([{ id: 'thread-new' }])

  act(() => h.threadCreatedListener?.({ payload: { sessionId: 'thread-new' } }))

  await waitFor(() => expect(h.fetchThreads).toHaveBeenCalled())
  expect(h.threads.getState().setThreads).toHaveBeenCalledWith([{ id: 'thread-new' }])
  expect(h.threads.getState().currentThreadId).toBe('thread-1')
  expect(h.navigate).not.toHaveBeenCalled()
})
