import type { FeatureServiceErrorCode } from './errors'

export const EXTERNAL_SERVICE_PROTOCOL_VERSION = 1 as const
export const EXTERNAL_SERVICE_PROTOCOL_VERSIONS = [1, 2] as const

export const EXTERNAL_SERVICE_IDS = ['store', 'memory', 'security'] as const

export type LegacyExternalServiceIdV1 = (typeof EXTERNAL_SERVICE_IDS)[number]
export type ExternalServiceIdV1 = string

export interface ExternalServiceGatewayRequestV1 {
  protocolVersion: 1
  requestId: string
  serviceId: ExternalServiceIdV1
  operationId: string
  params: Readonly<Record<string, unknown>>
  timeoutMs: number
}

export interface ExternalServiceGatewayErrorV1 {
  code: FeatureServiceErrorCode
  message: string
  retryable: boolean
}

export type ExternalServiceGatewayResponseV1 =
  | {
      protocolVersion: 1
      requestId: string
      ok: true
      result: unknown
    }
  | {
      protocolVersion: 1
      requestId: string
      ok: false
      error: ExternalServiceGatewayErrorV1
    }

export interface ExternalServiceProviderInitializeResultV1 {
  protocolVersion: 1
  providerVersion: string
  capabilities: { invoke: true }
  operations: readonly string[]
}

export interface ExternalServiceProviderInitializeResultV2 {
  protocolVersion: 2
  providerVersion: string
  capabilities: {
    invoke: true
    jobs: true
    cancellation: true
    maxConcurrentJobs: number
  }
  operations: readonly string[]
}

export type ExternalServiceProviderInitializeResult =
  | ExternalServiceProviderInitializeResultV1
  | ExternalServiceProviderInitializeResultV2
