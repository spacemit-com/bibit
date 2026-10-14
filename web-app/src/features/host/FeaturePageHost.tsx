import {
  FeatureContributionHost,
  type FeatureContributionHostProps,
} from './FeatureContributionHost'

export function FeaturePageHost(props: FeatureContributionHostProps) {
  return <FeatureContributionHost {...props} kind="page" testId="feature-page-host" />
}
