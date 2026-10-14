/**
 * Business operation names (`agents.list`) may carry a trailing release suffix
 * (`agents.list.v1`). The suffix is an alias only: it selects the same host
 * implementation, so new operations should be declared without it while every
 * existing name keeps working.
 *
 * This is the only place the rule is defined on the TypeScript side. It is
 * mirrored by `canonical_operation` in `src-tauri/src/feature_capabilities.rs`,
 * and `tests/fixtures/operation-alias-conformance/cases.json` pins both sides to
 * the same answers.
 */
const OPERATION_RELEASE_SUFFIX = /\.v[0-9]+$/

export const canonicalOperationId = (operationId: string): string =>
  operationId.replace(OPERATION_RELEASE_SUFFIX, '')

export const isSameOperation = (left: string, right: string): boolean =>
  canonicalOperationId(left) === canonicalOperationId(right)
