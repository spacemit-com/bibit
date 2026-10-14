import { invoke } from '@tauri-apps/api/core'
import type { FeatureHostApiV1 } from '@bibit/feature-sdk'
import type {
  ExternalServiceGatewayRequestV1,
  ExternalServiceGatewayResponseV1,
  ExternalServiceIdV1,
  FeatureHostCapability,
  FeatureManifestV1,
} from '@bibit/feature-contracts'
import {
  EXTERNAL_SERVICE_IDS,
  isSameOperation,
} from '@bibit/feature-contracts'
import grantsConfig from '../../../../config/feature-capability-grants.json'
import { createFeatureHostApi, type FeatureCapabilityRegistry } from './createFeatureHostApi'
import { createExternalServiceGatewayApi } from './externalService'
import { createFileTransferApi } from './fileTransfer'
import { createHostActionsApi, type HostActionContext } from './hostActions'
import { createServiceJobsApi } from './serviceJobs'

export type FeatureHostApiFactory = (
  manifest: FeatureManifestV1,
  targetAvailable: boolean,
  featureInstanceToken?: string,
  hostActions?: HostActionContext
) => FeatureHostApiV1

const configuredGrants = grantsConfig as {
  readonly version: 1
  readonly features: Readonly<Record<string, readonly FeatureHostCapability[]>>
  readonly serviceOperations?: Readonly<
    Record<string, Partial<Record<ExternalServiceIdV1, readonly string[]>>>
  >
}

export interface FeatureCapabilityGrantsV1 {
  readonly version: 1
  readonly features: Readonly<Record<string, readonly FeatureHostCapability[]>>
  readonly serviceOperations?: Readonly<
    Record<string, Partial<Record<ExternalServiceIdV1, readonly string[]>>>
  >
}

let runtimeGrants: FeatureCapabilityGrantsV1 = {
  version: 1,
  features: {},
  serviceOperations: {},
}

export const setRuntimeFeatureCapabilityGrants = (
  grants: FeatureCapabilityGrantsV1
) => {
  runtimeGrants = grants
}

export const loadRuntimeFeatureCapabilityGrants = async () => {
  try {
    setRuntimeFeatureCapabilityGrants(
      await invoke<FeatureCapabilityGrantsV1>(
        'feature_capability_grants_list'
      )
    )
  } catch {
    // Browser-only development uses the compiled defaults.
  }
}

const featureGrants = (featureId: string) => {
  const capabilities = [
    ...new Set([
      ...(configuredGrants.features[featureId] ?? []),
      ...(runtimeGrants.features[featureId] ?? []),
    ]),
  ]
  const configuredOperations =
    configuredGrants.serviceOperations?.[featureId] ?? {}
  const runtimeOperations = runtimeGrants.serviceOperations?.[featureId] ?? {}
  const serviceIds = [
    ...new Set([
      ...Object.keys(configuredOperations),
      ...Object.keys(runtimeOperations),
    ]),
  ]
  const serviceOperations = Object.fromEntries(
    serviceIds.map((serviceId) => [
      serviceId,
      [
        ...new Set([
          ...(configuredOperations[serviceId] ?? []),
          ...(runtimeOperations[serviceId] ?? []),
        ]),
      ],
    ])
  )
  return { capabilities, serviceOperations }
}

export type ExternalServiceGatewayInvoke = (
  request: ExternalServiceGatewayRequestV1,
  signal: AbortSignal
) => Promise<ExternalServiceGatewayResponseV1>

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export interface FeatureServiceContext {
  readonly featureId: string
  readonly pluginVersion: string
  readonly featureInstanceToken: string
}

export const createTauriServiceGatewayInvoke = (
  context: FeatureServiceContext,
  tauriInvoke: TauriInvoke = invoke
): ExternalServiceGatewayInvoke =>
  (request, signal) => {
    const cancel = () => {
      void tauriInvoke<boolean>('external_service_cancel', {
        request: {
          ...context,
          serviceId: request.serviceId,
          operationId: request.operationId,
          requestId: request.requestId,
        },
      }).catch(() => undefined)
    }
    signal.addEventListener('abort', cancel, { once: true })
    return tauriInvoke<ExternalServiceGatewayResponseV1>(
      'external_service_request',
      { request: { ...context, ...request } }
    ).finally(() => signal.removeEventListener('abort', cancel))
  }

export const createGatewayCapabilities = (
  invokeRequest: ExternalServiceGatewayInvoke,
  allowedOperations?: Partial<Record<ExternalServiceIdV1, readonly string[]>>,
  serviceIds: readonly ExternalServiceIdV1[] = EXTERNAL_SERVICE_IDS
): FeatureCapabilityRegistry => {
  const transport = (serviceId: ExternalServiceIdV1) =>
    (request: ExternalServiceGatewayRequestV1, signal: AbortSignal) => {
      const operations = allowedOperations?.[serviceId]
      if (
        operations &&
        !operations.some((operation) =>
          isSameOperation(operation, request.operationId)
        )
      ) {
        return Promise.resolve({
          protocolVersion: 1 as const,
          requestId: request.requestId,
          ok: false as const,
          error: {
            code: 'unauthorized' as const,
            message: 'The service operation is not granted',
            retryable: false,
          },
        })
      }
      return invokeRequest(request, signal)
    }
  const capabilities: FeatureCapabilityRegistry = {}
  const dynamicCapabilities = capabilities as Record<string, unknown>
  for (const serviceId of new Set(serviceIds)) {
    const service = createExternalServiceGatewayApi(
      serviceId,
      transport(serviceId)
    )
    capabilities[`service:${serviceId}`] = service
    if (
      EXTERNAL_SERVICE_IDS.includes(
        serviceId as (typeof EXTERNAL_SERVICE_IDS)[number]
      )
    ) {
      dynamicCapabilities[`external-service:${serviceId}`] = service
    }
  }
  return capabilities
}

export const createDefaultFeatureHostApi: FeatureHostApiFactory = (
  manifest,
  targetAvailable,
  featureInstanceToken,
  hostActions
) => {
  const grants = featureGrants(manifest.id)
  const hostCapabilities: FeatureCapabilityRegistry = featureInstanceToken
    ? createGatewayCapabilities(
        createTauriServiceGatewayInvoke({
          featureId: manifest.id,
          pluginVersion: manifest.version,
          featureInstanceToken,
        }),
        grants.serviceOperations,
        Object.keys(grants.serviceOperations)
      )
    : {}
  if (featureInstanceToken) {
    hostCapabilities['file:transfer'] = createFileTransferApi(
      manifest.id,
      manifest.version,
      featureInstanceToken
    )
    hostCapabilities['job:manage'] = createServiceJobsApi(
      manifest.id,
      manifest.version,
      featureInstanceToken
    )
  }
  if (hostActions) {
    hostCapabilities['host:actions'] = createHostActionsApi(hostActions)
  }
  return createFeatureHostApi({
    manifest,
    targetAvailable,
    grants: grants.capabilities,
    capabilities: hostCapabilities,
  })
}

export { createFeatureHostApi } from './createFeatureHostApi'
export { createExternalServiceApi } from './externalService'
export { createFileTransferApi } from './fileTransfer'
export { createServiceJobsApi } from './serviceJobs'
