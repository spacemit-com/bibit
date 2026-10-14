import type { FeatureServiceErrorV1 } from './errors'
import type { ProviderFileResourceV1 } from './file-grant'

export const SERVICE_JOB_CONTRACT_VERSION = 1 as const

export const AGENTHUB_TRANSFER_OPERATIONS_V1 = [
  'agents.upload.v1',
  'agents.download.v1',
] as const

export type AgentHubTransferOperationV1 =
  (typeof AGENTHUB_TRANSFER_OPERATIONS_V1)[number]

export const SERVICE_JOB_STATES_V1 = [
  'queued',
  'running',
  'finalizing',
  'cancel_requested',
  'succeeded',
  'failed',
  'cancelled',
] as const

export type ServiceJobStateV1 = (typeof SERVICE_JOB_STATES_V1)[number]
export type ServiceJobTerminalStateV1 = Extract<
  ServiceJobStateV1,
  'succeeded' | 'failed' | 'cancelled'
>

export const SERVICE_JOB_LIMITS_V1 = {
  maxProviderStoredBytes: 512 * 1024 * 1024,
  maxEventsPerJob: 256,
  maxProgressEventsPerSecond: 10,
  defaultMaxConcurrentJobs: 1,
} as const

export const SERVICE_JOB_LIMIT_CODES_V1 = [
  'active_grant_limit',
  'file_size_limit',
  'staging_bytes_limit',
  'provider_storage_limit',
  'event_history_limit',
  'progress_rate_limit',
] as const

export type ServiceJobLimitCodeV1 =
  (typeof SERVICE_JOB_LIMIT_CODES_V1)[number]

export interface ServiceJobProgressV1 {
  completedBytes: number
  totalBytes?: number
}

export interface ServiceJobStartRequestV1 {
  version: typeof SERVICE_JOB_CONTRACT_VERSION
  serviceId: string
  operationId: string
  idempotencyKey: string
  grantId: string
  input: Readonly<Record<string, unknown>>
}

export interface AgentUploadResultV1 {
  agentId: string
  displayName: string
  bytes: number
  sha256: string
}

export interface AgentDownloadResultV1 {
  agentId: string
  bytes: number
  sha256: string
}

export interface ServiceJobOwnerV1 {
  featureId: string
}

export interface ServiceJobSnapshotV1<TResult = unknown> {
  version: typeof SERVICE_JOB_CONTRACT_VERSION
  jobId: string
  owner: ServiceJobOwnerV1
  serviceId: string
  operationId: string
  idempotencyKey: string
  status: ServiceJobStateV1
  lastSequence: number
  progress?: ServiceJobProgressV1
  result?: TResult
  error?: FeatureServiceErrorV1
}

interface ServiceJobEventBaseV1 {
  version: typeof SERVICE_JOB_CONTRACT_VERSION
  jobId: string
  sequence: number
  emittedAt: string
}

export type ServiceJobEventV1<TResult = unknown> =
  | (ServiceJobEventBaseV1 & {
      kind: 'status'
      status: ServiceJobStateV1
    })
  | (ServiceJobEventBaseV1 & {
      kind: 'progress'
      status: 'running' | 'finalizing' | 'cancel_requested'
      progress: ServiceJobProgressV1
    })
  | (ServiceJobEventBaseV1 & {
      kind: 'result'
      status: 'succeeded'
      result: TResult
    })
  | (ServiceJobEventBaseV1 & {
      kind: 'error'
      status: 'failed' | 'cancelled'
      error: FeatureServiceErrorV1
    })

export interface ServiceJobStartResultV1<TResult = unknown> {
  version: typeof SERVICE_JOB_CONTRACT_VERSION
  job: ServiceJobSnapshotV1<TResult>
}

export interface ServiceJobSubscriptionV1 {
  version: typeof SERVICE_JOB_CONTRACT_VERSION
  jobId: string
  afterSequence: number
}

