import { describe, expect, it, vi } from 'vitest'
import type { FeatureManifestV1 } from '@bibit/feature-contracts'
import {
  activeFeatureRegistry,
  createActiveFeatureRegistry,
  setRuntimeFeatureRegistry,
} from '../activeFeatureRegistry'
import {
  activeFeatureRegistry as productionRegistry,
  setRuntimeFeatureRegistry as setProductionRuntimeFeatureRegistry,
} from '../activeFeatureRegistry.production'
import { mergeFeatureRegistryEntries } from '../activeFeatureRegistry.shared'

const baseEntry = {
  packageName: '@bibit/feature-existing',
  manifest: {
    manifestSchemaVersion: 1,
    sdkApiVersion: 1,
    id: 'existing',
    version: '1.0.0',
    owner: 'host-team',
    display: {
      titleKey: 'existing:title',
      fallbackTitle: 'Existing',
      iconKey: 'settings',
    },
    targets: ['desktop'],
    requiredHostCapabilities: [],
    contributions: {
      pages: [],
      settings: [],
      conversation: [],
      locales: ['en'],
    },
  } satisfies FeatureManifestV1,
  load: async () => ({ featureModule: { sdkApiVersion: 1 as const } }),
}

const registryEntry = (
  id: string,
  options: { readonly presenter?: boolean } = {}
) => ({
  ...baseEntry,
  packageName: `@bibit/feature-${id}`,
  manifest: {
    ...baseEntry.manifest,
    id,
    display: {
      ...baseEntry.manifest.display,
      titleKey: `${id}:title`,
      fallbackTitle: id,
    },
    contributions: {
      ...baseEntry.manifest.contributions,
      conversation: options.presenter
        ? [
            {
              id: 'approval',
              kind: 'permission-presenter' as const,
              surfaces: ['main' as const],
            },
          ]
        : [],
    },
  },
})

describe('active Feature Registry', () => {
  it('keeps the production Registry untouched when the Security demo is disabled', () => {
    const entries = createActiveFeatureRegistry([baseEntry], false)

    expect(entries).toEqual([baseEntry])
    expect(entries).not.toBe(baseEntry)
  })

  it('injects one development-only Security module when enabled', () => {
    const entries = createActiveFeatureRegistry([baseEntry], true)
    const security = entries.find((entry) => entry.manifest.id === 'security')

    expect(entries.map((entry) => entry.manifest.id)).toEqual([
      'existing',
      'security',
    ])
    expect(security?.manifest.contributions.settings).toEqual([
      expect.objectContaining({ id: 'rules', path: '' }),
    ])
    expect(security?.manifest.contributions.conversation).toEqual([
      expect.objectContaining({
        id: 'approval',
        kind: 'permission-presenter',
      }),
    ])
  })

  it('rejects a duplicate runtime id group instead of choosing by order', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const duplicate = { ...baseEntry, packageName: 'duplicate' }
    const rejected = setRuntimeFeatureRegistry([baseEntry, duplicate])

    expect(rejected).toHaveLength(2)
    expect(
      activeFeatureRegistry.filter(({ manifest }) => manifest.id === 'existing')
    ).toHaveLength(0)
    expect(consoleError).toHaveBeenCalledWith(
      'Rejected Feature Registry entry',
      expect.objectContaining({
        code: 'duplicate-feature-id',
        featureId: 'existing',
      })
    )
    consoleError.mockRestore()
    setRuntimeFeatureRegistry([])
  })

  it('injects runtime plugins into the production Registry without the demo', () => {
    setProductionRuntimeFeatureRegistry([baseEntry])

    expect(productionRegistry).toEqual([baseEntry])
    setProductionRuntimeFeatureRegistry([])
  })

  it('rejects every runtime member of a duplicate Feature id group', () => {
    const result = mergeFeatureRegistryEntries(
      [registryEntry('static-feature')],
      [
        registryEntry('duplicate'),
        { ...registryEntry('duplicate'), packageName: '@bibit/duplicate-two' },
        registryEntry('unrelated'),
      ]
    )

    expect(result.entries.map(({ manifest }) => manifest.id)).toEqual([
      'static-feature',
      'unrelated',
    ])
    expect(result.rejections).toEqual([
      expect.objectContaining({
        code: 'duplicate-feature-id',
        featureId: 'duplicate',
        packageName: '@bibit/duplicate-two',
      }),
      expect.objectContaining({
        code: 'duplicate-feature-id',
        featureId: 'duplicate',
        packageName: '@bibit/feature-duplicate',
      }),
    ])
  })

  it('keeps a static Presenter and rejects a conflicting runtime entry', () => {
    const result = mergeFeatureRegistryEntries(
      [registryEntry('static-security', { presenter: true })],
      [
        registryEntry('runtime-security', { presenter: true }),
        registryEntry('unrelated'),
      ]
    )

    expect(result.entries.map(({ manifest }) => manifest.id)).toEqual([
      'static-security',
      'unrelated',
    ])
    expect(result.rejections).toEqual([
      {
        code: 'permission-presenter-conflict',
        featureId: 'runtime-security',
        packageName: '@bibit/feature-runtime-security',
        target: 'desktop',
        surface: 'main',
        conflictsWith: ['static-security'],
        reason:
          'permission-presenter conflict on desktop/main with static Feature static-security',
      },
    ])
  })

  it('rejects an entire runtime Presenter conflict group independent of order', () => {
    const left = registryEntry('runtime-left', { presenter: true })
    const right = registryEntry('runtime-right', { presenter: true })

    for (const runtimeEntries of [
      [left, right],
      [right, left],
    ]) {
      const result = mergeFeatureRegistryEntries(
        [registryEntry('static-feature')],
        runtimeEntries
      )

      expect(result.entries.map(({ manifest }) => manifest.id)).toEqual([
        'static-feature',
      ])
      expect(
        result.rejections
          .map(({ featureId }) => featureId)
          .sort()
      ).toEqual(['runtime-left', 'runtime-right'])
      expect(
        new Set(result.rejections.map(({ reason }) => reason))
      ).toEqual(
        new Set([
          'permission-presenter conflict on desktop/main among runtime Features runtime-left, runtime-right',
        ])
      )
    }
  })
})
