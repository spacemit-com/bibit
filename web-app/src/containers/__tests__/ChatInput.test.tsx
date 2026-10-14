import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { useVoiceInputStore } from '@/stores/voice-input-store'
const agentApi = vi.hoisted(() => ({ invoke: vi.fn() }))
const serviceApi = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: agentApi.invoke }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ dialog: () => ({ open: serviceApi.open }) }),
  getServiceHub: () => ({ dialog: () => ({ open: serviceApi.open }) }),
}))

// --- Module mocks (must be declared before component import) ---------------

// Store backing state for usePrompt (settable by tests)
let promptState = ''
const setPromptMock = vi.fn((val: string) => {
  promptState = val
})
const addToHistoryMock = vi.fn()
const navigateHistoryMock = vi.fn()

vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: Object.assign((selector: any) =>
    selector({
      prompt: promptState,
      setPrompt: setPromptMock,
      addToHistory: addToHistoryMock,
      navigateHistory: navigateHistoryMock,
    }), {}),
}))

const updateCurrentThreadModelMock = vi.fn()
const createThreadMock = vi.fn()
const getCurrentThreadMock = vi.fn(() => undefined)
let currentThreadId: string | undefined = 'thread-1'
let currentThreadTargetId: string | undefined = 'target-a'

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: any) =>
    selector({
      currentThreadId,
      currentThreadTargetId,
      getCurrentThread: getCurrentThreadMock,
      updateCurrentThreadModel: updateCurrentThreadModelMock,
      createThread: createThreadMock,
    }),
}))

let appStateOverrides: any = {}
vi.mock('@/hooks/useAppState', () => ({
  useAppState: (selector: any) => {
    const state = {
      abortControllers: {},
      tools: [],
      cancelToolCall: vi.fn(),
      activeModels: [],
      ...appStateOverrides,
    }
    // zustand-style: selector may be a function returned by useShallow
    if (typeof selector === 'function') return selector(state)
    return state
  },
}))

let languageOverride: any = 'zh-CN'
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (selector?: any) => {
    const state = {
      spellCheckChatInput: false,
      tokenCounterCompact: false,
      currentLanguage: languageOverride,
    }
    return typeof selector === 'function' ? selector(state) : state
  },
}))

let selectedModelOverride: any = {
  id: 'model-a',
  capabilities: ['tools'],
  provider: 'llamacpp',
}
let selectedProviderOverride: any = 'llamacpp'
let runtimeEnabled = false
let sessionEvents = false
let sessionAttachments = false
let skillSelection = false
let runtimeId = 'bianbu'
const getProviderByNameMock = vi.fn()
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: any) =>
    selector({
      selectedModel: selectedModelOverride,
      selectedProvider: selectedProviderOverride,
      providers: [],
      selectModelProvider: vi.fn(),
      updateProvider: vi.fn(),
      getProviderByName: getProviderByNameMock,
    }),
}))

vi.mock('@/stores/runtime-store', () => ({
  useRuntimeStore: (selector: any) =>
    selector({ enabled: runtimeEnabled, runtimeId, runtimeEpoch: 'epoch-1', capabilities: { sessionEvents, sessionAttachments, skillSelection } }),
}))

vi.mock('@/hooks/useTokensCount', () => ({
  useTokensCount: () => ({
    maxTokens: undefined,
    configuredCtxLen: undefined,
    tokenCount: 0,
    isNearLimit: false,
    loading: false,
    fitEnabled: false,
    calculateTokens: vi.fn(),
  }),
}))

let agentModeOn = false
vi.mock('@/hooks/useAgentMode', () => ({
  useAgentMode: (selector: any) =>
    selector({
      agentThreads: agentModeOn ? { 'thread-1': true } : {},
      toggleAgentMode: vi.fn(),
    }),
}))

vi.mock('@/hooks/useMessages', () => ({
  useMessages: (selector: any) =>
    selector({
      messages: { 'thread-1': [] },
    }),
}))

vi.mock('@/hooks/useTools', () => ({
  useTools: () => undefined,
}))

let attachmentsEnabled = true
vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: (selector: any) =>
    selector({
      enabled: attachmentsEnabled,
      parseMode: 'auto',
      maxFileSizeMB: 10,
    }),
}))

let attachmentsList: any[] = []
const setAttachmentsMock = vi.fn()
const clearAttachmentsMock = vi.fn()
const transferAttachmentsMock = vi.fn()
vi.mock('@/hooks/useChatAttachments', () => ({
  NEW_THREAD_ATTACHMENT_KEY: '__new_thread__',
  useChatAttachments: (selector: any) =>
    selector({
      getAttachments: () => attachmentsList,
      setAttachments: setAttachmentsMock,
      clearAttachments: clearAttachmentsMock,
      transferAttachments: transferAttachmentsMock,
    }),
}))

vi.mock('@/hooks/useAttachmentIngestionPrompt', () => ({
  useAttachmentIngestionPrompt: vi.fn(),
}))

// Message queue store — it's imported as a zustand hook and also invoked via
// useMessageQueue.getState() for enqueue/clear/remove. Provide both.
const queueState: Record<string, any[]> = {}
const enqueueMock = vi.fn((tid: string, msg: any) => {
  queueState[tid] = queueState[tid] || []
  queueState[tid].push(msg)
})
const removeMessageMock = vi.fn()
const clearQueueMock = vi.fn()
const getQueueMock = vi.fn((tid: string) => queueState[tid] || [])

function useMessageQueueImpl(selector?: any) {
  const state = {
    getQueue: getQueueMock,
    enqueue: enqueueMock,
    removeMessage: removeMessageMock,
    clearQueue: clearQueueMock,
  }
  if (selector) return selector(state)
  return state
}
;(useMessageQueueImpl as any).getState = () => ({
  getQueue: getQueueMock,
  enqueue: enqueueMock,
  removeMessage: removeMessageMock,
  clearQueue: clearQueueMock,
})
vi.mock('@/stores/message-queue-store', () => ({
  useMessageQueue: useMessageQueueImpl,
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      get: () => undefined,
      getByName: () => undefined,
      listExtensions: () => [],
    }),
  },
}))

vi.mock('@janhq/core', () => ({
  ExtensionTypeEnum: { MCP: 'mcp', VectorDB: 'vectordb' },
  MCPExtension: class {},
  VectorDBExtension: class {},
  fs: {
    existsSync: vi.fn().mockResolvedValue(false),
    fileStat: vi.fn().mockResolvedValue({ size: 20 }),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: vi.fn() }),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}))

vi.mock('@/lib/random-id', () => ({ generateId: () => 'gen-id-1' }))

// Stub heavy children
vi.mock('@/containers/QueuedMessageBubble', () => ({
  QueuedMessageChip: ({ message }: any) => (
    <div data-testid="queued-chip">{message?.text}</div>
  ),
}))
vi.mock('@/containers/DropdownToolsAvailable', () => ({
  __esModule: true,
  default: () => <div data-testid="stub-tools" />,
}))
vi.mock('@/containers/McpExtensionToolLoader', () => ({
  McpExtensionToolLoader: () => null,
}))
vi.mock('@/containers/MovingBorder', () => ({
  MovingBorder: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('@/components/TokenCounter', () => ({
  TokenCounter: () => <div data-testid="stub-token-counter" />,
}))

// Minimal dropdown/tooltip stubs (pass-throughs to keep DOM shallow)
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: any) => <>{children}</>
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: ({ children, onClick, onSelect, disabled }: any) => (
      <button onClick={onClick || onSelect} disabled={disabled}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuSubTrigger: Pass,
  }
})
vi.mock('@/components/ui/tooltip', () => {
  const Pass = ({ children }: any) => <>{children}</>
  return {
    Tooltip: Pass,
    TooltipContent: Pass,
    TooltipTrigger: Pass,
    TooltipProvider: Pass,
  }
})

vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => false,
}))

// Import component AFTER all mocks
import ChatInput from '../ChatInput'
import { KnowledgeRetrievalError } from '@/lib/knowledge-retrieval'
import i18n from '@/i18n/setup'
import { TranslationProvider } from '@/i18n/TranslationContext'

// Helpers -------------------------------------------------------------------

const resetAll = () => {
  promptState = ''
  languageOverride = 'zh-CN'
  appStateOverrides = {}
  attachmentsList = []
  agentModeOn = false
  selectedModelOverride = {
    id: 'model-a',
    capabilities: ['tools'],
    provider: 'llamacpp',
  }
  selectedProviderOverride = { provider: 'llamacpp' }
  runtimeEnabled = false
  attachmentsEnabled = true
  sessionEvents = false
  sessionAttachments = false
  skillSelection = false
  currentThreadTargetId = 'target-a'
  runtimeId = 'bianbu'
  setPromptMock.mockClear()
  addToHistoryMock.mockClear()
  navigateHistoryMock.mockClear()
  enqueueMock.mockClear()
  clearQueueMock.mockClear()
  for (const k of Object.keys(queueState)) delete queueState[k]
  getCurrentThreadMock.mockReturnValue(undefined)
  serviceApi.open.mockReset().mockResolvedValue(null)
  agentApi.invoke.mockReset().mockResolvedValue(undefined)
  setAttachmentsMock.mockReset().mockImplementation((_key, update) => {
    attachmentsList = typeof update === 'function' ? update(attachmentsList) : update
  })
}

const getTextarea = () =>
  screen.getByTestId('chat-input') as HTMLTextAreaElement

// Shared render helper that returns last rerender handle
const renderInput = (props: any = {}) =>
  render(<ChatInput onSubmit={props.onSubmit} onStop={props.onStop} {...props} />)

