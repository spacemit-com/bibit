import type {
  PermissionDecisionReceiptV1,
  PermissionDecisionV1,
  PermissionRequestV1,
} from '@bibit/feature-contracts'
import type {
  ApprovalDecision,
  PendingApproval,
} from '@/hooks/useToolApprovalRequests'

const currentToolRuntimeEpoch = globalThis.crypto.randomUUID()
const currentToolRuntimeInstanceId = `current-tool-approval:${currentToolRuntimeEpoch}`

const expiresAt = (createdAt: string) => {
  const createdAtMs = Date.parse(createdAt)
  if (!Number.isFinite(createdAtMs)) {
    throw new Error('Current tool permission createdAt is invalid')
  }
  return new Date(createdAtMs + 5 * 60_000).toISOString()
}

export const toCurrentToolPermissionRequest = (
  pending: PendingApproval
): PermissionRequestV1 => ({
  version: 1,
  runtimeInstanceId: currentToolRuntimeInstanceId,
  requestId: pending.toolCallId,
  runtimeId: 'current-tool-approval',
  runtimeEpoch: currentToolRuntimeEpoch,
  sessionId: pending.threadId,
  threadId: pending.threadId,
  runId: `current-tool:${pending.threadId}:${pending.toolCallId}`,
  toolCallId: pending.toolCallId,
  action: {
    kind: 'tool',
    name: pending.toolName,
    summary: `Run ${pending.toolName}`,
  },
  supportedDecisions: ['allow_once', 'deny'],
  createdAt: pending.createdAt,
  expiresAt: expiresAt(pending.createdAt),
})

const toApprovalDecision = (
  decision: PermissionDecisionV1
): ApprovalDecision => {
  return decision.decision === 'deny' ? 'deny' : 'allow-once'
}

export const applyCurrentToolDecision = async (
  request: PermissionRequestV1,
  decision: PermissionDecisionV1,
  resolveApproval: (toolCallId: string, decision: ApprovalDecision) => void
): Promise<PermissionDecisionReceiptV1> => {
  const identity = {
    runtimeInstanceId: request.runtimeInstanceId,
    runtimeId: request.runtimeId,
    runtimeEpoch: request.runtimeEpoch,
    sessionId: request.sessionId,
    threadId: request.threadId,
    runId: request.runId,
    requestId: request.requestId,
    toolCallId: request.toolCallId,
  }
  const identityMatches = Object.entries(identity).every(
    ([field, value]) => decision[field as keyof typeof decision] === value
  )
  if (!identityMatches || !request.supportedDecisions.includes(decision.decision)) {
    return { version: 1, ...identity, decision: decision.decision, status: 'stale' }
  }
  resolveApproval(request.toolCallId, toApprovalDecision(decision))
  return { version: 1, ...identity, decision: decision.decision, status: 'accepted' }
}
