import { saveSessionKnowledge } from '@/lib/session-knowledge'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'
import type { SessionFeed } from '@/hooks/useSessionFeed'

const sessionView = vi.hoisted(() => ({ status: 'ready', ready: true, halted: false, error: '', waiting: false, messages: [] as any[], pending: [] as any[], send: vi.fn(), stop: vi.fn(), changeHistory: vi.fn(), switchVersion: vi.fn(), feed: undefined as SessionFeed | undefined, loadOlder: vi.fn(), anchored: false, args: [] as unknown[] }))
vi.mock('@/hooks/useSessionConversation', () => ({
  useSessionConversation: (...args: unknown[]) => {
    sessionView.args = args
    return { ...sessionView }
  },
}))

const knowledge = vi.hoisted(() => ({ retrieve: vi.fn() }))
vi.mock('@/lib/knowledge-retrieval', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  retrieveKnowledge: knowledge.retrieve,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() } }))

// -----------------------------------------------------------------------------
// Hoisted shared state + mocks (needed because vi.mock factory runs first)
// -----------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const mockSendMessage = vi.fn()
  const mockRegenerate = vi.fn()
  const mockStop = vi.fn()
  const mockAddToolOutput = vi.fn()
  const mockSetChatMessages = vi.fn()
  const mockUpdateRag = vi.fn()
  const mockSetContinueFromContent = vi.fn()
  const mockInvoke = vi.fn().mockResolvedValue(true)
  const mockCancelCoordinatedSessionRun = vi.fn().mockResolvedValue(true)
  const mockFocusUnlisten = vi.fn()
  let focusHandler:
    | ((event: { payload: boolean }) => void)
    | undefined

  const chatState: { messages: any[]; status: string; error: Error | null } = {
    messages: [],
    status: 'ready',
    error: null,
  }

  const threadsState: any = {
    threads: {
      'thread-1': {
        id: 'thread-1',
        title: 'My Thread',
        metadata: {},
        assistants: [],
        model: { id: 'gpt-x', provider: 'openai' },
      },
    },
    setCurrentThreadId: vi.fn(),
    updateThread: vi.fn(),
  }
  const useThreadsMock: any = (selector?: any) =>
    typeof selector === 'function' ? selector(threadsState) : threadsState
  useThreadsMock.getState = () => threadsState

  const messagesState: any = {
    setMessages: vi.fn(),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    getMessages: vi.fn(() => []),
  }
  const useMessagesMock: any = (selector: any) => selector(messagesState)
  useMessagesMock.getState = () => messagesState

  const appStateState = {
    ragToolNames: new Set<string>(),
    mcpToolNames: new Set<string>(),
    setOomError: vi.fn(),
    setBackendError: vi.fn(),
    busyThreads: {} as Record<string, boolean>,
    embeddingThreads: {} as Record<string, boolean>,
    setThreadBusy: vi.fn(),
    setThreadEmbedding: vi.fn(),
  }
  const useAppStateMock: any = (selector: any) => selector(appStateState)
  useAppStateMock.getState = () => appStateState

  const modelProviderState: any = {
    selectedModel: {
      id: 'gpt-x',
      capabilities: ['tools'],
      settings: {
        ctx_len: { controller_props: { value: 4096, max: 131072 } },
        auto_increase_ctx_len: { controller_props: { value: true } },
      },
    },
    selectedProvider: 'openai',
    getProviderByName: vi.fn((name: string) => ({
      provider: name,
      models: [
        {
          id: 'gpt-x',
          settings: {
            ctx_len: { controller_props: { value: 4096, max: 131072 } },
          },
        },
      ],
    })),
    updateProvider: vi.fn(),
  }
  const useModelProviderMock: any = (selector: any) => selector(modelProviderState)
  useModelProviderMock.getState = () => modelProviderState

  const chatSessionsState: any = {
    sessions: {},
    getSessionData: vi.fn(() => ({ tools: [] })),
  }
  const useChatSessionsMock: any = (selector: any) => selector(chatSessionsState)
  useChatSessionsMock.getState = () => chatSessionsState

  const attachmentsState: any = {
    getAttachments: vi.fn(() => []),
    clearAttachments: vi.fn(),
  }
  const useChatAttachmentsMock: any = (selector: any) => selector(attachmentsState)
  useChatAttachmentsMock.getState = () => attachmentsState

  const useAttachmentsState: any = { enabled: true, parseMode: 'auto' }
  const useAttachmentsMock: any = (selector: any) => selector(useAttachmentsState)
  useAttachmentsMock.getState = () => useAttachmentsState

  const toolAvailableState: any = {
    getDisabledToolsForThread: vi.fn(() => []),
  }
  const useToolAvailableMock: any = (selector: any) => selector(toolAvailableState)
  useToolAvailableMock.getState = () => toolAvailableState

  const toolApprovalState: any = {
    showApprovalModal: vi.fn().mockResolvedValue(true),
    approveToolForThread: vi.fn(),
    clearPendingForThread: vi.fn(),
    requestApproval: vi.fn().mockResolvedValue(true),
  }
  const useToolApprovalMock: any = (selector: any) => selector(toolApprovalState)
  useToolApprovalMock.getState = () => toolApprovalState
  // Transient approval store shares the same backing object so existing
  // toolApprovalState.requestApproval / clearPendingForThread refs keep working.
  const useToolApprovalRequestsMock: any = (selector: any) =>
    selector(toolApprovalState)
  useToolApprovalRequestsMock.getState = () => toolApprovalState

  const agentModeState: any = { agentThreads: {} }
  const useAgentModeMock: any = (selector: any) => selector(agentModeState)
  useAgentModeMock.getState = () => agentModeState

  const messageQueueState: any = {
    dequeue: vi.fn(() => null),
    clearQueue: vi.fn(),
  }
  let activeRuns: Record<string, any> = {}
  let windowSurface: 'main' | 'status-popup' = 'main'
  let runtimeEnabled = true
  let runtimeCapabilities: { durableSessions: boolean; historyOperations?: boolean } | undefined
  const useMessageQueueMock: any = (_selector: any) => undefined
  useMessageQueueMock.getState = () => messageQueueState

  return {
    mockSendMessage,
    mockRegenerate,
    mockStop,
    mockAddToolOutput,
    mockSetChatMessages,
    mockUpdateRag,
    mockSetContinueFromContent,
    mockInvoke,
    mockCancelCoordinatedSessionRun,
    mockFocusUnlisten,
    get focusHandler() {
      return focusHandler
    },
    set focusHandler(value: ((event: { payload: boolean }) => void) | undefined) {
      focusHandler = value
    },
    chatState,
    threadsState,
    useThreadsMock,
    messagesState,
    useMessagesMock,
    appStateState,
    useAppStateMock,
    modelProviderState,
    useModelProviderMock,
    chatSessionsState,
    useChatSessionsMock,
    attachmentsState,
    useChatAttachmentsMock,
    useAttachmentsState,
    useAttachmentsMock,
    toolAvailableState,
    useToolAvailableMock,
    toolApprovalState,
    useToolApprovalMock,
    useToolApprovalRequestsMock,
    agentModeState,
    useAgentModeMock,
    messageQueueState,
    useMessageQueueMock,
    get activeRuns() {
      return activeRuns
    },
    set activeRuns(value: Record<string, any>) {
      activeRuns = value
    },
    get windowSurface() {
      return windowSurface
    },
    set windowSurface(value: 'main' | 'status-popup') {
      windowSurface = value
    },
    get runtimeEnabled() {
      return runtimeEnabled
    },
    set runtimeEnabled(value: boolean) {
      runtimeEnabled = value
    },
    get runtimeCapabilities() {
      return runtimeCapabilities
    },
    set runtimeCapabilities(value: { durableSessions: boolean } | undefined) {
      runtimeCapabilities = value
    },
    // 搜索结果跳转：`seq` 由 URL 决定，导航断言用同一个 spy。
    searchParams: { threadModel: undefined } as { threadModel: unknown; seq?: number },
    mockNavigate: vi.fn(),
  }
})

