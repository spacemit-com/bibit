import { useOverlayConversationStore } from '@/stores/overlay-conversation-store'
import { currentWindowSurface } from '@/lib/window-surface'
import TextareaAutosize from 'react-textarea-autosize'
import { cn, formatBytes } from '@/lib/utils'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { useCallback, useEffect, useMemo, useRef, useState, useId, useLayoutEffect, Fragment, memo } from 'react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { ArrowRight, PlusIcon, Sparkles, BookOpen, Check, ChevronDown } from 'lucide-react'
import {
  IconPhoto,
  IconMusic,
  IconVideo,
  IconTool,
  IconCodeCircle2,
  IconPlayerStopFilled,
  IconX,
  IconPaperclip,
  IconLoader2,
  IconWorldSearch,
} from '@tabler/icons-react'
import { generateId } from '@/lib/random-id'
import { useMessageQueue } from '@/stores/message-queue-store'
import { QueuedMessageChip } from '@/containers/QueuedMessageBubble'
import { RuntimeSkillPicker } from '@/containers/RuntimeSkillPicker'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { filterRuntimeSkills, skillDisplayName, skillLocalizedDescription, skillMatchedOnlyByDescription, useRuntimeSkills, type RuntimeSkill } from '@/hooks/useRuntimeSkills'
import { takeComposeSkills } from '@/lib/pendingComposeSkills'
import { slashCompletion } from '@/lib/slash-completion'
import { KNOWLEDGE_BASE_NAME, KnowledgeRetrievalError } from '@/lib/knowledge-retrieval'
import { BotIcon } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useReconcileVideoCapability } from '@/hooks/useReconcileVideoCapability'

import { useAppState } from '@/hooks/useAppState'
import { MovingBorder } from './MovingBorder'
import type { ChatStatus } from 'ai'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  TEMPORARY_CHAT_ID,
  TEMPORARY_CHAT_QUERY_ID,
  SESSION_STORAGE_KEY,
  SESSION_STORAGE_PREFIX,
} from '@/constants/chat'
import { defaultModel } from '@/lib/models'
import DropdownToolsAvailable from '@/containers/DropdownToolsAvailable'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTools } from '@/hooks/useTools'
import { TokenCounter } from '@/components/TokenCounter'
import { useMessages } from '@/hooks/useMessages'
import { useShallow } from 'zustand/react/shallow'
import { McpExtensionToolLoader } from './McpExtensionToolLoader'
import {
  ExtensionTypeEnum,
  MCPExtension,
  fs,
  VectorDBExtension,
} from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { useAttachments } from '@/hooks/useAttachments'
import { toast } from 'sonner'
import { isPlatformTauri } from '@/lib/platform/utils'
import { shouldShowTokenCounter } from '@/lib/tokenCounterVisibility'
import { useAttachmentIngestionPrompt } from '@/hooks/useAttachmentIngestionPrompt'
import {
  NEW_THREAD_ATTACHMENT_KEY,
  useChatAttachments,
} from '@/hooks/useChatAttachments'

import {
  Attachment,
  createImageAttachment,
  createDocumentAttachment,
  createAudioAttachment,
  createVideoAttachment,
} from '@/types/attachment'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { useRuntimeStore } from '@/stores/runtime-store'
import { describeRuntimeCommandError, formatRuntimeCommandError } from '@/lib/runtime-contract'
import { useRuntimeAgents } from '@/hooks/useRuntimeAgents'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { withRuntimeController } from '@/lib/runtime-controller'
import { useVoiceInputStore } from '@/stores/voice-input-store'

import { traceStartup } from '@/services/app/startup-trace'

traceStartup('mod_chat_input')

export type ChatInputFile = {
  type: string
  mediaType: string
  url: string
  resourceId?: string
}

type RuntimeAttachmentGrant = {
  grantId: string
  displayName: string
  byteLength?: number
}

type ChatInputProps = {
  className?: string
  showSpeedToken?: boolean
  model?: ThreadModel
  initialMessage?: boolean
  surface?: 'main' | 'overlay'
  onSubmit?: (
    text: string,
    files?: ChatInputFile[],
    skillIds?: string[],
    enableKnowledge?: boolean
  ) => void | { skillIds: string[] } | Promise<void | { skillIds: string[] }>
  onStop?: () => void
  chatStatus?: ChatStatus
}

// Video containers llama-server can decode via ffmpeg/ffprobe into frames.
const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']
const videoMimeForExt = (ext: string | undefined): string => {
  switch (ext) {
    case 'mov':
      return 'video/quicktime'
    case 'webm':
      return 'video/webm'
    case 'mkv':
      return 'video/x-matroska'
    case 'avi':
      return 'video/x-msvideo'
    default:
      return 'video/mp4'
  }
}

// 归因用：只记第一次挂载的 layout effect。
let chatInputMountedMarked = false

/** 专家入口的头像位：默认助手用中性色，挑中其他专家时用主题色。 */
const ExpertBadge = ({ active }: { active: boolean }) => (
  <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full', active ? 'bg-primary/15' : 'bg-muted')}>
    <BotIcon size={13} aria-hidden className={active ? 'text-primary' : 'text-muted-foreground'} />
  </span>
)

/**
 * 这个专家已经在跑该技能吗。Runtime 物化技能时分两套规则，这里必须跟着分：
 * Plugin 拥有的技能只由「Plugin 是否被选中」决定，普通技能只由自己的 selectors
 * 决定，两边通配符互不覆盖（`agents/manager.py` 的 `_select_members`）。
 * 预设技能对所有专家固定启用，永远算已经在跑。
 */
function expertRunsSkill(
  skill: RuntimeSkill,
  owned: { skills: Set<string>; plugins: Set<string> }
) {
  if (skill.preset === true) return true
  if (skill.plugin_id) return owned.plugins.has('*') || owned.plugins.has(skill.plugin_id)
  return owned.skills.has('*') || owned.skills.has(skill.id)
}

