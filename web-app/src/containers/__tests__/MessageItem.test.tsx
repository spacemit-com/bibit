import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import '@testing-library/jest-dom'

// ---- Module mocks ----------------------------------------------------------
const realCards = vi.hoisted(() => ({ enabled: false }))
beforeEach(() => { realCards.enabled = false })
const skillApi = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: skillApi.invoke }))
const selectedModelRef = vi.hoisted(() => ({ current: { id: 'm1' } as any }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: any) =>
    selector({ selectedModel: selectedModelRef.current }),
}))

// Stub heavy children: RenderMarkdown. Reasoning and body both render through
// it now, so the stub splits them by testid — `render-markdown` stays the body
// selector and reasoning gets its own — and surfaces softBreaks/className for
// the wiring assertions.
vi.mock('../RenderMarkdown', () => ({
  RenderMarkdown: ({ content, softBreaks, className }: any) => (
    <div
      data-testid={softBreaks ? 'reasoning-markdown' : 'render-markdown'}
      data-soft-breaks={softBreaks ? 'true' : 'false'}
      className={className}
    >
      {content}
    </div>
  ),
}))

// Stub streamdown
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: any) => <div data-testid="streamdown">{children}</div>,
}))

// Stub ChainOfThought
vi.mock('@/components/ai-elements/chain-of-thought', async () => {
  const actual = await vi.importActual<any>('@/components/ai-elements/chain-of-thought')
  const mocks = {
  ChainOfThought: ({ children, forceOpen, shouldCollapse, defaultOpen, isStreaming }: any) => (
    <div
      data-testid="cot"
      data-streaming={String(Boolean(isStreaming))}
      data-force-open={String(Boolean(forceOpen))}
      data-should-collapse={String(shouldCollapse ?? 'undefined')}
      data-default-open={String(defaultOpen)}
    >
      {children}
    </div>
  ),
  ChainOfThoughtContent: ({ children }: any) => <div>{children}</div>,
  ChainOfThoughtHeader: () => <div>CoT Header</div>,
  }
  return Object.fromEntries(Object.entries(mocks).map(([name, component]) => [name, (props: any) => createElement(realCards.enabled ? actual[name] : component, props)]))
})

vi.mock('@/components/RuntimeEventPart', async () => {
  const actual = await vi.importActual<any>('@/components/RuntimeEventPart')
  return { RuntimeEventPart: (props: any) => realCards.enabled ? <actual.RuntimeEventPart {...props} /> : (
    <div data-testid="runtime-event-part" data-type={props.part.type} />
  ) }
})

// Stub Tool
vi.mock('@/components/ai-elements/tool', async () => {
  const actual = await vi.importActual<any>('@/components/ai-elements/tool')
  const mocks = {
  Tool: ({ children }: any) => <div data-testid="tool">{children}</div>,
  ToolContent: ({ children }: any) => <div>{children}</div>,
  ToolHeader: ({ title }: any) => <div data-testid="tool-header">{title}</div>,
  ToolInput: ({ input }: any) => <div data-testid="tool-input">{String(input)}</div>,
  ToolOutput: ({ output, errorText }: any) => (
    <div data-testid="tool-output">{errorText ?? String(output ?? '')}</div>
  ),
  ToolApprovalActions: () => null,
  }
  return Object.fromEntries(Object.entries(mocks).map(([name, component]) => [name, (props: any) => createElement(realCards.enabled ? actual[name] : component, props)]))
})

// Stub dialogs
const editOnSaveRef = vi.hoisted(() => ({ current: null as any }))
const realEditDialog = vi.hoisted(() => ({ enabled: false }))
vi.mock('@/containers/dialogs/EditMessageDialog', async () => {
 const actual = await vi.importActual<any>('@/containers/dialogs/EditMessageDialog')
 return { EditMessageDialog: (props: any) => {
    if (realEditDialog.enabled) return <actual.EditMessageDialog {...props} />
    const { onSave, message } = props
    editOnSaveRef.current = onSave
    return (
      <button data-testid="edit-btn" onClick={() => onSave('edited: ' + message)}>
        Edit
      </button>
    )
  }}
})

vi.mock('@/containers/dialogs/DeleteMessageDialog', () => ({
  DeleteMessageDialog: ({ onDelete }: any) => (
    <button data-testid="delete-btn" onClick={onDelete}>
      Delete
    </button>
  ),
}))

vi.mock('@/containers/TokenSpeedIndicator', () => ({
  default: ({ streaming }: any) => (
    <div data-testid="token-speed" data-streaming={String(streaming)} />
  ),
}))

vi.mock('../CopyButton', () => ({
  CopyButton: ({ text }: any) => (
    <button data-testid="copy-btn" data-text={text}>
      Copy
    </button>
  ),
}))

vi.mock('@/utils/formatDate', () => ({
  formatDate: () => '2024-01-01',
}))

vi.mock('@/lib/fileMetadata', async () => ({
  ...await vi.importActual<any>('@/lib/fileMetadata'),
  extractFilesFromPrompt: (text: string) => {
    if (text?.startsWith('[FILE:')) {
      return {
        cleanPrompt: text.replace(/\[FILE:[^\]]+\]/g, '').trim(),
        files: [{ id: 'f1', name: 'doc.txt', injectionMode: 'inline' }],
      }
    }
    return { cleanPrompt: text ?? '', files: [] }
  },
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...rest }: any) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/PromptProgress', () => ({
  PromptProgress: () => <div data-testid="prompt-progress" />,
}))

