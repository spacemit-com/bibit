import type {
  PermissionDecisionV1,
  PermissionRequestV1,
} from '@bibit/feature-contracts'
import type {
  PermissionResolveRequest,
  RuntimePermissionData,
} from '@/lib/runtime-contract'

/**
 * Projects the minimum user-facing context into the Feature boundary. Raw tool
 * input deliberately stays in the Runtime UI/contract and is never exposed to
 * a third-party presenter.
 */
export const toRuntimePermissionRequest = (
  data: RuntimePermissionData
): PermissionRequestV1 => ({
  version: 1,
  runtimeInstanceId: `${data.runtimeId}:${data.runtimeEpoch}`,
  requestId: data.requestId,
  runtimeId: data.runtimeId,
  runtimeEpoch: data.runtimeEpoch,
  runId: data.runId,
  sessionId: data.sessionId,
  threadId: data.threadId ?? data.sessionId,
  toolCallId: data.toolCallId,
  action: {
    kind: 'tool',
    name: data.toolName,
    summary: data.description || data.title,
  },
  ...(data.actions?.length ? { actions: data.actions } : {}),
  ...(data.actionSetDigest ? { actionSetDigest: data.actionSetDigest } : {}),
  supportedDecisions: [
    ...(data.canAllowOnce && !data.hasUnsupportedDecision
      ? (['allow_once'] as const)
      : []),
    ...(data.canDeny ? (['deny'] as const) : []),
  ],
  createdAt: data.createdAt,
  expiresAt: data.expiresAt,
})

export const toRuntimePermissionResolveRequest = (
  data: RuntimePermissionData,
  decision: PermissionDecisionV1
): PermissionResolveRequest => {
  const identity = {
    runtimeInstanceId: `${data.runtimeId}:${data.runtimeEpoch}`,
    runtimeId: data.runtimeId,
    runtimeEpoch: data.runtimeEpoch,
    sessionId: data.sessionId,
    threadId: data.threadId ?? data.sessionId,
    runId: data.runId,
    requestId: data.requestId,
    toolCallId: data.toolCallId,
  }
  if (
    Object.entries(identity).some(
      ([field, value]) => decision[field as keyof typeof decision] !== value
    )
  ) {
    throw new Error('Permission decision does not match the Runtime request')
  }
  if (decision.decision !== 'allow_once' && decision.decision !== 'deny') {
    throw new Error('Runtime only supports allow once or deny')
  }
  if (decision.decision === 'deny' && !data.canDeny) {
    throw new Error('Runtime does not support deny')
  }
  if (decision.decision === 'allow_once' && !data.canAllowOnce) {
    throw new Error('Runtime only supports allow once for this request')
  }
  return {
    ...identity,
    decision: decision.decision,
    ...(decision.decision === 'deny' ? { reason: decision.reason } : {}),
    ...(decision.actionSetDigest || data.actionSetDigest
      ? { actionSetDigest: decision.actionSetDigest ?? data.actionSetDigest }
      : {}),
  }
}
