import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import manifestSchema from '../schema/bibit-feature.schema.json'
import {
  FEATURE_DECLARATION_ONLY_CAPABILITIES,
  FEATURE_HOST_CAPABILITIES,
  validateFeatureManifestSemantics,
  type FeatureManifestV1,
} from './index'

const validateSchema = new Ajv({ allErrors: true }).compile(manifestSchema)

const validManifest = (): FeatureManifestV1 => ({
  manifestSchemaVersion: 1,
  sdkApiVersion: 1,
  id: 'store',
  version: '0.1.0',
  owner: 'agent-store-team',
  display: {
    titleKey: 'store:title',
    fallbackTitle: 'Store',
    iconKey: 'store',
  },
  targets: ['desktop'],
  requiredHostCapabilities: ['external-service:store'],
  contributions: {
    pages: [
      {
        id: 'home',
        path: '',
        surfaces: ['main'],
        navigation: { group: 'workspace', order: 100 },
      },
    ],
    settings: [],
    conversation: [],
    locales: ['en'],
  },
})

const schemaAccepts = (manifest: unknown) =>
  validateSchema(manifest) &&
  validateFeatureManifestSemantics(manifest as unknown as FeatureManifestV1)
    .length === 0

describe('Feature Manifest v1', () => {
  it('accepts the minimal valid manifest', () => {
    expect(schemaAccepts(validManifest())).toBe(true)
  })

  it('accepts a format-valid service capability without changing the schema', () => {
    expect(
      schemaAccepts({
        ...validManifest(),
        requiredHostCapabilities: ['service:knowledge-index'],
      })
    ).toBe(true)
  })

  it('accepts the transfer and job capabilities with a service capability', () => {
    expect(
      schemaAccepts({
        ...validManifest(),
        requiredHostCapabilities: [
          'service:store',
          'file:transfer',
          'job:manage',
        ],
      })
    ).toBe(true)
  })

  it.each([
    ['unknown top-level field', { unexpected: true }],
    ['unsupported target', { targets: ['web'] }],
    ['empty targets', { targets: [] }],
    ['unknown capability', { requiredHostCapabilities: ['system:shell'] }],
  ])('rejects %s', (_label, patch) => {
    expect(validateSchema({ ...validManifest(), ...patch })).toBe(false)
  })

  it('accepts a navigation group this build does not know yet', () => {
    const manifest = validManifest()
    manifest.contributions.pages[0].navigation = { group: 'future-surface' }
    expect(validateSchema(manifest)).toBe(true)
  })

  it('accepts an icon key this build does not ship yet', () => {
    const manifest = validManifest()
    manifest.display.iconKey = 'rocket'
    expect(validateSchema(manifest)).toBe(true)
  })

  it.each(['Rocket', 'rocket_icon', '-rocket', '', 'rocket--icon'])(
    'rejects the malformed declared token %o',
    (token) => {
      const icon = validManifest()
      icon.display.iconKey = token
      expect(validateSchema(icon)).toBe(false)

      const group = validManifest()
      group.contributions.pages[0].navigation = { group: token }
      expect(validateSchema(group)).toBe(false)
    }
  )

  it('caps declared tokens at the length the native validator enforces', () => {
    const manifest = validManifest()
    manifest.display.iconKey = 'a'.repeat(65)
    expect(validateSchema(manifest)).toBe(false)
  })

  it('accepts core settings navigation with contribution display metadata', () => {
    const manifest = validManifest()
    manifest.contributions.settings = [
      {
        id: 'runtime-status',
        path: 'runtime-status',
        surfaces: ['main'],
        navigation: {
          group: 'core',
          order: 110,
          titleKey: 'runtime:settings.runtimeStatus',
          fallbackTitle: 'Runtime Status',
          iconKey: 'settings',
          section: {
            id: 'runtime-monitoring',
            titleKey: 'runtime:settings.monitoring',
            fallbackTitle: '监控',
          },
        },
      },
    ]

    expect(validateSchema(manifest)).toBe(true)
  })

  it('rejects an invalid path and overlapping path ownership', () => {
    const invalidPath = validManifest()
    invalidPath.contributions.pages[0].path = '../admin'
    expect(schemaAccepts(invalidPath)).toBe(false)

    const overlap = validManifest()
    overlap.contributions.pages = [
      { id: 'root', path: 'agents', surfaces: ['main'] },
      { id: 'detail', path: 'agents/detail', surfaces: ['main'] },
    ]
    expect(schemaAccepts(overlap)).toBe(false)
  })

  it('requires English fallback text and paired descriptions', () => {
    const noFallback = validManifest()
    delete (noFallback.display as Partial<typeof noFallback.display>)
      .fallbackTitle
    expect(validateSchema(noFallback)).toBe(false)

    const unpairedDescription = validManifest()
    unpairedDescription.display.descriptionKey = 'store:description'
    expect(validateSchema(unpairedDescription)).toBe(false)
  })

  it('keeps the declared-token rule and capability enum in step with the host', () => {
    const definitions = manifestSchema.$defs
    // Mirrors `valid_declared_token` in src-tauri/src/trusted_plugins.rs.
    expect(definitions.declaredToken).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
    })
    expect(definitions.iconKey).toEqual({ $ref: '#/$defs/declaredToken' })
    expect(definitions.pageNavigationGroup).toEqual({
      $ref: '#/$defs/declaredToken',
    })
    expect(definitions.settingsNavigationGroup).toEqual({
      $ref: '#/$defs/declaredToken',
    })
    expect(new Set(definitions.hostCapability.anyOf[1].enum)).toEqual(
      new Set([
        ...FEATURE_HOST_CAPABILITIES.filter(
          (capability) => !capability.startsWith('service:')
        ),
        ...FEATURE_DECLARATION_ONLY_CAPABILITIES,
      ])
    )
  })
})
