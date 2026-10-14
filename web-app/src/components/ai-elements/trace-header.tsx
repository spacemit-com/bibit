import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronRightIcon } from 'lucide-react'
import { memo, type ComponentProps, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TraceStatusBadge, type TraceStatusKey } from './trace-status'

/**
 * The one row shape every trace card uses: a glyph, a human-readable label, an
 * optional tool name (mono, second in line), an optional status badge and a
 * chevron. Rows stay quiet at rest and only pick up colour on hover, so a
 * resting conversation reads as one column of text.
 *
 * The whole row is the hit target. Focus and the expanded state come from the
 * Radix trigger underneath, so keyboard and screen-reader behaviour is not
 * reimplemented per card.
 */
export type TraceHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  icon: ReactNode
  primary: ReactNode
  secondary?: ReactNode
  badge?: { status: TraceStatusKey; label: string; icon?: LucideIcon }
}

export const TraceHeader = memo(
  ({
    className,
    icon,
    primary,
    secondary,
    badge,
    onKeyDown,
    children,
    ...props
  }: TraceHeaderProps) => (
    <CollapsibleTrigger
      onKeyDown={(event) => {
        onKeyDown?.(event)
        // Radix opens on Enter/Space but does not close on Escape. Collapse
        // through the same path a click takes, so focus stays on the row.
        if (event.key !== 'Escape' || event.defaultPrevented) return
        const trigger = event.currentTarget
        if (trigger.dataset.state !== 'open') return
        event.preventDefault()
        trigger.click()
      }}
      className={cn(
        // 28px row: the trace is chrome around the answer, and a 36px line
        // made one collapsed card as tall as a paragraph of prose. Type drops
        // to the trace step so a row reads as scaffolding next to the answer.
        'group/trace flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-trace text-muted-foreground transition-colors duration-[120ms] outline-none hover:bg-trace-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className
      )}
      {...props}
    >
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      {/* Digits here are counts and durations, which tick while the group is
          live: tabular figures stop the row from twitching as they change. */}
      <span className="min-w-0 truncate tabular-nums">{primary}</span>
      {secondary ? (
        <span className="hidden min-w-0 truncate font-mono text-xs opacity-80 sm:inline">
          {secondary}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {badge ? (
          <TraceStatusBadge
            status={badge.status}
            label={badge.label}
            icon={badge.icon}
          />
        ) : null}
        <ChevronRightIcon
          className="size-3.5 shrink-0 opacity-60 transition-[transform,opacity] duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] group-hover/trace:opacity-100 group-data-[state=open]/trace:rotate-90 group-data-[state=open]/trace:opacity-100"
          aria-hidden="true"
        />
      </span>
      {children}
    </CollapsibleTrigger>
  )
)

TraceHeader.displayName = 'TraceHeader'
