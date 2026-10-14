import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  FeatureManifestV1,
  PermissionDecisionReceiptV1,
  PermissionDecisionV1,
  PermissionRequestV1,
} from '@bibit/feature-contracts'
import type { FeatureHostApiV1, FeatureModuleV1 } from '@bibit/feature-sdk'
import storeManifestJson from '../../../../tests/fixtures/features/store/bibit.feature.json'
import memoryManifestJson from '../../../../tests/fixtures/features/memory/bibit.feature.json'
import securityManifestJson from '../../../../tests/fixtures/features/security/bibit.feature.json'
import { featureModule as storeModule } from '../../../../tests/fixtures/features/store/src/bibit-feature'
import { featureModule as memoryModule } from '../../../../tests/fixtures/features/memory/src/bibit-feature'
import { featureModule as securityModule } from '../../../../tests/fixtures/features/security/src/bibit-feature'
import { featureRegistry as productionRegistry } from '../generated/feature-registry.gen'
import {
  createFeatureRegistryProjection,
  type FeatureRegistrySourceEntry,
} from '../host/registry'
import { clearFeatureModuleCache } from '../host/loadFeatureModule'
import { FeaturePageHost } from '../host/FeaturePageHost'
import { FeatureSettingsHost } from '../host/FeatureSettingsHost'
import { createExternalServiceApi } from '../host-api'
import { createConversationContributionRegistry } from '../conversation/contributionRegistry'
import { PermissionPresenterHost } from '../conversation/PermissionPresenterHost'

const storeManifest = storeManifestJson as FeatureManifestV1
const memoryManifest = memoryManifestJson as FeatureManifestV1
const securityManifest = securityManifestJson as FeatureManifestV1

const entry = (
  manifest: FeatureManifestV1,
  module: FeatureModuleV1,
  load: () => Promise<unknown> = () => Promise.resolve({ featureModule: module })
): FeatureRegistrySourceEntry => ({
  packageName: `@bibit/feature-${manifest.id}`,
  manifest,
  load,
})

const fixtureEntries = [
  entry(storeManifest, storeModule),
  entry(memoryManifest, memoryModule),
  entry(securityManifest, securityModule),
] as const

const fixtureRegistry = createFeatureRegistryProjection(fixtureEntries, {
  target: 'desktop',
  surface: 'main',
})

const request: PermissionRequestV1 = {
  version: 1,
  runtimeInstanceId: 'fixture-runtime:epoch-1',
  requestId: 'request-1',
  runtimeId: 'fixture-runtime',
  runtimeEpoch: 'epoch-1',
  sessionId: 'thread-1',
  threadId: 'thread-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  action: { kind: 'tool', name: 'shell', summary: 'Run a command' },
  supportedDecisions: ['allow_once', 'deny'],
  createdAt: new Date(0).toISOString(),
  expiresAt: new Date(60_000).toISOString(),
}

afterEach(() => clearFeatureModuleCache())