// -----------------------------------------------------------------------------
// Module mocks
// -----------------------------------------------------------------------------

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/threads/$threadId' }),
  useNavigate: () => h.mockNavigate,
  useParams: () => ({ threadId: 'thread-1' }),
  useSearch: () => h.searchParams,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
      h.focusHandler = handler
      return h.mockFocusUnlisten
    },
  }),
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
  useRuntimeStore: (selector: any) =>
    selector({
      enabled: h.runtimeEnabled,
      capabilities: { sessionEvents: false, ...h.runtimeCapabilities },
    }),
}))

vi.mock('@/lib/coordinated-stop', () => ({
  cancelCoordinatedSessionRun: (...args: unknown[]) =>
    h.mockCancelCoordinatedSessionRun(...args),
}))

vi.mock('@/containers/ChatInput', () => ({
  default: ({ onSubmit, onStop, chatStatus }: any) => (
    <div data-testid="chat-input">
      <span data-testid="chat-status">{chatStatus}</span>
      <button
        data-testid="chat-send"
        onClick={() => onSubmit('hello world', undefined)}
      >
        send
      </button>
      <button
        data-testid="chat-send-kb"
        onClick={() => onSubmit('怎么装驱动', undefined, undefined, true)}
      >
        send with knowledge
      </button>
      <button data-testid="chat-stop" onClick={() => onStop()}>
        stop
      </button>
    </div>
  ),
}))

vi.mock('@/containers/MessageItem', () => ({
  MessageItem: ({
    message,
    onRegenerate,
    onContinue,
    onEdit,
    onDelete,
    versionInfo,
    onSwitchVersion,
  }: any) => (
    <div data-testid={`message-${message.id}`} data-role={message.role} data-content={message.parts?.find((part: any) => part.type === 'text')?.text}>
      <span>{message.id}</span>
      {versionInfo && (
        <span data-testid={`version-${message.id}`}>
          {versionInfo.index}/{versionInfo.count}
        </span>
      )}
      <button
        data-testid={`prev-${message.id}`}
        onClick={() => onSwitchVersion?.(message.id, -1)}
      >
        prev
      </button>
      {onContinue && <button data-testid={`continue-${message.id}`} onClick={() => onContinue(message.id)}>continue</button>}
      {onRegenerate && (
      <button
        data-testid={`regen-${message.id}`}
        onClick={() => onRegenerate(message.id)}
      >
        regen
      </button>
      )}
      {onEdit && (
      <button
        data-testid={`edit-${message.id}`}
        onClick={() => onEdit(message.id, 'edited text')}
      >
        edit
      </button>
      )}
      {onDelete && (
      <button
        data-testid={`del-${message.id}`}
        onClick={() => onDelete(message.id)}
      >
        del
      </button>
      )}
    </div>
  ),
}))

vi.mock('@/components/ai-elements/conversation', () => ({
  Conversation: ({ children }: any) => <div>{children}</div>,
  ConversationContent: ({ children }: any) => <div>{children}</div>,
  ConversationScrollButton: () => <div data-testid="scroll-btn" />,
}))

vi.mock('@/components/ai-elements/shimmer', () => ({
  Shimmer: ({ children }: any) => <div data-testid="shimmer">{children}</div>,
}))

vi.mock('@/components/PromptProgress', () => ({
  PromptProgress: () => <div data-testid="prompt-progress" />,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
}))

vi.mock('@tabler/icons-react', () => ({
  IconAlertCircle: () => <span />,
  IconRefresh: () => <span />,
  IconLoader2: () => <span />,
}))

vi.mock('@/lib/utils', () => ({
  cn: (...classes: any[]) => classes.filter(Boolean).join(' '),
}))

