import { Fragment, useEffect, useMemo, useState } from 'react'
import type { RuntimeCardIdentity } from '@/lib/messages'
import { isCardExpanded, useConversationCardState, type ConversationCardScope } from '@/stores/conversation-card-state'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { invoke } from '@tauri-apps/api/core'
import { Check, RotateCcw, ShieldAlert, X } from 'lucide-react'
import type { PermissionDecisionV1 } from '@bibit/feature-contracts'
import type {
  RuntimeDiagnosticData,
  RuntimePermissionData,
  RuntimeToolData,
} from '@/lib/runtime-contract'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool'
import { TraceStatusIcon } from '@/components/ai-elements/trace-status'
import { describeToolRow, type TraceTranslate } from '@/lib/trace-presentation'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { PermissionPresenterHost } from '@/features/conversation/PermissionPresenterHost'
import { toRuntimePermissionRequest } from '@/features/conversation/adapters/runtimePermissionAdapter'
import type { ConversationContributionRegistry } from '@/features/conversation/contributionRegistry'
import { currentWindowSurface } from '@/lib/window-surface'
import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockCopyButton } from '@/components/ai-elements/code-block'
import {
  observeRuntimePermission,
  resolveRuntimePermission,
  runtimePermissionIdentityKey,
  isRuntimePermissionCurrent,
  useRuntimePermissionController,
} from '@/features/conversation/runtimePermissionController'

type RuntimeToolPart = {
  type: 'data-runtime-tool'
  id?: string
  data: RuntimeToolData
}

type RuntimePermissionPart = {
  type: 'data-runtime-permission'
  id?: string
  data: RuntimePermissionData
}

type RuntimeDiagnosticPart = {
  type: 'data-runtime-diagnostic'
  id?: string
  data: RuntimeDiagnosticData
}

export type RuntimeEventPartValue =
  | RuntimeToolPart
  | RuntimePermissionPart
  | RuntimeDiagnosticPart

const toolState = {
  pending: 'input-available',
  running: 'input-available',
  completed: 'output-available',
  failed: 'output-error',
} as const

const MAX_RUNTIME_DETAIL_CHARS = 20_000
const SECRET_KEY = /^(access_?token|refresh_?token|token|secret|password|authorization|api_?key|cookie)$/i

