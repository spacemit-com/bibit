import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'
import {
  applyVoiceEvent,
  clearSwitchIntents,
  noteVoiceSwitchTimeout,
  recordVoiceStatus,
  recordVoiceStatusUnavailable,
  SWITCH_INTENT_TIMEOUT_MS,
  SWITCH_TIMEOUT_MS,
  useVoiceStatusStore,
  type VoiceStatus,
} from '@/stores/voice-status-store'
import { isPlatformTauri } from '@/lib/platform/utils'

/**
 * 每个窗口只挂一次：把语音状态事件与窗口打开时的探测收敛成单一来源。
 * 打开窗口就查一次，用户不必先失败一次才知道语音不可用。
 * 识别引擎切换的在途状态与失败提示也归约到这里，视图只做投影。
 */
export function VoiceStatusBridge() {
  const switching = useVoiceStatusStore((state) => state.switching)
  const switchIntent = useVoiceStatusStore((state) => state.switchIntent)

  useEffect(() => {
    // 非 Tauri 运行（浏览器/单测）没有事件桥，静默跳过。
    if (!isPlatformTauri()) return
    let disposed = false
    const probe = () => {
      // 语音服务挂掉后不会再有状态推送，只能在每次窗口真正显示时重新问一次。
      void invoke<VoiceStatus>('voice_tool_get_status')
        .then((snapshot) => {
          if (!disposed) recordVoiceStatus(snapshot)
        })
        .catch(() => {
          if (!disposed) recordVoiceStatusUnavailable()
        })
    }
    const unlisten = listen<Record<string, unknown>>('voice-tool-event', (event) => {
      if (event.payload) applyVoiceEvent(event.payload)
    })
    // 浮窗常驻：每次被打开都要重新确认状态，不能只靠启动时那一次探测。
    const unlistenOpened = listen('voice-overlay-opened', probe)
    probe()
    return () => {
      disposed = true
      void unlisten.then((off) => off())
      void unlistenOpened.then((off) => off())
    }
  }, [])

  // 有界乐观：超过服务端启动超时的等待就转「未确认」并读一次快照对账，不做轮询。
  useEffect(() => {
    if (!switching) return
    const remaining = Math.max(0, switching.startedAt + SWITCH_TIMEOUT_MS - Date.now())
    const timer = window.setTimeout(() => {
      noteVoiceSwitchTimeout()
      void invoke<VoiceStatus>('voice_tool_get_status')
        .then((snapshot) => recordVoiceStatus(snapshot))
        .catch(() => {})
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [switching])

  // 开关意图同样要有界：服务端丢弃命令或回 BAD_COMMAND 时，界面不能永远停在「正在应用」。
  useEffect(() => {
    if (!switchIntent?.startedAt) return
    const remaining = Math.max(
      0,
      switchIntent.startedAt + SWITCH_INTENT_TIMEOUT_MS - Date.now()
    )
    const timer = window.setTimeout(() => {
      clearSwitchIntents()
      void invoke<VoiceStatus>('voice_tool_get_status')
        .then((snapshot) => recordVoiceStatus(snapshot))
        .catch(() => {})
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [switchIntent?.startedAt])

  return null
}
