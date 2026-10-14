import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { invoke } from '@tauri-apps/api/core'
import { cn } from '@/lib/utils'
import {
  VOICE_OVERLAY_HEIGHT,
  VOICE_OVERLAY_MOVED_EVENT,
  VOICE_OVERLAY_WIDTH,
} from '@/lib/window-surface'
import { useVoiceInputStore } from '@/stores/voice-input-store'

export type WindowSurfaceShellMode = 'main' | 'compact' | 'voice-overlay'

type WindowSurfaceShellProps = {
  mode: WindowSurfaceShellMode
  children: ReactNode
  className?: string
  testId?: string
}

type OverlayOrigin = { x: number; y: number }

/**
 * 浮窗（voice-overlay）窗口是整屏透明 surface——位置不能由客户端设置，
 * 所以真正的可见窗口是这里这个 460×620 的框，落点由后端按「悬浮球 + 偏移」算。
 *
 * 落点只在显示时取：挂载时取到的值等下次显示早就过期了。隐藏时先收起框再回执，
 * 因为窗口 unmapped 后 webview 不再渲染，留着的那一帧会在下次 map 时先亮出来
 * （SpacemiT K3 实测：先按旧落点画约 190ms 再跳到正确位置）。
 */
function useVoiceOverlayOrigin(enabled: boolean) {
  const [origin, setOrigin] = useState<OverlayOrigin | null>(null)

  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let generation = 0
    const load = () => {
      const requestGeneration = ++generation
      void invoke<[number, number]>('get_voice_overlay_position')
        .then(([x, y]) => {
          if (!disposed && generation === requestGeneration) setOrigin({ x, y })
        })
        .catch((error: unknown) => console.error('无法读取浮窗位置', error))
    }
    const onHidden = () => {
      generation += 1
      setOrigin(null)
      // 等两帧：收框那一帧真的提交给合成器之后，后端才取消映射。
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          void invoke('voice_overlay_blanked').catch(() => {})
        })
      )
    }
    const onMoved = (event: Event) => {
      const detail = (event as CustomEvent<OverlayOrigin>).detail
      if (detail) {
        generation += 1
        setOrigin({ x: detail.x, y: detail.y })
      }
    }

    window.addEventListener(VOICE_OVERLAY_MOVED_EVENT, onMoved)

    const unlisteners: Array<() => void> = []
    try {
      const appWindow = getCurrentWebviewWindow()
      if (typeof appWindow?.listen === 'function') {
        const subscriptions: Array<[string, () => void]> = [
          ['voice-overlay-shown', load],
          ['voice-overlay-hidden', onHidden],
        ]
        void Promise.all(subscriptions.map(async ([event, handler]) => {
          const unlisten = await appWindow.listen(event, handler)
          if (disposed) unlisten()
          else unlisteners.push(unlisten)
        })).then(async () => {
          if (disposed) return
          const visibilityGeneration = generation
          const visible = await appWindow.isVisible()
          if (visible && !disposed && generation === visibilityGeneration) load()
        }).catch((error: unknown) => console.error('无法同步浮窗可见性', error))
      }
    } catch {
      // 非 Tauri 环境（测试）：位置只由自定义事件驱动。
    }

    return () => {
      disposed = true
      window.removeEventListener(VOICE_OVERLAY_MOVED_EVENT, onMoved)
      unlisteners.forEach((fn) => fn())
    }
  }, [enabled])

  return origin
}

/** Shared outer shell; window mode only changes sizing and visual chrome. */
export function WindowSurfaceShell({ mode, children, className, testId }: WindowSurfaceShellProps) {
  const [isMaximized, setIsMaximized] = useState(false)
  // 只有 Linux 把浮窗做成整屏透明 surface：那里窗口不能被定位，位置只能落在内容框上。
  const isVoiceOverlay = mode === 'voice-overlay' && IS_LINUX
  const overlayOrigin = useVoiceOverlayOrigin(isVoiceOverlay)
  // 玻璃材质只给语音输入态：键盘态按 BIT-FLOAT-10 保持不透明实色底。
  // 这里读 store 而不是靠 CSS :has() 找输入框，是因为浮窗里可以既显示空态、
  // 又显示会话详情，两种树都可能不含输入框，属性挂在 shell 上才是稳定的。
  const voiceInputMode = useVoiceInputStore((state) => state.mode)
  const glassMode = mode === 'voice-overlay' && voiceInputMode === 'voice' ? 'voice' : undefined

  useEffect(() => {
    if (mode !== 'main' || !IS_TAURI) return

    let isMounted = true
    let unlisten: (() => void) | undefined

    try {
      const appWindow = getCurrentWebviewWindow()
      if (typeof appWindow.isMaximized === 'function') {
        appWindow
          .isMaximized()
          .then((max) => {
            if (isMounted) setIsMaximized(max)
          })
          .catch(() => {})
      }

      if (typeof appWindow.onResized === 'function') {
        appWindow
          .onResized(() => {
            if (typeof appWindow.isMaximized === 'function') {
              appWindow
                .isMaximized()
                .then((max) => {
                  if (isMounted) setIsMaximized(max)
                })
                .catch(() => {})
            }
          })
          .then((fn) => {
            unlisten = fn
          })
          .catch(() => {})
      }
    } catch {
      // Ignored if window handle fails or running in non-Tauri test
    }

    return () => {
      isMounted = false
      unlisten?.()
    }
  }, [mode])

  return (
    <div
      data-window-surface-shell={mode}
      data-maximized={isMaximized}
      data-glass={glassMode}
      data-testid={testId}
      // 落点没拿到之前先不显示：窗口是透明的，宁可晚一帧也不要先闪到原点上。
      style={
        isVoiceOverlay
          ? {
              position: 'absolute',
              left: overlayOrigin?.x ?? 0,
              top: overlayOrigin?.y ?? 0,
              width: VOICE_OVERLAY_WIDTH,
              height: VOICE_OVERLAY_HEIGHT,
              // 隐藏时要整棵子树退出渲染树：只做 visibility: hidden 的话，WebKit 只重画
              // 一部分，按钮这类被提升的合成层会留在合成器里，下次映射先亮出这些残留
              // 组件（SpacemiT K3 实测：左上角闪出标题行/按钮，卡片背景却是空的）。
              // 只在隐藏时写 display：类里是 flex flex-col，内联 display 会把它顶掉，
              // 子节点的 flex-1 就撑不开高度了。
              ...(overlayOrigin ? {} : { display: 'none' as const }),
            }
          : undefined
      }
      className={cn(
        mode === 'main'
          ? cn(
              'bg-neutral-50 dark:bg-background size-full relative overflow-hidden [transform:translateZ(0)]',
              isMaximized
                ? 'rounded-none border-0'
                : 'rounded-2xl border border-border/60',
            )
          : cn(
              'flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/95 text-foreground antialiased [transform:translateZ(0)]',
              !isVoiceOverlay && 'size-full',
            ),
        className,
      )}
    >
      {children}
    </div>
  )
}
