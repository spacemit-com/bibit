import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { isSessionBusy, useChatSessions } from '@/stores/chat-session-store'
import { useOverlayConversationStore } from '@/stores/overlay-conversation-store'
import { defaultModel } from '@/lib/models'
import { cancelCoordinatedSessionRun } from '@/lib/coordinated-stop'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useVoiceInputStore } from '@/stores/voice-input-store'
import {
  isVoiceTransportError,
  recordVoiceStatusUnavailable,
  useVoiceServiceState,
} from '@/stores/voice-status-store'
import { useTranslation } from '@/i18n/react-i18next-compat'

// 保留跨重挂载的完成记录；status 的计数回退表示语音服务重启。
const completedSessions = new Set<number>()
let latestSession = 0

type VoiceContext = {
  conversationGeneration?: number
  sessionId?: string
  targetId?: string
  runtimeEpoch?: string
  windowGeneration?: number
}

// 浮窗里已经开着的会话，用户再次唤醒就是打断当前回答再提新的。
// 停的是正在跑的 run，不是会话本身；本地模型走 chat.stop()，Runtime 走取消命令。
function interruptCurrentRun() {
  const threadId = useThreads.getState().currentThreadId
  const session = threadId ? useChatSessions.getState().sessions[threadId] : undefined
  if (!threadId || !(useOverlayConversationStore.getState().busy || isSessionBusy(session))) return
  if (!useRuntimeStore.getState().enabled) {
    void session?.chat?.stop()
    return
  }
  void cancelCoordinatedSessionRun(threadId, IS_TAURI, undefined, true).catch((cause) =>
    console.warn('打断当前回答失败', cause)
  )
}

