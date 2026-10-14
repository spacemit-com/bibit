import { act, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  navigate: vi.fn(),
  pathname: '/',
  createThread: vi.fn(),
  currentThreadId: 'thread-current' as string | undefined,
  selectedModel: { id: 'model-1', provider: 'openai' },
  selectedProvider: 'openai',
  runtimeEnabled: false,
  emitEvent: undefined as undefined | ((payload: unknown) => void),
  replay: [] as unknown[],
  dispose: vi.fn(),
  dismiss: undefined as undefined | (() => void),
  sessions: {} as Record<string, { isStreaming?: boolean; chat?: { stop: () => void } }>,
  stopChat: vi.fn(),
  cancelRun: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) => select({ pathname: h.pathname }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: vi.fn((_event: string, handler: (payload: unknown) => void) => {
    if (_event === 'voice-tool-event') h.emitEvent = handler
    else h.dismiss = () => handler({ payload: null })
    return Promise.resolve(h.dispose)
  }),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ createThread: h.createThread }),
    { getState: () => ({ currentThreadId: h.currentThreadId }) }
  ),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: Object.assign(() => ({}), {
    getState: () => ({
      selectedModel: h.selectedModel,
      selectedProvider: h.selectedProvider,
      providers: [],
      getProviderByName: () => ({ provider: h.selectedProvider }),
      selectModelProvider: vi.fn(),
    }),
  }),
}))

vi.mock('@/stores/runtime-store', () => ({
  useRuntimeStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ enabled: h.runtimeEnabled }),
    { getState: () => ({ enabled: h.runtimeEnabled }) }
  ),
}))

vi.mock('@/stores/chat-session-store', () => ({
  isSessionBusy: (session: { isStreaming?: boolean } | undefined) => Boolean(session?.isStreaming),
  useChatSessions: { getState: () => ({ sessions: h.sessions }) },
}))

vi.mock('@/lib/coordinated-stop', () => ({
  cancelCoordinatedSessionRun: (...args: unknown[]) => h.cancelRun(...args),
}))

vi.mock('@/lib/models', () => ({ defaultModel: () => 'default-model' }))

import { VoiceOverlayBridge } from '@/components/VoiceOverlayBridge'
import { useVoiceInputStore } from '@/stores/voice-input-store'
import { useOverlayConversationStore } from '@/stores/overlay-conversation-store'
import { useVoiceStatusStore } from '@/stores/voice-status-store'
import { describeVoiceFeedback } from '@/lib/voice-feedback'

const emit = (payload: Record<string, unknown>) =>
  act(() => h.emitEvent?.({ payload }))

const emittedCommands = () => h.invoke.mock.calls.map(([command]) => command)

