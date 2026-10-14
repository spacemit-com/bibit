import i18n from '@/i18n/setup'

export const RUNTIME_EVENT_NAME = 'runtime-event'
export const RUNTIME_SCHEMA_VERSION = '2.0' as const
export const RUNTIME_SCHEMA_VERSIONS = ['1.0', RUNTIME_SCHEMA_VERSION] as const
export type RuntimeSchemaVersion = (typeof RUNTIME_SCHEMA_VERSIONS)[number]
export const RUNTIME_ID = 'hermes' as const
export const RUNTIME_IDS = ['hermes', 'bianbu'] as const
export type RuntimeId = (typeof RUNTIME_IDS)[number]
export const RUNTIME_SESSION_ID = '__runtime__' as const

export type RuntimeStatus =
  | 'stopped'
  | 'checking'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'failed'

export type RuntimeErrorCode =
  | 'hermes_not_found'
  | 'hermes_check_failed'
  | 'hermes_start_failed'
  | 'acp_initialize_failed'
  | 'acp_protocol_error'
  | 'acp_capability_missing'
  | 'session_create_failed'
  | 'session_conflict'
  | 'run_conflict'
  | 'run_failed'
  | 'skill_unavailable'
  | 'run_incomplete'
  | 'run_interrupted'
  | 'security_denied'
  | 'security_unavailable'
  | 'network_policy_blocked'
  | 'provider_timeout'
  | 'provider_connection_failed'
  | 'TOKEN_BUDGET_EXCEEDED'
  | 'worker_rpc_error'
  | 'permission_expired'
  | 'cancel_timeout'
  | 'read_timeout'
  | 'controller_busy'
  | 'controller_required'
  | 'process_exited'
  | 'internal_error'

export type RuntimeError = {
  code: RuntimeErrorCode
  message: string
  recoverable: boolean
  details?: Record<string, unknown>
}

export type PermissionDecision = 'allow_once' | 'deny'
export type PermissionDenyReason =
  | 'user-denied'
  | 'cancelled'
  | 'timed-out'
  | 'presenter-failed'
  | 'runtime-closed'
export type DiagnosticLevel = 'info' | 'warning'
export type RuntimeConnectionStatus =
  | 'connected'
  | 'reconnecting'
  | 'disconnected'

export type PermissionRequest = {
  requestId: string
  toolCallId: string
  title: string
  description: string
  toolName: string
  inputSummary?: unknown
  canAllowOnce: boolean
  canDeny: boolean
  actions?: readonly PermissionAction[]
  actionSetDigest?: string
  hasUnsupportedDecision?: boolean
  expiresAt: string
}

export type PermissionAction = {
  kind: 'tool' | 'filesystem' | 'network' | 'system'
  name: string
  summary: string
}

export type RuntimeEvent =
  | {
      type: 'runtime_status_changed'
      status: RuntimeStatus
      message?: string
    }
  | {
      type: 'connection_status_changed'
      status: RuntimeConnectionStatus
      message?: string
    }
  | { type: 'run_started'; userMessageId: string }
  | { type: 'text_delta'; messageId: string; delta: string }
  | { type: 'reasoning_delta'; messageId: string; delta: string }
  | { type: 'tool_started'; toolCallId: string; name: string; input?: unknown }
  | { type: 'tool_updated'; toolCallId: string; update: unknown }
  | {
      type: 'tool_completed'
      toolCallId: string
      result?: unknown
      error?: string
    }
  | { type: 'permission_requested'; request: PermissionRequest }
  | {
      type: 'permission_resolved'
      requestId: string
      decision: PermissionDecision
    }
  | {
      type: 'permission_audit'
      requestId: string
      decision: PermissionDecision
      status: PermissionResolveStatus
      reason?: PermissionDenyReason
      actionSetDigest?: string
    }
  | { type: 'diagnostic_notice'; level: DiagnosticLevel; message: string }
  | { type: 'run_completed'; stopReason?: string }
  | { type: 'run_cancelled'; reason?: string }
  | { type: 'run_failed'; error: RuntimeError }

export type RuntimeEventEnvelope = {
  schemaVersion: RuntimeSchemaVersion
  eventId: string
  runtimeId: RuntimeId
  runtimeEpoch: string
  sessionId: string
  runId?: string
  sequence: number
  timestamp: string
  event: RuntimeEvent
}

export type RuntimeToolData = {
  toolCallId: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  input?: unknown
  update?: unknown
  result?: unknown
  error?: string
}

