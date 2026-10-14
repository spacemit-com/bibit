import { describe, expect, it, vi } from 'vitest'
import type { FeatureManifestV1 } from '@bibit/feature-contracts'
import { createFeatureHostApi } from '../createFeatureHostApi'

const manifest = (requiredHostCapabilities: FeatureManifestV1['requiredHostCapabilities']): FeatureManifestV1 => ({
  manifestSchemaVersion: 1,
  sdkApiVersion: 1,
  id: 'store',
  version: '1.0.0',
  owner: 'store-team',
  display: { titleKey: 'store:title', fallbackTitle: 'Store', iconKey: 'store' },
  targets: ['desktop'],
  requiredHostCapabilities,
  contributions: { pages: [], settings: [], conversation: [], locales: [] },
})

describe('createFeatureHostApi', () => {
  it('grants only declared, supported and configured capabilities', () => {
    const storeApi = { request: vi.fn() }
    const api = createFeatureHostApi({
      manifest: manifest(['external-service:store', 'runtime:permission']),
      targetAvailable: true,
      grants: ['external-service:store', 'external-service:memory'],
      capabilities: { 'external-service:store': storeApi },
    })
    expect(api.grantedCapabilities).toEqual(['external-service:store'])
    expect(api.getCapability('external-service:store')).toBe(storeApi)
    expect(api.getCapability('external-service:memory')).toBeUndefined()
    expect(api.getCapability('runtime:permission')).toBeUndefined()
  })

  it('returns no capabilities when the target is unavailable', () => {
    const api = createFeatureHostApi({
      manifest: manifest(['external-service:store']),
      targetAvailable: false,
      grants: ['external-service:store'],
      capabilities: { 'external-service:store': { request: vi.fn() } },
    })
    expect(api.grantedCapabilities).toEqual([])
  })
})
