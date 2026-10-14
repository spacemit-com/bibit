import { act } from 'react'
import { isolatePluginStyles } from '../trustedPluginStyles'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { FeatureHostApiProvider, type FeatureHostApiV1 } from '@bibit/feature-sdk'
import {
  trustedPluginLocaleRegistry,
  type FeatureManifestV1,
} from '@bibit/feature-contracts'
import {
  createTrustedPluginFeatureModule,
  loadTrustedPluginEntries,
  type ActiveTrustedPluginMetadataV1,
  type ActiveTrustedPluginV1,
} from '../trustedPluginLoader'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

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
    pages: [{ id: 'catalog', path: '', surfaces: ['main'] }],
    settings: [],
    conversation: [],
    locales: ['en'],
  },
}

const descriptor: ActiveTrustedPluginV1 = {
  id: 'agent-hub',
  version: '0.1.0',
  featureManifest: manifest,
  entrySource: 'customElements.define("bibit-agent-hub-page-catalog", class extends HTMLElement {})',
  styles: ['.agent-hub { color: green; }'],
}

const bootstrapInstance = async (plugin: ActiveTrustedPluginMetadataV1) => ({
  featureId: plugin.id,
  pluginVersion: plugin.version,
  featureInstanceToken: `${plugin.id}-instance`,
})

