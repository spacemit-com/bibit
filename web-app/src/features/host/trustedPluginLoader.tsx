import {
  createElement,
  useLayoutEffect,
  useRef,
  type ComponentType,
} from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  getTrustedPluginElementTag,
  trustedPluginLocaleRegistry,
  type FeatureManifestV1,
  type TrustedPluginContributionKind,
} from '@bibit/feature-contracts'
import {
  useFeatureHostApi,
  type FeatureHostApiV1,
  type FeatureModuleV1,
  type FeaturePageProps,
  type FeatureSettingsProps,
  type PermissionPresenterProps,
} from '@bibit/feature-sdk'
import type {
  FeatureInstanceBootstrapV1,
  FeatureRegistrySourceEntry,
} from './registry'
import { FeatureErrorState } from '@bibit/feature-ui'
import { useTranslation } from '@/i18n/react-i18next-compat'

export interface ActiveTrustedPluginV1 {
  id: string
  version: string
  featureManifest: FeatureManifestV1
  entrySource: string
  styles: readonly string[]
}

/**
 * 启动路径只拿元数据：4 个系统插件的源码合计约 1.6MB，跟着 prepare_active 一起
 * 过去会把它压在首屏上（序列化 + IPC + JSON.parse，实测这一段约 380ms），而源码
 * 真正要用是在 `load()` 里。源码/样式因此改成按需取。
 */
export interface ActiveTrustedPluginMetadataV1 {
  id: string
  version: string
  featureManifest: FeatureManifestV1
}

/** 注入用的宽类型：元数据 + 可能已经一起带过来的源码/样式。 */
export type TrustedPluginDescriptorV1 = ActiveTrustedPluginMetadataV1 &
  Partial<Pick<ActiveTrustedPluginV1, 'entrySource' | 'styles'>>

export interface RejectedTrustedPluginV1 {
  id: string
  version: string
  code: string
  reason: string
}

export interface TrustedPluginLifecycleV1 {
  id: string
  version: string
  status:
    | 'active'
    | 'rollback-available'
    | 'pending-restart'
    | 'pending-cleanup'
    | 'disabled'
    | 'rejected'
    | 'recovered'
  code?: string
  previousVersion?: string
  reason?: string
}

export interface ActiveTrustedPluginMetadataListV1 {
  plugins: readonly ActiveTrustedPluginMetadataV1[]
  rejected: readonly RejectedTrustedPluginV1[]
  lifecycle?: readonly TrustedPluginLifecycleV1[]
}

export interface ActiveTrustedPluginListV1 {
  plugins: readonly ActiveTrustedPluginV1[]
  rejected: readonly RejectedTrustedPluginV1[]
  lifecycle?: readonly TrustedPluginLifecycleV1[]
}

type RuntimePluginElement = HTMLElement & {
  bibitContext?: { props: object; hostApi?: FeatureHostApiV1 }
}

type RuntimeElementProps = {
  tag: string
  value: object
  hostApi?: FeatureHostApiV1
  fill?: boolean
}

// eslint-disable-next-line react-refresh/only-export-components
function RuntimeElement({ tag, value, hostApi, fill = false }: RuntimeElementProps) {
  const elementRef = useRef<RuntimePluginElement | null>(null)
  useLayoutEffect(() => {
    if (!elementRef.current) return
    elementRef.current.bibitContext = { props: value, hostApi }
  }, [value, hostApi])
  return createElement(tag, {
    ref: elementRef,
    'data-bibit-plugin-root': tag,
    style: {
      display: 'block',
      minWidth: 0,
      maxWidth: '100%',
      ...(fill ? { width: '100%', height: '100%', minHeight: 0 } : {}),
    },
  })
}

const routedComponent = (
  tag: string
): ComponentType<FeaturePageProps | FeatureSettingsProps> =>
  function TrustedPluginRoutedContribution(props) {
    const hostApi = useFeatureHostApi()
    if (!customElements.get(tag)) {
      return <MissingContribution tag={tag} />
    }
    return <RuntimeElement tag={tag} value={{ ...props, language: props.language ?? 'en' }} hostApi={hostApi} fill />
  }

const permissionComponent = (
  tag: string
): ComponentType<PermissionPresenterProps> =>
  function TrustedPluginPermissionPresenter(props) {
    if (!customElements.get(tag)) {
      return <MissingContribution tag={tag} />
    }
    return <RuntimeElement tag={tag} value={props} />
  }

