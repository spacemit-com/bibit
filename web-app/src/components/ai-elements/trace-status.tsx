/* eslint-disable react-refresh/only-export-components */
import {
  CheckIcon,
  ClockIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
  XCircleIcon,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * States a trace row can be in, plus the attention state used by approvals and
 * diagnostics. Status is always carried by three channels — icon, colour and
 * text — so it survives colour blindness, greyscale printing and screen
 * readers.
 */
export type TraceStatusKey =
  | 'idle'
  | 'running'
  | 'success'
  | 'error'
  | 'attention'

export const TRACE_STATUS_META: Record<
  TraceStatusKey,
  { icon: LucideIcon; className: string; spin?: boolean }
> = {
  idle: { icon: ClockIcon, className: 'text-trace-status-idle' },
  running: {
    icon: LoaderCircleIcon,
    className: 'text-trace-status-running',
    spin: true,
  },
  success: { icon: CheckIcon, className: 'text-trace-status-success' },
  error: { icon: XCircleIcon, className: 'text-trace-status-error' },
  attention: {
    icon: ShieldAlertIcon,
    className: 'text-trace-status-attention',
  },
}

export type TraceStatusBadgeProps = {
  status: TraceStatusKey
  label: string
  icon?: LucideIcon
  className?: string
}

export const TraceStatusBadge = ({
  status,
  label,
  icon,
  className,
}: TraceStatusBadgeProps) => {
  const meta = TRACE_STATUS_META[status]
  const Icon = icon ?? meta.icon
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap',
        meta.className,
        className
      )}
    >
      <Icon
        className={cn('size-3.5', meta.spin && 'motion-safe:animate-spin')}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

/**
 * Leading glyph for a row or a group summary. A running row shows a pulsing
 * dot rather than a spinner so the summary text stays the thing you read.
 */
export const TraceStatusIcon = ({
  status,
  pulse = true,
  className,
}: {
  status: TraceStatusKey
  pulse?: boolean
  className?: string
}) => {
  const meta = TRACE_STATUS_META[status]
  const Icon = meta.icon
  return (
    <Icon
      className={cn(
        'size-4',
        meta.className,
        meta.spin && pulse
          ? 'motion-safe:animate-trace-pulse'
          : meta.spin && 'motion-safe:animate-spin',
        className
      )}
      aria-hidden="true"
    />
  )
}