describe('VoiceOverlayBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOverlayConversationStore.setState({ busy: false, handingOff: 0 })
    useVoiceInputStore.setState({ mode: 'voice', phase: 'idle', error: '', pending: [], readyId: undefined })
    useVoiceStatusStore.setState({ status: null, offline: false })
    h.pathname = '/'
    h.navigate.mockResolvedValue(undefined)
    h.replay = []
    h.emitEvent = undefined
    h.dismiss = undefined
    h.runtimeEnabled = false
    h.currentThreadId = 'thread-current'
    h.sessions = {}
    h.cancelRun.mockResolvedValue(true)
    h.dispose.mockClear()
    h.createThread.mockResolvedValue({ id: 'thread-created' })
    h.invoke.mockImplementation((command: string) => {
      if (command === 'voice_tool_replay_events') return Promise.resolve(h.replay)
      if (command === 'conversation_snapshot') {
        return Promise.resolve({
          cursor: 1,
          selectedSessionId: h.currentThreadId,
          drafts: {},
          messages: [],
        })
      }
      if (command === 'runtime_target_identity') {
        return Promise.resolve({ targetId: 'target-a', runtimeEpoch: 'epoch-a' })
      }
      if (command === 'runtime_agents_list') {
        return Promise.resolve([{ id: 'agent-1', available: true }])
      }
      return Promise.resolve(undefined)
    })
  })

  it('hands the final text to the same-window thread without overwriting its draft', async () => {
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 101 })
    await emit({ event: 'asr_final', session_id: 101, text: '  你好 BiBit  ' })

    await waitFor(() => expect(useVoiceInputStore.getState().pending).toEqual([
      { id: expect.any(String), sessionId: 'thread-current', text: '你好 BiBit' },
    ]))
    expect(h.createThread).not.toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId', params: { threadId: 'thread-current' },
    })
    expect(h.invoke).toHaveBeenCalledWith('show_voice_overlay')
    for (const command of ['conversation_update_draft', 'open_main_window', 'hide_voice_overlay']) {
      expect(emittedCommands()).not.toContain(command)
    }
  })

  it('creates exactly one thread and pending input for repeated final events', async () => {
    h.currentThreadId = undefined
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 102 })
    await emit({ event: 'asr_final', session_id: 102, text: '新会话' })
    await emit({ event: 'asr_final', session_id: 102, text: '新会话' })
    await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(1))
    expect(h.createThread).toHaveBeenCalledTimes(1)
    expect(useVoiceInputStore.getState().pending[0].sessionId).toBe('thread-created')
  })

  it('binds a new Runtime session and pending input to the captured target', async () => {
    h.runtimeEnabled = true
    h.currentThreadId = undefined
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 103 })
    await emit({ event: 'asr_final', session_id: 103, text: '运行任务' })
    await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(1))
    expect(h.createThread).toHaveBeenCalledWith(
      { id: 'agent-1', provider: 'runtime' }, 'Voice session',
      false, 'target-a'
    )
    expect(useVoiceInputStore.getState().pending[0]).toMatchObject({
      sessionId: 'thread-created', targetId: 'target-a', runtimeEpoch: 'epoch-a',
    })
  })

  it('rejects a late final result after the Runtime target changes', async () => {
    h.runtimeEnabled = true
    let identityCalls = 0
    h.invoke.mockImplementation((command: string) => {
      if (command === 'voice_tool_replay_events') return Promise.resolve([])
      if (command === 'runtime_target_identity') {
        identityCalls += 1
        return Promise.resolve(identityCalls === 1
          ? { targetId: 'target-a', runtimeEpoch: 'epoch-a' }
          : { targetId: 'target-b', runtimeEpoch: 'epoch-b' })
      }
      if (command === 'conversation_snapshot') {
        return Promise.resolve({ cursor: 1, targetId: 'target-a', selectedSessionId: 'thread-current', drafts: {}, messages: [] })
      }
      return Promise.resolve(undefined)
    })

    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 104 })
    await emit({ event: 'asr_final', session_id: 104, text: '不能串线' })

    await waitFor(() => expect(useVoiceInputStore.getState().failure).toEqual({ kind: 'send', text: '不能串线' }))
    expect(useVoiceInputStore.getState().error).toContain('The Runtime target changed')
    expect(emittedCommands()).not.toContain('conversation_update_draft')
    expect(h.createThread).not.toHaveBeenCalled()
  })

  it('does not cancel, create, or stage an empty result', async () => {
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 105 })
    await emit({ event: 'asr_final', session_id: 105, text: '   ' })

    // asr_final 后不再 cancel：voice tool 已切 followup 会话，
    // 迟到的 cancel 只会 SESSION_MISMATCH。
    expect(h.invoke).not.toHaveBeenCalledWith('voice_tool_cancel', expect.anything())
    expect(h.createThread).not.toHaveBeenCalled()
    expect(emittedCommands()).not.toContain('conversation_update_draft')
  })

  it('语音失败只归约到 store，界面呈现交给输入区', async () => {
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 106 })
    await emit({ event: 'error', session_id: 106, code: 'AUDIO_OPEN_FAILED' })
    await waitFor(() => expect(useVoiceInputStore.getState().phase).toBe('error'))
    expect(useVoiceInputStore.getState().error).toBe('AUDIO_OPEN_FAILED')
    // 桥只做归约：原来那条窗口顶部的横幅已经移出，原始码交给 voice-feedback 投影。
    await emit({ event: 'session_cancelled', session_id: 106 })
    expect(emittedCommands()).not.toContain('open_main_window')
    expect(emittedCommands()).not.toContain('hide_voice_overlay')
  })

  it('带原始英文说明的失败码仍然按码保留，界面不会拿到那段英文', async () => {
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    // 会话 ID 只能排在后面几个用例之前：桥用的是模块级 latestSession。
    await emit({ event: 'wake_triggered', session_id: 107 })
    await emit({
      event: 'error',
      session_id: 107,
      code: 'QWEN3_ASR_FAILED',
      message: 'llama_decode returned -3',
    })
    await waitFor(() => expect(useVoiceInputStore.getState().phase).toBe('error'))
    // 码在前，投影层据此给用户文案；原始英文只留在 store 里当诊断。
    expect(useVoiceInputStore.getState().error).toBe('QWEN3_ASR_FAILED llama_decode returned -3')
    expect(describeVoiceFeedback(null, useVoiceInputStore.getState().error, 'ready')).toMatchObject({
      messageKey: 'chat:voiceRecognizeFailed',
    })
  })

  it('starts a manual session without requiring a wake event', async () => {
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'listening', session_id: 108 })
    await emit({ event: 'asr_state', state: 'started', reason: 'manual', session_id: 108 })
    await emit({ event: 'asr_final', session_id: 108, text: '手动语音' })
    await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(1))
  })

  it('does not requeue a completed session when events replay after remount', async () => {
    h.replay = [
      { event: 'wake_triggered', session_id: 109 },
      { event: 'asr_final', session_id: 109, text: '只发一次' },
    ]
    const first = render(<VoiceOverlayBridge />)
    await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(1))
    h.pathname = '/threads/thread-current'
    first.unmount()
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.invoke.mock.calls.filter(([cmd]) => cmd === 'voice_tool_replay_events')).toHaveLength(2))
    expect(useVoiceInputStore.getState().pending).toHaveLength(1)
    expect(h.navigate).toHaveBeenCalledTimes(1)
  })

  it('accepts reused session ids after service status proves a counter reset', async () => {
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 110 })
    await emit({ event: 'asr_final', session_id: 110, text: '重启前' })
    await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(1))
    await emit({ event: 'status', session_id: 0, mode: 'idle' })
    await emit({ event: 'wake_triggered', session_id: 110 })
    await emit({ event: 'asr_final', session_id: 110, text: '重启后' })
    await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(2))
  })

  it('handles context lookup rejection immediately even without a final event', async () => {
    h.invoke.mockImplementation((command: string) => command === 'voice_overlay_generation'
      ? Promise.reject(new Error('会话读取失败')) : Promise.resolve([]))
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 111 })
    await waitFor(() => expect(useVoiceInputStore.getState().phase).toBe('error'))
    expect(useVoiceInputStore.getState().error).toContain('会话读取失败')
    expect(useVoiceInputStore.getState().pending).toEqual([])
  })

  it('ignores a cancelled final and followup listening events', async () => {
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 112 })
    await emit({ event: 'session_cancelled', session_id: 112 })
    await emit({ event: 'asr_final', session_id: 112, text: '迟到' })
    await emit({ event: 'listening', session_id: 113 })
    await emit({ event: 'asr_state', state: 'started', reason: 'followup', session_id: 113 })
    await emit({ event: 'asr_final', session_id: 113, text: '意外追问' })
    expect(useVoiceInputStore.getState().pending).toEqual([])
    expect(useVoiceInputStore.getState().phase).toBe('idle')
  })

  it('keeps both accepted finals when the first context resolves after the next wake and keyboard switch', async () => {
    h.runtimeEnabled = true
    let resolveFirst!: (value: unknown) => void
    const firstContext = new Promise((resolve) => { resolveFirst = resolve })
    const invokeDefault = h.invoke.getMockImplementation()!
    let snapshots = 0
    h.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === 'voice_overlay_generation') {
        snapshots += 1
        return snapshots === 1 ? firstContext : Promise.resolve(undefined)
      }
      return invokeDefault(command, ...args)
    })
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    h.currentThreadId = 'thread-first'
    await emit({ event: 'wake_triggered', session_id: 114 })
    await emit({ event: 'asr_final', session_id: 114, text: '第一轮' })
    h.currentThreadId = 'thread-second'
    await emit({ event: 'wake_triggered', session_id: 115 })
    await emit({ event: 'asr_final', session_id: 115, text: '第二轮' })
    act(() => useVoiceInputStore.setState({ mode: 'keyboard', phase: 'idle' }))
    await act(async () => resolveFirst(undefined))
    await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(2))
    expect(useVoiceInputStore.getState().pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'thread-first', text: '第一轮', targetId: 'target-a', runtimeEpoch: 'epoch-a' }),
      expect.objectContaining({ sessionId: 'thread-second', text: '第二轮', targetId: 'target-a', runtimeEpoch: 'epoch-a' }),
    ]))
    expect(h.invoke).toHaveBeenCalledWith('conversation_select_session', {
      originWindow: 'voice-overlay', sessionId: 'thread-first', expectedTargetId: 'target-a',
    })
    expect(h.invoke).not.toHaveBeenCalledWith('conversation_select_session', {
      originWindow: 'voice-overlay', sessionId: 'thread-second', expectedTargetId: 'target-a',
    })
    // 两轮独立捕获并校验，只有队首进入导航。
    expect(h.invoke.mock.calls.filter(([command]) => command === 'runtime_target_identity')).toHaveLength(5)
  })

  it('rejects late final immediately while keyboard cancellation is still pending', async () => {
    const invokeDefault = h.invoke.getMockImplementation()!
    let finishCancel!: () => void
    h.invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'voice_tool_cancel_current'
      ? new Promise<void>((resolve) => { finishCancel = resolve })
      : invokeDefault(command, ...args))
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 116 })
    await emit({ event: 'error', session_id: 116, reason: '重试或取消' })
    // 切键盘的按钮现在在输入区（VoiceComposer），桥只认状态变化。
    const cancel = h.invoke('voice_tool_cancel_current')
    act(() => useVoiceInputStore.setState({ mode: 'keyboard', phase: 'idle' }))
    expect(useVoiceInputStore.getState().mode).toBe('keyboard')
    await emit({ event: 'asr_final', session_id: 116, text: '取消途中迟到' })
    expect(useVoiceInputStore.getState().pending).toEqual([])
    await act(async () => finishCancel())
    await cancel
  })


  it('does not replace the next recording phase when a previous final finishes handing off', async () => {
    const invokeDefault = h.invoke.getMockImplementation()!
    let resolveFirst!: (value: unknown) => void
    let snapshots = 0
    const firstContext = new Promise((resolve) => { resolveFirst = resolve })
    h.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === 'conversation_snapshot' && ++snapshots === 1) return firstContext
      return invokeDefault(command, ...args)
    })
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 117 })
    await emit({ event: 'asr_final', session_id: 117, text: '上一轮结果' })
    await emit({ event: 'wake_triggered', session_id: 118 })
    expect(useVoiceInputStore.getState().phase).toBe('listening')
    await act(async () => resolveFirst({ selectedSessionId: 'thread-first' }))
    await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(1))
    expect(useVoiceInputStore.getState().phase).toBe('listening')
    await emit({ event: 'asr_final', session_id: 118, text: '下一轮结果' })
    await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(2))
  })


  it('navigates queued inputs serially and releases each only after the overlay is shown', async () => {
    let finishFirstShow!: () => void
    const invokeDefault = h.invoke.getMockImplementation()!
    let showCalls = 0
    h.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === 'show_voice_overlay' && ++showCalls === 1) {
        return new Promise<void>((resolve) => { finishFirstShow = resolve })
      }
      return invokeDefault(command, ...args)
    })
    const view = render(<VoiceOverlayBridge />)
    act(() => useVoiceInputStore.setState({ pending: [
      { id: 'queue-a', sessionId: 'thread-a', text: '任务 A' },
      { id: 'queue-b', sessionId: 'thread-b', text: '任务 B' },
    ] }))
    await waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1))
    expect(h.navigate).toHaveBeenLastCalledWith({ to: '/threads/$threadId', params: { threadId: 'thread-a' } })
    h.pathname = '/threads/thread-a'
    view.rerender(<VoiceOverlayBridge />)
    expect(useVoiceInputStore.getState().readyId).toBeUndefined()
    expect(h.navigate).toHaveBeenCalledTimes(1)
    await act(async () => finishFirstShow())
    expect(useVoiceInputStore.getState().readyId).toBe('queue-a')
    // 模拟当前路由消费成功后才移除队首。
    act(() => useVoiceInputStore.setState((state) => ({ pending: state.pending.slice(1) })))
    await waitFor(() => expect(useVoiceInputStore.getState().readyId).toBe('queue-b'))
    expect(h.navigate).toHaveBeenCalledTimes(2)
    expect(h.navigate).toHaveBeenLastCalledWith({ to: '/threads/$threadId', params: { threadId: 'thread-b' } })
  })

  it('removes a failed navigation from the queue and keeps its recognized text', async () => {
    h.navigate.mockRejectedValue(new Error('无法打开会话'))
    render(<VoiceOverlayBridge />)
    act(() => useVoiceInputStore.setState({ pending: [
      { id: 'queue-failed', sessionId: 'thread-failed', text: '需要保留的语音' },
    ] }))
    await waitFor(() => expect(useVoiceInputStore.getState().failure).toEqual({ kind: 'send', text: '需要保留的语音' }))
    expect(useVoiceInputStore.getState().pending).toEqual([])
    expect(useVoiceInputStore.getState().readyId).toBeUndefined()
    expect(h.navigate).toHaveBeenCalledTimes(1)
  })

  it('旧失败不影响下一轮录音的进行状态', () => {
    render(<VoiceOverlayBridge />)
    act(() => useVoiceInputStore.setState({
      phase: 'listening',
      error: '发送失败：上一条语音',
      failure: { kind: 'send', text: '上一条语音' },
    }))
    expect(useVoiceInputStore.getState().phase).toBe('listening')
  })

  it('审计：旧交接失败保留原文且不覆盖下一轮录音', async () => {
    let rejectSnapshot!: (error: Error) => void
    const normal = h.invoke.getMockImplementation()!
    let snapshots = 0
    h.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === 'voice_overlay_generation' && ++snapshots === 1) {
        return new Promise((_resolve, reject) => { rejectSnapshot = reject })
      }
      return normal(command, ...args)
    })
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 20001 })
    await emit({ event: 'asr_final', session_id: 20001, text: '需要保留的上一条指令' })
    await emit({ event: 'wake_triggered', session_id: 20002 })
    await act(async () => rejectSnapshot(new Error('快照读取失败')))
    expect.soft(useVoiceInputStore.getState().phase).toBe('listening')
    expect.soft(useVoiceInputStore.getState().failure).toEqual({ kind: 'send', text: '需要保留的上一条指令' })
  })

  it('审计：交接异步耗时不应颠倒用户指令顺序', async () => {
    let resolveSnapshot!: (value: unknown) => void
    const normal = h.invoke.getMockImplementation()!
    let snapshots = 0
    h.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === 'voice_overlay_generation' && ++snapshots === 1) {
        return new Promise(resolve => { resolveSnapshot = resolve })
      }
      return normal(command, ...args)
    })
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 21001 })
    await emit({ event: 'asr_final', session_id: 21001, text: '先创建文件' })
    await emit({ event: 'wake_triggered', session_id: 21002 })
    await emit({ event: 'asr_final', session_id: 21002, text: '再修改文件' })
    await act(async () => resolveSnapshot(7))
    await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(2))
    expect(useVoiceInputStore.getState().pending.map(input => input.text)).toEqual(['先创建文件', '再修改文件'])
  })

  it('discards a late final after the native overlay dismissal', async () => {
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.dismiss).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 22001 })
    act(() => h.dismiss?.())
    await emit({ event: 'asr_final', session_id: 22001, text: '已经取消' })
    expect(useVoiceInputStore.getState().pending).toEqual([])
    expect(h.invoke).not.toHaveBeenCalledWith('show_voice_overlay')
  })

  it('carries the captured window generation through an in-flight handoff', async () => {
    const normal = h.invoke.getMockImplementation()!
    let resolveSnapshot!: (value: unknown) => void
    h.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === 'voice_overlay_generation') return new Promise(resolve => { resolveSnapshot = resolve })
      return normal(command, ...args)
    })
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.dismiss).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 22002 })
    await emit({ event: 'asr_final', session_id: 22002, text: '已接受的指令' })
    act(() => h.dismiss?.())
    await act(async () => resolveSnapshot(7))
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('show_voice_overlay', { expectedGeneration: 7 }))
    expect(useVoiceInputStore.getState().pending[0].text).toBe('已接受的指令')
  })

  // 模块级的 latestSession 跨用例保留，这组用例固定在文件末尾并取更大的 session id，
  // 免得把前面用例的递增序列顶掉。
  it('interrupts the running answer when Bibit is woken again', async () => {
    h.runtimeEnabled = true
    h.sessions = { 'thread-current': { isStreaming: true, chat: { stop: h.stopChat } } }
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())

    await emit({ event: 'wake_triggered', session_id: 900001 })

    await waitFor(() =>
      expect(h.cancelRun).toHaveBeenCalledWith('thread-current', expect.anything(), undefined, true)
    )
  })

  it('stops a local chat when Bibit is woken again outside Runtime', async () => {
    h.runtimeEnabled = false
    h.sessions = { 'thread-current': { isStreaming: true, chat: { stop: h.stopChat } } }
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())

    await emit({ event: 'wake_triggered', session_id: 900002 })

    await waitFor(() => expect(h.stopChat).toHaveBeenCalled())
    expect(h.cancelRun).not.toHaveBeenCalled()
  })

  it('leaves an idle thread untouched when Bibit is woken again', async () => {
    h.runtimeEnabled = true
    h.sessions = { 'thread-current': { isStreaming: false, chat: { stop: h.stopChat } } }
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())

    await emit({ event: 'wake_triggered', session_id: 900003 })

    await waitFor(() => expect(useVoiceInputStore.getState().phase).toBe('listening'))
    expect(h.cancelRun).not.toHaveBeenCalled()
    expect(h.stopChat).not.toHaveBeenCalled()
  })

  it('再次唤醒会打断没有旧 ChatSession 的 Runtime Session', async () => {
    h.runtimeEnabled = true
    h.sessions = {}
    useOverlayConversationStore.setState({ busy: true })
    render(<VoiceOverlayBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())
    await emit({ event: 'wake_triggered', session_id: 900004 })
    await waitFor(() => expect(h.cancelRun).toHaveBeenCalledWith('thread-current', expect.anything(), undefined, true))
  })
})
