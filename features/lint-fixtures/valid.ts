import type { FeatureModuleV1 } from '@bibit/feature-sdk'
import type { FeatureManifestV1 } from '@bibit/feature-contracts'
import { Button } from '@bibit/feature-ui'
import localValue from './local'

export const valid: [FeatureModuleV1, FeatureManifestV1, typeof Button, string] =
  [{} as FeatureModuleV1, {} as FeatureManifestV1, Button, localValue]