/** 审批失效的原因代码：界面层负责把它们翻成当前语言。 */
export type PermissionExpiredReason = 'timeout' | 'ended'

export type RuntimePermissionData = {
  targetId?: string
  runtimeId: RuntimeId
  runtimeEpoch: string
  sessionId: string
  /** Optional when a Runtime distinguishes UI thread from session. */
  threadId?: string
  runId: string
  createdAt: string
  expiresAt: string
  requestId: string
  toolCallId: string
  title: string
  description: string
  toolName: string
  inputSummary?: unknown
  actions?: readonly PermissionAction[]
  actionSetDigest?: string
  hasUnsupportedDecision?: boolean
  canAllowOnce: boolean
  canDeny: boolean
  status: 'pending' | 'resolved'
  /**
   * 失效原因；业务上仍视为 resolved，不允许再次决定。本仓的投影层只写
   * PermissionExpiredReason 代码，文案由界面层翻译；Runtime 若自带原因文本，
   * 原文照渲染。
   */
  expiredReason?: string
  decision?: 'allow_once' | 'deny'
}

export type RuntimeDiagnosticData = {
  level: 'info' | 'warning'
  message: string
  /** 机器可读的失败代码（如 `worker_rpc_error`）。界面层优先按它查文案，
   *  查不到再退回 message；命中时把 message 原文作为排查证据附在下方。 */
  code?: string
  /** Runtime 判定「不做任何改动直接重试是否可能成功」。缺省表示 Runtime
   *  没有给出判定，界面不替它承诺可以重试。 */
  retryable?: boolean
  /** Runtime 给出的定位信息（工具、能力、上游状态码等）。渲染前必须脱敏，
   *  这里保存的是 Runtime 原文，界面层负责选择展示哪些字段。 */
  details?: Record<string, unknown>
}

export type RuntimeDataParts = {
  'runtime-tool': RuntimeToolData
  'runtime-permission': RuntimePermissionData
  'runtime-diagnostic': RuntimeDiagnosticData
}

export type RuntimeSnapshot = {
  runtimeId: RuntimeId
  status: RuntimeStatus
  runtimeEpoch?: string
  sequence: number
  message?: string
}

export type RuntimeCapabilities = {
  sessionEvents?: boolean
  sessionInbox?: boolean
  durableSessions: boolean
  detachedRuns: boolean
  replayableEvents: boolean
  runtimeOwnedApprovals: boolean
  agentSelection?: boolean
  sessionManagement?: boolean
  contextClear?: boolean
  titleGeneration?: boolean
  sessionAttachments?: boolean
  skillSelection?: boolean
  /** Runtime 是否接受历史写操作（POST /sessions/{id}/history）。 */
  historyOperations?: boolean
  /** Runtime 是否支持跨会话正文检索（GET /sessions/search）。 */
  sessionSearch?: boolean
}

export type SessionAttachmentRef = { resourceId: string }

export type RuntimeDescriptor = {
  id: RuntimeId
  displayName: string
  available: boolean
  capabilities: RuntimeCapabilities
  error?: string
}

export type RuntimeRunSnapshot = {
  id: string
  sessionId: string
  agentId: string
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  content: string
  usage?: unknown
  error?: unknown
  pendingActions: unknown[]
  eventCursor: number
  createdAt: number
  updatedAt: number
}

export type RuntimeAgent = {
  id: string
  /** `system` 为 Runtime 内置助手，`user` 为用户自建。 */
  origin?: string
  name: string
  zhName: string
  model?: unknown
  available: boolean
  unavailableReason: string
  /** The agent's own skill selectors; the temporary skill picker hides them. */
  skills?: string[]
  /** Tools the agent named: naming a Plugin member materializes its owning Plugin. */
  tools?: string[]
  /** Plugins the agent selected: their Skills already run, so the picker hides them too. */
  plugins?: string[]
  /** MCP servers the agent selected, whose owning Plugin also brings its Skills. */
  mcps?: string[]
}

export type SessionTitleResult = { title: string; runId: string | null; status: string }

export type RuntimeSession = {
  running?: boolean
  waiting?: boolean
  failed?: boolean
  completedUnread?: boolean
  activeRunId?: string | null
  pendingInteraction?: string | null
  id: string
  title: string
  agentId: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  latestRun?: RuntimeRunSnapshot
}

export type RuntimeMessage = {
  id: string
  role: string
  content: string
  requestId?: string
  createdAt?: number
  seq?: number
  [key: string]: unknown
}

