import type { FeatureHostCapability } from './capabilities'
import type {
  FeatureDeclaredIconKey,
  FeaturePageNavigationV1,
  FeatureSettingsNavigationV1,
} from './navigation'

export const FEATURE_MANIFEST_SCHEMA_VERSION = 1 as const
export const FEATURE_SDK_API_VERSION = 1 as const

export const FEATURE_TARGETS = ['desktop'] as const
export const FEATURE_SURFACES = ['main'] as const
// Only wired kinds belong here. The host renders permission presenters; it has
// no entry point for the other conversation shapes, so declaring them used to
// validate and then silently render nothing. Add a kind only together with its
// host renderer and an element-tag assertion in the trusted plugin loader.
export const FEATURE_CONVERSATION_KINDS = ['permission-presenter'] as const

export type FeatureTarget = (typeof FEATURE_TARGETS)[number]
export type FeatureSurface = (typeof FEATURE_SURFACES)[number]
export type FeatureConversationKind =
  (typeof FEATURE_CONVERSATION_KINDS)[number]

type FeatureDisplayDescriptionV1 =
  | {
      descriptionKey: string
      fallbackDescription: string
    }
  | {
      descriptionKey?: never
      fallbackDescription?: never
    }

export type FeatureDisplayMetadataV1 = {
  titleKey: string
  fallbackTitle: string
  iconKey: FeatureDeclaredIconKey
} & FeatureDisplayDescriptionV1

export interface FeaturePageContributionV1 {
  id: string
  path: string
  surfaces: readonly FeatureSurface[]
  navigation?: FeaturePageNavigationV1
}

export interface FeatureSettingsContributionV1 {
  id: string
  path: string
  surfaces: readonly FeatureSurface[]
  navigation?: FeatureSettingsNavigationV1
}

export interface FeatureConversationContributionV1 {
  id: string
  kind: FeatureConversationKind
  surfaces: readonly FeatureSurface[]
  order?: number
}

export interface FeatureContributionsV1 {
  pages: FeaturePageContributionV1[]
  settings: FeatureSettingsContributionV1[]
  conversation: FeatureConversationContributionV1[]
  locales: string[]
}

export interface FeatureManifestV1 {
  manifestSchemaVersion: typeof FEATURE_MANIFEST_SCHEMA_VERSION
  sdkApiVersion: typeof FEATURE_SDK_API_VERSION
  id: string
  version: string
  owner: string
  display: FeatureDisplayMetadataV1
  targets: FeatureTarget[]
  requiredHostCapabilities: FeatureHostCapability[]
  contributions: FeatureContributionsV1
}

export interface FeatureManifestSemanticIssue {
  code: 'duplicate-contribution-id' | 'overlapping-contribution-path'
  path: string
  message: string
}

type RoutedContribution =
  | FeaturePageContributionV1
  | FeatureSettingsContributionV1

const pathsOverlap = (left: string, right: string) =>
  left === right ||
  left === '' ||
  right === '' ||
  left.startsWith(`${right}/`) ||
  right.startsWith(`${left}/`)

const findPathOverlaps = (
  kind: 'pages' | 'settings',
  contributions: readonly RoutedContribution[]
): FeatureManifestSemanticIssue[] => {
  const issues: FeatureManifestSemanticIssue[] = []
  for (let leftIndex = 0; leftIndex < contributions.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < contributions.length;
      rightIndex += 1
    ) {
      const left = contributions[leftIndex]
      const right = contributions[rightIndex]
      const sharesSurface = left.surfaces.some((surface) =>
        right.surfaces.includes(surface)
      )
      if (sharesSurface && pathsOverlap(left.path, right.path)) {
        issues.push({
          code: 'overlapping-contribution-path',
          path: `contributions.${kind}`,
          message: `${left.id} and ${right.id} own overlapping paths`,
        })
      }
    }
  }
  return issues
}

export const validateFeatureManifestSemantics = (
  manifest: FeatureManifestV1
): FeatureManifestSemanticIssue[] => {
  const issues: FeatureManifestSemanticIssue[] = []
  const contributionIds = new Set<string>()
  const contributions = [
    ...manifest.contributions.pages,
    ...manifest.contributions.settings,
    ...manifest.contributions.conversation,
  ]

  for (const contribution of contributions) {
    if (contributionIds.has(contribution.id)) {
      issues.push({
        code: 'duplicate-contribution-id',
        path: 'contributions',
        message: `duplicate contribution id: ${contribution.id}`,
      })
    }
    contributionIds.add(contribution.id)
  }

  issues.push(
    ...findPathOverlaps('pages', manifest.contributions.pages),
    ...findPathOverlaps('settings', manifest.contributions.settings)
  )
  return issues
}
