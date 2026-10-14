/* eslint-disable react-refresh/only-export-components */
import { useControllableState } from '@radix-ui/react-use-controllable-state'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import { ShieldAlertIcon, WrenchIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import {
  createContext,
  useCallback,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { CodeBlock } from './code-block'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { Citations } from '@/components/Citations'
import { parseCitationsFromToolOutput } from '@/lib/citation-parser'
import { PermissionPresenterHost } from '@/features/conversation/PermissionPresenterHost'
import type { ConversationContributionRegistry } from '@/features/conversation/contributionRegistry'
import { Button } from '@/components/ui/button'
import { currentWindowSurface } from '@/lib/window-surface'
import { tracePayloadClass } from './trace-frame'
import { TraceHeader } from './trace-header'
import { TraceDetail, TracePayload, TraceSection } from './trace-detail'
import {
  describeToolRow,
  type TraceRowCopy,
  type TraceToolStatus,
} from '@/lib/trace-presentation'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { invoke } from '@tauri-apps/api/core'
import {
  applyCurrentToolDecision,
  toCurrentToolPermissionRequest,
} from '@/features/conversation/adapters/currentToolApprovalAdapter'

type ToolContextValue = {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  state: ToolUIPart['state']
  toolCallId?: string
  messageId?: string
  awaitingApproval: boolean
}

const ToolContext = createContext<ToolContextValue | null>(null)

export const useTool = () => {
  const context = useContext(ToolContext)
  if (!context) {
    throw new Error('Tool components must be used within Tool')
  }
  return context
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  className?: string
  state: ToolUIPart['state']
  toolCallId?: string
  messageId?: string
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  approvalPending?: boolean
}

type ToolBodyProps = Omit<ToolProps, 'approvalPending'> & {
  isPending: boolean
}

const ToolBody = memo(
  ({
    className,
    state,
    toolCallId,
    messageId,
    open,
    defaultOpen,
    onOpenChange,
    isPending,
    children,
    ...props
  }: ToolBodyProps) => {
    // Expansion is caller-controlled: the Runtime path keeps the preference in
    // the card store, a non-Runtime path passes defaultOpen. A state or
    // approval update must never move the row (R5), so there is no effect here.
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen ?? false,
      onChange: onOpenChange,
    })

    return (
      <ToolContext.Provider
        value={{
          isOpen,
          setIsOpen,
          state,
          toolCallId,
          messageId,
          awaitingApproval: isPending,
        }}
      >
        <Collapsible
          className={cn('not-prose', className)}
          onOpenChange={setIsOpen}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ToolContext.Provider>
    )
  }
)

const StoreConnectedTool = (props: ToolProps) => {
  const isPending = useToolApprovalRequests((state) =>
    props.toolCallId ? Boolean(state.pending[props.toolCallId]) : false
  )
  return <ToolBody {...props} isPending={isPending} />
}

export const Tool = memo((props: ToolProps) => {
  if (props.approvalPending === undefined) {
    return <StoreConnectedTool {...props} />
  }
  const { approvalPending, ...toolProps } = props
  return <ToolBody {...toolProps} isPending={approvalPending} />
})

export type ToolHeaderProps = {
  title?: string
  state: ToolUIPart['state']
  type: ToolUIPart['type']
  className?: string
  /** Collapsed-row copy built from the real request, when the caller has it. */
  row?: TraceRowCopy
  /** Request payload used to build the row when `row` is absent. */
  input?: unknown
}

const toolStatusOf = (state: ToolUIPart['state']): TraceToolStatus => {
  if (state === 'input-streaming' || state === 'input-available')
    return 'running'
  if (state === 'output-error' || state === 'output-denied') return 'failed'
  return 'completed'
}

