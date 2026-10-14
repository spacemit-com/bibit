import { prepareKnowledgeMessage } from '@/lib/knowledge-retrieval'
import { readSessionKnowledge, saveSessionKnowledge, sessionKnowledgeRaw } from '@/lib/session-knowledge'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ChatStatus, UIMessage } from 'ai'
import { useRuntimeStore } from '@/stores/runtime-store'
import { formatRuntimeCommandError, type RuntimeSession, type SessionAttachmentRef } from '@/lib/runtime-contract'
import { projectSessionEvents, sessionMessageToUIMessage, sessionApprovalToPermission, SessionHistoryDependencyError,
  type SessionMessage, type SessionProjectionBaseline } from '@/lib/runtime-session-projection'
import { markProjectionDone } from '@/lib/stream-timings'
import { useSessionFeed } from './useSessionFeed'
import { useSessionReadState } from './useSessionReadState'
import { observeRuntimePermission } from '@/features/conversation/runtimePermissionController'
import { usePrompt } from './usePrompt'
import { useThreads } from './useThreads'
import { useConversationSyncStore } from '@/stores/conversation-sync-store'
import { useSessionExecutionStore } from '@/stores/session-execution-store'
import { SESSION_STORAGE_PREFIX } from '@/constants/chat'
import { readSessionTitle, sessionTitleKey, sessionTitleRequests } from '@/lib/session-title'
import { withRuntimeController } from '@/lib/runtime-controller'
import i18n from '@/i18n/setup'

type PendingInput = {
  targetId: string
  sessionId: string
  messageId: string
  content: string
  skillIds: string[]
  attachments: SessionAttachmentRef[]
  status?: string
  enableKnowledge?: boolean
  draftToken?: string
  preserveDraft?: boolean
}
type HistoryAction = 'edit' | 'delete' | 'regenerate' | 'continue' | 'switch_version'
type HistoryRequest = { targetId: string; sessionId: string; operationId: string; expectedSeq: number;
  action: HistoryAction; messageId: string; content?: string }
const historyKey = (target: string, session: string) => `bibit:session-history:${JSON.stringify([target, session])}`

// 用户停手、会话流离开、换 epoch 都以同一原因放弃发送。它和检索失败在用户侧
// 的补偿不同：检索失败把正文交回输入框，取消则没有任何可见入口，必须另有终态。
// 标记比文案可靠：语言切换后同一条错误不能再靠 message 相等来识别。
const cancelCode = 'send_cancelled'
const cancel = () => Object.assign(new Error(i18n.t('chat:sendCancelled')), { code: cancelCode })
const isCancelled = (cause: unknown) => (cause as { code?: unknown } | null)?.code === cancelCode

const inputKey = (identity: string) => `bibit:session-input:${identity}`
function savedInput(identity: string): PendingInput | undefined {
  try {
    const value: PendingInput | undefined = JSON.parse(localStorage.getItem(inputKey(identity)) ?? 'null') ?? undefined
    // 旧版本记录没有该字段，缺失按关闭处理，否则重试时的匹配会失败。
    if (value) value.enableKnowledge = value.enableKnowledge === true
    return value
  } catch { return undefined }
}
function clearSavedInput(identity: string, messageId: string) {
  if (savedInput(identity)?.messageId === messageId) localStorage.removeItem(inputKey(identity))
}

function initialInput(sessionId: string): PendingInput | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(`${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${sessionId}`) ?? 'null')
    if (value?.sessionId !== sessionId || typeof value.targetId !== 'string' || !value.targetId || typeof value.messageId !== 'string' || !value.messageId || typeof value.text !== 'string') return
    return { targetId: value.targetId, sessionId, messageId: value.messageId, content: value.text,
      skillIds: Array.isArray(value.skillIds) ? value.skillIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0) : [],
      attachments: [], enableKnowledge: typeof value.enableKnowledge === 'boolean' ? value.enableKnowledge : false }
  } catch { return undefined }
}

function clearInitialInput(input: PendingInput) {
  const current = initialInput(input.sessionId)
  if (current?.targetId === input.targetId && current.messageId === input.messageId) {
    sessionStorage.removeItem(`${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${input.sessionId}`)
  }
}

async function command<T>(name: string, args: Record<string, unknown>, beforeInvoke?: () => void): Promise<T> {
  return withRuntimeController(() => { beforeInvoke?.(); return invoke<T>(name, args) })
}

/**
 * 原对话视图的 Session 数据和命令；不拥有新的页面或输入控件。
 * `anchorSeq` 由搜索结果传入，表示首屏窗口要以这条消息结尾。
 */
