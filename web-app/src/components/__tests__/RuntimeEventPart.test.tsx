import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'
import '@testing-library/jest-dom'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  surface: 'main' as 'main' | 'status-popup' | 'voice-overlay',
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@/lib/window-surface', () => ({
  currentWindowSurface: () => h.surface,
}))

vi.mock('@/components/ai-elements/tool', () => ({
  Tool: ({ children, state }: any) => (
    <div data-testid="runtime-tool" data-state={state}>
      {children}
    </div>
  ),
  ToolContent: ({ children }: any) => <div>{children}</div>,
  ToolHeader: ({ title, state }: any) => (
    <div data-testid="runtime-tool-header" data-state={state}>
      {title}
    </div>
  ),
  ToolInput: ({ input }: any) => (
    <div data-testid="runtime-tool-input">{JSON.stringify(input)}</div>
  ),
  ToolOutput: ({ output, errorText }: any) => (
    <div data-testid="runtime-tool-output">
      {errorText ?? JSON.stringify(output)}
    </div>
  ),
}))

import {
  RuntimeEventPart,
  RuntimePermissionFallback,
} from '@/components/RuntimeEventPart'
import { createConversationContributionRegistry } from '@/features/conversation/contributionRegistry'
import {
  applyRuntimePermissionSnapshot,
  observeRuntimePermission,
  resetRuntimePermissionControllerForTests,
  runtimePermissionIdentityKey,
} from '@/features/conversation/runtimePermissionController'
import { securityDemoFeatureEntry } from '@/features/activeFeatureRegistry'

const toolPart = (status: 'pending' | 'running' | 'completed' | 'failed') => ({
  type: 'data-runtime-tool' as const,
  id: 'tool-1',
  data: {
    toolCallId: 'tool-1',
    name: 'web_search',
    status,
    input: { query: 'AI' },
    ...(status === 'completed' ? { result: { count: 3 } } : {}),
    ...(status === 'failed' ? { error: 'search failed' } : {}),
  },
})

const permissionPart = (
  overrides: Record<string, unknown> = {}
) => ({
  type: 'data-runtime-permission' as const,
  id: 'permission-1',
  data: {
    runtimeId: 'hermes' as const,
    runtimeEpoch: 'epoch-1',
    sessionId: 'thread-1',
    runId: 'run-1',
    createdAt: '2026-08-19T00:00:00.000Z',
    expiresAt: '2026-08-19T00:01:00.000Z',
    requestId: 'permission-1',
    toolCallId: 'tool-1',
    title: '允许搜索',
    description: 'Hermes 请求执行 web_search',
    toolName: 'web_search',
    canAllowOnce: true,
    canDeny: true,
    status: 'pending' as const,
    ...overrides,
  },
})

const resolveRequest = (decision: 'allow_once' | 'deny') => ({
  runtimeInstanceId: 'hermes:epoch-1',
  runtimeId: 'hermes',
  runtimeEpoch: 'epoch-1',
  sessionId: 'thread-1',
  threadId: 'thread-1',
  runId: 'run-1',
  requestId: 'permission-1',
  toolCallId: 'tool-1',
  decision,
})

const resolveReceipt = (decision: 'allow_once' | 'deny') => ({
  version: 1,
  ...resolveRequest(decision),
  status: 'accepted',
})

