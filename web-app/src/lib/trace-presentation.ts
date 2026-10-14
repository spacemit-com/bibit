import type { TraceStatusKey } from '@/components/ai-elements/trace-status'

/**
 * Turn runtime work items into the one line a reader sees while the trace is
 * collapsed.
 *
 * Everything here is presentation and it stays in the frontend on purpose: the
 * copy has to be localised, and the collapsed row is permanently visible, so
 * the Runtime is the wrong place to decide either the wording or what is safe
 * to show.
 *
 * Rules: the summary always comes from the request that was actually made
 * (nothing is inferred, and no JSON is ever shown); a tool's own name is a
 * secondary label rather than the sentence; a failure puts the reason in the
 * secondary slot.
 */

export type TraceTranslate = (
  key: string,
  options?: Record<string, unknown>
) => string

export type TraceToolStatus = 'pending' | 'running' | 'completed' | 'failed'

export type TraceToolInput = {
  name: string
  input?: unknown
  error?: string
  status: TraceToolStatus
}

export type TraceRowCopy = {
  primary: string
  secondary?: string
  status: TraceStatusKey
  statusLabel: string
  failureReason?: string
}

export type TraceGroupItem =
  | { kind: 'reasoning'; streaming: boolean }
  | ({ kind: 'tool' } & TraceToolInput)
  | { kind: 'permission'; pending: boolean }
  | { kind: 'diagnostic' }

export type TraceGroupSummary = {
  text: string
  status: TraceStatusKey
  statusLabel: string
  forceOpen: boolean
}

const PRIMARY_MAX = 60
const SECONDARY_MAX = 80
const VALUE_MAX = 40

export const clipText = (value: string, max = PRIMARY_MAX): string => {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const firstLine = (value: string): string =>
  value.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ''

const readRecord = (value: unknown): Record<string, unknown> | undefined => {
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return undefined
    }
  }
  return typeof candidate === 'object' &&
    candidate !== null &&
    !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined
}

const scalarEntries = (
  record: Record<string, unknown> | undefined
): Array<[string, string]> => {
  if (!record) return []
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') entries.push([key, value])
    else if (typeof value === 'number' || typeof value === 'boolean')
      entries.push([key, String(value)])
    if (entries.length === 2) break
  }
  return entries
}

/**
 * read_file becomes "read file". Case is left alone: the tool id is an
 * identifier, and title-casing it would invent a name the Runtime never used.
 */
export function humanizeToolName(name: string): string {
  return name.replace(/[_:/-]+/g, ' ').replace(/\s+/g, ' ').trim() || name
}

type ToolTemplate = {
  key: string
  param: string
  fields: readonly string[]
}

const TOOL_TEMPLATES: Record<string, ToolTemplate> = {
  terminal: { key: 'trace:tool.command', param: 'command', fields: ['command', 'cmd', 'script'] },
  bash: { key: 'trace:tool.command', param: 'command', fields: ['command', 'cmd', 'script'] },
  shell: { key: 'trace:tool.command', param: 'command', fields: ['command', 'cmd', 'script'] },
  exec: { key: 'trace:tool.command', param: 'command', fields: ['command', 'cmd', 'script'] },
  read_file: { key: 'trace:tool.read', param: 'path', fields: ['path', 'file_path', 'filename', 'file'] },
  read: { key: 'trace:tool.read', param: 'path', fields: ['path', 'file_path', 'filename', 'file'] },
  read_text_file: { key: 'trace:tool.read', param: 'path', fields: ['path', 'file_path', 'filename', 'file'] },
  write_file: { key: 'trace:tool.write', param: 'path', fields: ['path', 'file_path', 'filename', 'file'] },
  write: { key: 'trace:tool.write', param: 'path', fields: ['path', 'file_path', 'filename', 'file'] },
  edit: { key: 'trace:tool.write', param: 'path', fields: ['path', 'file_path', 'filename', 'file'] },
  str_replace: { key: 'trace:tool.write', param: 'path', fields: ['path', 'file_path', 'filename', 'file'] },
  apply_patch: { key: 'trace:tool.write', param: 'path', fields: ['path', 'file_path', 'filename', 'file'] },
  list_dir: { key: 'trace:tool.list', param: 'path', fields: ['path', 'dir', 'directory'] },
  ls: { key: 'trace:tool.list', param: 'path', fields: ['path', 'dir', 'directory'] },
  search: { key: 'trace:tool.search', param: 'pattern', fields: ['pattern', 'query', 'search'] },
  grep: { key: 'trace:tool.search', param: 'pattern', fields: ['pattern', 'query', 'search'] },
  glob: { key: 'trace:tool.search', param: 'pattern', fields: ['pattern', 'query', 'search'] },
  web_search: { key: 'trace:tool.webSearch', param: 'query', fields: ['query', 'q'] },
  web_fetch: { key: 'trace:tool.webFetch', param: 'host', fields: ['url', 'href'] },
}

const MCP_NAME = /^mcp__(.+?)__(.+)$|^([^:]+)::(.+)$/

export function parseMcpToolName(
  name: string
): { server: string; tool: string } | undefined {
  const matched = MCP_NAME.exec(name)
  if (!matched) return undefined
  const server = matched[1] ?? matched[3]
  const tool = matched[2] ?? matched[4]
  if (!server || !tool) return undefined
  return { server, tool }
}

