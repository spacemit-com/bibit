import {
  FeatureHostApiProvider,
  type FeatureHostApiV1,
  type FeatureModuleV1,
} from '@bibit/feature-sdk'
import {
  getTrustedPluginElementTag,
  trustedPluginLocaleRegistry,
  type FeatureManifestV1,
  type TrustedPluginContributionKind,
} from '@bibit/feature-contracts'
import { createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type PluginContext = {
  props: Record<string, unknown>
  hostApi?: FeatureHostApiV1
}

type PluginElement = HTMLElement & { bibitContext?: PluginContext; renderPlugin(): void }

type RendererRecord = {
  component: ComponentType<Record<string, unknown>>
  instances: Set<PluginElement>
}

const registryKey = Symbol.for('@bibit/feature-plugin-sdk/element-registry')

const rendererRegistry = (): Map<string, RendererRecord> => {
  const globalObject = globalThis as typeof globalThis & {
    [registryKey]?: Map<string, RendererRecord>
  }
  return (globalObject[registryKey] ??= new Map())
}

const defineElement = (
  tag: string,
  component: ComponentType<Record<string, unknown>>
) => {
  const registry = rendererRegistry()
  const existing = registry.get(tag)
  if (existing) {
    existing.component = component
    existing.instances.forEach((instance) => instance.renderPlugin())
    return
  }

  const record: RendererRecord = { component, instances: new Set() }
  registry.set(tag, record)

  class BibitFeatureElement extends HTMLElement {
    private root?: Root
    private contextValue: PluginContext = { props: {} }

    get bibitContext() {
      return this.contextValue
    }
    set bibitContext(value: PluginContext | undefined) {
      this.contextValue = value ?? { props: {} }
      this.renderPlugin()
    }

    connectedCallback() {
      record.instances.add(this)
      this.root ??= createRoot(this)
      this.renderPlugin()
    }

    disconnectedCallback() {
      record.instances.delete(this)
      this.root?.unmount()
      this.root = undefined
    }

    renderPlugin() {
      if (!this.isConnected || !this.root) return
      const child = createElement(record.component, this.contextValue.props)
      this.root.render(
        this.contextValue.hostApi
          ? createElement(
              FeatureHostApiProvider,
              { value: this.contextValue.hostApi },
              child
            )
          : child
      )
    }
  }

  customElements.define(tag, BibitFeatureElement)
}

const moduleKeyForKind = (kind: TrustedPluginContributionKind) =>
  kind === 'page' ? 'pages' : kind === 'settings' ? 'settings' : 'permissionPresenters'

const registerGroup = (
  featureId: string,
  kind: TrustedPluginContributionKind,
  contributionIds: readonly string[],
  renderers: Readonly<Record<string, ComponentType<never>>> | undefined
) => {
  for (const contributionId of contributionIds) {
    const renderer = renderers?.[contributionId]
    if (!renderer) {
      // A declared contribution without a renderer is a plugin-side bug, but it
      // must not take down the entries the plugin did ship: throwing here fails
      // the whole entry module, which used to disable every other contribution.
      // The host renders the missing entry as a local error instead.
      console.warn(
        `Feature plugin renderer is missing: ${moduleKeyForKind(kind)}.${contributionId}`
      )
      continue
    }
    defineElement(
      getTrustedPluginElementTag(featureId, kind, contributionId),
      renderer as ComponentType<Record<string, unknown>>
    )
  }
}

export interface RegisterFeaturePluginOptions {
  manifest: FeatureManifestV1
  module: FeatureModuleV1
}

export const registerFeaturePlugin = ({
  manifest,
  module,
}: RegisterFeaturePluginOptions) => {
  if (module.sdkApiVersion !== manifest.sdkApiVersion) {
    throw new Error('Feature plugin SDK version does not match its Manifest')
  }
  // Publish locales here so the host can register navigation labels before it
  // renders, without depending on an extra top-level export from the entry.
  if (module.locales) {
    trustedPluginLocaleRegistry().set(manifest.id, module.locales)
  }
  registerGroup(
    manifest.id,
    'page',
    manifest.contributions.pages.map(({ id }) => id),
    module.pages as Readonly<Record<string, ComponentType<never>>> | undefined
  )
  registerGroup(
    manifest.id,
    'settings',
    manifest.contributions.settings.map(({ id }) => id),
    module.settings as Readonly<Record<string, ComponentType<never>>> | undefined
  )
  registerGroup(
    manifest.id,
    'permission-presenter',
    manifest.contributions.conversation
      .filter(({ kind }) => kind === 'permission-presenter')
      .map(({ id }) => id),
    module.permissionPresenters as
      | Readonly<Record<string, ComponentType<never>>>
      | undefined
  )
}
