import { createHash } from 'node:crypto'

export const GENERATOR_VERSION = '1.0.0'

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  return value
}

export const canonicalInputDigest = ({ features, grants, schema }) => {
  const input = {
    generatorVersion: GENERATOR_VERSION,
    schema,
    grants,
    features: features.map((feature) => ({
      packageName: feature.packageName,
      bibitFeature: feature.bibitFeature,
      exportTarget: feature.exportTarget,
      manifest: feature.manifest,
    })),
  }
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(input)))
    .digest('hex')
}

const indent = (source, spaces) => {
  const prefix = ' '.repeat(spaces)
  return source
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

const renderEntry = (feature) => {
  const manifest = indent(JSON.stringify(feature.manifest, null, 2), 4).trimStart()
  return `  {
    packageName: '${feature.packageName}',
    manifest: ${manifest} as FeatureManifestV1,
    load: () => import('${feature.packageName}/bibit-feature'),
  }`
}

export function renderRegistry(features, digest) {
  const entries = features.map(renderEntry).join(',\n')
  return `// This file is generated. Do not edit manually.
// Generator version: ${GENERATOR_VERSION}
// Canonical input SHA-256: ${digest}

import type { FeatureManifestV1 } from '@bibit/feature-contracts'

export interface GeneratedFeatureRegistryEntry {
  readonly packageName: string
  readonly manifest: FeatureManifestV1
  readonly load: () => Promise<unknown>
}

export const featureRegistry = [
${entries}
] as const satisfies readonly GeneratedFeatureRegistryEntry[]
`
}