vi.mock('@/lib/instructionTemplate', () => ({
  renderInstructions: (i: string) => `rendered:${i}`,
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      get: () => ({
        listAttachments: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}))

vi.mock('@/lib/messages', () => ({
  convertThreadMessagesToUIMessages: (msgs: any[]) =>
    msgs.map((m) => ({
      id: m.id,
      role: m.role,
      parts: [{ type: 'text', text: m.content?.[0]?.text?.value ?? '' }],
    })),
  extractContentPartsFromUIMessage: (msg: any) =>
    msg.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => ({ type: 'text', text: { value: p.text, annotations: [] } })),
  extractRuntimeTurnV2FromUIMessage: (msg: any) =>
    msg.metadata?.runtime
      ? {
          schemaVersion: 2,
          runtimeId: msg.metadata.runtime,
          items: msg.parts
            .filter((p: any) => p.type === 'text')
            .map((p: any) => ({ kind: 'answer', lane: 'answer', markdown: p.text })),
        }
      : undefined,
  uiMessageHasMeaningfulContent: (msg: any) =>
    !!msg?.parts?.some((p: any) => p.type === 'text' && p.text?.trim()),
  threadMessageIsEmpty: () => false,
}))

vi.mock('@/lib/completion', () => ({
  newUserThreadContent: (threadId: string, text: string, _a: any, id: string) => ({
    id,
    thread_id: threadId,
    role: 'user',
    content: [{ type: 'text', text: { value: text, annotations: [] } }],
    metadata: {},
  }),
}))

vi.mock('@/lib/attachmentProcessing', () => ({
  processAttachmentsForSend: vi
    .fn()
    .mockResolvedValue({ processedAttachments: [], hasEmbeddedDocuments: false }),
}))

vi.mock('@/lib/thread-title-summarizer', () => ({
  generateThreadTitle: vi.fn().mockResolvedValue('Short title'),
}))

vi.mock('@/types/attachment', () => ({
  createImageAttachment: (x: any) => ({ type: 'image', ...x }),
}))

vi.mock('ai', () => ({
  generateId: () => 'gen-id',
  lastAssistantMessageIsCompleteWithToolCalls: () => false,
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: any) => fn,
}))

vi.mock('@/hooks/use-chat', () => ({
  useChat: (_args: any) => {
    ;(h as any).capturedOnFinish = _args?.onFinish
    ;(h as any).capturedOnToolCall = _args?.onToolCall
    ;(h as any).capturedUseChatArgs = _args
    return {
      messages: h.chatState.messages,
      status: h.chatState.status,
      error: h.chatState.error,
      sendMessage: h.mockSendMessage,
      regenerate: h.mockRegenerate,
      setMessages: h.mockSetChatMessages,
      stop: h.mockStop,
      addToolOutput: h.mockAddToolOutput,
      updateRagToolsAvailability: h.mockUpdateRag,
      setContinueFromContent: h.mockSetContinueFromContent,
    }
  },
}))

vi.mock('@/hooks/useThreads', () => ({ useThreads: h.useThreadsMock }))
vi.mock('@/hooks/useMessages', () => ({ useMessages: h.useMessagesMock }))
vi.mock('@/hooks/useTools', () => ({ useTools: vi.fn() }))
vi.mock('@/hooks/useAppState', () => ({ useAppState: h.useAppStateMock }))
vi.mock('@/hooks/useModelProvider', () => ({ useModelProvider: h.useModelProviderMock }))
vi.mock('@/stores/chat-session-store', () => ({ useChatSessions: h.useChatSessionsMock }))
vi.mock('@/stores/conversation-sync-store', () => ({
  useConversationSyncStore: (selector: any) =>
    selector({ activeRuns: h.activeRuns }),
}))
vi.mock('@/lib/window-surface', () => ({
  currentWindowSurface: () => h.windowSurface,
}))
vi.mock('@/hooks/useChatAttachments', () => ({
  useChatAttachments: h.useChatAttachmentsMock,
  NEW_THREAD_ATTACHMENT_KEY: '__new-thread__',
}))
vi.mock('@/hooks/useAttachments', () => ({ useAttachments: h.useAttachmentsMock }))
vi.mock('@/hooks/useToolAvailable', () => ({ useToolAvailable: h.useToolAvailableMock }))
vi.mock('@/hooks/useToolApproval', () => ({ useToolApproval: h.useToolApprovalMock }))
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: h.useToolApprovalRequestsMock,
}))
vi.mock('@/hooks/useAgentMode', () => ({ useAgentMode: h.useAgentModeMock }))
vi.mock('@/stores/message-queue-store', () => ({ useMessageQueue: h.useMessageQueueMock }))

vi.mock('@/hooks/useAutoScroll', () => ({
  useAutoScroll: () => ({
    containerRef: { current: null },
    isAtBottom: true,
    handleScroll: vi.fn(),
    scrollToBottom: vi.fn(),
    forceScrollToBottom: vi.fn(),
    reset: vi.fn(),
  }),
}))

vi.mock('@janhq/core', () => ({
  MessageStatus: { Ready: 'ready' },
  ChatCompletionRole: { Assistant: 'assistant', User: 'user' },
  ContentType: { Text: 'text' },
  ExtensionTypeEnum: { VectorDB: 'vectorDB' },
  VectorDBExtension: class {},
}))

vi.mock('@/constants/chat', () => ({
  SESSION_STORAGE_PREFIX: { INITIAL_MESSAGE: 'initial-message-' },
}))

vi.mock('@/utils/error', () => ({
  OUT_OF_CONTEXT_SIZE: 'OUT_OF_CONTEXT_SIZE',
  isContextOverflowMessage: () => false,
  parseContextOverflow: () => null,
}))

// -----------------------------------------------------------------------------
// Import component AFTER mocks
// -----------------------------------------------------------------------------
import { Route } from '../$threadId'
import { useVoiceInputStore } from '@/stores/voice-input-store'
import { useMessageErrors } from '@/stores/message-errors'
import {
  observeRuntimePermission,
  resetRuntimePermissionControllerForTests,
} from '@/features/conversation/runtimePermissionController'

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

