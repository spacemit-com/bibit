import {
  CodeBlockCopyButton,
  CodeBlockContext,
} from '@/components/ai-elements/code-block'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useMemo, type ComponentProps, type ReactNode } from 'react'
import { tracePayloadClass } from './trace-frame'

/**
 * Expanded payload panel. One surface, one scroll per payload: payloads are
 * capped here rather than inside a second scroller, and nothing in the panel
 * hardcodes a light or dark look — the app theme decides.
 */
export type TraceDetailProps = ComponentProps<'div'> & {
  /** Raw text offered through the copy affordance. */
  copy?: string
}

const CopyControl = ({ value, label }: { value: string; label: string }) => (
  <CodeBlockContext.Provider value={{ code: value }}>
    <CodeBlockCopyButton
      aria-label={label}
      className="size-6 text-muted-foreground"
    />
  </CodeBlockContext.Provider>
)

export const TraceDetail = ({
  className,
  copy,
  children,
  ...props
}: TraceDetailProps) => {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'mt-2 space-y-3 rounded-md bg-trace-surface p-3 text-xs',
        className
      )}
      {...props}
    >
      {children}
      {copy ? (
        <div className="flex justify-end">
          <CopyControl value={copy} label={t('trace:detail.copy')} />
        </div>
      ) : null}
    </div>
  )
}

export const TraceSection = ({
  label,
  copy,
  children,
}: {
  label: string
  copy?: string
  children: ReactNode
}) => {
  const { t } = useTranslation()
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </h4>
        {copy ? <CopyControl value={copy} label={t('trace:detail.copy')} /> : null}
      </div>
      {children}
    </section>
  )
}

type ParsedPayload =
  | { kind: 'record'; record: Record<string, unknown> }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

const parsePayload = (value: unknown): ParsedPayload => {
  let candidate = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return { kind: 'empty' }
    try {
      candidate = JSON.parse(trimmed)
    } catch {
      return { kind: 'text', text: value }
    }
  }
  if (candidate === undefined || candidate === null) return { kind: 'empty' }
  if (typeof candidate === 'object' && !Array.isArray(candidate))
    return { kind: 'record', record: candidate as Record<string, unknown> }
  if (Array.isArray(candidate) && !candidate.length) return { kind: 'empty' }
  return { kind: 'text', text: JSON.stringify(candidate, null, 2) ?? '' }
}

const ValueView = ({ value }: { value: unknown }) => {
  if (typeof value === 'object' && value !== null)
    return (
      <pre className="font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  return (
    <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      {String(value)}
    </span>
  )
}

export const KeyValueList = ({
  record,
}: {
  record: Record<string, unknown>
}) => (
  <dl className="space-y-1.5">
    {Object.entries(record).map(([key, value]) => (
      <div
        key={key}
        className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-0.5"
      >
        <dt className="font-mono text-muted-foreground [overflow-wrap:anywhere]">
          {key}
        </dt>
        <dd>
          <ValueView value={value} />
        </dd>
      </div>
    ))}
  </dl>
)

/**
 * Payload renderer shared by tool input and tool output: structured data reads
 * as a key/value list instead of a wall of JSON, and anything unstructured
 * falls back to preformatted text.
 */
export const TracePayload = ({ value }: { value: unknown }) => {
  const { t } = useTranslation()
  const parsed = useMemo(() => parsePayload(value), [value])
  if (parsed.kind === 'empty')
    return <p className="text-muted-foreground">{t('trace:detail.empty')}</p>
  if (parsed.kind === 'record') return <KeyValueList record={parsed.record} />
  return (
    <pre
      className={cn(
        tracePayloadClass,
        'p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]'
      )}
    >
      {parsed.text}
    </pre>
  )
}