export type SessionCreateRequest = { sessionId: string; title?: string; agentId?: string }
export type SessionCreateResult = {
  sessionId: string
  runtimeSessionId: string
  runtimeEpoch: string
  reused: boolean
}
export type RunStartRequest = {
  sessionId: string
  userMessageId: string
  prompt: string
}
export type RunStartResult = { runId: string }
export type RunCancelRequest = { sessionId: string; runId: string }
export type PermissionResolveRequest = {
  runtimeInstanceId: string
  runtimeId: RuntimeId
  runtimeEpoch: string
  sessionId: string
  threadId: string
  runId: string
  requestId: string
  toolCallId: string
  decision: 'allow_once' | 'deny'
  reason?: PermissionDenyReason
  actionSetDigest?: string
}
export type CommandAck = { accepted: boolean; duplicate: boolean }
export type PermissionResolveStatus =
  | 'accepted'
  | 'duplicate'
  | 'stale'
  | 'expired'
  | 'rejected'
export type PermissionDecisionReceipt = PermissionResolveRequest & {
  version: 1
  status: PermissionResolveStatus
}

export const runtimeDataPartType = {
  tool: 'data-runtime-tool',
  permission: 'data-runtime-permission',
  diagnostic: 'data-runtime-diagnostic',
} as const

const runtimeStatuses = [
  'stopped',
  'checking',
  'starting',
  'ready',
  'stopping',
  'failed',
] as const satisfies readonly RuntimeStatus[]

const runtimeErrorCodes = [
  'hermes_not_found',
  'hermes_check_failed',
  'hermes_start_failed',
  'acp_initialize_failed',
  'acp_protocol_error',
  'acp_capability_missing',
  'session_create_failed',
  'session_conflict',
  'run_conflict',
  'run_failed',
  'skill_unavailable',
  'run_incomplete',
  'run_interrupted',
  'security_denied',
  'security_unavailable',
  'network_policy_blocked',
  'provider_timeout',
  'provider_connection_failed',
  'TOKEN_BUDGET_EXCEEDED',
  'worker_rpc_error',
  'permission_expired',
  'cancel_timeout',
  'read_timeout',
  'controller_busy',
  'controller_required',
  'process_exited',
  'internal_error',
] as const satisfies readonly RuntimeErrorCode[]

const permissionDecisions = [
  'allow_once',
  'deny',
] as const satisfies readonly PermissionDecision[]

const permissionDenyReasons = [
  'user-denied',
  'cancelled',
  'timed-out',
  'presenter-failed',
  'runtime-closed',
] as const satisfies readonly PermissionDenyReason[]

const diagnosticLevels = [
  'info',
  'warning',
] as const satisfies readonly DiagnosticLevel[]

const runtimeConnectionStatuses = [
  'connected',
  'reconnecting',
  'disconnected',
] as const satisfies readonly RuntimeConnectionStatus[]

const permissionResolveStatuses = [
  'accepted',
  'duplicate',
  'stale',
  'expired',
  'rejected',
] as const satisfies readonly PermissionResolveStatus[]

type UnknownRecord = Record<string, unknown>
type OptionalValue<T> = { present: false } | { present: true; value: T }

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function requireField(
  record: UnknownRecord,
  field: string,
  path: string
): unknown {
  if (!hasOwn(record, field)) {
    return fail(path, 'missing field')
  }
  return record[field]
}

function fail(path: string, expectation: string): never {
  throw new Error(`${path}: ${expectation}`)
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireObject(
  value: unknown,
  path: string,
  allowedFields: readonly string[]
): UnknownRecord {
  if (!isPlainRecord(value)) {
    return fail(path, 'expected a plain object')
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedFields.includes(key)) {
      fail(`${path}.${String(key)}`, 'unknown field')
    }
  }

  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    return fail(path, 'expected a string')
  }
  return value
}

function requireNonEmptyString(value: unknown, path: string): string {
  const stringValue = requireString(value, path)
  if (stringValue.length === 0) {
    return fail(path, 'expected a non-empty string')
  }
  return stringValue
}

function requireSha256Digest(value: unknown, path: string): string {
  const digest = requireNonEmptyString(value, path)
  if (!/^[0-9a-f]{64}$/i.test(digest)) {
    return fail(path, 'expected a 64-character SHA-256 hex digest')
  }
  return digest.toLowerCase()
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    return fail(path, 'expected a boolean')
  }
  return value
}