const hostOf = (value: string): string => {
  try {
    return new URL(value).host || value
  } catch {
    return value
  }
}

export function traceStatusKey(status: TraceToolStatus): TraceStatusKey {
  if (status === 'failed') return 'error'
  if (status === 'completed') return 'success'
  if (status === 'running') return 'running'
  return 'idle'
}

export function describeToolRow(
  tool: TraceToolInput,
  t: TraceTranslate
): TraceRowCopy {
  const record = readRecord(tool.input)
  // A runtime event without a name would otherwise collapse the row to an
  // empty string, so the generic template gets a word for "something".
  const humanized = humanizeToolName(tool.name) || t('trace:tool.unknown')
  const template = TOOL_TEMPLATES[tool.name]
  const failureReason =
    tool.status === 'failed' && tool.error
      ? clipText(firstLine(tool.error), SECONDARY_MAX)
      : undefined

  let primary = t('trace:tool.generic', { name: humanized })
  let secondary: string | undefined

  if (template && record) {
    const field = template.fields.find(
      (key) => typeof record[key] === 'string' && (record[key] as string).trim()
    )
    if (field) {
      const raw = firstLine(record[field] as string)
      // Clipped twice on purpose: the value first (so a long path still shows
      // its head), then the finished phrase so the row itself stays within the
      // single-line budget whatever the template adds.
      primary = clipText(
        t(template.key, {
          [template.param]:
            template.param === 'host' ? hostOf(raw) : clipText(raw, PRIMARY_MAX),
        }),
        PRIMARY_MAX
      )
      secondary = humanized
    }
  } else if (!template) {
    const mcp = parseMcpToolName(tool.name)
    if (mcp) primary = t('trace:tool.mcp', mcp)
    const scalars = scalarEntries(record)
    if (scalars.length)
      secondary = clipText(
        scalars
          .map(([key, value]) => `${key}: ${clipText(value, VALUE_MAX)}`)
          .join(' · '),
        SECONDARY_MAX
      )
  }

  return {
    primary,
    secondary: failureReason ?? secondary,
    status: traceStatusKey(tool.status),
    statusLabel: t(`trace:status.${tool.status}`),
    ...(failureReason ? { failureReason } : {}),
  }
}

export function formatTraceDuration(ms: number, locale: string): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const chinese = locale.toLowerCase().startsWith('zh')
  const count = new Intl.NumberFormat(locale)
  if (total < 60)
    return chinese ? `${count.format(total)} 秒` : `${count.format(total)}s`
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return chinese
    ? `${count.format(minutes)} 分 ${seconds} 秒`
    : `${minutes}m ${seconds}s`
}

/**
 * `live` says whether the turn is still running. A stopped run can leave a tool
 * at `pending` forever, and calling that "working" would be the one thing a
 * summary line must never do; pass `false` when the run already ended.
 */
export function describeGroupSummary(
  items: readonly TraceGroupItem[],
  t: TraceTranslate,
  locale: string,
  durationMs?: number,
  live?: boolean
): TraceGroupSummary {
  const steps = items.length
  // A sub-second span is not worth a number: it read as "已完成 5 步 · 用时 0 秒"
  // for a group the reader watched for a fraction of a second, which looks like
  // a broken counter rather than a fast one.
  const duration =
    durationMs !== undefined && durationMs >= 1000
      ? formatTraceDuration(durationMs, locale)
      : undefined
  const pending = items.filter(
    (item) => item.kind === 'permission' && item.pending
  ).length
  const tools = items.filter(
    (item): item is { kind: 'tool' } & TraceToolInput => item.kind === 'tool'
  )
  const failed = tools.filter((tool) => tool.status === 'failed').length

  if (pending)
    return {
      text: t('trace:group.approvalNeeded', { count: pending }),
      status: 'attention',
      statusLabel: t('trace:status.attention'),
      forceOpen: true,
    }

  if (failed)
    return {
      text: t('trace:group.partialFailure', { steps, failed }),
      status: 'error',
      statusLabel: t('trace:status.failed'),
      forceOpen: false,
    }

  const currentIndex = items.findIndex(
    (item) =>
      (item.kind === 'tool' &&
        (item.status === 'running' || item.status === 'pending')) ||
      (item.kind === 'reasoning' && item.streaming)
  )
  if (currentIndex >= 0 && live !== false) {
    const current = items[currentIndex]
    return {
      text:
        current.kind === 'tool'
          ? t('trace:group.working', {
              index: currentIndex + 1,
              action: describeToolRow(current, t).primary,
            })
          : t('trace:group.workingReasoning', { index: currentIndex + 1 }),
      status: 'running',
      statusLabel: t('trace:status.running'),
      forceOpen: false,
    }
  }

  if (!tools.length)
    return {
      text:
        duration === undefined
          ? t('trace:group.reasoningOnly')
          : t('trace:group.reasoningOnlyDuration', { duration }),
      status: 'idle',
      statusLabel: t('trace:status.completed'),
      forceOpen: false,
    }

  return {
    text:
      duration === undefined
        ? t('trace:group.completed', { steps })
        : t('trace:group.completedDuration', { steps, duration }),
    status: 'success',
    statusLabel: t('trace:status.completed'),
    forceOpen: false,
  }
}
