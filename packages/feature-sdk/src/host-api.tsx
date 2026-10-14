import type { ReactNode } from 'react'
import { createContext, createElement, useContext } from 'react'
import type {
  ExternalServiceIdV1,
  FileGrantPublishRequestV1,
  FileGrantRequestV1,
  FileGrantV1,
  FeatureHostCapability,
  FeatureHostActionRegistryV1,
  FeatureHostActionResultV1,
  FeatureManifestV1,
  ServiceJobCancelRequestV1,
  ServiceJobEventBatchV1,
  ServiceJobSnapshotV1,
  ServiceJobStartRequestV1,
  ServiceJobStartResultV1,
  ServiceJobSubscriptionV1,
  FeatureServiceErrorV1 as FeatureServiceErrorContractV1,
} from '@bibit/feature-contracts'

export type FeatureExternalServiceIdV1 = ExternalServiceIdV1
export type FeatureServiceIdV1 = ExternalServiceIdV1

export interface FeatureServiceRequestV1<
  TServiceId extends FeatureServiceIdV1,
> {
  serviceId: TServiceId
  operationId: string
  params: Readonly<Record<string, unknown>>
  timeoutMs?: number
  signal?: AbortSignal
}

export interface FeatureServiceApiV1<
  TServiceId extends FeatureServiceIdV1,
> {
  request<TResult = unknown>(
    input: FeatureServiceRequestV1<TServiceId>
  ): Promise<TResult>
}

/** @deprecated Use FeatureServiceRequestV1. */
export type FeatureExternalServiceRequestV1<
  TServiceId extends FeatureExternalServiceIdV1,
> = FeatureServiceRequestV1<TServiceId>
/** @deprecated Use FeatureServiceApiV1. */
export type FeatureExternalServiceApiV1<
  TServiceId extends FeatureExternalServiceIdV1,
> = FeatureServiceApiV1<TServiceId>
export type FeatureServiceErrorV1 = FeatureServiceErrorContractV1
/** @deprecated Use FeatureServiceErrorV1. */
export type FeatureExternalServiceErrorV1 = FeatureServiceErrorV1

export interface FeatureFileTransferApiV1 {
  select(input: FileGrantRequestV1): Promise<FileGrantV1 | null>
  publish(input: FileGrantPublishRequestV1): Promise<void>
}

export interface FeatureHostActionApiV1 {
  invoke<TAction extends keyof FeatureHostActionRegistryV1>(
    action: TAction,
    input: FeatureHostActionRegistryV1[TAction]['input']
  ): Promise<FeatureHostActionResultV1>
}

export interface FeatureServiceJobsApiV1 {
  availability(serviceId: string): Promise<{
    available: boolean
    reason?: 'provider_v2_unavailable' | 'provider_unavailable'
  }>
  start(input: ServiceJobStartRequestV1): Promise<ServiceJobStartResultV1>
  get(jobId: string): Promise<ServiceJobSnapshotV1>
  list(serviceId: string): Promise<readonly ServiceJobSnapshotV1[]>
  events(input: ServiceJobSubscriptionV1): Promise<ServiceJobEventBatchV1>
  cancel(input: ServiceJobCancelRequestV1): Promise<ServiceJobSnapshotV1>
  subscribe(
    input: ServiceJobSubscriptionV1,
    listener: (batch: ServiceJobEventBatchV1) => void
  ): () => void
}

export interface FeatureHostCapabilityApisV1 {
  'file:transfer': FeatureFileTransferApiV1
  'host:actions': FeatureHostActionApiV1
  'job:manage': FeatureServiceJobsApiV1
  'service:store': FeatureServiceApiV1<'store'>
  'service:memory': FeatureServiceApiV1<'memory'>
  'service:security': FeatureServiceApiV1<'security'>
  'external-service:store': FeatureExternalServiceApiV1<'store'>
  'external-service:memory': FeatureExternalServiceApiV1<'memory'>
  'external-service:security': FeatureExternalServiceApiV1<'security'>
}

export type FeatureHostCapabilityApiV1<K extends FeatureHostCapability> =
  K extends `service:${infer TServiceId}`
    ? FeatureServiceApiV1<TServiceId>
    : K extends `external-service:${infer TServiceId}`
      ? FeatureExternalServiceApiV1<TServiceId>
      : K extends keyof FeatureHostCapabilityApisV1
        ? FeatureHostCapabilityApisV1[K]
        : unknown

export interface FeatureHostApiV1 {
  sdkApiVersion: 1
  featureId: FeatureManifestV1['id']
  grantedCapabilities: readonly FeatureHostCapability[]
  getCapability<K extends FeatureHostCapability>(
    capability: K
  ): FeatureHostCapabilityApiV1<K> | undefined
}

const FeatureHostApiContext = createContext<FeatureHostApiV1 | undefined>(
  undefined
)

export interface FeatureHostApiProviderProps {
  value: FeatureHostApiV1
  children?: ReactNode
}

export function FeatureHostApiProvider({
  value,
  children,
}: FeatureHostApiProviderProps) {
  return createElement(FeatureHostApiContext.Provider, { value }, children)
}

export function useFeatureHostApi(): FeatureHostApiV1 {
  const hostApi = useContext(FeatureHostApiContext)
  if (!hostApi) {
    throw new Error('useFeatureHostApi must be used within FeatureHostApiProvider')
  }
  return hostApi
}

export function useFeatureCapability<K extends FeatureHostCapability>(
  capability: K
): FeatureHostCapabilityApiV1<K> | undefined {
  return useFeatureHostApi().getCapability(capability)
}
