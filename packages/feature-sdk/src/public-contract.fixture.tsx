import type { ComponentType } from 'react'
import type {
  FeatureModuleV1,
  FeaturePageProps,
  FeatureSettingsProps,
} from './index'

declare const Page: ComponentType<FeaturePageProps>
declare const Settings: ComponentType<FeatureSettingsProps>

export const featureModuleFixture = {
  sdkApiVersion: 1,
  pages: { home: Page },
  settings: { manage: Settings },
  locales: { en: { title: 'Fixture' } },
} satisfies FeatureModuleV1
