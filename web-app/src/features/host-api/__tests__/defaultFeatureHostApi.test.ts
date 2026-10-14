import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ExternalServiceGatewayRequestV1,
  ExternalServiceGatewayResponseV1,
  FeatureManifestV1,
} from '@bibit/feature-contracts'
import {
  createDefaultFeatureHostApi,
  createGatewayCapabilities,
  createTauriServiceGatewayInvoke,
  setRuntimeFeatureCapabilityGrants,
} from '../index'

const agentHubManifest: FeatureManifestV1 = {
  manifestSchemaVersion: 1,
  sdkApiVersion: 1,
  id: 'agent-hub',
  version: '0.1.0',
  owner: 'agent-hub-team',
  display: {
    titleKey: 'agent-hub:title',
    fallbackTitle: 'Agent Hub',
    iconKey: 'store',
  },
  targets: ['desktop'],
  requiredHostCapabilities: ['external-service:store'],
  contributions: {
    pages: [],
    settings: [],
    conversation: [],
    locales: ['en'],
  },
}

describe('default feature host API', () => {
  afterEach(() => {
    setRuntimeFeatureCapabilityGrants({
      version: 1,
      features: {},
      serviceOperations: {},
    })
  })

  it('grants registered external services approved for the feature', () => {
    const hostApi = createDefaultFeatureHostApi(
      agentHubManifest,
      true,
      'instance-1'
    )
    expect(hostApi.grantedCapabilities).toEqual(['external-service:store'])
    expect(hostApi.getCapability('external-service:store')).toBeDefined()
  })

  it('does not expose native services without an active feature instance', () => {
    const hostApi = createDefaultFeatureHostApi(agentHubManifest, true)

    expect(hostApi.grantedCapabilities).toEqual([])
    expect(hostApi.getCapability('external-service:store')).toBeUndefined()
  })

  it('routes service calls through the single gateway transport', async () => {
    const invokeRequest = vi.fn(async (request: ExternalServiceGatewayRequestV1) => ({
      protocolVersion: 1 as const,
      requestId: request.requestId,
      ok: true as const,
      result: { items: [] },
    }))
    const capabilities = createGatewayCapabilities(invokeRequest)

    expect(capabilities['service:store']).toBe(
      capabilities['external-service:store']
    )

    await expect(
      capabilities['external-service:store'].request({
        serviceId: 'store',
        operationId: 'agents.list.v1',
        params: {},
      })
    ).resolves.toEqual({ items: [] })
    expect(invokeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: 1,
        serviceId: 'store',
        operationId: 'agents.list.v1',
      }),
      expect.any(AbortSignal)
    )
  })

  it('blocks operations outside the feature service grant', async () => {
    const invokeRequest = vi.fn()
    const capabilities = createGatewayCapabilities(invokeRequest, {
      store: ['agents.list.v1'],
    })

    await expect(
      capabilities['service:store']!.request({
        serviceId: 'store',
        operationId: 'agents.delete.v1',
        params: {},
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(invokeRequest).not.toHaveBeenCalled()
  })

  it('matches a granted operation regardless of its release suffix', async () => {
    const invokeRequest = vi.fn(async (request: ExternalServiceGatewayRequestV1) => ({
      protocolVersion: 1 as const,
      requestId: request.requestId,
      ok: true as const,
      result: { ready: true },
    }))
    const capabilities = createGatewayCapabilities(invokeRequest, {
      store: ['agents.list.v1'],
    })

    await expect(
      capabilities['service:store']!.request({
        serviceId: 'store',
        operationId: 'agents.list',
        params: {},
      })
    ).resolves.toEqual({ ready: true })
    expect(invokeRequest).toHaveBeenCalledOnce()
  })

  it('creates capabilities for newly registered service ids', async () => {
    const invokeRequest = vi.fn(async (request: ExternalServiceGatewayRequestV1) => ({
      protocolVersion: 1 as const,
      requestId: request.requestId,
      ok: true as const,
      result: { ready: true },
    }))
    const capabilities = createGatewayCapabilities(
      invokeRequest,
      { 'knowledge-index': ['documents.search.v1'] },
      ['knowledge-index']
    )

    await expect(
      capabilities['service:knowledge-index']!.request({
        serviceId: 'knowledge-index',
        operationId: 'documents.search.v1',
        params: { query: 'Bibit' },
      })
    ).resolves.toEqual({ ready: true })
    expect(
      (capabilities as Record<string, unknown>)[
        'external-service:knowledge-index'
      ]
    ).toBeUndefined()
  })

  it('loads new plugin services from runtime capability grants', () => {
    const manifest: FeatureManifestV1 = {
      ...agentHubManifest,
      id: 'knowledge-tools',
      requiredHostCapabilities: ['service:knowledge-index'],
    }
    setRuntimeFeatureCapabilityGrants({
      version: 1,
      features: {
        'knowledge-tools': ['service:knowledge-index'],
      },
      serviceOperations: {
        'knowledge-tools': {
          'knowledge-index': ['documents.search.v1'],
        },
      },
    })

    const hostApi = createDefaultFeatureHostApi(
      manifest,
      true,
      'knowledge-instance'
    )

    expect(hostApi.grantedCapabilities).toEqual(['service:knowledge-index'])
    expect(hostApi.getCapability('service:knowledge-index')).toBeDefined()
  })

  it('only exposes native transfer APIs to an active feature instance', () => {
    const manifest: FeatureManifestV1 = {
      ...agentHubManifest,
      requiredHostCapabilities: [
        'service:store',
        'file:transfer',
        'job:manage',
      ],
    }
    setRuntimeFeatureCapabilityGrants({
      version: 1,
      features: {
        'agent-hub': ['service:store', 'file:transfer', 'job:manage'],
      },
      serviceOperations: {
        'agent-hub': { store: ['agents.upload.v1'] },
      },
    })

    expect(
      createDefaultFeatureHostApi(manifest, true).getCapability('job:manage')
    ).toBeUndefined()
    const active = createDefaultFeatureHostApi(manifest, true, 'instance-1')
    expect(active.getCapability('file:transfer')).toBeDefined()
    expect(active.getCapability('job:manage')).toBeDefined()
  })

  it('only exposes host actions when the host can actually serve them', () => {
    const manifest: FeatureManifestV1 = {
      ...agentHubManifest,
      requiredHostCapabilities: ['host:actions'],
    }
    setRuntimeFeatureCapabilityGrants({
      version: 1,
      features: { 'agent-hub': ['host:actions'] },
      serviceOperations: {},
    })

    expect(
      createDefaultFeatureHostApi(manifest, true).getCapability('host:actions')
    ).toBeUndefined()
    const served = createDefaultFeatureHostApi(manifest, true, undefined, {
      navigate: vi.fn(),
    })
    expect(served.getCapability('host:actions')).toBeDefined()
  })

  it('forwards aborts to the native request cancellation command', async () => {
    let resolveRequest!: (value: ExternalServiceGatewayResponseV1) => void
    const tauriInvoke = vi.fn((command: string) => {
      if (command === 'external_service_cancel') return Promise.resolve(true)
      return new Promise<ExternalServiceGatewayResponseV1>((resolve) => {
        resolveRequest = resolve
      })
    })
    const request: ExternalServiceGatewayRequestV1 = {
      protocolVersion: 1,
      requestId: 'cancel-me',
      serviceId: 'store',
      operationId: 'agents.list.v1',
      params: {},
      timeoutMs: 10_000,
    }
    const controller = new AbortController()

    const pending = createTauriServiceGatewayInvoke(
      {
        featureId: 'agent-hub',
        pluginVersion: '0.1.0',
        featureInstanceToken: 'instance-1',
      },
      tauriInvoke
    )(request, controller.signal)
    controller.abort()

    expect(tauriInvoke).toHaveBeenCalledWith('external_service_cancel', {
      request: {
        featureId: 'agent-hub',
        pluginVersion: '0.1.0',
        featureInstanceToken: 'instance-1',
        serviceId: 'store',
        operationId: 'agents.list.v1',
        requestId: 'cancel-me',
      },
    })
    expect(tauriInvoke).toHaveBeenCalledWith('external_service_request', {
      request: {
        featureId: 'agent-hub',
        pluginVersion: '0.1.0',
        featureInstanceToken: 'instance-1',
        ...request,
      },
    })
    resolveRequest({
      protocolVersion: 1,
      requestId: 'cancel-me',
      ok: false,
      error: { code: 'cancelled', message: 'Request cancelled', retryable: false },
    })
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })
})
