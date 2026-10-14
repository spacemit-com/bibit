import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ listeners: new Map<string, (event: { payload: unknown }) => void>(), navigate: vi.fn(), invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => h.invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, callback) => { h.listeners.set(name, callback); return () => h.listeners.delete(name) }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }))
import { OverlayConversationLifecycle } from '../OverlayConversationLifecycle'
import { useThreads } from '@/hooks/useThreads'
import { usePrompt } from '@/hooks/usePrompt'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useChatSessions } from '@/stores/chat-session-store'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useOverlayConversationStore } from '@/stores/overlay-conversation-store'
import { useVoiceInputStore } from '@/stores/voice-input-store'

const event = (name: string, payload: unknown = {}) => act(() => h.listeners.get(name)?.({ payload }))
beforeEach(() => {
  h.listeners.clear()
  h.navigate.mockReset()
  h.invoke.mockClear()
  useThreads.setState({ currentThreadId: 'conversation', currentThreadTargetId: 'target-a' })
  usePrompt.setState({ prompt: '' })
  useRuntimeStore.setState({ enabled: true })
  useChatSessions.setState({ sessions: {} })
  useMessageQueue.setState({ queues: {} })
  useChatAttachments.setState({ attachmentsByThread: {} })
  useOverlayConversationStore.setState({ generation: 0, busy: false, handingOff: 0, previousSessionId: undefined })
  useVoiceInputStore.setState({ mode: 'voice', phase: 'idle', pending: [], error: '' })
})

describe('浮窗原生事件与真实会话状态集成', () => {
  it('完成交流收起后为空白，重新打开不创建会话并保留继续上次入口', async () => {
    const create = vi.spyOn(useThreads.getState(), 'createThread')
    render(<OverlayConversationLifecycle />)
    await waitFor(() => expect(h.listeners.has('voice-overlay-opened')).toBe(true))
    event('voice-overlay-dismissed')
    expect(useThreads.getState().currentThreadId).toBeUndefined()
    expect(useOverlayConversationStore.getState().previousSessionId).toBe('conversation')
    event('voice-overlay-opened', { mode: 'keyboard' })
    expect(useVoiceInputStore.getState().mode).toBe('keyboard')
    expect(useThreads.getState().currentThreadId).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    create.mockRestore()
  })

  it('托盘切键盘时取消当前录音，普通聚焦不启动麦克风', async () => {
    render(<OverlayConversationLifecycle />)
    await waitFor(() => expect(h.listeners.has('voice-overlay-opened')).toBe(true))
    event('voice-overlay-opened', { mode: 'keyboard' })
    expect(h.invoke).not.toHaveBeenCalled()
    useVoiceInputStore.setState({ phase: 'listening', mode: 'voice' })
    event('voice-overlay-opened', { mode: 'keyboard' })
    expect(h.invoke).toHaveBeenCalledWith('voice_tool_cancel_current')
    expect(useVoiceInputStore.getState().phase).toBe('idle')
  })

  it.each(['任务', '文字', '附件', '排队', '创建中', '识别失败'])('收起时存在%s则保留当前交流', async kind => {
    if (kind === '任务') useOverlayConversationStore.setState({ busy: true })
    if (kind === '文字') usePrompt.setState({ prompt: '尚未发送' })
    if (kind === '附件') useChatAttachments.getState().setAttachments(JSON.stringify(['target-a', 'conversation']), [{ id: 'attachment' } as any])
    if (kind === '排队') useMessageQueue.getState().enqueue('conversation', { id: 'q', text: '排队输入', createdAt: 1 })
    if (kind === '创建中') useOverlayConversationStore.setState({ handingOff: 1 })
    if (kind === '识别失败') useVoiceInputStore.setState({ error: '保留转写原文' })
    render(<OverlayConversationLifecycle />)
    await waitFor(() => expect(h.listeners.has('voice-overlay-opened')).toBe(true))
    event('voice-overlay-dismissed')
    event('voice-overlay-opened', { mode: 'keyboard' })
    expect(useThreads.getState().currentThreadId).toBe('conversation')
    expect(h.navigate).not.toHaveBeenCalled()
  })
})