export function VoiceOverlayBridge() {
  const { t } = useTranslation()
  const createThread = useThreads((state) => state.createThread)
  const runtimeEnabled = useRuntimeStore((state) => state.enabled)
  const navigate = useNavigate()
  const pathname = useLocation({ select: (location) => location.pathname })
  const nextInput = useVoiceInputStore((state) => state.pending[0])
  const routingInputRef = useRef<string | null>(null)
  const errorText = useVoiceInputStore((state) => state.error)
  const serviceState = useVoiceServiceState()
  const activeSessionRef = useRef<number | null>(null)
  const contextRef = useRef<Promise<VoiceContext> | null>(null)
  const generationRef = useRef(0)
  const handoffQueueRef = useRef<Promise<void>>(Promise.resolve())

  const reportError = useCallback((cause: unknown) => {
    useVoiceInputStore.setState({
      phase: 'error',
      error: cause instanceof Error ? cause.message : String(cause),
      failure: null,
    })
  }, [])

  /**
   * 识别结果拿到了却没发出去。原文（`text`）必须留在界面上：用户说过的话不能因为
   * 一次发送失败就消失。底层原因只进 error 供日志与排查使用。
   */
  const reportSendFailure = useCallback((text: string, cause: unknown) => {
    useVoiceInputStore.setState({
      phase: 'error',
      error: cause instanceof Error ? cause.message : String(cause),
      failure: { kind: 'send', text },
    })
  }, [])

  const resolveModel = useCallback(() => {
    const store = useModelProvider.getState()
    const providerName = store.selectedProvider || 'openai'
    if (store.selectedModel?.id && store.getProviderByName(providerName)) {
      return { id: store.selectedModel.id, provider: providerName }
    }
    const provider =
      store.providers.find(
        (candidate) =>
          candidate.provider === providerName &&
          (candidate.models?.length ?? 0) > 0
      ) ??
      store.providers.find(
        (candidate) => candidate.active && (candidate.models?.length ?? 0) > 0
      )
    if (provider?.models?.length) {
      const model = provider.models[0]
      store.selectModelProvider(provider.provider, model.id)
      return { id: model.id, provider: provider.provider }
    }
    return { id: defaultModel(providerName), provider: providerName }
  }, [])

  const captureContext = useCallback(async (): Promise<VoiceContext> => {
    const sessionId = useThreads.getState().currentThreadId
    const conversationGeneration = useOverlayConversationStore.getState().generation
    const windowGeneration = await invoke<number>('voice_overlay_generation')
    const windowContext = { conversationGeneration, ...(windowGeneration === undefined ? {} : { windowGeneration }) }
    if (!runtimeEnabled) return { ...windowContext, sessionId }
    const identity = await invoke<{ targetId: string; runtimeEpoch?: string }>(
      'runtime_target_identity'
    )
    return {
      ...windowContext, sessionId,
      targetId: identity.targetId, runtimeEpoch: identity.runtimeEpoch,
    }
  }, [runtimeEnabled])

  const verifyTarget = useCallback(async (context: VoiceContext) => {
    if (!context.targetId) return
    const current = await invoke<{ targetId: string; runtimeEpoch?: string }>(
      'runtime_target_identity'
    )
    if (
      current.targetId !== context.targetId ||
      current.runtimeEpoch !== context.runtimeEpoch
    ) {
      throw new Error(t('chat:runtimeTargetChanged'))
    }
  }, [t])

  const handoffInput = useCallback(
    async (text: string, contextPromise: Promise<VoiceContext>, generation: number) => {
      const context = await contextPromise
      await verifyTarget(context)

      let sessionId = context.sessionId ?? (context.conversationGeneration === useOverlayConversationStore.getState().generation ? useThreads.getState().currentThreadId : undefined)
      if (!sessionId) {
        let model: ThreadModel
        if (context.targetId) {
          const agents = await invoke<Array<{ id: string; available: boolean }>>(
            'runtime_agents_list'
          )
          const agent = agents.find((candidate) => candidate.available)
          if (!agent) throw new Error(t('chat:noAvailableAgent'))
          model = { id: agent.id, provider: 'runtime' }
        } else {
          model = resolveModel()
        }
        const thread = await createThread(
          model,
          t('chat:voiceSessionTitle'),
          false,
          context.targetId
        )
        sessionId = thread.id
        void emitTo('main', 'conversation-thread-created', {
          sessionId: thread.id,
          targetId: thread.metadata?.targetId,
        }).catch((cause) => console.warn('主窗口会话列表刷新通知失败', cause))
        await verifyTarget(context)
      }

      const inputContext = { ...context }
      delete inputContext.conversationGeneration
      useVoiceInputStore.setState((state) => ({
        ...(generation === generationRef.current
          ? { phase: 'idle' as const, error: '', failure: null }
          : {}),
        pending: [...state.pending, { ...inputContext, id: crypto.randomUUID(), sessionId, text }],
      }))
    },
    [createThread, resolveModel, verifyTarget, t]
  )

  useEffect(() => {
    if (!nextInput || routingInputRef.current === nextInput.id) return
    routingInputRef.current = nextInput.id
    useVoiceInputStore.setState({ readyId: undefined })
    void (async () => {
      await verifyTarget(nextInput)
      await invoke('conversation_select_session', {
        originWindow: 'voice-overlay',
        sessionId: nextInput.sessionId,
        ...(nextInput.targetId ? { expectedTargetId: nextInput.targetId } : {}),
      })
      if (pathname !== `/threads/${nextInput.sessionId}`) {
        await navigate({ to: '/threads/$threadId', params: { threadId: nextInput.sessionId } })
      }
      await invoke('show_voice_overlay', ...(nextInput.windowGeneration === undefined ? [] : [{ expectedGeneration: nextInput.windowGeneration }]))
      if (useVoiceInputStore.getState().pending[0]?.id === nextInput.id) {
        useVoiceInputStore.setState({ readyId: nextInput.id })
      }
    })().catch((cause) => {
      useVoiceInputStore.setState((state) => ({
        readyId: undefined,
        pending: state.pending.filter((input) => input.id !== nextInput.id),
      }))
      reportSendFailure(nextInput.text, cause)
    }).finally(() => {
      if (routingInputRef.current === nextInput.id) routingInputRef.current = null
    })
  }, [nextInput, pathname, navigate, verifyTarget, reportSendFailure])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    let unlistenDismiss: (() => void) | undefined
    const beginSession = (sessionId: number) => {
      if (sessionId < latestSession || completedSessions.has(sessionId) || activeSessionRef.current === sessionId) return
      latestSession = Math.max(latestSession, sessionId)
      for (const completed of completedSessions) {
        if (completed < latestSession) completedSessions.delete(completed)
      }
      activeSessionRef.current = sessionId
      const generation = ++generationRef.current
      const context = captureContext()
      contextRef.current = context
      // wake 后未必有 asr_final，必须立即处理上下文查询的拒绝。
      void context.catch((cause) => {
        if (!disposed && generationRef.current === generation) reportError(cause)
      })
      useVoiceInputStore.setState({ mode: 'voice', phase: 'listening', error: '', failure: null })
    }

    const unsubscribe = useVoiceInputStore.subscribe((state, previous) => {
      if (
        (state.mode === 'keyboard' && previous.mode !== 'keyboard') ||
        (state.phase === 'idle' && previous.phase !== 'idle')
      ) {
        if (activeSessionRef.current !== null) completedSessions.add(activeSessionRef.current)
        activeSessionRef.current = null
        generationRef.current += 1
      }
    })

    const handleEvent = ({ payload }: { payload: Record<string, unknown> }) => {
      if (disposed) return
      const event = typeof payload.event === 'string' ? payload.event : ''
      const sessionId =
        typeof payload.session_id === 'number' ? payload.session_id : null
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''

      switch (event) {
        case 'status':
          if (sessionId !== null && sessionId < latestSession) {
            completedSessions.clear()
            latestSession = sessionId
            activeSessionRef.current = null
            generationRef.current += 1
          }
          return
        case 'wake_triggered':
          if (sessionId !== null) {
            interruptCurrentRun()
            beginSession(sessionId)
          }
          return
        case 'asr_state':
          // 手动录音不发 wake_triggered；followup 不应开启新一轮输入。
          if (payload.state === 'started' && payload.reason === 'manual' && sessionId !== null) {
            beginSession(sessionId)
          }
          return
        case 'listening':
        case 'speech_started':
          if (sessionId !== null && activeSessionRef.current === sessionId) {
            useVoiceInputStore.setState({ phase: 'listening' })
          }
          return
        case 'recognizing':
          if (sessionId !== null && activeSessionRef.current === sessionId) {
            useVoiceInputStore.setState({ phase: 'recognizing' })
          }
          return
        case 'asr_final': {
          if (
            sessionId === null ||
            activeSessionRef.current !== sessionId ||
            completedSessions.has(sessionId)
          ) return
          completedSessions.add(sessionId)
          activeSessionRef.current = null
          if (!text) {
            useVoiceInputStore.setState({ phase: 'idle' })
            return
          }
          const context = contextRef.current
          if (!context) return
          const generation = generationRef.current
          useOverlayConversationStore.setState(state => ({ handingOff: state.handingOff + 1 }))
          handoffQueueRef.current = handoffQueueRef.current
            .then(() => handoffInput(text, context, generation))
            .catch((cause) => {
              if (disposed) return
              // 旧录音的失败不得改写新一轮录音的状态，但识别原文仍要保留下来。
              console.error('语音交接失败', cause)
              useVoiceInputStore.setState({
                ...(generation === generationRef.current
                  ? { phase: 'error' as const, error: cause instanceof Error ? cause.message : String(cause) }
                  : {}),
                failure: { kind: 'send', text },
              })
            })
            .finally(() => useOverlayConversationStore.setState(state => ({ handingOff: state.handingOff - 1 })))
          return
        }
        case 'error':
          if (sessionId !== null && activeSessionRef.current !== sessionId) return
          {
            // 码在前、诊断文本在后：界面按码投影成人话，日志里也能直接按码检索。
            const code = typeof payload.code === 'string' ? payload.code : ''
            const detail = typeof payload.reason === 'string'
              ? payload.reason
              : typeof payload.message === 'string' ? payload.message : ''
            if (code || detail) console.error('语音服务错误', code, detail)
            reportError(code && detail ? `${code} ${detail}` : code || detail || t('chat:speechRecognitionFailed'))
          }
          return
        case 'session_cancelled':
        case 'session_exit':
          if (sessionId !== null && sessionId >= latestSession) completedSessions.add(sessionId)
          if (sessionId === null || activeSessionRef.current === sessionId) {
            activeSessionRef.current = null
            generationRef.current += 1
            useVoiceInputStore.setState({ phase: 'idle' })
          }
          return
      }
    }

    void (async () => {
      const dispose = await listen<Record<string, unknown>>(
        'voice-tool-event',
        handleEvent
      )
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
      const disposeDismiss = await listen('voice-overlay-dismissed', () => {
        if (activeSessionRef.current !== null) completedSessions.add(activeSessionRef.current)
        activeSessionRef.current = null
        generationRef.current += 1
        useVoiceInputStore.setState({ phase: 'idle' })
      })
      if (disposed) { disposeDismiss(); return }
      unlistenDismiss = disposeDismiss
      const replay = await invoke<unknown>('voice_tool_replay_events')
      if (!disposed && Array.isArray(replay)) {
        replay.forEach((payload) => {
          if (payload && typeof payload === 'object') {
            handleEvent({ payload: payload as Record<string, unknown> })
          }
        })
      }
    })().catch((error) => {
      if (!disposed) console.error('语音事件监听失败', error)
    })

    return () => {
      disposed = true
      unlisten?.()
      unlistenDismiss?.()
      unsubscribe()
    }
  }, [captureContext, handoffInput, reportError, t])

  // 原始错误文本留在日志里；界面只呈现用户能理解的状态。
  // 连接层失败同时说明状态已过期，就地刷新，别让提示语继续停留在 ready。
  useEffect(() => {
    if (!errorText || !isVoiceTransportError(errorText)) return
    console.error('voice overlay error:', errorText)
    // 只有陈旧(ready)或未知(connecting)的状态需要刷新；模型加载中、麦克风未就绪
    // 这类更具体的降级保留，它们比一句笼统的"未连接"更有用。
    if (serviceState === 'ready' || serviceState === 'connecting') {
      recordVoiceStatusUnavailable()
    }
  }, [errorText, serviceState])

  // 界面部分交给输入区的 VoiceComposer/VoiceFeedbackBubble：提示要出现在球旁边，
  // 而不是窗口顶部把会话内容顶下去。这里只负责事件归约与状态刷新。
  return null
}
