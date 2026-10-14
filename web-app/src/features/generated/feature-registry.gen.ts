// This file is generated. Do not edit manually.
// Generator version: 1.0.0
// Canonical input SHA-256: 01a3d776746e9c3bbafeac07e2573fdf3fbeb4cb0b01660390b1667afc99c3aa

import type { FeatureManifestV1 } from '@bibit/feature-contracts'

export interface GeneratedFeatureRegistryEntry {
  readonly packageName: string
  readonly manifest: FeatureManifestV1
  readonly load: () => Promise<unknown>
}

export const featureRegistry = [

] as const satisfies readonly GeneratedFeatureRegistryEntry[]