describe('ChatInput', () => {
  beforeEach(() => {
    resetAll()
    currentThreadId = 'thread-1'
  })

  it('知识库开关随发送传递，发送后复位', async () => {
    runtimeEnabled = true
    promptState = 'K3 接口说明'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    const toggle = screen.getByRole('button', { name: 'Enable 进迭社区知识库' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('进迭社区知识库')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '进迭社区知识库 enabled' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('进迭社区知识库')).toBeInTheDocument()
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('K3 接口说明', undefined, undefined, true))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable 进迭社区知识库' })).toHaveAttribute('aria-pressed', 'false'))
    expect(screen.queryByText('进迭社区知识库')).not.toBeInTheDocument()
  })

  it('@ 回车直接启用知识库并保留正文，邮箱与网址不打开面板', async () => {
    runtimeEnabled = true
    promptState = 'K3 接口说明 @'
    const onSubmit = vi.fn()
    const view = renderInput({ onSubmit })
    getTextarea().setSelectionRange(9, 9)
    fireEvent.select(getTextarea())
    expect(await screen.findByTestId('slash-knowledge-knowledge')).toBeInTheDocument()
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    const toggle = screen.getByRole('button', { name: '进迭社区知识库 enabled' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle.querySelector('svg.lucide-book-open')).toBeTruthy()
    expect(setPromptMock).toHaveBeenLastCalledWith('K3 接口说明 ')
    expect(onSubmit).not.toHaveBeenCalled()
    for (const value of ['a@b.com', 'https://a/@b', '名字@企业.com']) {
      promptState = value
      view.rerender(<ChatInput onSubmit={onSubmit} />)
      expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument()
    }
  })

  it('首页首发把选中的技能 ID 一并交给新会话', async () => {
    runtimeEnabled = true
    sessionEvents = true
    skillSelection = true
    currentThreadId = undefined
    promptState = '请审查这段代码'
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_skills_list') return [{ id: 'bianbu.audit/audit-guide', name: 'audit-guide', display_name: '代码审计', enabled: true, assignable: true }]
      if (name === 'runtime_agents_list') return [{ id: 'real-agent', name: '助手', available: true }]
      return { targetId: 'target-a', runtimeEpoch: 'e1' }
    })
    createThreadMock.mockResolvedValueOnce({ id: 'skill-first', metadata: { targetId: 'target-a' } })
    const user = userEvent.setup()
    renderInput()
    await user.click(await screen.findByTestId('skill-picker-trigger'))
    await user.click(await screen.findByTestId('skill-picker-item-bianbu.audit/audit-guide'))
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('initial-message-skill-first')!)).toMatchObject({
      text: '请审查这段代码', skillIds: ['bianbu.audit/audit-guide'],
    }))
  })

  it('renders the textarea with placeholder and send button', () => {
    renderInput()
    const ta = getTextarea()
    expect(ta).toBeInTheDocument()
    expect(ta).toHaveAttribute('placeholder', 'Ask me anything...')
    // send button is present
    expect(document.querySelector('[data-test-id="send-message-button"]')).toBeTruthy()
  })

  const agentTrigger = async () =>
    waitFor(() => {
      const node = document.querySelector('[data-slot="agent-trigger"]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

  it.each([
    ['已自动选中唯一专家', [{ id: 'expert-a', name: 'A', available: true }], () => 'A'],
    ['多个专家时回退内置默认助手', [{ id: 'builtin', origin: 'system', name: 'BibitEdgeAssistant', zhName: 'Bibit端侧智能助手', available: true }, { id: 'expert-b', name: 'B', available: true }], () => 'Bibit端侧智能助手'],
    ['有多个专家且未选', [{ id: 'expert-b', name: 'B', available: true }, { id: 'expert-c', name: 'C', available: true }], () => i18n.t('chat:selectAssistant')],
  ])('新建会话的专家入口显示当前专家名称（%s）', async (_label, agents, pillText) => {
    runtimeEnabled = true
    sessionEvents = true
    currentThreadId = undefined
    agentApi.invoke.mockImplementation(async (name: string) =>
      name === 'runtime_agents_list' ? agents : { targetId: 'target-a', runtimeEpoch: 'e1' }
    )
    renderInput()
    const trigger = await agentTrigger()
    const label = pillText()
    expect(trigger).toHaveAttribute('title', label === i18n.t('chat:selectAssistant')
      ? i18n.t('chat:selectAssistantTooltip')
      : i18n.t('chat:expertCurrentTooltip', { name: label }))
    expect(trigger).toHaveTextContent(label)
  })

  it('专家图标按钮只在未选择其他专家时高亮，未选择即以默认助手建会话', async () => {
    runtimeEnabled = true
    sessionEvents = true
    currentThreadId = undefined
    promptState = '用默认助手回话'
    agentApi.invoke.mockImplementation(async (name: string) =>
      name === 'runtime_agents_list' ? [
        { id: 'builtin', origin: 'system', name: 'BibitEdgeAssistant', zhName: 'Bibit端侧智能助手', available: true },
        { id: 'expert-b', origin: 'user', name: '代码专家', available: true },
      ] : { targetId: 'target-a', runtimeEpoch: 'e1' }
    )
    createThreadMock.mockResolvedValueOnce({ id: 'default-session', metadata: { targetId: 'target-a' } })
    renderInput()
    const trigger = await agentTrigger()
    // 默认助手不出现在“其他专家”列表里，也不会点亮图标按钮
    expect(screen.queryByRole('button', { name: 'Bibit端侧智能助手' })).not.toBeInTheDocument()
    expect(trigger.className).not.toContain('bg-primary/10')
    const defaultRow = () => screen.getByRole('button', { name: new RegExp(i18n.t('chat:expertUseDefault')) })
    expect(defaultRow()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '代码专家' }))
    await waitFor(() => expect(trigger).toHaveTextContent('代码专家'))
    expect(trigger.className).toContain('bg-primary/10')
    expect(localStorage.getItem('bibit:agent:target-a')).toBe('expert-b')
    fireEvent.click(defaultRow())
    await waitFor(() => expect(trigger).toHaveTextContent('Bibit端侧智能助手'))
    expect(localStorage.getItem('bibit:agent:target-a')).toBeNull()
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(createThreadMock).toHaveBeenCalledWith(
      { id: 'builtin', provider: 'runtime' }, '用默认助手回话', false, 'target-a'
    ))
  })

  it('读取专家列表失败时悬浮提示仍然报原因', async () => {
    runtimeEnabled = true
    sessionEvents = true
    currentThreadId = undefined
    agentApi.invoke.mockRejectedValue(new Error('运行时未就绪'))
    renderInput()
    const trigger = await agentTrigger()
    expect(trigger).toHaveAttribute('title', '运行时未就绪')
  })

  it.each(['llamacpp', 'openai'])(
    'does not render legacy sampling or reasoning controls for %s',
    (provider) => {
      selectedProviderOverride = provider
      renderInput()

      expect(
        screen.queryByRole('button', { name: 'Sampling parameters' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /^Reasoning(?: effort)?:/ })
      ).not.toBeInTheDocument()
    }
  )

  it('disables the send button when prompt is empty', () => {
    renderInput()
    const btn = document.querySelector(
      '[data-test-id="send-message-button"]'
    ) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('enables the send button when prompt has content', () => {
    promptState = 'hello'
    renderInput()
    const btn = document.querySelector(
      '[data-test-id="send-message-button"]'
    ) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('keeps the send button aligned to the end when Runtime hides the toolbar', () => {
    runtimeEnabled = true
    renderInput()

    const sendButton = document.querySelector(
      '[data-test-id="send-message-button"]'
    ) as HTMLButtonElement
    expect(sendButton.parentElement).toHaveClass('ml-auto')
  })

  it('calls setPrompt on textarea change', () => {
    renderInput()
    fireEvent.change(getTextarea(), { target: { value: 'abc' } })
    expect(setPromptMock).toHaveBeenCalledWith('abc')
  })

  it('submits via onSubmit prop when Enter is pressed', () => {
    promptState = 'hello world'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('hello world', undefined, undefined, false)
    expect(addToHistoryMock).toHaveBeenCalledWith('hello world')
    expect(setPromptMock).toHaveBeenCalledWith('')
  })

  it('does NOT submit on Shift+Enter (newline behavior)', () => {
    promptState = 'hello'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does nothing when Enter pressed with empty/whitespace prompt', () => {
    promptState = '   '
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits via the send button click', () => {
    promptState = 'button submit'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    const btn = document.querySelector(
      '[data-test-id="send-message-button"]'
    ) as HTMLButtonElement
    fireEvent.click(btn)
    expect(onSubmit).toHaveBeenCalledWith('button submit', undefined, undefined, false)
  })

  it('shows stop button while streaming and hides the send button', () => {
    promptState = 'stream stuff'
    renderInput({ chatStatus: 'streaming' })
    expect(
      document.querySelector('[data-test-id="send-message-button"]')
    ).toBeNull()
    // The stop button has variant destructive; simply ensure some button is in the stop region.
    const btns = document.querySelectorAll('button')
    expect(btns.length).toBeGreaterThan(0)
  })

  it('忙碌时标记输入框并常驻动画层，空闲后只隐藏不卸载', () => {
    const view = renderInput({ chatStatus: 'streaming' })
    const surface = view.container.querySelector('[data-busy]') as HTMLElement
    expect(surface.getAttribute('data-busy')).toBe('true')
    expect(surface.querySelector('[aria-hidden="false"]')).not.toBeNull()
    view.rerender(<ChatInput chatStatus="ready" />)
    expect(surface.getAttribute('data-busy')).toBe('false')
    const idleLayer = surface.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(idleLayer).not.toBeNull()
    expect(idleLayer.className).toContain('opacity-0')
  })

  it.each(['thread-1', undefined])('全局会话为 %s 时调用当前对话的停止回调', (selectedId) => {
    currentThreadId = selectedId
    const onStop = vi.fn()
    renderInput({ chatStatus: 'streaming', onStop })
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(clearQueueMock).not.toHaveBeenCalled()
  })

  it('queues the message when streaming with a currentThreadId', () => {
    promptState = 'queued msg'
    const onSubmit = vi.fn()
    renderInput({ onSubmit, chatStatus: 'streaming' })
    // During streaming, stop button is shown instead of send; submit path is via Enter on textarea
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(enqueueMock).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ text: 'queued msg', id: 'gen-id-1' })
    )
    // onSubmit should NOT fire when queued
    expect(onSubmit).not.toHaveBeenCalled()
    expect(setPromptMock).toHaveBeenCalledWith('')
  })

  it('Session 运行中追加交给服务端而非本地队列', () => {
    runtimeEnabled = true
    sessionEvents = true
    promptState = '追加消息'
    const onSubmit = vi.fn()
    renderInput({ onSubmit, chatStatus: 'streaming' })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('追加消息', undefined, undefined, false)
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('异步提交失败清空输入框并显示原输入框错误（不回填）', async () => {
    promptState = '需要保留的草稿'
    const onSubmit = vi.fn().mockRejectedValue(new Error('回执未收到'))
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('回执未收到')).toBeInTheDocument())
    // 方案A：发送即清空；非知识库失败不回填，靠消息流 pending 重试。
    expect(setPromptMock).toHaveBeenCalledWith('')
    expect(getTextarea()).toHaveValue('')
  })

  it('知识库检索失败回填草稿与开关，其余失败不回填', async () => {
    runtimeEnabled = true
    promptState = '需要保留的问题'
    const onSubmit = vi.fn().mockRejectedValue(new KnowledgeRetrievalError('知识库服务 HTTP 401'))
    renderInput({ onSubmit })
    fireEvent.click(screen.getByRole('button', { name: 'Enable 进迭社区知识库' }))
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('需要保留的问题', undefined, undefined, true))
    await waitFor(() => expect(screen.getByText(/知识库服务 HTTP 401/)).toBeInTheDocument())
    expect(setPromptMock).toHaveBeenCalledWith('需要保留的问题')
    expect(screen.getByRole('button', { name: '进迭社区知识库 enabled' })).toHaveAttribute('aria-pressed', 'true')
  })

  it.each([false, true])('发送即清空，回执到达不清空提交期间新草稿，离开=%s', async (leave) => {
    promptState = '等待接收的草稿'
    let accept!: () => void
    const onSubmit = vi.fn(() => new Promise<void>(resolve => { accept = resolve }))
    const view = renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    // 方案A：发送即清空输入框。
    expect(setPromptMock).toHaveBeenCalledWith('')
    setPromptMock.mockClear()
    if (leave) view.unmount()
    await act(async () => accept())
    // 回执到达不再额外清空（避免覆盖提交期间新草稿）；unmount 后也不再触碰。
    expect(setPromptMock).not.toHaveBeenCalledWith('')
  })

  it('等待提交时不重复发送，发送即清空但不覆盖期间编辑的新草稿', async () => {
    promptState = '第一条消息'
    let accept!: () => void
    const onSubmit = vi.fn(() => new Promise<void>(resolve => { accept = resolve }))
    const view = renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    // 方案A：发送即清空输入框。
    expect(setPromptMock).toHaveBeenCalledWith('')
    promptState = '继续编辑的新草稿'
    view.rerender(<ChatInput onSubmit={onSubmit} />)
    await act(async () => accept())
    // 回执到达不应覆盖用户在等待期间输入的新草稿。
    expect(setPromptMock).not.toHaveBeenCalledWith('继续编辑的新草稿')
    expect(promptState).toBe('继续编辑的新草稿')
  })

  it('shows "please select a model" inline message when no model selected', () => {
    // With no selected model, Enter should set the inline error message
    selectedModelOverride = null
    promptState = 'hi'
    renderInput({ onSubmit: vi.fn() })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(
      screen.getByText('Please select a model to start chatting.')
    ).toBeInTheDocument()
  })

  it('submits text without a selected model in Hermes Runtime mode', () => {
    runtimeEnabled = true
    selectedModelOverride = null
    promptState = 'Hermes 消息'
    const onSubmit = vi.fn()

    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('Hermes 消息', undefined, undefined, false)
    expect(
      screen.queryByText('Please select a model to start chatting.')
    ).not.toBeInTheDocument()
  })

  it('creates a persistent thread with Hermes Runtime compatibility fields', async () => {
    runtimeEnabled = true
    runtimeId = 'hermes'
    selectedModelOverride = null
    selectedProviderOverride = ''
    promptState = '新 Hermes 会话'
    createThreadMock.mockResolvedValueOnce({ id: 'demo-thread' })

    renderInput()
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    await waitFor(() => {
      expect(createThreadMock).toHaveBeenCalledWith(
        { id: 'hermes', provider: 'runtime' },
        '新 Hermes 会话'
      )
    })
  })

  it('Session 首页绑定真实 Agent 和目标，暂存首条消息的稳定身份', async () => {
    runtimeEnabled = true
    sessionEvents = true
    promptState = '首页首条消息'
    agentApi.invoke.mockImplementation(async name => name === 'runtime_agents_list'
      ? [{ id: 'real-agent', name: '助手', available: true }]
      : { targetId: 'target-a', runtimeEpoch: 'e1' })
    createThreadMock.mockResolvedValueOnce({ id: 'new-session', metadata: { targetId: 'target-a' } })
    renderInput()
    await waitFor(() => expect(document.querySelector('[data-slot="agent-trigger"]')).toHaveTextContent('助手'))
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(createThreadMock).toHaveBeenCalledWith(
      { id: 'real-agent', provider: 'runtime' }, '首页首条消息', false, 'target-a'
    ))
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('initial-message-new-session')!)).toMatchObject({
      text: '首页首条消息', targetId: 'target-a', sessionId: 'new-session', messageId: expect.any(String),
    }))
  })

  it('同名助手显示完整身份，选择后创建会话仍使用对应 Agent ID', async () => {
    runtimeEnabled = true
    sessionEvents = true
    promptState = '同名助手验证'
    agentApi.invoke.mockImplementation(async name => name === 'runtime_agents_list'
      ? [{ id: 'agent-a', name: 'Legacy', zhName: '端侧助手', available: true },
        { id: 'agent-b', name: 'Current', zhName: '端侧助手', available: true }]
      : { targetId: 'target-duplicates', runtimeEpoch: 'e1' })
    createThreadMock.mockResolvedValueOnce({ id: 'duplicate-session', metadata: { targetId: 'target-duplicates' } })
    renderInput()
    const trigger = await agentTrigger()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '端侧助手（agent-b）' }))
    expect(trigger).toHaveTextContent('端侧助手（agent-b）')
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(createThreadMock).toHaveBeenCalledWith(
      { id: 'agent-b', provider: 'runtime' }, '同名助手验证', false, 'target-duplicates'
    ))
  })

  it('Session 首页无可用 Agent 时按钮和回车都不能创建会话', async () => {
    runtimeEnabled = true
    sessionEvents = true
    promptState = '不能发送'
    agentApi.invoke.mockImplementation(async name => name === 'runtime_agents_list' ? [] : { targetId: 'target-a', runtimeEpoch: 'e1' })
    createThreadMock.mockClear()
    const view = renderInput()
    await screen.findByText('No assistants available')
    expect(view.container.querySelector('[data-test-id="send-message-button"]')).toBeDisabled()
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(createThreadMock).not.toHaveBeenCalled()
  })

  it('does not submit if isComposing (IME) is true', () => {
    promptState = 'hello'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), {
      key: 'Enter',
      // jsdom supports isComposing on KeyboardEvent
      isComposing: true,
    })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('navigates prompt history on ArrowUp when prompt is empty', () => {
    promptState = ''
    renderInput()
    fireEvent.keyDown(getTextarea(), { key: 'ArrowUp' })
    expect(navigateHistoryMock).toHaveBeenCalledWith('up')
  })

  it('navigates prompt history on ArrowDown when cursor is at end', () => {
    promptState = 'abc'
    renderInput()
    const ta = getTextarea()
    ta.focus()
    ta.setSelectionRange(3, 3)
    fireEvent.keyDown(ta, { key: 'ArrowDown' })
    expect(navigateHistoryMock).toHaveBeenCalledWith('down')
  })

  it('adds attached image files to onSubmit payload', () => {
    promptState = 'with image'
    attachmentsList = [
      {
        type: 'image',
        dataUrl: 'data:image/png;base64,xxx',
        mimeType: 'image/png',
      },
    ]
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith(
      'with image',
      expect.arrayContaining([
        expect.objectContaining({
          type: 'file',
          mediaType: 'image/png',
          url: 'data:image/png;base64,xxx',
        }),
      ]),
      undefined,
      false
    )
    // 方案A（收敛后）：AI SDK 模式也走增量 setAttachmentsForThread，清除本次发送的附件。
    expect(clearAttachmentsMock).not.toHaveBeenCalled()
    expect(setAttachmentsMock).toHaveBeenCalled()
  })

  it('submits only uploaded Runtime resource references', () => {
    runtimeEnabled = true
    promptState = 'Runtime text only'
    attachmentsList = [
      {
        type: 'document',
        mimeType: 'text/plain',
        resourceId: 'resource-1',
        resourceUrl: '/api/v1/sessions/thread-1/attachments/resource-1',
      },
    ]
    const onSubmit = vi.fn()

    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('Runtime text only', [
      {
        type: 'file',
        mediaType: 'text/plain',
        url: '/api/v1/sessions/thread-1/attachments/resource-1',
        resourceId: 'resource-1',
      },
    ], undefined, false)
  })

  it('removes submitted Runtime resources after acceptance and keeps newer attachments', async () => {
    runtimeEnabled = true
    promptState = 'Runtime attachment'
    attachmentsList = [{ type: 'document', resourceId: 'resource-1' }]
    let accept!: () => void
    const onSubmit = vi.fn(() => new Promise<void>(resolve => { accept = resolve }))
    const view = renderInput({ onSubmit })

    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    attachmentsList = [
      { type: 'document', resourceId: 'resource-1' },
      { type: 'document', resourceId: 'resource-2' },
    ]
    view.rerender(<ChatInput onSubmit={onSubmit} />)
    await act(async () => accept())

    expect(attachmentsList).toEqual([{ type: 'document', resourceId: 'resource-2' }])
  })

  it('keeps a failed Runtime attachment and blocks submit until retry succeeds', () => {
    runtimeEnabled = true
    promptState = '不能丢附件'
    attachmentsList = [{
      type: 'document',
      path: '/tmp/brief.txt',
      error: '连接中断',
      processed: false,
      processing: false,
    }]
    const onSubmit = vi.fn()

    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Upload failed, click to retry')).toBeInTheDocument()
    expect(
      screen.getByText('Please retry or remove attachments that failed to upload')
    ).toBeInTheDocument()
  })

  it('hides Runtime attachment input when the Runtime has no attachment endpoint', () => {
    runtimeEnabled = true
    sessionAttachments = false

    renderInput({ onSubmit: vi.fn() })

    expect(
      screen.queryByRole('button', { name: 'Add attachment' })
    ).not.toBeInTheDocument()
  })

  it('does not upload or submit when the Runtime file dialog is cancelled', async () => {
    runtimeEnabled = true
    sessionAttachments = true
    promptState = '保留草稿'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })

    fireEvent.click(screen.getByText('Add documents or files'))
    await act(async () => {})

    expect(agentApi.invoke).toHaveBeenCalledWith('runtime_session_attachment_select', {
      sessionId: 'thread-1',
      expectedTargetId: 'target-a',
    })
    expect(serviceApi.open).not.toHaveBeenCalled()
    expect(agentApi.invoke.mock.calls.some(([name]) => name === 'runtime_session_attachment_upload')).toBe(false)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('retains a failed Runtime upload and retries even when the legacy attachment setting is disabled', async () => {
    runtimeEnabled = true
    sessionAttachments = true
    attachmentsEnabled = false
    let attempts = 0
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_session_attachment_select') {
        return {
          grantId: `grant-${attempts + 1}`,
          displayName: 'brief.txt',
          byteLength: 20,
        }
      }
      if (name === 'runtime_controller_acquire') return { accepted: true, duplicate: false }
      if (name === 'runtime_session_attachment_upload') {
        attempts += 1
        if (attempts === 1) throw new Error('连接中断')
        return {
          resourceId: 'resource-retried',
          name: 'brief.txt',
          size: 20,
          mimeType: 'text/plain',
          url: '/api/v1/sessions/thread-1/attachments/resource-retried',
        }
      }
      return undefined
    })
    const view = renderInput({ onSubmit: vi.fn() })

    fireEvent.click(screen.getByText('Add documents or files'))
    await screen.findByText('Upload failed, click to retry')
    fireEvent.click(screen.getByText('Upload failed, click to retry'))
    await waitFor(() => expect(attempts).toBe(2))
    view.rerender(<ChatInput onSubmit={vi.fn()} />)

    expect(screen.queryByText('上传失败，点击重试')).not.toBeInTheDocument()
    expect(attachmentsList).toContainEqual(expect.objectContaining({
      resourceId: 'resource-retried',
      processed: true,
      error: undefined,
    }))
    const uploads = agentApi.invoke.mock.calls.filter(([name]) => name === 'runtime_session_attachment_upload')
    expect(uploads).toHaveLength(2)
    expect(uploads[0][1]).toEqual({
      sessionId: 'thread-1',
      grantId: 'grant-1',
      expectedTargetId: 'target-a',
    })
    expect(uploads[1][1]).toEqual({
      sessionId: 'thread-1',
      grantId: 'grant-2',
      expectedTargetId: 'target-a',
    })
  })

  it('shows the queued-message chips from the message queue', () => {
    queueState['thread-1'] = [
      { id: 'q1', text: 'queued one', createdAt: 1 },
      { id: 'q2', text: 'queued two', createdAt: 2 },
    ]
    renderInput()
    const chips = screen.getAllByTestId('queued-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0]).toHaveTextContent('queued one')
  })

  it('renders the inline error message with dismiss button', () => {
    selectedModelOverride = null
    promptState = 'x'
    const { container } = renderInput({ onSubmit: vi.fn() })
    act(() => {
      fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    })
    const errorNode = screen.getByText('Please select a model to start chatting.')
    expect(errorNode).toBeInTheDocument()
    // dismiss icon (svg) sits alongside
    const svg = container.querySelector('.text-destructive svg')
    expect(svg).toBeTruthy()
  })

  describe('token counter visibility', () => {
    // Regression: llama.cpp is a string provider ('llamacpp') and loads lazily,
    // so it is never present in `activeModels` during a chat turn. The counter
    // must still render off model selection + prompt/messages alone.
    it('renders for llama.cpp even when activeModels is empty', () => {
      selectedProviderOverride = { provider: 'llamacpp' }
      appStateOverrides = { activeModels: [] }
      promptState = 'hello'
      renderInput()
      expect(screen.getByTestId('stub-token-counter')).toBeInTheDocument()
    })

    it('renders for a remote provider (openai) with a selected model', () => {
      selectedProviderOverride = 'openai'
      appStateOverrides = { activeModels: [] }
      promptState = 'hello'
      renderInput()
      expect(screen.getByTestId('stub-token-counter')).toBeInTheDocument()
    })

    it('does not render when no model is selected', () => {
      selectedModelOverride = null
      promptState = 'hello'
      renderInput()
      expect(screen.queryByTestId('stub-token-counter')).not.toBeInTheDocument()
    })

    it('does not render with no messages and an empty prompt', () => {
      promptState = ''
      renderInput()
      expect(screen.queryByTestId('stub-token-counter')).not.toBeInTheDocument()
    })
  })
})