function requireSequence(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail(path, 'expected a non-negative safe integer')
  }
  return value
}

function isOneOf<T extends string>(
  value: unknown,
  candidates: readonly T[]
): value is T {
  return (
    typeof value === 'string' &&
    candidates.some((candidate: string) => candidate === value)
  )
}

function requireOneOf<T extends string>(
  value: unknown,
  candidates: readonly T[],
  path: string
): T {
  if (!isOneOf(value, candidates)) {
    return fail(path, `expected one of: ${candidates.join(', ')}`)
  }
  return value
}

function optionalString(
  record: UnknownRecord,
  field: string,
  path: string
): OptionalValue<string> {
  if (!hasOwn(record, field)) {
    return { present: false }
  }
  return { present: true, value: requireString(record[field], path) }
}

function optionalSha256Digest(
  record: UnknownRecord,
  field: string,
  path: string
): OptionalValue<string> {
  if (!hasOwn(record, field)) {
    return { present: false }
  }
  return { present: true, value: requireSha256Digest(record[field], path) }
}

function optionalNonEmptyString(
  record: UnknownRecord,
  field: string,
  path: string
): OptionalValue<string> {
  if (!hasOwn(record, field)) {
    return { present: false }
  }
  return { present: true, value: requireNonEmptyString(record[field], path) }
}

function validateJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object> = new Set()
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(path, 'expected a finite JSON number')
    }
    return
  }

  if (typeof value !== 'object') {
    fail(path, 'expected a JSON-compatible value')
  }

  if (ancestors.has(value)) {
    fail(path, 'cyclic JSON value')
  }

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)

  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value).filter((key) => key !== 'length')
    for (const key of keys) {
      if (
        typeof key !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= value.length
      ) {
        fail(`${path}.${String(key)}`, 'invalid JSON array field')
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn(value, index)) {
        fail(`${path}[${index}]`, 'sparse arrays are not JSON values')
      }
      validateJsonValue(value[index], `${path}[${index}]`, nextAncestors)
    }
    return
  }

  if (!isPlainRecord(value)) {
    fail(path, 'expected a plain JSON object')
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail(`${path}.${String(key)}`, 'JSON object keys must be strings')
    }
    validateJsonValue(value[key], `${path}.${key}`, nextAncestors)
  }
}

function requireJsonValue(value: unknown, path: string): unknown {
  validateJsonValue(value, path)
  return value
}

function optionalJsonValue(
  record: UnknownRecord,
  field: string,
  path: string
): OptionalValue<unknown> {
  if (!hasOwn(record, field)) {
    return { present: false }
  }
  return { present: true, value: requireJsonValue(record[field], path) }
}

function parseRuntimeError(value: unknown, path: string): RuntimeError {
  const error = requireObject(value, path, [
    'code',
    'message',
    'recoverable',
    'details',
  ])
  const details = optionalJsonValue(error, 'details', `${path}.details`)
  if (details.present && !isPlainRecord(details.value)) {
    fail(`${path}.details`, 'expected a plain object')
  }
  return {
    code: requireOneOf(
      requireField(error, 'code', `${path}.code`),
      runtimeErrorCodes,
      `${path}.code`
    ),
    message: requireString(
      requireField(error, 'message', `${path}.message`),
      `${path}.message`
    ),
    recoverable: requireBoolean(
      requireField(error, 'recoverable', `${path}.recoverable`),
      `${path}.recoverable`
    ),
    ...(details.present
      ? { details: details.value as Record<string, unknown> }
      : {}),
  }
}

