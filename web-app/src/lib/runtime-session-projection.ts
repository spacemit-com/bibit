import type { RuntimeTurnV2 } from './messages'
import type { PermissionExpiredReason, RuntimeDiagnosticData, RuntimeToolData, RuntimePermissionData } from './runtime-contract'
import type { UIMessage } from 'ai'
import { safeDetails } from './runtime-safe-details'
import i18n from '@/i18n/setup'

export type SessionFeedIdentity = Pick<RuntimePermissionData, 'targetId' | 'runtimeId' | 'runtimeEpoch' | 'sessionId'>

export type SessionEvent = {
  seq: number
  type: string
  time: number
  run_id?: string | null
  data: Record<string, unknown>
}

export type SessionInput = {
  messageId: string
  content: string
  skillIds: string[]
  status: 'staged' | 'claimed' | 'executing'
  runId?: string
}

export type SessionApproval = {
  id: string
  runId: string
  status: 'pending' | 'resolved' | 'expired'
  decision?: string
  requestedAt?: number
  /** 失效原因代码（见 PermissionExpiredReason），文案由界面层翻译。 */
  expiredReason?: PermissionExpiredReason
  data: Record<string, unknown>
}

export type SessionMessage = {
  id: string
  parentId?: string | null
  seq: number
  createdAt: number
  runId?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  turn?: RuntimeTurnV2
  activeReasoningIndex?: number
  artifacts: Record<string, unknown>[]
  attachments: unknown[]
  usage?: Record<string, unknown>
  compression?: Record<string, unknown>
  progress?: Record<string, unknown>
  error?: unknown
}

export type SessionProjection = {
  messages: SessionMessage[]
  allMessages: SessionMessage[]
  inputs: Record<string, SessionInput>
  approvals: Record<string, SessionApproval>
  trajectory: SessionEvent[]
  hooks: { id: string; runId: string; invoked?: SessionEvent; result?: SessionEvent }[]
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []

const sameDetails = (left?: Record<string, unknown>, right?: Record<string, unknown>): boolean => {
  const keys = Object.keys(left ?? {})
  if (keys.length !== Object.keys(right ?? {}).length) return false
  return keys.every(key => JSON.stringify(left?.[key]) === JSON.stringify(right?.[key]))
}

/** 两条诊断说的是不是同一件事。details 也参与比较，避免把「同码同话、原因不同」合并掉。 */
const sameDiagnostic = (left: RuntimeDiagnosticData, right: RuntimeDiagnosticData): boolean =>
  left.code === right.code && left.message === right.message && sameDetails(left.details, right.details)

export type RuntimeTokenUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number }

/** Missing measurements remain absent; only derive total when both counters exist. */
export function normalizeRuntimeUsage(value: unknown): RuntimeTokenUsage | undefined {
  const usage = record(value)
  const count = (...values: unknown[]) => values.find(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) as number | undefined
  const inputTokens = count(usage.inputTokens, usage.input_tokens, usage.prompt_tokens)
  const outputTokens = count(usage.outputTokens, usage.output_tokens, usage.completion_tokens)
  const totalTokens = count(usage.totalTokens, usage.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}) }
}

/** Aggregate measured assistant usage once per message; absent fields are never counted as zero. */
export function aggregateSessionUsage(messages: readonly SessionMessage[]): RuntimeTokenUsage | undefined {
  const usages = [...new Map(messages.filter(message => message.role === 'assistant').map(message => [message.id, normalizeRuntimeUsage(message.usage)])).values()].filter((usage): usage is RuntimeTokenUsage => Boolean(usage))
  return sumMeasuredUsage(usages)
}

/** Terminal events retain accounting even when continue rewrites the visible answer. */
export function aggregateSessionEventUsage(events: readonly SessionEvent[]): RuntimeTokenUsage | undefined {
  const terminals = new Map<string, SessionEvent>()
  for (const event of events) {
    if (!event.run_id || !['run/completed', 'run/failed', 'run/cancelled'].includes(event.type)) continue
    const previous = terminals.get(event.run_id)
    if (!previous || event.seq >= previous.seq) terminals.set(event.run_id, event)
  }
  return sumMeasuredUsage([...terminals.values()].map(event => normalizeRuntimeUsage(event.data.usage)).filter((usage): usage is RuntimeTokenUsage => Boolean(usage)))
}

function sumMeasuredUsage(usages: RuntimeTokenUsage[]): RuntimeTokenUsage | undefined {
  if (!usages.length) return undefined
  const total: RuntimeTokenUsage = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    // A partially measured total must not claim to represent the whole session.
    if (usages.every(usage => usage[key] !== undefined)) total[key] = usages.reduce((sum, usage) => sum + usage[key]!, 0)
  }
  return Object.keys(total).length ? total : undefined
}

