/* eslint-disable @typescript-eslint/no-explicit-any */
import { memo, useState, useCallback, useEffect, useRef } from 'react'
import type { UIMessage, ChatStatus } from 'ai'
import { RuntimeConversationInfo } from './RuntimeConversationInfo'
import { RenderMarkdown } from './RenderMarkdown'
import { cn } from '@/lib/utils'
import { twMerge } from 'tailwind-merge'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from '@/components/ai-elements/chain-of-thought'
import {
  Tool,
  ToolApprovalActions,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool'
import { CopyButton } from './CopyButton'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatDate } from '@/utils/formatDate'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useMessageErrors } from '@/stores/message-errors'
import {
  IconRefresh,
  IconPlayerPlay,
  IconPaperclip,
  IconArrowDown,
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react'
import { EditMessageDialog } from '@/containers/dialogs/EditMessageDialog'
import { DeleteMessageDialog } from '@/containers/dialogs/DeleteMessageDialog'
import TokenSpeedIndicator from '@/containers/TokenSpeedIndicator'
import { extractFilesFromPrompt, FileMetadata } from '@/lib/fileMetadata'
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { PromptProgress } from '@/components/PromptProgress'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { parseCitationsFromToolOutput } from '@/lib/citation-parser'
import type { RagCitation, WebCitation } from '@/components/Citations'
import { useGroundingStore } from '@/stores/grounding-store'
import { useWebCitationStore } from '@/stores/web-citation-store'
import { WebSourcesRow } from '@/components/WebSourcesRow'
import { KNOWLEDGE_BASE_NAME, type KnowledgeContext } from '@/lib/knowledge-retrieval'
import { BookOpen, Sparkles } from 'lucide-react'
import {
  skillDisplayName,
  skillLabelFromId,
  useRuntimeSkillCatalog,
} from '@/hooks/useRuntimeSkills'
import { injectCitationMarkers } from '@/lib/grounding'
import {
  RuntimeEventPart,
  type RuntimeEventPartValue,
} from '@/components/RuntimeEventPart'
import type { RuntimeCardIdentity } from '@/lib/messages'
import { TraceGroup } from '@/components/ai-elements/trace-group'
import type { TraceGroupItem } from '@/lib/trace-presentation'
import { isCardExpanded, useConversationCardState, type ConversationCardScope } from '@/stores/conversation-card-state'

// The model emits a bare "..." between two tool calls as filler (twice in one
// observed run). It is punctuation, not a sentence, so it must not become a
// paragraph of the transcript. Only assistant copy is filtered: what the reader
// typed is echoed back verbatim whatever it says.
const isFillerText = (role: string, text: string) =>
  role === 'assistant' && /^[\s.。⋯…]+$/.test(text) && text.trim().length > 0

// 同一消息引用的技能超过这个数量就折叠成 `+N`（名称放进 title），避免元数据比正文还长。
const MAX_CITED_SKILL_CHIPS = 4

const localToolStatus = (state: string): 'pending' | 'running' | 'completed' | 'failed' => {
  if (state === 'output-available') return 'completed'
  if (state === 'output-error' || state === 'output-denied') return 'failed'
  return 'running'
}

function SessionTraceGroup({ items, card, scope, isStreaming, children }: {
  items: readonly TraceGroupItem[]
  card: RuntimeCardIdentity
  scope?: ConversationCardScope
  isStreaming: boolean
  children: React.ReactNode
}) {
  const storedOpen = useConversationCardState(state => Boolean(scope && isCardExpanded(state.opened, scope, card)))
  const [localOpen, setLocalOpen] = useState(false)
  return <TraceGroup
    items={items}
    isStreaming={isStreaming}
    forceOpen={items.some(item => item.kind === 'permission' && item.pending)}
    open={scope ? storedOpen : localOpen}
    onOpenChange={value => scope ? useConversationCardState.getState().setExpanded(scope, card, value) : setLocalOpen(value)}
    className="mb-2 w-full"
  >
    {children}
  </TraceGroup>
}

function SessionReasoningCard({ parts, messageId, card, scope }: {
  parts: Array<{ text?: string; reasoning?: string; state?: string }>
  messageId: string
  card?: RuntimeCardIdentity
  scope?: ConversationCardScope
}) {
  const storedOpen = useConversationCardState(state => Boolean(scope && card && isCardExpanded(state.opened, scope, card)))
  const [localOpen, setLocalOpen] = useState(false)
  const open = scope && card ? storedOpen : localOpen
  const { t } = useTranslation()
  const content = parts.map(part => part.text ?? part.reasoning ?? '').join('')
  const streaming = parts.some(part => part.state === 'streaming')
  const container = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const toBottom = () => {
    if (container.current) container.current.scrollTop = container.current.scrollHeight
    follow.current = true
    setAtBottom(true)
  }
  useEffect(() => { if (open && follow.current) toBottom() }, [content, open])
  if (!content.trim()) return null
  return <ChainOfThought data-testid="session-reasoning-card" open={open} defaultOpen={false}
    onOpenChange={value => scope && card ? useConversationCardState.getState().setExpanded(scope, card, value) : setLocalOpen(value)}
    isStreaming={streaming} messageIsStreaming={streaming} className="w-full text-muted-foreground">
    <ChainOfThoughtHeader />
    <ChainOfThoughtContent>
      <div ref={container} className="max-h-80 overflow-auto [overflow-wrap:anywhere]" onScroll={() => {
        const node = container.current
        if (!node) return
        follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
        setAtBottom(follow.current)
      }}>
        <RenderMarkdown content={content} isStreaming={streaming} messageId={messageId} softBreaks className="cot-markdown text-sm text-main-view-fg/70" />
      </div>
      {!atBottom && <Button type="button" variant="outline" size="sm" onClick={toBottom}>{t('trace:detail.follow')}</Button>}
    </ChainOfThoughtContent>
  </ChainOfThought>
}

const CHAT_STATUS = {
  STREAMING: 'streaming',
  SUBMITTED: 'submitted',
} as const

const CONTENT_TYPE = {
  TEXT: 'text',
  FILE: 'file',
  REASONING: 'reasoning',
} as const

const isRuntimePart = (type: string) =>
  type === 'data-runtime-tool' ||
  type === 'data-runtime-permission' ||
  type === 'data-runtime-diagnostic'

const isRuntimeToolPart = (part: any) =>
  part.type === 'data-runtime-tool' &&
  (part.data?.status === 'pending' || part.data?.status === 'running')

const isRuntimePermissionPart = (part: any) =>
  part.type === 'data-runtime-permission' && part.data?.status === 'pending'

const isCotPart = (type: string) =>
  type === CONTENT_TYPE.REASONING ||
  type.startsWith('tool-') ||
  isRuntimePart(type)

export type MessageItemProps = {
  message: UIMessage
  isFirstMessage: boolean
  isLastMessage: boolean
  status: ChatStatus
  reasoningContainerRef?: React.RefObject<HTMLDivElement | null>
  isReasoningAtBottom?: boolean
  onReasoningScroll?: () => void
  onReasoningScrollToBottom?: () => void
  onRegenerate?: (messageId: string) => void
  onContinue?: (messageId: string) => void
  onEdit?: (messageId: string, newText: string) => void
  onDelete?: (messageId: string) => void
  versionInfo?: { index: number; count: number }
  onSwitchVersion?: (messageId: string, dir: -1 | 1) => void
  assistant?: { avatar?: React.ReactNode; name?: string }
  showAssistant?: boolean
  isAnimating?: boolean
  hideActions?: boolean
  /** 从搜索结果跳进来的那一条：给整条消息加一圈指示，便于在长对话里认出目标。 */
  highlighted?: boolean
}

export const MessageItem = memo(
  ({
    message,
    isFirstMessage,
    isLastMessage,
    status,
    isAnimating,
    hideActions,
    highlighted,
    reasoningContainerRef,
    isReasoningAtBottom,
    onReasoningScroll,
    onReasoningScrollToBottom,
    onRegenerate,
    onContinue,
    onEdit,
    onDelete,
    versionInfo,
    onSwitchVersion,
  }: MessageItemProps) => {
    const { t, i18n } = useTranslation()
    const selectedModel = useModelProvider((state) => state.selectedModel)
    const coloredUserBubble = useInterfaceSettings((s) => s.coloredUserBubble)
    const accentColor = useInterfaceSettings((s) => s.accentColor)
    const metadata = message.metadata as Record<string, unknown> | undefined
    // 本条消息携带的技能：标签要跟界面语言一致，所以按 id 去目录里换名字。
    const citedSkillIds = useMemo(
      () =>
        message.role !== 'user' || !Array.isArray(metadata?.citedSkillIds)
          ? []
          : (metadata?.citedSkillIds as unknown[]).filter(
              (id): id is string => typeof id === 'string' && id.length > 0
            ),
      [message.role, metadata?.citedSkillIds]
    )
    const citedSkillCatalog = useRuntimeSkillCatalog(citedSkillIds.length > 0)
    const citedSkillLabel = useCallback(
      (id: string) => {
        const skill = citedSkillCatalog.find((item) => item.id === id)
        // 目录还没回来或该技能已卸载时，退回 id 推导的标签，宁可旧名也不要空白。
        return skill ? skillDisplayName(skill, i18n.language) : skillLabelFromId(id)
      },
      [citedSkillCatalog, i18n.language]
    )
    const isRuntimeMessage =
      metadata?.runtime === 'hermes' || metadata?.runtime === 'bianbu'
    const messageError = useMessageErrors((s) => s.errors[message.id])
    const createdAt = (metadata?.createdAt as Date) ?? new Date()
    const [previewImage, setPreviewImage] = useState<{
      url: string
      filename?: string
    } | null>(null)

    const handleRegenerate = useCallback(() => {
      onRegenerate?.(message.id)
    }, [onRegenerate, message.id])

    const handleContinue = useCallback(() => {
      onContinue?.(message.id)
    }, [onContinue, message.id])

    const isStopped = metadata?.stopped === true
    const sessionTerminated = Boolean(metadata?.sessionFeed && ['completed', 'failed', 'cancelled'].includes(String(metadata.runStatus)))

    const handleEdit = useCallback(
      (newText: string) => {
        onEdit?.(message.id, newText)
      },
      [onEdit, message.id]
    )

    const handleDelete = useCallback(() => {
      onDelete?.(message.id)
    }, [onDelete, message.id])

    // Get image URLs from file parts for the edit dialog
    const imageUrls = useMemo(() => {
      return message.parts
        .filter((part) => {
          if (part.type !== 'file') return false
          const filePart = part as { type: 'file'; url?: string; mediaType?: string }
          return filePart.url && filePart.mediaType?.startsWith('image/')
        })
        .map((part) => (part as { url: string }).url)
    }, [message.parts])

    // A tool part is "pending" until it reaches a terminal state. While any
    // tool on the last assistant message is still pending the turn isn't
    // done — the model will resume once the tool result arrives, even if the
    // SDK briefly reports status as 'ready' between the tool-call stream and
    // the follow-up request.
    const hasPendingToolCall = useMemo(() => {
      if (sessionTerminated || !isLastMessage || message.role !== 'assistant') return false
      return message.parts.some((part) => {
        if (isRuntimeToolPart(part)) return true
        if (!part.type?.startsWith('tool-')) return false
        const state = (part as { state?: string }).state
        return (
          state !== 'output-available' &&
          state !== 'output-error' &&
          state !== 'output-denied'
        )
      })
    }, [sessionTerminated, isLastMessage, message.role, message.parts])

    const hasPendingRuntimePermission = useMemo(
      () => message.parts.some(isRuntimePermissionPart),
      [message.parts]
    )

    // Whether the last assistant message has any visible output yet — non-empty
    // reasoning/text, or any tool/runtime part. A warm-model reply can sit in
    // status 'streaming' for a moment before its first delta lands; while it
    // has nothing on screen we keep the "Working…" placeholder up so the second
    // question in a session still shows an in-progress indicator.
    //
    // The result is sticky per message: the reasoning part briefly disappears
    // from `message.parts` at the reasoning→text handoff (the agent closes one
    // thought id and the SDK only marks it `done`, but a transient empty window
    // makes `parts.some(...)` flick back to false for a frame). Only looking at
    // the current parts made "Working…" pop back in the instant thinking ended —
    // the Thinking↔Working flicker. Once a message has shown any output we keep
    // reporting visible until the message id changes, so "Working…" appears only
    // before the first delta.
    // Caches the last non-empty parts array seen for the current streaming
    // message. The AI SDK transiently clears message.parts to [] between
    // coalescer ticks (setStatus fires before replaceMessage, giving React a
    // render window with parts=[]). Without this guard every reasoning-delta
    // would unmount and remount the ChainOfThought card (~4ms flicker per
    // delta). Only used during streaming; cleared implicitly when message.id
    // changes (the msgId check in renderedParts won't match).
    const lastNonEmptyPartsRef = useRef<{ msgId: string; parts: any[] } | null>(null)

    const lastVisibleMessageIdRef = useRef<string | undefined>(undefined)
    const hasVisibleStreamingOutput = useMemo(() => {
      if (message.role !== 'assistant') return false
      const current = message.parts.some((part) => {
        const t = (part as { type?: string }).type ?? ''
        // A reasoning part marks that thinking has begun even while its text
        // is still empty (the reasoning-start → first-delta window). The card's
        // own "Thinking" header is already the in-progress indicator, so the
        // Working prompt must NOT also show here — that overlap is what read as
        // "Thinking and Working racing each other" on a warm second question.
        if (t === CONTENT_TYPE.REASONING) return true
        if (t === CONTENT_TYPE.TEXT) {
          return Boolean((part as { text?: string }).text?.trim())
        }
        return isCotPart(t)
      })
      if (current) {
        lastVisibleMessageIdRef.current = message.id
      }
      return current || lastVisibleMessageIdRef.current === message.id
    }, [message.parts, message.role, message.id])

    const pendingApprovals = useToolApprovalRequests((s) => s.pending)
    const awaitingApproval = useMemo(() => {
      if (!hasPendingToolCall) return false
      return message.parts.some((part) => {
        const toolCallId = (part as { toolCallId?: string }).toolCallId
        return Boolean(toolCallId && pendingApprovals[toolCallId])
      })
    }, [hasPendingToolCall, message.parts, pendingApprovals])

    const isStreaming = !sessionTerminated && (
      (isLastMessage &&
        (status === CHAT_STATUS.STREAMING ||
          status === CHAT_STATUS.SUBMITTED)) ||
      hasPendingToolCall)

    // Aggregate RAG citations in part order and record each rag tool part's
    // base offset, so its card numbers/anchors continue the same global
    // sequence the inline superscript markers use.
    const { ragCitations, citationOffsets, webCitations } = useMemo(() => {
      const out: RagCitation[] = []
      const web: WebCitation[] = []
      const offsets = new Map<number, number>()
      if (message.role === 'assistant') {
        const parts = message.parts as any[]
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]
          if (!part.type?.startsWith('tool-')) continue
          if (part.state !== 'output-available') continue
          const parsed = parseCitationsFromToolOutput(part.output)
          if (parsed?.kind === 'rag') {
            offsets.set(i, out.length)
            out.push(...parsed.citations)
          } else if (parsed?.kind === 'web') {
            web.push(...parsed.citations)
          }
        }
      }
      return { ragCitations: out, citationOffsets: offsets, webCitations: web }
    }, [message.parts, message.role])

    const serviceHub = useServiceHub()
    const grounding = useGroundingStore((s) => s.byMessageId[message.id])
    const ensureGrounding = useGroundingStore((s) => s.ensure)

    const assistantText = useMemo(() => {
      if (message.role !== 'assistant') return ''
      return (message.parts as any[])
        .filter((p) => p.type === CONTENT_TYPE.TEXT && p.text)
        .map((p) => p.text)
        .join('\n')
    }, [message.parts, message.role])

    useEffect(() => {
      if (isStreaming) return
      if (!assistantText || !ragCitations.length) return
      const rag = serviceHub.rag()
      if (!rag.embed) return
      ensureGrounding(
        message.id,
        assistantText,
        ragCitations,
        rag.embed.bind(rag)
      )
    }, [
      isStreaming,
      assistantText,
      ragCitations,
      message.id,
      ensureGrounding,
      serviceHub,
    ])

    const setWebCitations = useWebCitationStore((s) => s.setForMessage)
    useEffect(() => {
      if (!webCitations.length) return
      setWebCitations(message.id, webCitations)
    }, [webCitations, message.id, setWebCitations])

    // Extract file metadata from message text (for user messages with attachments)
    const attachedFiles = useMemo(() => {
      if (message.role !== 'user') return []

      const textParts = message.parts.filter(
        (part): part is { type: 'text'; text: string } =>
          part.type === CONTENT_TYPE.TEXT
      )

      if (textParts.length === 0) return []

      const { files } = extractFilesFromPrompt(textParts[0].text)
      return files
    }, [message.parts, message.role])

    // Get full text content for copy button
    const getFullTextContent = useCallback(() => {
      return message.parts
        .filter(
          (part): part is { type: 'text'; text: string } =>
            part.type === CONTENT_TYPE.TEXT
        )
        .map((part) => part.text)
        .join('\n')
    }, [message.parts])

    const renderTextPart = (
      part: { type: 'text'; text: string },
      partIndex: number
    ) => {
      if (!part.text || part.text.trim() === '') {
        return null
      }

      const isLastPart = partIndex === message.parts.length - 1

      // For user messages, extract and clean the text from file metadata
      const displayText =
        message.role === 'user'
          ? extractFilesFromPrompt(part.text).cleanPrompt
          : part.text

      if (
        !displayText.trim() &&
        message.role === 'user' &&
        attachedFiles.length === 0
      ) {
        return null
      }

      // Streamdown with parseIncompleteMarkdown=true treats the last line as
      // an incomplete block and skips rendering it if it has no trailing \n.
      // The first streaming delta is often a bare heading ("## Title") with no
      // newline yet, which makes the opening line invisible until the next tick.
      // Appending \n when the content doesn't already end with one tells
      // Streamdown the line is complete and safe to render immediately.
      const streamingContent =
        isStreaming && isLastPart && !part.text.endsWith('\n')
          ? part.text + '\n'
          : part.text

      return (
        <div key={`${message.id}-${partIndex}`} className="w-full">
          {message.role === 'user' ? (
            <div className="flex justify-end w-full h-full text-start wrap-break-word whitespace-normal">
              <div
                className={cn(
                  'relative p-2 rounded-md inline-block max-w-[80%]',
                  coloredUserBubble
                    ? accentColor === 'gray'
                      ? 'bg-[#A2EC69] text-black'
                      : 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-foreground'
                )}
              >
                {/* Show attached files if any */}
                {attachedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {attachedFiles.map((file: FileMetadata, idx: number) => (
                      <div
                        key={`file-${idx}-${file.id}`}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-sm bg-secondary text-secondary-foreground border text-xs"
                      >
                        <IconPaperclip
                          size={14}
                          className="text-muted-foreground"
                        />
                        <span className="font-medium">{file.name}</span>
                        {file.injectionMode && (
                          <span className="text-muted-foreground">
                            ({file.injectionMode})
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {displayText && (
                  <div dir="auto" className="select-text whitespace-pre-wrap">
                    {displayText}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <RenderMarkdown
                content={
                  grounding && !isStreaming
                    ? injectCitationMarkers(
                        part.text,
                        grounding.sentenceCitations,
                        `cite-${message.id}`
                      )
                    : streamingContent
                }
                isStreaming={isStreaming && isLastPart}
                messageId={message.id}
                isAnimating={isAnimating}
              />
            </>
          )}
        </div>
      )
    }

    const renderFilePart = (
      part: {
        type: 'file'
        filename?: string
        url?: string
        mediaType?: string
      },
      partIndex: number
    ) => {
      const isImage = part.mediaType?.startsWith('image/')
      const isAudio =
        part.mediaType === 'audio/wav' || part.mediaType === 'audio/mpeg' || (metadata?.sessionFeed && part.mediaType?.startsWith('audio/'))
      const isVideo = part.mediaType?.startsWith('video/')

      if (isAudio && part.url) {
        const justify =
          message.role === 'user' ? 'justify-end' : 'justify-start'
        return (
          <div
            key={`${message.id}-${partIndex}`}
            className={`flex ${justify} w-full my-2`}
          >
            <audio
              controls
              src={part.url}
              className="max-w-[80%] rounded-md"
            />
          </div>
        )
      }

      if (isVideo && part.url) {
        const justify =
          message.role === 'user' ? 'justify-end' : 'justify-start'
        return (
          <div
            key={`${message.id}-${partIndex}`}
            className={`flex ${justify} w-full my-2`}
          >
            <video
              controls
              src={part.url}
              className="max-w-[80%] max-h-80 rounded-md border"
            />
          </div>
        )
      }

      if (message.role === 'user' && isImage && part.url) {
        return (
          <div
            key={`${message.id}-${partIndex}`}
            className="flex justify-end w-full my-2"
          >
            <div className="flex flex-wrap gap-2 max-w-[80%] justify-end">
              <div className="relative">
                <img
                  src={part.url}
                  alt={part.filename || t('common:uploadedAttachment')}
                  className="size-20 rounded-lg object-cover border cursor-pointer"
                  onClick={() =>
                    setPreviewImage({ url: part.url!, filename: part.filename })
                  }
                />
              </div>
            </div>
          </div>
        )
      }

      if (message.role === 'assistant' && isImage && part.url) {
        return (
          <div key={`${message.id}-${partIndex}`} className="my-2">
            <img
              src={part.url}
              alt={part.filename || t('common:generatedImage')}
              className="max-w-full rounded-md cursor-pointer"
              onClick={() =>
                setPreviewImage({ url: part.url!, filename: part.filename })
              }
            />
          </div>
        )
      }

      if (metadata?.sessionFeed && part.url && /^https?:\/\//i.test(part.url)) {
        return <a key={`${message.id}-${partIndex}`} href={part.url} target="_blank" rel="noopener noreferrer" className="my-2 block underline" aria-label={t('chat:openFile', { name: part.filename || t('chat:downloadArtifact') })}>{part.filename || t('chat:downloadArtifact')}</a>
      }
      return null
    }

    const renderToolInline = (part: any, partIndex: number) => {
      if (isRuntimePart(part.type)) {
        return (
          <RuntimeEventPart
            key={`${message.id}-${partIndex}`}
            part={part as RuntimeEventPartValue}
            messageId={message.id}
            sessionFeed={Boolean(metadata?.sessionFeed)}
            scope={metadata?.conversationCardScope as ConversationCardScope | undefined}
            card={(metadata?.conversationCards as (RuntimeCardIdentity | undefined)[] | undefined)?.[partIndex]}
          />
        )
      }

      if (!part.type.startsWith('tool-') || !('state' in part)) {
        return null
      }

      const toolName = part.type.split('-').slice(1).join('-')
      // Start expanded while the tool is running so the user sees progress;
      // the Tool component auto-collapses to a summary row on completion
      // (unless the user manually toggled it open).
      const toolIsRunning =
        part.state === 'input-streaming' || part.state === 'input-available'
      return (
        <Tool
          key={`${message.id}-${partIndex}`}
          state={part.state}
          toolCallId={part.toolCallId}
          messageId={message.id}
          className="mb-1"
          defaultOpen={toolIsRunning}
        >
          <ToolHeader
            title={toolName}
            type={`tool-${toolName}` as `tool-${string}`}
            state={part.state}
          />
          <ToolContent title={toolName}>
            {part.input && <ToolInput input={part.input} />}
            <ToolApprovalActions />
            {part.output && (
              <ToolOutput
                output={part.output}
                resolver={(input) => Promise.resolve(input)}
                errorText={undefined}
                citationOffset={citationOffsets.get(partIndex) ?? 0}
              />
            )}
            {part.state === 'output-error' && (
              <ToolOutput
                output={undefined}
                errorText={part.error || part.errorText || t('common:toolExecutionFailed')}
                resolver={(input) => Promise.resolve(input)}
              />
            )}
          </ToolContent>
        </Tool>
      )
    }

    const renderWorkTimelineCard = (
      workParts: Array<{ part: any; index: number }>,
      hasAnswer: boolean
    ) => {
      const hasDisplayableContent = workParts.some(({ part }) =>
        part.type === CONTENT_TYPE.REASONING
          ? Boolean((part.text ?? part.reasoning ?? '').trim())
          : true
      )
      let lastReasoningIndex = -1
      for (let index = workParts.length - 1; index >= 0; index--) {
        if (workParts[index].part.type === CONTENT_TYPE.REASONING) {
          lastReasoningIndex = index
          break
        }
      }
      const shouldCollapse = !isStreaming && (!hasDisplayableContent || hasAnswer)

      return (
        <ChainOfThought
          key={`${message.id}-work-timeline-${workParts[0]?.index ?? 0}`}
          className="w-full text-muted-foreground"
          isStreaming={isStreaming}
          messageIsStreaming={isStreaming}
          shouldCollapse={shouldCollapse}
          defaultOpen={isStreaming || hasDisplayableContent}
        >
          <ChainOfThoughtHeader />
          <ChainOfThoughtContent>
            <div className="relative">
              <div
                ref={reasoningContainerRef}
                onScroll={onReasoningScroll}
                className={twMerge(
                  'w-full overflow-auto relative',
                  '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden'
                )}
              >
                {workParts.map(({ part, index }, workIndex) => {
                  if (part.type === CONTENT_TYPE.REASONING) {
                    const text = (part.text ?? part.reasoning ?? '') as string
                    if (!text.trim()) return null
                    return (
                      <RenderMarkdown
                        key={`${message.id}-reasoning-${index}`}
                        content={text}
                        isStreaming={
                          isStreaming &&
                          workIndex === lastReasoningIndex &&
                          workIndex === workParts.length - 1
                        }
                        messageId={message.id}
                        softBreaks
                        className="cot-markdown text-sm text-main-view-fg/70"
                      />
                    )
                  }
                  return renderToolInline(part, index)
                })}
              </div>
              {isStreaming && !isReasoningAtBottom && (
                <Button
                  className="absolute bottom-2 left-[50%] translate-x-[-50%] rounded-full size-7 z-10"
                  onClick={onReasoningScrollToBottom}
                  size="icon"
                  type="button"
                  variant="outline"
                >
                  <IconArrowDown className="size-3" />
                </Button>
              )}
            </div>
          </ChainOfThoughtContent>
        </ChainOfThought>
      )
    }

    const renderedParts = useMemo(() => {
      const rawParts = message.parts as any[]
      // Guard against the AI SDK transiently clearing message.parts to [] between
      // coalescer ticks. Each reasoning-delta write causes setStatus("streaming")
      // to fire before replaceMessage, giving React a render window where parts=[].
      // Without this guard every delta unmounts and remounts the ChainOfThought card.
      let index = 0
      let parts: any[]
      if (isStreaming && rawParts.length === 0 && lastNonEmptyPartsRef.current?.msgId === message.id) {
        parts = lastNonEmptyPartsRef.current.parts.filter(
          (part) => part.type !== 'data-runtime-permission'
        )
      } else {
        parts = rawParts
        if (rawParts.length > 0) {
          lastNonEmptyPartsRef.current = { msgId: message.id, parts: rawParts }
        }
      }
      const elements: React.ReactNode[] = []
      const cards = metadata?.conversationCards as
        | (RuntimeCardIdentity | undefined)[]
        | undefined
      const cardScope = metadata?.conversationCardScope as
        | ConversationCardScope
        | undefined

      // Runtime session feed: one group card per run of consecutive work items,
      // so a turn with eight tool calls reads as a single trace with one rail
      // instead of eight indented rows (D2). A segment ends where the answer
      // lane resumes, and a lone item is rendered as itself rather than as a
      // group of one.
      if (metadata?.sessionFeed) {
        while (index < parts.length) {
          const type = parts[index].type as string
          if (!isCotPart(type)) {
            const part = parts[index]
            if (type === CONTENT_TYPE.TEXT) {
              if (part.text && part.text.trim() !== '' && !isFillerText(message.role, part.text))
                elements.push(renderTextPart(part, index))
            } else if (type === CONTENT_TYPE.FILE) {
              elements.push(renderFilePart(part as any, index))
            }
            index++
            continue
          }

          const rows: React.ReactNode[] = []
          const summary: TraceGroupItem[] = []
          const sourceSeqs: number[] = []
          const groupStart = index
          while (index < parts.length && isCotPart(parts[index].type as string)) {
            const current = parts[index]
            const currentType = current.type as string
            const partCard = cards?.[index]
            if (partCard) sourceSeqs.push(...partCard.sourceSeqs)
            if (isRuntimePart(currentType)) {
              rows.push(renderToolInline(current, index))
              summary.push(
                currentType === 'data-runtime-permission'
                  ? { kind: 'permission', pending: current.data?.status === 'pending' }
                  : currentType === 'data-runtime-diagnostic'
                    ? { kind: 'diagnostic' }
                    : {
                        kind: 'tool',
                        name: current.data?.name ?? '',
                        input: current.data?.input,
                        error: current.data?.error,
                        status: current.data?.status ?? 'running',
                      }
              )
            } else if (currentType.startsWith('tool-')) {
              rows.push(renderToolInline(current, index))
              summary.push({
                kind: 'tool',
                name: currentType.split('-').slice(1).join('-'),
                input: current.input,
                error: current.error ?? current.errorText,
                status: localToolStatus((current.state as string) ?? 'input-streaming'),
              })
            } else {
              // Distinct source cards stay distinct even when message.end has no UI part.
              const card = partCard
              const segment = [current]
              while (
                index + 1 < parts.length &&
                parts[index + 1].type === CONTENT_TYPE.REASONING &&
                !cards?.[index + 1]
              ) {
                index++
                segment.push(parts[index])
              }
              // A segment with no text renders nothing, so it must not be
              // counted either: the collapsed summary reported "5 steps" for a
              // card that opened to three rows, because the model emits a bare
              // "\n\n" reasoning delta between two tool calls.
              const segmentText = segment
                .map(item => item.text ?? item.reasoning ?? '')
                .join('')
              if (segmentText.trim()) {
                rows.push(
                  <SessionReasoningCard
                    // Deliberately not keyed on sourceSeqs: every delta appends to
                    // them, and a new key would remount the card and reset the
                    // reader's scroll position.
                    key={card ? JSON.stringify([card.runId, card.kind, card.id]) : `${message.id}-reasoning-${index}`}
                    parts={segment}
                    messageId={message.id}
                    card={card}
                    scope={cardScope}
                  />
                )
                summary.push({
                  kind: 'reasoning',
                  streaming: segment.some(item => item.state === 'streaming'),
                })
              }
            }
            index++
          }

          const runId =
            cards?.[groupStart]?.runId ?? (metadata?.runId as string | undefined)
          const groupCard =
            rows.length > 1 && runId && sourceSeqs.length
              ? {
                  kind: 'group' as const,
                  runId,
                  id: `${runId}:${sourceSeqs[0]}`,
                  sourceSeqs,
                }
              : undefined
          if (groupCard) {
            // A stopped run can leave a tool at `pending` forever; only a run
            // that is still streaming may claim the group is working.
            const active = summary.some(item =>
              item.kind === 'reasoning'
                ? item.streaming
                : item.kind === 'tool' && (item.status === 'running' || item.status === 'pending')
            )
            elements.push(
              <SessionTraceGroup
                key={groupCard.id}
                items={summary}
                card={groupCard}
                scope={cardScope}
                isStreaming={Boolean(isStreaming && active)}
              >
                {rows}
              </SessionTraceGroup>
            )
          } else {
            elements.push(...rows)
          }
        }
        return elements
      }

      const workParts = parts
        .map((part, index) => ({ part, index }))
        .filter(({ part }) => isCotPart(part.type as string))
      const hasAnswer = parts.some(
        (part) =>
          part.type === CONTENT_TYPE.TEXT &&
          typeof part.text === 'string' &&
          part.text.trim() &&
          !isFillerText(message.role, part.text)
      )
      if (workParts.length) {
        elements.push(renderWorkTimelineCard(workParts, hasAnswer))
      }

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const t = part.type as string
        if (isCotPart(t)) continue
        if (t === CONTENT_TYPE.TEXT) {
          if (!part.text || part.text.trim() === '') continue
          if (isFillerText(message.role, part.text)) continue
          elements.push(
            renderTextPart(part as { type: 'text'; text: string }, i)
          )
          continue
        }
        if (t === CONTENT_TYPE.FILE) {
          elements.push(renderFilePart(part as any, i))
          continue
        }
      }
      return elements
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      message.parts,
      message.id,
      metadata?.conversationCards,
      metadata?.conversationCardScope,
      isStreaming,
      isReasoningAtBottom,
      grounding,
    ])

    const versionNav =
      versionInfo && versionInfo.count > 1 && onSwitchVersion ? (
        <div className="flex items-center gap-0.5 text-muted-foreground">
          <button
            type="button"
            className="hover:text-foreground disabled:opacity-40"
            disabled={versionInfo.index <= 1}
            onClick={() => onSwitchVersion(message.id, -1)}
            title={t('chat:previousVersion')}
          >
            <IconChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionInfo.index}/{versionInfo.count}
          </span>
          <button
            type="button"
            className="hover:text-foreground disabled:opacity-40"
            disabled={versionInfo.index >= versionInfo.count}
            onClick={() => onSwitchVersion(message.id, 1)}
            title={t('chat:nextVersion')}
          >
            <IconChevronRight size={14} />
          </button>
        </div>
      ) : null

    return (
      <div
        // 浮窗窗面靠这个属性给助手回答加实色气泡（见 index.css 的磨砂段落）：
        // 磨砂只做卡片背景，气泡压在它上面，背后内容才透不进正文。
        data-message-role={message.role}
        className={cn(
          'w-full mb-4 group/message',
          message.role === 'user' && !isFirstMessage && 'mt-8',
          highlighted && 'rounded-2xl ring-2 ring-primary/40 bg-primary/5'
        )}
      >

        {/* Render message parts */}
        {renderedParts}
        <RuntimeConversationInfo metadata={metadata} />

        {/* Skills this message was sent with */}
        {(() => {
          if (citedSkillIds.length === 0) return null
          const shown = citedSkillIds.slice(0, MAX_CITED_SKILL_CHIPS)
          const rest = citedSkillIds.slice(MAX_CITED_SKILL_CHIPS)
          return (
            <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5" data-testid="cited-skill-chips">
              <span className="text-[11px] text-muted-foreground">{t('chat:citedSkillsLabel')}</span>
              {shown.map(id => (
                <span
                  key={id}
                  data-testid={`cited-skill-chip-${id}`}
                  title={citedSkillLabel(id)}
                  className="flex max-w-48 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  <Sparkles size={10} aria-hidden className="shrink-0" />
                  <span className="truncate">{citedSkillLabel(id)}</span>
                </span>
              ))}
              {rest.length > 0 && (
                <span
                  data-testid="cited-skill-overflow"
                  title={rest.map(citedSkillLabel).join('、')}
                  className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  <span aria-hidden>+{rest.length}</span>
                  <span className="sr-only">{t('chat:citedSkillsMore', { count: rest.length, names: rest.map(citedSkillLabel).join('、') })}</span>
                </span>
              )}
            </div>
          )
        })()}

        {/* Knowledge context for user messages */}
        {(() => {
          const knowledgeRetrieving = metadata?.knowledgeRetrieving as boolean | undefined
          const knowledgeContext = metadata?.knowledgeContext as KnowledgeContext | undefined

          if (knowledgeRetrieving) {
            return (
              <div className={cn("mt-2 flex", message.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className="max-w-[80%] rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <div className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    <span role="status">{t('chat:knowledgeRetrieving', { name: KNOWLEDGE_BASE_NAME })}</span>
                  </div>
                </div>
              </div>
            )
          }

          if (!knowledgeContext) return null

          if (knowledgeContext.status === 'succeeded' && knowledgeContext.chunks.length > 0) {
            return (
              <div className={cn("mt-2 flex", message.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className="max-w-[80%] rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs">
                  <details className="cursor-pointer">
                    <summary className="select-none font-medium text-foreground/80">
                      <BookOpen size={14} aria-hidden className="mr-1 inline align-[-2px]" />
                      {t('chat:knowledgeReferenceCount', { count: knowledgeContext.chunks.length, name: KNOWLEDGE_BASE_NAME })}
                    </summary>
                    <div className="mt-2 space-y-2">
                      <p className="text-muted-foreground">{t('chat:knowledgeProvidedNotice')}</p>
                      {knowledgeContext.chunks.map((chunk, i) => (
                        <div key={chunk.id} className="border-l-2 border-primary/30 pl-2 text-[11px]">
                          <div className="font-medium text-foreground/70">
                            {i + 1}. {chunk.documentName}
                          </div>
                          <div className="mt-0.5 text-muted-foreground">
                            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed">{chunk.content}</p>
                            {chunk.url && /^https?:\/\//i.test(chunk.url) && (() => { try { const url = new URL(chunk.url); return !url.username && !url.password } catch { return false } })() && (
                              <>
                                {' · '}
                                <a
                                  href={chunk.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                >
                                  {t('chat:viewSource')}
                                </a>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              </div>
            )
          }

          if (knowledgeContext.status === 'empty') {
            return (
              <div className={cn("mt-2 flex", message.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className="max-w-[80%] rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  ℹ️ {t('chat:knowledgeEmpty', { name: KNOWLEDGE_BASE_NAME })}
                </div>
              </div>
            )
          }

          return null
        })()}

        {message.role === 'assistant' && !isStreaming && webCitations.length > 0 && (
          <WebSourcesRow citations={webCitations} />
        )}

        {isLastMessage &&
          message.role === 'assistant' &&
          !awaitingApproval &&
          !hasPendingRuntimePermission &&
          (hasPendingToolCall ||
            ((status === CHAT_STATUS.SUBMITTED ||
              status === CHAT_STATUS.STREAMING) &&
              !hasVisibleStreamingOutput)) && (
            <div className="mt-2">
              <PromptProgress hideIdle={hasPendingToolCall} />
            </div>
          )}

        {typeof messageError === 'string' && messageError.length > 0 && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
            <IconAlertTriangle
              size={16}
              className="mt-0.5 shrink-0 text-destructive"
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-destructive">
                {t('chat:generationFailed')}
              </div>
              <div className="text-muted-foreground break-words">
                {messageError}
              </div>
            </div>
            {(selectedModel || isRuntimeMessage) &&
              onRegenerate &&
              status !== CHAT_STATUS.STREAMING &&
              status !== CHAT_STATUS.SUBMITTED && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRegenerate}
                  className="shrink-0"
                >
                  <IconRefresh size={14} />
                  <span>{t('common:regenerate')}</span>
                </Button>
              )}
          </div>
        )}

        {/* Message actions for user messages */}
        {message.role === 'user' && !hideActions && (
          <div className="flex items-center justify-end gap-1 text-muted-foreground text-xs opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
            <span className="text-muted-foreground">
              {formatDate(createdAt)}
            </span>
            {versionNav}
            <CopyButton text={getFullTextContent()} />

            {onEdit && status !== CHAT_STATUS.STREAMING &&
              status !== CHAT_STATUS.SUBMITTED && (
              <EditMessageDialog
                disabled={!selectedModel && !isRuntimeMessage}
                message={getFullTextContent()}
                imageUrls={imageUrls.length > 0 ? imageUrls : undefined}
                onSave={handleEdit}
              />
            )}

            {onDelete && status !== CHAT_STATUS.STREAMING &&
              status !== CHAT_STATUS.SUBMITTED && (
              <DeleteMessageDialog onDelete={handleDelete} />
            )}
          </div>
        )}

        {/* Message actions for assistant messages (non-tool) */}
        {message.role === 'assistant' && (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              {!isStreaming && (
                <span className="text-muted-foreground">
                  {formatDate(createdAt)}
                </span>
              )}
              <div
                className={cn(
                  'flex items-center gap-1',
                  (isStreaming || hideActions) && 'hidden'
                )}
              >
                {versionNav}
                <CopyButton text={getFullTextContent()} />

                {onEdit && !isStreaming && (
                  <EditMessageDialog
                    disabled={!selectedModel && !isRuntimeMessage}
                    message={getFullTextContent()}
                    onSave={handleEdit}
                  />
                )}

                {onDelete && !isStreaming && (
                  <DeleteMessageDialog onDelete={handleDelete} />
                )}

                {(selectedModel || isRuntimeMessage) &&
                  onContinue &&
                  !isStreaming &&
                  isLastMessage &&
                  isStopped && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={handleContinue}
                      title={t('chat:actions.continue')}
                    >
                      <IconPlayerPlay size={16} />
                    </Button>
                  )}

                {(selectedModel || isRuntimeMessage) &&
                  onRegenerate &&
                  !isStreaming &&
                  isLastMessage && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={handleRegenerate}
                      title={t('chat:actions.regenerate')}
                    >
                      <IconRefresh size={16} />
                    </Button>
                  )}
              </div>

              {(metadata?.runtime !== 'bianbu' || !metadata?.usage || Boolean(metadata?.tokenSpeed)) && <TokenSpeedIndicator
                streaming={isStreaming}
                metadata={metadata}
              />}
            </div>
          )}

        {/* Image Preview Dialog */}
        {previewImage && (
          <div
            className="fixed inset-0 z-100 bg-black/50 backdrop-blur-md flex items-center justify-center cursor-pointer"
            onClick={() => setPreviewImage(null)}
          >
            <img
              src={previewImage.url}
              alt={previewImage.filename || 'Preview'}
              className="max-h-[90vh] max-w-[90vw] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    )
  },
  (prevProps, nextProps) => {
    // Always re-render if the last message is in-flight (streaming or submitted)
    if (
      nextProps.isLastMessage &&
      (nextProps.status === CHAT_STATUS.STREAMING ||
        nextProps.status === CHAT_STATUS.SUBMITTED)
    ) {
      return false
    }

    return (
      prevProps.message === nextProps.message &&
      prevProps.isFirstMessage === nextProps.isFirstMessage &&
      prevProps.isLastMessage === nextProps.isLastMessage &&
      prevProps.status === nextProps.status &&
      prevProps.showAssistant === nextProps.showAssistant &&
      prevProps.hideActions === nextProps.hideActions &&
      prevProps.versionInfo?.index === nextProps.versionInfo?.index &&
      prevProps.versionInfo?.count === nextProps.versionInfo?.count
    )
  }
)

MessageItem.displayName = 'MessageItem'
