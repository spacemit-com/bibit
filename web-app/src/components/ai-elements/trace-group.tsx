import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  describeGroupSummary,
  type TraceGroupItem,
} from '@/lib/trace-presentation'
import { cn } from '@/lib/utils'
import { useControllableState } from '@radix-ui/react-use-controllable-state'
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { TraceRail } from './trace-frame'
import { TraceHeader } from './trace-header'
import { TraceStatusIcon } from './trace-status'

/**
 * A whole work segment — every consecutive reasoning, tool, approval or
 * diagnostic item in one turn — behind a single collapsible row.
 *
 * The group is a sibling of the answer, not a container for the reasoning: the
 * rows inside it stay siblings of each other, so a tool is never something you
 * only find by opening a thought.
 *
 * The group carries the only rail. Rows inside it do not draw their own, which
 * is what turns "eight indented lines" into one trace.
 */
export type TraceGroupProps = {
  /** Pure data used for the summary line; rendering stays with the caller. */
  items: readonly TraceGroupItem[]
  /**
   * The turn is still running. Omitted means "unknown": the summary keeps the
   * working branch, and no duration timer is started.
   */
  isStreaming?: boolean
  /** Pins the group open (a pending approval blocks the turn). Never closes. */
  forceOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  children: ReactNode
}

export const TraceGroup = memo(
  ({
    items,
    isStreaming,
    forceOpen = false,
    open,
    onOpenChange,
    className,
    children,
  }: TraceGroupProps) => {
    const { t, i18n } = useTranslation()
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: false,
      onChange: onOpenChange,
    })

    // Opening is the only automatic transition: a pending approval has to be
    // seen, and so does a diagnostic (it is how a stopped or rescued run says
    // what happened, and it used to be visible without expanding anything).
    // Nothing here closes the group, so a settled choice survives every later
    // state update.
    const pinned = forceOpen || items.some((item) => item.kind === 'diagnostic')
    useEffect(() => {
      if (pinned) setIsOpen(true)
    }, [pinned, setIsOpen])

    // Wall-clock span the group has been live in this window: the first frame
    // it streamed, to the moment it settles. The start is never reset, because
    // a group pauses between two tool calls and a single trailing reasoning
    // delta used to restart the clock and report a six second group as null
    // work ("5 steps · 0s"). A group that mounts after the fact (history
    // replay) never starts a clock, so its summary reports step counts instead
    // of inventing a duration.
    const firstLiveAt = useRef<number | null>(null)
    const [durationMs, setDurationMs] = useState<number | undefined>(undefined)
    useEffect(() => {
      if (isStreaming) {
        if (firstLiveAt.current === null) firstLiveAt.current = Date.now()
        return
      }
      if (firstLiveAt.current === null) return
      setDurationMs(Date.now() - firstLiveAt.current)
    }, [isStreaming])

    const summary = useMemo(
      () =>
        describeGroupSummary(
          items,
          t,
          i18n?.language ?? 'en',
          durationMs,
          isStreaming
        ),
      [items, t, i18n?.language, durationMs, isStreaming]
    )

    return (
      <Collapsible
        className={cn('not-prose', className)}
        open={isOpen}
        onOpenChange={setIsOpen}
        data-testid="trace-group"
      >
        <TraceHeader
          icon={<TraceStatusIcon status={summary.status} />}
          primary={summary.text}
          data-testid="trace-group-header"
        />
        <CollapsibleContent>
          <TraceRail className="space-y-2 pb-1">{children}</TraceRail>
        </CollapsibleContent>
        {summary.status === 'error' || summary.status === 'attention' ? (
          <span role="status" className="sr-only">
            {summary.text}
          </span>
        ) : null}
      </Collapsible>
    )
  }
)

TraceGroup.displayName = 'TraceGroup'