describe('Feature SDK fixtures', () => {
  it('keeps proof fixtures out of the production Registry', () => {
    expect(
      productionRegistry.some((item) =>
        ['store', 'memory', 'security'].includes(item.manifest.id)
      )
    ).toBe(false)
    expect(fixtureRegistry.pages.map((item) => item.finalPath)).toContain(
      '/features/store'
    )
    expect(fixtureRegistry.settings.map((item) => item.finalPath)).toContain(
      '/settings/features/memory'
    )
  })

  it('contains an offline Store service and retries without affecting Memory', async () => {
    const user = userEvent.setup()
    const listAgents = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'OFFLINE' }))
      .mockResolvedValueOnce([{ id: 'agent-1', name: 'Writer' }])
    const storeService = createExternalServiceApi('store', {
      'list-agents': listAgents,
    })
    const hostApiFactory = (manifest: FeatureManifestV1): FeatureHostApiV1 => ({
      sdkApiVersion: 1,
      featureId: manifest.id,
      grantedCapabilities:
        manifest.id === 'store' ? ['external-service:store'] : [],
      getCapability: (capability) =>
        (capability === 'external-service:store' ? storeService : undefined) as never,
    })

    render(
      <>
        <FeaturePageHost
          registry={fixtureRegistry}
          featureId="store"
          routeSubpath=""
          search={{}}
          navigate={vi.fn()}
          back={vi.fn()}
          hostApiFactory={hostApiFactory}
        />
        <FeatureSettingsHost
          registry={fixtureRegistry}
          featureId="memory"
          routeSubpath="items/memory-42"
          search={{}}
          navigate={vi.fn()}
          back={vi.fn()}
        />
      </>
    )

    expect(await screen.findByText('Store service unavailable')).toBeInTheDocument()
    expect(screen.getByText('Memory memory-42')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Retry Store' })
    retry.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Writer')).toBeInTheDocument()
    expect(screen.getByText('Memory memory-42')).toBeInTheDocument()
    expect(listAgents).toHaveBeenCalledTimes(2)
  })

  it('restores a Memory detail deep link and navigates inside its namespace', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    render(
      <FeatureSettingsHost
        registry={fixtureRegistry}
        featureId="memory"
        routeSubpath="items/memory-42"
        search={{}}
        navigate={navigate}
        back={vi.fn()}
      />
    )

    expect(await screen.findByRole('heading', { name: 'Memory memory-42' })).toBeInTheDocument()
    const allMemories = screen.getByRole('button', { name: 'All memories' })
    allMemories.focus()
    await user.keyboard('{Enter}')
    expect(navigate).toHaveBeenCalledWith({
      to: '/settings/features/$featureId/$',
      params: { featureId: 'memory', _splat: '' },
      search: undefined,
      replace: true,
    })
  })

  it('contains a lazy fixture failure and recovers on retry', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({ featureModule: storeModule })
    const registry = createFeatureRegistryProjection(
      [entry(storeManifest, storeModule, load)],
      { target: 'desktop', surface: 'main' }
    )

    render(
      <FeaturePageHost
        registry={registry}
        featureId="store"
        routeSubpath=""
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )

    expect(await screen.findByText('Feature could not be loaded')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'Agent Store' })).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('selects one Security presenter and makes repeated decisions idempotent', async () => {
    const user = userEvent.setup()
    const conversationRegistry = createConversationContributionRegistry(
      fixtureEntries,
      { target: 'desktop', surface: 'main' }
    )
    const presenter = conversationRegistry.getPermissionPresenter()
    const decide = vi.fn(
      async (
        decision: PermissionDecisionV1
      ): Promise<PermissionDecisionReceiptV1> => ({
        version: 1,
        runtimeInstanceId: decision.runtimeInstanceId,
        runtimeId: decision.runtimeId,
        runtimeEpoch: decision.runtimeEpoch,
        sessionId: decision.sessionId,
        threadId: decision.threadId,
        runId: decision.runId,
        requestId: decision.requestId,
        toolCallId: decision.toolCallId,
        decision: decision.decision,
        status: 'accepted',
      })
    )

    expect(presenter?.key).toBe('security:approval')
    render(
      <PermissionPresenterHost
        request={request}
        decide={decide}
        presenter={presenter}
        enableCustomPresenter
      />
    )

    const allow = await screen.findByRole('button', { name: 'Allow once' })
    allow.focus()
    await user.keyboard('{Enter}')
    fireEvent.click(allow)
    expect(decide).toHaveBeenCalledOnce()
    expect(decide).toHaveBeenCalledWith({
      version: 1,
      requestId: 'request-1',
      runtimeInstanceId: 'fixture-runtime:epoch-1',
      runtimeId: 'fixture-runtime',
      runtimeEpoch: 'epoch-1',
      sessionId: 'thread-1',
      threadId: 'thread-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      decision: 'allow_once',
    })
  })

  it('renders the Security rules editor as an isolated settings contribution', async () => {
    const user = userEvent.setup()
    render(
      <FeatureSettingsHost
        registry={fixtureRegistry}
        featureId="security"
        routeSubpath=""
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )

    expect(
      await screen.findByRole('heading', { name: 'Agent 安全规则' })
    ).toBeInTheDocument()
    expect(screen.getByText('读取 SSH 私钥')).toBeInTheDocument()
    expect(screen.getByText('执行系统命令')).toBeInTheDocument()

    const commandRule = screen.getByRole('checkbox', {
      name: '执行系统命令',
    })
    expect(commandRule).toBeChecked()
    await user.click(commandRule)
    expect(commandRule).not.toBeChecked()
    expect(screen.getByText('存在未保存的更改')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存规则' }))
    expect(screen.getByText('规则已保存到模拟安全服务')).toBeInTheDocument()
  })

  it('keeps permission interaction available while a custom presenter fails', async () => {
    const decide = vi.fn()
    render(
      <PermissionPresenterHost
        request={request}
        decide={decide}
        enableCustomPresenter
        presenter={{
          key: 'security:approval',
          featureId: 'security',
          contributionId: 'approval',
          load: () => Promise.reject(new Error('security unavailable')),
        }}
      />
    )

    expect(
      await screen.findByText('This tool needs your approval before it runs.')
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Deny' })
    )
    await waitFor(() => expect(decide).toHaveBeenCalledOnce())
  })

  it('fails closed when both Security and Builtin presenters fail', async () => {
    const decide = vi.fn()
    const BrokenBuiltin = () => {
      throw new Error('builtin unavailable')
    }
    render(
      <PermissionPresenterHost
        request={request}
        decide={decide}
        enableCustomPresenter
        presenter={{
          key: 'security:approval',
          featureId: 'security',
          contributionId: 'approval',
          load: () => Promise.reject(new Error('security unavailable')),
        }}
        builtinPresenter={BrokenBuiltin}
      />
    )

    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'request-1',
          decision: 'deny',
          reason: 'presenter-failed',
        })
      )
    )
  })
})