function parsePermissionRequest(
  value: unknown,
  path: string
): PermissionRequest {
  const request = requireObject(value, path, [
    'requestId',
    'toolCallId',
    'title',
    'description',
    'toolName',
    'inputSummary',
    'canAllowOnce',
    'canDeny',
    'actions',
    'actionSetDigest',
    'hasUnsupportedDecision',
    'expiresAt',
  ])
  const inputSummary = optionalJsonValue(
    request,
    'inputSummary',
    `${path}.inputSummary`
  )
  const actions = request.actions
    ? (() => {
        if (!Array.isArray(request.actions) || request.actions.length === 0) {
          return fail(`${path}.actions`, 'expected a non-empty array')
        }
        return request.actions.map((item, index) => {
          const action = requireObject(item, `${path}.actions[${index}]`, [
            'kind',
            'name',
            'summary',
          ])
          return {
            kind: requireOneOf(
              requireField(action, 'kind', `${path}.actions[${index}].kind`),
              ['tool', 'filesystem', 'network', 'system'] as const,
              `${path}.actions[${index}].kind`
            ),
            name: requireNonEmptyString(
              requireField(action, 'name', `${path}.actions[${index}].name`),
              `${path}.actions[${index}].name`
            ),
            summary: requireString(
              requireField(action, 'summary', `${path}.actions[${index}].summary`),
              `${path}.actions[${index}].summary`
            ),
          }
        })
      })()
    : undefined
  const actionSetDigest = hasOwn(request, 'actionSetDigest')
    ? requireSha256Digest(
        requireField(request, 'actionSetDigest', `${path}.actionSetDigest`),
        `${path}.actionSetDigest`
      )
    : undefined

  return {
    requestId: requireNonEmptyString(
      requireField(request, 'requestId', `${path}.requestId`),
      `${path}.requestId`
    ),
    toolCallId: requireNonEmptyString(
      requireField(request, 'toolCallId', `${path}.toolCallId`),
      `${path}.toolCallId`
    ),
    title: requireString(
      requireField(request, 'title', `${path}.title`),
      `${path}.title`
    ),
    description: requireString(
      requireField(request, 'description', `${path}.description`),
      `${path}.description`
    ),
    toolName: requireString(
      requireField(request, 'toolName', `${path}.toolName`),
      `${path}.toolName`
    ),
    ...(inputSummary.present ? { inputSummary: inputSummary.value } : {}),
    canAllowOnce: requireBoolean(
      requireField(request, 'canAllowOnce', `${path}.canAllowOnce`),
      `${path}.canAllowOnce`
    ),
    canDeny: requireBoolean(
      requireField(request, 'canDeny', `${path}.canDeny`),
      `${path}.canDeny`
    ),
    ...(actions ? { actions } : {}),
    ...(actionSetDigest ? { actionSetDigest } : {}),
    ...(hasOwn(request, 'hasUnsupportedDecision')
      ? {
          hasUnsupportedDecision: requireBoolean(
            requireField(
              request,
              'hasUnsupportedDecision',
              `${path}.hasUnsupportedDecision`
            ),
            `${path}.hasUnsupportedDecision`
          ),
        }
      : {}),
    expiresAt: requireNonEmptyString(
      requireField(request, 'expiresAt', `${path}.expiresAt`),
      `${path}.expiresAt`
    ),
  }
}