/** 显式身份使历史渲染和控制器注册使用同一份脱敏审批数据。 */
export function sessionApprovalToPermission(approval: SessionApproval, identity?: SessionFeedIdentity): RuntimePermissionData {
  const data = approval.data
  const actions = array(data.actions).filter(value => value && typeof value === 'object' && !Array.isArray(value)).map(record)
  const permits = (decision: string) => Boolean(identity?.targetId && identity.sessionId && identity.runtimeEpoch)
    && approval.status === 'pending' && actions.length > 0
    && actions.every(action => array(action.allowed_decisions).includes(decision))
  const time = approval.requestedAt ?? 0
  return {
    runtimeId: 'bianbu', runtimeEpoch: '', sessionId: '', ...identity,
    runId: approval.runId, requestId: approval.id,
    toolCallId: String(data.call_id ?? data.tool_call_id ?? approval.id),
    createdAt: new Date(time * (time < 1e12 ? 1000 : 1)).toISOString(),
    expiresAt: String(data.expires_at ?? ''), title: String(data.title ?? ''),
    // token_budget 一类的审批没有顶层 title/description，人话只在 message（如
    // "Token quota reached: used=2876063; limit=100000"）或 action.description 上；
    // 漏读会让卡片只剩原始参数 JSON，用户不知道在批什么而超时，随后整个 Run 失败。
    description: String(data.description ?? data.reason ?? data.message
      ?? actions.map(action => action.description).find(value => typeof value === 'string' && value) ?? ''),
    toolName: String(data.tool_name ?? data.tool ?? actions.map(action => action.name).join(', ')),
    inputSummary: JSON.parse(safeDetails(actions.length ? actions : data.arguments ?? data.input ?? {})),
    actions: actions.map(action => ({
      kind: ['tool', 'filesystem', 'network', 'system'].includes(String(action.kind)) ? action.kind as 'tool' | 'filesystem' | 'network' | 'system' : 'tool',
      name: String(action.name ?? ''), summary: safeDetails(action.arguments ?? action),
    })),
    canAllowOnce: permits('approve'), canDeny: permits('reject'),
    status: approval.status === 'pending' ? 'pending' : 'resolved',
    decision: approval.decision === 'approve' ? 'allow_once' : approval.decision === 'reject' ? 'deny' : undefined,
    ...(approval.status === 'expired' ? { expiredReason: approval.expiredReason ?? 'ended' } : {}),
  }
}

export class SessionHistoryDependencyError extends Error {}

/** 上一次投影及其输入：纯尾部 delta 批次据此增量更新，其余情况一律全量重投影。 */
export type SessionProjectionBaseline = {
  events: readonly SessionEvent[]
  hiddenRunIds: readonly string[]
  identity?: SessionFeedIdentity
  projection: SessionProjection
}

const DELTA_TYPES = new Set(['assistant/text.delta', 'assistant/reasoning.delta'])
type DeltaKind = 'answer' | 'reasoning'
const deltaKind = (type: string): DeltaKind => type === 'assistant/text.delta' ? 'answer' : 'reasoning'

