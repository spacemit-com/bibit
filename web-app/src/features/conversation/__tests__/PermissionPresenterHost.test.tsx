import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import type {
  PermissionDecisionReceiptV1,
  PermissionRequestV1,
} from '@bibit/feature-contracts'
import type { PermissionPresenterProps } from '@bibit/feature-sdk'
import { PermissionPresenterHost } from '../PermissionPresenterHost'
import { createConversationContributionRegistry } from '../contributionRegistry'
import { createTestEntry } from '../../host/__tests__/testRegistry'

const request: PermissionRequestV1 = {
  version: 1,
  runtimeInstanceId: 'current-tool-instance-1',
  requestId: 'tc-1',
  runtimeId: 'current-tool-approval',
  runtimeEpoch: 'epoch-1',
  sessionId: 'thread-1',
  threadId: 'thread-1',
  runId: 'run-1',
  toolCallId: 'tc-1',
  action: { kind: 'tool', name: 'shell', summary: 'Run shell' },
  supportedDecisions: ['allow_once', 'deny'],
  createdAt: new Date(0).toISOString(),
  expiresAt: new Date(60_000).toISOString(),
}

const pendingDecide = () =>
  vi.fn(() => new Promise<PermissionDecisionReceiptV1>(() => {}))

describe('PermissionPresenterHost', () => {
  it('does not treat StrictMode effect replay as a closed runtime', async () => {
    const decide = pendingDecide()

    render(
      <StrictMode>
        <PermissionPresenterHost request={request} decide={decide} />
      </StrictMode>
    )
    await act(async () => {})

    expect(decide).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: 'Allow Once' })
    )
    expect(decide).toHaveBeenCalledOnce()
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'allow_once' })
    )
  })

  it('uses Builtin by default and resolves only one explicit decision', () => {
    const decide = pendingDecide()
    render(<PermissionPresenterHost request={request} decide={decide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(decide).toHaveBeenCalledOnce()
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow_once' }))
  })

  it('falls back to Builtin when a custom registry presenter fails to load', async () => {
    const decide = pendingDecide()
    render(<PermissionPresenterHost
      request={request}
      decide={decide}
      enableCustomPresenter
      presenter={{
        key: 'security:permission',
        featureId: 'security',
        contributionId: 'permission',
        load: () => Promise.reject(new Error('load failed')),
      }}
    />)
    expect(await screen.findByText('This tool needs your approval before it runs.')).toBeInTheDocument()
    expect(decide).not.toHaveBeenCalled()
  })

  it('falls back to Builtin when a custom presenter throws while rendering', async () => {
    const decide = pendingDecide()
    const BrokenCustom = () => {
      throw new Error('render failed')
    }
    render(
      <PermissionPresenterHost
        request={request}
        decide={decide}
        enableCustomPresenter
        presenter={{
          key: 'security:permission',
          featureId: 'security',
          contributionId: 'permission',
          load: () =>
            Promise.resolve({
              sdkApiVersion: 1,
              permissionPresenters: { permission: BrokenCustom },
            }),
        }}
      />
    )
    expect(
      await screen.findByText('This tool needs your approval before it runs.')
    ).toBeInTheDocument()
    expect(decide).not.toHaveBeenCalled()
  })

  it('denies if both the custom and Builtin presenters fail', async () => {
    const decide = pendingDecide()
    const BrokenBuiltin = () => { throw new Error('builtin failed') }
    render(<PermissionPresenterHost
      request={request}
      decide={decide}
      enableCustomPresenter
      presenter={{ key: 'security:permission', featureId: 'security', contributionId: 'permission', load: () => Promise.reject(new Error('custom failed')) }}
      builtinPresenter={BrokenBuiltin}
    />)
    await act(async () => {})
    expect(decide).toHaveBeenCalledOnce()
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', reason: 'presenter-failed' }))
  })

  it('waits for Runtime expiry when both presenters fail on a projected request', async () => {
    const decide = pendingDecide()
    const BrokenBuiltin = () => { throw new Error('builtin failed') }
    render(<PermissionPresenterHost
      request={request}
      decide={decide}
      enableCustomPresenter
      manageLifecycle={false}
      presenter={{ key: 'security:permission', featureId: 'security', contributionId: 'permission', load: () => Promise.reject(new Error('custom failed')) }}
      builtinPresenter={BrokenBuiltin}
    />)

    expect(await screen.findByRole('alert')).toHaveTextContent(request.expiresAt)
    expect(decide).not.toHaveBeenCalled()
  })

  it('does not reset timeout on rerender and fails closed', () => {
    vi.useFakeTimers()
    const decide = pendingDecide()
    const view = render(<PermissionPresenterHost request={request} decide={decide} timeoutMs={1000} />)
    act(() => vi.advanceTimersByTime(700))
    view.rerender(<PermissionPresenterHost request={request} decide={decide} timeoutMs={1000} />)
    act(() => vi.advanceTimersByTime(300))
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', reason: 'timed-out' }))
    vi.useRealTimers()
  })

  it('closes the previous request without denying the next request on transition', async () => {
    const decide = pendingDecide()
    const nextRequest = { ...request, requestId: 'tc-2', toolCallId: 'tc-2' }
    const view = render(
      <PermissionPresenterHost request={request} decide={decide} />
    )

    view.rerender(
      <PermissionPresenterHost request={nextRequest} decide={decide} />
    )
    await act(async () => {})

    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestId: 'tc-1',
        decision: 'deny',
        reason: 'runtime-closed',
      })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Allow Once' })
    )
    expect(decide).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 'tc-2', decision: 'allow_once' })
    )
  })

  it.each(['pagehide', 'beforeunload'])('fails closed on %s', (eventName) => {
    const decide = pendingDecide()
    render(<PermissionPresenterHost request={request} decide={decide} />)
    fireEvent(window, new Event(eventName))
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', reason: 'runtime-closed' }))
  })

  it('fails closed when unmounted while still pending', async () => {
    const decide = pendingDecide()
    const view = render(<PermissionPresenterHost request={request} decide={decide} />)
    view.unmount()
    await act(async () => {})
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'deny',
      reason: 'runtime-closed',
    }))
  })

  it('passes only public request and decide props to a custom presenter', async () => {
    const decide = pendingDecide()
    const Custom = (props: PermissionPresenterProps) => <button onClick={() => void props.decide({ version: 1, runtimeInstanceId: props.request.runtimeInstanceId, runtimeId: props.request.runtimeId, runtimeEpoch: props.request.runtimeEpoch, sessionId: props.request.sessionId, threadId: props.request.threadId, runId: props.request.runId, requestId: props.request.requestId, toolCallId: props.request.toolCallId, decision: 'deny', reason: 'user-denied' })}>{Object.keys(props).sort().join(',')}</button>
    render(<PermissionPresenterHost request={request} decide={decide} enableCustomPresenter presenter={{
      key: 'security:permission', featureId: 'security', contributionId: 'permission',
      load: () => Promise.resolve({ sdkApiVersion: 1, permissionPresenters: { permission: Custom } }),
    }} />)
    const button = await screen.findByRole('button', { name: 'decide,request,surface,viewState' })
    fireEvent.click(button)
    expect(decide).toHaveBeenCalledOnce()
  })

  it('uses Builtin instead of selecting an ambiguous registry Presenter', async () => {
    const Custom = () => <div data-testid="ambiguous-presenter">Custom</div>
    const entry = (id: string) => {
      const base = createTestEntry({
        id,
        load: () =>
          Promise.resolve({
            sdkApiVersion: 1,
            permissionPresenters: { approval: Custom },
          }),
      })
      return {
        ...base,
        manifest: {
          ...base.manifest,
          contributions: {
            ...base.manifest.contributions,
            conversation: [
              {
                id: 'approval',
                kind: 'permission-presenter' as const,
                surfaces: ['main' as const],
              },
            ],
          },
        },
      }
    }
    const registry = createConversationContributionRegistry(
      [entry('security-one'), entry('security-two')],
      { target: 'desktop', surface: 'main' }
    )

    render(
      <PermissionPresenterHost
        request={request}
        decide={pendingDecide()}
        registry={registry}
        enableCustomPresenter
      />
    )
    await act(async () => {})

    expect(screen.queryByTestId('ambiguous-presenter')).not.toBeInTheDocument()
    expect(
      screen.getByText('This tool needs your approval before it runs.')
    ).toBeInTheDocument()
  })
})
