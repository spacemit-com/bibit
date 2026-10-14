import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useMemo, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

type WindowDragRegionProps = {
  children?: ReactNode
  className?: string
  title?: string
  'aria-label'?: string
}

/** Shared drag handle for every borderless application window. */
export function WindowDragRegion({
  children,
  className,
  title,
  'aria-label': ariaLabel,
}: WindowDragRegionProps) {
  const appWindow = useMemo(() => getCurrentWebviewWindow(), [])

  return (
    <div
      className={cn('cursor-grab active:cursor-grabbing', className)}
      title={title}
      aria-label={ariaLabel}
      data-tauri-drag-region
      // Capture the press before descendants (text/icons) or WebView controls
      // can consume it. This is important for a custom, borderless title bar:
      // the native drag request must be started from the original mouse press.
      onMouseDownCapture={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        void appWindow.startDragging().catch((error) => {
          console.error('无法拖动应用窗口', error)
        })
      }}
    >
      {children}
    </div>
  )
}