describe('ThreadDetail route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useVoiceInputStore.setState({ pending: [], readyId: undefined, mode: 'voice', phase: 'idle', error: '' })
    h.mockInvoke.mockReset().mockImplementation((command: string) => {
      if (command === 'runtime_messages_list') return Promise.resolve([])
      return Promise.resolve(true)
    })
    h.chatState.messages = []
    sessionView.messages = []
    sessionView.status = 'ready'
    sessionView.ready = true
    sessionView.halted = false
    sessionView.error = ''
    sessionView.waiting = false
    sessionView.pending = []
    sessionView.feed = undefined
    sessionView.anchored = false
    sessionView.args = []
    sessionView.loadOlder.mockReset().mockResolvedValue(false)
    sessionView.send.mockResolvedValue(undefined)
    sessionView.changeHistory.mockResolvedValue(undefined)
    sessionView.switchVersion.mockResolvedValue(undefined)
    h.chatState.status = 'ready'
    h.chatState.error = null
    h.threadsState.threads['thread-1'] = {
      id: 'thread-1',
      title: 'My Thread',
      metadata: {},
      assistants: [],
      model: { id: 'gpt-x', provider: 'openai' },
    }
    h.threadsState.setCurrentThreadId = vi.fn()
    h.threadsState.updateThread = vi.fn()
    h.messagesState.getMessages = vi.fn(() => [
      {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
      },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: { value: 'hello', annotations: [] } }],
      },
    ])
    h.messagesState.addMessage = vi.fn()
    h.messagesState.updateMessage = vi.fn()
    h.messagesState.deleteMessage = vi.fn()
    h.messagesState.setMessages = vi.fn()
    h.chatSessionsState.getSessionData = vi.fn(() => ({ tools: [] }))
    h.chatSessionsState.sessions = {}
    h.focusHandler = undefined
    h.messageQueueState.dequeue = vi.fn(() => null)
    h.messageQueueState.clearQueue = vi.fn()
    h.agentModeState.agentThreads = {}
    h.activeRuns = {}
    h.windowSurface = 'main'
    h.runtimeEnabled = true
    h.runtimeCapabilities = undefined
    h.searchParams = { threadModel: undefined }
    h.mockNavigate = vi.fn()
    h.modelProviderState.selectedProvider = 'openai'
    h.appStateState.oomError = undefined
    h.appStateState.ragToolNames = new Set<string>()
    h.appStateState.mcpToolNames = new Set<string>()
    h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
    useMessageErrors.getState().clearAll()
    resetRuntimePermissionControllerForTests()
    sessionStorage.clear()
  })

  it('validateSearch returns threadModel from search params', () => {
    const searchModel = { id: 'm1', provider: 'p1' }
    const result = (Route as any).validateSearch({ threadModel: searchModel })
    expect(result.threadModel).toEqual(searchModel)
  })

  it('validateSearch handles missing threadModel', () => {
    const result = (Route as any).validateSearch({})
    expect(result.threadModel).toBeUndefined()
  })

  it('validateSearch 只接受合法的消息游标', () => {
    expect((Route as any).validateSearch({ seq: 42 }).seq).toBe(42)
    expect((Route as any).validateSearch({ seq: '42' }).seq).toBe(42)
    expect((Route as any).validateSearch({ seq: -1 }).seq).toBeUndefined()
    expect((Route as any).validateSearch({ seq: 'x' }).seq).toBeUndefined()
    expect((Route as any).validateSearch({}).seq).toBeUndefined()
  })

  it('带消息游标进入时把锚点交给会话读取，并给出回到最新的出口', () => {
    h.runtimeCapabilities = { sessionEvents: true }
    h.searchParams = { threadModel: undefined, seq: 42 }
    sessionView.anchored = true
    sessionView.feed = {
      targetId: 'bianbu',
      runtimeEpoch: '1',
      sessionId: 'thread-1',
      events: [],
      hiddenRunIds: [],
      baseSeq: 40,
      lastSeq: 42,
      hasMore: true,
      connectionStatus: 'connected',
    }

    renderComponent()

    expect(sessionView.args[2]).toBe(42)
    expect(screen.getByText('Showing the message you searched for')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to latest' }))
    expect(h.mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: 'thread-1' }, search: { threadModel: undefined } })
    )
  })

  it.each([false, true])('Session 能力为 %s 时保留原对话界面', (sessionEvents) => {
    h.runtimeCapabilities = { sessionEvents }
    renderComponent()
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.queryByTestId('model-dropdown')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-controls')).toHaveTextContent(
      'Hermes Runtime'
    )
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.getByTestId('chat-status')).toHaveTextContent('ready')
  })

  it('hides the full page header inside the status popup surface', () => {
    h.windowSurface = 'status-popup'
    renderComponent()
    expect(screen.queryByTestId('header-page')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
  })

  it('读取仍在进行时显示加载态', () => {
    h.runtimeCapabilities = { sessionEvents: true }
    sessionView.ready = false
    renderComponent()
    expect(screen.getByText('Reading session…')).toBeInTheDocument()
  })

  it('读取停止后不再显示加载态，改为明确的停止提示', () => {
    h.runtimeCapabilities = { sessionEvents: true }
    sessionView.ready = false
    sessionView.halted = true
    sessionView.error = '初始化事件缓冲已满，读取已暂停；请重试读取权威会话窗口'
    renderComponent()
    expect(screen.queryByText('Reading session…')).not.toBeInTheDocument()
    expect(screen.getByText('Session reading stopped, input is disabled; retry reading the session.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry reading the session' })).toBeInTheDocument()
  })

  it.each([
    ['main', true, true],
    ['status-popup', true, false],
    ['main', false, false],
  ] as const)('待审批入口在 %s、sessionEvents=%s 时遵守页面边界', async (surface, sessionEvents, visible) => {
    h.windowSurface = surface
    h.runtimeCapabilities = { sessionEvents }
    sessionView.feed = {
      targetId: 'target-1', runtimeEpoch: 'epoch-1', sessionId: 'thread-1',
      events: [], hiddenRunIds: [], baseSeq: 20, lastSeq: 30,
      hasMore: true, connectionStatus: 'connected',
    }
    observeRuntimePermission({
      targetId: 'target-1', runtimeId: 'bianbu', runtimeEpoch: 'epoch-1',
      sessionId: 'thread-1', runId: 'run-1', requestId: 'request-1',
      toolCallId: 'tool-1', createdAt: '2026-09-08T00:00:00Z',
      title: '允许读取文件', description: '', toolName: 'read_file',
      canAllowOnce: true, canDeny: true, status: 'pending',
    })
    renderComponent()
    const navigation = screen.queryByRole('button', { name: '1 pending approval(s) · Locate' })
    if (!visible) {
      expect(navigation).not.toBeInTheDocument()
      expect(sessionView.loadOlder).not.toHaveBeenCalled()
      return
    }
    expect(navigation).toBeInTheDocument()
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    fireEvent.click(navigation!)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    expect(sessionView.loadOlder).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Load older records' }))
    await waitFor(() => expect(sessionView.loadOlder).toHaveBeenCalledTimes(1))
  })

  it('sets current thread id on mount and resets on unmount', () => {
    const { unmount } = renderComponent()
    expect(h.threadsState.setCurrentThreadId).toHaveBeenCalledWith('thread-1')
    unmount()
    expect(h.threadsState.setCurrentThreadId).toHaveBeenLastCalledWith(undefined)
  })

  it('clears this thread pending tool approvals on unmount', () => {
    const { unmount } = renderComponent()
    unmount()
    expect(h.toolApprovalState.clearPendingForThread).toHaveBeenCalledWith('thread-1')
  })

  it('renders messages passed through useChat', () => {
    h.chatState.messages = [
      { id: 'm-a', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm-b', role: 'assistant', parts: [{ type: 'text', text: 'yo' }] },
    ]
    renderComponent()
    expect(screen.getByTestId('message-m-a')).toBeInTheDocument()
    expect(screen.getByTestId('message-m-b')).toBeInTheDocument()
  })

  it('renders a real Runtime permission tracked only by the controller', () => {
    observeRuntimePermission({
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-1',
      sessionId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-08-21T00:00:00.000Z',
      expiresAt: '2026-08-21T00:01:00.000Z',
      requestId: 'permission-1',
      toolCallId: 'tool-1',
      title: '允许执行命令',
      description: 'Hermes 请求执行命令',
      toolName: 'terminal',
      canAllowOnce: true,
      canDeny: true,
      status: 'pending',
    })

    renderComponent()

    expect(screen.getByTestId('runtime-permission')).toBeInTheDocument()
    expect(screen.getByText('允许执行命令')).toBeInTheDocument()
  })

  it(
    'mounts a session without taking workbench control',
    async () => {
      h.runtimeCapabilities = { durableSessions: true }
      h.mockInvoke.mockImplementation((command: string) => {
        if (command === 'runtime_messages_list') return Promise.resolve([])
        return Promise.resolve(true)
      })

      observeRuntimePermission({
        runtimeId: 'bianbu',
        runtimeEpoch: 'epoch-1',
        sessionId: 'thread-1',
        runId: 'run-1',
        createdAt: '2026-08-21T00:00:00.000Z',
        expiresAt: '2026-08-21T00:01:00.000Z',
        requestId: 'permission-1',
        toolCallId: 'tool-1',
        title: '允许执行命令',
        description: 'Bianbu 请求执行命令',
        toolName: 'terminal',
        canAllowOnce: true,
        canDeny: true,
        status: 'pending',
      })

      renderComponent()

      await waitFor(() => {
        expect(screen.getByTestId('chat-input')).toBeInTheDocument()
        expect(screen.getByTestId('runtime-permission')).toBeInTheDocument()
      })
      // 挂载会话是读准备：不得为此申请工作台控制权。
      expect(
        h.mockInvoke.mock.calls.filter(
          ([command]) => command === 'runtime_controller_acquire'
        )
      ).toHaveLength(0)
    }
  )

  it(
    'detaches on unfocus without touching workbench control',
    async () => {
      h.runtimeCapabilities = { durableSessions: true }
      const detach = vi.fn()
      h.chatSessionsState.sessions['thread-1'] = {
        transport: { detach },
        chat: { status: 'ready', messages: [] },
        isStreaming: false,
      }

      renderComponent()
      await waitFor(() => expect(h.focusHandler).toBeDefined())
      await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument())

      act(() => h.focusHandler?.({ payload: false }))

      await waitFor(() => {
        expect(detach).toHaveBeenCalledOnce()
        expect(h.mockInvoke).toHaveBeenCalledWith('runtime_session_detach', {
          sessionId: 'thread-1',
        })
        expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument()
      })
      expect(h.mockInvoke).not.toHaveBeenCalledWith('runtime_controller_release')

      act(() => h.focusHandler?.({ payload: true }))
      await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument())
      expect(
        h.mockInvoke.mock.calls.filter(
          ([command]) => command === 'runtime_controller_acquire'
        )
      ).toHaveLength(0)
    }
  )

  it(
    'retries mounting the session without leaving the thread',
    async () => {
      h.runtimeCapabilities = { durableSessions: true }
      let mountAttempts = 0
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      h.mockInvoke.mockImplementation((command: string) => {
        if (command === 'runtime_messages_list') return Promise.resolve([])
        if (command === 'runtime_start' && mountAttempts++ === 0) {
          return Promise.reject({
            code: 'runtime_error',
            message: 'runtime unavailable',
            recoverable: true,
          })
        }
        return Promise.resolve(true)
      })

      renderComponent()

      expect(
        await screen.findByText(/Could not connect to the workbench/)
      ).toBeInTheDocument()
      // 面向用户的提示不带机器错误码前缀。
      expect(screen.queryByText(/runtime_error:/)).not.toBeInTheDocument()
      expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument()

      await act(async () => screen.getByText('Retry').click())

      await waitFor(() => {
        expect(screen.getByTestId('chat-input')).toBeInTheDocument()
      })
      expect(mountAttempts).toBe(2)
      expect(errorLog).toHaveBeenCalled()
      errorLog.mockRestore()
    }
  )

  it('voice auto-send reuses the thread but leaves keyboard attachments untouched', async () => {
    h.windowSurface = 'voice-overlay'
    h.runtimeEnabled = false
    const id = crypto.randomUUID()
    useVoiceInputStore.setState({ pending: [{ id, sessionId: 'thread-1', text: '语音输入' }], readyId: id })
    renderComponent()
    await waitFor(() => expect(h.mockSendMessage).toHaveBeenCalledOnce())
    expect(h.mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ parts: [{ type: 'text', text: '语音输入' }] }))
    expect(h.attachmentsState.clearAttachments).not.toHaveBeenCalled()
    expect(screen.queryByTestId('header-page')).not.toBeInTheDocument()
    expect(screen.getByTestId('voice-composer')).toBeInTheDocument()
  })

  it('submits user text via ChatInput -> sendMessage', async () => {
    renderComponent()
    await act(async () => {
      screen.getByTestId('chat-send').click()
    })
    await waitFor(() => {
      expect(h.mockSendMessage).toHaveBeenCalled()
    })
    expect(h.messagesState.addMessage).toHaveBeenCalled()
  })

  it('Session 模式只呈现权威投影，发送与停止不进入旧 Run 通道', async () => {
    h.runtimeCapabilities = { sessionEvents: true, durableSessions: true }
    sessionView.messages = [{ id: 'session-message', role: 'assistant', parts: [{ type: 'text', text: '权威消息' }] }]
    h.chatState.messages = [{ id: 'old-message', role: 'assistant', parts: [{ type: 'text', text: '旧消息' }] }]
    renderComponent()
    expect(screen.getByTestId('message-session-message')).toBeInTheDocument()
    expect(screen.queryByTestId('message-old-message')).not.toBeInTheDocument()
    await act(async () => { screen.getByTestId('chat-send').click() })
    screen.getByTestId('chat-stop').click()
    expect(sessionView.send).toHaveBeenCalledWith('hello world', undefined, [], [], false)
    expect(sessionView.stop).toHaveBeenCalled()
    expect(h.mockSendMessage).not.toHaveBeenCalled()
    expect(h.messagesState.addMessage).not.toHaveBeenCalled()
    expect(h.mockCancelCoordinatedSessionRun).not.toHaveBeenCalled()
    expect(h.mockInvoke).not.toHaveBeenCalledWith('runtime_start')
  })

  it('Session 路径把知识库开关交给共享发送层，不在路由层检索', async () => {
    h.runtimeCapabilities = { sessionEvents: true, durableSessions: true }
    renderComponent()
    await act(async () => { screen.getByTestId('chat-send-kb').click() })
    expect(sessionView.send).toHaveBeenCalledWith('怎么装驱动', undefined, [], [], true)
    expect(knowledge.retrieve).not.toHaveBeenCalled()
  })

  it.each(['edit', 'del', 'regen', 'continue'])('Session 历史保留原消息操作：%s', async (action) => {
    h.runtimeCapabilities = { sessionEvents: true, durableSessions: true, historyOperations: true }
    sessionView.messages = [
      { id: 'session-user', role: 'user', parts: [{ type: 'text', text: '原输入' }] },
      { id: 'session-answer', role: 'assistant', parts: [{ type: 'text', text: '原回答' }] },
    ]
    renderComponent()
    expect(screen.getByTestId(`${action}-session-answer`)).toBeInTheDocument()
    await act(async () => screen.getByTestId(`${action}-session-answer`).click())
    expect(sessionView.changeHistory).toHaveBeenCalledWith(
      ...({ edit: ['edit', 'session-answer', 'edited text'], del: ['delete', 'session-answer'],
        regen: ['regenerate', 'session-answer'], continue: ['continue', 'session-answer'] }[action]!))
  })

  it('Runtime 未实现历史写接口时不给出编辑/删除/继续/重试入口', async () => {
    h.runtimeCapabilities = { sessionEvents: true, durableSessions: true }
    sessionView.messages = [
      { id: 'session-user', role: 'user', parts: [{ type: 'text', text: '原输入' }] },
      { id: 'session-answer', role: 'assistant', parts: [{ type: 'text', text: '原回答' }] },
    ]
    renderComponent()
    for (const action of ['edit', 'del', 'regen', 'continue'])
      expect(screen.queryByTestId(`${action}-session-answer`)).toBeNull()
    expect(sessionView.changeHistory).not.toHaveBeenCalled()
  })

  it('待确认输入复用原消息组件，未知回执以原身份重试', async () => {
    h.runtimeCapabilities = { sessionEvents: true, durableSessions: true }
    const input = { targetId: 'target-a', sessionId: 'thread-1', messageId: 'unknown-1', content: '待确认消息', skillIds: [], status: 'unknown' }
    sessionView.pending = [input]
    saveSessionKnowledge('target-a', 'thread-1', 'unknown-1', { version: 1, originalInput: '原始问题', question: '原始问题', prompt: input.content, context: { type: 'knowledge_retrieval', status: 'succeeded', question: '原始问题', chunks: [], total: 0 } })
    renderComponent()
    expect(screen.getByTestId('message-unknown-1')).toHaveAttribute('data-content', '原始问题')
    expect(screen.queryByText(input.content)).not.toBeInTheDocument()
    expect(screen.getByTestId('message-unknown-1')).toBeInTheDocument()
    expect(screen.getByText('Delivery result unknown, retry as-is')).toBeInTheDocument()
    await act(async () => screen.getByRole('button', { name: 'Retry as-is' }).click())
    expect(sessionView.send).toHaveBeenCalledWith(input.content, input)
    expect(h.mockSendMessage).not.toHaveBeenCalled()
  })

  it('invokes the local transport stop for non-Runtime chats', () => {
    h.runtimeEnabled = false
    renderComponent()
    screen.getByTestId('chat-stop').click()
    expect(h.mockStop).toHaveBeenCalled()
  })

  it('cancels Hermes through the Runtime gateway without aborting the transport twice', () => {
    renderComponent()
    screen.getByTestId('chat-stop').click()
    expect(h.mockStop).not.toHaveBeenCalled()
    expect(h.mockCancelCoordinatedSessionRun).toHaveBeenCalledWith(
      'thread-1',
      false,
      undefined,
      true
    )
  })

  it('shows streaming status for a runtime mirrored from another window', () => {
    h.activeRuns = {
      'thread-1': {
        runId: 'run-1',
        sessionId: 'thread-1',
        lastSequence: 1,
        content: '你',
        status: 'running',
      },
    }
    renderComponent()
    expect(screen.getByTestId('chat-status')).toHaveTextContent('streaming')
  })

  it('regenerate from a user message calls regenerate with its id', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('regen-u1').click()
    expect(h.mockRegenerate).toHaveBeenCalledWith({ messageId: 'u1' })
  })

  it('regenerate from an assistant message keeps the prior version (no delete)', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('regen-a1').click()
    // Versioning: the old reply is preserved, parent links are backfilled.
    expect(h.messagesState.deleteMessage).not.toHaveBeenCalled()
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockRegenerate).toHaveBeenCalledWith({ messageId: 'a1' })
  })

  it('edit on a user message forks a new version and regenerates', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('edit-u1').click()
    // A new sibling version is added; the original branch is not deleted.
    expect(h.messagesState.addMessage).toHaveBeenCalled()
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockSetChatMessages).toHaveBeenCalled()
    expect(h.messagesState.deleteMessage).not.toHaveBeenCalled()
    expect(h.mockRegenerate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: expect.any(String) })
    )
  })

  it('edit on an assistant message updates without regenerating', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('edit-a1').click()
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockRegenerate).not.toHaveBeenCalled()
  })

  it('shows a version chip and switches branches without regenerating', () => {
    const branched = [
      {
        id: 'u1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
        metadata: { parentId: null },
      },
      {
        id: 'a1a',
        role: 'assistant',
        created_at: 2,
        content: [{ type: 'text', text: { value: 'v1', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
      {
        id: 'a1b',
        role: 'assistant',
        created_at: 3,
        content: [{ type: 'text', text: { value: 'v2', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
    ]
    h.messagesState.messages = { 'thread-1': branched }
    h.messagesState.getMessages = vi.fn(() => branched)
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1b', role: 'assistant', parts: [{ type: 'text', text: 'v2' }] },
    ]
    renderComponent()
    // The active (newest) reply shows as version 2 of 2.
    expect(screen.getByTestId('version-a1b').textContent).toBe('2/2')
    screen.getByTestId('prev-a1b').click()
    // Switching pins the parent's active child and re-renders, no regeneration.
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockSetChatMessages).toHaveBeenCalled()
    expect(h.mockRegenerate).not.toHaveBeenCalled()
  })

  it('clears an active banner error when switching versions so a healthy assistant is not hidden', () => {
    // A prior turn left a router OOM banner active. Without clearing it on
    // switch, the render filter blanks the last assistant of whatever branch we
    // land on, leaving only user messages visible.
    h.modelProviderState.selectedProvider = 'llamacpp'
    h.appStateState.oomError = 'router crashed'
    const branched = [
      {
        id: 'u1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
        metadata: { parentId: null },
      },
      {
        id: 'a1a',
        role: 'assistant',
        created_at: 2,
        content: [{ type: 'text', text: { value: 'v1', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
      {
        id: 'a1b',
        role: 'assistant',
        created_at: 3,
        content: [{ type: 'text', text: { value: 'v2', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
    ]
    h.messagesState.messages = { 'thread-1': branched }
    h.messagesState.getMessages = vi.fn(() => branched)
    // a1b is rendered mid-list (a trailing user turn keeps it off the
    // last-message filter) so its version nav stays clickable.
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1b', role: 'assistant', parts: [{ type: 'text', text: 'v2' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'more' }] },
    ]
    renderComponent()
    screen.getByTestId('prev-a1b').click()
    expect(h.appStateState.setOomError).toHaveBeenCalledWith(undefined)
    expect(h.mockRegenerate).not.toHaveBeenCalled()
  })

  it('onFinish links a new assistant to the active user turn in a branched thread (never null parent)', () => {
    // Regression for #8357: once a thread is branched, a lost pending-parent ref
    // must not persist the assistant with parentId:null (which computeActivePath
    // drops as a phantom root, leaving "user messages in a row").
    const branched = [
      {
        id: 'u1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
        metadata: { parentId: null },
      },
      {
        id: 'a1',
        role: 'assistant',
        created_at: 2,
        content: [{ type: 'text', text: { value: 'r1', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
      {
        id: 'u2',
        role: 'user',
        created_at: 3,
        content: [{ type: 'text', text: { value: 'again', annotations: [] } }],
        metadata: { parentId: 'a1' },
      },
    ]
    h.messagesState.getMessages = vi.fn(() => branched)
    h.runtimeEnabled = false
    renderComponent()

    act(() => {
      ;(h as any).capturedOnFinish({
        message: {
          id: 'a2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'reply for u2' }],
          metadata: {},
        },
        isAbort: false,
      })
    })

    const added = h.messagesState.addMessage.mock.calls.map((c: any[]) => c[0])
    const persisted = added.find((m: any) => m.id === 'a2')
    expect(persisted).toBeTruthy()
    expect(persisted.metadata.parentId).toBe('u2')
    expect(persisted.metadata.parentId).not.toBeNull()
  })

  it('persists Runtime assistant text exactly once from onFinish', () => {
    renderComponent()

    act(() => {
      ;(h as any).capturedOnFinish({
        message: {
          id: 'run-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Hermes 回复' }],
          metadata: { runtime: 'hermes' },
        },
        isAbort: false,
      })
    })

    expect(h.messagesState.addMessage).toHaveBeenCalledTimes(1)
    expect(h.messagesState.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'run-1',
        role: 'assistant',
        content: [
          expect.objectContaining({
            type: 'text',
            text: expect.objectContaining({ value: 'Hermes 回复' }),
          }),
        ],
        metadata: expect.objectContaining({
          runtimeTurnV2: expect.objectContaining({
            schemaVersion: 2,
            runtimeId: 'hermes',
          }),
        }),
      })
    )
  })

  it('does not collect or approve local tool calls while Runtime is enabled', async () => {
    renderComponent()
    const sessionData = h.chatSessionsState.getSessionData.mock.results[0].value

    await act(async () => {
      await (h as any).capturedOnToolCall({
        toolCall: {
          toolCallId: 'runtime-tool-1',
          toolName: 'runtime-owned-tool',
          input: {},
        },
      })
    })

    expect(sessionData.tools).toEqual([])
    expect(h.toolApprovalState.requestApproval).not.toHaveBeenCalled()
  })

  it('keeps Runtime run failures attached to the assistant message', async () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        id: 'run-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'partial' }],
        metadata: { runtime: 'hermes' },
      },
    ]
    h.chatState.status = 'error'
    h.chatState.error = new Error('run_failed: Hermes process exited')

    renderComponent()

    await waitFor(() => {
      expect(useMessageErrors.getState().errors['run-1']).toBe(
        'run_failed: Hermes process exited'
      )
    })
    expect(screen.getByTestId('regen-run-1')).toBeInTheDocument()
  })

  describe('tool-call approval requested early, execution stays in onFinish', () => {
    beforeEach(() => {
      h.runtimeEnabled = false
    })

    const toolCall = (id: string) => ({
      toolCall: { toolCallId: id, toolName: 'fetch', input: { url: 'x' } },
    })
    const finishWithToolCalls = () =>
      (h as any).capturedOnFinish({
        message: {
          id: 'a-tc',
          role: 'assistant',
          parts: [{ type: 'text', text: '' }],
          metadata: { finishReason: 'tool-calls' },
        },
        isAbort: false,
      })

    it('requests approval as soon as a tool call arrives, before onFinish', async () => {
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      expect((h as any).capturedOnToolCall).toBeTypeOf('function')

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc1'))
      })

      // Popup is requested purely from the tool-call arrival, decoupled from onFinish.
      expect(h.toolApprovalState.requestApproval).toHaveBeenCalledWith(
        'tc1',
        'fetch',
        'thread-1'
      )
    })

    it('does NOT execute the tool from onToolCall (execution deferred to onFinish)', async () => {
      // Executing during streaming lands addToolResult on an incomplete message,
      // which suppresses auto-resubmit and makes the model appear to "stop".
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc1'))
      })

      expect(h.mockAddToolOutput).not.toHaveBeenCalled()
    })

    it('executes approved tools in onFinish so the completed message can auto-resubmit', async () => {
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc2'))
      })
      await act(async () => {
        await finishWithToolCalls()
      })

      // Global setup mock resolves callTool to { error: '', content: [] }.
      expect(h.mockAddToolOutput).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: 'tc2', tool: 'fetch' })
      )
    })

    it('reuses the early approval instead of prompting twice', async () => {
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc4'))
      })
      await act(async () => {
        await finishWithToolCalls()
      })

      expect(h.toolApprovalState.requestApproval).toHaveBeenCalledTimes(1)
    })

    it('marks the thread busy during onFinish execution and clears it when tools drain', async () => {
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc5'))
      })
      await act(async () => {
        await finishWithToolCalls()
      })

      expect(h.appStateState.setThreadBusy).toHaveBeenCalledWith('thread-1', true)
      expect(h.appStateState.setThreadBusy).toHaveBeenLastCalledWith('thread-1', false)
    })
  })

  it('delete removes message from store and chat list', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ]
    renderComponent()
    screen.getByTestId('del-u1').click()
    expect(h.messagesState.deleteMessage).toHaveBeenCalledWith('thread-1', 'u1')
    expect(h.mockSetChatMessages).toHaveBeenCalled()
  })

  it('shows PromptProgress while status is submitted', () => {
    h.chatState.status = 'submitted'
    renderComponent()
    expect(screen.getByTestId('prompt-progress')).toBeInTheDocument()
  })

  it.each(['sending', 'accepted'])('Session 输入 %s 且尚未开始回复时显示 Working', inputStatus => {
    h.runtimeCapabilities = { sessionEvents: true, durableSessions: true }
    sessionView.messages = [{ id: 'old', role: 'assistant', parts: [{ type: 'text', text: '上一轮' }] }]
    sessionView.pending = [{ messageId: 'new', content: '下一轮', status: inputStatus }]
    renderComponent()
    expect(screen.getByTestId('prompt-progress')).toBeInTheDocument()
  })

  it.each([
    ['streaming', false, false, true],
    ['streaming', true, false, false],
    ['streaming', false, true, false],
    ['ready', false, false, false],
  ])('Session 状态 %s，已有助手=%s，待审批=%s 时 Working=%s', (status, assistant, waiting, visible) => {
    h.runtimeCapabilities = { sessionEvents: true, durableSessions: true }
    sessionView.status = status as string
    sessionView.waiting = waiting as boolean
    sessionView.messages = [{ id: 'last', role: assistant ? 'assistant' : 'user', parts: [{ type: 'text', text: '内容' }] }]
    renderComponent()
    expect(Boolean(screen.queryByTestId('prompt-progress'))).toBe(visible)
  })

  it('processes an initial message from sessionStorage on mount', async () => {
    h.runtimeCapabilities = { durableSessions: true }
    sessionStorage.setItem(
      'initial-message-thread-1',
      JSON.stringify({ text: 'hello from storage' })
    )
    renderComponent()
    await waitFor(() => {
      expect(h.mockSendMessage).toHaveBeenCalled()
    })
    expect((h as any).capturedUseChatArgs.resume).toBe(false)
    expect(sessionStorage.getItem('initial-message-thread-1')).toBeNull()
  })

  it('clears queue on unmount', () => {
    const { unmount } = renderComponent()
    unmount()
    expect(h.messageQueueState.clearQueue).toHaveBeenCalledWith('thread-1')
  })

  it('does not initialize RAG tools in Hermes Runtime mode', async () => {
    renderComponent()
    await act(async () => {})
    expect(h.mockUpdateRag).not.toHaveBeenCalled()
  })
})
