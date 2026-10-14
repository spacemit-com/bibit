export const FEATURE_PAGE_NAVIGATION_GROUPS = [
  'workspace',
  'library',
  'tools',
] as const

export const FEATURE_SETTINGS_NAVIGATION_GROUPS = [
  'core',
  'features',
  'integrations',
  'privacy',
] as const

export const FEATURE_ICON_KEYS = [
  'store',
  'memory',
  'security',
  'feature',
  'settings',
  'activity',
  'brain',
  'gauge',
  'link',
  'logs',
  'plug',
  'puzzle',
  'radio',
  'server',
  'sparkles',
  'users',
  'wrench',
] as const

export type FeaturePageNavigationGroup =
  (typeof FEATURE_PAGE_NAVIGATION_GROUPS)[number]
export type FeatureSettingsNavigationGroup =
  (typeof FEATURE_SETTINGS_NAVIGATION_GROUPS)[number]
export type FeatureIconKey = (typeof FEATURE_ICON_KEYS)[number]

/**
 * Declared icon and group values are open strings on purpose.
 *
 * A Manifest may name an icon or navigation group that this host build does not
 * know yet, and the host degrades locally (default icon, appended group) rather
 * than refusing a signed plugin over presentation metadata. The closed unions
 * above stay closed because they drive the icon catalog and the menu ordering;
 * they describe what this build renders, not what a plugin may declare.
 */
export type FeatureDeclaredIconKey = string
export type FeatureDeclaredNavigationGroup = string

export interface FeaturePageNavigationV1 {
  group: FeatureDeclaredNavigationGroup
  order?: number
}

export interface FeatureSettingsNavigationV1 {
  group: FeatureDeclaredNavigationGroup
  order?: number
  titleKey?: string
  fallbackTitle?: string
  iconKey?: FeatureDeclaredIconKey
  section?: FeatureSettingsNavigationSectionV1
}

export interface FeatureSettingsNavigationSectionV1 {
  id: string
  titleKey?: string
  fallbackTitle: string
}