function parseRuntimeEvent(value: unknown, path: string): RuntimeEvent {
  if (!isPlainRecord(value)) {
    return fail(path, 'expected a plain object')
  }

  const type = requireString(
    requireField(value, 'type', `${path}.type`),
    `${path}.type`
  )

  switch (type) {
    case 'runtime_status_changed': {
      const event = requireObject(value, path, ['type', 'status', 'message'])
      const message = optionalString(event, 'message', `${path}.message`)
      return {
        type,
        status: requireOneOf(
          requireField(event, 'status', `${path}.status`),
          runtimeStatuses,
          `${path}.status`
        ),
        ...(message.present ? { message: message.value } : {}),
      }
    }
    case 'connection_status_changed': {
      const event = requireObject(value, path, ['type', 'status', 'message'])
      const message = optionalString(event, 'message', `${path}.message`)
      return {
        type,
        status: requireOneOf(
          requireField(event, 'status', `${path}.status`),
          runtimeConnectionStatuses,
          `${path}.status`
        ),
        ...(message.present ? { message: message.value } : {}),
      }
    }
    case 'run_started': {
      const event = requireObject(value, path, ['type', 'userMessageId'])
      return {
        type,
        userMessageId: requireNonEmptyString(
          requireField(event, 'userMessageId', `${path}.userMessageId`),
          `${path}.userMessageId`
        ),
      }
    }
    case 'text_delta':
    case 'reasoning_delta': {
      const event = requireObject(value, path, ['type', 'messageId', 'delta'])
      return {
        type,
        messageId: requireNonEmptyString(
          requireField(event, 'messageId', `${path}.messageId`),
          `${path}.messageId`
        ),
        delta: requireString(
          requireField(event, 'delta', `${path}.delta`),
          `${path}.delta`
        ),
      }
    }
    case 'tool_started': {
      const event = requireObject(value, path, [
        'type',
        'toolCallId',
        'name',
        'input',
      ])
      const input = optionalJsonValue(event, 'input', `${path}.input`)
      return {
        type,
        toolCallId: requireNonEmptyString(
          requireField(event, 'toolCallId', `${path}.toolCallId`),
          `${path}.toolCallId`
        ),
        name: requireString(
          requireField(event, 'name', `${path}.name`),
          `${path}.name`
        ),
        ...(input.present ? { input: input.value } : {}),
      }
    }
    case 'tool_updated': {
      const event = requireObject(value, path, ['type', 'toolCallId', 'update'])
      return {
        type,
        toolCallId: requireNonEmptyString(
          requireField(event, 'toolCallId', `${path}.toolCallId`),
          `${path}.toolCallId`
        ),
        update: requireJsonValue(
          requireField(event, 'update', `${path}.update`),
          `${path}.update`
        ),
      }
    }
    case 'tool_completed': {
      const event = requireObject(value, path, [
        'type',
        'toolCallId',
        'result',
        'error',
      ])
      const result = optionalJsonValue(event, 'result', `${path}.result`)
      const error = optionalString(event, 'error', `${path}.error`)
      return {
        type,
        toolCallId: requireNonEmptyString(
          requireField(event, 'toolCallId', `${path}.toolCallId`),
          `${path}.toolCallId`
        ),
        ...(result.present ? { result: result.value } : {}),
        ...(error.present ? { error: error.value } : {}),
      }
    }
    case 'permission_requested': {
      const event = requireObject(value, path, ['type', 'request'])
      return {
        type,
        request: parsePermissionRequest(
          requireField(event, 'request', `${path}.request`),
          `${path}.request`
        ),
      }
    }
    case 'permission_resolved': {
      const event = requireObject(value, path, [
        'type',
        'requestId',
        'decision',
      ])
      return {
        type,
        requestId: requireNonEmptyString(
          requireField(event, 'requestId', `${path}.requestId`),
          `${path}.requestId`
        ),
        decision: requireOneOf(
          requireField(event, 'decision', `${path}.decision`),
          permissionDecisions,
          `${path}.decision`
        ),
      }
    }
    case 'permission_audit': {
      const event = requireObject(value, path, [
        'type',
        'requestId',
        'decision',
        'status',
        'reason',
        'actionSetDigest',
      ])
      const reason = hasOwn(event, 'reason')
        ? {
            present: true as const,
            value: requireOneOf(
              requireField(event, 'reason', `${path}.reason`),
              permissionDenyReasons,
              `${path}.reason`
            ),
          }
        : { present: false as const }
      const digest = optionalSha256Digest(
        event,
        'actionSetDigest',
        `${path}.actionSetDigest`
      )
      return {
        type,
        requestId: requireNonEmptyString(
          requireField(event, 'requestId', `${path}.requestId`),
          `${path}.requestId`
        ),
        decision: requireOneOf(
          requireField(event, 'decision', `${path}.decision`),
          permissionDecisions,
          `${path}.decision`
        ),
        status: requireOneOf(
          requireField(event, 'status', `${path}.status`),
          permissionResolveStatuses,
          `${path}.status`
        ),
        ...(reason.present ? { reason: reason.value } : {}),
        ...(digest.present ? { actionSetDigest: digest.value } : {}),
      }
    }
    case 'diagnostic_notice': {
      const event = requireObject(value, path, ['type', 'level', 'message'])
      return {
        type,
        level: requireOneOf(
          requireField(event, 'level', `${path}.level`),
          diagnosticLevels,
          `${path}.level`
        ),
        message: requireString(
          requireField(event, 'message', `${path}.message`),
          `${path}.message`
        ),
      }
    }
    case 'run_completed': {
      const event = requireObject(value, path, ['type', 'stopReason'])
      const stopReason = optionalString(
        event,
        'stopReason',
        `${path}.stopReason`
      )
      return {
        type,
        ...(stopReason.present ? { stopReason: stopReason.value } : {}),
      }
    }
    case 'run_cancelled': {
      const event = requireObject(value, path, ['type', 'reason'])
      const reason = optionalString(event, 'reason', `${path}.reason`)
      return {
        type,
        ...(reason.present ? { reason: reason.value } : {}),
      }
    }
    case 'run_failed': {
      const event = requireObject(value, path, ['type', 'error'])
      return {
        type,
        error: parseRuntimeError(
          requireField(event, 'error', `${path}.error`),
          `${path}.error`
        ),
      }
    }
    default:
      return fail(`${path}.type`, 'unknown runtime event type')
  }
}

