import { describe, expect, it } from 'vitest'
import { createFeatureRegistryProjection } from '../registry'
import { createTestEntry } from './testRegistry'

const Empty = () => null

describe('Feature Registry projection', () => {
  it('provides readonly queries by feature, full contribution key, and final path', () => {
    const projection = createFeatureRegistryProjection(
      [
        createTestEntry({
          page: Empty,
          pagePath: 'agents',
          settings: Empty,
          settingsPath: 'catalog',
        }),
      ],
      { target: 'desktop', surface: 'main' }
    )

    expect(projection.features.map((entry) => entry.manifest.id)).toEqual([
      'store',
    ])
    expect(projection.getFeature('store')?.manifest.id).toBe('store')
    expect(projection.getContribution('store:home')).toMatchObject({
      featureId: 'store',
      contributionId: 'home',
      finalPath: '/features/store/agents',
    })
    expect(projection.getByFinalPath('/settings/features/store/catalog')).toMatchObject(
      { key: 'store:manage', kind: 'settings' }
    )
    expect(Object.isFrozen(projection.features)).toBe(true)
    expect(Object.isFrozen(projection.pages)).toBe(true)
  })

  it('resolves page and settings deep links to contribution-relative subpaths', () => {
    const projection = createFeatureRegistryProjection(
      [
        createTestEntry({
          page: Empty,
          pagePath: 'agents',
          settings: Empty,
          settingsPath: 'memory',
        }),
      ],
      { target: 'desktop', surface: 'main' }
    )

    expect(projection.resolvePage('store', 'agents/42')).toMatchObject({
      status: 'found',
      subpath: '42',
      contribution: { key: 'store:home' },
    })
    expect(projection.resolveSettings('store', 'memory/items/7')).toMatchObject({
      status: 'found',
      subpath: 'items/7',
      contribution: { key: 'store:manage' },
    })
  })

  it('distinguishes unknown features, paths, and unavailable targets', () => {
    const unavailable = createTestEntry({ page: Empty })
    unavailable.manifest.targets = []
    const projection = createFeatureRegistryProjection([unavailable], {
      target: 'desktop',
      surface: 'main',
    })

    expect(projection.resolvePage('missing', '')).toEqual({
      status: 'unknown-feature',
    })
    expect(projection.resolvePage('store', '')).toEqual({
      status: 'target-unavailable',
    })

    const knownProjection = createFeatureRegistryProjection(
      [createTestEntry({ page: Empty, pagePath: 'agents' })],
      { target: 'desktop', surface: 'main' }
    )
    expect(knownProjection.resolvePage('store', 'skills')).toEqual({
      status: 'path-not-found',
    })
  })
})
