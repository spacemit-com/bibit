import {
  FeatureContributionHost,
  type FeatureContributionHostProps,
} from './FeatureContributionHost'

export function FeatureSettingsHost(props: FeatureContributionHostProps) {
  return (
    <FeatureContributionHost
      {...props}
      kind="settings"
      testId="feature-settings-host"
    />
  )
}
