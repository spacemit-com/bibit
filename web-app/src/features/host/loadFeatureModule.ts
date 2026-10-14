import type { FeatureModuleV1 } from '@bibit/feature-sdk'
import type { FeatureRegistrySourceEntry } from './registry'

const cache = new Map<string, Promise<FeatureModuleV1>>()

const isModule = (value: unknown): value is FeatureModuleV1 =>
  typeof value === 'object' && value !== null && 'sdkApiVersion' in value

export const unwrapFeatureModule = (value: unknown): FeatureModuleV1 => {
  const namespace = value as {
    default?: unknown
    featureModule?: unknown
  }
  const module = isModule(value)
    ? value
    : isModule(namespace?.featureModule)
      ? namespace.featureModule
      : namespace?.default
  if (!isModule(module) || module.sdkApiVersion !== 1) {
    throw new Error('Feature module uses an unsupported SDK API version')
  }
  return module
}

export const loadFeatureModule = (
  entry: FeatureRegistrySourceEntry
): Promise<FeatureModuleV1> => {
  const existing = cache.get(entry.manifest.id)
  if (existing) return existing
  const loading = entry.load().then(unwrapFeatureModule)
  cache.set(entry.manifest.id, loading)
  return loading
}

export const retryFeatureModule = (featureId: string) => {
  cache.delete(featureId)
}

export const clearFeatureModuleCache = () => {
  cache.clear()
}