/**
 * A contribution the plugin declared but never registered a renderer for. This
 * is a plugin-side bug, so it stays local to the broken entry instead of
 * disabling the rest of the plugin.
 */
function MissingContribution({ tag }: { tag: string }) {
  const { t } = useTranslation()
  return (
    <FeatureErrorState
      title={t('common:featureEntryUnavailable')}
      description={t('common:featureEntryUnavailableDetail', { entry: tag })}
    />
  )
}

const elementTag = (
  descriptor: ActiveTrustedPluginMetadataV1,
  kind: TrustedPluginContributionKind,
  contributionId: string
) => getTrustedPluginElementTag(descriptor.id, kind, contributionId)

/**
 * Navigation labels must be registered before the first render, so the host
 * needs the plugin locales without importing the entry twice. Plugins built
 * against the current SDK publish them through the shared registry; older
 * bundles still export `pluginLocales` from the entry module. A manifest that
 * declares locales it never ships is reported instead of silently rendering
 * fallback titles.
 */
const resolvePluginLocales = (
  descriptor: ActiveTrustedPluginMetadataV1,
  loaded: Record<string, unknown>
): FeatureModuleV1['locales'] | undefined => {
  const locales =
    (trustedPluginLocaleRegistry().get(descriptor.id) as
      | FeatureModuleV1['locales']
      | undefined) ??
    (loaded.pluginLocales as FeatureModuleV1['locales'] | undefined)
  const declared = descriptor.featureManifest.contributions?.locales ?? []
  const missing = declared.filter((locale) => !locales?.[locale])
  if (missing.length > 0) {
    console.warn(
      `Trusted plugin ${descriptor.id} declares locales without shipping resources: ${missing.join(', ')}`
    )
  }
  return locales
}

const expectedElementTags = (descriptor: ActiveTrustedPluginMetadataV1) => [
  ...descriptor.featureManifest.contributions.pages.map(({ id }) =>
    elementTag(descriptor, 'page', id)
  ),
  ...descriptor.featureManifest.contributions.settings.map(({ id }) =>
    elementTag(descriptor, 'settings', id)
  ),
  ...descriptor.featureManifest.contributions.conversation
    .filter(({ kind }) => kind === 'permission-presenter')
    .map(({ id }) => elementTag(descriptor, 'permission-presenter', id)),
]

const warnAboutMissingElements = (descriptor: ActiveTrustedPluginMetadataV1) => {
  const missing = expectedElementTags(descriptor).filter(
    (tag) => !customElements.get(tag)
  )
  if (missing.length === 0) return
  console.warn(
    `Trusted plugin ${descriptor.id}@${descriptor.version} did not register: ${missing.join(', ')}`
  )
}

export const createTrustedPluginFeatureModule = (
  descriptor: ActiveTrustedPluginMetadataV1,
  locales?: FeatureModuleV1['locales']
): FeatureModuleV1 => ({
  sdkApiVersion: 1,
  pages: Object.fromEntries(
    descriptor.featureManifest.contributions.pages.map(({ id }) => [
      id,
      routedComponent(elementTag(descriptor, 'page', id)),
    ])
  ),
  settings: Object.fromEntries(
    descriptor.featureManifest.contributions.settings.map(({ id }) => [
      id,
      routedComponent(elementTag(descriptor, 'settings', id)),
    ])
  ),
  permissionPresenters: Object.fromEntries(
    descriptor.featureManifest.contributions.conversation
      .filter(({ kind }) => kind === 'permission-presenter')
      .map(({ id }) => [
        id,
        permissionComponent(elementTag(descriptor, 'permission-presenter', id)),
      ])
  ),
  locales,
})

const installStyles = async (descriptor: ActiveTrustedPluginV1) => {
  const scopeRoots = expectedElementTags(descriptor)
  if (scopeRoots.length === 0) return
  // postcss + postcss-selector-parser are ~240 KB of source and are only used
  // here, so they must not ride along in this module's startup chunk: doing so
  // cost ~100 KB of parse on the critical path before the first window paint.
  const { isolatePluginStyles } = await import('./trustedPluginStyles')
  // Parse every stylesheet before installing any of them.
  const styles = descriptor.styles.map(source => isolatePluginStyles(source, scopeRoots))
  styles.forEach((source, index) => {
    const key = `${descriptor.id}:${descriptor.version}:${index}`
    if (document.head.querySelector(`[data-bibit-plugin-style="${CSS.escape(key)}"]`)) {
      return
    }
    const style = document.createElement('style')
    style.textContent = source
    style.dataset.bibitPluginStyle = key
    document.head.append(style)
  })
}