describe('trusted plugin loader', () => {
  it('shares concurrent and repeated loads so plugin React roots keep the same renderer', async () => {
    const createModuleUrl = vi.fn(() => 'blob:shared-plugin')
    const importModule = vi.fn(async () => ({}))
    const revokeModuleUrl = vi.fn()
    if (!customElements.get('bibit-agent-hub-page-catalog')) {
      customElements.define('bibit-agent-hub-page-catalog', class extends HTMLElement {})
    }
    const [entry] = await loadTrustedPluginEntries({
      listActive: async () => ({ plugins: [descriptor], rejected: [] }),
      bootstrapInstance,
      createModuleUrl,
      importModule,
      revokeModuleUrl,
    })

    const [settingsModule, approvalModule] = await Promise.all([entry.load(), entry.load()])
    expect(approvalModule).toBe(settingsModule)
    expect(await entry.load()).toBe(settingsModule)
    expect(createModuleUrl).toHaveBeenCalledOnce()
    expect(importModule).toHaveBeenCalledOnce()
    expect(revokeModuleUrl).toHaveBeenCalledOnce()
  })

  it('allows retrying a failed import instead of caching the failure', async () => {
    const importModule = vi.fn()
      .mockRejectedValueOnce(new Error('temporary import failure'))
      .mockResolvedValue({})
    const revokeModuleUrl = vi.fn()
    if (!customElements.get('bibit-agent-hub-page-catalog')) {
      customElements.define('bibit-agent-hub-page-catalog', class extends HTMLElement {})
    }
    const [entry] = await loadTrustedPluginEntries({
      listActive: async () => ({ plugins: [descriptor], rejected: [] }),
      bootstrapInstance,
      createModuleUrl: () => 'blob:retry-plugin',
      importModule,
      revokeModuleUrl,
    })

    await expect(entry.load()).rejects.toThrow('temporary import failure')
    await expect(entry.load()).resolves.toMatchObject({ sdkApiVersion: 1 })
    await entry.load()
    expect(importModule).toHaveBeenCalledTimes(2)
    expect(revokeModuleUrl).toHaveBeenCalledTimes(2)
  })

  it('uses the startup preparation command instead of the read-only status command', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ plugins: [], rejected: [] })

    await loadTrustedPluginEntries()

    expect(invoke).toHaveBeenCalledWith('trusted_plugin_prepare_active')
  })

  it('fetches the plugin source on demand when startup only carried metadata', async () => {
    const createModuleUrl = vi.fn(() => 'blob:lazy-plugin')
    const importModule = vi.fn(async () => ({}))
    const revokeModuleUrl = vi.fn()
    const listInstalled = vi.fn(async () => [descriptor])
    if (!customElements.get('bibit-agent-hub-page-catalog')) {
      customElements.define('bibit-agent-hub-page-catalog', class extends HTMLElement {})
    }
    const metadata = {
      id: descriptor.id,
      version: descriptor.version,
      featureManifest: descriptor.featureManifest,
    }
    const [entry] = await loadTrustedPluginEntries({
      listActive: async () => ({ plugins: [metadata], rejected: [] }),
      listInstalled,
      bootstrapInstance,
      createModuleUrl,
      importModule,
      revokeModuleUrl,
    })

    // 启动阶段不能碰源码:元数据里根本没有它。
    expect(createModuleUrl).not.toHaveBeenCalled()
    expect(listInstalled).not.toHaveBeenCalled()

    const module = await entry.load()
    expect(listInstalled).toHaveBeenCalledTimes(1)
    expect(createModuleUrl).toHaveBeenCalledWith(descriptor.entrySource)
    expect(importModule).toHaveBeenCalledWith('blob:lazy-plugin')
    expect(module.pages?.catalog).toBeTypeOf('function')
  })

  it('rejects the load when the installed plugin cannot be resolved', async () => {
    const [entry] = await loadTrustedPluginEntries({
      listActive: async () => ({
        plugins: [
          {
            id: 'agent-hub',
            version: '9.9.9',
            featureManifest: { ...manifest, version: '9.9.9' },
          },
        ],
        rejected: [],
      }),
      listInstalled: async () => [descriptor],
      bootstrapInstance,
      createModuleUrl: () => 'blob:missing',
      importModule: vi.fn(async () => ({})),
    })

    await expect(entry.load()).rejects.toThrow(
      'Trusted plugin source is unavailable: agent-hub@9.9.9'
    )
  })

  it('adapts a registered custom element to the existing Feature Module contract', async () => {
    class AgentHubElement extends HTMLElement {
      bibitContext?: {
        props: Record<string, unknown>
        hostApi?: FeatureHostApiV1
      }
    }
    if (!customElements.get('bibit-agent-hub-page-catalog')) {
      customElements.define('bibit-agent-hub-page-catalog', AgentHubElement)
    }
    const module = createTrustedPluginFeatureModule(descriptor)
    const Catalog = module.pages?.catalog
    const hostApi: FeatureHostApiV1 = {
      sdkApiVersion: 1,
      featureId: 'agent-hub',
      grantedCapabilities: [],
      getCapability: () => undefined,
    }

    const view = render(
      <FeatureHostApiProvider value={hostApi}>
        {Catalog ? (
          <Catalog
            language="zh-CN"
            featureId="agent-hub"
            contributionId="catalog"
            subpath=""
            search={{}}
            navigation={{ push() {}, replace() {}, back() {} }}
          />
        ) : null}
      </FeatureHostApiProvider>
    )
    const element = view.container.querySelector(
      'bibit-agent-hub-page-catalog'
    ) as AgentHubElement

    await act(async () => {})
    expect(element.bibitContext?.props.contributionId).toBe('catalog')
    expect(element.bibitContext?.props.language).toBe('zh-CN')
    view.rerender(<FeatureHostApiProvider value={hostApi}>{Catalog ? <Catalog language="en" featureId="agent-hub" contributionId="catalog" subpath="" search={{}} navigation={{ push() {}, replace() {}, back() {} }} /> : null}</FeatureHostApiProvider>)
    expect(element.bibitContext?.props.language).toBe('en')
    expect(element.bibitContext?.hostApi?.featureId).toBe('agent-hub')
    expect(element.dataset.bibitPluginRoot).toBe(
      'bibit-agent-hub-page-catalog'
    )
    expect(element.style.display).toBe('block')
    expect(element.style.minWidth).toBe('0')
    expect(element.style.maxWidth).toBe('100%')
    expect(element.style.width).toBe('100%')
    expect(element.style.height).toBe('100%')
    expect(element.style.minHeight).toBe('0')
  })

  it('only creates entries returned by the verified backend registry', async () => {
    const entries = await loadTrustedPluginEntries({
      listActive: async () => ({ plugins: [descriptor], rejected: [] }),
      bootstrapInstance,
      createModuleUrl: () => 'blob:verified-plugin',
      revokeModuleUrl: (url) => expect(url).toBe('blob:verified-plugin'),
      importModule: async () => ({}),
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].manifest.id).toBe('agent-hub')
    expect(entries[0].featureInstanceToken).toBe('agent-hub-instance')
    await expect(entries[0].load()).resolves.toMatchObject({ sdkApiVersion: 1 })
    expect(
      document.head.querySelector(
        '[data-bibit-plugin-style="agent-hub:0.1.0:0"]'
      )?.textContent
    ).toBe(
      isolatePluginStyles(descriptor.styles[0], ['bibit-agent-hub-page-catalog'])
    )
  })

  it('uses every contributed custom element as a stylesheet scope root', async () => {
    const multiSurfaceDescriptor: ActiveTrustedPluginV1 = {
      ...descriptor,
      version: '0.1.1',
      featureManifest: {
        ...manifest,
        version: '0.1.1',
        contributions: {
          ...manifest.contributions,
          settings: [{ id: 'preferences', path: '', surfaces: ['main'] }],
          conversation: [
            {
              id: 'approval',
              kind: 'permission-presenter',
              surfaces: ['main'],
            },
          ],
        },
      },
    }
    const expectedTags = [
      'bibit-agent-hub-page-catalog',
      'bibit-agent-hub-settings-preferences',
      'bibit-agent-hub-permission-presenter-approval',
    ]
    expectedTags.forEach((tag) => {
      if (!customElements.get(tag)) {
        customElements.define(tag, class extends HTMLElement {})
      }
    })

    const entries = await loadTrustedPluginEntries({
      listActive: async () => ({
        plugins: [multiSurfaceDescriptor],
        rejected: [],
      }),
      bootstrapInstance,
      createModuleUrl: () => 'blob:multi-surface-plugin',
      revokeModuleUrl() {},
      importModule: async () => ({}),
    })

    await entries[0].load()
    expect(
      document.head.querySelector(
        '[data-bibit-plugin-style="agent-hub:0.1.1:0"]'
      )?.textContent
    ).toContain(`:where(${expectedTags.join(', ')})`)
  })

  it('keeps the rest of the plugin when a declared entry never registered its element', async () => {
    const invalidDescriptor: ActiveTrustedPluginV1 = {
      ...descriptor,
      id: 'missing-plugin',
      version: '0.1.0',
      featureManifest: {
        ...manifest,
        id: 'missing-plugin',
      },
    }
    const revokeModuleUrl = vi.fn()
    const entries = await loadTrustedPluginEntries({
      listActive: async () => ({
        plugins: [invalidDescriptor],
        rejected: [],
      }),
      bootstrapInstance,
      createModuleUrl: () => 'blob:missing-plugin',
      revokeModuleUrl,
      importModule: async () => ({}),
    })

    const module = await entries[0].load()

    expect(module.pages?.catalog).toBeTypeOf('function')
    expect(revokeModuleUrl).toHaveBeenCalledWith('blob:missing-plugin')
    expect(
      document.head.querySelector(
        '[data-bibit-plugin-style="missing-plugin:0.1.0:0"]'
      )?.textContent
    ).toContain('bibit-missing-plugin-page-catalog')
  })

  it('renders a local error for an entry whose element never registered', () => {
    const module = createTrustedPluginFeatureModule({
      id: 'missing-plugin',
      version: '0.1.0',
      featureManifest: { ...manifest, id: 'missing-plugin' },
    })
    const Broken = module.pages?.catalog
    const hostApi: FeatureHostApiV1 = {
      sdkApiVersion: 1,
      featureId: 'missing-plugin',
      grantedCapabilities: [],
      getCapability: () => undefined,
    }

    const view = render(
      <FeatureHostApiProvider value={hostApi}>
        {Broken ? (
          <Broken
            language="en"
            featureId="missing-plugin"
            contributionId="catalog"
            subpath=""
            search={{}}
            navigation={{ push() {}, replace() {}, back() {} }}
          />
        ) : null}
      </FeatureHostApiProvider>
    )

    expect(view.getByRole('alert')).toBeTruthy()
  })

  it('keeps verified plugins when another active plugin is rejected', async () => {
    const entries = await loadTrustedPluginEntries({
      listActive: async () => ({
        plugins: [descriptor],
        rejected: [{ id: 'broken', version: '1.0.0', reason: 'hash mismatch' }],
      }),
      bootstrapInstance,
    })

    expect(entries.map(({ manifest }) => manifest.id)).toEqual(['agent-hub'])
  })

  it('bootstraps every instance before any plugin code executes', async () => {
    const order: string[] = []
    const entries = await loadTrustedPluginEntries({
      listActive: async () => ({ plugins: [descriptor], rejected: [] }),
      bootstrapInstance: async (plugin) => {
        order.push(`bootstrap:${plugin.id}`)
        return bootstrapInstance(plugin)
      },
      createModuleUrl: () => 'blob:bootstrap-order',
      revokeModuleUrl() {},
      importModule: async () => {
        order.push('import')
        return {}
      },
    })

    expect(order).toEqual(['bootstrap:agent-hub'])
    await entries[0].load()
    expect(order).toEqual(['bootstrap:agent-hub', 'import'])
  })
})