function sameIdentity(left: SessionFeedIdentity | undefined, right: SessionFeedIdentity | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  return left.targetId === right.targetId && left.runtimeId === right.runtimeId
    && left.runtimeEpoch === right.runtimeEpoch && left.sessionId === right.sessionId
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function groupStart(event: SessionEvent) {
  const span = event.data.seq_range
  return Array.isArray(span) && span.length === 2 && Number.isSafeInteger(span[0]) ? Number(span[0]) : event.seq
}

function groupEnd(event: SessionEvent) {
  const span = event.data.seq_range
  return Array.isArray(span) && span.length === 2 && Number.isSafeInteger(span[1]) ? Number(span[1]) : event.seq
}

/** 同一个折叠组的延伸：seq/类型/run 不变，正文只追加，覆盖区间不回退。 */
function extendsGroup(previous: SessionEvent, next: SessionEvent) {
  return next !== previous && next.seq === previous.seq && next.type === previous.type
    && next.time === previous.time && next.data && !Array.isArray(next.data)
    && (next.run_id ?? null) === (previous.run_id ?? null)
    && typeof next.data.text === 'string' && next.data.text.startsWith(text(previous.data.text))
    && groupStart(next) === groupStart(previous) && groupEnd(next) >= groupEnd(previous)
}

/**
 * 只有「同一 Run 的尾部折叠文字/思考组继续追加」才走增量：
 * 事件前缀必须引用相等，新增部分只能是该 Run 的 delta。其余（新片段、新 Run、工具、
 * 审批、message.end、终态、压缩/恢复、分页、乱序、历史修改、hidden 变化）都返回 undefined
 * 交给全量投影，避免用不完整指纹猜「没变」。
 *
 * 增量结果与全量 `projectSessionEvents` 严格等价：未受影响的消息保留引用，
 * 因此下游的 UIMessage 缓存与 `MessageItem` memo 才真正生效。
 */
function incrementalTail(
  events: readonly SessionEvent[],
  hiddenRunIds: readonly string[],
  identity: SessionFeedIdentity | undefined,
  baseline: SessionProjectionBaseline | undefined,
): SessionProjection | undefined {
  if (!baseline) return undefined
  const previous = baseline.events
  const tail = previous.at(-1)
  // 空正文的折叠组先交给全量：那一刻是否新建 item 取决于 closedPart 状态，无法只从结果反推。
  if (!tail || !DELTA_TYPES.has(tail.type) || !text(tail.data.text)) return undefined
  if (!sameIdentity(identity, baseline.identity) || !sameIds(hiddenRunIds, baseline.hiddenRunIds)) return undefined
  const runId = tail.run_id ?? null
  if (runId === null || hiddenRunIds.includes(runId)) return undefined
  if (events.length < previous.length) return undefined
  for (let index = 0; index < previous.length - 1; index++) {
    if (events[index] !== previous[index]) return undefined
    if (previous[index].seq >= previous[index + 1].seq) return undefined
  }
  const head = events[previous.length - 1]
  let replaced: SessionEvent | undefined
  if (events.length === previous.length) {
    if (head === tail) return baseline.projection
    if (!extendsGroup(tail, head)) return undefined
    replaced = head
  } else if (head !== tail) return undefined
  for (let index = previous.length; index < events.length; index++) {
    const event = events[index]
    if (!Number.isSafeInteger(event.seq) || event.seq <= events[index - 1].seq
      || !event.data || Array.isArray(event.data)) return undefined
    if (!DELTA_TYPES.has(event.type) || (event.run_id ?? null) !== runId) return undefined
  }
  return applyTailDelta(baseline, runId, replaced, events.slice(previous.length))
}

function applyTailDelta(
  baseline: SessionProjectionBaseline,
  runId: string,
  replaced: SessionEvent | undefined,
  appended: readonly SessionEvent[],
): SessionProjection | undefined {
  const projection = baseline.projection
  const tailEvent = baseline.events.at(-1)!
  const message = projection.messages.at(-1)
  const sourceItems = message?.turn?.items
  if (!message || message.role !== 'assistant' || message.status !== 'running' || !message.runId
    || message.runId !== runId || !sourceItems || projection.trajectory.at(-1) !== tailEvent) return undefined
  const trajectory = appended.length
    ? [...projection.trajectory, ...appended]
    : replaced ? [...projection.trajectory.slice(0, -1), replaced] : projection.trajectory
  const items = [...sourceItems]
  let content = message.content
  let activeReasoningIndex = message.activeReasoningIndex
  const push = (item: (typeof items)[number]) => { items.push(item) }

  if (replaced) {
    const suffix = text(replaced.data.text).slice(text(tailEvent.data.text).length)
    // 正文没有新增（只有 seq_range 变化）时消息本身不变，只更新 trajectory。
    if (!suffix) return { ...projection, trajectory }
    const kind = deltaKind(replaced.type)
    const last = items.at(-1)
    if (last?.kind !== kind) return undefined
    items[items.length - 1] = { ...last, markdown: last.markdown + suffix }
    if (kind === 'answer') { content += suffix; activeReasoningIndex = undefined }
    else activeReasoningIndex = items.length - 1
  }

  for (const event of appended) {
    const kind = deltaKind(event.type)
    const delta = text(event.data.text)
    if (!delta) {
      if (kind === 'answer') activeReasoningIndex = undefined
      continue
    }
    const last = items.at(-1)
    if (kind === 'answer') {
      activeReasoningIndex = undefined
      if (last?.kind === 'answer') items[items.length - 1] = { ...last, markdown: last.markdown + delta }
      else push({ kind: 'answer', lane: 'answer', markdown: delta })
      content += delta
      continue
    }
    if (last?.kind === 'reasoning') {
      items[items.length - 1] = { ...last, markdown: last.markdown + delta,
        card: last.card ? { ...last.card, sourceSeqs: [...last.card.sourceSeqs, event.seq] } : last.card }
    } else {
      push({ kind: 'reasoning', lane: 'work', markdown: delta,
        card: { kind: 'reasoning', runId, id: String(event.seq), sourceSeqs: [event.seq] } })
    }
    activeReasoningIndex = items.length - 1
  }

  if (items.length === sourceItems.length && items.every((item, index) => item === sourceItems[index])
    && content === message.content && activeReasoningIndex === message.activeReasoningIndex) {
    return { ...projection, trajectory }
  }
  const next: SessionMessage = { ...message, content, activeReasoningIndex,
    turn: { ...message.turn!, items } }
  return { ...projection, trajectory,
    messages: [...projection.messages.slice(0, -1), next],
    allMessages: projection.allMessages.map(item => item === message ? next : item) }
}

/**
 * 全量重投影会把每条消息都建成新对象，于是下游按引用做缓存的东西
 * （`useSessionConversation` 的 UIMessage WeakMap、`MessageItem` 的 memo）全部落空，
 * 一整屏历史行跟着重渲染。而回合边界上每个非 delta 事件（`request/context`、
 * `run/event`、`run/completed`…）都要走全量，代价随会话长度一起涨。
 *
 * 所以全量算完之后按整条消息的序列化指纹比对一次：指纹相同就沿用上一版对象，
 * 只有真正变了的行换新对象。指纹取整条消息（含 turn.items 与审批数据），
 * 宁可保守——只要有一处不同就不复用——这样不会把旧内容粘在界面上。
 */
function reuseUnchangedMessages(result: SessionProjection, previous?: SessionProjection) {
  if (!previous) return
  const before = new Map(previous.allMessages.map(message => [message.id, message]))
  if (!before.size) return
  const fingerprints = new Map<string, string>()
  const pick = (message: SessionMessage) => {
    const baseline = before.get(message.id)
    if (!baseline || baseline === message) return message
    let fingerprint = fingerprints.get(message.id)
    if (fingerprint === undefined) {
      fingerprint = JSON.stringify(baseline)
      fingerprints.set(message.id, fingerprint)
    }
    return fingerprint === JSON.stringify(message) ? baseline : message
  }
  result.messages = result.messages.map(pick)
  result.allMessages = result.allMessages.map(pick)
}

/** 历史页与实时批次均投影同一原始事件窗；不把服务端 tail 当作已消费游标。 */
export function projectSessionEvents(
  events: readonly SessionEvent[],
  hiddenRunIds: readonly string[] = [],
  identity?: SessionFeedIdentity,
  baseline?: SessionProjectionBaseline,
): SessionProjection {
  const incremental = incrementalTail(events, hiddenRunIds, identity, baseline)
  if (incremental) return incremental
  const bySeq = new Map<number, SessionEvent>()
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !event.type || !event.data || Array.isArray(event.data)) {
      // 不变量违规，但错误会经 session.error 显示给用户，仍需按界面语言给出。
      throw new Error(i18n.t('chat:eventFormatInvalid'))
    }
    bySeq.set(event.seq, event)
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  const operationIds = new Set(ordered.filter(event => event.type === 'conversation/changed').map(event => text(event.data.operation_id)))
  const hidden = new Set(hiddenRunIds)
  for (const event of ordered) {
    if (event.type === 'user/message' && event.data.console_operation && event.run_id) hidden.add(event.run_id)
  }
  const result: SessionProjection = { messages: [], allMessages: [], inputs: Object.create(null), approvals: Object.create(null), trajectory: [], hooks: [] }
  const messages = new Map<string, SessionMessage>()
  const selected = new Map<string | null, string | null>()
  const path = () => {
    const seen = new Set<string>()
    const active: SessionMessage[] = []
    let id = selected.get(null)
    while (id) {
      const message = messages.get(id)
      if (!message || seen.has(id)) throw new Error(i18n.t('chat:historyBranchInvalid'))
      seen.add(id)
      active.push(message)
      id = selected.get(id)
    }
    return active
  }
  const select = (id: string) => {
    let message = messages.get(id)
    while (message) {
      selected.set(message.parentId ?? null, message.id)
      message = message.parentId ? messages.get(message.parentId) : undefined
    }
  }
  const append = (message: SessionMessage) => {
    message.parentId = result.messages.at(-1)?.id ?? null
    messages.set(message.id, message)
    selected.set(message.parentId, message.id)
    result.messages.push(message)
  }
  const hooks = new Map<string, SessionProjection['hooks'][number]>()
  const users = new Map<string, SessionMessage>()
  const assistants = new Map<string, SessionMessage>()
  const approvalOnlyMessages = new WeakSet<SessionMessage>()
  const tools = new Map<string, RuntimeToolData>()
  const closedPart = new Set<string>()
  const terminalRuns = new Set<string>()
  const continuationTargets = new Map<string, string>()
  const continuationRuns = new Map<string, string>()
  const continuationPrefixes = new Map<string, string>()
  const compressedSegments = new Map<string, SessionMessage[]>()

  const assistant = (event: SessionEvent, runId: string): SessionMessage => {
    let message = assistants.get(runId)
    if (!message) {
      message = { id: `${runId}:${event.seq}`, seq: event.seq, createdAt: event.time, runId,
        role: 'assistant', content: '', status: 'running', artifacts: [], attachments: [],
        turn: { schemaVersion: 2, runtimeId: 'bianbu', items: [] } }
      const previousId = continuationRuns.get(runId)
      const previous = previousId ? messages.get(previousId) : undefined
      if (previous) {
        message = { ...structuredClone(previous), ...message, parentId: previous.parentId,
          content: previous.content, turn: structuredClone(previous.turn) ?? message.turn,
          artifacts: structuredClone(previous.artifacts), attachments: structuredClone(previous.attachments),
          usage: undefined, error: undefined, activeReasoningIndex: undefined }
        continuationPrefixes.set(runId, previous.content)
        continuationRuns.delete(runId)
        messages.delete(previous.id)
        messages.set(message.id, message)
        selected.set(previous.parentId ?? null, message.id)
        selected.set(message.id, selected.get(previous.id) ?? null)
        selected.delete(previous.id)
        for (const child of messages.values()) {
          if (child.parentId === previous.id) child.parentId = message.id
        }
        result.messages = path()
        closedPart.add(runId)
      } else append(message)
      assistants.set(runId, message)
      if (event.type === 'approval/requested') approvalOnlyMessages.add(message)
    } else if (approvalOnlyMessages.has(message) && event.type !== 'approval/requested') {
      // Runtime 历史消息以首个正文/思考/工具/终态事件编号；审批可先显示，不能改变操作身份。
      const previousId = message.id
      messages.delete(previousId)
      message.id = `${runId}:${event.seq}`
      messages.set(message.id, message)
      if (selected.has(previousId)) {
        selected.set(message.id, selected.get(previousId) ?? null)
        selected.delete(previousId)
      }
      for (const [parent, child] of selected) {
        if (child === previousId) selected.set(parent, message.id)
      }
      for (const child of messages.values()) {
        if (child.parentId === previousId) child.parentId = message.id
      }
      approvalOnlyMessages.delete(message)
    }
    return message
  }

  for (const event of ordered) {
    const data = event.data
    const runId = event.run_id || undefined
    if (runId && hidden.has(runId)) continue
    result.trajectory.push(event)
    if (event.type === 'conversation/changed') {
      const id = text(data.message_id)
      const target = messages.get(id)
      if (!target) throw new SessionHistoryDependencyError(i18n.t('chat:historyMissingTargetMessage'))
      if (target.role === 'system') throw new Error(i18n.t('chat:historyTargetInvalid'))
      if (data.action === 'edit') {
        const message: SessionMessage = { id: `history:${text(data.operation_id)}`, parentId: target.parentId,
          seq: event.seq, createdAt: event.time, role: target.role, content: text(data.content),
          status: 'completed', attachments: [], artifacts: [] }
        messages.set(message.id, message)
        if (message.role === 'user') users.set(message.id, message)
        select(message.id)
      } else if (data.action === 'delete') {
        const child = selected.get(id)
        selected.delete(id)
        for (const message of messages.values()) {
          if (message.parentId === id) message.parentId = target.parentId
        }
        messages.delete(id)
        users.delete(id)
        if (selected.get(target.parentId ?? null) === id) {
          const siblings = [...messages.values()].filter(message => message.parentId === target.parentId)
          selected.set(target.parentId ?? null, child ?? siblings.at(-1)?.id ?? null)
        }
      } else if (data.action === 'switch_version') {
        select(id)
      } else if (data.action === 'regenerate' || data.action === 'continue') {
        if (data.action === 'continue') continuationTargets.set(text(data.operation_id), id)
        let parent = data.action === 'continue' ? target : messages.get(target.parentId ?? '')
        while (parent && data.action === 'regenerate' && parent.role !== 'user') parent = messages.get(parent.parentId ?? '')
        if (!parent) throw new SessionHistoryDependencyError(i18n.t('chat:historyMissingParentQuestion'))
        select(parent.id)
        selected.set(parent.id, null)
      } else throw new Error(i18n.t('chat:historyActionInvalid'))
      result.messages = path()
      continue
    }
    if (runId && (event.type === 'hook/invoked' || event.type === 'hook/result')) {
      const id = text(data.invocation_id) || `seq:${event.seq}`
      const key = JSON.stringify([runId, id])
      const hook = hooks.get(key) ?? { id, runId }
      if (event.type === 'hook/invoked') hook.invoked = event
      else hook.result = event
      hooks.set(key, hook)
    }
    if (event.type === 'agent/inbox/spliced' || event.type === 'user/message') {
      const input = event.type === 'user/message' ? data : record(data.message)
      const historyOperationId = text(record(record(input.request).metadata).history_operation_id)
      if (historyOperationId && !operationIds.has(historyOperationId)) throw new SessionHistoryDependencyError(i18n.t('chat:historyMissingOperation'))
      const id = text(input.message_id) || (runId ? `${runId}:initial` : '')
      if (!id) continue
      const previous = result.inputs[id]
      result.inputs[id] = {
        messageId: id, content: text(input.content),
        skillIds: input.skill_ids ? array(input.skill_ids).map(text).filter(Boolean) : previous?.skillIds ?? [],
        status: event.type === 'user/message' ? 'executing' : previous?.status ?? 'staged',
        ...(runId ? { runId } : previous?.runId ? { runId: previous.runId } : {}),
      }
      let message = users.get(id)
      if (!message) {
        message = { id, seq: event.seq, createdAt: event.time, role: 'user', content: text(input.content),
          status: 'pending', attachments: array(input.attachments), artifacts: [] }
        users.set(id, message)
        append(message)
      }
      if (event.type === 'user/message') {
        message.runId = runId
        message.status = 'completed'
        message.content = text(input.content)
        if (runId) {
          const current = assistants.get(runId)
          if (current) current.status = 'completed'
          assistants.delete(runId)
          compressedSegments.delete(runId)
          closedPart.delete(runId)
          continuationPrefixes.delete(runId)
          continuationRuns.delete(runId)
          const operationId = text(record(record(input.request).metadata).history_operation_id)
          const target = continuationTargets.get(operationId)
          if (target) continuationRuns.set(runId, target)
        }
      }
      continue
    }
    if (event.type === 'agent/inbox/claimed') {
      for (const id of array(data.message_ids).map(text)) {
        if (result.inputs[id]) {
          result.inputs[id].status = 'claimed'
          result.inputs[id].runId = runId
        }
      }
      continue
    }
    if (!runId) continue
    if (event.type === 'assistant/text.delta' || event.type === 'assistant/message.end'
      || event.type.startsWith('tool/call.') || event.type.startsWith('approval/')
      || ['run/completed', 'run/failed', 'run/cancelled'].includes(event.type)) {
      const current = assistants.get(runId)
      if (current) current.activeReasoningIndex = undefined
    }
    if (event.type === 'assistant/text.delta' || event.type === 'assistant/reasoning.delta') {
      const message = assistant(event, runId)
      const kind = event.type === 'assistant/text.delta' ? 'answer' : 'reasoning'
      const delta = text(data.text)
      const items = message.turn!.items
      const last = items[items.length - 1]
      if (last?.kind === kind && !closedPart.has(runId)) {
        last.markdown += delta
        if (delta) last.card?.sourceSeqs.push(event.seq)
      }
      else if (delta) items.push(kind === 'answer'
        ? { kind, lane: 'answer', markdown: delta }
        : { kind, lane: 'work', markdown: delta, card: { kind, runId, id: String(event.seq), sourceSeqs: [event.seq] } })
      closedPart.delete(runId)
      if (kind === 'answer') message.content += delta
      else if (delta) message.activeReasoningIndex = items.length - 1
    } else if (event.type === 'assistant/message.end') {
      closedPart.add(runId)
    } else if (event.type.startsWith('tool/call.')) {
      const id = text(data.call_id) || text(data.tool_call_id)
      if (!id) continue
      const key = JSON.stringify([runId, id])
      let tool = tools.get(key)
      if (!tool) {
        const item = { kind: 'tool' as const, lane: 'work' as const,
          card: { kind: 'tool' as const, runId, id, sourceSeqs: [event.seq] },
          toolCallId: id, name: text(data.name) || text(data.tool), status: 'running' as RuntimeToolData['status'] }
        assistant(event, runId).turn!.items.push(item)
        tools.set(key, item)
        tool = item
      }
      if (data.name) tool.name = text(data.name)
      if (data.arguments !== undefined) tool.input = data.arguments
      if (event.type === 'tool/call.progress') tool.update = data.content ?? data.text ?? data
      if (event.type === 'tool/call.completed') {
        tool.result = data.result
        tool.status = ['failed', 'error', 'rejected'].includes(text(data.status)) ? 'failed' : 'completed'
        if (tool.status === 'failed') {
          const error = data.error ?? data.result
          tool.error = typeof error === 'string' ? error : JSON.stringify(error) ?? undefined
        }
      }
      if (event.type === 'tool/call.rejected') {
        tool.status = 'failed'
        tool.error = text(data.reason) || undefined
      }
      closedPart.add(runId)
    } else if (event.type === 'approval/requested') {
      const id = text(data.approval_id)
      const key = JSON.stringify([runId, id])
      if (id && result.approvals[key]?.requestedAt === undefined) {
        const approval: SessionApproval = {
          ...result.approvals[key], id, runId, requestedAt: event.time,
          status: result.approvals[key]?.status ?? (terminalRuns.has(runId) ? 'expired' : 'pending'), data,
        }
        result.approvals[key] = approval
        assistant(event, runId).turn!.items.push({ kind: 'permission', lane: 'work',
          card: { kind: 'permission', runId, id, sourceSeqs: [event.seq] },
          data: sessionApprovalToPermission(approval, identity) })
      }
      closedPart.add(runId)
    } else if (event.type === 'approval/resolved') {
      const id = text(data.approval_id)
      const key = JSON.stringify([runId, id])
      if (id) result.approvals[key] = { ...result.approvals[key], id, runId, data: result.approvals[key]?.data ?? data,
        status: data.decision === 'timeout' ? 'expired' : 'resolved', decision: text(data.decision),
        expiredReason: data.decision === 'timeout' ? 'timeout' : undefined }
    } else if ((event.type === 'context/compressed' && data.compressed !== false)
      || (event.type === 'run/progress' && data.phase === 'recovering')) {
      const discarded = event.type === 'run/progress' ? text(data.discarded_text) : ''
      const affected = result.messages.filter(message => message.runId === runId && message.role === 'assistant')
      if (discarded && affected.map(message => message.content).join('').endsWith(discarded)) {
        let remaining = discarded.length
        for (const message of affected.reverse()) {
          const removed = Math.min(remaining, message.content.length)
          if (!removed) continue
          message.content = message.content.slice(0, message.content.length - removed)
          let partRemaining = removed
          for (const item of [...(message.turn?.items ?? [])].reverse()) {
            if (item.kind !== 'answer') continue
            const count = Math.min(partRemaining, item.markdown.length)
            item.markdown = item.markdown.slice(0, item.markdown.length - count)
            partRemaining -= count
          }
          remaining -= removed
          if (!remaining) break
        }
      }
      const previous = assistants.get(runId)
      if (previous) {
        previous.status = 'completed'
        previous.activeReasoningIndex = undefined
        compressedSegments.set(runId, [...(compressedSegments.get(runId) ?? []), previous])
        assistants.delete(runId)
      }
      closedPart.add(runId)
      append({ id: `${runId}:context:${event.seq}`, seq: event.seq,
        createdAt: event.time, runId, role: 'system', content: text(data.summary),
        status: 'completed', attachments: [], artifacts: [],
        ...(event.type === 'run/progress' ? { progress: { ...data } } : { compression: { ...data } }) })
    } else if (event.type === 'run/event' && data.kind === 'artifact') {
      assistant(event, runId).artifacts.push(record(data.payload))
    } else if (event.type === 'run/event' && data.kind === 'error') {
      // Runtime 把失败过程中的原因也写进会话（例如上游 429）。以前这里只认
      // artifact，中间原因在 Bibit 里完全不可见，用户只看到终态那句通用文案。
      const payload = record(data.payload)
      const payloadCode = text(payload.code)
      assistant(event, runId).turn!.items.push({ kind: 'diagnostic', lane: 'work',
        data: {
          level: 'warning',
          message: text(payload.message) || payloadCode || 'run_failed',
          ...(payloadCode ? { code: payloadCode } : {}),
          ...(typeof payload.retryable === 'boolean' ? { retryable: payload.retryable } : {}),
          ...(Object.keys(record(payload.details)).length ? { details: record(payload.details) } : {}),
        } })
    } else if (['run/completed', 'run/failed', 'run/cancelled'].includes(event.type)) {
      const message = assistant(event, runId)
      message.status = event.type.slice(4) as 'completed' | 'failed' | 'cancelled'
      // 终态是权威快照；服务端修订正文时不能继续展示过时的流式内容。
      let finalContent = text(data.content) ? (continuationPrefixes.get(runId) ?? '') + text(data.content) : ''
      const precedingSegments = compressedSegments.get(runId) ?? []
      if (finalContent && precedingSegments.length) {
        const prefix = precedingSegments.map(segment => segment.content).join('')
        if (finalContent.startsWith(prefix)) finalContent = finalContent.slice(prefix.length)
        else for (const segment of precedingSegments) {
          segment.content = ''
          for (const item of segment.turn?.items ?? []) if (item.kind === 'answer') item.markdown = ''
        }
      }
      if (text(data.content) && finalContent !== message.content) {
        const answers = message.turn!.items.filter(item => item.kind === 'answer')
        const last = answers.at(-1)
        const prefix = answers.slice(0, -1).map(item => item.markdown).join('')
        if (!last) message.turn!.items.push({ kind: 'answer', lane: 'answer', markdown: finalContent })
        else if (finalContent.startsWith(prefix)) last.markdown = finalContent.slice(prefix.length)
        else {
          for (const answer of answers) answer.markdown = ''
          last.markdown = finalContent
        }
        message.content = finalContent
      }
      if (data.usage) message.usage = record(data.usage)
      if (data.error) message.error = data.error
      for (const [key, tool] of tools) {
        if (JSON.parse(key)[0] !== runId || !['pending', 'running'].includes(tool.status)) continue
        const failure = record(data.error)
        tool.status = 'failed'
        // Runtime 的 error 可能是对象也可能是纯文本（见终态诊断的两种形状）。
        tool.error = text(failure.message) || text(data.error) || text(record(failure.details).reason)
          || (event.type === 'run/cancelled' ? 'Run cancelled' : 'Run ended before tool completion')
      }
      terminalRuns.add(runId)
      closedPart.add(runId)
      for (const approval of Object.values(result.approvals)) {
        if (approval.runId === runId && approval.status === 'pending') approval.status = 'expired'
      }
    }
  }
  result.allMessages = [...messages.values()]
  for (const message of result.allMessages) {
    for (const item of message.turn?.items ?? []) {
      if (item.kind !== 'permission') continue
      const approval = result.approvals[JSON.stringify([item.data.runId, item.data.requestId])]
      if (approval) item.data = sessionApprovalToPermission(approval, identity)
    }
  }
  result.hooks = [...hooks.values()]
  reuseUnchangedMessages(result, baseline?.projection)
  return result
}