export function useSessionConversation(sessionId: string, enabled: boolean, anchorSeq?: number) {
  const epoch = useRuntimeStore(state => state.runtimeEpoch)
  const runtimeId = useRuntimeStore(state => state.runtimeId)
  const source = useSessionFeed(sessionId, epoch, enabled, anchorSeq)
  // Runtime 重连期间 useSessionFeed 保留同一会话的上一份快照：正文照常展示，
  // 但这份快照仍属于它自己的 epoch，不能拿当前 epoch 给它重新盖章，
  // 否则退役实例的审批会被当成当前有效（见 runtimePermissionController 的
  // retired-epoch 不变量）。
  const feed = enabled && source.feed?.sessionId === sessionId ? source.feed : undefined
  const identity = feed ? JSON.stringify([feed.targetId, sessionId, epoch]) : undefined
  const targetId = feed?.targetId
  const feedEpoch = feed?.runtimeEpoch
  const feedIdentity = useMemo(() => targetId && feedEpoch && runtimeId ? {
    targetId, runtimeId, runtimeEpoch: feedEpoch, sessionId,
  } : undefined, [targetId, feedEpoch, runtimeId, sessionId])
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  useEffect(() => {
    currentIdentity.current = identity
    return () => { currentIdentity.current = undefined }
  }, [identity])
  // 上一次投影作为增量基线：纯尾部 delta 批次沿用未受影响的消息引用，
  // 全量重投影（工具、审批、终态、分页等）也会复用内容未变化的消息。
  const projectionBaseline = useRef<SessionProjectionBaseline | undefined>(undefined)
  const projected = useMemo(() => {
    const startedAt = performance.now()
    try {
      const value = projectSessionEvents(feed?.events ?? [], feed?.hiddenRunIds, feedIdentity, projectionBaseline.current)
      markProjectionDone(performance.now() - startedAt, feed?.sessionId, feed?.events, value.messages)
      projectionBaseline.current = { events: feed?.events ?? [], hiddenRunIds: feed?.hiddenRunIds ?? [], identity: feedIdentity, projection: value }
      return { value, error: '', missing: false }
    }
    catch (cause) {
      projectionBaseline.current = undefined
      return { value: projectSessionEvents([]), error: formatRuntimeCommandError(cause), missing: cause instanceof SessionHistoryDependencyError }
    }
  }, [feed?.events, feed?.hiddenRunIds, feedIdentity])
  const projection = projected.value
  const dependencyPage = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!identity) { dependencyPage.current = undefined; return }
    if (!projected.missing || !feed?.hasMore || feed.paused) return
    const key = JSON.stringify([identity, feed.baseSeq])
    if (dependencyPage.current === key) return
    dependencyPage.current = key
    void source.loadOlder()
  }, [identity, projected.missing, feed?.hasMore, feed?.paused, feed?.baseSeq, source.loadOlder])
  const accepted = useRef(projection.inputs)
  accepted.current = projection.inputs
  const [pending, setPending] = useState<PendingInput[]>([])
  const [summary, setSummary] = useState<RuntimeSession>()
  // 已读水位：当会话在视口中且被聚焦（用户真正打开并查看）时，把当前 feed
  // 的 renderedSeq 与最新终态 run 推进到本地水位，侧栏据此清掉“完成未读”。
  useSessionReadState(targetId, feed ? sessionId : undefined, feed, summary ? [summary] : [])
  const [error, setError] = useState('')
  const [stopping, setStopping] = useState(false)
  const sending = useRef(new Set<string>())
  const preparation = useRef(new Map<string, AbortController>())
  const [preparing, setPreparing] = useState<{ identity: string; messageId: string; question: string }>()
  // 会话生命周期：换会话、换 runtime epoch、组件卸载。会话流重订阅会把 feed 打回
  // undefined（会话切换或订阅失效时 useSessionFeed 会 installFeed(undefined)），连带 identity 归零，
  // 但那只是 UI 订阅的抖动，不是会话生命周期变化——在途发送只认这里。
  const sessionLifetime = JSON.stringify([sessionId, epoch])
  const lifetime = useRef<string | undefined>(sessionLifetime)
  lifetime.current = sessionLifetime
  useEffect(() => {
    lifetime.current = sessionLifetime
    return () => { lifetime.current = undefined }
  }, [sessionLifetime])
  const alive = (started: string | undefined) => lifetime.current === started
  useEffect(() => () => {
    for (const controller of preparation.current.values()) controller.abort()
  }, [sessionLifetime])
  const historySending = useRef(new Set<string>())
  const [historyBusy, setHistoryBusy] = useState(false)
  const [pendingHistory, setPendingHistory] = useState<HistoryRequest | null>(null)
  const confirmedHistory = useRef(new Set<string>())
  confirmedHistory.current = new Set((feed?.events ?? []).filter(event => event.type === 'conversation/changed').map(event => String(event.data.operation_id)))
  useEffect(() => { setHistoryBusy(false) }, [identity])
  useEffect(() => {
    if (!feed) { setPendingHistory(null); return }
    const key = historyKey(feed.targetId, sessionId)
    try {
      const pending: HistoryRequest | null = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (pending && feed.events.some(event => event.type === 'conversation/changed' && event.data.operation_id === pending.operationId)) {
        localStorage.removeItem(key)
        setError('')
        setPendingHistory(null)
      } else setPendingHistory(pending)
    } catch { setError(i18n.t('chat:historyPendingUnreadable')) }
  }, [identity, feed?.events, sessionId])
  const titleAttempts = useRef(new Set<string>())

  useEffect(() => {
    if (!identity || !feed) return
    const key = `bibit:session-draft:${JSON.stringify([feed.targetId, sessionId])}`
    useThreads.setState({ currentThreadId: sessionId, currentThreadTargetId: feed.targetId })
    const synchronized = useConversationSyncStore.getState().drafts[sessionId]
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? localStorage.getItem(`bibit:session-draft:${feed.targetId}:${sessionId}`) ?? '{}')
      const content = synchronized ?? (typeof saved.content === 'string' ? saved.content : '')
      usePrompt.setState({ prompt: content, draftToken: typeof saved.draftToken === 'string' && saved.content === content ? saved.draftToken : crypto.randomUUID() })
      if (synchronized !== undefined) localStorage.setItem(key, JSON.stringify({ content, draftToken: usePrompt.getState().draftToken }))
    } catch { usePrompt.getState().resetPrompt() }
    const restoreKnowledge = (event: StorageEvent) => {
      if (event.key !== key || currentIdentity.current !== identity) return
      try {
        const saved = JSON.parse(event.newValue ?? '{}')
        if (saved.content === usePrompt.getState().prompt) usePrompt.setState({ draftToken: typeof saved.draftToken === 'string' ? saved.draftToken : crypto.randomUUID() })
      } catch { /* 无效存储事件不覆盖正在编辑的草稿。 */ }
    }
    window.addEventListener('storage', restoreKnowledge)
    const unsubscribe = usePrompt.subscribe((state, previous) => {
      const selected = useThreads.getState()
      if (currentIdentity.current !== identity || selected.currentThreadId !== sessionId || selected.currentThreadTargetId !== feed.targetId || (state.prompt === previous.prompt && state.draftToken === previous.draftToken)) return
      try { localStorage.setItem(key, JSON.stringify({ content: state.prompt, draftToken: state.draftToken })) }
      catch (cause) { setError(formatRuntimeCommandError(cause)) }
    })
    return () => { unsubscribe(); window.removeEventListener('storage', restoreKnowledge) }
  }, [identity, sessionId, feed?.targetId])

  useEffect(() => {
    if (!identity || !feed) return
    const storageIdentity = JSON.stringify([feed.targetId, sessionId])
    const input = savedInput(storageIdentity)
    if (!input || !projection.inputs[input.messageId]) return
    clearSavedInput(storageIdentity, input.messageId)
    clearInitialInput(input)
    const original = readSessionKnowledge(feed.targetId, sessionId, input.messageId, input.content)?.originalInput
    if (!input.preserveDraft && input.draftToken === usePrompt.getState().draftToken &&
      (usePrompt.getState().prompt === input.content || usePrompt.getState().prompt === original)) usePrompt.getState().resetPrompt()
  }, [identity, feed?.targetId, sessionId, projection.inputs])

  useEffect(() => {
    // 快照重载会重建 pending，但本地已知终态的输入（失败的、回执未知的）要么从未
    // 交给 Runtime，要么还没被确认，丢掉就等于抹掉用户唯一的重试入口。
    setPending(items => items.filter(item => item.status === 'failed' || item.status === 'unknown'))
    setError('')
    setStopping(false)
    if (!identity || !feed) return
    let active = true
    void invoke<PendingInput[]>('runtime_session_pending', { sessionId, expectedTargetId: feed.targetId }).then(inputs => {
      if (active) setPending(existing => [
        ...inputs.filter(input => input.targetId === feed.targetId && input.sessionId === sessionId && !existing.some(item => item.messageId === input.messageId)).map(input => ({ ...input, status: 'unknown' })),
        ...existing,
      ])
    }).catch(cause => { if (active) setError(formatRuntimeCommandError(cause)) })
    return () => { active = false }
  }, [identity, sessionId, feed?.targetId])

  const summaryIdentity = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!identity) {
      summaryIdentity.current = undefined
      setSummary(undefined)
      return
    }
    // stale-while-revalidate：新值到达前保留上一个已知值，否则每次摘要刷新都会让忙碌
    // 判据短暂失去依据（run 开始、终态、标题生成 run 都会推一次摘要帧）。
    if (summaryIdentity.current !== identity) {
      summaryIdentity.current = identity
      setSummary(undefined)
    }
    let active = true
    void invoke<RuntimeSession[]>('runtime_sessions_list').then(sessions => {
      if (!active) return
      const current = sessions.find(session => session.id === sessionId)
      setSummary(current)
      const threads = useThreads.getState()
      const thread = threads.threads?.[sessionId]
      if (current?.title && thread?.metadata?.targetId === feed?.targetId && !thread?.metadata?.titleSetManually && thread.title !== current.title) {
        threads.setThreads(Object.values(threads.threads).map(item => item.id === sessionId ? { ...item, title: current.title } : item))
      }
    }).catch(cause => { if (active) setError(formatRuntimeCommandError(cause)) })
    return () => { active = false }
  }, [identity, sessionId, feed?.summaryVersion])

  useEffect(() => {
    if (!identity || !feed || feed.paused) return
    const key = sessionTitleKey(feed.targetId, sessionId)
    const input = readSessionTitle(key)
    if (!input || input.manual || input.done || !projection.inputs[input.messageId] || sessionTitleRequests.has(key) || titleAttempts.current.has(key)) return
    titleAttempts.current.add(key)
    const request = command('runtime_session_generate_title', { expectedTargetId: feed.targetId, sessionId, messageId: input.messageId, content: input.content }).then(() => {
      const current = readSessionTitle(key)
      if (current?.messageId === input.messageId && !current.manual) localStorage.setItem(key, JSON.stringify({ ...current, done: true }))
    }).catch(cause => { if (currentIdentity.current === identity) setError(formatRuntimeCommandError(cause)) }).finally(() => { sessionTitleRequests.delete(key) })
    sessionTitleRequests.set(key, request)
  }, [identity, feed, sessionId, projection.inputs])

  const approvals = Object.values(projection.approvals)
  const activeRunId = projection.messages.filter(message => message.role === 'assistant' && message.status === 'running').at(-1)?.runId ?? approvals.find(approval => approval.status === 'pending')?.runId ?? summary?.activeRunId
  const resolvedCurrentApproval = approvals.some(approval => approval.runId === activeRunId && approval.status !== 'pending')
  const waiting = approvals.some(approval => approval.status === 'pending') || Boolean(summary?.waiting && !resolvedCurrentApproval)
  // 忙碌判据的权威来源是 Runtime 的会话执行视图；内容投影只在视图缺席时兜底。
  const executionKey = identity
  const executionView = feed?.summary?.sessions?.find(item => item.id === sessionId)
  const unclaimedInputs = identity
    ? pending.filter(input => input.targetId === feed?.targetId && input.sessionId === sessionId && !projection.inputs[input.messageId]).length
    : 0
  const pendingApprovals = approvals.filter(approval => approval.status === 'pending').length
  useEffect(() => {
    if (!executionKey) return
    useSessionExecutionStore.getState().observe(executionKey, {
      view: executionView
        ? { running: executionView.running, waiting: executionView.waiting, activeRunId: executionView.active_run_id }
        : undefined,
      unclaimedInputs,
      pendingApprovals,
      contentRunning: Boolean(activeRunId),
    })
  }, [executionKey, executionView, unclaimedInputs, pendingApprovals, activeRunId])
  useEffect(() => () => {
    if (executionKey) useSessionExecutionStore.getState().clear(executionKey)
  }, [executionKey])
  // 会话报错或订阅暂停时没有权威依据，直接释放忙碌状态，避免界面卡在"处理中"。
  useEffect(() => {
    if (executionKey && (projected.error || feed?.paused)) useSessionExecutionStore.getState().clear(executionKey)
  }, [executionKey, projected.error, feed?.paused])
  const executionBusy = useSessionExecutionStore(state => {
    const phase = executionKey ? state.executions[executionKey]?.phase : undefined
    return phase !== undefined && phase !== 'idle'
  })
  useEffect(() => {
    if (!identity || !feed || !runtimeId) return
    for (const approval of Object.values(projection.approvals)) {
      observeRuntimePermission(sessionApprovalToPermission(approval, feedIdentity))
    }
  }, [identity, feed, runtimeId, feedIdentity, projection.approvals])
  // UIMessage 缓存只在 SessionMessage 引用不变时命中，因此增量路径下历史行保持同一对象，
  // `MessageItem` 的 memo 不再被无意义的重建打断。知识上下文按存储原文参与键：
  // 检索结果后到时会换键重建，不会因为消息引用没变就停在旧内容上。
  const uiCache = useRef(new WeakMap<SessionMessage, { key: string; ui: UIMessage }>())
  const messages = useMemo(() => {
    const byId = new Map(projection.messages.map(message => [message.id, message]))
    const identityKey = feedIdentity ? JSON.stringify([feedIdentity.targetId, feedIdentity.runtimeId, feedIdentity.runtimeEpoch, feedIdentity.sessionId]) : ''
    const base = JSON.stringify([feed?.resourceBaseUrl ?? '', feed?.targetId ?? '', sessionId, identityKey])
    return projection.messages.map(message => {
      let owner = message
      const visited = new Set<string>()
      while (owner.role !== 'user' && owner.parentId && !visited.has(owner.id)) {
        visited.add(owner.id)
        const parent = byId.get(owner.parentId)
        if (!parent) break
        owner = parent
      }
      const raw = feed && owner.role === 'user' ? sessionKnowledgeRaw(feed.targetId, sessionId, owner.id) : null
      // 这条消息引用了哪些技能：Runtime 把它放在 inputs 里，刷新后由事件回放重建，
      // 所以引用展示不依赖本地的发送状态。
      const citedSkillIds = message.role === 'user' ? projection.inputs[owner.id]?.skillIds ?? [] : []
      const key = JSON.stringify([base, raw, raw ? owner.content : null, citedSkillIds])
      const cached = uiCache.current.get(message)
      if (cached?.key === key) return cached.ui
      const ui = sessionMessageToUIMessage(message, feed?.resourceBaseUrl, feedIdentity)
      const knowledge = raw ? readSessionKnowledge(feed!.targetId, sessionId, owner.id, owner.content) : undefined
      if (knowledge && message.role === 'user') {
        ui.parts = ui.parts.map(part => part.type === 'text' ? { ...part, text: knowledge.question } : part)
      }
      ui.metadata = {
        ...(ui.metadata as object),
        sessionFeed: true,
        ...(knowledge ? { knowledgeContext: knowledge.context } : {}),
        ...(citedSkillIds.length > 0 ? { citedSkillIds } : {}),
      }
      uiCache.current.set(message, { key, ui })
      return ui
    })
  }, [projection.messages, projection.inputs, feed?.resourceBaseUrl, feed?.targetId, sessionId, feedIdentity])

  type SendOptions = { skillIds?: string[]; enableKnowledge?: boolean; messageId?: string; preserveDraft?: boolean }
  const send = useCallback(async (
    content: string,
    retry?: PendingInput,
    attachments: SessionAttachmentRef[] = [],
    skillIdsOrOptions: string[] | SendOptions = [],
    enableKnowledge?: boolean,
  ) => {
    const options: SendOptions = Array.isArray(skillIdsOrOptions)
      ? { skillIds: skillIdsOrOptions, enableKnowledge }
      : skillIdsOrOptions
    const skillIds = options.skillIds ?? []
    const knowledgeEnabled = options.enableKnowledge ?? false
    if (!identity || !feed || feed.paused || projected.error) throw new Error(i18n.t('chat:sessionNotReady'))
    // 这条输入属于哪个会话生命周期；feed/identity 只是订阅态，不能拿来判定是否放弃发送。
    const started = lifetime.current
    const abandoned = () => controller.signal.aborted || !alive(started)
    if (waiting) throw new Error(i18n.t('chat:waitForApproval'))
    if (!content.trim()) throw new Error(i18n.t('chat:messageEmpty'))
    if (sending.current.has(identity)) throw new Error(i18n.t('chat:awaitingInputReceipt'))
    const storageIdentity = JSON.stringify([feed.targetId, sessionId])
    const saved = savedInput(storageIdentity)
    const matches = (input: PendingInput) => (input.enableKnowledge === knowledgeEnabled)
      && (input.content === content || readSessionKnowledge(input.targetId, input.sessionId, input.messageId, input.content)?.originalInput === content)
    const previous = retry ?? (saved && matches(saved) ? saved : undefined) ?? pending.find(input => input.status === 'unknown' && matches(input) && input.targetId === feed.targetId && input.sessionId === sessionId)
    if (previous && (previous.targetId !== feed.targetId || previous.sessionId !== sessionId)) throw new Error(i18n.t('chat:inputTargetChanged'))
    const priorUncertain = Boolean(previous && (saved?.messageId === previous.messageId || previous.status === 'unknown'))
    // 重试/续发复用原输入的 skillIds；新输入才接受调用方传入的临时技能。
    const draftAtStart = usePrompt.getState()
    const sourceInput: PendingInput = previous ?? {
      targetId: feed.targetId,
      sessionId,
      messageId: options.messageId ?? crypto.randomUUID(),
      content,
      skillIds: [...new Set(skillIds)],
      attachments,
      enableKnowledge: knowledgeEnabled,
      draftToken: draftAtStart.draftToken,
      ...(options.preserveDraft ? { preserveDraft: true } : {}),
    }
    const input: PendingInput = {
      ...sourceInput,
      draftToken: sourceInput.draftToken ?? (!priorUncertain ? draftAtStart.draftToken : undefined),
      attachments: [...new Map(sourceInput.attachments.map(attachment => [attachment.resourceId, attachment])).values()],
    }
    sending.current.add(identity)
    const controller = new AbortController()
    preparation.current.set(identity, controller)
    let submissionStarted = false
    try {
      let knowledge = readSessionKnowledge(feed.targetId, sessionId, input.messageId, input.content)
      const enableKnowledge = input.enableKnowledge ?? false
      if (!knowledge && !priorUncertain && enableKnowledge) {
        setPreparing({ identity, messageId: input.messageId, question: input.content })
        let rejectCancelled: () => void = () => undefined
        const cancelled = new Promise<never>((_, reject) => {
          rejectCancelled = () => reject(cancel())
          controller.signal.addEventListener('abort', rejectCancelled, { once: true })
        })
        const prepared = await Promise.race([prepareKnowledgeMessage(input.content, enableKnowledge), cancelled])
          .finally(() => controller.signal.removeEventListener('abort', rejectCancelled))
        if (abandoned()) throw cancel()
        input.content = prepared.prompt
        if (prepared.context) {
          knowledge = { version: 1, originalInput: sourceInput.content, ...prepared, context: prepared.context }
          saveSessionKnowledge(feed.targetId, sessionId, input.messageId, knowledge)
        }
      }
      if (abandoned()) throw cancel()
      setPreparing(current => current?.identity === identity ? undefined : current)
      localStorage.setItem(inputKey(storageIdentity), JSON.stringify(input))
      const titleKey = sessionTitleKey(feed.targetId, sessionId)
      if (!readSessionTitle(titleKey) && !projection.messages.some(message => message.role === 'user')) {
        localStorage.setItem(titleKey, JSON.stringify({ messageId: input.messageId, content: knowledge?.question ?? content }))
      }
      // 本地提交立即进入忙碌，不等待 Runtime 的事件或摘要帧。
      useSessionExecutionStore.getState().markSubmit(identity)
      setPending(items => [...items.filter(item => item.messageId !== input.messageId), { ...input, status: 'sending' }])
      const receipt = await command<{ accepted: boolean; status: string }>('runtime_session_submit', { request: {
        targetId: input.targetId, sessionId, messageId: input.messageId, content: input.content, skillIds: input.skillIds, attachments: input.attachments,
      } }, () => {
        if (abandoned()) throw cancel()
        preparation.current.delete(identity)
        submissionStarted = true
      })
      if (!receipt.accepted) throw { code: 'input_rejected', message: receipt.status || i18n.t('chat:inputNotAccepted') }
      clearSavedInput(storageIdentity, input.messageId)
      clearInitialInput(input)
      if (currentIdentity.current !== identity) return { skillIds: input.skillIds }
      if (!input.preserveDraft && usePrompt.getState().draftToken === input.draftToken &&
        usePrompt.getState().prompt === draftAtStart.prompt) usePrompt.getState().resetPrompt()
      setPending(items => items.map(item => item.messageId === input.messageId ? { ...item, status: receipt.status } : item))
      setError('')
      return { skillIds: input.skillIds }
    } catch (cause) {
      if (!submissionStarted && !priorUncertain) {
        clearInitialInput(input)
        clearSavedInput(storageIdentity, input.messageId)
      }
      // 取消必须留痕：这条输入从未交给 Runtime，而且身份漂移时下面的 setError 不会执行，
      // 界面只有靠 pending 才能给出“原样重试”，所以在身份判定之前先落一条终态。
      // 导出处按会话过滤，不会串到别的会话。
      if (isCancelled(cause) && !submissionStarted) setPending(items => [...items.filter(item => item.messageId !== input.messageId),
        { ...input, content: sourceInput.content, status: priorUncertain ? 'unknown' : 'failed' }])
      if (!alive(started)) throw cause
      if (accepted.current[input.messageId]) {
        clearSavedInput(storageIdentity, input.messageId)
        clearInitialInput(input)
        return { skillIds: input.skillIds }
      }
      const detail = cause && typeof cause === 'object' ? cause as Record<string, unknown> : {}
      const details = detail.details && typeof detail.details === 'object' ? detail.details as Record<string, unknown> : {}
      const httpStatus = Number(details.httpStatus ?? detail.status)
      const definite = !submissionStarted ? !priorUncertain : (!previous && details.submissionState === 'not_sent') || ['input_rejected', 'invalid_request', 'session_conflict', 'session_not_found', 'unsupported_operation', 'permission_denied'].includes(String(detail.code)) || (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408)
      if (definite) {
        clearSavedInput(storageIdentity, input.messageId)
        const key = sessionTitleKey(feed.targetId, sessionId)
        const title = readSessionTitle(key)
        if (title?.messageId === input.messageId && !title.manual && !title.done) localStorage.removeItem(key)
      }
      setPending(items => items.map(item => item.messageId === input.messageId ? { ...item, status: definite ? 'failed' : 'unknown' } : item))
      setError(formatRuntimeCommandError(cause))
      throw cause
    } finally {
      sending.current.delete(identity)
      preparation.current.delete(identity)
      setPreparing(current => current?.identity === identity ? undefined : current)
    }
  }, [identity, feed, sessionId, waiting, pending, projection.messages, projected.error])

  const attemptedInitial = useRef(new Set<string>())
  useEffect(() => {
    if (!identity || !feed || feed.paused || projected.error) return
    const input = initialInput(sessionId)
    if (waiting) return
    if (!input || input.targetId !== feed.targetId) return
    if (projection.inputs[input.messageId]) { clearInitialInput(input); return }
    const key = JSON.stringify([input.targetId, sessionId, input.messageId])
    if (attemptedInitial.current.has(key)) return
    attemptedInitial.current.add(key)
    if (!usePrompt.getState().prompt) usePrompt.setState({ prompt: input.content, draftToken: crypto.randomUUID() })
    // 未知回执保留原输入，重开页面不自动重试；用户确认重试时复用原 ID。
    if (savedInput(JSON.stringify([input.targetId, sessionId]))?.messageId === input.messageId) return
    void send(input.content, input).then(() => {
    }).catch(() => undefined)
  }, [identity, feed, sessionId, waiting, projection.inputs, send, projected.error])

  const stop = useCallback(async () => {
    if (preparation.current.size) {
      for (const controller of preparation.current.values()) controller.abort()
      return
    }
    if (!identity || !feed || !activeRunId || stopping) return
    setStopping(true)
    useSessionExecutionStore.getState().markStopping(identity)
    try { await command('runtime_session_cancel', { sessionId, runId: activeRunId, expectedTargetId: feed.targetId }) }
    catch (cause) {
      if (currentIdentity.current === identity) { setStopping(false); setError(formatRuntimeCommandError(cause)) }
    }
  }, [identity, feed, activeRunId, sessionId, stopping])
  useEffect(() => { setStopping(false) }, [activeRunId])

  const changeHistory = useCallback(async (action: HistoryAction, messageId: string, content?: string) => {
    const reject = (message: string): never => { setError(message); throw new Error(message) }
    if (!identity || !feed || feed.paused || projected.error) return reject(i18n.t('chat:sessionNotReady'))
    const message = projection.allMessages.find(item => item.id === messageId)
    if (message?.compression) return reject(i18n.t('chat:historyCompressedUnsupported'))
    if (historySending.current.has(identity)) return
    const key = historyKey(feed.targetId, sessionId)
    let saved: HistoryRequest | null
    try { saved = JSON.parse(localStorage.getItem(key) ?? 'null') }
    catch { return reject(i18n.t('chat:historyPendingUnreadable')) }
    if (saved && (saved.targetId !== feed.targetId || saved.sessionId !== sessionId || saved.action !== action
      || saved.messageId !== messageId || saved.content !== content)) return reject(i18n.t('chat:historyPendingUnconfirmed'))
    if (!saved && (activeRunId || waiting || pending.some(input => !projection.inputs[input.messageId]))) return reject(i18n.t('chat:waitForRunAndInputs'))
    const request: HistoryRequest = saved ?? { targetId: feed.targetId, sessionId, operationId: crypto.randomUUID(),
      expectedSeq: feed.events.at(-1)?.seq ?? 0, action, messageId, ...(content === undefined ? {} : { content }) }
    historySending.current.add(identity)
    setHistoryBusy(true)
    try {
      localStorage.setItem(key, JSON.stringify(request))
      setPendingHistory(request)
      const receipt = await command<{ accepted: boolean; operationId: string }>('runtime_session_history', { request })
      if (!receipt.accepted || receipt.operationId !== request.operationId) throw new Error(i18n.t('chat:historyReceiptUnconfirmed'))
      if (JSON.parse(localStorage.getItem(key) ?? 'null')?.operationId === request.operationId) localStorage.removeItem(key)
      if (currentIdentity.current === identity) { setPendingHistory(null); setError(''); source.retry() }
    } catch (cause) {
      if (currentIdentity.current === identity && confirmedHistory.current.has(request.operationId)) return
      const detail = cause && typeof cause === 'object' ? cause as Record<string, unknown> : {}
      const details = detail.details && typeof detail.details === 'object' ? detail.details as Record<string, unknown> : {}
      const status = Number(details.httpStatus)
      if (status >= 400 && status < 500 && status !== 408) {
        localStorage.removeItem(key)
        if (currentIdentity.current === identity) setPendingHistory(null)
      }
      if (currentIdentity.current === identity) setError(formatRuntimeCommandError(cause))
      throw cause
    } finally {
      historySending.current.delete(identity)
      if (currentIdentity.current === identity) setHistoryBusy(false)
    }
  }, [identity, feed, sessionId, projected.error, activeRunId, waiting, pending, projection.inputs, projection.allMessages, source.retry])
  const ownedHistory = pendingHistory?.targetId === feed?.targetId && pendingHistory?.sessionId === sessionId ? pendingHistory : null
  const retryHistory = useCallback(async () => {
    if (ownedHistory) await changeHistory(ownedHistory.action, ownedHistory.messageId, ownedHistory.content)
  }, [ownedHistory, changeHistory])

  const versions = useMemo(() => {
    const groups = new Map<string | null, typeof projection.allMessages>()
    for (const message of projection.allMessages) {
      const key = message.parentId ?? null
      const group = groups.get(key) ?? []
      group.push(message)
      groups.set(key, group)
    }
    const result: Record<string, { index: number; count: number; siblings: string[] }> = {}
    for (const group of groups.values()) {
      const siblings = group.map(message => message.id)
      group.forEach((message, index) => { result[message.id] = { index: index + 1, count: group.length, siblings } })
    }
    return result
  }, [projection.allMessages])
  const switchVersion = useCallback(async (messageId: string, direction: -1 | 1) => {
    const version = versions[messageId]
    const next = version?.siblings[version.index - 1 + direction]
    if (next) await changeHistory('switch_version', next)
  }, [versions, changeHistory])

  // 自愈兑底：当一条已成功提交的输入（sending/claimed/staged）在投影中始终未获确认
  // （projection.inputs 缺失该 messageId）时，实时通道大概率丢失了对应事件（首条
  // user/message 或 agent/inbox/spliced），导致 pending 无法清算。此处触发一次权威窗口
  // 重新同步（等价于 webui 收到 subscribed 时重拉 / 切换会话重进），用 HTTP 补齐缺失事件，
  // 避免“一直显示 working”需手动切换会话恢复。每个 messageId 至多触发一次，避免重试循环。
  const feedWatchdog = useRef(new Set<string>())
  useEffect(() => {
    if (!identity || !feed || feed.paused || projected.error) return
    const unconfirmed = pending.filter(input =>
      input.status !== 'failed' && input.status !== 'unknown' &&
      !projection.inputs[input.messageId]
    )
    if (!unconfirmed.length) return
    const timer = setTimeout(() => {
      const still = pending.filter(input => unconfirmed.some(item => item.messageId === input.messageId))
      if (projected.error || feed.paused) return
      for (const input of still) {
        if (projection.inputs[input.messageId]) continue
        const key = JSON.stringify([identity, input.messageId])
        if (feedWatchdog.current.has(key)) continue
        feedWatchdog.current.add(key)
        source.retry()
      }
    }, 5000)
    return () => clearTimeout(timer)
  }, [identity, feed, projected.error, feed?.paused, pending, projection.inputs, projection.allMessages, source.retry])
  useEffect(() => {
    if (!identity) { feedWatchdog.current.clear(); return }
    // messageId 一旦进入 projection.inputs 即视为已确认，不再需要自愈，释放护栏。
    for (const input of pending) {
      if (projection.inputs[input.messageId]) {
        feedWatchdog.current.delete(JSON.stringify([identity, input.messageId]))
      }
    }
  }, [identity, pending, projection.inputs])

  return {
    feed, projection,
    messages: preparing && preparing.identity === identity ? [...messages, {
      id: preparing.messageId, role: 'user' as const,
      parts: [{ type: 'text' as const, text: preparing.question }],
      metadata: { sessionFeed: true, knowledgeRetrieving: true },
    }] : messages,
    send, stop, stopping, waiting, changeHistory, historyBusy, versions, switchVersion,
    pendingHistory: ownedHistory, retryHistory,
    ready: Boolean(identity && !feed?.paused && !projected.error),
    halted: Boolean(source.halted),
    status: (preparing?.identity === identity && preparing ? 'submitted' : executionBusy || Boolean(activeRunId) ? 'streaming' : 'ready') as ChatStatus,
    pending: identity ? pending.filter(input => input.targetId === feed?.targetId && input.sessionId === sessionId && !projection.inputs[input.messageId]) : [],
    error: enabled ? error || source.error || (projected.missing && feed?.hasMore ? i18n.t('chat:historyDependencyLoading') : projected.error) || (ownedHistory && !historyBusy ? i18n.t('chat:historyResultUnconfirmed') : '') : '',
    loadOlder: source.loadOlder,
    retry: source.retry,
    /** 展示的是「以命中消息结尾」的历史窗口，还是最新窗口。 */
    anchored: source.anchored,
  }
}
