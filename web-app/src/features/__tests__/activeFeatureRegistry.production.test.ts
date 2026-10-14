import { describe, expect, it, vi } from 'vitest'
import type { FeatureManifestV1 } from '@bibit/feature-contracts'
import type { ActiveFeatureRegistryEntry } from '../activeFeatureRegistry'
import { bootstrapStaticFeatureEntries } from '../activeFeatureRegistry.production'

const manifest = (
  id: string,
  requiredHostCapabilities: FeatureManifestV1['requiredHostCapabilities']
): FeatureManifestV1 => ({
  manifestSchemaVersion: 1,
  sdkApiVersion: 1,
  id,
  version: '1.0.0',
  owner: 'platform-team',
  display: {
    titleKey: `${id}:title`,
    fallbackTitle: id,
    iconKey: 'store',
  },
  targets: ['desktop'],
  requiredHostCapabilities,
  contributions: { pages: [], settings: [], conversation: [], locales: [] },
})

const entry = (
  id: string,
  capabilities: FeatureManifestV1['requiredHostCapabilities']
): ActiveFeatureRegistryEntry => ({
  packageName: `@bibit/${id}`,
  manifest: manifest(id, capabilities),
  load: async () => ({}),
})

describe('production static Feature bootstrap', () => {
  it('issues an instance only for a Native-capability manifest in the static Registry', async () => {
    const bootstrap = vi.fn(async ({ manifest }: ActiveFeatureRegistryEntry) => ({
      featureId: manifest.id,
      pluginVersion: manifest.version,
      featureInstanceToken: `${manifest.id}-instance`,
    }))

    const entries = await bootstrapStaticFeatureEntries(
      [entry('builtin-store', ['service:store']), entry('builtin-ui', [])],
      bootstrap
    )

    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: 'builtin-store' }),
      })
    )
    expect(entries[0].featureInstanceToken).toBe('builtin-store-instance')
    expect(entries[1].featureInstanceToken).toBeUndefined()
  })

  it('does not expose a sensitive Feature when Native returns a different identity', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await bootstrapStaticFeatureEntries(
      [entry('builtin-store', ['service:store'])],
      async () => ({
        featureId: 'other-feature',
        pluginVersion: '1.0.0',
        featureInstanceToken: 'other-instance',
      })
    )

    expect(result).toEqual([])
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})