describe('ChatInput 临时技能选择', () => {
  const skills = [
    { id: 's1', name: 's1', display_name: '技能一', description: '第一个技能', enabled: true, assignable: true },
    { id: 's2', name: 's2', display_name: '技能二', description: '第二个技能', enabled: false, assignable: true },
  ]
  beforeEach(() => {
    resetAll()
    currentThreadId = 'thread-1'
    runtimeEnabled = true
    sessionEvents = true
    skillSelection = true
    agentApi.invoke.mockImplementation(async (name: string) =>
      name === 'runtime_skills_list' ? skills : undefined)
  })

  it('能力位关闭时不显示技能入口', () => {
    skillSelection = false
    renderInput()
    expect(screen.queryByTestId('skill-picker-trigger')).not.toBeInTheDocument()
  })

  it('选择技能后以 chips 展示，提交携带 skillIds 并在成功后清空', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const view = renderInput({ onSubmit })
    await user.click(screen.getByTestId('skill-picker-trigger'))
    const item = await screen.findByTestId('skill-picker-item-s1')
    // enabled:false 的技能不出现在可选列表
    expect(screen.queryByTestId('skill-picker-item-s2')).not.toBeInTheDocument()
    await user.click(item)
    expect(screen.getByTestId('skill-chip-s1')).toBeInTheDocument()
    promptState = '带技能的消息'
    view.rerender(<ChatInput onSubmit={onSubmit} />)
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('带技能的消息', undefined, ['s1'], false))
    await waitFor(() => expect(screen.queryByTestId('skill-chip-s1')).not.toBeInTheDocument())
  })

  it('移除 chip 后提交不带 skillIds', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const view = renderInput({ onSubmit })
    await user.click(screen.getByTestId('skill-picker-trigger'))
    await user.click(await screen.findByTestId('skill-picker-item-s1'))
    await user.click(screen.getByTestId('skill-chip-s1').querySelector('button')!)
    promptState = '不带技能的消息'
    view.rerender(<ChatInput onSubmit={onSubmit} />)
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('不带技能的消息', undefined, undefined, false))
  })

  it('手打 /skills 仍然打开技能选择器并清空输入', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    promptState = '/skills'
    const view = renderInput({ onSubmit })
    expect(screen.getByTestId('slash-menu')).toBeInTheDocument()
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument()
    expect(setPromptMock).toHaveBeenCalledWith('')
    expect(await screen.findByTestId('skill-picker-item-s1')).toBeInTheDocument()
    // 选中后再提交，验证命令打开的选择器与按钮入口共享同一状态
    await user.click(screen.getByTestId('skill-picker-item-s1'))
    promptState = '命令入口选技能'
    view.rerender(<ChatInput onSubmit={onSubmit} />)
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('命令入口选技能', undefined, ['s1'], false))
  })
})


