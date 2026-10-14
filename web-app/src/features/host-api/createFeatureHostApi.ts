import type {
  FeatureHostApiV1,
  FeatureHostCapabilityApiV1,
  FeatureHostCapabilityApisV1,
  FeatureServiceApiV1,
} from '@bibit/feature-sdk'
import type {
  FeatureHostCapability,
  FeatureManifestV1,
} from '@bibit/feature-contracts'

export type FeatureCapabilityRegistry = Partial<FeatureHostCapabilityApisV1> &
  Partial<Record<`service:${string}`, FeatureServiceApiV1<string>>>

export interface CreateFeatureHostApiOptions {
  manifest: FeatureManifestV1
  targetAvailable: boolean
  grants: readonly FeatureHostCapability[]
  capabilities: FeatureCapabilityRegistry
}

export const createFeatureHostApi = ({
  manifest,
  targetAvailable,
  grants,
  capabilities,
}: CreateFeatureHostApiOptions): FeatureHostApiV1 => {
  const grantedCapabilities = targetAvailable
    ? manifest.requiredHostCapabilities.filter(
        (capability) =>
          grants.includes(capability) && capability in capabilities
      )
    : []
  return {
    sdkApiVersion: 1,
    featureId: manifest.id,
    grantedCapabilities,
    getCapability: <K extends FeatureHostCapability>(capability: K) =>
      (grantedCapabilities.includes(capability)
        ? capabilities[capability as keyof FeatureHostCapabilityApisV1]
        : undefined) as FeatureHostCapabilityApiV1<K> | undefined,
  }
}
