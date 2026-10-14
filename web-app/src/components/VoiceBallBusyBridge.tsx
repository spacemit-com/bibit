import { useEffect } from 'react'
import { emitTo } from '@tauri-apps/api/event'
import { isPlatformTauri } from '@/lib/platform/utils'
import { useThreads } from '@/hooks/useThreads'
import { isSessionBusy, useChatSessions } from '@/stores/chat-session-store'
import { useOverlayConversationStore } from '@/stores/overlay-conversation-store'
import { useVoiceInputStore } from '@/stores/voice-input-store'

/**
 * 把「球该不该显示思考态」推给悬浮球。
 *
 * 悬浮球活在自己的 webview 里，读不到本窗口的 store，只认
 * `voice-ball:set-thinking` 事件（见 VoiceBall.tsx）。这里是它唯一的发送方：
 * Rust 侧只驱动 listening，两边都写会互相覆盖。
 *
 * 思考态要盖住三段才不闪：转写在跑、定稿正在交接、当前会话在干活。
 * 只认最后一段的话，转文本成功到回答开始之间球会掉回空闲态。
 */
export function VoiceBallBusyBridge() {
  useEffect(() => {
    // vite define 的 IS_TAURI 在 vitest 下恒为 false，用可 mock 的运行时守卫。
    if (!isPlatformTauri()) return

    let lastSent: boolean | undefined
    const publish = () => {
      const { currentThreadId } = useThreads.getState()
      const thinking =
        useVoiceInputStore.getState().phase === 'recognizing' ||
        useVoiceInputStore.getState().pending.length > 0 ||
        useOverlayConversationStore.getState().busy ||
        useOverlayConversationStore.getState().handingOff > 0 ||
        (currentThreadId
          ? isSessionBusy(useChatSessions.getState().sessions[currentThreadId])
          : false)
      // 只在跨越边沿时发，避免每个 streaming chunk 都打一次 IPC。
      if (thinking === lastSent) return
      lastSent = thinking
      void emitTo('voice-ball', 'voice-ball:set-thinking', { thinking })
    }

    publish()
    // 会话切换、流式状态、转写阶段和交接计数都会改变结论，四个 store 都要订阅。
    const unsubscribeSessions = useChatSessions.subscribe(publish)
    const unsubscribeThreads = useThreads.subscribe(publish)
    const unsubscribeVoice = useVoiceInputStore.subscribe(publish)
    const unsubscribeOverlay = useOverlayConversationStore.subscribe(publish)
    return () => {
      unsubscribeSessions()
      unsubscribeThreads()
      unsubscribeVoice()
      unsubscribeOverlay()
      // 卸载时清掉忙碌态，否则球会一直转。
      if (lastSent) void emitTo('voice-ball', 'voice-ball:set-thinking', { thinking: false })
    }
  }, [])

  return null
}
