import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  SecurityDemoApproval,
  SecurityDemoApprovalTimeline,
} from '../SecurityDemoApproval'
import { createConversationContributionRegistry } from '@/features/conversation/contributionRegistry'
import { securityDemoFeatureEntry } from '@/features/activeFeatureRegistry'
import { featureModule as securityDemoModule } from '@/features/demo/securityFeatureModule'
import { useSecurityDemoApprovalStore } from '@/features/demo/securityDemoApprovalStore'
import { useConversationAttentionStore } from '@/features/conversation/conversationAttentionStore'

const createDemoRegistry = () =>
  createConversationContributionRegistry(
    [
      {
        ...securityDemoFeatureEntry,
        load: async () => ({ featureModule: securityDemoModule }),
      },
    ],
    { target: 'desktop', surface: 'main' }
  )

describe('SecurityDemoApproval', () => {
  beforeEach(() => {
    useSecurityDemoApprovalStore.getState().resetForTests()
  })

  it('renders the request as a conversation event without a modal', async () => {
    const user = userEvent.setup()
    render(
      <>
        <SecurityDemoApproval threadId="thread-a" />
        <SecurityDemoApprovalTimeline
          threadId="thread-a"
          registry={createDemoRegistry()}
        />
      </>
    )

    await user.click(screen.getByRole('button', { name: '模拟安全请求' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      await screen.findByRole('region', { name: 'Agent 权限确认' })
    ).toBeInTheDocument()
    expect(screen.getByText(/读取 SSH 身份凭据/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已拒绝此次操作')
  })

  it('keeps a pending request when the conversation timeline unmounts', async () => {
    const user = userEvent.setup()
    const registry = createDemoRegistry()
    const view = render(
      <>
        <SecurityDemoApproval threadId="thread-a" />
        <SecurityDemoApprovalTimeline threadId="thread-a" registry={registry} />
      </>
    )

    await user.click(screen.getByRole('button', { name: '模拟安全请求' }))
    view.rerender(
      <SecurityDemoApprovalTimeline threadId="thread-b" registry={registry} />
    )
    expect(
      screen.queryByRole('region', { name: 'Agent 权限确认' })
    ).not.toBeInTheDocument()

    view.rerender(
      <SecurityDemoApprovalTimeline threadId="thread-a" registry={registry} />
    )
    expect(
      await screen.findByRole('region', { name: 'Agent 权限确认' })
    ).toBeInTheDocument()
  })

  it('keeps the approval event anchored after its requesting message', async () => {
    const user = userEvent.setup()
    const registry = createDemoRegistry()
    const view = render(
      <>
        <SecurityDemoApproval threadId="thread-a" afterMessageId="message-1" />
        <SecurityDemoApprovalTimeline
          threadId="thread-a"
          afterMessageId="message-1"
          registry={registry}
        />
      </>
    )

    await user.click(screen.getByRole('button', { name: '模拟安全请求' }))
    expect(
      await screen.findByRole('region', { name: 'Agent 权限确认' })
    ).toBeInTheDocument()

    view.rerender(
      <SecurityDemoApprovalTimeline threadId="thread-a" registry={registry} />
    )
    expect(
      screen.queryByRole('region', { name: 'Agent 权限确认' })
    ).not.toBeInTheDocument()
  })

  it('renders an orphaned approval in the fallback timeline', async () => {
    const user = userEvent.setup()
    const registry = createDemoRegistry()
    const view = render(
      <SecurityDemoApproval threadId="thread-a" afterMessageId="removed-message" />
    )

    await user.click(screen.getByRole('button', { name: '模拟安全请求' }))
    view.rerender(
      <SecurityDemoApprovalTimeline
        threadId="thread-a"
        visibleMessageIds={['visible-message']}
        registry={registry}
      />
    )

    expect(
      await screen.findByRole('region', { name: 'Agent 权限确认' })
    ).toBeInTheDocument()
  })

  it('keeps the status popup projection read-only', async () => {
    const user = userEvent.setup()
    const registry = createDemoRegistry()
    const view = render(<SecurityDemoApproval threadId="thread-a" />)

    await user.click(screen.getByRole('button', { name: '模拟安全请求' }))
    view.rerender(
      <SecurityDemoApprovalTimeline
        threadId="thread-a"
        registry={registry}
        surface="status-popup"
      />
    )

    expect(screen.getByText('主窗口中等待审批')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开主窗口' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Allow once' })
    ).not.toBeInTheDocument()
  })

  it('expires a stale demo request without accepting the decision', async () => {
    const store = useSecurityDemoApprovalStore.getState()
    const eventId = store.request('thread-a')
    const event = useSecurityDemoApprovalStore.getState().threads['thread-a']
      ?.byId[eventId]
    expect(event).toBeDefined()
    useSecurityDemoApprovalStore.setState((state) => ({
      threads: {
        ...state.threads,
        'thread-a': {
          ...state.threads['thread-a'],
          byId: {
            ...state.threads['thread-a']?.byId,
            [eventId]: {
              ...event!,
              expiresAt: new Date(Date.now() - 1).toISOString(),
            },
          },
        },
      },
    }))

    const receipt = await useSecurityDemoApprovalStore.getState().decide(
      'thread-a',
      eventId,
      {
        version: 1,
        runtimeInstanceId: 'security-demo-runtime:development',
        runtimeId: 'security-demo-runtime',
        runtimeEpoch: 'development',
        sessionId: 'thread-a',
        threadId: 'thread-a',
        runId: `security-demo:thread-a:${eventId}`,
        requestId: eventId,
        toolCallId: eventId,
        decision: 'allow_once',
      }
    )

    expect(receipt.status).toBe('expired')
    expect(
      useSecurityDemoApprovalStore.getState().threads['thread-a']?.byId[eventId]
    ).toMatchObject({ status: 'denied' })
    expect(
      useConversationAttentionStore.getState().pendingPermissionCounts['thread-a']
    ).toBeUndefined()
  })
})