export const ToolHeader = memo(
  ({ className, title, state, type, row, input }: ToolHeaderProps) => {
    const { awaitingApproval } = useTool()
    const { t } = useTranslation()
    const toolName = title ?? type.split('-').slice(1).join('-')
    const copy = useMemo(
      () =>
        row ??
        describeToolRow(
          { name: toolName, input, status: toolStatusOf(state) },
          t
        ),
      [row, toolName, input, state, t]
    )

    return (
      <TraceHeader
        className={className}
        icon={
          awaitingApproval ? (
            <ShieldAlertIcon className="size-4 text-trace-status-attention" />
          ) : (
            <WrenchIcon className="size-4" />
          )
        }
        primary={copy.primary}
        secondary={copy.secondary}
        badge={
          awaitingApproval
            ? {
                status: 'attention',
                label: t('trace:permission.pending'),
                icon: ShieldAlertIcon,
              }
            : { status: copy.status, label: copy.statusLabel }
        }
      />
    )
  }
)

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = memo(
  ({ className, children, ...props }: ToolContentProps) => (
    <CollapsibleContent
      className={cn(
        'overflow-hidden text-sm outline-none duration-[160ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:animate-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className
      )}
      {...props}
    >
      <TraceDetail>{children}</TraceDetail>
    </CollapsibleContent>
  )
)

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolUIPart['input']
}

const payloadText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? undefined
  } catch {
    return undefined
  }
}

export const ToolInput = memo(
  ({ className, input, ...props }: ToolInputProps) => {
    const { t } = useTranslation()
    return (
      <div className={cn('space-y-1.5', className)} {...props}>
        <TraceSection label={t('trace:detail.input')} copy={payloadText(input)}>
          <TracePayload value={input} />
        </TraceSection>
      </div>
    )
  }
)

export const ToolApprovalActions = memo(
  ({ registry }: { registry?: ConversationContributionRegistry }) => {
    const { t } = useTranslation()
    const { toolCallId } = useTool()
    const pending = useToolApprovalRequests((s) =>
      toolCallId ? s.pending[toolCallId] : undefined
    )
    const resolveApproval = useToolApprovalRequests((s) => s.resolveApproval)
    const permissionRequest = useMemo(
      () => (pending ? toCurrentToolPermissionRequest(pending) : undefined),
      [pending]
    )

    if (!pending || !toolCallId || !permissionRequest) return null

    if (currentWindowSurface() === 'status-popup') {
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t('common:awaitingApprovalInMainWindow')}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void invoke('open_main_window')}
          >
            {t('common:openMainWindow')}
          </Button>
        </div>
      )
    }

    return (
      <PermissionPresenterHost
        request={permissionRequest}
        registry={registry}
        enableCustomPresenter
        decide={(decision) =>
          applyCurrentToolDecision(permissionRequest, decision, resolveApproval)
        }
      />
    )
  }
)

type ToolImageProps = {
  data: string
  index: number
  resolver: (input: string) => Promise<string>
}

const ToolImage = memo(({ data, index }: ToolImageProps) => {
  const { t } = useTranslation()
  // Prepare the URL - convert base64 to data URL if needed
  const [preparedUrl, setPreparedUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (data.startsWith('data:image') || data.startsWith('http')) {
      // Already a data URL or HTTP URL
      setPreparedUrl(data)
    } else {
      // Assume it's base64 encoded
      setPreparedUrl(`data:image/png;base64,${data}`)
    }
  }, [data])

  const isLoading = !preparedUrl

  if (isLoading) {
    return (
      <div className="flex justify-center">
        <div className="flex size-24 items-center justify-center rounded-md bg-muted">
          <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    )
  }

  if (!preparedUrl) {
    return null
  }

  return (
    <div key={index} className="inline-block">
      <img
        src={preparedUrl}
        alt={t('common:toolOutput')}
        className="max-w-full max-h-96 w-auto h-auto object-contain rounded-md border"
      />
    </div>
  )
})

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolUIPart['output']
  errorText: ToolUIPart['errorText']
  resolver: (input: string) => Promise<string>
  // Running count of citations from earlier tool calls in this turn, so each
  // card's numbering/anchors continue the global sequence the markers use.
  citationOffset?: number
  followOutput?: boolean
}

