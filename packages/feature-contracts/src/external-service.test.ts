import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_SERVICE_IDS,
  EXTERNAL_SERVICE_PROTOCOL_VERSION,
  EXTERNAL_SERVICE_PROTOCOL_VERSIONS,
  type ExternalServiceProviderInitializeResultV2,
  type ExternalServiceGatewayRequestV1,
  type ExternalServiceGatewayResponseV1,
} from './external-service'

describe('external service protocol v1', () => {
  it('keeps the gateway envelope versioned and service ids closed', () => {
    const request: ExternalServiceGatewayRequestV1 = {
      protocolVersion: 1,
      requestId: 'request-1',
      serviceId: 'store',
      operationId: 'agents.list.v1',
      params: { limit: 20 },
      timeoutMs: 15_000,
    }
    const response: ExternalServiceGatewayResponseV1 = {
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      result: { items: [] },
    }

    expect(EXTERNAL_SERVICE_PROTOCOL_VERSION).toBe(1)
    expect(EXTERNAL_SERVICE_IDS).toEqual(['store', 'memory', 'security'])
    expect(response.requestId).toBe(request.requestId)
  })

  it('adds v2 job negotiation without changing v1', () => {
    const initialize: ExternalServiceProviderInitializeResultV2 = {
      protocolVersion: 2,
      providerVersion: 'demo-1',
      capabilities: {
        invoke: true,
        jobs: true,
        cancellation: true,
        maxConcurrentJobs: 1,
      },
      operations: ['agents.upload.v1', 'agents.download.v1'],
    }

    expect(EXTERNAL_SERVICE_PROTOCOL_VERSION).toBe(1)
    expect(EXTERNAL_SERVICE_PROTOCOL_VERSIONS).toEqual([1, 2])
    expect(initialize.capabilities.maxConcurrentJobs).toBe(1)
  })
})
