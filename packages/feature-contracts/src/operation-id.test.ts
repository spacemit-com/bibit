import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canonicalOperationId, isSameOperation } from './operation-id'

interface OperationAliasCase {
  readonly operation: string
  readonly canonical: string
}

// The Rust mirror reads the same file, so a rule that lands on only one side
// fails there instead of silently diverging in production.
const cases = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../tests/fixtures/operation-alias-conformance/cases.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as { cases: OperationAliasCase[] }
).cases

describe('operation release-suffix aliasing', () => {
  it('ships a case set covering both outcomes', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10)
    expect(cases.some((item) => item.operation !== item.canonical)).toBe(true)
    expect(cases.some((item) => item.operation === item.canonical)).toBe(true)
  })

  it.each(cases)('$operation -> $canonical', ({ operation, canonical }) => {
    expect(canonicalOperationId(operation)).toBe(canonical)
  })

  it('treats two spellings of one operation as the same operation', () => {
    expect(isSameOperation('agents.list.v1', 'agents.list')).toBe(true)
    expect(isSameOperation('agents.list', 'agents.get')).toBe(false)
  })
})
