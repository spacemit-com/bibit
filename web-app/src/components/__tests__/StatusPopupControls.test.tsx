import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  surface: 'status-popup',
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@/lib/overlay-handoff', () => ({ handoffOverlay: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@/lib/window-surface', () => ({
  currentWindowSurface: () => h.surface,
}))

vi.mock('@/stores/conversation-sync-store', () => ({
  useConversationSyncStore: (selector: any) =>
    selector({
      selectedSessionId: 'thread-1',
      activeRuns: {
        'thread-1': { runId: 'run-1' },
      },
    }),
}))

vi.mock('@/stores/demo-runtime-store', () => ({
  useDemoRuntimeStore: (selector: any) => selector({ mode: 'streaming' }),
}))

import { StatusPopupButton } from '@/components/StatusPopupButton'
import { StatusPopupHeader } from '@/components/StatusPopupHeader'
import { adjustPopupGeometry } from '@/components/WindowResizeGrips'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useVoiceInputStore } from '@/stores/voice-input-store'
import { useOverlayConversationStore } from '@/stores/overlay-conversation-store'
import { handoffOverlay } from '@/lib/overlay-handoff'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useChatSessions } from '@/stores/chat-session-store'

describe('status popup controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.surface = 'status-popup'
    useThreads.setState({
      threads: {},
      currentThreadId: undefined,
      currentThreadTargetId: undefined,
    })
    usePrompt.setState({ prompt: '' })
    useRuntimeStore.setState((state) => ({
      capabilities: { ...state.capabilities, sessionEvents: false },
    }))
  })

  it('shows runtime activity and exposes main-window and hide actions', async () => {
    render(<StatusPopupHeader />)
    expect(screen.getByText('Running')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open main window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide quick chat' }))

    await waitFor(() => {
      expect(h.invoke).toHaveBeenCalledWith('open_main_window')
      expect(h.invoke).toHaveBeenCalledWith('hide_status_popup')
    })
  })

  it('opens the independent quick conversation window', () => {
    render(<StatusPopupButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Open quick chat' }))
    expect(h.invoke).toHaveBeenCalledWith('show_status_popup')
  })

  it('selects a session and flushes its draft before every window action', async () => {
    const user = userEvent.setup()
    useThreads.setState({
      currentThreadId: 'thread-1',
      currentThreadTargetId: 'target-a',
      threads: {
        'thread-1': {
          id: 'thread-1',
          title: '会话一',
          updated: 1,
          metadata: { targetId: 'target-a' },
        },
        'thread-2': {
          id: 'thread-2',
          title: '会话二',
          updated: 2,
          metadata: { targetId: 'target-a' },
        },
        other: {
          id: 'other',
          title: '其他目标',
          updated: 3,
          metadata: { targetId: 'target-b' },
        },
      },
    })
    usePrompt.setState({ prompt: '保留草稿' })
    useRuntimeStore.setState((state) => ({
      capabilities: { ...state.capabilities, sessionEvents: true },
    }))

    render(<StatusPopupHeader />)
    await user.click(screen.getByRole('button', { name: 'Select conversation' }))
    expect(screen.queryByText('其他目标')).not.toBeInTheDocument()
    await user.click(screen.getByText('会话二'))
    await waitFor(() =>
      expect(useThreads.getState().currentThreadId).toBe('thread-2')
    )

    for (const name of [
      'Open main window',
      'Minimize quick chat',
      'Hide quick chat',
    ]) {
      await user.click(screen.getByRole('button', { name }))
    }

    expect(h.invoke.mock.calls).toEqual([
      [
        'conversation_update_draft',
        {
          originWindow: 'status-popup',
          sessionId: 'thread-1',
          draft: '保留草稿',
          expectedTargetId: 'target-a',
        },
      ],
      [
        'conversation_update_draft',
        {
          originWindow: 'status-popup',
          sessionId: 'thread-2',
          draft: '保留草稿',
          expectedTargetId: 'target-a',
        },
      ],
      ['open_main_window'],
      [
        'conversation_update_draft',
        {
          originWindow: 'status-popup',
          sessionId: 'thread-2',
          draft: '保留草稿',
          expectedTargetId: 'target-a',
        },
      ],
      ['minimize_status_popup'],
      [
        'conversation_update_draft',
        {
          originWindow: 'status-popup',
          sessionId: 'thread-2',
          draft: '保留草稿',
          expectedTargetId: 'target-a',
        },
      ],
      ['hide_status_popup'],
    ])
  })

  it('flushes the full-window draft before opening quick conversation', async () => {
    h.surface = 'main'
    useThreads.setState({
      currentThreadId: 'thread-1',
      currentThreadTargetId: 'target-a',
    })
    usePrompt.setState({ prompt: '主窗口草稿' })
    useRuntimeStore.setState((state) => ({
      capabilities: { ...state.capabilities, sessionEvents: true },
    }))

    render(<StatusPopupButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Open quick chat' }))

    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2))
    expect(h.invoke.mock.calls).toEqual([
      [
        'conversation_update_draft',
        {
          originWindow: 'main',
          sessionId: 'thread-1',
          draft: '主窗口草稿',
          expectedTargetId: 'target-a',
        },
      ],
      ['show_status_popup'],
    ])
  })

  it('keeps dragged and resized geometry inside product bounds', () => {
    const geometry = {
      screenIndex: 0,
      width: 500,
      height: 700,
      rightMargin: 120,
      bottomMargin: 60,
    }
    expect(adjustPopupGeometry(geometry, 'NorthWest', 250, 400)).toEqual({
      ...geometry,
      width: 300,
      height: 400,
    })
    expect(adjustPopupGeometry(geometry, 'Move', 200, -40)).toEqual({
      ...geometry,
      rightMargin: 0,
      bottomMargin: 100,
    })
  })
})

