import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { VoiceBallBusyBridge } from '../VoiceBallBusyBridge'
import { useThreads } from '@/hooks/useThreads'
import { useChatSessions } from '@/stores/chat-session-store'
import { useOverlayConversationStore } from '@/stores/overlay-conversation-store'
import { useVoiceInputStore } from '@/stores/voice-input-store'

const emitTo = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({ emitTo: (...args: unknown[]) => emitTo(...args) }))
// vitest 里 IS_TAURI 恒 false，组件靠 isPlatformTauri() 守卫，这里放行。
vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => true }))

/** 只保留 bridge 关心的字段；isSessionBusy 读 isStreaming 和 data.tools。 */
function session(overrides: Record<string, unknown> = {}) {
  return { isStreaming: false, data: { tools: [], messages: [], idMap: new Map() }, ...overrides }
}

function thinkingCalls() {
  return emitTo.mock.calls
    .filter(([target, event]) => target === 'voice-ball' && event === 'voice-ball:set-thinking')
    .map(([, , payload]) => (payload as { thinking: boolean }).thinking)
}

describe('VoiceBallBusyBridge', () => {
  const threads = useThreads.getState()
  const sessions = useChatSessions.getState()

  beforeEach(() => {
    emitTo.mockClear()
    useThreads.setState({ currentThreadId: undefined })
    useChatSessions.setState({ sessions: {} })
    useVoiceInputStore.setState({ phase: 'idle', pending: [] })
    useOverlayConversationStore.setState({ handingOff: 0, busy: false })
  })

  afterEach(() => {
useThreads.setState(threads, true)
    useChatSessions.setState(sessions, true)
  })

  it('挂载时先推一次空闲，让球有确定初值', () => {
    render(<VoiceBallBusyBridge />)
    expect(thinkingCalls()).toEqual([false])
  })

  it('会话开始流式输出时推 thinking=true', () => {
    useThreads.setState({ currentThreadId: 't1' })
    render(<VoiceBallBusyBridge />)
    emitTo.mockClear()

    useChatSessions.setState({ sessions: { t1: session({ isStreaming: true }) } as never })

    expect(thinkingCalls()).toEqual([true])
  })

  it('有工具在跑也算忙', () => {
    useThreads.setState({ currentThreadId: 't1' })
    render(<VoiceBallBusyBridge />)
    emitTo.mockClear()

    useChatSessions.setState({
 sessions: { t1: session({ data: { tools: [{ id: 'x' }], messages: [], idMap: new Map() } }) },
    } as never)

    expect(thinkingCalls()).toEqual([true])
  })

  it('同一状态重复写入不再发 IPC（只在边沿发）', () => {
    useThreads.setState({ currentThreadId: 't1' })
    render(<VoiceBallBusyBridge />)
    useChatSessions.setState({ sessions: { t1: session({ isStreaming: true }) } as never })
    emitTo.mockClear()

    // 模拟流式过程中的多次 chunk 更新，忙碌结论不变。
    useChatSessions.setState({ sessions: { t1: session({ isStreaming: true }) } as never })
    useChatSessions.setState({ sessions: { t1: session({ isStreaming: true }) } as never })

    expect(thinkingCalls()).toEqual([])
  })

  it('流式结束回落 thinking=false', () => {
 useThreads.setState({ currentThreadId: 't1' })
    render(<VoiceBallBusyBridge />)
    useChatSessions.setState({ sessions: { t1: session({ isStreaming: true }) } as never })
    emitTo.mockClear()

    useChatSessions.setState({ sessions: { t1: session({ isStreaming: false }) } as never })

    expect(thinkingCalls()).toEqual([false])
  })

  it('切到不忙的会话要回落', () => {
    useThreads.setState({ currentThreadId: 't1' })
  useChatSessions.setState({
      sessions: { t1: session({ isStreaming: true }), t2: session() },
    } as never)
    render(<VoiceBallBusyBridge />)
    emitTo.mockClear()

    useThreads.setState({ currentThreadId: 't2' })

    expect(thinkingCalls()).toEqual([false])
  })

  it('转写中推 thinking=true，定稿交接到回答开始之间不回落到空闲', () => {
    useThreads.setState({ currentThreadId: 't1' })
    render(<VoiceBallBusyBridge />)
    emitTo.mockClear()

    useVoiceInputStore.setState({ phase: 'recognizing' })
    expect(thinkingCalls()).toEqual([true])

    // 定稿：先记交接再落回 idle，这是 VoiceOverlayBridge 的真实顺序。
    useOverlayConversationStore.setState({ handingOff: 1 })
    useVoiceInputStore.setState({ phase: 'idle' })
    expect(thinkingCalls()).toEqual([true])

    // 回答跑完、交接归零，球才回空闲。
    useOverlayConversationStore.setState({ handingOff: 0 })
    expect(thinkingCalls()).toEqual([true, false])
  })

  it('卸载时清掉忙碌态，否则球会一直转', () => {
    useThreads.setState({ currentThreadId: 't1' })
    const view = render(<VoiceBallBusyBridge />)
    useChatSessions.setState({ sessions: { t1: session({ isStreaming: true }) } as never })
    emitTo.mockClear()

    view.unmount()

    expect(thinkingCalls()).toEqual([false])
  })

  it('Runtime Session 没有旧 ChatSession 时仍跟随浮窗忙碌态直到结束', () => {
    useThreads.setState({ currentThreadId: 'runtime-session' })
    render(<VoiceBallBusyBridge />)
    emitTo.mockClear()

    useOverlayConversationStore.setState({ busy: true })
    expect(thinkingCalls()).toEqual([true])
    useOverlayConversationStore.setState({ busy: false })
    expect(thinkingCalls()).toEqual([true, false])
  })

  it('转写已经进入待提交队列时保持思考态', () => {
    render(<VoiceBallBusyBridge />)
    emitTo.mockClear()
    useVoiceInputStore.setState({ pending: [{ id: 'input-1', sessionId: 't1', text: '你好' }] })
    expect(thinkingCalls()).toEqual([true])
  })
})
