import { useThreads } from '@/hooks/useThreads'
import { usePrompt } from '@/hooks/usePrompt'
import { NEW_THREAD_ATTACHMENT_KEY, useChatAttachments } from '@/hooks/useChatAttachments'
import { useRuntimeStore } from '@/stores/runtime-store'
import { isSessionBusy, useChatSessions } from '@/stores/chat-session-store'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useVoiceInputStore } from '@/stores/voice-input-store'
import { create } from 'zustand'

// 浮窗拥有自己的交流边界，不从主窗口当前选择推断会话。
export const useOverlayConversationStore = create<{
  previousSessionId?: string
  previousTargetId?: string
  previousDraft?: string
  generation: number
  busy: boolean
  handingOff: number
}>(() => ({ generation: 0, busy: false, handingOff: 0 }))

export function shouldKeepOverlayConversation(input: {
  busy: boolean
  draft: string
  attachments: number
  pending: number
}) {
  return input.busy || Boolean(input.draft.trim()) || input.attachments > 0 || input.pending > 0
}

export function overlayHasUnfinishedWork() {
  const { currentThreadId, currentThreadTargetId } = useThreads.getState()
  const key = useRuntimeStore.getState().enabled
    ? JSON.stringify([currentThreadTargetId ?? '', currentThreadId ?? NEW_THREAD_ATTACHMENT_KEY])
    : currentThreadId ?? NEW_THREAD_ATTACHMENT_KEY
  const state = useOverlayConversationStore.getState()
  return shouldKeepOverlayConversation({
    busy: state.busy || isSessionBusy(currentThreadId ? useChatSessions.getState().sessions[currentThreadId] : undefined),
    draft: usePrompt.getState().prompt || useVoiceInputStore.getState().error,
    attachments: useChatAttachments.getState().getAttachments(key).length,
    pending: state.handingOff + useVoiceInputStore.getState().pending.length +
      (currentThreadId ? useMessageQueue.getState().getQueue(currentThreadId).length : 0),
  })
}

export function clearOverlayConversation() {
  const { currentThreadId, currentThreadTargetId } = useThreads.getState()
  if (currentThreadId) useOverlayConversationStore.setState({
    previousSessionId: currentThreadId, previousTargetId: currentThreadTargetId, previousDraft: usePrompt.getState().prompt,
  })
  useOverlayConversationStore.setState(state => ({ generation: state.generation + 1 }))
  useThreads.setState({ currentThreadId: undefined })
  usePrompt.setState({ prompt: '' })
}

