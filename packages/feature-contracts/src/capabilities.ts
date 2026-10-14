// Capabilities the host actually implements; `service:<kebab-id>` is an
// extensible namespace. Every entry here must have a matching implementation in
// the host's FeatureCapabilityRegistry.
export const FEATURE_HOST_CAPABILITIES = [
  'service:store',
  'service:memory',
  'service:security',
  'external-service:store',
  'external-service:memory',
  'external-service:security',
  'file:transfer',
  'job:manage',
  'host:actions',
] as const

/**
 * Manifest-only declarations. A Feature may state that it takes part in a
 * platform protocol, but the host publishes no API for these, so
 * `getCapability(...)` always returns `undefined`. They exist for manifest-level
 * governance and grant auditing. Promoting one of them into
 * FEATURE_HOST_CAPABILITIES requires a host implementation, a typed entry in
 * FeatureHostCapabilityApisV1 and a negative test.
 */
export const FEATURE_DECLARATION_ONLY_CAPABILITIES = [
  'runtime:permission',
] as const

export type FeatureServiceCapability = `service:${string}`
export type FeatureHostCapability =
  | FeatureServiceCapability
  | (typeof FEATURE_HOST_CAPABILITIES)[number]
  | (typeof FEATURE_DECLARATION_ONLY_CAPABILITIES)[number]

export const EXPERIMENTAL_FEATURE_HOST_CAPABILITIES = [
  'service:store',
  'service:memory',
  'service:security',
  'external-service:store',
  'external-service:memory',
  'external-service:security',
  'file:transfer',
  'job:manage',
  'host:actions',
] as const satisfies readonly FeatureHostCapability[]
