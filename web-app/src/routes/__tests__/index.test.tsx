/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

const h = vi.hoisted(() => ({
  sessionEvents: false,
  providers: [] as any[],
  search: { threadModel: undefined as any },
  setCurrentThreadId: vi.fn(),
  useTools: vi.fn(),
  providerHasRemoteApiKeys: vi.fn(() => false),
  runtimeTransportCreated: vi.fn(),
  demoTransportCreated: vi.fn(),
  customTransportCreated: vi.fn(),
  ensureSession: vi.fn(),
  setSessionTitle: vi.fn(),
  updateStatus: vi.fn(),
  chatSessions: {} as Record<string, any>,
  useChatSDK: vi.fn(() => ({ status: 'ready' })),
  predefinedProviders: [
    { provider: 'openai' },
    { provider: 'llamacpp' },
    { provider: 'jan' },
  ],
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/' }),
  useSearch: () => h.search,
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({ providers: h.providers }),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: () => ({ setCurrentThreadId: h.setCurrentThreadId }),
}))

vi.mock('@/hooks/useTools', () => ({
  useTools: h.useTools,
}))

vi.mock('@/containers/ChatInput', () => ({
  default: ({ model, initialMessage }: any) => (
    <div data-testid="chat-input" data-initial={String(initialMessage)}>
      {model ? model.id : 'no-model'}
    </div>
  ),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: any) => <div data-testid="header-page">{children}</div>,
}))

vi.mock('@/components/RuntimeControls', () => ({
  RuntimeControls: () => (
    <div data-testid="runtime-controls">Hermes Runtime</div>
  ),
}))

vi.mock('@/stores/runtime-store', () => ({
  useRuntimeStore: (selector: any) => selector({ enabled: true, capabilities: { sessionEvents: h.sessionEvents } }),
}))

vi.mock('@/lib/runtime-chat-transport', () => ({
  RuntimeChatTransport: class {
    constructor() {
      h.runtimeTransportCreated()
    }
    updateSystemMessage() {}
    setOnTokenUsage() {}
    refreshTools() {}
    setContinueFromContent() {}
    async updateRagToolsAvailability() {}
  },
}))

vi.mock('@/lib/demo-chat-transport', () => ({
  DemoChatTransport: class {
    constructor() {
      h.demoTransportCreated()
    }
    updateSystemMessage() {}
    setOnTokenUsage() {}
    refreshTools() {}
    setContinueFromContent() {}
    async updateRagToolsAvailability() {}
  },
}))

vi.mock('@/lib/custom-chat-transport', () => ({
  CustomChatTransport: class {
    constructor() {
      h.customTransportCreated()
    }
    updateSystemMessage() {}
    setOnTokenUsage() {}
    refreshTools() {}
    setContinueFromContent() {}
    async updateRagToolsAvailability() {}
  },
}))

vi.mock('@/stores/chat-session-store', () => {
  const useChatSessions: any = (selector: any) =>
    selector({
      ensureSession: h.ensureSession,
      setSessionTitle: h.setSessionTitle,
      updateStatus: h.updateStatus,
    })
  useChatSessions.getState = () => ({ sessions: h.chatSessions })
  return { useChatSessions }
})

vi.mock('@/hooks/useAppState', () => ({
  useAppState: (selector: any) =>
    selector({ mcpToolNames: new Set(), ragToolNames: new Set() }),
}))

vi.mock('@ai-sdk/react', () => ({
  Chat: class {
    status = 'ready'
    messages = []
  },
  useChat: (...args: unknown[]) => h.useChatSDK(...args),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...c: any[]) => c.filter(Boolean).join(' '),
}))

vi.mock('@/lib/provider-api-keys', () => ({
  providerHasRemoteApiKeys: (p: any) => h.providerHasRemoteApiKeys(p),
}))

vi.mock('@/constants/providers', () => ({
  predefinedProviders: h.predefinedProviders,
}))

vi.mock('@/constants/routes', () => ({
  route: { home: '/' },
}))

import { Route } from '../index'
import { useChat } from '@/hooks/use-chat'

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

const RuntimeChatHarness = ({ sessionId = 'new-thread' }: { sessionId?: string }) => {
  useChat({ sessionId })
  return null
}