const pendingApprovalsRef = vi.hoisted(() => ({ current: {} as any }))
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: (selector: any) =>
    selector({ pending: pendingApprovalsRef.current }),
}))

// Import after mocks
import { MessageItem } from '../MessageItem'
import { useConversationCardState } from '@/stores/conversation-card-state'
import { resetSharedSkillCatalog } from '@/hooks/useRuntimeSkills'
import i18n from '@/i18n/setup'

it('真实折叠组件：组卡默认关闭，组内条目各自开合并跨增量、完成及父消息重挂保持', async () => {
  realCards.enabled = true
  useConversationCardState.setState({ opened: [] })
  const { projectSessionEvents, sessionMessageToUIMessage } = await import('@/lib/runtime-session-projection')
  const identity = { targetId: 'a', runtimeId: 'bianbu' as const, sessionId: 's', runtimeEpoch: 'e' }
  const events = [
    { seq: 10, time: 10, run_id: 'r', type: 'assistant/reasoning.delta', data: { text: '思考一' } },
    { seq: 11, time: 11, run_id: 'r', type: 'tool/call.started', data: { call_id: 't', name: 'read', arguments: { path: '/tmp/file' } } },
    { seq: 12, time: 12, run_id: 'r', type: 'assistant/reasoning.delta', data: { text: '思考二' } },
  ] as any[]
  const message = () => {
    const ui = sessionMessageToUIMessage(projectSessionEvents(events, [], identity).messages[0], undefined, identity)
    return { ...ui, metadata: { ...ui.metadata as object, sessionFeed: true } }
  }
  const view = render(<MessageItem message={message()} isFirstMessage isLastMessage status="streaming" hideActions />)

  const groupHeader = screen.getByTestId('trace-group-header')
  expect(groupHeader).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByTestId('session-reasoning-card')).not.toBeInTheDocument()
  expect(screen.queryByTestId('session-tool-card')).not.toBeInTheDocument()
  fireEvent.click(groupHeader)

  const thoughts = screen.getAllByTestId('session-reasoning-card')
  const tool = screen.getByTestId('session-tool-card')
  expect(thoughts).toHaveLength(2)
  expect(thoughts[0].parentElement).toBe(thoughts[1].parentElement)
  expect(thoughts[0].parentElement).toBe(tool.parentElement)
  expect(thoughts[1].parentElement).toBe(tool.parentElement)
  expect(thoughts[0]).not.toContainElement(tool)
  for (const card of [...thoughts, tool]) expect(within(card).getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('思考一')).not.toBeInTheDocument()
  fireEvent.click(within(thoughts[0]).getByRole('button'))
  fireEvent.click(within(tool).getByRole('button'))
  events.push({ seq: 13, time: 13, run_id: 'r', type: 'tool/call.progress', data: { call_id: 't', content: '真实进度' } })
  view.rerender(<MessageItem message={message()} isFirstMessage isLastMessage status="streaming" hideActions />)
  expect(screen.getByText('真实进度')).toBeInTheDocument()
  expect(within(screen.getByTestId('session-tool-card')).getByRole('button', { name: /read/i })).toHaveAttribute('aria-expanded', 'true')
  events.unshift({ seq: 9, time: 9, run_id: 'r', type: 'assistant/reasoning.delta', data: { text: '前缀' } })
  events.push({ seq: 14, time: 14, run_id: 'r', type: 'tool/call.completed', data: { call_id: 't', result: '最终结果' } })
  view.rerender(<MessageItem key="remount" message={message()} isFirstMessage isLastMessage status="ready" hideActions />)
  expect(screen.getByTestId('trace-group-header')).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('前缀思考一')).toBeInTheDocument()
  expect(screen.getByText('最终结果')).toBeInTheDocument()
  // Independent thought scrollers must not steal an upward reading position.
  const lastThought = screen.getAllByTestId('session-reasoning-card')[1]
  fireEvent.click(within(lastThought).getByRole('button'))
  const scroller = lastThought.querySelector('.overflow-auto') as HTMLDivElement
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
  scroller.scrollTop = 100
  fireEvent.scroll(scroller)
  events.push({ seq: 16, time: 16, run_id: 'r', type: 'assistant/reasoning.delta', data: { text: '持续思考' } })
  view.rerender(<MessageItem key="remount" message={message()} isFirstMessage isLastMessage status="streaming" hideActions />)
  expect(scroller.scrollTop).toBe(100)
  fireEvent.click(within(lastThought).getByRole('button', { name: /Jump to latest/i }))
  expect(scroller.scrollTop).toBe(1000)
  const toolToggle = within(screen.getByTestId('session-tool-card')).getByRole('button', { name: /read/i })
  fireEvent.click(toolToggle)
  events.push({ seq: 15, time: 15, run_id: 'r', type: 'run/completed', data: {} })
  view.rerender(<MessageItem key="remount" message={message()} isFirstMessage isLastMessage status="ready" hideActions />)
  expect(toolToggle).toHaveAttribute('aria-expanded', 'false')
  events.push({ seq: 17, time: 17, run_id: 'r', type: 'approval/requested', data: { approval_id: 'a', title: '审批动作' } })
  view.rerender(<MessageItem key="remount" message={message()} isFirstMessage isLastMessage status="ready" hideActions />)
  const approval = screen.getByTestId('runtime-permission')
  expect(approval.parentElement).toBe(screen.getByTestId('session-tool-card').parentElement)
  for (const thought of screen.getAllByTestId('session-reasoning-card')) expect(thought).not.toContainElement(approval)
})

