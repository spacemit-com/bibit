/* eslint-disable react-refresh/only-export-components */
import { useControllableState } from '@radix-ui/react-use-controllable-state'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatTraceDuration } from '@/lib/trace-presentation'
import { SparklesIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react'
import { Shimmer } from './shimmer'
import { TraceHeader } from './trace-header'

// ── Context ────────────────────────────────────────────────────────────────

type ChainOfThoughtContextValue = {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  isStreaming: boolean
  messageIsStreaming: boolean
  durationMs: number | undefined
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(
  null
)

export const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext)
  if (!context) {
    throw new Error(
      'ChainOfThought components must be used within ChainOfThought'
    )
  }
  return context
}

// ── ChainOfThought (root) ──────────────────────────────────────────────────

export type ChainOfThoughtProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean
  /** When true, suppresses collapse/expand animations (e.g. while the message is streaming). */
  messageIsStreaming?: boolean
  /** When true the collapsible auto-collapses (e.g. text content appeared after this CoT group). */
  preserveManualState?: boolean
  shouldCollapse?: boolean
  /** When true the collapsible is forced open and overrides auto-collapse (e.g. a tool is awaiting approval). */
  forceOpen?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export const ChainOfThought = memo(
  ({
    className,
    isStreaming = false,
    messageIsStreaming = false,
    shouldCollapse,
    preserveManualState = false,
    forceOpen = false,
    open,
    defaultOpen = true,
    onOpenChange,
    children,
    ...props
  }: ChainOfThoughtProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    })

    // Follow the caller's open intent. forceOpen pins it open (e.g. a tool
    // awaiting approval). When shouldCollapse is a boolean, track it two-way so
    // the trace opens as a step gains content and collapses when it has none or
    // the answer begins; when undefined the caller isn't controlling collapse,
    // so defaultOpen / manual toggle is left untouched. Re-applied only on
    // input change, preserving a manual toggle between changes.
    useEffect(() => {
      if (preserveManualState && !forceOpen) return
      if (forceOpen) setIsOpen(true)
      else if (shouldCollapse === true) setIsOpen(false)
      else if (shouldCollapse === false) setIsOpen(true)
    }, [forceOpen, shouldCollapse, setIsOpen, preserveManualState])

    // Wall-clock duration of the stream this window actually watched. A card
    // that mounts after the fact (history replay) never starts a timer, so the
    // header reports no duration rather than inventing one.
    const [startTime, setStartTime] = useState<number | null>(null)
    const [durationMs, setDurationMs] = useState<number | undefined>(undefined)

    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) setStartTime(Date.now())
      } else if (startTime !== null) {
        setDurationMs(Date.now() - startTime)
        setStartTime(null)
      }
    }, [isStreaming, startTime])

    const contextValue = useMemo(
      () => ({
        isStreaming,
        messageIsStreaming,
        isOpen,
        setIsOpen,
        durationMs,
      }),
      [isStreaming, messageIsStreaming, isOpen, setIsOpen, durationMs]
    )

    return (
      <ChainOfThoughtContext.Provider value={contextValue}>
        <Collapsible
          className={cn(
            'not-prose transition-colors',
            // No frame in either state. A trace is scaffolding around the
            // answer; a filled, bordered card gave the agent's working more
            // visual weight than the reply it supports. The group rail sets
            // the work apart instead, matching the tool and approval rows.
            'data-[state=open]:mt-1',
            className
          )}
          onOpenChange={setIsOpen}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ChainOfThoughtContext.Provider>
    )
  }
)

// ── ChainOfThoughtHeader ───────────────────────────────────────────────────

export type ChainOfThoughtHeaderProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  title?: string
}

export const ChainOfThoughtHeader = memo(
  ({ className, title, children, ...props }: ChainOfThoughtHeaderProps) => {
    const { isStreaming, durationMs } = useChainOfThought()
    const { t, i18n } = useTranslation()
    const streaming = isStreaming || durationMs === 0
    // Under a second the number is noise, and "已思考 0 秒" reads as a bug.
    const watched =
      durationMs !== undefined && durationMs >= 1000 ? durationMs : undefined
    const label =
      title ??
      (watched === undefined
        ? t('trace:reasoning.completedNoDuration')
        : t('trace:reasoning.completed', {
            duration: formatTraceDuration(watched, i18n?.language ?? 'en'),
          }))

    return (
      <TraceHeader
        className={className}
        icon={<SparklesIcon className="size-4" />}
        primary={
          children ??
          (streaming ? (
            <Shimmer as="span">{t('trace:reasoning.streaming')}</Shimmer>
          ) : (
            label
          ))
        }
        {...props}
      />
    )
  }
)

// ── ChainOfThoughtContent ──────────────────────────────────────────────────

export type ChainOfThoughtContentProps = ComponentProps<
  typeof CollapsibleContent
>

export const ChainOfThoughtContent = memo(
  ({ className, children, ...props }: ChainOfThoughtContentProps) => (
    <CollapsibleContent
      className={cn(
        // Opacity only: a slide would read as jitter on every stream phase
        // change, and reduced-motion users get an instant toggle.
        'relative text-sm text-muted-foreground outline-none duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:animate-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className
      )}
      {...props}
    >
      <div className="space-y-3">{children}</div>
    </CollapsibleContent>
  )
)

// ── Display names ──────────────────────────────────────────────────────────

ChainOfThought.displayName = 'ChainOfThought'
ChainOfThoughtHeader.displayName = 'ChainOfThoughtHeader'
ChainOfThoughtContent.displayName = 'ChainOfThoughtContent'