/** 与原生资源策略一致：只解析 Runtime 同源资源，不把远端 path 当成本机文件。 */
export function sessionResourceUrl(value: string, resourceBaseUrl?: string): string | undefined {
  if (!value || !resourceBaseUrl || /^file:/i.test(value)
    || (value.startsWith('/') && !value.startsWith('/api/v1/'))) return undefined
  try {
    const base = new URL(resourceBaseUrl)
    const url = new URL(value, base)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin
      || url.username || url.password) return undefined
    return url.href
  } catch { return undefined }
}

export function sessionMessageToUIMessage(message: SessionMessage, resourceBaseUrl?: string, identity?: SessionFeedIdentity): UIMessage {
  const parts: UIMessage['parts'] = message.turn?.items.map((item, index) => {
    if (item.kind === 'answer') return { type: 'text' as const, text: item.markdown }
    if (item.kind === 'reasoning') return { type: 'reasoning' as const, text: item.markdown,
      state: message.status === 'running' && message.activeReasoningIndex === index ? 'streaming' as const : 'done' as const }
    if (item.kind === 'tool') return { type: 'data-runtime-tool' as const, id: item.toolCallId, data: item }
    if (item.kind === 'permission') return { type: 'data-runtime-permission' as const, id: item.data.requestId, data: item.data }
    return { type: 'data-runtime-diagnostic' as const, data: item.data }
  }) ?? [{ type: 'text', text: message.content }]
  for (const value of [...message.attachments, ...message.artifacts]) {
    const artifact = record(value)
    const url = sessionResourceUrl(text(artifact.url) || text(artifact.path) || text(record(artifact.image_url).url), resourceBaseUrl)
    if (!url) continue
    const mediaType = text(artifact.media_type) || text(artifact.mime_type) || text(artifact.mimeType) || 'application/octet-stream'
    parts.push({ type: 'file', url, mediaType, filename: text(artifact.name) || undefined })
  }
  if (message.role === 'assistant' && ['failed', 'cancelled'].includes(message.status)) {
    const failure = record(message.error)
    const failureCode = text(failure.code)
    const failureReason = text(failure.message) || text(message.error)
    const failureDetails = record(failure.details)
    const terminal: RuntimeDiagnosticData = message.status === 'failed' ? {
      // message 保持 Runtime 原文（人话优先），code 交给界面层查文案
      // （见 RuntimeEventPart.diagnosticText）：查得到就显示人话并把原文留作证据，
      // 查不到就原样显示原文，两边都不会只剩一个看不懂的代码。
      level: 'warning',
      message: failureReason || failureCode || 'run_failed',
      ...(failureCode ? { code: failureCode } : {}),
      // 结构化字段在这里必须原样带走：界面层要按字段渲染，
      // 而不是让用户看一整段拼接过的字符串。
      ...(typeof failure.retryable === 'boolean' ? { retryable: failure.retryable } : {}),
      ...(Object.keys(failureDetails).length ? { details: failureDetails } : {}),
    } : { level: 'info', message: 'run_cancelled' }
    // Runtime 终止一条 Run 之前，会先把它作为诊断事件写进会话（run/event + kind=error），
    // 上面已经把它投影成诊断项。同一件事不该在聊天里出现两遍；只有两边确实不同
    // （例如过程里是上游 429、终态是泛化失败）时，两条才都保留。
    const duplicated = (message.turn?.items ?? []).some(
      item => item.kind === 'diagnostic' && sameDiagnostic(item.data, terminal))
    if (!duplicated) parts.push({ type: 'data-runtime-diagnostic', data: terminal })
  }
  return { id: message.id, role: message.role, parts, metadata: {
    parentId: message.parentId,
    conversationCards: message.turn?.items.map(item => item.card),
    ...(identity ? { conversationCardScope: { targetId: identity.targetId, runtimeId: identity.runtimeId, sessionId: identity.sessionId } } : {}),
    runtime: 'bianbu', runId: message.runId, runStatus: message.status,
    createdAt: new Date(message.createdAt * (message.createdAt < 1e12 ? 1000 : 1)),
    stopped: message.status === 'cancelled', usage: normalizeRuntimeUsage(message.usage),
    compression: message.compression, progress: message.progress,
  } }
}
