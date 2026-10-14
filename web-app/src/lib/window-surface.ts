import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

export type WindowSurface = 'main' | 'status-popup' | 'voice-ball' | 'voice-overlay'

/** 浮窗内容框落点变更（拖动落盘后由后端坐标回填），载荷 { x, y }。 */
export const VOICE_OVERLAY_MOVED_EVENT = 'voice-overlay-moved'

/** 浮窗可视尺寸：窗口是整屏透明 surface，内容框按这个尺寸画。与 Rust 侧常量一致。 */
export const VOICE_OVERLAY_WIDTH = 460
export const VOICE_OVERLAY_HEIGHT = 620

// Authoritative, per-window surface. Computed once at first call and cached:
// each webview runs its own JS context, so the cache is naturally scoped to
// the current window and the label never changes for the lifetime of a window.
let cachedSurface: WindowSurface | null = null

export function resolveWindowSurface(label: string): WindowSurface {
  if (label === 'status-popup') return 'status-popup'
  if (label === 'voice-ball') return 'voice-ball'
  if (label === 'voice-overlay') return 'voice-overlay'
  return 'main'
}

export function currentWindowSurface(): WindowSurface {
  if (cachedSurface === null) {
    cachedSurface = IS_TAURI
      ? resolveWindowSurface(getCurrentWebviewWindow().label)
      : 'main'
  }
  return cachedSurface
}

export function shouldStopRuntimeOnPageHide(
  surface: WindowSurface,
  durableSessions: boolean
): boolean {
  return surface === 'main' && !durableSessions
}