export interface ServiceJobEventBatchV1<TResult = unknown> {
  snapshot: ServiceJobSnapshotV1<TResult>
  events: readonly ServiceJobEventV1<TResult>[]
  hasGap: boolean
}

export interface ServiceJobCancelRequestV1 {
  version: typeof SERVICE_JOB_CONTRACT_VERSION
  jobId: string
}

export interface ProviderJobStartParamsV2 {
  serviceId: string
  jobId: string
  operationId: string
  input: Readonly<Record<string, unknown>>
  resources: readonly ProviderFileResourceV1[]
}

export interface ProviderJobCancelParamsV2 {
  serviceId: string
  jobId: string
}

export interface ProviderJobAcceptedV2 {
  jobId: string
  accepted: true
}

export interface ProviderJobEventParamsV2<TResult = unknown> {
  serviceId: string
  jobId: string
  providerSequence: number
  kind: 'progress' | 'result_ready' | 'cancelled' | 'failed'
  progress?: ServiceJobProgressV1
  result?: TResult
  error?: FeatureServiceErrorV1
}

export type ServiceJobContractIssueCodeV1 =
  | 'invalid-event'
  | 'invalid-status'
  | 'invalid-progress'
  | 'job-mismatch'
  | 'non-monotonic-sequence'
  | 'duplicate-terminal'
  | 'event-after-terminal'

export interface ServiceJobContractIssueV1 {
  code: ServiceJobContractIssueCodeV1
  index: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

const isTerminal = (status: unknown): status is ServiceJobTerminalStateV1 =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled'

export const validateServiceJobEventSequenceV1 = (
  events: readonly unknown[]
): ServiceJobContractIssueV1[] => {
  const issues: ServiceJobContractIssueV1[] = []
  let previousSequence = 0
  let terminalSeen = false
  let jobId: string | undefined

  events.forEach((event, index) => {
    if (
      !isRecord(event) ||
      event.version !== SERVICE_JOB_CONTRACT_VERSION ||
      typeof event.jobId !== 'string' ||
      event.jobId.length === 0 ||
      !Number.isSafeInteger(event.sequence) ||
      (event.sequence as number) <= 0 ||
      !['status', 'progress', 'result', 'error'].includes(
        event.kind as string
      ) ||
      typeof event.emittedAt !== 'string'
    ) {
      issues.push({ code: 'invalid-event', index })
      return
    }

    if (jobId !== undefined && event.jobId !== jobId) {
      issues.push({ code: 'job-mismatch', index })
    }
    jobId ??= event.jobId as string

    if ((event.sequence as number) <= previousSequence) {
      issues.push({ code: 'non-monotonic-sequence', index })
    }
    previousSequence = Math.max(previousSequence, event.sequence as number)

    if (!(SERVICE_JOB_STATES_V1 as readonly unknown[]).includes(event.status)) {
      issues.push({ code: 'invalid-status', index })
      return
    }

    if (terminalSeen) {
      issues.push({
        code: isTerminal(event.status)
          ? 'duplicate-terminal'
          : 'event-after-terminal',
        index,
      })
    }
    if (isTerminal(event.status)) terminalSeen = true

    if (event.kind === 'progress') {
      const progress = event.progress
      if (
        !isRecord(progress) ||
        !isNonNegativeInteger(progress.completedBytes) ||
        (progress.totalBytes !== undefined &&
          (!isNonNegativeInteger(progress.totalBytes) ||
            progress.completedBytes > progress.totalBytes))
      ) {
        issues.push({ code: 'invalid-progress', index })
      }
    }


    if (
      (event.kind === 'result' && event.status !== 'succeeded') ||
      (event.kind === 'error' &&
        event.status !== 'failed' &&
        event.status !== 'cancelled') ||
      (event.kind === 'progress' &&
        event.status !== 'running' &&
        event.status !== 'finalizing' &&
        event.status !== 'cancel_requested')
    ) {
      issues.push({ code: 'invalid-status', index })
    }
  })

  return issues
}