export function parseRuntimeEventEnvelope(
  value: unknown
): RuntimeEventEnvelope {
  const path = 'envelope'
  const envelope = requireObject(value, path, [
    'schemaVersion',
    'eventId',
    'runtimeId',
    'runtimeEpoch',
    'sessionId',
    'runId',
    'sequence',
    'timestamp',
    'event',
  ])

  const schemaVersion = requireField(
    envelope,
    'schemaVersion',
    `${path}.schemaVersion`
  )
  const parsedSchemaVersion = requireOneOf(
    schemaVersion,
    RUNTIME_SCHEMA_VERSIONS,
    `${path}.schemaVersion`
  )
  const runtimeId = requireField(envelope, 'runtimeId', `${path}.runtimeId`)
  const parsedRuntimeId = requireOneOf(
    runtimeId,
    RUNTIME_IDS,
    `${path}.runtimeId`
  )

  const eventId = requireNonEmptyString(
    requireField(envelope, 'eventId', `${path}.eventId`),
    `${path}.eventId`
  )
  const runtimeEpoch = requireNonEmptyString(
    requireField(envelope, 'runtimeEpoch', `${path}.runtimeEpoch`),
    `${path}.runtimeEpoch`
  )
  const sessionId = requireNonEmptyString(
    requireField(envelope, 'sessionId', `${path}.sessionId`),
    `${path}.sessionId`
  )
  const runId = optionalNonEmptyString(envelope, 'runId', `${path}.runId`)
  const sequence = requireSequence(
    requireField(envelope, 'sequence', `${path}.sequence`),
    `${path}.sequence`
  )
  const timestamp = requireNonEmptyString(
    requireField(envelope, 'timestamp', `${path}.timestamp`),
    `${path}.timestamp`
  )
  const event = parseRuntimeEvent(
    requireField(envelope, 'event', `${path}.event`),
    `${path}.event`
  )

  if (sessionId === RUNTIME_SESSION_ID) {
    if (runId.present) {
      fail(`${path}.runId`, 'must be omitted for runtime events')
    }
    if (event.type !== 'runtime_status_changed') {
      fail(
        `${path}.event.type`,
        'runtime sessions only accept runtime_status_changed'
      )
    }
  } else {
    if (!runId.present) {
      fail(`${path}.runId`, 'required for run events')
    }
    if (event.type === 'runtime_status_changed') {
      fail(`${path}.event.type`, 'runtime_status_changed requires __runtime__')
    }
  }

  return {
    schemaVersion: parsedSchemaVersion,
    eventId,
    runtimeId: parsedRuntimeId,
    runtimeEpoch,
    sessionId,
    ...(runId.present ? { runId: runId.value } : {}),
    sequence,
    timestamp,
    event,
  }
}

export function parseRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  const path = 'snapshot'
  const snapshot = requireObject(value, path, [
    'runtimeId',
    'status',
    'runtimeEpoch',
    'sequence',
    'message',
  ])
  const runtimeId = requireField(snapshot, 'runtimeId', `${path}.runtimeId`)
  const parsedRuntimeId = requireOneOf(
    runtimeId,
    RUNTIME_IDS,
    `${path}.runtimeId`
  )

  const runtimeEpoch = optionalNonEmptyString(
    snapshot,
    'runtimeEpoch',
    `${path}.runtimeEpoch`
  )
  const message = optionalString(snapshot, 'message', `${path}.message`)

  return {
    runtimeId: parsedRuntimeId,
    status: requireOneOf(
      requireField(snapshot, 'status', `${path}.status`),
      runtimeStatuses,
      `${path}.status`
    ),
    ...(runtimeEpoch.present ? { runtimeEpoch: runtimeEpoch.value } : {}),
    sequence: requireSequence(
      requireField(snapshot, 'sequence', `${path}.sequence`),
      `${path}.sequence`
    ),
    ...(message.present ? { message: message.value } : {}),
  }
}

export function parseSessionCreateResult(value: unknown): SessionCreateResult {
  const path = 'sessionCreateResult'
  const result = requireObject(value, path, [
    'sessionId',
    'runtimeSessionId',
    'runtimeEpoch',
    'reused',
  ])
  return {
    sessionId: requireNonEmptyString(
      requireField(result, 'sessionId', `${path}.sessionId`),
      `${path}.sessionId`
    ),
    runtimeSessionId: requireNonEmptyString(
      requireField(result, 'runtimeSessionId', `${path}.runtimeSessionId`),
      `${path}.runtimeSessionId`
    ),
    runtimeEpoch: requireNonEmptyString(
      requireField(result, 'runtimeEpoch', `${path}.runtimeEpoch`),
      `${path}.runtimeEpoch`
    ),
    reused: requireBoolean(
      requireField(result, 'reused', `${path}.reused`),
      `${path}.reused`
    ),
  }
}