function safeRuntimeDetails(
  value: unknown,
  t: TraceTranslate,
  maxChars = MAX_RUNTIME_DETAIL_CHARS
): string {
  let source = value
  if (typeof value === 'string') {
    try { source = JSON.parse(value) } catch { /* keep plain text */ }
  }
  const bearer = t('trace:redact.bearer')
  let rendered: string
  try {
    rendered = typeof source === 'string'
      ? source.replace(/Bearer\s+[^\s"']+/gi, bearer)
      : JSON.stringify(source, (key, item) => SECRET_KEY.test(key)
        ? t('trace:redact.hidden')
        : typeof item === 'string'
          ? item.replace(/Bearer\s+[^\s"']+/gi, bearer)
          : item, 2) ?? ''
  } catch {
    rendered = t('trace:redact.unavailable')
  }
  return rendered.length > maxChars
    ? `${rendered.slice(0, maxChars)}\n${t('trace:redact.truncated')}`
    : rendered
}

function terminalOutput(value: unknown, t: TraceTranslate): string | undefined {
  try {
    let payload = typeof value === 'string' ? JSON.parse(value) : value
    if (payload && typeof payload === 'object' && typeof payload.content === 'string') payload = JSON.parse(payload.content)
    if (!payload || typeof payload !== 'object') return
    const lines: string[] = []
    // stdout/stderr are stream names from the tool contract, not copy.
    const labels: Array<[string, string]> = [
      ['stdout', 'stdout'],
      ['stderr', 'stderr'],
      ['output', t('trace:terminal.mergedOutput')],
    ]
    for (const [key, label] of labels) {
      if (typeof payload[key] === 'string') lines.push(`${label}:\n${safeRuntimeDetails(payload[key], t)}`)
    }
    if (typeof payload.exit_code === 'number' && Number.isInteger(payload.exit_code)) lines.push(t('trace:terminal.exitCode', { code: payload.exit_code }))
    if (payload.status === 'timeout') lines.push(t('trace:terminal.timeout'))
    return lines.length ? lines.join('\n\n') : undefined
  } catch { return undefined }
}

/**
 * 失效原因/诊断信息只带代码，文案在界面层。Runtime 自带的原因文本（老版本、
 * 或别的实现）原样显示，不能因为认不出代码就把内容吞掉：查不到文案时 i18n
 * 返回 key 本身，据此回退到调用方给的原文。
 */
const CODE_LIKE = /^[A-Za-z][A-Za-z0-9_.:-]*$/

const translateCode = (value: string, t: TraceTranslate, keys: string): string => {
  if (!CODE_LIKE.test(value)) return value
  const key = `${keys}.${value}`
  const translated = t(key)
  return translated === key ? value : translated
}

/** 诊断文案：有可翻译的错误代码就用它，否则用 Runtime 原文；命中代码时原文留作证据。 */
const diagnosticText = (data: RuntimeDiagnosticData, t: TraceTranslate): { label: string; detail?: string } => {
  if (data.code && CODE_LIKE.test(data.code)) {
    const key = `trace:diagnostic.${data.code}`
    const translated = t(key)
    if (translated !== key) {
      return { label: translated, ...(data.message && data.message !== data.code ? { detail: data.message } : {}) }
    }
  }
  return { label: translateCode(data.message, t, 'trace:diagnostic') }
}

/**
 * 诊断详情的字段顺序。已知字段排在前面（越靠前越能定位问题），
 * Runtime 将来新增的字段自动排在后面，不会被丢掉。
 */
const DIAGNOSTIC_FIELD_KEYS = [
  'tool', 'capability', 'scope', 'risk_level', 'reason',
  'provider_host', 'network_mode', 'timeout_seconds', 'http_status',
  'skill_ids', 'provider', 'action', 'agent_id', 'worker_instance',
] as const

function diagnosticFields(data: RuntimeDiagnosticData): Array<[string, unknown]> {
  const details = data.details
  if (!details) return []
  const present = (key: string) => {
    const value = details[key]
    return value !== undefined && value !== null && String(value) !== ''
  }
  const known = DIAGNOSTIC_FIELD_KEYS.filter(present)
  const rest = Object.keys(details)
    .filter(key => !(DIAGNOSTIC_FIELD_KEYS as readonly string[]).includes(key))
    .sort()
  return [...known, ...rest].map(key => [key, details[key]])
}

const diagnosticFieldLabel = (key: string, t: TraceTranslate): string => {
  const full = `trace:diagnosticField.${key}`
  const translated = t(full)
  return translated === full ? key : translated
}

/**
 * 值可能是嵌套结构（如 skill_ids）；统一走脱敏渲染，不能直接铺 JSON。
 *
 * 注意：`safeRuntimeDetails` 的键名脱敏只在序列化整个对象时生效，所以
 * **以键名判定的敏感字段必须在调用方拦截**（见下面的 SECRET_KEY 分支），
 * 否则 `api_key: "sk-..."` 这类标量值会被原样打印。
 */
const diagnosticFieldValue = (value: unknown, t: TraceTranslate): string =>
  Array.isArray(value) && value.every(item => ['string', 'number', 'boolean'].includes(typeof item))
    ? value.map(item => safeRuntimeDetails(item, t)).join(', ')
    : safeRuntimeDetails(value, t)

type Expansion = { sessionFeed?: boolean; open: boolean; onOpenChange: (open: boolean) => void }

function RuntimeToolEvent({ part, expansion }: { part: RuntimeToolPart; expansion: Expansion }) {
  const { data } = part
  const { t } = useTranslation()
  const state = toolState[data.status]
  const terminal = data.name === 'terminal' ? terminalOutput(data.result ?? data.update, t) : undefined
  const safeInput = useMemo(
    () => (data.input === undefined ? undefined : safeRuntimeDetails(data.input, t)),
    [data.input, t]
  )
  const safeError = useMemo(
    () => (data.error === undefined ? undefined : safeRuntimeDetails(data.error, t)),
    [data.error, t]
  )
  // The collapsed row is the only thing a reader sees by default, so it is
  // built from the request that was actually made and shows no raw payload.
  const row = useMemo(
    () => describeToolRow(
      { name: data.name, input: safeInput, error: safeError, status: data.status },
      t
    ),
    [data.name, data.status, safeInput, safeError, t]
  )
  return (
    <Tool
      state={state}
      toolCallId={data.toolCallId}
      defaultOpen={data.status === 'pending' || data.status === 'running'}
      {...(expansion.sessionFeed ? { open: expansion.open, onOpenChange: expansion.onOpenChange } : {})}
      className="mb-1 w-full"
      data-testid="session-tool-card"
    >
      <ToolHeader
        title={data.name}
        type={`tool-${data.name}` as `tool-${string}`}
        state={state}
        row={row}
      />
      <ToolContent title={data.name}>
        {safeInput !== undefined && <ToolInput input={safeInput} />}
        {terminal !== undefined ? (
          <CodeBlock code={terminal} language="shell" className="rounded-md">
            <CodeBlockCopyButton aria-label={t('trace:detail.copyTerminal')} />
          </CodeBlock>
        ) : data.status === 'failed' ? (
          <ToolOutput
            output={undefined}
            errorText={safeError ?? t('trace:status.failed')}
            resolver={(input) => Promise.resolve(input)}
          />
        ) : data.result !== undefined ? (
          <ToolOutput
            output={safeRuntimeDetails(data.result, t)}
            followOutput={expansion.sessionFeed}
            resolver={(input) => Promise.resolve(input)}
            errorText={undefined}
          />
        ) : data.update !== undefined ? (
          <ToolOutput
            output={safeRuntimeDetails(data.update, t)}
            followOutput={expansion.sessionFeed}
            resolver={(input) => Promise.resolve(input)}
            errorText={undefined}
          />
        ) : null}
      </ToolContent>
    </Tool>
  )
}

function RuntimePermissionEvent({
  part,
  registry,
  expansion,
}: {
  part: RuntimePermissionPart
  registry?: ConversationContributionRegistry
  expansion: Expansion
}) {
  const { data } = part
  const { t } = useTranslation()
  const identityKey = runtimePermissionIdentityKey(data)
  const entry = useRuntimePermissionController(
    (state) => state.entries[identityKey]
  )
  useEffect(() => {
    if (!expansion.sessionFeed) observeRuntimePermission(data)
  }, [data, expansion.sessionFeed])
  const projectedData = entry?.data ?? data
  const currentRuntime = isRuntimePermissionCurrent(data)
  const wasResolved =
    projectedData.status === 'resolved' || entry?.status === 'resolved'
  const resolved =
    !currentRuntime ||
    wasResolved
  const submitting = entry?.status === 'submitting'
  const error = entry?.error
  const isStatusPopup = currentWindowSurface() === 'status-popup'

  const resolve = (decision: PermissionDecisionV1) => {
    if (resolved) throw new Error('Permission request is already resolved')
    return resolveRuntimePermission(data, decision)
  }

  return (
    <div
      className="my-2 w-full rounded-md border border-trace-status-attention/30 bg-trace-status-attention/5 p-3 text-sm"
      data-testid="runtime-permission"
      data-runtime-permission-key={identityKey}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-trace-status-attention" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-trace-status-attention" data-runtime-permission-title tabIndex={-1}>
            {projectedData.expiredReason ? t('trace:permission.requestExpired') : wasResolved
              ? t('trace:permission.requestResolved')
              : currentRuntime
                ? data.title || t('trace:permission.title')
                : t('trace:permission.requestExpired')}
          </div>
          {projectedData.expiredReason && (
            <div className="mt-1 text-muted-foreground">
              {translateCode(projectedData.expiredReason, t, 'trace:permission.expiredReason')}
            </div>
          )}
          <div className="mt-1 break-words text-muted-foreground">
            {data.description}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {data.toolName}
          </div>
          {expansion.sessionFeed && <div className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]" data-testid="permission-decision-context">
            <div>{!resolved ? t('trace:permission.needsApproval') : t('trace:permission.requestedAction')}{safeRuntimeDetails(data.title, t, Infinity)}</div>
            {data.actions?.map((action, index) => <div key={index}>{safeRuntimeDetails(action.name, t, Infinity)}{t('trace:permission.actionSeparator')}{safeRuntimeDetails(action.summary, t, Infinity)}</div>)}
            {!data.actions?.length && data.inputSummary !== undefined && <div>{safeRuntimeDetails(data.inputSummary, t, Infinity)}</div>}
            <div>{t('trace:permission.impact')}{data.description ? safeRuntimeDetails(data.description, t, Infinity) : t('trace:permission.noImpact')}</div>
          </div>}
          {expansion.sessionFeed ? <Collapsible open={expansion.open} onOpenChange={expansion.onOpenChange}>
            <CollapsibleTrigger className="mt-2 text-xs underline">{t('trace:permission.moreDetails')}</CollapsibleTrigger>
            <CollapsibleContent><div className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{safeRuntimeDetails({ expiresAt: data.expiresAt, input: data.inputSummary }, t)}</div></CollapsibleContent>
          </Collapsible> : data.inputSummary !== undefined && (
            <div
              className="mt-2 overflow-hidden rounded-md border border-trace-status-attention/20 bg-background/60"
              data-testid="runtime-permission-summary"
            >
              <ToolInput input={safeRuntimeDetails(data.inputSummary, t)} />
            </div>
          )}
          {resolved && projectedData.decision && (
            <div className="mt-2 flex items-center gap-1 font-medium text-muted-foreground">
              {projectedData.decision === 'allow_once' ? (
                <Check className="size-3.5" />
              ) : (
                <X className="size-3.5" />
              )}
              {projectedData.decision === 'allow_once' ? t('trace:permission.allowedOnce') : t('trace:permission.denied')}
            </div>
          )}
          {error && (
            <div className="mt-2 flex items-center gap-1 text-destructive">
              <RotateCcw className="size-3.5" />
              <span className="break-words">{error}</span>
            </div>
          )}
          {!resolved && isStatusPopup ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('trace:permission.waitingInMainWindow')}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void invoke('open_main_window')}
              >
                {t('trace:permission.openMainWindow')}
              </Button>
            </div>
          ) : resolved ? null : (
            <fieldset disabled={submitting}>
              <PermissionPresenterHost
                request={toRuntimePermissionRequest(data)}
                decide={resolve}
                registry={registry}
                enableCustomPresenter
                manageLifecycle={false}
              />
            </fieldset>
          )}
        </div>
      </div>
    </div>
  )
}