describe('ChatInput 直接选择技能与草稿消费', () => {
  const skills = [
    { id: 's1', name: 'summarize', display_name: '文档总结', description: '整理文档要点', enabled: true, assignable: true },
    { id: 's2', name: 'review', display_name: '代码审查', description: '检查代码问题', enabled: true, assignable: true },
  ]
  beforeEach(() => {
    resetAll(); currentThreadId = 'thread-1'; runtimeEnabled = true; sessionEvents = true; skillSelection = true
    agentApi.invoke.mockImplementation(async name => name === 'runtime_skills_list' ? skills : undefined)
  })
  it('斜杠直接列出技能，方向键和 Tab 只添加标签不发送', async () => {
    const onSubmit = vi.fn(); promptState = '/'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    expect(await screen.findByTestId('slash-skill-s1')).toBeInTheDocument()
    fireEvent.keyDown(getTextarea(), { key: 'ArrowDown' })
    fireEvent.keyDown(getTextarea(), { key: 'Tab' })
    expect(screen.getByTestId('skill-chip-s2')).toBeInTheDocument()
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument()
    expect(setPromptMock).toHaveBeenLastCalledWith('')
    expect(onSubmit).not.toHaveBeenCalled()
  })
  it('在正文中搜索描述并选择技能，只移除光标所在斜杠词', async () => {
    const onSubmit = vi.fn(); promptState = '请 /要点 总结附件'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(5, 5)
    fireEvent.select(getTextarea())
    expect(await screen.findByTestId('slash-skill-s1')).toBeInTheDocument()
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(screen.getByTestId('skill-chip-s1')).toBeInTheDocument()
    expect(setPromptMock).toHaveBeenLastCalledWith('请  总结附件')
    expect(onSubmit).not.toHaveBeenCalled()
  })
  it('Esc 保留正文；网址和路径不打开面板', async () => {
    const onSubmit = vi.fn(); promptState = '/'
    const view = renderInput({ onSubmit })
    await screen.findByTestId('slash-skill-s1')
    fireEvent.keyDown(getTextarea(), { key: 'Escape' })
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument()
    expect(setPromptMock).not.toHaveBeenCalled()
    for (const value of ['https://example.com/a', '/etc/hosts', '查看 /tmp/a.txt', '文件 ./foo']) {
      promptState = value; view.rerender(<ChatInput onSubmit={onSubmit} />)
      expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument()
    }
  })
  it('没有匹配项时回车仍然发送，Enter 不被菜单吞掉', async () => {
    const onSubmit = vi.fn(); promptState = '/etc'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(4, 4); fireEvent.select(getTextarea())
    expect(await screen.findByText('No matching skills')).toBeInTheDocument()
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('/etc', undefined, undefined, false)
  })
  it('Tab 与 Enter 一样选中技能，并只移除光标所在的斜杠词', async () => {
    // Tab 过去只补全命令文本、不选中；菜单里只剩技能之后，Tab 就是「选中当前项」。
    const onSubmit = vi.fn(); promptState = '请 /sum 后续正文'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(6, 6); fireEvent.select(getTextarea())
    await screen.findByTestId('slash-skill-s1')
    fireEvent.keyDown(getTextarea(), { key: 'Tab' })
    expect(screen.getByTestId('skill-chip-s1')).toBeInTheDocument()
    expect(setPromptMock).toHaveBeenLastCalledWith('请  后续正文')
    expect(screen.queryByTestId('slash-menu')).not.toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
  it('插件技能在菜单与已选标签里显示 插件id:技能名，standalone 技能不变', async () => {
    agentApi.invoke.mockImplementation(async name => name === 'runtime_skills_list' ? [
      { id: 'spacemit-power/markdown-maker', name: 'markdown-maker', display_name: 'PDF 转 Markdown', description: '把 PDF 转成 Markdown', origin: 'plugin', plugin_id: 'spacemit-power', enabled: true, assignable: true },
      { id: 'summarize', name: 'summarize', display_name: '文档总结', description: '整理文档要点', origin: 'standalone', plugin_id: null, enabled: true, assignable: true },
    ] : undefined)
    const onSubmit = vi.fn(); promptState = '/'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    const pluginOption = await screen.findByTestId('slash-skill-spacemit-power/markdown-maker')
    expect(pluginOption).toHaveTextContent('spacemit-power:PDF 转 Markdown')
    const standaloneOption = screen.getByTestId('slash-skill-summarize')
    expect(standaloneOption).toHaveTextContent('文档总结')
    expect(standaloneOption.textContent).not.toContain('spacemit-power:')
    expect(pluginOption.textContent).not.toContain('把 PDF 转成 Markdown')
    expect(standaloneOption.textContent).not.toContain('整理文档要点')
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(screen.getByTestId('skill-chip-spacemit-power/markdown-maker'))
      .toHaveTextContent('spacemit-power:PDF 转 Markdown')
    expect(onSubmit).not.toHaveBeenCalled()
  })
  it('临时技能面板也只列名字，不显示技能描述', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(); promptState = '/'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    await screen.findByTestId('slash-skill-s1')
    await user.click(screen.getByTestId('skill-picker-trigger'))
    const item = await screen.findByTestId('skill-picker-item-s1')
    expect(item).toHaveTextContent('文档总结')
    expect(item.textContent).not.toContain('整理文档要点')
  })
  it('专家选中的 Plugin 名下技能也算专家已有，不出现在候选里', async () => {
    // Plugin 一被选中，它名下的 Skill 就随 Plugin 一起进会话：再列出来只会让用户
    // 白选一次，所以候选里只剩这个专家真正没有的技能。
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_agents_list') return [
        { id: 'real-agent', name: '助手', available: true, skills: ['summarize'], plugins: ['spacemit-power'] },
      ]
      if (name === 'runtime_skills_list') return [
        { id: 'spacemit-power/markdown-maker', name: 'markdown-maker', display_name: 'PDF 转 Markdown', description: '把 PDF 转成 Markdown', origin: 'plugin', plugin_id: 'spacemit-power', enabled: true, assignable: true },
        { id: 'summarize', name: 'summarize', display_name: '文档总结', description: '整理文档要点', enabled: true, assignable: true },
        { id: 'vibe-coder', name: 'vibe-coder', display_name: 'vibe-coder', description: '离线 HTML/CSS/JS 应用', enabled: true, assignable: true },
      ]
      return { targetId: 'target-a', runtimeEpoch: 'e1' }
    })
    const onSubmit = vi.fn(); promptState = '/'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    expect(await screen.findByTestId('slash-skill-vibe-coder')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('slash-skill-summarize')).not.toBeInTheDocument())
    expect(screen.queryByTestId('slash-skill-spacemit-power/markdown-maker')).not.toBeInTheDocument()
  })
  it('专家点名了插件成员时，该插件名下其它技能同样不出现', async () => {
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_agents_list') return [
        { id: 'real-agent', name: '助手', available: true, skills: ['spacemit-power/k3-media-pipeline'] },
      ]
      if (name === 'runtime_skills_list') return [
        { id: 'spacemit-power/markdown-maker', name: 'markdown-maker', display_name: 'PDF 转 Markdown', description: '把 PDF 转成 Markdown', origin: 'plugin', plugin_id: 'spacemit-power', enabled: true, assignable: true },
        { id: 'spacemit-power/k3-media-pipeline', name: 'k3-media-pipeline', display_name: 'K3 媒体管线', description: '媒体管线', origin: 'plugin', plugin_id: 'spacemit-power', enabled: true, assignable: true },
        { id: 'vibe-coder', name: 'vibe-coder', display_name: 'vibe-coder', description: '离线 HTML/CSS/JS 应用', enabled: true, assignable: true },
      ]
      return { targetId: 'target-a', runtimeEpoch: 'e1' }
    })
    const onSubmit = vi.fn(); promptState = '/'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    expect(await screen.findByTestId('slash-skill-vibe-coder')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('slash-skill-spacemit-power/markdown-maker')).not.toBeInTheDocument())
    expect(screen.queryByTestId('slash-skill-spacemit-power/k3-media-pipeline')).not.toBeInTheDocument()
  })
  it('专家点名的插件工具也会把该 Plugin 拉进来，名下技能同样不出现', async () => {
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_agents_list') return [
        { id: 'real-agent', name: '助手', available: true, tools: ['spacemit-power/k3-media-tool'] },
      ]
      if (name === 'runtime_skills_list') return [
        { id: 'spacemit-power/markdown-maker', name: 'markdown-maker', display_name: 'PDF 转 Markdown', description: '把 PDF 转成 Markdown', origin: 'plugin', plugin_id: 'spacemit-power', enabled: true, assignable: true },
        { id: 'vibe-coder', name: 'vibe-coder', display_name: 'vibe-coder', description: '离线 HTML/CSS/JS 应用', enabled: true, assignable: true },
      ]
      return { targetId: 'target-a', runtimeEpoch: 'e1' }
    })
    const onSubmit = vi.fn(); promptState = '/'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    expect(await screen.findByTestId('slash-skill-vibe-coder')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('slash-skill-spacemit-power/markdown-maker')).not.toBeInTheDocument())
  })
  it('skills 通配符只覆盖普通技能，插件技能仍可临时添加', async () => {
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_agents_list') return [
        { id: 'real-agent', name: '助手', available: true, skills: ['*'] },
      ]
      if (name === 'runtime_skills_list') return [
        { id: 'summarize', name: 'summarize', display_name: '文档总结', description: '整理文档要点', enabled: true, assignable: true },
        { id: 'spacemit-power/markdown-maker', name: 'markdown-maker', display_name: 'PDF 转 Markdown', description: '把 PDF 转成 Markdown', origin: 'plugin', plugin_id: 'spacemit-power', enabled: true, assignable: true },
      ]
      return { targetId: 'target-a', runtimeEpoch: 'e1' }
    })
    const onSubmit = vi.fn(); promptState = '/'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    // 普通技能全开 → 隐藏；插件没被选中 → 该插件技能其实没在跑，仍然可选。
    expect(await screen.findByTestId('slash-skill-spacemit-power/markdown-maker')).toBeInTheDocument()
    expect(screen.queryByTestId('slash-skill-summarize')).not.toBeInTheDocument()
  })
  it('plugins 通配符只覆盖插件技能，普通技能仍可临时添加', async () => {
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_agents_list') return [
        { id: 'real-agent', name: '助手', available: true, plugins: ['*'] },
      ]
      if (name === 'runtime_skills_list') return [
        { id: 'summarize', name: 'summarize', display_name: '文档总结', description: '整理文档要点', enabled: true, assignable: true },
        { id: 'spacemit-power/markdown-maker', name: 'markdown-maker', display_name: 'PDF 转 Markdown', description: '把 PDF 转成 Markdown', origin: 'plugin', plugin_id: 'spacemit-power', enabled: true, assignable: true },
      ]
      return { targetId: 'target-a', runtimeEpoch: 'e1' }
    })
    const onSubmit = vi.fn(); promptState = '/'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    expect(await screen.findByTestId('slash-skill-summarize')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('slash-skill-spacemit-power/markdown-maker')).not.toBeInTheDocument())
  })
  it('只有描述命中时才补一行描述解释', async () => {
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_agents_list') return []
      if (name === 'runtime_skills_list') return [
        { id: 'summarize', name: 'summarize', display_name: '文档总结', description: '整理文档要点', enabled: true, assignable: true },
        { id: 'review', name: 'review', display_name: '代码审查', description: '总结代码问题', enabled: true, assignable: true },
      ]
      return { targetId: 'target-a', runtimeEpoch: 'e1' }
    })
    const onSubmit = vi.fn(); promptState = '/总结'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(3, 3); fireEvent.select(getTextarea())
    const nameHit = await screen.findByTestId('slash-skill-summarize')
    const descriptionHit = screen.getByTestId('slash-skill-review')
    expect(nameHit.textContent).not.toContain('整理文档要点')
    expect(descriptionHit).toHaveTextContent('总结代码问题')
  })
  it('菜单打开时 /skills 就是普通技能查询，别名只在菜单关掉后生效', async () => {
    // 菜单里已经没有命令项：/skills 命中的技能会被选中，而不是被当成"完整命令"
    // 去抢 Enter。手打 /skills 仍能打开选择器，但要先让菜单让位（见下一条）。
    agentApi.invoke.mockImplementation(async name => name === 'runtime_skills_list'
      ? [{ ...skills[0], description: 'Create skills' }] : undefined)
    const onSubmit = vi.fn(); promptState = '/skills'
    renderInput({ onSubmit })
    getTextarea().setSelectionRange(7, 7); fireEvent.select(getTextarea())
    await screen.findByTestId('slash-skill-s1')
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(screen.getByTestId('skill-chip-s1')).toBeInTheDocument()
    expect(screen.queryByTestId('skill-picker-search')).not.toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
  it('/vi 把名字命中的技能排在只命中描述的技能前面', async () => {
    // 本机目录里 /vi 会命中一打"描述里恰好带 vi"的技能，vibe-coder 以前排在最后，
    // 用户只能多打一个字母用 /vib 找它。
    agentApi.invoke.mockImplementation(async (name: string) => name === 'runtime_skills_list' ? [
      { id: 'frontend-design', name: 'frontend-design', display_name: 'frontend-design', description: 'Visual design guidance.', enabled: true, assignable: true },
      { id: 'receiving-code-review', name: 'receiving-code-review', display_name: 'receiving-code-review', description: 'Use when receiving review feedback.', enabled: true, assignable: true },
      { id: 'vibe-coder', name: 'vibe-coder', display_name: 'vibe-coder', description: 'Offline native HTML/CSS/JS applications.', enabled: true, assignable: true },
    ] : undefined)
    promptState = '/vi'
    renderInput({ onSubmit: vi.fn() })
    getTextarea().setSelectionRange(3, 3); fireEvent.select(getTextarea())
    const menu = await screen.findByTestId('slash-menu')
    const options = await within(menu).findAllByTestId(/^slash-skill-/)
    expect(options.map(option => option.getAttribute('data-testid'))).toEqual([
      'slash-skill-vibe-coder',
      'slash-skill-receiving-code-review',
      'slash-skill-frontend-design',
    ])
    expect(options[0].getAttribute('data-active')).toBe('true')
  })
  it('「临时使用技能」只列出这个专家还没有的技能', async () => {
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_target_identity') return { targetId: 'target-a', runtimeEpoch: 'epoch-1' }
      if (name === 'runtime_agents_list') return [{ id: 'writer', name: 'writer', available: true, skills: ['s1'] }]
      if (name === 'runtime_skills_list') return skills
      return undefined
    })
    promptState = '/'
    renderInput({ onSubmit: vi.fn() })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    expect(await screen.findByTestId('slash-skill-s2')).toBeInTheDocument()
    // s1 已经在这个专家的 selectors 里：临时再选一次不可能生效，不该出现在候选里。
    await waitFor(() => expect(screen.queryByTestId('slash-skill-s1')).not.toBeInTheDocument())
  })
  it('专家已启用全部技能时不提供临时技能候选', async () => {
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_target_identity') return { targetId: 'target-a', runtimeEpoch: 'epoch-1' }
      if (name === 'runtime_agents_list') return [{ id: 'writer', name: 'writer', available: true, skills: ['*'] }]
      if (name === 'runtime_skills_list') return skills
      return undefined
    })
    promptState = '/'
    renderInput({ onSubmit: vi.fn() })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    expect(await screen.findByText('No matching skills')).toBeInTheDocument()
    expect(screen.queryByTestId('slash-skill-s1')).not.toBeInTheDocument()
  })
  it('预设技能不出现在临时技能候选里', async () => {
    agentApi.invoke.mockImplementation(async (name: string) => {
      if (name === 'runtime_target_identity') return { targetId: 'target-a', runtimeEpoch: 'epoch-1' }
      if (name === 'runtime_agents_list') return [{ id: 'writer', name: 'writer', available: true, skills: [] }]
      if (name === 'runtime_skills_list') return [{ ...skills[0], preset: true }, skills[1]]
      return undefined
    })
    promptState = '/'
    renderInput({ onSubmit: vi.fn() })
    getTextarea().setSelectionRange(1, 1); fireEvent.select(getTextarea())
    expect(await screen.findByTestId('slash-skill-s2')).toBeInTheDocument()
    // preset 技能对每个专家都固定启用，选它不会改变任何东西。
    await waitFor(() => expect(screen.queryByTestId('slash-skill-s1')).not.toBeInTheDocument())
  })
  it('组合态 Enter 不选技能，重复添加不取消，重开刷新目录', async () => {
    const user = userEvent.setup(); renderInput({ onSubmit: vi.fn() })
    await user.click(screen.getByTestId('skill-picker-trigger'))
    const item = await screen.findByTestId('skill-picker-item-s1')
    fireEvent.keyDown(screen.getByTestId('skill-picker-search'), { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(screen.queryByTestId('skill-chip-s1')).not.toBeInTheDocument()
    await user.click(item); await user.click(item)
    expect(screen.getByTestId('skill-chip-s1')).toBeInTheDocument()
    const calls = agentApi.invoke.mock.calls.filter(c => c[0] === 'runtime_skills_list').length
    await user.click(screen.getByTestId('skill-picker-trigger')); await user.click(screen.getByTestId('skill-picker-trigger'))
    await waitFor(() => expect(agentApi.invoke.mock.calls.filter(c => c[0] === 'runtime_skills_list').length).toBeGreaterThan(calls))
  })
  it('回执只消费提交时的技能，保留等待期间新增的选择', async () => {
    let complete!: () => void
    const onSubmit = vi.fn(() => new Promise<void>(resolve => { complete = resolve }))
    const user = userEvent.setup(); const view = renderInput({ onSubmit })
    await user.click(screen.getByTestId('skill-picker-trigger')); await user.click(await screen.findByTestId('skill-picker-item-s1'))
    await user.click(screen.getByTestId('skill-picker-trigger'))
    promptState = '第一条'; view.rerender(<ChatInput onSubmit={onSubmit} />); fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('第一条', undefined, ['s1'], false)
    promptState = '第二条'; view.rerender(<ChatInput onSubmit={onSubmit} />)
    await user.click(screen.getByTestId('skill-picker-trigger')); await user.click(await screen.findByTestId('skill-picker-item-s2'))
    await act(async () => complete())
    expect(screen.queryByTestId('skill-chip-s1')).not.toBeInTheDocument()
    expect(screen.getByTestId('skill-chip-s2')).toBeInTheDocument()
    expect(promptState).toBe('第二条')
  })
  it('未知回执重试只消费实际接受的技能，不消费未提交的新选择', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ skillIds: ['s1'] })
    const user = userEvent.setup(); const view = renderInput({ onSubmit })
    await user.click(screen.getByTestId('skill-picker-trigger')); await user.click(await screen.findByTestId('skill-picker-item-s2'))
    await user.click(screen.getByTestId('skill-picker-trigger'))
    promptState = '重试原消息'; view.rerender(<ChatInput onSubmit={onSubmit} />)
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('重试原消息', undefined, ['s2'], false))
    expect(screen.getByTestId('skill-chip-s2')).toBeInTheDocument()
  })
  it('发送失败后保留技能但清空正文（方案A：不回填）', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('未接收'))
    const user = userEvent.setup(); const view = renderInput({ onSubmit })
    await user.click(screen.getByTestId('skill-picker-trigger')); await user.click(await screen.findByTestId('skill-picker-item-s1'))
    await user.click(screen.getByTestId('skill-picker-trigger'))
    promptState = '重试正文'; view.rerender(<ChatInput onSubmit={onSubmit} />); fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    // 方案A：技能仅在成功时消费，故失败保留；正文发送即清空且不回填。
    expect(screen.getByTestId('skill-chip-s1')).toBeInTheDocument()
    expect(promptState).toBe('')
  })
})