it('switching to main folds overlay only after handoff acknowledgement', async () => {
  h.surface = 'voice-overlay'
  h.invoke.mockClear()
  render(<StatusPopupHeader />)
  fireEvent.click(screen.getByRole('button', { name: 'Open main window' }))
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('hide_voice_overlay', { reason: 'handoff' }))
  const calls = h.invoke.mock.calls.map(([name]) => name)
  expect(calls.indexOf('hide_voice_overlay')).toBeGreaterThanOrEqual(0)
  expect(calls.indexOf('hide_voice_overlay')).toBeGreaterThan(calls.indexOf('open_main_window'))
})

it('录音中新对话先取消录音，防止迟到转写进入上次会话', async () => {
  h.surface = 'voice-overlay'
  h.invoke.mockClear()
  useRuntimeStore.setState(state => ({ capabilities: { ...state.capabilities, sessionEvents: true } }))
  useThreads.setState({ currentThreadId: 'thread-1', currentThreadTargetId: 'target-a' })
  useOverlayConversationStore.setState({ handingOff: 0 })
  useVoiceInputStore.setState({ phase: 'listening', pending: [] })
  render(<StatusPopupHeader />)
  fireEvent.click(screen.getByRole('button', { name: 'New Conversation' }))
  await waitFor(() => expect(useThreads.getState().currentThreadId).toBeUndefined())
  expect(h.invoke).toHaveBeenCalledWith('voice_tool_cancel_current')
  expect(useVoiceInputStore.getState().phase).toBe('idle')
})

it.each(['草稿', '附件'])('等待主窗确认时更新%s，不收起尚未交接的新输入', async (kind) => {
  h.surface = 'voice-overlay'
  h.invoke.mockClear()
  useThreads.setState({ currentThreadId: 'thread-1', currentThreadTargetId: 'target-a' })
  usePrompt.setState({ prompt: '最初草稿' })
  useRuntimeStore.setState(state => ({ enabled: true, capabilities: { ...state.capabilities, sessionEvents: true } }))
  useOverlayConversationStore.setState({ handingOff: 0 })
  useChatAttachments.setState({ attachmentsByThread: {} })
  let finish!: () => void
  vi.mocked(handoffOverlay).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<StatusPopupHeader />)
  fireEvent.click(screen.getByRole('button', { name: 'Open main window' }))
  await waitFor(() => expect(finish).toBeDefined())
  expect(useOverlayConversationStore.getState().handingOff).toBe(1)
  act(() => {
    if (kind === '草稿') usePrompt.setState({ prompt: '后来编辑的草稿' })
    else useChatAttachments.getState().setAttachments(JSON.stringify(['target-a', 'thread-1']), [{ id: 'added', type: 'document', name: '新增附件' } as any])
    finish()
  })
  await waitFor(() => expect(useOverlayConversationStore.getState().handingOff).toBe(0))
  expect(h.invoke).not.toHaveBeenCalledWith('hide_voice_overlay', { reason: 'handoff' })
})

it('Runtime 运行中新对话保留任务和草稿，继续上次恢复原输入', async () => {
  h.surface = 'voice-overlay'
  h.invoke.mockClear()
  h.invoke.mockImplementation(async command => command === 'runtime_target_identity' ? { targetId: 'target-a' } : undefined)
  useRuntimeStore.setState(state => ({ enabled: true, capabilities: { ...state.capabilities, sessionEvents: true } }))
  useThreads.setState({ currentThreadId: 'thread-1', currentThreadTargetId: 'target-a' })
  usePrompt.setState({ prompt: '留给上次对话的草稿' })
  useChatAttachments.setState({ attachmentsByThread: {} })
  useVoiceInputStore.setState({ phase: 'idle', pending: [], error: '' })
  useOverlayConversationStore.setState({ busy: true, handingOff: 0 })
  const running = { isStreaming: true, status: 'streaming' } as any
  useChatSessions.setState({ sessions: { 'thread-1': running } })
  render(<StatusPopupHeader />)
  fireEvent.click(screen.getByRole('button', { name: 'New Conversation' }))
  expect(useThreads.getState().currentThreadId).toBeUndefined()
  expect(useChatSessions.getState().sessions['thread-1']).toBe(running)
  expect(useOverlayConversationStore.getState().previousDraft).toBe('留给上次对话的草稿')
  // 线程页卸载会清理当前页 busy 标记，不清除后台任务。
  act(() => useOverlayConversationStore.setState({ busy: false }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue last' }))
  await waitFor(() => expect(useThreads.getState().currentThreadId).toBe('thread-1'))
  expect(usePrompt.getState().prompt).toBe('留给上次对话的草稿')
  expect(useChatSessions.getState().sessions['thread-1']).toBe(running)
  expect(h.invoke.mock.calls.every(([command]) => !String(command).includes('cancel'))).toBe(true)
})
