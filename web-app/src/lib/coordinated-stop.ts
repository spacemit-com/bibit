import { invoke } from '@tauri-apps/api/core'

type InvokeCommand = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>

export async function cancelCoordinatedSessionRun(
  sessionId: string,
  enabled = IS_TAURI,
  invokeCommand: InvokeCommand = invoke,
  runtimeEnabled = false
): Promise<boolean> {
  if (!enabled) return false
  return Boolean(
    await invokeCommand(
      runtimeEnabled
        ? 'conversation_cancel_runtime_run'
        : 'conversation_cancel_session_run',
      { sessionId }
    )
  )
}
