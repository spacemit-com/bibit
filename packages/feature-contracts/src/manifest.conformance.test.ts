import Ajv from 'ajv'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import manifestSchema from '../schema/bibit-feature.schema.json'
import {
  validateFeatureManifestSemantics,
  type FeatureManifestV1,
} from './index'

interface ManifestConformanceCase {
  readonly name: string
  readonly expect: 'accept' | 'reject'
  readonly note: string
  readonly manifest: FeatureManifestV1
}

// The Rust validator reads the same directory, so a rule that lands on only one
// side fails there instead of silently diverging in production.
const casesDirectory = fileURLToPath(
  new URL('../../../tests/fixtures/manifest-conformance/cases', import.meta.url)
)

const loadCases = (): ManifestConformanceCase[] =>
  readdirSync(casesDirectory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map(
      (file) =>
        JSON.parse(
          readFileSync(join(casesDirectory, file), 'utf8')
        ) as ManifestConformanceCase
    )

const validateSchema = new Ajv({ allErrors: true }).compile(manifestSchema)

const acceptsManifest = (manifest: FeatureManifestV1) =>
  Boolean(validateSchema(manifest)) &&
  validateFeatureManifestSemantics(manifest).length === 0

const cases = loadCases()

describe('Feature Manifest conformance cases', () => {
  it('ships a shared case set covering both outcomes', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10)
    expect(cases.some((item) => item.expect === 'accept')).toBe(true)
    expect(cases.some((item) => item.expect === 'reject')).toBe(true)
  })

  it.each(cases)('$name', (conformanceCase) => {
    expect(acceptsManifest(conformanceCase.manifest)).toBe(
      conformanceCase.expect === 'accept'
    )
  })
})
