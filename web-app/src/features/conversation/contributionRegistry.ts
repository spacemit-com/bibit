import type {
  FeatureConversationContributionV1,
  FeatureSurface,
  FeatureTarget,
} from '@bibit/feature-contracts'
import { activeFeatureRegistry } from '@/features/activeFeatureRegistry'
import type { FeatureRegistrySourceEntry } from '@/features/host/registry'

export interface ConversationRegistryContribution {
  readonly key: string
  readonly featureId: string
  readonly contributionId: string
  readonly contribution: FeatureConversationContributionV1
  readonly load: () => Promise<unknown>
}

export interface ConversationContributionRegistry {
  readonly contributions: readonly ConversationRegistryContribution[]
  getPermissionPresenter(): ConversationRegistryContribution | undefined
}

export const createConversationContributionRegistry = (
  entries: readonly FeatureRegistrySourceEntry[],
  options: { readonly target: FeatureTarget; readonly surface: FeatureSurface }
): ConversationContributionRegistry => {
  const contributions = Object.freeze(
    entries
      .filter((entry) => entry.manifest.targets.includes(options.target))
      .flatMap((entry) =>
        entry.manifest.contributions.conversation
          .filter((item) => item.surfaces.includes(options.surface))
          .map((item) =>
            Object.freeze({
              key: `${entry.manifest.id}:${item.id}`,
              featureId: entry.manifest.id,
              contributionId: item.id,
              contribution: item,
              load: entry.load,
            })
          )
      )
  )
  return Object.freeze({
    contributions,
    getPermissionPresenter: () =>
      contributions.length === 1 ? contributions[0] : undefined,
  })
}

export const desktopMainConversationRegistry =
  createConversationContributionRegistry(activeFeatureRegistry, {
    target: 'desktop',
    surface: 'main',
  })
