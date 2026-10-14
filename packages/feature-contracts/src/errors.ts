export const FEATURE_SERVICE_ERROR_CODES = [
  'cancelled',
  'offline',
  'timeout',
  'unauthorized',
  'incompatible',
  'unavailable',
  'provider_crashed',
  'resource_exhausted',
  'unknown',
] as const

export type FeatureServiceErrorCode =
  (typeof FEATURE_SERVICE_ERROR_CODES)[number]

export interface FeatureServiceErrorV1 {
  version: 1
  code: FeatureServiceErrorCode
  message: string
  retryable?: boolean
  diagnosticId?: string
}