export function RuntimeEventPart({
  part,
  registry,
  sessionFeed,
  card,
  scope,
}: {
  part: RuntimeEventPartValue
  messageId: string
  registry?: ConversationContributionRegistry
  sessionFeed?: boolean
  card?: RuntimeCardIdentity
  scope?: ConversationCardScope
}) {
  const { t } = useTranslation()
  const [localOpen, setLocalOpen] = useState(false)
  const storedOpen = useConversationCardState(state => Boolean(scope && card && isCardExpanded(state.opened, scope, card)))
  const expansion = { sessionFeed, open: scope && card ? storedOpen : localOpen,
    onOpenChange: (open: boolean) => scope && card ? useConversationCardState.getState().setExpanded(scope, card, open) : setLocalOpen(open) }
  if (part.type === 'data-runtime-tool') {
    return <RuntimeToolEvent part={part} expansion={expansion} />
  }
  if (part.type === 'data-runtime-permission') {
    return <RuntimePermissionEvent part={part} registry={registry} expansion={expansion} />
  }
  const diagnostic = diagnosticText(part.data, t)
  const fields = diagnosticFields(part.data)
  const fieldRows = fields.length ? (
    <dl
      className="mt-1.5 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1"
      data-testid="runtime-diagnostic-details"
    >
      {fields.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-muted-foreground/70">{diagnosticFieldLabel(key, t)}</dt>
          <dd className="min-w-0 break-words [overflow-wrap:anywhere]">
            {SECRET_KEY.test(key) ? t('trace:redact.hidden') : diagnosticFieldValue(value, t)}
          </dd>
        </Fragment>
      ))}
    </dl>
  ) : null
  return (
    <div
      className="my-2 flex min-h-7 items-start gap-2 px-2 py-1 text-trace text-muted-foreground"
      data-testid="runtime-diagnostic"
    >
      <span className="mt-0.5 shrink-0">
        <TraceStatusIcon
          status={part.data.level === 'warning' ? 'attention' : 'idle'}
          pulse={false}
        />
      </span>
      {/* div 而不是 span：详情区是 <dl>（flow content），放在 span 里是无效嵌套，
          浏览器会重排父子关系。 */}
      <div className="min-w-0 [overflow-wrap:anywhere]">
        {diagnostic.label}
        {diagnostic.detail ? (
          <span className="mt-0.5 block text-muted-foreground/70">{diagnostic.detail}</span>
        ) : null}
        {fieldRows ? (expansion.sessionFeed ? (
          <Collapsible open={expansion.open} onOpenChange={expansion.onOpenChange}>
            <CollapsibleTrigger className="mt-1 block text-xs underline">
              {t('trace:diagnosticDetails')}
            </CollapsibleTrigger>
            <CollapsibleContent>{fieldRows}</CollapsibleContent>
          </Collapsible>
        ) : fieldRows) : null}
      </div>
    </div>
  )
}

export function RuntimePermissionFallback({
  threadId,
  renderedPermissionKeys,
}: {
  threadId: string
  renderedPermissionKeys: ReadonlySet<string>
}) {
  const entries = useRuntimePermissionController((state) => state.entries)
  const missing = Object.entries(entries)
    .filter(
      ([key, entry]) =>
        entry.data.sessionId === threadId &&
        entry.data.status === 'pending' && entry.status !== 'resolved' &&
        isRuntimePermissionCurrent(entry.data) &&
        !renderedPermissionKeys.has(key)
    )
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        left.data.createdAt.localeCompare(right.data.createdAt) ||
        leftKey.localeCompare(rightKey)
    )

  return (
    <>
      {missing.map(([key, entry]) => (
        <RuntimeEventPart
          key={key}
          part={{
            type: 'data-runtime-permission',
            id: entry.data.requestId,
            data: entry.data,
          }}
          messageId={`runtime-permission-fallback:${key}`}
        />
      ))}
    </>
  )
}