describe('Index route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.sessionEvents = false
    h.providers = []
    h.search = { threadModel: undefined }
    h.providerHasRemoteApiKeys.mockReturnValue(false)
    h.chatSessions = {}
    h.ensureSession.mockImplementation(
      (_sessionId: string, _transport: unknown, createChat: () => unknown) =>
        createChat()
    )
  })

  it('Session 能力变化时保持原首页、标题、输入框和 Header', () => {
    h.sessionEvents = true
    const view = renderComponent()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'How can I help you today?' })).toBeInTheDocument()
    h.sessionEvents = false
    const Component = Route.component as React.ComponentType
    view.rerender(<Component />)
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
  })

  it('validateSearch returns threadModel from search params', () => {
    const tm = { id: 'm1', provider: 'p1' }
    const result = (Route as any).validateSearch({ threadModel: tm })
    expect(result.threadModel).toEqual(tm)
  })

  it('validateSearch handles missing threadModel', () => {
    const result = (Route as any).validateSearch({})
    expect(result.threadModel).toBeUndefined()
  })

  it('renders the Hermes chat when no providers exist', () => {
    h.providers = []
    renderComponent()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-controls')).toHaveTextContent(
      'Hermes Runtime'
    )
  })

  it('does not require an API key or model for the Hermes chat', () => {
    h.providers = [{ provider: 'openai', models: [] }]
    h.providerHasRemoteApiKeys.mockReturnValue(false)
    renderComponent()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
  })

  it('renders chat UI when predefined provider has api key', () => {
    h.providers = [{ provider: 'openai', models: [] }]
    h.providerHasRemoteApiKeys.mockReturnValue(true)
    renderComponent()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.queryByTestId('dropdown')).not.toBeInTheDocument()
    expect(screen.getByText('How can I help you today?')).toBeInTheDocument()
  })

  it('renders chat UI when llamacpp provider has models', () => {
    h.providers = [{ provider: 'llamacpp', models: [{ id: 'x' }] }]
    h.providerHasRemoteApiKeys.mockReturnValue(false)
    renderComponent()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
  })

  it('renders chat UI when jan provider has models', () => {
    h.providers = [{ provider: 'jan', models: [{ id: 'j' }] }]
    renderComponent()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
  })

  it('renders chat UI for custom provider with models, no api key required', () => {
    h.providers = [{ provider: 'custom-xyz', models: [{ id: 'c' }] }]
    renderComponent()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
  })

  it('renders Hermes chat for a custom provider with no models', () => {
    h.providers = [{ provider: 'custom-xyz', models: [] }]
    renderComponent()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
  })

  it('passes threadModel from search into ChatInput without rendering model selection', () => {
    h.providers = [{ provider: 'openai', models: [] }]
    h.providerHasRemoteApiKeys.mockReturnValue(true)
    h.search = { threadModel: { id: 'gpt-x', provider: 'openai' } }
    renderComponent()
    expect(screen.queryByTestId('dropdown')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toHaveTextContent('gpt-x')
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-initial', 'true')
  })

  it('resets the current thread without loading model tools', () => {
    h.providers = [{ provider: 'openai', models: [] }]
    h.providerHasRemoteApiKeys.mockReturnValue(true)
    renderComponent()
    expect(h.setCurrentThreadId).toHaveBeenCalledWith(undefined)
    expect(h.useTools).not.toHaveBeenCalled()
  })

  it('creates RuntimeChatTransport instead of DemoChatTransport for a new session', () => {
    render(<RuntimeChatHarness />)

    expect(h.runtimeTransportCreated).toHaveBeenCalledTimes(1)
    expect(h.demoTransportCreated).not.toHaveBeenCalled()
    expect(h.customTransportCreated).not.toHaveBeenCalled()
  })

  it('does not carry a legacy Demo transport into a later new session', () => {
    const legacyDemoTransport = {
      updateSystemMessage: vi.fn(),
      setOnTokenUsage: vi.fn(),
      refreshTools: vi.fn(),
      setContinueFromContent: vi.fn(),
      updateRagToolsAvailability: vi.fn(),
    }
    h.chatSessions = {
      legacy: { transport: legacyDemoTransport },
    }
    const { rerender } = render(<RuntimeChatHarness sessionId="legacy" />)
    expect(h.runtimeTransportCreated).not.toHaveBeenCalled()

    h.chatSessions = {}
    rerender(<RuntimeChatHarness sessionId="new-thread" />)

    expect(h.runtimeTransportCreated).toHaveBeenCalledTimes(1)
    expect(h.demoTransportCreated).not.toHaveBeenCalled()
  })
})
