import React from 'react'
import { act, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  selectedSessionId: undefined as string | undefined,
  navigate: vi.fn(),
  sessionEvents: undefined as boolean | undefined,
  currentThreadId: undefined as string | undefined,
  surface: 'status-popup',
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/status-popup' }),
  useNavigate: () => h.navigate,
}))

vi.mock('@/stores/conversation-sync-store', () => ({
  useConversationSyncStore: (selector: any) =>
    selector({ selectedSessionId: h.selectedSessionId }),
}))

vi.mock('@/stores/runtime-store', () => ({
  useRuntimeStore: (selector: any) =>
    selector({ capabilities: { sessionEvents: h.sessionEvents } }),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: any) => selector({ currentThreadId: h.currentThreadId }),
}))

vi.mock('@/lib/window-surface', () => ({
  currentWindowSurface: () => h.surface,
}))

vi.mock('@/components/RuntimeControls', () => ({
  RuntimeControls: () => <div data-testid="runtime-controls" />,
}))

vi.mock('@/containers/ChatInput', () => ({
  default: ({ initialMessage }: any) => (
    <div data-testid="chat-input" data-initial={String(initialMessage)} />
  ),
}))

import { Route } from '@/routes/status-popup'

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

describe('status popup route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.selectedSessionId = undefined
    h.sessionEvents = undefined
    h.currentThreadId = undefined
    h.surface = 'status-popup'
  })

  it('shows a compact new-conversation empty state', () => {
    renderComponent()
    expect(screen.getByText('Start a new conversation')).toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'data-initial',
      'true'
    )
  })

  it('初始化 Runtime 并在能力加载后保持原浮窗空状态', () => {
    const { rerender } = renderComponent()
    expect(screen.getByTestId('runtime-controls')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-controls')).not.toBeVisible()

    h.sessionEvents = true
    const Component = Route.component as React.ComponentType
    rerender(<Component />)
    expect(screen.getByTestId('runtime-controls')).not.toBeVisible()
    expect(screen.getByTestId('chat-input')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Start a new conversation' })).toBeVisible()
  })

  it('navigates to the shared Runtime session without mounting empty-state controls', () => {
    h.sessionEvents = true
    h.currentThreadId = 'runtime-session-1'
    renderComponent()
    expect(h.navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'runtime-session-1' },
      replace: true,
    })
    expect(screen.queryByTestId('runtime-controls')).not.toBeInTheDocument()
  })

  it('opens the same selected conversation inside the voice overlay', () => {
    h.surface = 'voice-overlay'
    h.currentThreadId = 'voice-session'
    h.selectedSessionId = 'other-main-session'
    renderComponent()
    expect(screen.queryByTestId('runtime-controls')).not.toBeInTheDocument()
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument()
    expect(h.navigate).toHaveBeenCalledWith({ to: '/threads/$threadId', params: { threadId: 'voice-session' }, replace: true })
  })

  it('navigates to the coordinated selected session', () => {
    h.selectedSessionId = 'thread-1'
    act(() => renderComponent())
    expect(screen.queryByTestId('runtime-controls')).not.toBeInTheDocument()
    expect(h.navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'thread-1' },
      replace: true,
    })
  })
})