it('真实思考卡片增量更新不抢独立阅读位置，点击回到底部后继续跟随', async () => {
  realCards.enabled = true
  useConversationCardState.setState({ opened: [] })
  const { projectSessionEvents, sessionMessageToUIMessage } = await import('@/lib/runtime-session-projection')
  const identity = { targetId: 'scroll', runtimeId: 'bianbu' as const, sessionId: 's', runtimeEpoch: 'e' }
  const events = [{ seq: 1, time: 1, run_id: 'r', type: 'assistant/reasoning.delta', data: { text: '第一段' } }]
  const message = () => {
    const ui = sessionMessageToUIMessage(projectSessionEvents(events, [], identity).messages[0], undefined, identity)
    return { ...ui, metadata: { ...ui.metadata as object, sessionFeed: true } }
  }
  const view = render(<MessageItem message={message()} isFirstMessage isLastMessage status="streaming" hideActions />)
  const thinking = screen.getByRole('button', { name: /Thinking/ })
  expect(thinking.querySelectorAll('svg')).toHaveLength(2)
  expect(thinking).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(thinking)
  const scroller = screen.getByTestId('session-reasoning-card').querySelector('.overflow-auto') as HTMLDivElement
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
  scroller.scrollTop = 100
  fireEvent.scroll(scroller)
  events.push({ seq: 2, time: 2, run_id: 'r', type: 'assistant/reasoning.delta', data: { text: '第二段' } })
  view.rerender(<MessageItem message={message()} isFirstMessage isLastMessage status="streaming" hideActions />)
  expect(screen.getByText('第一段第二段')).toBeInTheDocument()
  expect(scroller.scrollTop).toBe(100)
  fireEvent.click(screen.getByRole('button', { name: /Jump to latest/i }))
  expect(scroller.scrollTop).toBe(1000)
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 })
  events.push({ seq: 3, time: 3, run_id: 'r', type: 'assistant/reasoning.delta', data: { text: '第三段' } })
  view.rerender(<MessageItem message={message()} isFirstMessage isLastMessage status="streaming" hideActions />)
  expect(scroller.scrollTop).toBe(1200)
})

const makeMsg = (overrides: any = {}) => ({
  id: 'msg-1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Hello assistant' }],
  metadata: { createdAt: new Date() },
  ...overrides,
})