export function parseRunStartResult(value: unknown): RunStartResult {
  const path = 'runStartResult'
  const result = requireObject(value, path, ['runId'])
  return {
    runId: requireNonEmptyString(
      requireField(result, 'runId', `${path}.runId`),
      `${path}.runId`
    ),
  }
}

export function parseCommandAck(value: unknown): CommandAck {
  const path = 'commandAck'
  const ack = requireObject(value, path, ['accepted', 'duplicate'])
  return {
    accepted: requireBoolean(
      requireField(ack, 'accepted', `${path}.accepted`),
      `${path}.accepted`
    ),
    duplicate: requireBoolean(
      requireField(ack, 'duplicate', `${path}.duplicate`),
      `${path}.duplicate`
    ),
  }
}

export function parsePermissionDecisionReceipt(
  value: unknown
): PermissionDecisionReceipt {
  const path = 'permissionDecisionReceipt'
  const receipt = requireObject(value, path, [
    'version',
    'runtimeInstanceId',
    'runtimeId',
    'runtimeEpoch',
    'sessionId',
    'threadId',
    'runId',
    'requestId',
    'toolCallId',
    'decision',
    'status',
    'reason',
    'actionSetDigest',
  ])
  const version = requireField(receipt, 'version', `${path}.version`)
  if (version !== 1) fail(`${path}.version`, 'expected 1')
  const runtimeId = requireField(receipt, 'runtimeId', `${path}.runtimeId`)
  const parsedRuntimeId = requireOneOf(
    runtimeId,
    RUNTIME_IDS,
    `${path}.runtimeId`
  )
  const reason = hasOwn(receipt, 'reason')
    ? {
        present: true as const,
        value: requireOneOf(
          requireField(receipt, 'reason', `${path}.reason`),
          permissionDenyReasons,
          `${path}.reason`
        ),
      }
    : { present: false as const }
  const actionSetDigest = optionalSha256Digest(
    receipt,
    'actionSetDigest',
    `${path}.actionSetDigest`
  )
  return {
    version: 1,
    runtimeInstanceId: requireNonEmptyString(requireField(receipt, 'runtimeInstanceId', `${path}.runtimeInstanceId`), `${path}.runtimeInstanceId`),
    runtimeId: parsedRuntimeId,
    runtimeEpoch: requireNonEmptyString(requireField(receipt, 'runtimeEpoch', `${path}.runtimeEpoch`), `${path}.runtimeEpoch`),
    sessionId: requireNonEmptyString(requireField(receipt, 'sessionId', `${path}.sessionId`), `${path}.sessionId`),
    threadId: requireNonEmptyString(requireField(receipt, 'threadId', `${path}.threadId`), `${path}.threadId`),
    runId: requireNonEmptyString(requireField(receipt, 'runId', `${path}.runId`), `${path}.runId`),
    requestId: requireNonEmptyString(requireField(receipt, 'requestId', `${path}.requestId`), `${path}.requestId`),
    toolCallId: requireNonEmptyString(requireField(receipt, 'toolCallId', `${path}.toolCallId`), `${path}.toolCallId`),
    decision: requireOneOf(requireField(receipt, 'decision', `${path}.decision`), permissionDecisions, `${path}.decision`),
    status: requireOneOf(requireField(receipt, 'status', `${path}.status`), permissionResolveStatuses, `${path}.status`),
    ...(reason.present ? { reason: reason.value } : {}),
    ...(actionSetDigest.present ? { actionSetDigest: actionSetDigest.value } : {}),
  }
}

export function formatRuntimeCommandError(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    const error = parseRuntimeError(value, 'runtimeError')
    return `${error.code}: ${error.message}`
  } catch {
    return i18n.t('common:runtimeCommandFailed')
  }
}

/** 面向用户的展示：错误码是诊断信息，不该出现在给用户看的提示正文里。 */
export function describeRuntimeCommandError(value: unknown): string {
  return formatRuntimeCommandError(value).replace(/^[a-z][a-z0-9_]*:\s*/, '')
}

export function isTerminalRuntimeEvent(event: RuntimeEvent): boolean {
  return (
    event.type === 'run_completed' ||
    event.type === 'run_cancelled' ||
    event.type === 'run_failed'
  )
}
