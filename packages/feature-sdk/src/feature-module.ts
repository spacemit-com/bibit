import type { ComponentType } from 'react'
import type {
  PermissionDecisionReceiptV1,
  PermissionDecisionV1,
  PermissionRequestV1,
} from '@bibit/feature-contracts'

export type FeatureSearchValue = string | readonly string[] | undefined

export interface FeatureRelativeNavigationV1 {
  push(subpath: string, search?: Readonly<Record<string, FeatureSearchValue>>): void
  replace(
    subpath: string,
    search?: Readonly<Record<string, FeatureSearchValue>>
  ): void
  back(): void
}

interface FeatureRoutedContributionProps {
  /** Current host language; contributions default to English when omitted. */
  language?: string
  featureId: string
  contributionId: string
  subpath: string
  search: Readonly<Record<string, FeatureSearchValue>>
  navigation: FeatureRelativeNavigationV1
}

export type FeaturePageProps = FeatureRoutedContributionProps
export type FeatureSettingsProps = FeatureRoutedContributionProps

export interface PermissionPresenterProps {
  request: PermissionRequestV1
  surface: 'main'
  viewState: Readonly<{
    status: 'pending' | 'submitting' | 'resolved' | 'error'
    error?: string
  }>
  decide(decision: PermissionDecisionV1): Promise<PermissionDecisionReceiptV1>
}

export type FeatureLocaleResource = Readonly<Record<string, unknown>>

export interface FeatureModuleV1 {
  sdkApiVersion: 1
  pages?: Readonly<Record<string, ComponentType<FeaturePageProps>>>
  settings?: Readonly<Record<string, ComponentType<FeatureSettingsProps>>>
  permissionPresenters?: Readonly<
    Record<string, ComponentType<PermissionPresenterProps>>
  >
  locales?: Readonly<Record<string, FeatureLocaleResource>>
}