describe('MessageItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 引用技能标签会按目录换名字：默认让目录不可用，用例再按需给结果。
    skillApi.invoke.mockReset().mockRejectedValue(new Error('Runtime 不可用'))
    resetSharedSkillCatalog()
    selectedModelRef.current = { id: 'm1' }
    pendingApprovalsRef.current = {}
  })

  it('消息根节点标记 data-message-role，浮窗的助手气泡样式靠它挂钩', () => {
    const assistant = render(
      <MessageItem message={makeMsg()} isFirstMessage isLastMessage status="ready" hideActions />
    )
    expect(assistant.container.firstElementChild).toHaveAttribute('data-message-role', 'assistant')

    const user = render(
      <MessageItem
        message={makeMsg({ id: 'msg-user', role: 'user', parts: [{ type: 'text', text: 'hi' }] })}
        isFirstMessage
        isLastMessage
        status="ready"
        hideActions
      />
    )
    expect(user.container.firstElementChild).toHaveAttribute('data-message-role', 'user')
  })

  it('回答引用展示名称、真实片段和安全链接，不显示内部 ID 或相似度', () => {
    render(<MessageItem message={makeMsg({ metadata: { knowledgeContext: {
      status: 'succeeded',
      chunks: [{ id: 'c', documentName: 'K3.md', content: '实际参考片段：支持 USB', similarity: 0.9, url: 'javascript:alert(1)' }],
    } } }) as any} isFirstMessage isLastMessage status="ready" />)
    expect(screen.getByText(/进迭社区知识库 · 1 references/)).toBeInTheDocument()
    expect(screen.getByText('实际参考片段：支持 USB')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByText(/internal-id|相似度/)).not.toBeInTheDocument()
    const summary = screen.getByText(/进迭社区知识库 · 1 references/)
    fireEvent.click(summary)
    expect(summary.closest('details')).toHaveAttribute('open')
  })

  it('renders assistant text via RenderMarkdown', () => {
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('render-markdown')).toHaveTextContent('Hello assistant')
  })

  it('用户消息展示本次引用的技能，超过四个折叠为 +N', () => {
    render(
      <MessageItem
        message={makeMsg({
          role: 'user',
          parts: [{ type: 'text', text: '审查这段代码' }],
          metadata: {
            citedSkillIds: [
              'bianbu.audit/audit-guide',
              'spacemit-power/markdown-maker',
              'riscv-porter',
              'a/b',
              'c/d',
              'e/f',
            ],
          },
        }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('cited-skill-chip-bianbu.audit/audit-guide')).toHaveTextContent('bianbu.audit:audit-guide')
    expect(screen.getByTestId('cited-skill-chip-riscv-porter')).toHaveTextContent('riscv-porter')
    // 第五个起折叠，不直接把名字铺出来。
    expect(screen.queryByTestId('cited-skill-chip-c/d')).not.toBeInTheDocument()
    expect(screen.getByTestId('cited-skill-overflow')).toHaveTextContent('+2')
    expect(screen.getByTestId('cited-skill-overflow')).toHaveAttribute('title', 'c:d、e:f')
  })

  it('引用技能按目录里的名字显示（跟随界面语言），目录不可用时退回 id 标签', async () => {
    const language = i18n.language
    i18n.changeLanguage('zh-CN')
    try {
      skillApi.invoke.mockResolvedValue([
        {
          id: 'using-apm',
          name: 'using-apm',
          display_name: 'using-apm',
          description: 'Manage Powers with APM.',
          name_zh: 'APM 使用手册',
          name_en: 'APM Agent Handbook',
          version: '1.0.0',
          origin: 'standalone',
          plugin_id: null,
          enabled: true,
          assignable: true,
        },
      ])
      const view = render(
        <MessageItem
          message={makeMsg({
            role: 'user',
            parts: [{ type: 'text', text: '看下 APM' }],
            metadata: { createdAt: new Date(), citedSkillIds: ['using-apm', 'not-in-catalog'] },
          }) as any}
          isFirstMessage
          isLastMessage
          status={'ready' as any}
        />
      )
      await waitFor(() =>
        expect(screen.getByTestId('cited-skill-chip-using-apm')).toHaveTextContent('APM 使用手册'))
      // 目录里没有的技能保持原有 id 标签，不显示空白。
      expect(screen.getByTestId('cited-skill-chip-not-in-catalog')).toHaveTextContent('not-in-catalog')

      // 目录只在同一 Runtime 代次里拉一次，多条消息不会各拉一遍。
      view.rerender(
        <MessageItem
          message={makeMsg({
            id: 'msg-2',
            role: 'user',
            parts: [{ type: 'text', text: '再看一次' }],
            metadata: { createdAt: new Date(), citedSkillIds: ['using-apm'] },
          }) as any}
          isFirstMessage={false}
          isLastMessage
          status={'ready' as any}
        />
      )
      await waitFor(() =>
        expect(screen.getByTestId('cited-skill-chip-using-apm')).toHaveTextContent('APM 使用手册'))
      expect(skillApi.invoke.mock.calls.filter(([name]) => name === 'runtime_skills_list')).toHaveLength(1)
    } finally {
      i18n.changeLanguage(language)
    }
  })

  it('没有引用技能的消息不渲染技能区，助手消息也不渲染', () => {
    const view = render(
      <MessageItem
        message={makeMsg({ role: 'user', parts: [{ type: 'text', text: '你好' }] }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.queryByTestId('cited-skill-chips')).not.toBeInTheDocument()
    view.rerender(
      <MessageItem
        message={makeMsg({ metadata: { citedSkillIds: ['bianbu.audit/audit-guide'] } }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.queryByTestId('cited-skill-chips')).not.toBeInTheDocument()
  })

  it('renders user message in a bubble (no markdown renderer)', () => {
    render(
      <MessageItem
        message={makeMsg({ role: 'user', parts: [{ type: 'text', text: 'Hi there' }] }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByText('Hi there')).toBeInTheDocument()
    expect(screen.queryByTestId('render-markdown')).not.toBeInTheDocument()
  })

  it('renders attached files from user text metadata', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            role: 'user',
            parts: [{ type: 'text', text: '[FILE:doc.txt] Please summarize' }],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByText('doc.txt')).toBeInTheDocument()
    expect(screen.getByText('(inline)')).toBeInTheDocument()
  })

  it('fires onRegenerate when regenerate button clicked (assistant, last)', () => {
    const onRegenerate = vi.fn()
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onRegenerate={onRegenerate}
      />
    )
    const regenBtn = screen.getByTitle('Regenerate response')
    fireEvent.click(regenBtn)
    expect(onRegenerate).toHaveBeenCalledWith('msg-1')
  })

  it('does not render regenerate button when not last message', () => {
    const onRegenerate = vi.fn()
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage={false}
        status={'ready' as any}
        onRegenerate={onRegenerate}
      />
    )
    expect(screen.queryByTitle('Regenerate response')).not.toBeInTheDocument()
  })

  it('shows Continue button on a stopped last assistant message', () => {
    const onContinue = vi.fn()
    render(
      <MessageItem
        message={
          makeMsg({ metadata: { createdAt: new Date(), stopped: true } }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onContinue={onContinue}
      />
    )
    const btn = screen.getByTitle('Continue generating')
    fireEvent.click(btn)
    expect(onContinue).toHaveBeenCalledWith('msg-1')
  })

  it('hides Continue button when the turn finished normally', () => {
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onContinue={vi.fn()}
      />
    )
    expect(screen.queryByTitle('Continue generating')).not.toBeInTheDocument()
  })

  it('hides Continue button on a stopped message that is not last', () => {
    render(
      <MessageItem
        message={
          makeMsg({ metadata: { createdAt: new Date(), stopped: true } }) as any
        }
        isFirstMessage
        isLastMessage={false}
        status={'ready' as any}
        onContinue={vi.fn()}
      />
    )
    expect(screen.queryByTitle('Continue generating')).not.toBeInTheDocument()
  })

  it('fires onEdit when edit dialog saves', () => {
    const onEdit = vi.fn()
    render(
      <MessageItem
        message={
          makeMsg({ role: 'user', parts: [{ type: 'text', text: 'original' }] }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onEdit={onEdit}
      />
    )
    fireEvent.click(screen.getByTestId('edit-btn'))
    expect(onEdit).toHaveBeenCalledWith('msg-1', expect.stringContaining('original'))
  })

  it('fires onDelete when delete dialog button clicked', () => {
    const onDelete = vi.fn()
    render(
      <MessageItem
        message={
          makeMsg({ role: 'user', parts: [{ type: 'text', text: 'x' }] }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onDelete={onDelete}
      />
    )
    fireEvent.click(screen.getByTestId('delete-btn'))
    expect(onDelete).toHaveBeenCalledWith('msg-1')
  })

  it('hides actions when hideActions is set', () => {
    render(
      <MessageItem
        message={
          makeMsg({ role: 'user', parts: [{ type: 'text', text: 'x' }] }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        hideActions
      />
    )
    expect(screen.queryByTestId('edit-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delete-btn')).not.toBeInTheDocument()
  })

  it('streaming state hides edit/delete and marks token speed streaming', () => {
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage
        status={'streaming' as any}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.queryByTestId('edit-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delete-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('token-speed').getAttribute('data-streaming')).toBe('true')
  })

  it('renders user image attachment', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'image/png',
                url: 'blob:foo',
                filename: 'pic.png',
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    const img = screen.getByAltText('pic.png') as HTMLImageElement
    expect(img.src).toContain('blob:foo')
  })

  it('renders a CoT block containing reasoning', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'reasoning', text: 'thinking...' },
              { type: 'text', text: 'final' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('cot')).toBeInTheDocument()
    expect(screen.getByText('thinking...')).toBeInTheDocument()
  })

  it('renders reasoning through the markdown pipeline with soft breaks', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'reasoning', text: '## Plan\nstep one' },
              { type: 'text', text: 'final' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    // The reasoning card and the answer body both go through RenderMarkdown;
    // the reasoning one opts into soft breaks and the scoped-down heading sizes.
    const cot = screen.getByTestId('reasoning-markdown')
    expect(cot).toHaveTextContent('## Plan')
    expect(cot.className).toContain('cot-markdown')

    const body = screen.getByTestId('render-markdown')
    expect(body).toHaveAttribute('data-soft-breaks', 'false')
    expect(body).toHaveTextContent('final')
  })

  it('renders a tool-only work turn inside one thinking timeline', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-search', state: 'output-available', input: { q: 'x' }, output: 'ok' },
              { type: 'text', text: 'done' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('tool')).toBeInTheDocument()
    expect(screen.getByTestId('tool-header')).toHaveTextContent('search')
    expect(screen.getByTestId('cot')).toContainElement(screen.getByTestId('tool'))
  })

  it('renders runtime tool and permission parts inside one thinking timeline', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'data-runtime-tool',
                data: {
                  toolCallId: 'rt-1',
                  name: 'web_search',
                  status: 'completed',
                  result: { count: 3 },
                },
              },
              {
                type: 'data-runtime-permission',
                data: {
                  requestId: 'rp-1',
                  toolCallId: 'rt-2',
                  title: '允许搜索',
                  description: 'Hermes 请求执行 web_search',
                  toolName: 'web_search',
                  canAllowOnce: true,
                  canDeny: true,
                  status: 'pending',
                },
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )

    expect(screen.getAllByTestId('cot')).toHaveLength(1)
    const cot = screen.getByTestId('cot')
    expect(screen.getAllByTestId('runtime-event-part')).toHaveLength(2)
    for (const part of screen.getAllByTestId('runtime-event-part')) {
      expect(cot).toContainElement(part)
    }
    expect(
      screen
        .getAllByTestId('runtime-event-part')
        .map((part) => part.getAttribute('data-type'))
    ).toEqual(['data-runtime-tool', 'data-runtime-permission'])
  })

  it('keeps reasoning before and after a runtime tool in one card while answers stay below', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'reasoning', text: '## Before\n分析参数' },
              { type: 'text', text: '我先执行命令。' },
              {
                type: 'data-runtime-tool',
                id: 'tool-1',
                data: {
                  toolCallId: 'tool-1',
                  name: 'terminal',
                  status: 'completed',
                  input: { command: 'pwd' },
                  result: { output: '/workspace', exit_code: 0 },
                },
              },
              { type: 'reasoning', text: '## After\n分析结果' },
              { type: 'text', text: 'FINAL: /workspace' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )

    expect(screen.getAllByTestId('cot')).toHaveLength(1)
    const cot = screen.getByTestId('cot')
    const reasoning = screen.getAllByTestId('reasoning-markdown')
    expect(reasoning).toHaveLength(2)
    expect(cot).toContainElement(reasoning[0])
    expect(cot).toContainElement(screen.getByTestId('runtime-event-part'))
    expect(cot).toContainElement(reasoning[1])
    expect(cot).not.toHaveTextContent('FINAL: /workspace')
    expect(screen.getAllByTestId('render-markdown')).toHaveLength(2)
  })

  it('renders a pending runtime permission inline', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'data-runtime-permission',
                data: {
                  requestId: 'rp-1',
                  toolCallId: 'rt-1',
                  title: '允许搜索',
                  description: 'Hermes 请求执行 web_search',
                  toolName: 'web_search',
                  canAllowOnce: true,
                  canDeny: true,
                  status: 'pending',
                },
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )

    const permission = screen.getByTestId('runtime-event-part')
    expect(screen.getByTestId('cot')).toContainElement(permission)
  })

  it('does not reuse a cached permission while streamed message parts are empty', () => {
    const pending = {
      type: 'data-runtime-permission',
      data: {
        requestId: 'rp-1',
        toolCallId: 'rt-1',
        title: '允许搜索',
        description: 'Hermes 请求执行 web_search',
        toolName: 'web_search',
        canAllowOnce: true,
        canDeny: true,
        status: 'pending',
      },
    }
    const props = {
      isFirstMessage: true,
      isLastMessage: true,
      status: 'submitted' as any,
    }
    const { rerender } = render(
      <MessageItem
        {...props}
        message={makeMsg({ id: 'runtime-1', parts: [pending] }) as any}
      />
    )
    expect(screen.getByTestId('runtime-event-part')).toHaveAttribute(
      'data-type',
      'data-runtime-permission'
    )

    rerender(
      <MessageItem
        {...props}
        message={makeMsg({ id: 'runtime-1', parts: [] }) as any}
      />
    )

    expect(screen.queryByTestId('runtime-event-part')).not.toBeInTheDocument()
  })

  it('keeps a pending runtime permission visible ahead of a streaming tool', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'data-runtime-permission',
                data: {
                  requestId: 'rp-1',
                  toolCallId: 'rt-1',
                  title: '允许运行命令',
                  description: 'Hermes 请求执行 terminal',
                  toolName: 'terminal',
                  inputSummary: { command: 'pwd' },
                  canAllowOnce: true,
                  canDeny: true,
                  status: 'pending',
                },
              },
              {
                type: 'data-runtime-tool',
                data: {
                  toolCallId: 'rt-2',
                  name: 'web_search',
                  status: 'running',
                },
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'submitted' as any}
      />
    )

    expect(
      screen
        .getAllByTestId('runtime-event-part')
        .map((part) => part.getAttribute('data-type'))
    ).toEqual(['data-runtime-permission', 'data-runtime-tool'])
    expect(screen.getByTestId('cot')).toContainElement(
      screen.getAllByTestId('runtime-event-part')[0]
    )
    expect(screen.queryByTestId('prompt-progress')).not.toBeInTheDocument()
  })

  it('hides the Working prompt once reasoning has begun, even while status is submitted', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [{ type: 'reasoning', text: 'thinking...' }],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'submitted' as any}
      />
    )
    // Reasoning is already on screen, so a transient re-submit (e.g. between
    // runs of a multi-run turn) must not swap Thinking back to the Working
    // placeholder — that read as "Working replaces Thinking" mid-answer.
    expect(screen.getByTestId('cot')).toBeInTheDocument()
    expect(screen.queryByTestId('prompt-progress')).not.toBeInTheDocument()
  })

  describe('interim reasoning text', () => {
    const interstitialMsg = () =>
      makeMsg({
        parts: [
          { type: 'reasoning', text: 'first thought' },
          { type: 'text', text: 'interim answer' },
          { type: 'reasoning', text: 'second thought' },
          { type: 'text', text: 'final answer' },
        ],
      }) as any

    it('renders all reasoning segments in one card before answer text', () => {
      render(
        <MessageItem
          message={interstitialMsg()}
          isFirstMessage
          isLastMessage
          status={'ready' as any}
        />
      )
      const cots = screen.getAllByTestId('cot')
      expect(cots).toHaveLength(1)
      expect(cots[0]).toHaveTextContent('first thought')
      expect(cots[0]).toHaveTextContent('second thought')
      const bodies = screen.getAllByTestId('render-markdown')
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).toHaveTextContent('interim answer')
      expect(bodies[1]).toHaveTextContent('final answer')
    })

    it('collapses the work timeline once answer content exists', () => {
      render(
        <MessageItem
          message={interstitialMsg()}
          isFirstMessage
          isLastMessage
          status={'ready' as any}
        />
      )
      const cots = screen.getAllByTestId('cot')
      expect(cots).toHaveLength(1)
      expect(cots[0]).toHaveAttribute('data-should-collapse', 'true')
    })

    it('keeps one timeline when reasoning resumes after answer text', () => {
      render(
        <MessageItem
          message={
            makeMsg({
              parts: [
                { type: 'reasoning', text: 'first thought' },
                { type: 'text', text: 'interim answer' },
                { type: 'reasoning', text: 'trailing thought' },
              ],
            }) as any
          }
          isFirstMessage
          isLastMessage
          status={'ready' as any}
        />
      )
      const cots = screen.getAllByTestId('cot')
      expect(cots).toHaveLength(1)
      expect(cots[0]).toHaveAttribute('data-should-collapse', 'true')
      expect(cots[0]).toHaveTextContent('first thought')
      expect(cots[0]).toHaveTextContent('trailing thought')
    })

    it('skips empty interim text parts', () => {
      render(
        <MessageItem
          message={
            makeMsg({
              parts: [
                { type: 'reasoning', text: 'thinking' },
                { type: 'text', text: '   ' },
                { type: 'text', text: 'final' },
              ],
            }) as any
          }
          isFirstMessage
          isLastMessage
          status={'ready' as any}
        />
      )
      // Blank interim text does not flush the trace into a second group.
      expect(screen.getAllByTestId('cot')).toHaveLength(1)
      const bodies = screen.getAllByTestId('render-markdown')
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toHaveTextContent('final')
    })
  })

  it('renders tool error when state is output-error', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'tool-x',
                state: 'output-error',
                errorText: 'boom',
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('tool-output')).toHaveTextContent('boom')
  })

  it('shows progress for an executing tool call (not awaiting approval)', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-search', state: 'input-available', toolCallId: 'tc1', input: {} },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('prompt-progress')).toBeInTheDocument()
  })

  it('shows progress only while a runtime tool is non-terminal', () => {
    const { rerender } = render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'data-runtime-tool',
                data: {
                  toolCallId: 'rt-1',
                  name: 'web_search',
                  status: 'running',
                },
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )

    expect(screen.getByTestId('prompt-progress')).toBeInTheDocument()

    rerender(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'data-runtime-tool',
                data: {
                  toolCallId: 'rt-1',
                  name: 'web_search',
                  status: 'completed',
                  result: { count: 3 },
                },
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )

    expect(screen.queryByTestId('prompt-progress')).not.toBeInTheDocument()

    rerender(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'data-runtime-tool',
                data: {
                  toolCallId: 'rt-1',
                  name: 'web_search',
                  status: 'failed',
                  error: '连接已断开',
                },
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )

    expect(screen.queryByTestId('prompt-progress')).not.toBeInTheDocument()
  })

  it('hides progress while a tool call awaits approval', () => {
    pendingApprovalsRef.current = { tc1: {} }
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-search', state: 'input-available', toolCallId: 'tc1', input: {} },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.queryByTestId('prompt-progress')).not.toBeInTheDocument()
  })

  it('keeps an earlier tool part visible while it awaits approval (multi-tool turn)', () => {
    // Two tool calls in one streaming turn; the first is awaiting approval.
    // Streaming truncation must not hide it, or its approve/deny controls
    // never mount and the run hangs.
    pendingApprovalsRef.current = { 'tc-alpha': {} }
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-alpha', state: 'input-available', toolCallId: 'tc-alpha', input: {} },
              { type: 'tool-beta', state: 'input-available', toolCallId: 'tc-beta', input: {} },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'streaming' as any}
      />
    )
    const headers = screen.getAllByTestId('tool-header').map((h) => h.textContent)
    expect(headers).toContain('alpha')
    expect(headers).toContain('beta')
  })

  it('renders every tool step while streaming (no truncation)', () => {
    // Tools render inline per part now, so every step stays mounted while
    // streaming — no truncation to the latest step.
    pendingApprovalsRef.current = {}
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-alpha', state: 'input-available', toolCallId: 'tc-alpha', input: {} },
              { type: 'tool-beta', state: 'input-available', toolCallId: 'tc-beta', input: {} },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'streaming' as any}
      />
    )
    const headers = screen.getAllByTestId('tool-header').map((h) => h.textContent)
    expect(headers).toContain('alpha')
    expect(headers).toContain('beta')
  })

  it('passes full text to copy button', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    const copy = screen.getByTestId('copy-btn')
    expect(copy.getAttribute('data-text')).toBe('a\nb')
  })

  it('does not render regenerate button when no selectedModel', () => {
    selectedModelRef.current = null
    const onRegenerate = vi.fn()
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onRegenerate={onRegenerate}
      />
    )
    expect(screen.queryByTitle('Regenerate response')).not.toBeInTheDocument()
  })

  it('renders regenerate for a Hermes runtime message without selectedModel', () => {
    selectedModelRef.current = null
    const onRegenerate = vi.fn()
    render(
      <MessageItem
        message={
          makeMsg({
            metadata: { createdAt: new Date(), runtime: 'hermes' },
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onRegenerate={onRegenerate}
      />
    )

    fireEvent.click(screen.getByTitle('Regenerate response'))
    expect(onRegenerate).toHaveBeenCalledWith('msg-1')
  })
})

it('Session 保留正文、工作段、正文的事件顺序并提供文件链接', () => {
  const { container } = render(<MessageItem message={{ id: 'ordered-session', role: 'assistant', metadata: { runtime: 'bianbu', sessionFeed: true }, parts: [
    { type: 'text', text: '第一段正文' },
    { type: 'reasoning', text: '第二阶段思考', state: 'done' },
    { type: 'data-runtime-tool', data: { toolCallId: 't', name: 'terminal', status: 'completed' } },
    { type: 'text', text: '第三段正文' },
    { type: 'file', mediaType: 'application/octet-stream', filename: '结果.txt', url: 'http://localhost:9100/api/v1/files/result' },
  ] } as any} isFirstMessage isLastMessage status="ready" hideActions />)
  const sequence = [...container.querySelectorAll('[data-testid="render-markdown"], [data-testid="reasoning-markdown"], [data-testid="runtime-event-part"]')].map(element => element.textContent || '工具')
  expect(sequence).toEqual(['第一段正文', '第二阶段思考', '工具', '第三段正文'])
  expect(screen.getByRole('link', { name: 'Open file 结果.txt' })).toHaveAttribute('href', 'http://localhost:9100/api/v1/files/result')
})

it('Session 文件事件经投影进入原消息组件，只为同源合法资源提供入口', async () => {
  const { projectSessionEvents, sessionMessageToUIMessage } = await import('@/lib/runtime-session-projection')
  const urls = [
    '/api/v1/files/report',
    'https://other.example/report',
    'http://localhost:9101/api/v1/files/report',
    'http://user:password@localhost:9100/api/v1/files/report',
    'file:///home/user/report',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    '/home/user/report',
  ]
  const projection = projectSessionEvents(urls.map((url, seq) => ({ seq, time: 1, run_id: 'run-files', type: 'run/event', data: { kind: 'artifact', payload: { url, name: `文件-${seq}.pdf`, mime_type: 'application/pdf' } } })))
  const message = sessionMessageToUIMessage(projection.messages[0], 'http://localhost:9100/api/v1/')
  render(<MessageItem message={{ ...message, metadata: { ...message.metadata as object, sessionFeed: true } }} isFirstMessage isLastMessage status="ready" hideActions />)
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link', { name: 'Open file 文件-0.pdf' })).toHaveAttribute('href', 'http://localhost:9100/api/v1/files/report')
  for (let index = 1; index < urls.length; index++) expect(screen.queryByRole('link', { name: `Open file 文件-${index}.pdf` })).not.toBeInTheDocument()
})


it.each(['cancelled', 'failed'])('Session %s 终态不被未完成工具覆盖，诊断在折叠区外', async terminal => {
  const { projectSessionEvents, sessionMessageToUIMessage } = await import('@/lib/runtime-session-projection')
  const projection = projectSessionEvents([
    { seq: 1, time: 1, run_id: 'stopped-run', type: 'tool/call.started', data: { call_id: 'tool-1', name: 'terminal', arguments: {} } },
    { seq: 2, time: 2, run_id: 'stopped-run', type: `run/${terminal}`, data: {} },
  ])
  const ui = sessionMessageToUIMessage(projection.messages[0])
  const { container } = render(<MessageItem message={{ ...ui, metadata: { ...ui.metadata as object, sessionFeed: true } }} isFirstMessage isLastMessage status="ready" hideActions />)
  const diagnostic = container.querySelector('[data-type="data-runtime-diagnostic"]')
  expect(diagnostic).not.toBeNull()
  expect(screen.queryByTestId('cot')).not.toBeInTheDocument()
  expect(screen.getByTestId('token-speed')).toHaveAttribute('data-streaming', 'false')
})


it.each(['user', 'assistant'] as const)('Runtime %s 使用真实编辑对话框且不依赖本地模型', async role => {
  selectedModelRef.current = null
  realEditDialog.enabled = true
  const onEdit = vi.fn()
  try {
    const view = render(<MessageItem message={{ id: 'runtime-edit', role, metadata: { runtime: 'bianbu' },
      parts: [{ type: 'text', text: '原内容' }] }} isFirstMessage isLastMessage status="ready" onEdit={onEdit} />)
    const trigger = view.container.querySelector('button:has(.tabler-icon-pencil)') as HTMLButtonElement
    expect(trigger).not.toBeDisabled()
    fireEvent.click(trigger)
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '修订内容' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onEdit).toHaveBeenCalledWith('runtime-edit', '修订内容')
  } finally { realEditDialog.enabled = false }
})

it('shows Runtime compression details without token counters', () => {
  const { rerender } = render(<MessageItem isFirstMessage={false} isLastMessage={true} status="ready" message={{ id: 'compression', role: 'system', parts: [{ type: 'text', text: 'Summary' }], metadata: { runtime: 'bianbu', compression: { before_tokens: 10000, after_tokens: 2000, retained_messages: 8, compression_count: 2, used_fallback: true } } }} />)
  expect(screen.getByText('10,000 → 2,000 tokens')).toBeInTheDocument()
  expect(screen.getByText('Summary model unavailable; used the safe fallback summary.')).toBeInTheDocument()
  expect(screen.getByText('Repeated compression may reduce detail and accuracy.')).toBeInTheDocument()
  rerender(<MessageItem isFirstMessage={false} isLastMessage={true} status="ready" message={{ id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'Done' }], metadata: { runtime: 'bianbu', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } }} />)
  expect(screen.queryAllByText(/runtimeConversation\.(input|output|total)/)).toHaveLength(0)
})