export const ToolOutput = memo(
  ({
    className,
    output,
    errorText,
    resolver,
    citationOffset = 0,
    followOutput = false,
    ...props
  }: ToolOutputProps) => {
    const { messageId } = useTool()
    const { t } = useTranslation()
    const outputContainer = useRef<HTMLDivElement>(null)
    const following = useRef(true)
    const [atBottom, setAtBottom] = useState(true)
    const toBottom = useCallback(() => {
      if (outputContainer.current)
        outputContainer.current.scrollTop = outputContainer.current.scrollHeight
      following.current = true
      setAtBottom(true)
    }, [])
    useEffect(() => {
      if (followOutput && following.current) toBottom()
    }, [output, followOutput, toBottom])
    const citationPayload = useMemo(
      () => (output ? parseCitationsFromToolOutput(output) : null),
      [output]
    )

    const Output = useMemo(() => {
      if (!(output || errorText)) {
        return null
      }

      if (citationPayload) {
        return (
          <Citations
            payload={citationPayload}
            anchorPrefix={messageId ? `cite-${messageId}` : undefined}
            indexOffset={citationOffset}
          />
        )
      }

      // Handle string output
      if (typeof output === 'string') {
        return (
          <div
            ref={outputContainer}
            data-testid="tool-output-scroll"
            className={tracePayloadClass}
            onScroll={
              followOutput
                ? () => {
                    const node = outputContainer.current
                    if (!node) return
                    following.current =
                      node.scrollHeight - node.scrollTop - node.clientHeight <
                      24
                    setAtBottom(following.current)
                  }
                : undefined
            }
          >
            <CodeBlock code={output} language="json" />
          </div>
        )
      }

      if (typeof output === 'object' && !isValidElement(output)) {
        // Check if output has content array (new structure: {content: [{text, type}, {data, type: image}]})
        if (
          output &&
          typeof output === 'object' &&
          'content' in output &&
          Array.isArray(output.content)
        ) {
          const content = output.content as Array<{
            type: string
            text?: string
            data?: string
            mimeType?: string
          }>

          const textItems = content.filter((item) => item.type === 'text')
          const imageItems = content.filter((item) => item.type === 'image')

          return (
            <div className="space-y-4">
              {textItems.length > 0 && (
                <div className="space-y-2">
                  {textItems.map((item, index) => (
                    <div key={index} className={tracePayloadClass}>
                      <CodeBlock code={item.text || ''} language="markdown" />
                    </div>
                  ))}
                </div>
              )}
              {imageItems.length > 0 && (
                <div className="space-y-2">
                  {imageItems.map((item, index) => (
                    <ToolImage
                      key={index}
                      data={item.data || ''}
                      index={index}
                      resolver={resolver}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        }

        // Handle old array format for backward compatibility
        if (Array.isArray(output)) {
          const hasImages = output.some(
            (item) => item?.type === 'image' && (item?.data || item?.image)
          )

          if (hasImages) {
            // Filter out images from JSON and render images separately
            const nonImageOutput = output.filter(
              (item) => item?.type !== 'image'
            )

            return (
              <div className="space-y-4">
                {nonImageOutput.length > 0 && (
                  <div className={tracePayloadClass}>
                    <CodeBlock
                      code={JSON.stringify(nonImageOutput, null, 2)}
                      language="json"
                    />
                  </div>
                )}
                {output
                  .filter(
                    (item) =>
                      item?.type === 'image' && (item?.data || item?.image?.url)
                  )
                  .map((item, index) => (
                    <ToolImage
                      key={index}
                      data={item.data ?? item.image?.url}
                      index={index}
                      resolver={resolver}
                    />
                  ))}
              </div>
            )
          }

          return (
            <div className={tracePayloadClass}>
              <CodeBlock
                code={JSON.stringify(output, null, 2)}
                language="json"
              />
            </div>
          )
        }

        // Handle regular object
        return (
          <div className={tracePayloadClass}>
            <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
          </div>
        )
      }

      return <div>{output as ReactNode}</div>
    }, [
      output,
      errorText,
      resolver,
      citationPayload,
      messageId,
      citationOffset,
      followOutput,
    ])

    if (!(output || errorText)) {
      return null
    }

    return (
      <div className={cn('space-y-2', className)} {...props}>
        <TraceSection
          label={t(errorText ? 'trace:detail.error' : 'trace:detail.output')}
        >
          <div className="overflow-hidden rounded-md">
            {errorText && (
              <div className="rounded-md bg-destructive/10 p-2 text-destructive">
                {errorText}
              </div>
            )}
            {Output}
          </div>
        </TraceSection>
        {followOutput && !atBottom && (
          <Button type="button" variant="outline" size="sm" onClick={toBottom}>
            {t('trace:detail.follow')}
          </Button>
        )}
      </div>
    )
  }
)

Tool.displayName = 'Tool'
ToolHeader.displayName = 'ToolHeader'
ToolContent.displayName = 'ToolContent'
ToolInput.displayName = 'ToolInput'
ToolOutput.displayName = 'ToolOutput'
ToolApprovalActions.displayName = 'ToolApprovalActions'