describe('trusted plugin locales', () => {
  const loadLocales = async (imported: Record<string, unknown>) => {
    const entries = await loadTrustedPluginEntries({
      listActive: async () => ({ plugins: [descriptor], rejected: [] }),
      bootstrapInstance,
      createModuleUrl: () => 'blob:locale-plugin',
      revokeModuleUrl() {},
      importModule: async () => imported,
    })
    return (await entries[0].load()).locales
  }

  beforeEach(() => {
    trustedPluginLocaleRegistry().clear()
  })

  it('prefers locales published through the shared registry over the entry export', async () => {
    trustedPluginLocaleRegistry().set('agent-hub', { en: { title: 'From registry' } })

    await expect(
      loadLocales({ pluginLocales: { en: { title: 'From entry' } } })
    ).resolves.toEqual({ en: { title: 'From registry' } })
  })

  it('falls back to the entry pluginLocales export for bundles built before the registry', async () => {
    await expect(
      loadLocales({ pluginLocales: { en: { title: 'From entry' } } })
    ).resolves.toEqual({ en: { title: 'From entry' } })
  })

  it('reports a manifest locale the bundle never ships instead of staying silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(loadLocales({})).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('declares locales without shipping resources: en')
      )
    } finally {
      warn.mockRestore()
    }
  })
})
