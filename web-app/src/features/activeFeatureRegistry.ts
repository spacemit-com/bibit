import type { FeatureManifestV1 } from '@bibit/feature-contracts'
import securityManifestJson from './demo/security.feature.json'
import { featureRegistry } from './generated/feature-registry.gen'
import { mergeFeatureRegistryEntries } from './activeFeatureRegistry.shared'
import type { FeatureRegistrySourceEntry } from './host/registry'

export type ActiveFeatureRegistryEntry = FeatureRegistrySourceEntry

export const securityDemoFeatureEntry: ActiveFeatureRegistryEntry = Object.freeze({
  packageName: '@bibit/feature-security-demo',
  manifest: securityManifestJson as FeatureManifestV1,
  load: () => {
    if (!BIBIT_SECURITY_DEMO) {
      return Promise.reject(new Error('Security demo is disabled'))
    }
    return import('./demo/securityFeatureModule')
  },
})

export const createActiveFeatureRegistry = (
  entries: readonly ActiveFeatureRegistryEntry[],
  securityDemoEnabled: boolean
): readonly ActiveFeatureRegistryEntry[] =>
  Object.freeze(
    securityDemoEnabled ? [...entries, securityDemoFeatureEntry] : [...entries]
  )

const staticFeatureRegistry = createActiveFeatureRegistry(
  featureRegistry,
  BIBIT_SECURITY_DEMO
)

export let activeFeatureRegistry: readonly ActiveFeatureRegistryEntry[] =
  staticFeatureRegistry

// Development-only built-ins do not receive production Native instances.
export const bootstrapStaticFeatureRegistry = async () => {}

export const setRuntimeFeatureRegistry = (
  entries: readonly ActiveFeatureRegistryEntry[]
) => {
  const result = mergeFeatureRegistryEntries(staticFeatureRegistry, entries)
  for (const rejection of result.rejections) {
    console.error('Rejected Feature Registry entry', rejection)
  }
  activeFeatureRegistry = result.entries
  return result.rejections
}