const ChatInput = memo(function ChatInput({
  className,
  initialMessage,
  surface = 'main',
  onSubmit,
  onStop,
  chatStatus,
}: ChatInputProps) {
  useLayoutEffect(() => {
    if (!chatInputMountedMarked) {
      chatInputMountedMarked = true
      traceStartup('cim_mounted')
    }
  }, [])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isFocused, setIsFocused] = useState(false)
  const [rows, setRows] = useState(1)
  const [enableKnowledge, setEnableKnowledge] = useState(false)
  const [submitBusy, setSubmitBusy] = useState(false)
  const serviceHub = useServiceHub()
  const abortControllers = useAppState((state) => state.abortControllers)
  const tools = useAppState((state) => state.tools)
  const cancelToolCall = useAppState((state) => state.cancelToolCall)
  const prompt = usePrompt((state) => state.prompt)
  const setPrompt = usePrompt((state) => state.setPrompt)
  const addToHistory = usePrompt((state) => state.addToHistory)
  const navigateHistory = usePrompt((state) => state.navigateHistory)
  const currentThreadId = useThreads((state) => state.currentThreadId)
  const currentThreadTargetId = useThreads((state) => state.currentThreadTargetId)
  // 已有会话绑定的 Agent 来自它自己的 model；首页新会话才看选择器。
  const currentThread = useThreads((state) => state.getCurrentThread())
  const { t, i18n } = useTranslation()
  const accentColor = useInterfaceSettings((state) => state.accentColor)
  const spellCheckChatInput = useGeneralSetting(
    (state) => state.spellCheckChatInput
  )
  const tokenCounterCompact = useGeneralSetting(
    (state) => state.tokenCounterCompact
  )
  const runtimeEnabled = useRuntimeStore((state) => state.enabled)
  const voiceInputMode = useVoiceInputStore((state) => state.mode)
  const runtimeId = useRuntimeStore((state) => state.runtimeId)
  const runtimeEpoch = useRuntimeStore((state) => state.runtimeEpoch)
  const sessionEvents = useRuntimeStore(
    (state) => state.enabled && state.capabilities?.sessionEvents
  )
  const runtimeAttachmentsEnabled = useRuntimeStore(
    (state) => Boolean(state.enabled && state.capabilities?.sessionAttachments)
  )
  const runtimeAttachmentReason =
    runtimeEnabled && !currentThreadId
      ? t('chat:attachmentsNeedConversation')
      : ''
  const choosingAgent = Boolean(sessionEvents && !onSubmit)
  const runtimeSkillsEnabled = useRuntimeStore(
    (state) =>
      Boolean(
        state.enabled &&
          state.capabilities?.skillSelection &&
          state.capabilities?.sessionEvents
      )
  )
  const skillsAvailable = runtimeSkillsEnabled
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  const [selectedSkills, setSelectedSkills] = useState<RuntimeSkill[]>([])
  const addSkill = useCallback((skill: RuntimeSkill) => {
    // 每次重新添加保留独立对象，使旧回执不能消费同 ID 的新选择。
    setSelectedSkills(current => current.some(item => item.id === skill.id)
      ? current : [...current, { ...skill }])
  }, [])
  const removeSkill = (id: string) => setSelectedSkills(current => current.filter(skill => skill.id !== id))
  const runtimeAgents = useRuntimeAgents(choosingAgent || skillsAvailable)
  // 插件经 `conversation.compose` 预置的临时技能：只在新会话输入框消费一次，
  // 取走即清。之后用户删掉它，与手动挑选的技能走完全一样的路径。
  const stagedComposeTargetId = runtimeAgents.targetId
  useEffect(() => {
    if (currentThreadId || !stagedComposeTargetId) return
    const staged = takeComposeSkills(stagedComposeTargetId)
    if (staged.length === 0 || !skillsAvailable) return
    setSelectedSkills(current => [
      ...current,
      ...staged
        .filter(skill => !current.some(item => item.id === skill.id))
        .map(skill => ({ ...skill })),
    ])
  }, [currentThreadId, stagedComposeTargetId, skillsAvailable])
  const agentLabel = (agent: (typeof runtimeAgents.agents)[number]) => {
    const name = agent.zhName || agent.name || agent.id
    const duplicate = runtimeAgents.agents.some(other => other.id !== agent.id && (other.zhName || other.name || other.id) === name)
    return duplicate ? `${name}（${agent.id}）` : name
  }
  const expertName = runtimeAgents.selected ? agentLabel(runtimeAgents.selected) : t('chat:selectAssistant')
  const expertTooltip = runtimeAgents.reason && runtimeAgents.reason !== t('chat:selectAssistant')
    ? runtimeAgents.reason
    : runtimeAgents.selected ? t('chat:expertCurrentTooltip', { name: expertName }) : t('chat:selectAssistantTooltip')
  const [cursor, setCursor] = useState({ text: prompt, start: prompt.length, end: prompt.length })
  const [composing, setComposing] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const slashListId = useId()
  const slashListRef = useRef<HTMLDivElement>(null)
  const token = useMemo(() => slashCompletion(prompt,
    cursor.text === prompt ? cursor.start : prompt.length,
    cursor.text === prompt ? cursor.end : prompt.length), [prompt, cursor])
  // “@”专供知识库：输入 @ 回车即启用，不与 “/” 的技能、命令补全混在一起。
  const knowledgeMention = useMemo(() => ({
    kind: 'knowledge' as const, id: 'knowledge', label: KNOWLEDGE_BASE_NAME,
    description: enableKnowledge
      ? t('chat:knowledgeEnabledHint')
      : t('chat:knowledgeDisabledHint'),
    run: () => setEnableKnowledge(true),
  }), [enableKnowledge, t])
  const knowledgeMentionMatched = Boolean(token && [KNOWLEDGE_BASE_NAME, 'knowledge', 'kb', '知识', '资料']
    .some(alias => alias.toLowerCase().includes(token.query.trim().toLowerCase())))
  const slashOpen = Boolean(token && isFocused && !composing && !skillPickerOpen &&
    slashDismissed !== prompt && (token.trigger === '@'
      ? runtimeEnabled && knowledgeMentionMatched
      : skillsAvailable))
  const skillCatalog = useRuntimeSkills(skillsAvailable && (skillPickerOpen || (slashOpen && token?.trigger === '/')))
  // 「临时使用技能」只提供这个专家还没有的技能。专家已经在跑两类技能：自己点名的
  // selectors，以及它选的 Plugin 附带的 —— Plugin 一进会话，名下 Skill 就跟着跑
  // （Tool / Skill / MCP 任意一种成员被点名，都会把它的 Plugin 拉进来，所以
  // `插件id/成员名` 的声明同样算这个 Plugin 在场）。预设技能固定启用，同样不该出现。
  const expertOwnedSelectors = useMemo(() => {
    // 已有会话继续用它创建时绑定的 Agent；首页新会话才用选择器里的 Agent。
    const threadModel = currentThread?.model
    const agentId = threadModel?.provider === 'runtime' ? threadModel.id : runtimeAgents.selected?.id
    const agent = runtimeAgents.agents.find(item => item.id === agentId)
    const skills = new Set(agent?.skills ?? [])
    const plugins = new Set(agent?.plugins ?? [])
    for (const selector of [...skills, ...(agent?.tools ?? []), ...(agent?.mcps ?? [])]) {
      const separator = selector.indexOf('/')
      if (separator > 0) plugins.add(selector.slice(0, separator))
    }
    return { skills, plugins }
  }, [currentThread?.model, runtimeAgents.agents, runtimeAgents.selected?.id])
  const temporarySkillCatalog = useMemo(() => ({
    ...skillCatalog,
    skills: skillCatalog.skills.filter(skill => !expertRunsSkill(skill, expertOwnedSelectors)),
  }), [expertOwnedSelectors, skillCatalog])
  const slashMatches = useMemo(() => slashOpen && token
    ? token.trigger === '@' ? [knowledgeMention] : filterRuntimeSkills(temporarySkillCatalog.skills, token.query).map(skill => ({
      kind: 'skill' as const, id: skill.id, label: skillDisplayName(skill, i18n.language),
      // 只命中描述的行，只看名字说不清为什么出现。
      hint: skillMatchedOnlyByDescription(skill, token.query)
        ? skillLocalizedDescription(skill, i18n.language) : '',
      skill,
    })) : [], [slashOpen, token, temporarySkillCatalog.skills, knowledgeMention, i18n.language])
  const activeSlashIndex = Math.min(slashIndex, Math.max(slashMatches.length - 1, 0))
  const activeSlashKey = slashMatches[activeSlashIndex]?.id
  useEffect(() => {
    slashListRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeSlashIndex, activeSlashKey, t])
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    const position = pendingCaret.current
    pendingCaret.current = null
    textareaRef.current?.focus()
    textareaRef.current?.setSelectionRange(position, position)
  }, [prompt, cursor])
  const replaceSlashToken = (value: string, focus = true) => {
    if (!token) return
    const next = prompt.slice(0, token.start) + value + prompt.slice(token.end)
    const position = token.start + value.length
    setPrompt(next)
    setCursor({ text: next, start: position, end: position })
    pendingCaret.current = focus ? position : null
    return next
  }
  const chooseSlashItem = (index: number) => {
    const item = slashMatches[index]
    if (!item) return
    setSlashIndex(0)
    if (item.kind === 'knowledge') {
      // 启用后清掉 @ 词，正文原样保留。
      const next = replaceSlashToken('')
      setSlashDismissed(next ?? '')
      item.run()
      return
    }
    const next = replaceSlashToken('', item.kind === 'skill')
    setSlashDismissed(next ?? '')
    if (item.kind === 'skill') addSkill(item.skill)
  }
  const submitting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const draftSnapshot = useRef({ prompt, currentThreadId, runtimeId, runtimeEpoch })
  if (
    draftSnapshot.current.prompt !== prompt ||
    draftSnapshot.current.currentThreadId !== currentThreadId ||
    draftSnapshot.current.runtimeId !== runtimeId ||
    draftSnapshot.current.runtimeEpoch !== runtimeEpoch
  ) {
    draftSnapshot.current = { prompt, currentThreadId, runtimeId, runtimeEpoch }
  }

  useTools(!runtimeEnabled)
  const router = useRouter()
  const createThread = useThreads((state) => state.createThread)

  // Agent mode
  // Use TEMPORARY_CHAT_ID as fallback key on the home screen (same pattern as attachments)
  const agentModeKey = currentThreadId ?? TEMPORARY_CHAT_ID
  const isAgentMode = useAgentMode((state) =>
    state.agentThreads[agentModeKey] === true
  )
  const effectiveAgentMode = isAgentMode
  const toggleAgentMode = useAgentMode((state) => state.toggleAgentMode)
  const webSearchEnabled = useWebSearchConfig((s) => s.webSearchEnabled)
  const setWebSearchEnabled = useWebSearchConfig((s) => s.setWebSearchEnabled)

  const handleAgentToggle = useCallback(() => {
    toggleAgentMode(agentModeKey)
  }, [agentModeKey, toggleAgentMode])

  // Get current thread messages for token counting
  const threadMessages = useMessages(
    useShallow((state) =>
      currentThreadId ? state.messages[currentThreadId] : []
    )
  )

  const maxRows = 10
  const ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES = 512 * 1024

  const selectedModel = useModelProvider((state) => state.selectedModel)
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const [message, setMessage] = useState('')
  const [dropdownToolsAvailable, setDropdownToolsAvailable] = useState(false)
  const [tooltipShown, setTooltipShown] = useState<
    'tools' | 'assistants' | false
  >(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [hasMmproj, setHasMmproj] = useState(false)
  const activeModels = useAppState(useShallow((state) => state.activeModels))
  // Check if selected model is currently loaded/active
  const isModelActive = selectedModel?.id ? activeModels.includes(selectedModel.id) : false

  // Reconcile video capability from /props once the model is loaded.
  useReconcileVideoCapability(selectedModel?.id, selectedProvider, isModelActive)

  const tokenCounterVisible = !runtimeEnabled && shouldShowTokenCounter({
    hasSelectedModel: !!selectedModel,
    isAgentMode: effectiveAgentMode,
    isInitialMessage: !!initialMessage,
    hasMessages: (threadMessages?.length ?? 0) > 0,
    hasPromptText: prompt.trim().length > 0,
  })
  const attachmentsEnabled = useAttachments((s) => s.enabled)
  const parsePreference = useAttachments((s) => s.parseMode)
  const maxFileSizeMB = useAttachments((s) => s.maxFileSizeMB)

  // Derived: any document currently processing (ingestion in progress)
  const attachmentsKey = runtimeEnabled
    ? JSON.stringify([currentThreadTargetId ?? '', currentThreadId ?? NEW_THREAD_ATTACHMENT_KEY])
    : currentThreadId ?? NEW_THREAD_ATTACHMENT_KEY
  const attachments = useChatAttachments(
    useCallback(
      (state) => state.getAttachments(attachmentsKey),
      [attachmentsKey]
    )
  )
  const setAttachmentsForThread = useChatAttachments(
    (state) => state.setAttachments
  )
  const transferAttachments = useChatAttachments(
    (state) => state.transferAttachments
  )

  const ingestingDocs = attachments.some(
    (a) => a.type === 'document' && a.processing
  )
  const ingestingAny = attachments.some((a) => a.processing)
  const hasSendableMedia = runtimeEnabled ? attachments.some(a => !!a.resourceId && !a.error && !a.processing) : attachments.some(
    (a) =>
      (a.type === 'image' || a.type === 'audio' || a.type === 'video') &&
      !!a.dataUrl
  )

  const [, setFileIngestProgress] = useState<{
    completed: number
    total: number
  } | null>(null)

  // Queued messages for this thread (shown as chips in the input area)
  const queuedMessages = useMessageQueue(
    useShallow((s) => s.getQueue(currentThreadId ?? ''))
  )
  const queueLength = queuedMessages.length

  const removeQueuedMessage = useCallback(
    (id: string) => {
      useMessageQueue.getState().removeMessage(currentThreadId ?? '', id)
    },
    [currentThreadId]
  )

  const lastTransferredThreadId = useRef<string | null>(null)

  useEffect(() => {
    if (
      !runtimeEnabled &&
      currentThreadId &&
      lastTransferredThreadId.current !== currentThreadId
    ) {
      transferAttachments(NEW_THREAD_ATTACHMENT_KEY, currentThreadId)
      lastTransferredThreadId.current = currentThreadId
    }
  }, [currentThreadId, runtimeEnabled, transferAttachments])

  // Check for mmproj existence or vision capability when model changes
  useEffect(() => {
    const checkMmprojSupport = async () => {
      if (selectedModel && selectedModel?.id) {
        try {
          // Only check mmproj for llamacpp provider
          if (selectedModel?.capabilities?.includes('vision')) {
            setHasMmproj(true)
          } else {
            setHasMmproj(false)
          }
        } catch (error) {
          console.error('Error checking mmproj:', error)
          setHasMmproj(false)
        }
      }
    }

    checkMmprojSupport()
  }, [selectedModel, selectedModel?.capabilities, selectedProvider, serviceHub])

  // Check if there are active MCP servers
  const hasActiveMCPServers =
    tools.filter((tool) => tool.server !== 'Jan Browser MCP').length > 0

  // Get MCP extension and its custom component
  const extensionManager = ExtensionManager.getInstance()
  const mcpExtension = extensionManager.get<MCPExtension>(ExtensionTypeEnum.MCP)
  const MCPToolComponent = mcpExtension?.getToolComponent?.()

  const handleSendMessage = async (prompt: string, withoutKnowledge = false) => {
    if (submitting.current) return
    if (skillsAvailable && /^\/skills?$/i.test(prompt.trim())) {
      setSkillPickerOpen(true); setPrompt(''); return
    }
    if (runtimeEnabled && !prompt.trim() && hasSendableMedia) prompt = t('chat:runtimeCommands.attachmentPrompt')
    const useKnowledge = withoutKnowledge ? false : enableKnowledge
    if (withoutKnowledge) { setEnableKnowledge(false); setMessage('') }
    if (choosingAgent && (!runtimeAgents.selected || !runtimeAgents.targetId || runtimeAgents.modelRequired)) {
      setMessage(runtimeAgents.reason || t('chat:selectAssistant'))
      return
    }
    if (!runtimeEnabled && !selectedModel) {
      setMessage(t('chat:selectModelToChat'))
      return
    }
    if (!prompt.trim() && !hasSendableMedia) {
      return
    }
    if (ingestingAny) {
      toast.info(t('chat:waitForAttachments'))
      return
    }
    if (runtimeEnabled && attachments.some((a) => a.error || !a.resourceId)) {
      setMessage(t('chat:retryFailedAttachments'))
      return
    }

    setMessage('')
    addToHistory(prompt)

    // Use onSubmit prop if available (AI SDK), otherwise create thread and navigate
    if (onSubmit) {
      if (submitting.current) return
      // When the model is still streaming, queue the message for later
      if (isStreaming && currentThreadId && !sessionEvents) {
        if (useKnowledge) { setMessage(t('chat:waitForAnswerBeforeKnowledge')); return }
        useMessageQueue.getState().enqueue(currentThreadId, {
          id: generateId(),
          text: prompt,
          createdAt: Date.now(),
        })
        setPrompt('')
        return
      }

      const imageFiles = attachments
        .filter((att) => att.type === 'image' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.mimeType ?? 'image/jpeg',
          url: att.dataUrl!,
        }))
      const audioFiles = attachments
        .filter((att) => att.type === 'audio' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav',
          url: att.dataUrl!,
        }))
      const videoFiles = attachments
        .filter((att) => att.type === 'video' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.mimeType ?? 'video/mp4',
          url: att.dataUrl!,
        }))
      const files = runtimeEnabled
        ? attachments.flatMap((attachment) => attachment.resourceId
            ? [{
                type: 'file',
                mediaType: attachment.mimeType ?? 'application/octet-stream',
                url: attachment.resourceUrl ?? '',
                resourceId: attachment.resourceId,
              }]
            : [])
        : [...imageFiles, ...audioFiles, ...videoFiles]
      const submittedResourceIds = new Set(
        files.flatMap((file) =>
          'resourceId' in file && typeof file.resourceId === 'string'
            ? [file.resourceId]
            : []
        )
      )

      const submittedSkills = new Set(selectedSkills)
      submitting.current = true
      setSubmitBusy(true)
      // 乐观清空：点发送即清空输入框，不等服务端回执；内容/知识/附件已捕获到局部，避免清空后用到空值。
      const submittedContent = prompt
      const submittedKnowledge = useKnowledge
      const submittedAttachments = attachments
      setPrompt(''); setEnableKnowledge(false)
      try {
        const receipt = onSubmit(
          submittedContent,
          files.length > 0 ? files : undefined,
          selectedSkills.length > 0
            ? selectedSkills.map((skill) => skill.id)
            : undefined,
          submittedKnowledge
        )
        const accepted = receipt ? await receipt : undefined
        const acceptedSkillIds = new Set(accepted?.skillIds ?? selectedSkills.map(skill => skill.id))
        if (mounted.current) {
          // 临时技能随消息一起消费；发送失败时保留在原处便于重发。
          setSelectedSkills(current => current.filter(skill => !submittedSkills.has(skill) || !acceptedSkillIds.has(skill.id)))
          // 附件清理统一为增量：仅清除本次发送的附件（按资源 ID / 引用），保留等待期间新增的。
          if (runtimeEnabled) {
            setAttachmentsForThread(attachmentsKey, (current) =>
              current.filter((attachment) =>
                !attachment.resourceId || !submittedResourceIds.has(attachment.resourceId)
              )
            )
          } else {
            setAttachmentsForThread(attachmentsKey, (current) =>
              current.filter((attachment) => !submittedAttachments.includes(attachment))
            )
          }
        }
      } catch (cause) {
        if (mounted.current) {
          // 知识库检索失败：回填内容与开关，供用户调整后重试；其余失败不回填，靠消息流 pending 重试。
          if (cause instanceof KnowledgeRetrievalError) {
            setPrompt(submittedContent)
            setEnableKnowledge(submittedKnowledge)
          }
          setMessage(describeRuntimeCommandError(cause))
        }
      } finally {
        submitting.current = false
        if (mounted.current) setSubmitBusy(false)
      }
    } else {
      if (submitting.current) return
      submitting.current = true
      setSubmitBusy(true)
      const overlaySubmission = currentWindowSurface() === 'voice-overlay'
      if (overlaySubmission) useOverlayConversationStore.setState(state => ({ handingOff: state.handingOff + 1 }))
      const snapshot = draftSnapshot.current
      try {
        // No onSubmit provided - create a new thread and navigate to it.
        // Media attachments (image/audio/video) are NOT serialized into
        // sessionStorage — their base64 data URLs blow past the ~5MB quota
        // (esp. video). They live in the in-memory attachments store and are
        // transferred to the new thread's key on the detail page (see the
        // transferAttachments effect); processAndSendMessage reads them there.
        const isTemporaryChat = !sessionEvents && window.location.search.includes(
          `${TEMPORARY_CHAT_QUERY_ID}=true`
        )

        const messagePayload = {
          text: prompt,
          skillIds: selectedSkills.map((skill) => skill.id),
          enableKnowledge: useKnowledge,
          files: [] as Array<{ type: string; mediaType: string; url: string }>,
        }

        if (isTemporaryChat) {
          // For temporary chat, store message and navigate to temporary thread
          sessionStorage.setItem(
            SESSION_STORAGE_KEY.INITIAL_MESSAGE_TEMPORARY,
            JSON.stringify(messagePayload)
          )
          sessionStorage.setItem('temp-chat-nav', 'true')
          // Transfer agent mode from home screen to temporary thread
          if (isAgentMode && agentModeKey !== TEMPORARY_CHAT_ID) {
            useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
            useAgentMode.getState().removeThread(agentModeKey)
          }
          router.navigate({
            to: route.threadsDetail,
            params: { threadId: TEMPORARY_CHAT_ID },
          })
        } else {
          const newThread = await createThread(
            runtimeEnabled
              ? { id: sessionEvents ? runtimeAgents.selected!.id : runtimeId ?? 'bianbu', provider: 'runtime' }
              : {
                  id: selectedModel?.id ?? defaultModel(selectedProvider),
                  provider: selectedProvider,
                },
            prompt.trim(), // 标题使用完整输入
            ...((sessionEvents ? [false, runtimeAgents.targetId] : []) as [boolean?, string?])
          )

          // Transfer agent mode from home screen to the new thread
          if (isAgentMode) {
            useAgentMode.getState().setAgentMode(newThread.id, true)
            useAgentMode.getState().removeThread(agentModeKey)
          }

          // Store the initial message for the new thread
          sessionStorage.setItem(
            `${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${newThread.id}`,
            JSON.stringify(sessionEvents ? {
              ...messagePayload,
              targetId: newThread.metadata?.targetId,
              sessionId: newThread.id,
              messageId: crypto.randomUUID(),
            } : messagePayload)
          )

          if (!mounted.current || draftSnapshot.current.runtimeEpoch !== snapshot.runtimeEpoch || draftSnapshot.current.runtimeId !== snapshot.runtimeId) return

          router.navigate({
            to: route.threadsDetail,
            params: { threadId: newThread.id },
          })
        }

        if (draftSnapshot.current === snapshot) setPrompt('')
        // Don't clear attachments here — document attachments stored under
        // NEW_THREAD_ATTACHMENT_KEY need to survive until the thread detail
        // page transfers and processes them.  The thread detail page's
        // processAndSendMessage already calls clearAttachmentsForThread after
        // processing is complete.
      } catch (cause) {
        if (mounted.current && draftSnapshot.current.runtimeEpoch === snapshot.runtimeEpoch && draftSnapshot.current.runtimeId === snapshot.runtimeId) setMessage(describeRuntimeCommandError(cause))
      } finally {
        submitting.current = false
        if (mounted.current) setSubmitBusy(false)
        if (overlaySubmission) useOverlayConversationStore.setState(state => ({ handingOff: state.handingOff - 1 }))
      }
    }
  }

  useEffect(() => {
    const handleFocusIn = () => {
      if (document.activeElement === textareaRef.current) {
        setIsFocused(true)
      }
    }

    const handleFocusOut = () => {
      if (document.activeElement !== textareaRef.current) {
        setIsFocused(false)
      }
    }

    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)

    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  // 浮窗隐藏着挂载，挂载期的 focus() 落不到输入框；语音模式下输入框还是 display:none。
  // 只有键盘模式才把 DOM 焦点交给它，否则键盘事件进得了 webview（Esc、Tab 生效）却打不了字。
  useEffect(() => {
    if (surface !== 'overlay' || voiceInputMode !== 'keyboard') return
    const focusInput = () => textareaRef.current?.focus()
    focusInput()
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen('voice-overlay-opened', focusInput)
      .then(off => {
        if (disposed) off()
        else unlisten = off
      })
      .catch(() => {})
    window.addEventListener('focus', focusInput)
    return () => {
      disposed = true
      unlisten?.()
      window.removeEventListener('focus', focusInput)
    }
  }, [surface, voiceInputMode])

  // Focus when component mounts
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  useEffect(() => {
    if (tooltipShown && dropdownToolsAvailable) {
      setTooltipShown(false)
    }
  }, [dropdownToolsAvailable, tooltipShown])

  // Focus when thread changes
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [currentThreadId])

  // Focus when streaming content finishes
  const prevChatStatusRef = useRef(chatStatus)
  useEffect(() => {
    const wasSubmitted = prevChatStatusRef.current === 'submitted'
    prevChatStatusRef.current = chatStatus
    if (wasSubmitted && chatStatus !== 'submitted' && textareaRef.current) {
      // Small delay to ensure UI has updated
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 10)
    }
  }, [chatStatus])

  const stopStreaming = useCallback(
    (threadId?: string) => {
      // Use onStop prop if available (AI SDK), otherwise use legacy abort
      if (onStop) {
        onStop()
      } else if (threadId) {
        abortControllers[threadId]?.abort()
      }
      cancelToolCall?.()
    },
    [abortControllers, cancelToolCall, onStop]
  )

  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const audioSupported = !!selectedModel?.capabilities?.includes('audio')
  const videoInputRef = useRef<HTMLInputElement>(null)
  const videoSupported = !!selectedModel?.capabilities?.includes('video')

  const processNewDocumentAttachments = useCallback(
    async (docs: Attachment[]) => {
      if (!docs.length) return

      // Only collect the user's inline-vs-embeddings preference via the
      // dialog.  Actual ingestion is always deferred to send time
      // (processAttachmentsForSend inside processAndSendMessage).
      const docsNeedingPrompt = docs.filter((doc) => {
        if (doc.processed || doc.injectionMode) return false
        const preference = doc.parseMode ?? parsePreference
        return preference === 'prompt' || preference === 'auto'
      })

      if (docsNeedingPrompt.length > 0) {
        const choices = new Map<string, 'inline' | 'embeddings'>()
        for (let i = 0; i < docsNeedingPrompt.length; i++) {
          const doc = docsNeedingPrompt[i]
          const choice = await useAttachmentIngestionPrompt
            .getState()
            .showPrompt(
              doc,
              ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES,
              i,
              docsNeedingPrompt.length
            )

          if (!choice) {
            // User cancelled — remove all pending docs
            setAttachmentsForThread(attachmentsKey, (prev) =>
              prev.filter(
                (att) =>
                  !docsNeedingPrompt.some(
                    (d) => d.path && att.path && d.path === att.path
                  )
              )
            )
            return
          }

          if (doc.path) {
            choices.set(doc.path, choice)
          }
        }

        // Persist each document's chosen mode so processAttachmentsForSend
        // can pick it up at send time.
        if (choices.size > 0) {
          setAttachmentsForThread(attachmentsKey, (prev) =>
            prev.map((att) => {
              const mode = att.path ? choices.get(att.path) : undefined
              return mode ? { ...att, parseMode: mode } : att
            })
          )
        }
      }
    },
    [
      ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES,
      attachmentsKey,
      parsePreference,
      setAttachmentsForThread,
    ]
  )

  const selectRuntimeAttachment = useCallback(async (): Promise<Attachment | undefined> => {
    if (!currentThreadId || !currentThreadTargetId) return
    const grant = await invoke<RuntimeAttachmentGrant | null>('runtime_session_attachment_select', {
      sessionId: currentThreadId,
      expectedTargetId: currentThreadTargetId,
    })
    if (!grant) return
    return {
      id: grant.grantId,
      runtimeFileGrantId: grant.grantId,
      name: grant.displayName,
      size: grant.byteLength,
      fileType: grant.displayName.split('.').pop()?.toLowerCase(),
      type: 'document',
      runtime: true,
    }
  }, [currentThreadId, currentThreadTargetId])

  const uploadRuntimeAttachment = useCallback(async (attachment: Attachment) => {
    if (!currentThreadId || !currentThreadTargetId || !attachment.id) return
    let selected = attachment
    if (!selected.runtimeFileGrantId) {
      const replacement = await selectRuntimeAttachment()
      if (!replacement) return
      selected = { ...replacement, id: attachment.id }
    }
    const matches = (candidate: Attachment) => candidate.id === selected.id
    setAttachmentsForThread(attachmentsKey, previous => previous.map(candidate =>
      matches(candidate) ? { ...selected, processing: true, error: undefined } : candidate
    ))
    let uploadStarted = false
    try {
      const result = await withRuntimeController(() => {
        uploadStarted = true
        return invoke<{
        resourceId: string
        name: string
        size: number
        mimeType: string
        url: string
      }>('runtime_session_attachment_upload', {
        sessionId: currentThreadId,
        grantId: selected.runtimeFileGrantId,
        expectedTargetId: currentThreadTargetId,
      })
      })
      setAttachmentsForThread(attachmentsKey, previous => previous.map(candidate =>
        matches(candidate)
          ? {
              ...candidate,
              name: result.name,
              size: result.size,
              mimeType: result.mimeType,
              resourceId: result.resourceId,
              resourceUrl: result.url,
              processed: true,
              processing: false,
              error: undefined,
            }
          : candidate
      ))
    } catch (cause) {
      const error = formatRuntimeCommandError(cause)
      setAttachmentsForThread(attachmentsKey, previous => previous.map(candidate =>
        matches(candidate)
          ? {
              ...candidate,
              processing: false,
              processed: false,
              error,
              ...(uploadStarted ? { runtimeFileGrantId: undefined } : {}),
            }
          : candidate
      ))
      setMessage(error)
    }
  }, [attachmentsKey, currentThreadId, currentThreadTargetId, selectRuntimeAttachment, setAttachmentsForThread])

  const handleAttachDocsIngest = async () => {
    try {
      if (!runtimeEnabled && !attachmentsEnabled) {
        toast.info(t('common:toast.attachmentsDisabledInfo.description'))
        return
      }
      if (runtimeEnabled) {
        const attachment = await selectRuntimeAttachment()
        if (!attachment) return
        setAttachmentsForThread(attachmentsKey, current => [...current, attachment])
        await uploadRuntimeAttachment(attachment)
        return
      }
      const selection = await serviceHub.dialog().open({
        multiple: true,
        filters: [
          {
            name: t('common:fileCategory.documentsAndCode'),
            extensions: [
              // Documents
              'pdf',
              'docx',
              'txt',
              'md',
              'csv',
              'xlsx',
              'xls',
              'ods',
              'pptx',
              'html',
              'htm',
              // JavaScript / TypeScript
              'js',
              'mjs',
              'cjs',
              'ts',
              'mts',
              'cts',
              'jsx',
              'tsx',
              // Python
              'py',
              'pyw',
              'pyi',
              // C / C++
              'c',
              'h',
              'cpp',
              'cc',
              'cxx',
              'hpp',
              'hh',
              // Systems languages
              'rs',
              'go',
              'swift',
              'zig',
              // JVM languages
              'java',
              'kt',
              'kts',
              'scala',
              'groovy',
              // Scripting languages
              'rb',
              'php',
              'lua',
              'pl',
              'r',
              'jl',
              // .NET
              'cs',
              'fs',
              'vb',
              'xaml',
              'csproj',
              'sln',
              // CUDA
              'cu',
              'cuh',
              // Shaders
              'hlsl',
              'glsl',
              'cg',
              'shader',
              // Shell
              'sh',
              'bash',
              'zsh',
              'fish',
              'ps1',
              'bat',
              'cmd',
              'vbs',
              // More languages
              'asm',
              's',
              'm',
              'mm',
              'pas',
              'pp',
              'erl',
              'hrl',
              'ex',
              'exs',
              'clj',
              'cljs',
              'hs',
              'lhs',
              'ml',
              'mli',
              'f',
              'f90',
              // Web
              'css',
              'scss',
              'sass',
              'less',
              'vue',
              'svelte',
              'astro',
              'php',
              'asp',
              'aspx',
              'jsp',
              // Data / config formats
              'json',
              'jsonc',
              'yaml',
              'yml',
              'toml',
              'xml',
              'ini',
              'cfg',
              'conf',
              'env',
              'properties',
              'dockerfile',
              'makefile',
              'cmake',
              'lock',
              // Query / markup
              'sql',
              'graphql',
              'gql',
              'tex',
              'rst',
              'adoc',
              'textile',
              // Misc text
              'log',
              'diff',
              'patch',
              'gitignore',
            ],
          },
          {
            name: t('common:fileCategory.allFiles'),
            extensions: ['*'],
          },
        ],
      })
      if (!selection) return
      const paths = Array.isArray(selection) ? selection : [selection]
      if (!paths.length) return

      // Prepare attachments with file sizes
      const preparedAttachments: Attachment[] = []
      for (const p of paths) {
        const name = p.split(/[\\/]/).pop() || p
        const fileType = name.split('.').pop()?.toLowerCase()
        let size: number | undefined = undefined
        try {
          const stat = await fs.fileStat(p)
          size = stat?.size ? Number(stat.size) : undefined
        } catch (e) {
          console.warn('Failed to read file size for', p, e)
        }
        preparedAttachments.push(
          createDocumentAttachment({
            name,
            path: p,
            fileType,
            size,
            parseMode: parsePreference,
          })
        )
      }

      const effectiveMaxFileSizeMB = maxFileSizeMB
      const maxFileSizeBytes =
        typeof effectiveMaxFileSizeMB === 'number' && effectiveMaxFileSizeMB > 0
          ? effectiveMaxFileSizeMB * 1024 * 1024
          : undefined

      if (maxFileSizeBytes !== undefined) {
        const hasOversized = preparedAttachments.some(
          (att) => typeof att.size === 'number' && att.size > maxFileSizeBytes
        )
        if (hasOversized) {
          toast.error(t('common:errors.fileTooLarge'), {
            description: t('chat:overSizeLimitDescription', { limit: effectiveMaxFileSizeMB }),
          })
          return
        }
      }

      let duplicates: string[] = []
      let newDocAttachments: Attachment[] = []

      setAttachmentsForThread(attachmentsKey, (currentAttachments) => {
        const existingPaths = new Set(
          currentAttachments
            .filter((a) => a.type === 'document' && a.path)
            .map((a) => a.path)
        )

        duplicates = []
        newDocAttachments = []

        for (const att of preparedAttachments) {
          if (existingPaths.has(att.path)) {
            duplicates.push(att.name)
            continue
          }
          newDocAttachments.push(att)
        }

        return newDocAttachments.length > 0
          ? [...currentAttachments, ...newDocAttachments]
          : currentAttachments
      })

      if (duplicates.length > 0) {
        toast.warning(t('chat:filesAlreadyAttached'), {
          description: t('chat:alreadyAttachedDescription', { files: duplicates.join(', ') }),
        })
      }

      if (newDocAttachments.length > 0) {
        await processNewDocumentAttachments(newDocAttachments)
      }
    } catch (e) {
      console.error('Failed to attach documents:', e)
      const desc = e instanceof Error ? e.message : JSON.stringify(e)
      toast.error(t('chat:attachDocumentsFailed'), { description: desc })
    }
  }

  const handleRemoveAttachment = async (indexToRemove: number) => {
    const attachmentToRemove = attachments[indexToRemove]

    const isRuntimeAttachment =
      runtimeEnabled && attachmentToRemove?.runtime === true

    if (isRuntimeAttachment) {
      // A runtime attachment is either fully uploaded (has a resourceId) or
      // failed. When it fully uploaded we delete the backend resource; when it
      // failed there is no backend resource to clean up, so we just drop the
      // local chip. Never route this through the vector-DB document deletion.
      if (attachmentToRemove?.resourceId && currentThreadId && currentThreadTargetId) {
        try {
          await withRuntimeController(() => invoke('runtime_session_attachment_delete', {
            sessionId: currentThreadId,
            resourceId: attachmentToRemove.resourceId,
            expectedTargetId: currentThreadTargetId,
          }))
        } catch (cause) {
          setMessage(describeRuntimeCommandError(cause))
          return
        }
      } else if (attachmentToRemove?.runtimeFileGrantId && currentThreadId && currentThreadTargetId) {
        try {
          await invoke('runtime_session_attachment_discard', {
            sessionId: currentThreadId,
            grantId: attachmentToRemove.runtimeFileGrantId,
            expectedTargetId: currentThreadTargetId,
          })
        } catch (cause) {
          setMessage(describeRuntimeCommandError(cause))
          return
        }
      }
      // Fall through to drop the local chip for failed runtime attachments.
    } else if (attachmentToRemove?.id && currentThreadId) {
      try {
        if (attachmentToRemove.type === 'document') {
          const vectorDBExtension = ExtensionManager.getInstance().get(
            ExtensionTypeEnum.VectorDB
          ) as VectorDBExtension | undefined

          if (vectorDBExtension?.deleteFile) {
            await vectorDBExtension.deleteFile(
              currentThreadId,
              attachmentToRemove.id
            )
          }
        }
      } catch (error) {
        console.error('Failed to delete attachment from backend:', error)
        toast.error(t('chat:removeAttachmentFailed'), {
          description: error instanceof Error ? error.message : String(error),
        })
        return
      }
    }

    setAttachmentsForThread(attachmentsKey, (prev) =>
      prev.filter((_, index) => index !== indexToRemove)
    )
  }

  const getFileTypeFromExtension = (fileName: string): string => {
    const extension = fileName.toLowerCase().split('.').pop()
    switch (extension) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg'
      case 'png':
        return 'image/png'
      default:
        return ''
    }
  }

  const hashBase64 = async (base64: string): Promise<string> => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  const processImageFiles = useCallback(async (files: File[]) => {
    const maxSize = 10 * 1024 * 1024 // 10MB in bytes
    const oversizedFiles: string[] = []
    const invalidTypeFiles: string[] = []

    const allowedTypes = ['image/jpg', 'image/jpeg', 'image/png']
    const validFiles: File[] = []

    // First pass: validate file size and type (no duplicate check yet)
    Array.from(files).forEach((file) => {
      // Check file size
      if (file.size > maxSize) {
        oversizedFiles.push(file.name)
        return
      }

      // Get file type - use extension as fallback if MIME type is incorrect
      const detectedType = file.type || getFileTypeFromExtension(file.name)
      const actualType = getFileTypeFromExtension(file.name) || detectedType

      // Check file type - images only
      if (!allowedTypes.includes(actualType)) {
        invalidTypeFiles.push(file.name)
        return
      }

      validFiles.push(file)
    })

    // Process valid files into attachments
    const preparedFiles: Attachment[] = []
    for (const file of validFiles) {
      const detectedType = file.type || getFileTypeFromExtension(file.name)
      const actualType = getFileTypeFromExtension(file.name) || detectedType

      const reader = new FileReader()
      await new Promise<void>((resolve) => {
        reader.onload = () => {
          const result = reader.result
          if (typeof result === 'string') {
            const base64String = result.split(',')[1]
            const att = createImageAttachment({
              name: file.name,
              size: file.size,
              mimeType: actualType,
              base64: base64String,
              dataUrl: result,
            })
            preparedFiles.push(att)
          }
          resolve()
        }
        reader.readAsDataURL(file)
      })
    }

    // Compute content hashes for deduplication (allows different images with same filename)
    for (const att of preparedFiles) {
      if (att.base64) {
        att.contentHash = await hashBase64(att.base64)
      }
    }

    const duplicates: string[] = []
    const newFiles: Attachment[] = []

    const currentAttachments = useChatAttachments.getState().getAttachments(
      attachmentsKey
    )

    const existingImageHashes = new Set<string>()
    const existingImageNames = new Set<string>()
    for (const a of currentAttachments) {
      if (a.type !== 'image') continue
      if (a.contentHash) {
        existingImageHashes.add(a.contentHash)
      } else if (a.base64) {
        existingImageHashes.add(await hashBase64(a.base64))
      } else {
        existingImageNames.add(a.name)
      }
    }

    const seenHashesInBatch = new Set<string>()
    for (const att of preparedFiles) {
      const hash = att.contentHash
      const isDuplicateByContent =
        hash &&
        (existingImageHashes.has(hash) || seenHashesInBatch.has(hash))
      const isDuplicateByName =
        existingImageNames.has(att.name)
      if (isDuplicateByContent || isDuplicateByName) {
        duplicates.push(att.name)
        continue
      }
      if (hash) {
        seenHashesInBatch.add(hash)
      }
      newFiles.push(att)
    }

    setAttachmentsForThread(attachmentsKey, (prev) =>
      newFiles.length > 0 ? [...prev, ...newFiles] : prev
    )

    if (currentThreadId && newFiles.length > 0) {
      const ingestTotal = newFiles.length
      void (async () => {
        setFileIngestProgress({ completed: 0, total: ingestTotal })
        try {
          for (let i = 0; i < newFiles.length; i++) {
            const img = newFiles[i]
            const matchImg = (a: Attachment) =>
              a.type === 'image' &&
              (img.contentHash
                ? a.contentHash === img.contentHash
                : a.name === img.name)

            try {
              setAttachmentsForThread(attachmentsKey, (prev) =>
                prev.map((a) => (matchImg(a) ? { ...a, processing: true } : a))
              )

              const result = await serviceHub
                .uploads()
                .ingestImage(currentThreadId, img)

              if (result?.id) {
                setAttachmentsForThread(attachmentsKey, (prev) =>
                  prev.map((a) =>
                    matchImg(a)
                      ? {
                          ...a,
                          processing: false,
                          processed: true,
                          id: result.id,
                        }
                      : a
                  )
                )
              } else {
                throw new Error(t('chat:imageIngestNoId'))
              }
            } catch (error) {
              console.error('Failed to ingest image:', error)
              setAttachmentsForThread(attachmentsKey, (prev) =>
                prev.filter((a) => !matchImg(a))
              )
              toast.error(t('chat:imageIngestFailed', { name: img.name }), {
                description:
                  error instanceof Error ? error.message : String(error),
              })
            } finally {
              setFileIngestProgress({
                completed: i + 1,
                total: ingestTotal,
              })
            }
          }
        } finally {
          setFileIngestProgress(null)
        }
      })()
    }

    // Display validation errors
    if (duplicates.length > 0) {
      toast.warning(t('chat:imagesAlreadyAttached'), {
        description: t('chat:alreadyAttachedDescription', { files: duplicates.join(', ') }),
      })
    }

    const errors: string[] = []
    if (oversizedFiles.length > 0) {
      errors.push(
        t('chat:attachmentTooLarge', { limit: '10MB', files: oversizedFiles.join(', ') })
      )
    }

    if (invalidTypeFiles.length > 0) {
      errors.push(
        t('chat:unsupportedFileType', { files: invalidTypeFiles.join(', ') })
      )
    }

    if (errors.length > 0) {
      setMessage(errors.join(' | '))
      // Reset file input to allow re-uploading
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } else {
      setMessage('')
    }
  }, [attachmentsKey, currentThreadId, setAttachmentsForThread, serviceHub, setFileIngestProgress, t])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files

    if (files && files.length > 0) {
      void processImageFiles(Array.from(files))

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }

    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }

  const decodeAudioDuration = (dataUrl: string): Promise<number | undefined> =>
    new Promise((resolve) => {
      try {
        const audio = new Audio()
        audio.preload = 'metadata'
        audio.onloadedmetadata = () => {
          const d = audio.duration
          resolve(Number.isFinite(d) && d > 0 ? d : undefined)
        }
        audio.onerror = () => resolve(undefined)
        audio.src = dataUrl
      } catch {
        resolve(undefined)
      }
    })

  const processAudioFiles = useCallback(
    async (files: File[]) => {
      const maxBytes = 25 * 1024 * 1024
      const oversized: string[] = []
      const invalid: string[] = []
      const prepared: Attachment[] = []

      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase()
        const ext = lower.split('.').pop()
        const isWav = file.type === 'audio/wav' || file.type === 'audio/x-wav' || ext === 'wav'
        const isMp3 = file.type === 'audio/mpeg' || file.type === 'audio/mp3' || ext === 'mp3'
        if (!isWav && !isMp3) {
          invalid.push(file.name)
          continue
        }
        if (file.size > maxBytes) {
          oversized.push(file.name)
          continue
        }
        const fmt: 'wav' | 'mp3' = isWav ? 'wav' : 'mp3'
        const mimeType = fmt === 'wav' ? 'audio/wav' : 'audio/mpeg'
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const r = reader.result
            if (typeof r === 'string') resolve(r)
            else reject(new Error('read failed'))
          }
          reader.onerror = () => reject(reader.error ?? new Error('read failed'))
          reader.readAsDataURL(file)
        })
        const base64 = dataUrl.split(',')[1] ?? ''
        const durationSec = await decodeAudioDuration(dataUrl)
        prepared.push(
          createAudioAttachment({
            name: file.name,
            base64,
            dataUrl,
            mimeType,
            audioFormat: fmt,
            size: file.size,
            durationSec,
          })
        )
      }

      const current = useChatAttachments.getState().getAttachments(attachmentsKey)
      const existingNames = new Set(
        current.filter((a) => a.type === 'audio').map((a) => a.name)
      )
      const duplicates: string[] = []
      const newOnes: Attachment[] = []
      for (const att of prepared) {
        if (existingNames.has(att.name)) {
          duplicates.push(att.name)
          continue
        }
        newOnes.push(att)
      }

      if (newOnes.length > 0) {
        setAttachmentsForThread(attachmentsKey, (prev) => [...prev, ...newOnes])
      }

      if (duplicates.length > 0) {
        toast.warning(t('chat:audioAlreadyAttached'), {
          description: t('chat:alreadyAttachedDescription', { files: duplicates.join(', ') }),
        })
      }
      const errors: string[] = []
      if (oversized.length > 0) {
        errors.push(
          t('chat:attachmentTooLarge', { limit: '25MB', files: oversized.join(', ') })
        )
      }
      if (invalid.length > 0) {
        errors.push(
          t('chat:unsupportedAudioType', { files: invalid.join(', ') })
        )
      }
      if (errors.length > 0) {
        setMessage(errors.join(' | '))
        if (audioInputRef.current) audioInputRef.current.value = ''
      }
    },
    [attachmentsKey, setAttachmentsForThread, t]
  )

  const handleAudioFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      void processAudioFiles(Array.from(files))
      if (audioInputRef.current) audioInputRef.current.value = ''
    }
    if (textareaRef.current) textareaRef.current.focus()
  }

  const openAudioPicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [{ name: 'Audio', extensions: ['wav', 'mp3'] }],
        })
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files: File[] = []
          for (const path of paths) {
            try {
              const { convertFileSrc } = await import('@tauri-apps/api/core')
              const fileUrl = convertFileSrc(path)
              const response = await fetch(fileUrl)
              if (!response.ok) throw new Error(response.statusText)
              const blob = await response.blob()
              const fileName = path.split(/[\\/]/).filter(Boolean).pop() || 'audio'
              const ext = fileName.toLowerCase().split('.').pop()
              const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav'
              files.push(new File([blob], fileName, { type: mimeType }))
            } catch (error) {
              console.error('Failed to read audio file:', error)
              toast.error(t('chat:readAudioFailed'), {
                description: error instanceof Error ? error.message : String(error),
              })
            }
          }
          if (files.length > 0) await processAudioFiles(files)
        }
      } catch (error) {
        console.error('Failed to open audio dialog:', error)
      }
      if (textareaRef.current) textareaRef.current.focus()
    } else {
      audioInputRef.current?.click()
    }
  }, [serviceHub, processAudioFiles, t])

  const processVideoFiles = useCallback(
    async (files: File[]) => {
      const maxBytes = 100 * 1024 * 1024
      const oversized: string[] = []
      const invalid: string[] = []
      const prepared: Attachment[] = []

      for (const file of Array.from(files)) {
        const ext = file.name.toLowerCase().split('.').pop()
        const isVideo =
          file.type.startsWith('video/') || VIDEO_EXTS.includes(ext ?? '')
        if (!isVideo) {
          invalid.push(file.name)
          continue
        }
        if (file.size > maxBytes) {
          oversized.push(file.name)
          continue
        }
        const mimeType = file.type.startsWith('video/')
          ? file.type
          : videoMimeForExt(ext)
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const r = reader.result
            if (typeof r === 'string') resolve(r)
            else reject(new Error('read failed'))
          }
          reader.onerror = () => reject(reader.error ?? new Error('read failed'))
          reader.readAsDataURL(file)
        })
        const base64 = dataUrl.split(',')[1] ?? ''
        prepared.push(
          createVideoAttachment({
            name: file.name,
            base64,
            dataUrl,
            mimeType,
            size: file.size,
          })
        )
      }

      const current = useChatAttachments.getState().getAttachments(attachmentsKey)
      const existingNames = new Set(
        current.filter((a) => a.type === 'video').map((a) => a.name)
      )
      const duplicates: string[] = []
      const newOnes: Attachment[] = []
      for (const att of prepared) {
        if (existingNames.has(att.name)) {
          duplicates.push(att.name)
          continue
        }
        newOnes.push(att)
      }

      if (newOnes.length > 0) {
        setAttachmentsForThread(attachmentsKey, (prev) => [...prev, ...newOnes])
      }

      if (duplicates.length > 0) {
        toast.warning(t('chat:videoAlreadyAttached'), {
          description: t('chat:alreadyAttachedDescription', { files: duplicates.join(', ') }),
        })
      }
      const errors: string[] = []
      if (oversized.length > 0) {
        errors.push(
          t('chat:attachmentTooLarge', { limit: '100MB', files: oversized.join(', ') })
        )
      }
      if (invalid.length > 0) {
        errors.push(
          t('chat:unsupportedVideoType', { files: invalid.join(', ') })
        )
      }
      if (errors.length > 0) {
        setMessage(errors.join(' | '))
        if (videoInputRef.current) videoInputRef.current.value = ''
      }
    },
    [attachmentsKey, setAttachmentsForThread, t]
  )

  const handleVideoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      void processVideoFiles(Array.from(files))
      if (videoInputRef.current) videoInputRef.current.value = ''
    }
    if (textareaRef.current) textareaRef.current.focus()
  }

  const openVideoPicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [{ name: 'Video', extensions: VIDEO_EXTS }],
        })
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files: File[] = []
          for (const path of paths) {
            try {
              const { convertFileSrc } = await import('@tauri-apps/api/core')
              const fileUrl = convertFileSrc(path)
              const response = await fetch(fileUrl)
              if (!response.ok) throw new Error(response.statusText)
              const blob = await response.blob()
              const fileName = path.split(/[\\/]/).filter(Boolean).pop() || 'video'
              const ext = fileName.toLowerCase().split('.').pop()
              files.push(new File([blob], fileName, { type: videoMimeForExt(ext) }))
            } catch (error) {
              console.error('Failed to read video file:', error)
              toast.error(t('chat:readVideoFailed'), {
                description: error instanceof Error ? error.message : String(error),
              })
            }
          }
          if (files.length > 0) await processVideoFiles(files)
        }
      } catch (error) {
        console.error('Failed to open video dialog:', error)
      }
      if (textareaRef.current) textareaRef.current.focus()
    } else {
      videoInputRef.current?.click()
    }
  }, [serviceHub, processVideoFiles, t])

  // Open the image picker dialog (extracted for reuse)
  const openImagePicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [
            {
              name: 'Images',
              extensions: ['jpg', 'jpeg', 'png'],
            },
          ],
        })

        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files: File[] = []

          for (const path of paths) {
            try {
              // Use Tauri's convertFileSrc to create a valid URL for the file
              const { convertFileSrc } = await import('@tauri-apps/api/core')
              const fileUrl = convertFileSrc(path)

              // Fetch the file as blob
              const response = await fetch(fileUrl)
              if (!response.ok) {
                throw new Error(t('chat:fetchFileFailed', { status: response.statusText }))
              }

              const blob = await response.blob()
              const fileName =
                path.split(/[\\/]/).filter(Boolean).pop() || 'image'
              const ext = fileName.toLowerCase().split('.').pop()
              const mimeType =
                ext === 'png'
                  ? 'image/png'
                  : ext === 'jpg' || ext === 'jpeg'
                    ? 'image/jpeg'
                    : 'image/jpeg'

              const file = new File([blob], fileName, { type: mimeType })
              files.push(file)
            } catch (error) {
              console.error('Failed to read file:', error)
              toast.error(t('chat:readFileFailed'), {
                description:
                  error instanceof Error ? error.message : String(error),
              })
            }
          }

          if (files.length > 0) {
            await processImageFiles(files)
          }
        }
      } catch (error) {
        console.error('Failed to open file dialog:', error)
      }

      if (textareaRef.current) {
        textareaRef.current.focus()
      }
    } else {
      // Fallback to input click for web
      fileInputRef.current?.click()
    }
  }, [serviceHub, processImageFiles, t])

  const dropAcceptsAnything =
    !runtimeEnabled && (hasMmproj || audioSupported || videoSupported)

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (dropAcceptsAnything) {
      setIsDragOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set dragOver to false if we're leaving the drop zone entirely
    // In Tauri, relatedTarget can be null, so we need to handle that case
    const relatedTarget = e.relatedTarget as Node | null
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      setIsDragOver(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (dropAcceptsAnything) {
      setIsDragOver(true)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    if (!dropAcceptsAnything) return
    if (!e.dataTransfer) {
      console.warn('No dataTransfer available in drop event')
      return
    }

    const dropped = Array.from(e.dataTransfer.files ?? [])
    if (dropped.length === 0) return

    const isAudioFile = (f: File) => {
      const ext = f.name.toLowerCase().split('.').pop()
      return (
        f.type === 'audio/wav' ||
        f.type === 'audio/x-wav' ||
        f.type === 'audio/mpeg' ||
        f.type === 'audio/mp3' ||
        ext === 'wav' ||
        ext === 'mp3'
      )
    }

    const isVideoFile = (f: File) => {
      const ext = f.name.toLowerCase().split('.').pop()
      return f.type.startsWith('video/') || VIDEO_EXTS.includes(ext ?? '')
    }

    const audioOnes = audioSupported ? dropped.filter(isAudioFile) : []
    const videoOnes = videoSupported ? dropped.filter(isVideoFile) : []
    const otherOnes = dropped.filter(
      (f) => !audioOnes.includes(f) && !videoOnes.includes(f)
    )

    if (otherOnes.length > 0 && hasMmproj) {
      const dt = new DataTransfer()
      otherOnes.forEach((f) => dt.items.add(f))
      const syntheticEvent = {
        target: { files: dt.files },
      } as React.ChangeEvent<HTMLInputElement>
      handleFileChange(syntheticEvent)
    }
    if (audioOnes.length > 0) {
      void processAudioFiles(audioOnes)
    }
    if (videoOnes.length > 0) {
      void processVideoFiles(videoOnes)
    }
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    if (audioSupported) {
      const clipboardItems = e.clipboardData?.items
      if (clipboardItems && clipboardItems.length > 0) {
        const audioFiles: File[] = []
        for (const item of Array.from(clipboardItems)) {
          if (
            item.type === 'audio/wav' ||
            item.type === 'audio/x-wav' ||
            item.type === 'audio/mpeg' ||
            item.type === 'audio/mp3'
          ) {
            const f = item.getAsFile()
            if (f) audioFiles.push(f)
          }
        }
        if (audioFiles.length > 0) {
          e.preventDefault()
          await processAudioFiles(audioFiles)
          return
        }
      }
    }

    if (hasMmproj) {
      const clipboardItems = e.clipboardData?.items
      let hasProcessedImage = false

      // Try clipboardData.items first (traditional method)
      if (clipboardItems && clipboardItems.length > 0) {
        const imageItems = Array.from(clipboardItems).filter((item) =>
          item.type.startsWith('image/')
        )

        if (imageItems.length > 0) {
          e.preventDefault()

          const files: File[] = []
          let processedCount = 0

          imageItems.forEach((item) => {
            const file = item.getAsFile()
            if (file) {
              files.push(file)
            }
            processedCount++

            // When all items are processed, handle the valid files
            if (processedCount === imageItems.length) {
              if (files.length > 0) {
                const syntheticEvent = {
                  target: {
                    files: files,
                  },
                } as unknown as React.ChangeEvent<HTMLInputElement>

                handleFileChange(syntheticEvent)
                hasProcessedImage = true
              }
            }
          })

          // If we found image items but couldn't get files, fall through to modern API
          if (processedCount === imageItems.length && !hasProcessedImage) {
            // Continue to modern clipboard API fallback below
          } else {
            return // Successfully processed with traditional method
          }
        }
      }

      // Modern Clipboard API fallback (for Linux, images copied from web, etc.)
      if (
        navigator.clipboard &&
        'read' in navigator.clipboard &&
        !hasProcessedImage
      ) {
        try {
          const clipboardContents = await navigator.clipboard.read()
          const files: File[] = []

          for (const item of clipboardContents) {
            const imageTypes = item.types.filter((type) =>
              type.startsWith('image/')
            )

            for (const type of imageTypes) {
              try {
                const blob = await item.getType(type)
                // Convert blob to File with better naming
                const extension = type.split('/')[1] || 'png'
                const file = new File(
                  [blob],
                  `pasted-image-${Date.now()}.${extension}`,
                  { type }
                )
                files.push(file)
              } catch (error) {
                console.error('Error reading clipboard item:', error)
              }
            }
          }

          if (files.length > 0) {
            e.preventDefault()
            const syntheticEvent = {
              target: {
                files: files,
              },
            } as unknown as React.ChangeEvent<HTMLInputElement>

            handleFileChange(syntheticEvent)
            return
          }
        } catch (error) {
          console.error('Clipboard API access failed:', error)
        }
      }

      // If we reach here, no image was found - allow normal text pasting to continue
      console.log(
        'No image data found in clipboard, allowing normal text paste'
      )
    }
    // If hasMmproj is false or no images found, allow normal text pasting to continue
  }

  const isStreaming = chatStatus === 'submitted' || chatStatus === 'streaming'

  return (
    <div className="relative" data-surface={surface}>
      <div className="relative">
        <div
          className={cn(
            'relative p-0.5 rounded-3xl'
          )}
          data-busy={isStreaming ? 'true' : 'false'}
        >
          {/* 常驻挂载、空闲停帧：状态翻转不再卸载动画组件，避免边框随忙碌判据闪烁。 */}
          <div
            className={cn(
              'absolute inset-0 overflow-hidden rounded-3xl transition-opacity duration-200',
              isStreaming ? 'opacity-100' : 'pointer-events-none opacity-0'
            )}
            aria-hidden={!isStreaming}
          >
            <MovingBorder rx="10%" ry="10%" active={isStreaming}>
              <div
                className={cn(
                  'h-100 w-100 bg-[radial-gradient(var(--app-primary),transparent_60%)]'
                )}
              />
            </MovingBorder>
          </div>

          <div
            data-slot="composer-surface"
            className={cn(
              'relative z-20 px-0 pb-10 border rounded-3xl border-input bg-white dark:bg-input/30',
              isFocused && 'border-ring',
              isDragOver && 'border-primary'
            )}
            data-drop-zone={dropAcceptsAnything ? 'true' : undefined}
            onDragEnter={dropAcceptsAnything ? handleDragEnter : undefined}
            onDragLeave={dropAcceptsAnything ? handleDragLeave : undefined}
            onDragOver={dropAcceptsAnything ? handleDragOver : undefined}
            onDrop={dropAcceptsAnything ? handleDrop : undefined}
          >
            {slashOpen && (
              <div
                ref={slashListRef}
                id={slashListId}
                role="listbox"
                aria-label={token?.trigger === '@' ? t('chat:knowledgeBaseLabel') : t('chat:skillGroup')}
                data-testid="slash-menu"
                className="absolute bottom-full left-2 mb-2 z-30 w-80 max-w-[calc(100%-1rem)] max-h-72 overflow-y-auto rounded-xl border border-input bg-background shadow-lg"
              >
                {skillCatalog.loading && <div role="status" className="px-3 py-2 text-sm text-muted-foreground">{t('chat:loadingSkills')}</div>}
                {skillCatalog.error && <div role="alert" className="px-3 py-2 text-sm text-destructive">
                  {skillCatalog.error}
                  <button type="button" className="ml-2 underline" onMouseDown={event => event.preventDefault()} onClick={skillCatalog.refresh}>{t('chat:retry')}</button>
                </div>}
                {!skillCatalog.loading && !skillCatalog.error && slashMatches.length === 0 && <div role="status" className="px-3 py-2 text-sm text-muted-foreground">{t('chat:noMatchingSkills')}</div>}
                {slashMatches.map((item, index) => (
                  <Fragment key={`${item.kind}-${item.id}`}>
                    {slashMatches[index - 1]?.kind !== item.kind && <div className="px-3 pt-2 pb-1 text-xs text-muted-foreground">{item.kind === 'skill' ? t('chat:skillGroup') : t('chat:knowledgeBaseLabel')}</div>}
                    <button
                      id={`${slashListId}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeSlashIndex}
                      data-active={index === activeSlashIndex}
                      className={cn('flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left', index === activeSlashIndex && 'bg-accent')}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => chooseSlashItem(index)}
                      onMouseMove={() => setSlashIndex(index)}
                      data-testid={`slash-${item.kind}-${item.id}`}
                    >
                      <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                        <span className="truncate">{item.label}</span>
                        {item.kind === 'skill' && selectedSkills.some(skill => skill.id === item.id) && <span className="shrink-0 text-xs text-muted-foreground">{t('chat:skillAdded')}</span>}
                        {item.kind === 'knowledge' && enableKnowledge && <span className="shrink-0 text-xs text-muted-foreground">{t('chat:skillEnabled')}</span>}
                      </span>
                      {item.kind === 'knowledge' && <span className="line-clamp-2 text-xs text-muted-foreground">{item.description}</span>}
                      {item.kind === 'skill' && item.hint && <span className="line-clamp-2 text-xs text-muted-foreground">{item.hint}</span>}
                    </button>
                  </Fragment>
                ))}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="flex flex-col gap-2 p-2 pb-0">
                <div className="flex gap-3 items-center">
                  {attachments
                    .map((att, idx) => ({ att, idx }))
                    .map(({ att, idx }) => {
                      const isImage = att.type === 'image'
                      const isAudio = att.type === 'audio'
                      const isVideo = att.type === 'video'
                      const ext = att.fileType || att.mimeType?.split('/')[1]
                      const durLabel =
                        isAudio && typeof att.durationSec === 'number'
                          ? `${Math.floor(att.durationSec / 60)}:${Math.floor(att.durationSec % 60)
                              .toString()
                              .padStart(2, '0')}`
                          : undefined
                      return (
                        <div
                          key={`${att.type}-${idx}-${att.name}`}
                          className="relative"
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className={cn(
                                  'relative border rounded-xl size-14 overflow-hidden',
                                  'flex items-center justify-center'
                                )}
                              >
                                {isImage && att.dataUrl ? (
                                  <img
                                    className="object-cover w-full h-full"
                                    src={att.dataUrl}
                                    alt={`${att.name}`}
                                  />
                                ) : isAudio ? (
                                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                                    <IconMusic size={20} />
                                    {durLabel && (
                                      <span className="text-[10px] leading-none mt-0.5 tabular-nums opacity-70">
                                        {durLabel}
                                      </span>
                                    )}
                                  </div>
                                ) : isVideo ? (
                                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                                    <IconVideo size={20} />
                                  </div>
                                ) : (
                                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                                    <IconPaperclip size={18} />
                                    {ext && (
                                      <span className="text-[10px] leading-none mt-0.5 uppercase opacity-70">
                                        .{ext}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="text-xs">
                                <div
                                  className="font-medium truncate max-w-52"
                                  title={att.name}
                                >
                                  {att.name}
                                </div>
                                <div className="opacity-70">
                                  {isImage
                                    ? att.mimeType || 'image'
                                    : isAudio
                                      ? att.audioFormat
                                        ? `.${att.audioFormat}${durLabel ? ` · ${durLabel}` : ''}`
                                        : 'audio'
                                      : ext
                                        ? `.${ext}`
                                        : 'document'}
                                  {att.size
                                    ? ` · ${formatBytes(att.size, {
                                        decimals: (_, unit) =>
                                          unit === 'B' ? 0 : 1,
                                      })}`
                                    : ''}
                                </div>
                                {isAudio && att.dataUrl && (
                                  <audio
                                    controls
                                    src={att.dataUrl}
                                    className="mt-1 w-56"
                                  />
                                )}
                                {att.processing && <div className="mt-1">{t('chat:uploading')}</div>}
                                {att.error && (
                                  <button
                                    type="button"
                                    className="mt-1 text-destructive underline"
                                    onClick={() => void uploadRuntimeAttachment(att)}
                                  >
                                    {t('chat:uploadFailedRetry')}
                                  </button>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>

                          {/* Remove button disabled while processing - outside overflow-hidden container */}
                          {!att.processing && (
                            <div
                              className="absolute -top-1 -right-2.5 bg-destructive size-5 flex rounded-full items-center justify-center cursor-pointer"
                              onClick={() => handleRemoveAttachment(idx)}
                            >
                              <IconX
                                className="text-neutral-200"
                                size={14}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                </div>
              </div>
            )}
            {queuedMessages.length > 0 && (
              <div className="flex flex-col gap-1 px-3 pt-2 pb-0">
                {queuedMessages.map((msg) => (
                  <QueuedMessageChip
                    key={msg.id}
                    message={msg}
                    onEdit={(queued) => {
                      // Put the text back in the input for editing, remove from queue
                      setPrompt(queued.text)
                      removeQueuedMessage(queued.id)
                      textareaRef.current?.focus()
                    }}
                    onRemove={removeQueuedMessage}
                  />
                ))}
              </div>
            )}
            {selectedSkills.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2 pb-0">
                {selectedSkills.map((skill) => (
                  <span
                    key={skill.id}
                    data-testid={`skill-chip-${skill.id}`}
                    className="flex max-w-full items-center gap-1 rounded-full border border-input bg-background px-2.5 py-1 text-xs"
                  >
                    <Sparkles
                      size={11}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span
                      className="max-w-40 truncate"
                      title={skillDisplayName(skill, i18n.language)}
                    >
                      {skillDisplayName(skill, i18n.language)}
                    </span>
                    <button
                      type="button"
                      aria-label={t('chat:removeSkill', { name: skillDisplayName(skill, i18n.language) })}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => removeSkill(skill.id)}
                    >
                      <IconX size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <TextareaAutosize
              dir="auto"
              ref={textareaRef}
              minRows={2}
              rows={1}
              maxRows={10}
              value={prompt}
              data-testid={'chat-input'}
              role="combobox"
              aria-label={t('chat:messageInputLabel')}
              aria-autocomplete="list"
              aria-expanded={slashOpen}
              aria-controls={slashOpen ? slashListId : undefined}
              aria-activedescendant={slashOpen && slashMatches.length ? `${slashListId}-${activeSlashIndex}` : undefined}
              onSelect={event => {
                const input = event.currentTarget
                const next = { text: input.value, start: input.selectionStart, end: input.selectionEnd }
                setCursor(current => current.text === next.text && current.start === next.start && current.end === next.end ? current : next)
              }}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onChange={(e) => {
                setPrompt(e.target.value)
                setCursor({ text: e.target.value, start: e.target.selectionStart, end: e.target.selectionEnd })
                setSlashDismissed('')
                setSlashIndex(0)
                // Count the number of newlines to estimate rows
                const newRows = (e.target.value.match(/\n/g) || []).length + 1
                setRows(Math.min(newRows, maxRows))
              }}
              onKeyDown={(e) => {
                // e.keyCode 229 is for IME input with Safari
                const isComposing =
                  e.nativeEvent.isComposing || e.keyCode === 229
                if (slashOpen && !isComposing) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSlashIndex(
                      Math.max(0, Math.min(activeSlashIndex + 1, slashMatches.length - 1))
                    )
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSlashIndex(Math.max(activeSlashIndex - 1, 0))
                    return
                  }
                  // Only a menu that has something to choose may take the key.
                  // "/etc" and "/tmp/..." open the menu with no match, and an
                  // unconditional preventDefault turned Enter into a no-op:
                  // the message could not be sent at all until the text was
                  // edited. With no match Enter now falls through and sends.
                  if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && slashMatches.length > 0) {
                    e.preventDefault()
                    // Tab 过去只补全命令、不选中；菜单里只剩技能之后，两者是同一件事。
                    chooseSlashItem(activeSlashIndex)
                    return
                  }
                  if (e.key === 'Tab' && !e.shiftKey) {
                    e.preventDefault()
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setSlashDismissed(prompt)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
                  e.preventDefault()
                  // Submit prompt when Enter is pressed without Shift and prompt is not empty.
                  // If streaming, handleSendMessage will queue the message automatically.
                  if ((prompt.trim() || hasSendableMedia) && !ingestingAny) {
                    handleSendMessage(prompt)
                  }
                  // When Shift+Enter is pressed, a new line is added (default behavior)
                }
                // Navigate prompt history with Up/Down arrow keys
                if (e.key === 'ArrowUp' && !isComposing) {
                  const textarea = e.currentTarget
                  const cursorAtStart =
                    textarea.selectionStart === 0 &&
                    textarea.selectionEnd === 0
                  if (cursorAtStart || !prompt) {
                    e.preventDefault()
                    navigateHistory('up')
                  }
                }
                if (e.key === 'ArrowDown' && !isComposing) {
                  const textarea = e.currentTarget
                  const cursorAtEnd =
                    textarea.selectionStart === prompt.length &&
                    textarea.selectionEnd === prompt.length
                  if (cursorAtEnd) {
                    e.preventDefault()
                    navigateHistory('down')
                  }
                }
              }}
              onPaste={runtimeEnabled ? undefined : handlePaste}
              placeholder={t('common:placeholder.chatInput')}
              autoFocus
              spellCheck={spellCheckChatInput}
              data-gramm={spellCheckChatInput}
              data-gramm_editor={spellCheckChatInput}
              data-gramm_grammarly={spellCheckChatInput}
              className={cn(
                'bg-transparent pt-4 w-full shrink-0 border-none resize-none outline-0 px-4',
                rows < maxRows && 'scrollbar-hide',
                className
              )}
            />
            {submitBusy && enableKnowledge && <p role="status" className="px-4 pb-1 text-xs text-muted-foreground">{t('chat:knowledgeRetrievingHint', { name: KNOWLEDGE_BASE_NAME })}</p>}
          </div>
        </div>

        <div className="absolute z-20 bg-transparent bottom-0 w-full p-2 ">
          <div className="flex justify-between items-center w-full">
            {choosingAgent && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" data-slot="agent-trigger" aria-label={t('chat:expertTriggerAria', { name: expertName })} className={cn('group/expert relative z-20 mr-1 flex h-8 max-w-[13rem] min-w-0 cursor-pointer items-center gap-2 rounded-full border bg-muted/40 px-2 text-xs font-medium transition-colors outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent [&[data-state=open]_.expert-chevron]:rotate-180 [&[data-state=open]_.expert-chevron]:opacity-100', runtimeAgents.usingDefault ? 'border-border/60' : 'border-primary/30 bg-primary/10')} title={expertTooltip}>
                    <ExpertBadge active={!runtimeAgents.usingDefault} />
                    <span className={cn('truncate leading-normal', !runtimeAgents.selected && 'text-muted-foreground', !runtimeAgents.usingDefault && 'text-primary')}>{expertName}</span>
                    <ChevronDown size={12} aria-hidden className="expert-chevron size-3 shrink-0 text-muted-foreground opacity-0 transition group-hover/expert:opacity-100" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-64 rounded-xl p-1.5 shadow-lg">
                  <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">{t('chat:expertPickerTitle')}</div>
                  {runtimeAgents.experts.length === 0 && <p className="px-2 pb-2 text-xs text-muted-foreground">{t('chat:expertPickerEmpty')}</p>}
                  {runtimeAgents.experts.map(agent => (
                    <DropdownMenuItem key={agent.id} disabled={!agent.available && agent.unavailableReason !== 'agent_model_required'} onSelect={() => runtimeAgents.select(agent.id)} className="gap-2.5 rounded-lg px-2 py-2">
                      <ExpertBadge active={runtimeAgents.selected?.id === agent.id} />
                      <span className="flex min-w-0 flex-1 flex-col items-start">
                        <span className="w-full truncate text-[13px] font-medium leading-tight">{agentLabel(agent)}</span>
                        {!agent.available && <span className="w-full truncate text-[11px] leading-tight text-muted-foreground">{agent.unavailableReason === 'agent_model_required' ? t('chat:agentModelRequired') : agent.unavailableReason || t('common:unavailable')}</span>}
                      </span>
                      <Check aria-hidden className={cn('size-4 shrink-0 text-primary', runtimeAgents.selected?.id !== agent.id && 'invisible')} />
                    </DropdownMenuItem>
                  ))}
                  {runtimeAgents.defaultAgent && (
                    <>
                      <DropdownMenuSeparator className="my-1.5" />
                      <DropdownMenuItem disabled={runtimeAgents.usingDefault} onSelect={runtimeAgents.useDefault} className="gap-2.5 rounded-lg px-2 py-2">
                        <ExpertBadge active={runtimeAgents.usingDefault} />
                        <span className="flex min-w-0 flex-1 flex-col items-start">
                          <span className="w-full truncate text-[13px] font-medium leading-tight">{agentLabel(runtimeAgents.defaultAgent)}</span>
                          <span className="w-full truncate text-[11px] leading-tight text-muted-foreground">{t('chat:expertUseDefault')}</span>
                        </span>
                        <Check aria-hidden className={cn('size-4 shrink-0 text-primary', !runtimeAgents.usingDefault && 'invisible')} />
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator className="my-1.5" />
                  <DropdownMenuItem onSelect={runtimeAgents.refresh} className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground">{t('chat:refreshAgents')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <div className="px-1 flex items-center gap-1 flex-1 min-w-0">
              <div
                className={cn(
                  'px-1 flex items-center w-full gap-1',
                  isStreaming && 'opacity-50 pointer-events-none'
                )}
              >
                {/* Dropdown for attachments — hidden in agent mode, and for
                    Runtimes that cannot accept attachments */}
                {!effectiveAgentMode &&
                  (!runtimeEnabled || runtimeAttachmentsEnabled) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      className="rounded-full mr-2 mb-1"
                      disabled={Boolean(runtimeAttachmentReason)}
                      aria-label={runtimeAttachmentReason || t('chat:addAttachment')}
                      title={runtimeAttachmentReason || undefined}
                    >
                      <PlusIcon size={18} className="text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {!runtimeEnabled && hasMmproj && (
                      <DropdownMenuItem onClick={() => void openImagePicker()}>
                        <IconPhoto size={18} className="text-muted-foreground" />
                        <span>{t('common:addImages')}</span>
                        <input
                          type="file"
                          ref={fileInputRef}
                          className="hidden"
                          multiple
                          onChange={handleFileChange}
                        />
                      </DropdownMenuItem>
                    )}
                    {!runtimeEnabled && audioSupported && (
                      <DropdownMenuItem onClick={() => void openAudioPicker()}>
                        <IconMusic size={18} className="text-muted-foreground" />
                        <span>{t('common:addAudio')}</span>
                        <input
                          type="file"
                          ref={audioInputRef}
                          className="hidden"
                          multiple
                          accept="audio/wav,audio/mpeg,.wav,.mp3"
                          onChange={handleAudioFileChange}
                        />
                      </DropdownMenuItem>
                    )}
                    {!runtimeEnabled && videoSupported && (
                      <DropdownMenuItem onClick={() => void openVideoPicker()}>
                        <IconVideo size={18} className="text-muted-foreground" />
                        <span>{t('common:addVideo')}</span>
                        <input
                          type="file"
                          ref={videoInputRef}
                          className="hidden"
                          multiple
                          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,.mp4,.mov,.webm,.mkv,.avi,.m4v"
                          onChange={handleVideoFileChange}
                        />
                      </DropdownMenuItem>
                    )}
                    {/* RAG document attachments - desktop-only via dialog; shown when feature enabled */}
                    <DropdownMenuItem
                      onClick={handleAttachDocsIngest}
                      disabled={!runtimeEnabled && !selectedModel?.capabilities?.includes('tools')}
                    >
                      {ingestingDocs ? (
                        <IconLoader2
                          size={18}
                          className="text-muted-foreground animate-spin"
                        />
                      ) : (
                        <IconPaperclip
                          size={18}
                          className="text-muted-foreground"
                        />
                      )}
                      <span>
                        {ingestingDocs
                          ? t('chat:indexingDocuments')
                          : t('chat:addDocumentsOrFiles')}
                      </span>
                    </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {skillsAvailable && (
                  <Popover
                    open={skillPickerOpen}
                    onOpenChange={setSkillPickerOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="secondary"
                        size="icon-sm"
                        className="rounded-full mr-2 mb-1"
                        aria-label={t('chat:tempSkillLabel')}
                        title={t('chat:tempSkillTitle')}
                        data-testid="skill-picker-trigger"
                      >
                        <Sparkles
                          size={18}
                          className={cn(
                            'text-muted-foreground',
                            selectedSkills.length > 0 && 'text-primary'
                          )}
                        />
                      </Button>
                    </PopoverTrigger>
                    {skillPickerOpen && <RuntimeSkillPicker
                      selected={selectedSkills}
                      onAdd={addSkill}
                      catalog={temporarySkillCatalog}
                    />}
                  </Popover>
                )}
                {!effectiveAgentMode && selectedModel?.capabilities?.includes('embeddings') && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                          variant="ghost"
                          size="icon-xs"
                        >
                        <IconCodeCircle2
                          size={18}
                          className="text-muted-foreground"
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('embeddings')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {!effectiveAgentMode && selectedModel?.capabilities?.includes('tools') &&
                  hasActiveMCPServers &&
                  (MCPToolComponent ? (
                    // Use custom MCP component
                    <McpExtensionToolLoader
                      tools={tools}
                      hasActiveMCPServers={hasActiveMCPServers}
                      selectedModelHasTools={
                        selectedModel?.capabilities?.includes('tools') ?? false
                      }
                      MCPToolComponent={MCPToolComponent}
                    />
                  ) : (
                    // Use default tools dropdown
                    <Tooltip
                      open={tooltipShown === 'tools'}
                      onOpenChange={(newValue) => newValue ? setTooltipShown('tools') : setTooltipShown(false)}
                    >
                      <TooltipTrigger
                        asChild
                        disabled={dropdownToolsAvailable}
                      >
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={(e) => {
                            setDropdownToolsAvailable(false)
                            e.stopPropagation()
                          }}
                        >
                          <DropdownToolsAvailable
                            onOpenChange={(isOpen) => {
                              setDropdownToolsAvailable(isOpen)
                              if (isOpen) {
                                setTooltipShown(false)
                              }
                            }}
                          >
                            {() => {
                              return (
                                <div
                                  className={cn(
                                    'p-1 flex items-center justify-center rounded-sm transition-all duration-200 ease-in-out gap-1 cursor-pointer',
                                  )}
                                >
                                  <IconTool
                                    size={18}
                                    className={cn(
                                      'text-muted-foreground',
                                    )}
                                  />
                                </div>
                              )
                            }}
                          </DropdownToolsAvailable>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('tools')}</p>
                      </TooltipContent>
                    </Tooltip>
                  ))}

                {runtimeEnabled && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className={cn('rounded-sm', enableKnowledge && 'bg-primary/10 ring-1 ring-primary/40')}
                        onClick={() => setEnableKnowledge(!enableKnowledge)}
                        aria-pressed={enableKnowledge}
                        aria-label={enableKnowledge ? t('chat:knowledgeEnabledAria', { name: KNOWLEDGE_BASE_NAME }) : t('chat:enableKnowledgeAria', { name: KNOWLEDGE_BASE_NAME })}
                      >
                        <BookOpen
                          size={18}
                          aria-hidden
                          className={cn('text-muted-foreground', enableKnowledge && 'text-primary')}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{enableKnowledge ? t('chat:knowledgeInUseTooltip', { name: KNOWLEDGE_BASE_NAME }) : t('chat:enableKnowledgeAria', { name: KNOWLEDGE_BASE_NAME })}</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {runtimeEnabled && enableKnowledge && (
                  <span className="mr-1 inline-flex shrink-0 items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    {KNOWLEDGE_BASE_NAME}
                  </span>
                )}

                {/* Agent mode toggle hidden — kept as dead code for future use */}
                {false && isAgentMode && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={isAgentMode ? "default" : "ghost"}
                        size="icon-xs"
                        onClick={currentThreadId ? handleAgentToggle : undefined}
                        className={cn(
                          isAgentMode && 'text-primary bg-primary/10 hover:bg-primary/10 items-center',
                          !currentThreadId && 'cursor-default pointer-events-none'
                        )}
                      >
                        <BotIcon
                          className={cn(
                            'text-muted-foreground -mt-0.5',
                            isAgentMode && 'text-primary'
                          )}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {isAgentMode
                          ? t('chat:agentModeActive')
                          : t('chat:agentModeEnable')}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {!effectiveAgentMode && selectedModel?.capabilities?.includes('tools') && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={cn(webSearchEnabled && 'text-primary')}
                        onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                      >
                        <IconWorldSearch
                          size={18}
                          className={cn(
                            'text-muted-foreground',
                            webSearchEnabled && 'text-primary'
                          )}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {webSearchEnabled
                          ? t('common:web_search') + ' (Active)'
                          : t('common:web_search')}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                )}

              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              {tokenCounterVisible && tokenCounterCompact && (
                <div className="flex-1 flex justify-center">
                  <TokenCounter messages={threadMessages || []} compact={true} />
                </div>
              )}

              {isStreaming ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="icon-sm"
                      className="rounded-full mr-1 mb-1"
                      aria-label={queueLength > 0 ? t('chat:clearQueuedMessages', { count: queueLength }) : t('chat:stopGenerating')}
                      onClick={() => {
                        const queue = currentThreadId
                          ? useMessageQueue.getState().getQueue(currentThreadId)
                          : []
                        if (currentThreadId && queue.length > 0) {
                          useMessageQueue.getState().clearQueue(currentThreadId)
                        } else {
                          stopStreaming(currentThreadId)
                        }
                      }}
                    >
                      <IconPlayerStopFilled />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{queueLength > 0 ? t('chat:clearQueuedMessages', { count: queueLength }) : t('chat:stopGenerating')}</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Button
                  variant="default"
                  size="icon-sm"
                  disabled={submitBusy || (!prompt.trim() && !hasSendableMedia) || ingestingAny || (choosingAgent && (!runtimeAgents.selected || runtimeAgents.modelRequired))}
                  data-test-id="send-message-button"
                  onClick={() => handleSendMessage(prompt)}
                  className="rounded-full mr-1 mb-1"
                >
                  <ArrowRight
                    className={
                      accentColor === 'gray'
                        ? 'text-black'
                        : 'text-primary-foreground'
                    }
                  />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {choosingAgent && runtimeAgents.reason && <p role="status" className="mx-2 px-3 text-xs text-muted-foreground">{runtimeAgents.reason}</p>}
      {message && (
        <div className="-mt-0.5 mx-2 pb-2 px-3 pt-1.5 rounded-b-lg text-xs text-destructive transition-all duration-200 ease-in-out">
          <div className="flex items-center gap-1 justify-between">
            {message}
            <IconX
              className="size-3 text-muted-foreground cursor-pointer"
              onClick={() => {
                setMessage('')
                // Reset file input to allow re-uploading the same file
                if (fileInputRef.current) {
                  fileInputRef.current.value = ''
                }
              }}
            />
          </div>
        </div>
      )}

      {tokenCounterVisible && !tokenCounterCompact && (
        <div className="flex-1 w-full flex justify-start px-2">
          <TokenCounter messages={threadMessages || []} />
        </div>
      )}

    </div>
  )
})

export default ChatInput