export interface LoadTrustedPluginEntriesOptions {
  listActive?: () => Promise<ActiveTrustedPluginMetadataListV1>
  bootstrapInstance?: (
    descriptor: ActiveTrustedPluginMetadataV1
  ) => Promise<FeatureInstanceBootstrapV1>
  listInstalled?: () => Promise<readonly ActiveTrustedPluginV1[]>
  createModuleUrl?: (source: string) => string
  revokeModuleUrl?: (url: string) => void
  importModule?: (url: string) => Promise<Record<string, unknown>>
}

export const loadTrustedPluginEntries = async ({
  listActive = () =>
    invoke<ActiveTrustedPluginMetadataListV1>('trusted_plugin_prepare_active'),
  listInstalled = () =>
    invoke<ActiveTrustedPluginListV1>('trusted_plugin_list_active').then(
      ({ plugins }) => plugins
    ),
  bootstrapInstance = ({ id, version }) =>
    invoke<FeatureInstanceBootstrapV1>('trusted_plugin_bootstrap', {
      request: { featureId: id, pluginVersion: version },
    }),
  createModuleUrl = (source) =>
    URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
  revokeModuleUrl = (url) => URL.revokeObjectURL(url),
  importModule = (url) => import(/* @vite-ignore */ url),
}: LoadTrustedPluginEntriesOptions = {}): Promise<FeatureRegistrySourceEntry[]> => {
  let descriptors: readonly ActiveTrustedPluginMetadataV1[]
  // 同一批插件共享一次「取完整描述符」的 IPC：多个模块同时加载不会各拉一份。
  let installed: Promise<readonly ActiveTrustedPluginV1[]> | undefined
  const resolveDescriptor = async (
    descriptor: TrustedPluginDescriptorV1
  ): Promise<ActiveTrustedPluginV1> => {
    if (descriptor.entrySource !== undefined) {
      return { ...descriptor, entrySource: descriptor.entrySource, styles: descriptor.styles ?? [] }
    }
    const all = await (installed ??= listInstalled())
    const match = all.find(
      ({ id, version }) =>
        id === descriptor.id && version === descriptor.version
    )
    if (!match) {
      throw new Error(
        `Trusted plugin source is unavailable: ${descriptor.id}@${descriptor.version}`
      )
    }
    return match
  }
  try {
    const active = await listActive()
    descriptors = active.plugins
    active.rejected.forEach(({ id, version, reason }) =>
      console.error(`Rejected trusted plugin ${id}@${version}: ${reason}`)
    )
    console.info(
      `Loaded trusted plugins: ${descriptors.map(({ id, version }) => `${id}@${version}`).join(', ') || 'none'}`
    )
  } catch (error) {
    console.error('Failed to list trusted plugins:', error)
    return []
  }
  const entries = await Promise.all(
    descriptors.map(async (descriptor) => {
      try {
        const bootstrap = await bootstrapInstance(descriptor)
        if (
          bootstrap.featureId !== descriptor.id ||
          bootstrap.pluginVersion !== descriptor.version ||
          !bootstrap.featureInstanceToken
        ) {
          throw new Error('Trusted plugin bootstrap identity mismatch')
        }
        // 设置页和审批卡片必须共享插件模块，避免重复执行包后混用 React 实例。
        let loading: Promise<FeatureModuleV1> | undefined
        return {
          packageName: `trusted-plugin:${descriptor.id}@${descriptor.version}`,
          manifest: descriptor.featureManifest,
          featureInstanceToken: bootstrap.featureInstanceToken,
          load: () => loading ??= (async () => {
            const full = await resolveDescriptor(descriptor)
            const moduleUrl = createModuleUrl(full.entrySource)
            let loaded: Record<string, unknown>
            try {
              loaded = await importModule(moduleUrl)
            } finally {
              revokeModuleUrl(moduleUrl)
            }
            warnAboutMissingElements(descriptor)
            await installStyles(full)
            return createTrustedPluginFeatureModule(
              descriptor,
              resolvePluginLocales(descriptor, loaded)
            )
          })().catch((error: unknown) => {
            loading = undefined
            throw error
          }),
        } satisfies FeatureRegistrySourceEntry
      } catch (error) {
        console.error(
          `Failed to bootstrap trusted plugin ${descriptor.id}@${descriptor.version}:`,
          error
        )
        return undefined
      }
    })
  )
  return entries.filter((entry) => entry !== undefined)
}
