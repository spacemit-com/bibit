import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * One rail for a whole work group.
 *
 * The agent trace — reasoning, tool calls, approvals, diagnostics — reports
 * what the agent is doing, which is secondary to the conversation itself. The
 * frame stays deliberately quiet: a hairline the rows hang off, no fill, no
 * shadow, no per-row box. Approval is the exception and does not use this
 * frame — it blocks the turn and has to interrupt (see the permission card).
 *
 * The rail belongs to the group, not to each row: N consecutive tool calls
 * share one line instead of drawing N indented rules, and a lone row needs no
 * rail at all.
 */
export const TraceRail = ({
  className,
  children,
  ...props
}: ComponentProps<'div'>) => (
  <div
    className={cn('border-l border-trace-rail/70 pl-3', className)}
    {...props}
  >
    {children}
  </div>
)

/**
 * Frame for a payload (tool input, tool output, terminal text). Capped so a
 * long payload cannot push the answer off screen, and never nested inside a
 * second scroll container — the trace keeps exactly one scroller per payload.
 */
export const tracePayloadClass =
  'max-h-80 overflow-auto rounded-md border border-border/60 bg-background'