describe('Runtime Console input behavior parity', () => {
  beforeEach(() => { resetAll(); currentThreadId = 'thread-1'; runtimeEnabled = true; sessionEvents = true })
  it('submits attachment-only input with the Runtime default prompt', () => {
    attachmentsList = [{ type: 'document', mimeType: 'text/plain', resourceId: 'r', resourceUrl: '/resources/r' }]
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('Please process the attached files.', [expect.objectContaining({ resourceId: 'r' })], undefined, false)
  })
  it('opens the skill picker for /skills after Escape closes suggestions', async () => {
    skillSelection = true; promptState = '/skills'
    agentApi.invoke.mockImplementation(async name => name === 'runtime_skills_list' ? [] : undefined)
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Escape' })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(await screen.findByTestId('skill-picker-search')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('ChatInput 浮窗键盘焦点', () => {
  beforeEach(() => {
    resetAll()
    useVoiceInputStore.setState({ mode: 'voice', phase: 'idle' })
  })

  it('浮窗切到键盘模式时把 DOM 焦点交给输入框', async () => {
    renderInput({ surface: 'overlay' })
    const ta = getTextarea()
    ta.blur()
    act(() => useVoiceInputStore.setState({ mode: 'keyboard' }))
    await waitFor(() => expect(document.activeElement).toBe(ta))
  })

  it('主窗口不跟随浮窗输入模式抢焦点', async () => {
    renderInput({ surface: 'main' })
    const ta = getTextarea()
    ta.blur()
    act(() => useVoiceInputStore.setState({ mode: 'keyboard' }))
    await waitFor(() => expect(document.activeElement).not.toBe(ta))
  })
})

// 技能名随界面语言：v2 展示字段必须真的接到面板、`/` 菜单和 chips 上。
describe('ChatInput 技能名随界面语言', () => {
  const skills = [
    {
      id: 'using-apm',
      name: 'using-apm',
      display_name: 'using-apm',
      description: 'Manage Powers with APM.',
      name_zh: 'APM 使用手册',
      name_en: 'APM Agent Handbook',
      description_zh: '使用 APM 管理 Power 资源。',
      enabled: true,
      assignable: true,
    },
    {
      id: 'no-english-description',
      name: 'no-english-description',
      display_name: '无英文描述',
      // 模型侧 description 为空、只有中文描述：命中说明仍必须给出来。
      description: '',
      description_zh: '只有中文描述',
      enabled: true,
      assignable: true,
    },
  ]
  const page = () => (
    <TranslationProvider>
      <ChatInput onSubmit={vi.fn()} />
    </TranslationProvider>
  )

  beforeEach(() => {
    resetAll()
    currentThreadId = 'thread-1'
    runtimeEnabled = true
    sessionEvents = true
    skillSelection = true
    agentApi.invoke.mockImplementation(async name =>
      name === 'runtime_skills_list' ? skills : undefined)
  })

  it('切换语言后面板、chip 与 / 菜单一起换名', async () => {
    const user = userEvent.setup()
    const view = render(page())

    await user.click(await screen.findByTestId('skill-picker-trigger'))
    const item = await screen.findByTestId('skill-picker-item-using-apm')
    expect(item).toHaveTextContent('APM 使用手册')
    await user.click(item)
    expect(screen.getByTestId('skill-chip-using-apm')).toHaveTextContent('APM 使用手册')

    languageOverride = 'en'
    view.rerender(page())
    await waitFor(() =>
      expect(screen.getByTestId('skill-chip-using-apm')).toHaveTextContent('APM Agent Handbook'))
    expect(screen.getByTestId('skill-picker-item-using-apm')).toHaveTextContent('APM Agent Handbook')

    promptState = '/'
    view.rerender(page())
    getTextarea().setSelectionRange(1, 1)
    fireEvent.select(getTextarea())
    await waitFor(() =>
      expect(screen.getByTestId('slash-skill-using-apm')).toHaveTextContent('APM Agent Handbook'))
  })

  it('模型侧描述为空、只有中文描述时，面板仍给出命中理由', async () => {
    const user = userEvent.setup()
    render(page())
    await user.click(await screen.findByTestId('skill-picker-trigger'))
    await user.type(screen.getByTestId('skill-picker-search'), '只有中文描述')
    const item = await screen.findByTestId('skill-picker-item-no-english-description')
    expect(item).toHaveTextContent('只有中文描述')
  })
})
