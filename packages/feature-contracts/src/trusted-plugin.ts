import type { FeatureManifestV1 } from './manifest'

export const TRUSTED_PLUGIN_SCHEMA_VERSION = 1 as const

export type TrustedPluginContributionKind =
  | 'page'
  | 'settings'
  | 'permission-presenter'

export interface TrustedPluginBundleManifestV1 {
  pluginSchemaVersion: typeof TRUSTED_PLUGIN_SCHEMA_VERSION
  featureManifest: FeatureManifestV1
  entry: string
  styles: readonly string[]
  files: Readonly<Record<string, string>>
}

export interface TrustedPluginSignatureV1 {
  keyId: string
  signature: string
}

export const getTrustedPluginElementTag = (
  featureId: string,
  kind: TrustedPluginContributionKind,
  contributionId: string
) => `bibit-${featureId}-${kind}-${contributionId}`

/**
 * Locale resources a plugin module published when it ran.
 *
 * The host registers navigation labels before the first render, which means it
 * needs the resources without importing the entry a second time. The plugin SDK
 * writes here during `registerFeaturePlugin`; the host reads and cross-checks the
 * result against the manifest. Keeping the map behind a well-known symbol is the
 * same shared-runtime approach the element registry already uses.
 */
export const TRUSTED_PLUGIN_LOCALES_REGISTRY_KEY = Symbol.for(
  '@bibit/feature-plugin-sdk/plugin-locales'
)

export type TrustedPluginLocaleResources = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>

type TrustedPluginLocaleRegistryHost = {
  [key: symbol]: Map<string, TrustedPluginLocaleResources> | undefined
}

export const trustedPluginLocaleRegistry =
  (): Map<string, TrustedPluginLocaleResources> => {
    const host = globalThis as unknown as TrustedPluginLocaleRegistryHost
    return (host[TRUSTED_PLUGIN_LOCALES_REGISTRY_KEY] ??= new Map())
  }
