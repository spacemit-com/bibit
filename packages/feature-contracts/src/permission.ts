export type PermissionActionKindV1 = 'tool' | 'filesystem' | 'network' | 'system'

export interface PermissionActionV1 {
  kind: PermissionActionKindV1
  name: string
  summary: string
  details?: Readonly<Record<string, unknown>>
}

export interface PermissionIdentityV1 {
  runtimeInstanceId: string
  runtimeId: string
  runtimeEpoch: string
  sessionId: string
  threadId: string
  runId: string
  requestId: string
  toolCallId: string
}

export type PermissionDecisionKindV1 = 'allow_once' | 'deny'

export interface PermissionRequestV1 extends PermissionIdentityV1 {
  version: 1
  action: PermissionActionV1
  /** Full batch projection. Single-action requests contain one item. */
  actions?: readonly PermissionActionV1[]
  /** SHA-256 of the canonical action projection. */
  actionSetDigest?: string
  supportedDecisions: readonly PermissionDecisionKindV1[]
  createdAt: string
  expiresAt: string
}

export type PermissionDenyReasonV1 =
  | 'user-denied'
  | 'cancelled'
  | 'timed-out'
  | 'presenter-failed'
  | 'runtime-closed'

export type PermissionDecisionV1 = PermissionIdentityV1 &
  (
    | {
        version: 1
        decision: 'allow_once'
        actionSetDigest?: string
      }
    | {
        version: 1
        decision: 'deny'
        reason: PermissionDenyReasonV1
        actionSetDigest?: string
      }
  )

export type PermissionDecisionReceiptStatusV1 =
  | 'accepted'
  | 'duplicate'
  | 'stale'
  | 'expired'
  | 'rejected'

export interface PermissionDecisionReceiptV1 extends PermissionIdentityV1 {
  version: 1
  decision: PermissionDecisionKindV1
  status: PermissionDecisionReceiptStatusV1
  actionSetDigest?: string
  reason?: PermissionDenyReasonV1
}
