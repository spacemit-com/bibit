import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  useFeatureHostApi,
  registerFeaturePlugin,
  type FeatureModuleV1,
  type FeatureHostApiV1,
  type FeatureManifestV1,
} from './index'
import { trustedPluginLocaleRegistry } from '@bibit/feature-contracts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const manifest: FeatureManifestV1 = {
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
  requiredHostCapabilities: [],
  contributions: {
    pages: [
      { id: 'catalog', path: '', surfaces: ['main'] },
    ],
    settings: [],
    conversation: [],
    locales: ['en'],
  },
}

describe('registerFeaturePlugin', () => {
  it('publishes module locales through the shared registry', () => {
    const locales = { en: { title: 'Agent Hub' } }
    trustedPluginLocaleRegistry().delete(manifest.id)

    registerFeaturePlugin({
      manifest,
      module: {
        sdkApiVersion: 1,
        pages: { catalog: () => null },
        locales,
      },
    })

    expect(trustedPluginLocaleRegistry().get(manifest.id)).toEqual(locales)
  })

  it('mounts a Feature component in a stable custom element with Host API access', async () => {
    function Catalog({ contributionId }: { contributionId: string }) {
      return (
        <span>{`${useFeatureHostApi().featureId}:${contributionId}`}</span>
      )
    }
    const module = {
      sdkApiVersion: 1,
      pages: { catalog: Catalog },
    } satisfies FeatureModuleV1
    const hostApi: FeatureHostApiV1 = {
      sdkApiVersion: 1,
      featureId: 'agent-hub',
      grantedCapabilities: [],
      getCapability: () => undefined,
    }

    registerFeaturePlugin({ manifest, module })
    const element = document.createElement('bibit-agent-hub-page-catalog') as
      HTMLElement & {
        bibitContext: {
          props: Record<string, unknown>
          hostApi: FeatureHostApiV1
        }
      }
    element.bibitContext = { props: { contributionId: 'catalog' }, hostApi }

    await act(async () => document.body.append(element))

    expect(element.textContent).toBe('agent-hub:catalog')
    await act(async () => element.remove())
  })

  it('registers the contributions that have renderers and warns about the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const twoPages: FeatureManifestV1 = {
      ...manifest,
      contributions: {
        ...manifest.contributions,
        pages: [
          { id: 'catalog', path: 'catalog', surfaces: ['main'] },
          { id: 'missing', path: 'missing', surfaces: ['main'] },
        ],
      },
    }

    registerFeaturePlugin({
      manifest: twoPages,
      module: { sdkApiVersion: 1, pages: { catalog: () => null } },
    })

    expect(warn).toHaveBeenCalledWith(
      'Feature plugin renderer is missing: pages.missing'
    )
    expect(customElements.get('bibit-agent-hub-page-missing')).toBeUndefined()
    expect(customElements.get('bibit-agent-hub-page-catalog')).toBeDefined()
    warn.mockRestore()
  })
})
