import { invoke } from '@tauri-apps/api/core'
import { featureRegistry } from './generated/feature-registry.gen'
import { mergeFeatureRegistryEntries } from './activeFeatureRegistry.shared'
import type {
  FeatureInstanceBootstrapV1,
  FeatureRegistrySourceEntry,
} from './host/registry'

type ActiveFeatureRegistryEntry = FeatureRegistrySourceEntry

type BootstrapStaticFeature = (
  entry: ActiveFeatureRegistryEntry
) => Promise<FeatureInstanceBootstrapV1>

const requiresNativeInstance = (entry: ActiveFeatureRegistryEntry) =>
  entry.manifest.requiredHostCapabilities.some(
    (capability) =>
      capability.startsWith('service:') ||
      capability.startsWith('external-service:') ||
      capability === 'file:transfer' ||
      capability === 'job:manage'
  )

export const bootstrapStaticFeatureEntries = async (
  entries: readonly ActiveFeatureRegistryEntry[],
  bootstrap: BootstrapStaticFeature = ({ manifest }) =>
    invoke<FeatureInstanceBootstrapV1>('static_feature_bootstrap', {
      request: {
        featureId: manifest.id,
        pluginVersion: manifest.version,
      },
    })
): Promise<readonly ActiveFeatureRegistryEntry[]> =>
  Object.freeze(
    (await Promise.all(
      entries.map(async (entry) => {
        if (!requiresNativeInstance(entry) || entry.featureInstanceToken) {
          return entry
        }
        try {
          const instance = await bootstrap(entry)
          if (
            instance.featureId !== entry.manifest.id ||
            instance.pluginVersion !== entry.manifest.version ||
            !instance.featureInstanceToken
          ) {
            throw new Error('Static Feature bootstrap identity mismatch')
          }
          return Object.freeze({
            ...entry,
            featureInstanceToken: instance.featureInstanceToken,
          })
        } catch (error) {
          console.error(
            `Failed to bootstrap static Feature ${entry.manifest.id}@${entry.manifest.version}:`,
            error
          )
          // A sensitive static Feature without a Native instance must not be
          // exposed as a partially working entry.
          return null
        }
      })
    )).filter((entry): entry is ActiveFeatureRegistryEntry => entry !== null)
  )

let staticFeatureRegistry: readonly ActiveFeatureRegistryEntry[] =
  featureRegistry

export let activeFeatureRegistry: readonly ActiveFeatureRegistryEntry[] =
  staticFeatureRegistry

export const bootstrapStaticFeatureRegistry = async () => {
  staticFeatureRegistry = await bootstrapStaticFeatureEntries(
    staticFeatureRegistry
  )
  activeFeatureRegistry = staticFeatureRegistry
}

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
