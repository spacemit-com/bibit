import type { ComponentType } from 'react'
import {
  FEATURE_SETTINGS_NAVIGATION_GROUPS,
  type FeaturePageNavigationGroup,
  type FeatureSettingsNavigationGroup,
  type FeatureSettingsNavigationSectionV1,
} from '@bibit/feature-contracts'
import { getFeatureIcon } from '@bibit/feature-ui'

const compareCodePoints = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

export interface FeatureNavigationItem {
  id: string
  group?: string
  order?: number
  title: string
  titleKey?: string
  path: string
  iconKey: string
}

const mainGroupOrder = {
  workspace: 0,
  library: 1,
  tools: 2,
} as const satisfies Record<FeaturePageNavigationGroup, number>

/**
 * A group this build does not know ranks after every known group. A missing
 * lookup must not reach the comparator: `undefined - undefined` is `NaN`, and a
 * `NaN` comparator hands the whole menu order to the sort implementation.
 */
const groupRank = (
  order: Readonly<Record<string, number>>,
  group: string
): number => order[group] ?? Number.MAX_SAFE_INTEGER

export const mergeFeatureNavigation = (
  items: readonly FeatureNavigationItem[]
) =>
  items
    .filter(
      (item): item is FeatureNavigationItem & { group: string } =>
        item.group !== undefined
    )
    .sort(
      (left, right) =>
        groupRank(mainGroupOrder, left.group) -
          groupRank(mainGroupOrder, right.group) ||
        (left.order ?? 1000) - (right.order ?? 1000) ||
        compareCodePoints(left.id, right.id)
    )

export const buildFeatureNavMainItems = (
  items: readonly FeatureNavigationItem[],
  translate: (key: string) => string
) =>
  items.map((item) => {
    const translated = item.titleKey ? translate(item.titleKey) : item.title
    return {
      id: item.id,
      title: item.title,
      literalLabel: translated === item.titleKey ? item.title : translated,
      url: item.path,
      icon: getFeatureIcon(item.iconKey) as ComponentType<{
        className?: string
      }>,
    }
  })

export interface FeatureSettingsNavigationItem {
  id: string
  group?: string
  order?: number
  title: string
  titleKey?: string
  path: string
  iconKey: string
  section?: FeatureSettingsNavigationSectionV1
}

const settingsGroupOrder = {
  core: 0,
  features: 1,
  integrations: 2,
  privacy: 3,
} as const satisfies Record<FeatureSettingsNavigationGroup, number>

export const mergeFeatureSettingsNavigation = (
  items: readonly FeatureSettingsNavigationItem[]
) =>
  items
    .filter(
      (item): item is FeatureSettingsNavigationItem & { group: string } =>
        item.group !== undefined
    )
    .sort(
      (left, right) =>
        groupRank(settingsGroupOrder, left.group) -
          groupRank(settingsGroupOrder, right.group) ||
        (left.order ?? 1000) - (right.order ?? 1000) ||
        compareCodePoints(left.id, right.id)
    )

/**
 * Settings entries used to be filtered into four exact buckets, so a group this
 * build did not know made the entry disappear from Settings entirely. Unknown
 * groups now land in `features`, which keeps the entry reachable until a host
 * build ships a bucket for it.
 */
const settingsBucket = (group: string): FeatureSettingsNavigationGroup =>
  (FEATURE_SETTINGS_NAVIGATION_GROUPS as readonly string[]).includes(group)
    ? (group as FeatureSettingsNavigationGroup)
    : 'features'

export const groupFeatureSettingsNavigation = (
  items: readonly (FeatureSettingsNavigationItem & { group: string })[]
): Record<FeatureSettingsNavigationGroup, FeatureSettingsNavigationItem[]> => {
  const buckets: Record<
    FeatureSettingsNavigationGroup,
    FeatureSettingsNavigationItem[]
  > = { core: [], features: [], integrations: [], privacy: [] }
  for (const item of items) {
    buckets[settingsBucket(item.group)].push(item)
  }
  return buckets
}
