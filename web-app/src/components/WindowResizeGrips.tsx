import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { invoke } from '@tauri-apps/api/core'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  currentWindowSurface,
  VOICE_OVERLAY_HEIGHT,
  VOICE_OVERLAY_MOVED_EVENT,
  VOICE_OVERLAY_WIDTH,
} from '@/lib/window-surface'

// @tauri-apps/api declares ResizeDirection locally but doesn't export it.
type ResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West'

/**
 * Invisible edge/corner grips that restore window resizing for a borderless
 * window. A decorations:false window on Wayland has no compositor-drawn resize
 * handles, so each grip forwards to the compositor's interactive resize.
 */
const GRIP = 'fixed z-[60]'
const EDGE = 4
const CORNER = 16

type PopupGeometry = {
  screenIndex: number
  width: number
  height: number
  rightMargin: number
  bottomMargin: number
}

type PopupGeometryStatus = { popupGeometry: PopupGeometry }
type PopupDrag = ResizeDirection | 'Move'

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)))

// eslint-disable-next-line react-refresh/only-export-components
export const adjustPopupGeometry = (
  geometry: PopupGeometry,
  direction: PopupDrag,
  dx: number,
  dy: number
): PopupGeometry => {
  if (direction === 'Move') {
    return {
      ...geometry,
      rightMargin: Math.max(0, geometry.rightMargin - Math.round(dx)),
      bottomMargin: Math.max(0, geometry.bottomMargin - Math.round(dy)),
    }
  }

  let { width, height, rightMargin, bottomMargin } = geometry
  if (direction.includes('East')) {
    const next = clamp(width + dx, 300, 600)
    rightMargin = Math.max(0, rightMargin - (next - width))
    width = next
  }
  if (direction.includes('West')) width = clamp(width - dx, 300, 600)
  if (direction.includes('South')) {
    const next = clamp(height + dy, 400, 800)
    bottomMargin = Math.max(0, bottomMargin - (next - height))
    height = next
  }
  if (direction.includes('North')) height = clamp(height - dy, 400, 800)
  return { ...geometry, width, height, rightMargin, bottomMargin }
}

// eslint-disable-next-line react-refresh/only-export-components
export const startPopupGeometryDrag = (
  event: ReactPointerEvent<HTMLElement>,
  direction: PopupDrag
) => {
  if (
    direction === 'Move' &&
    (event.target as HTMLElement).closest('button, a, input, [role="menuitem"]')
  ) {
    return
  }
  const startX = event.clientX
  const startY = event.clientY
  const geometry = invoke<PopupGeometryStatus>('desktop_integration_status')
  const finish = (end: PointerEvent) => {
    const dx = end.clientX - startX
    const dy = end.clientY - startY
    void geometry.then((status) =>
      invoke(
        'desktop_integration_set_popup_geometry',
        adjustPopupGeometry(status.popupGeometry, direction, dx, dy)
      )
    )
  }
  window.addEventListener('pointerup', finish, { once: true })
}

/**
 * 语音浮窗标题栏拖动。窗口是整屏透明 surface（和悬浮球同一套），所以拖动动的是内容框：
 * 框先本地挪（窗口不动 → clientX 参考系稳定，零 IPC 往返），松手再把整段位移交给后端，
 * 由后端折算成「相对悬浮球的偏移」落盘并夹进可用区，回一个最终落点。
 * 不能用 data-tauri-drag-region：那是发起原生移动，抓取带来的失焦会被浮窗当成
 * 「用户点到别处」而隐藏自己。
 */