describe('RuntimeEventPart', () => {
  it('审批常驻区显示动作参数，内部元数据只在用户展开详情后显示', () => {
    render(<RuntimeEventPart part={permissionPart({
      actions: [{ kind: 'tool', name: 'terminal', summary: '{"command":"pwd"}' }],
      inputSummary: [{ name: 'terminal', arguments: { command: 'pwd' }, tool_metadata: { module_name: 'internal-module-marker' } }],
    })} messageId="approval-metadata" sessionFeed />)
    expect(screen.getByTestId('permission-decision-context')).toHaveTextContent('pwd')
    expect(screen.queryByText(/internal-module-marker/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More details' }))
    expect(screen.getByText(/internal-module-marker/)).toBeVisible()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    h.surface = 'main'
    resetRuntimePermissionControllerForTests()
    h.invoke.mockImplementation(
      (command: string, input?: { request: { decision: 'allow_once' | 'deny' } }) =>
        command === 'runtime_permission_resolve' && input
          ? Promise.resolve(resolveReceipt(input.request.decision))
          : Promise.resolve(undefined)
    )
  })

  it('审批关键目标超过日志截断长度仍常驻可读且脱敏', () => {
    render(<RuntimeEventPart part={permissionPart({
      inputSummary: { explanation: 'x'.repeat(20_100), path: '/important/final-target', token: 'private-token' },
    })} messageId="long-approval" sessionFeed />)
    const context = screen.getByTestId('permission-decision-context')
    expect(context).toHaveTextContent('/important/final-target')
    expect(context).not.toHaveTextContent('private-token')
    expect(context).not.toHaveTextContent('…[truncated]')
    expect(screen.getByRole('button', { name: 'More details' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('redacts secrets and bounds Runtime tool details', () => {
    render(<RuntimeEventPart part={{
      ...toolPart('completed'),
      data: {
        ...toolPart('completed').data,
        input: { api_key: 'top-secret', authorization: 'Bearer abc123' },
        result: { text: 'Bearer result-token', payload: 'x'.repeat(25_000) },
      },
    }} messageId="m1" />)
    expect(screen.queryByText(/top-secret|abc123|result-token/)).not.toBeInTheDocument()
    expect(screen.getAllByText(/\[redacted\]/).length).toBeGreaterThan(0)
    expect(document.body.textContent?.length).toBeLessThan(23_000)
  })

  it('Session 审批决策信息常驻，详情开关不提交，定位标题和失效原因可用', () => {
    const part = permissionPart({
      inputSummary: { path: '/tmp/必须直接可见的目录', token: 'hidden-secret' },
      actions: [{ kind: 'filesystem', name: '删除目录', summary: '/tmp/必须直接可见的目录' }],
    })
    const view = render(<RuntimeEventPart part={part} messageId="m" sessionFeed />)
    const trigger = screen.getByRole('button', { name: 'More details' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('permission-decision-context')).toHaveTextContent('/tmp/必须直接可见的目录')
    expect(screen.getByTestId('permission-decision-context')).not.toHaveTextContent('hidden-secret')
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeVisible()
    const root = screen.getByTestId('runtime-permission')
    expect(root.getAttribute('data-runtime-permission-key')).toBe(runtimePermissionIdentityKey(part.data))
    const title = root.querySelector<HTMLElement>('[data-runtime-permission-title]')!
    title.focus()
    expect(title).toHaveFocus()
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(trigger)
    expect(h.invoke).not.toHaveBeenCalled()
    view.rerender(<RuntimeEventPart part={permissionPart({ ...part.data, status: 'resolved', expiredReason: '任务已取消' })} messageId="m" sessionFeed />)
    expect(screen.getByText('Permission request expired')).toBeInTheDocument()
    expect(screen.getByText('任务已取消')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow Once' })).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('失败详情保留错误说明并脱敏结构化凭据', () => {
    render(<RuntimeEventPart part={{ ...toolPart('failed'), data: {
      ...toolPart('failed').data,
      error: JSON.stringify({ message: '命令执行失败', token: 'error-secret' }),
    } }} messageId="m1" />)
    expect(screen.getByTestId('runtime-tool-output')).toHaveTextContent('命令执行失败')
    expect(screen.getByTestId('runtime-tool-output')).toHaveTextContent('[redacted]')
    expect(document.body.textContent).not.toContain('error-secret')
  })

  it.each([
    [{ output: '完整输出\n第二行', exit_code: 3 }, 'Merged output:\n完整输出\n第二行\n\nExit code: 3'],
    [{ stdout: '标准输出', stderr: '错误输出', exit_code: 1 }, 'stdout:\n标准输出\n\nstderr:\n错误输出\n\nExit code: 1'],
    [
      { stdout: '1: lo: <LOOPBACK,UP>\r\n    inet 127.0.0.1/8  scope host lo\r\n\r\n\tvalid_lft forever\r\n', stderr: '    Bearer private-token\n', exit_code: 0 },
      'stdout:\n1: lo: <LOOPBACK,UP>\r\n    inet 127.0.0.1/8  scope host lo\r\n\r\n\tvalid_lft forever\r\n\n\nstderr:\n    Bearer [redacted]\n\n\nExit code: 0',
    ],
  ])('终端输出保留实际流结构和退出码，复制完整可见内容', async (result, expected) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const view = render(<RuntimeEventPart part={{ ...toolPart('completed'), data: {
      ...toolPart('completed').data, name: 'terminal', result: JSON.stringify(result),
    } }} messageId="m1" />)
    // The terminal block follows the app theme now; there is no forced dark
    // surface inside a light conversation.
    expect(view.container.querySelector('.dark')).toBeNull()
    expect(view.container.textContent).toContain(`Exit code: ${result.exit_code}`)
    await waitFor(() => {
      const highlighted = view.container.querySelectorAll('pre code')
      expect(highlighted).toHaveLength(2)
      for (const code of highlighted) {
        // HTML parsing normalizes CRLF for display; clipboard keeps the code prop.
        expect(code.textContent).toBe(expected.replace(/\r\n/g, '\n'))
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Copy terminal output' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
  })

  it('无法识别的终端结果仍通过原工具输出安全降级', () => {
    render(<RuntimeEventPart part={{ ...toolPart('completed'), data: {
      ...toolPart('completed').data, name: 'terminal', result: '无结构输出',
    } }} messageId="m1" />)
    expect(screen.getByTestId('runtime-tool-output')).toHaveTextContent('无结构输出')
    expect(screen.queryByRole('button', { name: 'Copy terminal output' })).not.toBeInTheDocument()
  })

  it.each([
    ['pending', 'input-available'],
    ['running', 'input-available'],
    ['completed', 'output-available'],
    ['failed', 'output-error'],
  ] as const)('maps %s runtime tools to %s tool state', (status, expected) => {
    render(<RuntimeEventPart part={toolPart(status)} messageId="m1" />)

    expect(screen.getByTestId('runtime-tool')).toHaveAttribute(
      'data-state',
      expected
    )
    expect(screen.getByTestId('runtime-tool-header')).toHaveTextContent(
      'web_search'
    )
  })

  it('offers only deny and allow once for Hermes permission', () => {
    render(<RuntimeEventPart part={permissionPart()} messageId="m1" />)

    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Allow Once' })
    ).toBeInTheDocument()
    expect(screen.queryByText('Allow in thread')).not.toBeInTheDocument()
  })

  it('renders only controller permissions missing from the current thread messages', () => {
    const visible = permissionPart().data
    const alreadyRendered = permissionPart({
      requestId: 'permission-2',
      toolCallId: 'tool-2',
      title: '已在消息中展示',
    }).data
    const otherThread = permissionPart({
      sessionId: 'thread-2',
      requestId: 'permission-3',
      toolCallId: 'tool-3',
      title: '其他会话请求',
    }).data
    const resolved = permissionPart({
      requestId: 'permission-4',
      toolCallId: 'tool-4',
      title: '已处理请求',
      status: 'resolved',
      decision: 'deny',
    }).data
    observeRuntimePermission(visible)
    observeRuntimePermission(alreadyRendered)
    observeRuntimePermission(otherThread)
    observeRuntimePermission(resolved)

    render(
      <RuntimePermissionFallback
        threadId="thread-1"
        renderedPermissionKeys={
          new Set([runtimePermissionIdentityKey(alreadyRendered)])
        }
      />
    )

    expect(screen.getAllByTestId('runtime-permission')).toHaveLength(1)
    expect(screen.getByText('允许搜索')).toBeInTheDocument()
    expect(screen.queryByText('已在消息中展示')).not.toBeInTheDocument()
    expect(screen.queryByText('其他会话请求')).not.toBeInTheDocument()
    expect(screen.queryByText('权限请求已处理')).not.toBeInTheDocument()
  })

  it('keeps the status popup read-only and opens the main window', () => {
    h.surface = 'status-popup'
    render(<RuntimeEventPart part={permissionPart()} messageId="m1" />)

    expect(screen.getByText('Waiting for approval in the main window')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Deny' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Allow Once' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open main window' }))
    expect(h.invoke).toHaveBeenCalledOnce()
    expect(h.invoke).toHaveBeenCalledWith('open_main_window')
  })

  it('keeps the voice overlay approval cards actionable', async () => {
    h.surface = 'voice-overlay'
    render(<RuntimeEventPart part={permissionPart()} messageId="m1" />)

    expect(
      screen.queryByText('Waiting for approval in the main window')
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith('runtime_permission_resolve', {
        request: { ...resolveRequest('deny'), reason: 'user-denied' },
      })
    )
  })

  it('routes a real Hermes request through the custom Security presenter', async () => {
    const registry = createConversationContributionRegistry(
      [
        {
          ...securityDemoFeatureEntry,
          load: async () => ({
            featureModule: {
              sdkApiVersion: 1 as const,
              permissionPresenters: {
                approval: ({ request, decide }: any) => (
                  <button
                    type="button"
                    onClick={() =>
                      decide({
                        version: 1,
                        runtimeInstanceId: request.runtimeInstanceId,
                        runtimeId: request.runtimeId,
                        runtimeEpoch: request.runtimeEpoch,
                        sessionId: request.sessionId,
                        threadId: request.threadId,
                        runId: request.runId,
                        requestId: request.requestId,
                        toolCallId: request.toolCallId,
                        decision: 'allow_once',
                      })
                    }
                  >
                    Security allow once
                  </button>
                ),
              },
            },
          }),
        },
      ],
      { target: 'desktop', surface: 'main' }
    )

    render(
      <RuntimeEventPart
        part={permissionPart()}
        messageId="m1"
        registry={registry}
      />
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Security allow once' })
    )

    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith('runtime_permission_resolve', {
        request: resolveRequest('allow_once'),
      })
    )
  })

  it('fails closed when a custom presenter submits an unsupported scope', async () => {
    const registry = createConversationContributionRegistry(
      [
        {
          ...securityDemoFeatureEntry,
          load: async () => ({
            featureModule: {
              sdkApiVersion: 1 as const,
              permissionPresenters: {
                approval: ({ request, decide }: any) => (
                  <button
                    type="button"
                    onClick={() =>
                      decide({
                        version: 1,
                        runtimeInstanceId: request.runtimeInstanceId,
                        runtimeId: request.runtimeId,
                        runtimeEpoch: request.runtimeEpoch,
                        sessionId: request.sessionId,
                        threadId: request.threadId,
                        runId: request.runId,
                        requestId: request.requestId,
                        toolCallId: request.toolCallId,
                        decision: 'allow_always',
                      })
                    }
                  >
                    Invalid session allow
                  </button>
                ),
              },
            },
          }),
        },
      ],
      { target: 'desktop', surface: 'main' }
    )

    render(
      <RuntimeEventPart
        part={permissionPart()}
        messageId="m1"
        registry={registry}
      />
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Invalid session allow' })
    )

    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith('runtime_permission_resolve', {
        request: { ...resolveRequest('deny'), reason: 'presenter-failed' },
      })
    )
  })

  it('hides allow once when the permission does not offer it', () => {
    render(
      <RuntimeEventPart
        part={permissionPart({ canAllowOnce: false })}
        messageId="m1"
      />
    )

    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Allow Once' })
    ).not.toBeInTheDocument()
  })

  it('shows the sanitized permission input summary only when provided', () => {
    const { rerender } = render(
      <RuntimeEventPart
        part={permissionPart({ inputSummary: { command: 'pwd' } })}
        messageId="m1"
      />
    )

    expect(screen.getByTestId('runtime-permission-summary')).toHaveTextContent(
      'pwd'
    )

    rerender(<RuntimeEventPart part={permissionPart()} messageId="m1" />)
    expect(
      screen.queryByTestId('runtime-permission-summary')
    ).not.toBeInTheDocument()
  })

  it('submits a rapid double click only once', async () => {
    let resolve: (() => void) | undefined
    h.invoke.mockReturnValue(
      new Promise((done) => {
        resolve = () => done(resolveReceipt('allow_once'))
      })
    )
    render(<RuntimeEventPart part={permissionPart()} messageId="m1" />)
    const allow = screen.getByRole('button', { name: 'Allow Once' })

    fireEvent.click(allow)
    fireEvent.click(allow)

    await waitFor(() => expect(h.invoke).toHaveBeenCalledOnce())
    expect(h.invoke).toHaveBeenCalledWith('runtime_permission_resolve', {
      request: resolveRequest('allow_once'),
    })
    await act(async () => resolve?.())
    expect(allow).toBeDisabled()
  })

  it('keeps an in-flight decision across message unmount and remount', async () => {
    let resolve: (() => void) | undefined
    h.invoke.mockReturnValue(
      new Promise((done) => {
        resolve = () => done(resolveReceipt('allow_once'))
      })
    )
    const first = render(
      <RuntimeEventPart part={permissionPart()} messageId="m1" />
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Allow Once' })
    )
    await waitFor(() => expect(h.invoke).toHaveBeenCalledOnce())
    first.unmount()

    render(<RuntimeEventPart part={permissionPart()} messageId="m1" />)
    expect(
      screen.getByRole('button', { name: 'Allow Once' })
    ).toBeDisabled()
    expect(h.invoke).toHaveBeenCalledOnce()

    await act(async () => resolve?.())
    expect(await screen.findByText('Permission request resolved')).toBeInTheDocument()
    expect(h.invoke).toHaveBeenCalledOnce()
  })

  it('shows the resolved decision and disables actions', () => {
    render(
      <RuntimeEventPart
        part={permissionPart({
          status: 'resolved',
          decision: 'deny',
        })}
        messageId="m1"
      />
    )

    expect(screen.getByText('Denied')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows an invoke error in the card and allows retry', async () => {
    h.invoke
      .mockRejectedValueOnce({
        code: 'process_exited',
        message: '连接已断开',
        recoverable: true,
      })
      .mockResolvedValueOnce(resolveReceipt('allow_once'))
    render(<RuntimeEventPart part={permissionPart()} messageId="m1" />)
    const deny = screen.getByRole('button', { name: 'Deny' })

    fireEvent.click(deny)
    expect(
      await screen.findByText('process_exited: 连接已断开')
    ).toBeInTheDocument()
    expect(deny).not.toBeDisabled()
    fireEvent.click(deny)

    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2))
  })

  it('rejects an invalid permission command acknowledgement', async () => {
    h.invoke.mockResolvedValue({ ...resolveReceipt('allow_once'), status: 'always' })
    render(<RuntimeEventPart part={permissionPart()} messageId="m1" />)
    const deny = screen.getByRole('button', { name: 'Deny' })

    fireEvent.click(deny)

    expect(await screen.findByText(/permissionDecisionReceipt.status: expected one of/)).toBeInTheDocument()
    expect(deny).not.toBeDisabled()
  })

  it('closes a request after a stale receipt', async () => {
    h.invoke.mockResolvedValueOnce({
      ...resolveReceipt('deny'),
      status: 'stale',
    })
    render(<RuntimeEventPart part={permissionPart()} messageId="m1" />)
    const deny = screen.getByRole('button', { name: 'Deny' })

    fireEvent.click(deny)

    expect(await screen.findByText('Permission request resolved')).toBeInTheDocument()
    expect(h.invoke).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('button', { name: 'Deny' })
    ).not.toBeInTheDocument()
  })

  it('does not revive a permission from a retired Runtime epoch', () => {
    applyRuntimePermissionSnapshot({
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-2',
      sequence: 1,
      status: 'ready',
    })

    render(<RuntimeEventPart part={permissionPart()} messageId="m1" />)

    expect(screen.getByText('Permission request expired')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('preserves a resolved decision from a retired Runtime epoch', () => {
    applyRuntimePermissionSnapshot({
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-2',
      sequence: 1,
      status: 'ready',
    })

    render(
      <RuntimeEventPart
        part={permissionPart({ status: 'resolved', decision: 'allow_once' })}
        messageId="m1"
      />
    )

    expect(screen.getByText('Permission request resolved')).toBeInTheDocument()
    expect(screen.getByText('Allowed once')).toBeInTheDocument()
    expect(screen.queryByText('Permission request expired')).not.toBeInTheDocument()
  })
})

// Everything above renders through the key-echo translator, which proves the
// wiring but says nothing about the copy. These two run the real translator so
// a string that is missing from a locale file, or hardcoded in one language,
// fails here instead of shipping.
describe('trace copy follows the active language', () => {
  const originalLanguage = i18n.language
  const localised = (children: ReactNode) => (
    <TranslationContext.Provider value={{ t: i18n.t, i18n }}>
      {children}
    </TranslationContext.Provider>
  )
  const approval = () => (
    <RuntimeEventPart
      part={permissionPart({
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        title: 'Allow file removal',
        description: 'Deletes a directory',
        actions: [{ kind: 'filesystem', name: 'Remove directory', summary: '/tmp/visible' }],
        inputSummary: { path: '/tmp/visible' },
      })}
      messageId="m-en"
      sessionFeed
    />
  )

  afterEach(() => i18n.changeLanguage(originalLanguage))
  beforeEach(() =>
    applyRuntimePermissionSnapshot({
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-1',
      sequence: 1,
      status: 'ready',
    })
  )

  it('renders no Chinese copy under the English locale', () => {
    i18n.changeLanguage('en')
    const view = render(localised(approval()))
    expect(view.container.textContent).toContain('Needs approval: ')
    expect(view.container.textContent).toContain('More details')
    expect(view.container.textContent).not.toMatch(/[\u3400-\u9fff]/)
  })

  it('renders the Chinese copy under the zh-CN locale', () => {
    i18n.changeLanguage('zh-CN')
    const view = render(localised(approval()))
    expect(view.container.textContent).toContain('需要审批：')
    expect(view.container.textContent).toContain('补充详情')
    expect(view.container.textContent).not.toMatch(/Needs approval/)
  })

  it('translates a runtime failure code and keeps the original text', () => {
    i18n.changeLanguage('zh-CN')
    const view = render(localised(
      <RuntimeEventPart
        part={{ type: 'data-runtime-diagnostic', data: {
          level: 'warning',
          message: "Permission denied: '/run/user/0/bianbu-agent/instances'",
          code: 'worker_rpc_error',
        } }}
        messageId="m-diag"
      />
    ))
    expect(view.container.textContent).toContain('运行时工作进程异常，本轮未能完成。')
    expect(view.container.textContent).toContain("Permission denied: '/run/user/0/bianbu-agent/instances'")
  })

  it('falls back to the runtime text when the code has no copy', () => {
    i18n.changeLanguage('zh-CN')
    const view = render(localised(
      <RuntimeEventPart
        part={{ type: 'data-runtime-diagnostic', data: {
          level: 'warning',
          message: '自动恢复未能完成当前任务。可以在当前会话继续。',
          code: 'model_recovery_exhausted',
        } }}
        messageId="m-diag-fallback"
      />
    ))
    expect(view.container.textContent).toContain('自动恢复未能完成当前任务。可以在当前会话继续。')
    expect(view.container.textContent).not.toContain('model_recovery_exhausted')
  })

  it('shows the structured reason instead of only the generic sentence', () => {
    i18n.changeLanguage('zh-CN')
    const view = render(localised(
      <RuntimeEventPart
        part={{ type: 'data-runtime-diagnostic', data: {
          level: 'warning',
          message: '[bianbu-security] 能力未授权',
          code: 'security_denied',
          retryable: false,
          details: {
            tool: 'web_search',
            capability: 'network.access',
            scope: 'https://api.example.com',
            risk_level: 'L2',
          },
        } }}
        messageId="m-diag-details"
      />
    ))
    const details = screen.getByTestId('runtime-diagnostic-details')
    expect(details.textContent).toContain('web_search')
    expect(details.textContent).toContain('network.access')
    expect(details.textContent).toContain('L2')
    expect(details.textContent).toContain('所需能力')
    expect(view.container.textContent).toContain('安全策略拒绝了本轮请求。')
  })

  it('redacts secrets in the details before rendering them', () => {
    i18n.changeLanguage('zh-CN')
    render(localised(
      <RuntimeEventPart
        part={{ type: 'data-runtime-diagnostic', data: {
          level: 'warning',
          message: '上游拒绝',
          code: 'provider_connection_failed',
          details: { provider: 'deepseek', api_key: 'sk-super-secret' },
        } }}
        messageId="m-diag-secret"
      />
    ))
    expect(screen.getByTestId('runtime-diagnostic-details').textContent)
      .not.toContain('sk-super-secret')
  })
})
