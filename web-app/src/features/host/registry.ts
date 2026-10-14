import type {
  FeatureManifestV1,
  FeaturePageContributionV1,
  FeatureSettingsContributionV1,
  FeatureSurface,
  FeatureTarget,
} from '@bibit/feature-contracts'
import { activeFeatureRegistry } from '@/features/activeFeatureRegistry'

export interface FeatureRegistrySourceEntry {
  readonly packageName: string
  readonly manifest: FeatureManifestV1
  readonly load: () => Promise<unknown>
  readonly featureInstanceToken?: string
}

export interface FeatureInstanceBootstrapV1 {
  readonly featureId: string
  readonly pluginVersion: string
  readonly featureInstanceToken: string
}

type RoutedContribution =
  | FeaturePageContributionV1
  | FeatureSettingsContributionV1

export interface FeatureRegistryContribution {
  readonly key: string
  readonly kind: 'page' | 'settings'
  readonly featureId: string
  readonly contributionId: string
  readonly finalPath: string
  readonly entry: FeatureRegistrySourceEntry
  readonly contribution: RoutedContribution
}

export type FeatureResolution =
  | {
      readonly status: 'found'
      readonly contribution: FeatureRegistryContribution
      readonly subpath: string
    }
  | { readonly status: 'unknown-feature' }
  | { readonly status: 'target-unavailable' }
  | { readonly status: 'path-not-found' }

export type FeatureNavigateOptions = { readonly to: '/'; readonly replace: boolean; readonly params?: never; readonly search?: never } | {
  readonly to: '/features/$featureId/$' | '/settings/features/$featureId/$'
  readonly params: { readonly featureId: string; readonly _splat: string }
  readonly search?: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly replace: boolean
}

export type FeatureNavigate = (
  options: FeatureNavigateOptions
) => void | Promise<void>

export interface FeatureRegistryProjection {
  readonly features: readonly FeatureRegistrySourceEntry[]
  readonly pages: readonly FeatureRegistryContribution[]
  readonly settings: readonly FeatureRegistryContribution[]
  getFeature(featureId: string): FeatureRegistrySourceEntry | undefined
  getContribution(key: string): FeatureRegistryContribution | undefined
  getByFinalPath(path: string): FeatureRegistryContribution | undefined
  resolvePage(featureId: string, subpath: string): FeatureResolution
  resolveSettings(featureId: string, subpath: string): FeatureResolution
}

const normalizeRouteSubpath = (value: string) => value.replace(/^\/+|\/+$/g, '')

const resolve = (
  allEntries: readonly FeatureRegistrySourceEntry[],
  availableEntries: readonly FeatureRegistrySourceEntry[],
  contributions: readonly FeatureRegistryContribution[],
  featureId: string,
  routeSubpath: string
): FeatureResolution => {
  if (!allEntries.some((entry) => entry.manifest.id === featureId)) {
    return { status: 'unknown-feature' }
  }
  if (!availableEntries.some((entry) => entry.manifest.id === featureId)) {
    return { status: 'target-unavailable' }
  }
  const subpath = normalizeRouteSubpath(routeSubpath)
  const matched = contributions.find(({ contribution, featureId: id }) => {
    if (id !== featureId) return false
    const base = normalizeRouteSubpath(contribution.path)
    return base === '' || subpath === base || subpath.startsWith(`${base}/`)
  })
  if (!matched) return { status: 'path-not-found' }
  const base = normalizeRouteSubpath(matched.contribution.path)
  return {
    status: 'found',
    contribution: matched,
    subpath: base === '' ? subpath : subpath.slice(base.length).replace(/^\//, ''),
  }
}

export const createFeatureRegistryProjection = (
  entries: readonly FeatureRegistrySourceEntry[],
  options: { readonly target: FeatureTarget; readonly surface: FeatureSurface }
): FeatureRegistryProjection => {
  const availableEntries = entries.filter((entry) =>
    entry.manifest.targets.includes(options.target)
  )
  const makeContributions = (
    kind: 'page' | 'settings'
  ): readonly FeatureRegistryContribution[] =>
    Object.freeze(
      availableEntries.flatMap((entry) => {
        const contributions =
          kind === 'page'
            ? entry.manifest.contributions.pages
            : entry.manifest.contributions.settings
        return contributions
          .filter((contribution) => contribution.surfaces.includes(options.surface))
          .map((contribution) => {
            const namespace =
              kind === 'page'
                ? `/features/${entry.manifest.id}`
                : `/settings/features/${entry.manifest.id}`
            return Object.freeze({
              key: `${entry.manifest.id}:${contribution.id}`,
              kind,
              featureId: entry.manifest.id,
              contributionId: contribution.id,
              finalPath: contribution.path
                ? `${namespace}/${contribution.path}`
                : namespace,
              entry,
              contribution,
            })
          })
      })
    )
  const features = Object.freeze([...availableEntries])
  const pages = makeContributions('page')
  const settings = makeContributions('settings')
  const all = Object.freeze([...pages, ...settings])
  return Object.freeze({
    features,
    pages,
    settings,
    getFeature: (featureId: string) =>
      availableEntries.find((entry) => entry.manifest.id === featureId),
    getContribution: (key: string) => all.find((item) => item.key === key),
    getByFinalPath: (path: string) => all.find((item) => item.finalPath === path),
    resolvePage: (featureId: string, subpath: string) =>
      resolve(entries, availableEntries, pages, featureId, subpath),
    resolveSettings: (featureId: string, subpath: string) =>
      resolve(entries, availableEntries, settings, featureId, subpath),
  })
}

export const desktopMainFeatureRegistry = createFeatureRegistryProjection(
  activeFeatureRegistry,
  { target: 'desktop', surface: 'main' }
)
