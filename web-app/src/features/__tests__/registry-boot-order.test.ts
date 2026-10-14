import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureManifestV1 } from '@bibit/feature-contracts'
import type { FeatureRegistrySourceEntry } from '../host/registry'

const dynamicFeatureId = 'boot-order-probe'

const dynamicManifest: FeatureManifestV1 = {
  manifestSchemaVersion: 1,
  sdkApiVersion: 1,
  id: dynamicFeatureId,
  version: '1.0.0',
  owner: 'platform-team',
  display: {
    titleKey: `${dynamicFeatureId}:title`,
    fallbackTitle: dynamicFeatureId,
    iconKey: 'feature',
  },
  targets: ['desktop'],
  requiredHostCapabilities: [],
  contributions: {
    pages: [
      {
        id: 'home',
        path: '',
        surfaces: ['main'],
        navigation: { group: 'tools' },
      },
    ],
    settings: [],
    conversation: [],
    locales: ['en'],
  },
}

const dynamicEntry: FeatureRegistrySourceEntry = {
  packageName: `trusted-plugin:${dynamicFeatureId}@1.0.0`,
  manifest: dynamicManifest,
  load: async () => ({ sdkApiVersion: 1 }),
}

describe('Feature Registry boot order', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('projects runtime entries when the registry is populated before the projection module loads', async () => {
    const { setRuntimeFeatureRegistry } = await import('../activeFeatureRegistry')
    setRuntimeFeatureRegistry([dynamicEntry])

    const { desktopMainFeatureRegistry } = await import('../host/registry')

    expect(
      desktopMainFeatureRegistry.features.map(({ manifest }) => manifest.id)
    ).toContain(dynamicFeatureId)
    expect(desktopMainFeatureRegistry.pages.map(({ finalPath }) => finalPath)).toContain(
      `/features/${dynamicFeatureId}`
    )
  })

  it('drops runtime entries when the projection module is evaluated too early', async () => {
    const { desktopMainFeatureRegistry } = await import('../host/registry')
    const { setRuntimeFeatureRegistry } = await import('../activeFeatureRegistry')
    setRuntimeFeatureRegistry([dynamicEntry])

    expect(
      desktopMainFeatureRegistry.features.map(({ manifest }) => manifest.id)
    ).not.toContain(dynamicFeatureId)
  })

  it('keeps the projection preload after the runtime registry merge in the boot sequence', () => {
    // vitest 既可能从仓库根运行，也可能从 web-app 运行。
    const mainSourcePath = [
      resolve(process.cwd(), 'src/main.tsx'),
      resolve(process.cwd(), 'web-app/src/main.tsx'),
    ].find(existsSync)
    expect(mainSourcePath).toBeDefined()
    const source = readFileSync(mainSourcePath!, 'utf8')
    const registration = source.indexOf('setRuntimeFeatureRegistry(pluginEntries)')
    const preload = source.indexOf("await import('@/features/host/registry')")

    expect(registration).toBeGreaterThan(-1)
    expect(preload).toBeGreaterThan(registration)
  })
})
