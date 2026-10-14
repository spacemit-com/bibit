import { describe, expect, it } from 'vitest'
import {
  getTrustedPluginElementTag,
  type TrustedPluginBundleManifestV1,
} from './index'

describe('trusted plugin contract', () => {
  it('derives stable custom-element tags from public contribution identities', () => {
    expect(getTrustedPluginElementTag('agent-hub', 'page', 'catalog')).toBe(
      'bibit-agent-hub-page-catalog'
    )
    expect(
      getTrustedPluginElementTag('security', 'permission-presenter', 'approval')
    ).toBe('bibit-security-permission-presenter-approval')
  })

  it('keeps the signed bundle manifest transport-only', () => {
    const manifest: TrustedPluginBundleManifestV1 = {
      pluginSchemaVersion: 1,
      featureManifest: {
        manifestSchemaVersion: 1,
        sdkApiVersion: 1,
        id: 'agent-hub',
        version: '0.1.0',
        owner: 'agent-hub-team',
        display: {
          titleKey: 'agent-hub:title',
          fallbackTitle: 'Agent Hub',
          iconKey: 'store',
        },
        targets: ['desktop'],
        requiredHostCapabilities: ['external-service:store'],
        contributions: {
          pages: [],
          settings: [],
          conversation: [],
          locales: ['en'],
        },
      },
      entry: 'dist/plugin.js',
      styles: ['dist/plugin.css'],
      files: {
        'dist/plugin.js': 'a'.repeat(64),
        'dist/plugin.css': 'b'.repeat(64),
      },
    }

    expect(manifest.featureManifest.id).toBe('agent-hub')
    expect(manifest).not.toHaveProperty('url')
    expect(manifest).not.toHaveProperty('publicKey')
  })
})