// eslint-disable-next-line react-refresh/only-export-components
export const startVoiceOverlayDrag = (event: ReactPointerEvent<HTMLElement>) => {
  if (event.button !== 0) return
  if ((event.target as HTMLElement).closest('button, a, input, [role="menuitem"]')) {
    return
  }
  // 标题栏不该选中文字（tauri 的 drag-region 也是这么做的）。
  event.preventDefault()

  // Linux 之外没有整屏 surface：窗口本身就是那个小窗，只能走原生移动。
  if (!IS_LINUX) {
    void getCurrentWebviewWindow()
      .startDragging()
      .catch((error: unknown) => console.error('无法拖动语音输入弹窗', error))
    return
  }

  const node = document.querySelector<HTMLElement>(
    '[data-window-surface-shell="voice-overlay"]'
  )
  if (!node) return

  const startLeft = node.offsetLeft
  const startTop = node.offsetTop
  const startX = event.clientX
  const startY = event.clientY
  let settled = false
  let previewLeft = startLeft
  let previewTop = startTop

  // 预览就按可用区夹住：surface 本身铺满可用区（实测 1920×1036），窗口尺寸就是边界。
  // 不夹的话，往屏幕边拖时预览会跟着手越过边界，松手那一刻后端才把落点夹进可用区——
  // 用户看到的就是「拖完松手又跳回原处」（贴着边每次都会跳）。
  const limitX = Math.max(window.innerWidth - VOICE_OVERLAY_WIDTH, 0)
  const limitY = Math.max(window.innerHeight - VOICE_OVERLAY_HEIGHT, 0)

  const place = (x: number, y: number) => {
    node.style.left = `${x}px`
    node.style.top = `${y}px`
  }

  const onMove = (move: PointerEvent) => {
    // clientX 是分数像素（指针加速 / 缩放下不是整数），预览和后端一样只收整数。
    previewLeft = Math.min(Math.max(Math.round(startLeft + (move.clientX - startX)), 0), limitX)
    previewTop = Math.min(Math.max(Math.round(startTop + (move.clientY - startY)), 0), limitY)
    place(previewLeft, previewTop)
  }

  const finish = () => {
    if (settled) return
    settled = true
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)

    // 位移按预览位置算：贴边时它已经停在边界上，发出去的位移和用户看到的位置一致，
    // 松手不会再跳一次。分数像素在 preview 那一步已经取整。
    const deltaX = previewLeft - startLeft
    const deltaY = previewTop - startTop
    if (!deltaX && !deltaY) return

    void invoke<[number, number]>('update_voice_overlay_offset', { deltaX, deltaY })
      .then(([x, y]) => {
        place(x, y)
        window.dispatchEvent(
          new CustomEvent(VOICE_OVERLAY_MOVED_EVENT, { detail: { x, y } })
        )
      })
      .catch((error: unknown) => {
        // 后端没落盘就把框放回原处：不能让「看到的位置」和「记住的位置」分叉。
        console.error('无法移动语音输入弹窗', error)
        place(startLeft, startTop)
      })
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
}

const startResize =
  (direction: ResizeDirection) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (currentWindowSurface() === 'status-popup') {
      event.preventDefault()
      startPopupGeometryDrag(event, direction)
      return
    }
    void getCurrentWebviewWindow().startResizeDragging(direction)
  }

export const WindowResizeGrips = () => (
  <>
    <div
      className={GRIP}
      style={{ top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' }}
      onPointerDown={startResize('North')}
    />
    <div
      className={GRIP}
      style={{ bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' }}
      onPointerDown={startResize('South')}
    />
    <div
      className={GRIP}
      style={{ top: CORNER, bottom: CORNER, left: 0, width: EDGE, cursor: 'ew-resize' }}
      onPointerDown={startResize('West')}
    />
    <div
      className={GRIP}
      style={{ top: CORNER, bottom: CORNER, right: 0, width: EDGE, cursor: 'ew-resize' }}
      onPointerDown={startResize('East')}
    />
    <div
      className={GRIP}
      style={{ top: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' }}
      onPointerDown={startResize('NorthWest')}
    />
    <div
      className={GRIP}
      style={{ top: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' }}
      onPointerDown={startResize('NorthEast')}
    />
    <div
      className={GRIP}
      style={{ bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' }}
      onPointerDown={startResize('SouthWest')}
    />
    <div
      className={GRIP}
      style={{ bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' }}
      onPointerDown={startResize('SouthEast')}
    />
  </>
)
