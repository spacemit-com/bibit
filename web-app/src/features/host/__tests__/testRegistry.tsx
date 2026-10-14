import type { ComponentType } from 'react'
import type { FeatureManifestV1 } from '@bibit/feature-contracts'
import type {
  FeatureModuleV1,
  FeaturePageProps,
  FeatureSettingsProps,
} from '@bibit/feature-sdk'
import type { FeatureRegistrySourceEntry } from '../registry'

interface TestEntryOptions {
  id?: string
  targets?: FeatureManifestV1['targets']
  pagePath?: string
  settingsPath?: string
  page?: ComponentType<FeaturePageProps>
  settings?: ComponentType<FeatureSettingsProps>
  load?: () => Promise<unknown>
}

export function createTestEntry({
  id = 'store',
  targets = ['desktop'],
  pagePath = '',
  settingsPath = '',
  page,
  settings,
  load,
}: TestEntryOptions = {}): FeatureRegistrySourceEntry {
  const manifest: FeatureManifestV1 = {
    manifestSchemaVersion: 1,
    sdkApiVersion: 1,
    id,
    version: '0.1.0',
    owner: `${id}-team`,
    display: {
      titleKey: `${id}:title`,
      fallbackTitle: id,
      iconKey: id === 'store' || id === 'memory' ? id : 'feature',
    },
    targets,
    requiredHostCapabilities: [],
    contributions: {
      pages: page
        ? [{ id: 'home', path: pagePath, surfaces: ['main'] }]
        : [],
      settings: settings
        ? [{ id: 'manage', path: settingsPath, surfaces: ['main'] }]
        : [],
      conversation: [],
      locales: ['en'],
    },
  }
  const module: FeatureModuleV1 = {
    sdkApiVersion: 1,
    pages: page ? { home: page } : undefined,
    settings: settings ? { manage: settings } : undefined,
  }
  return {
    packageName: `@bibit/feature-${id}`,
    manifest,
    load: load ?? (() => Promise.resolve({ default: module })),
  }
}
