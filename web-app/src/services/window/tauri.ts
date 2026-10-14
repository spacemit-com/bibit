/**
 * Tauri Window Service - Desktop implementation
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { WindowConfig, WebviewWindowInstance } from './types'
import i18n from '@/i18n/setup'
import { DefaultWindowService } from './default'
import { useTheme } from '@/hooks/useTheme'
import type { AppThemePayload } from '@/services/theme/authority'

export class TauriWindowService extends DefaultWindowService {
  async createWebviewWindow(
    config: WindowConfig
  ): Promise<WebviewWindowInstance> {
    try {
      // Take the window theme from the authority's resolved value. Reading a
      // webview-side key here (the old `jan-theme` entry) let a new window fall
      // back to the desktop's light theme while the app was dark.
      const { isDark } = useTheme.getState()
      const theme: 'light' | 'dark' = isDark ? 'dark' : 'light'

      const webviewWindow = new WebviewWindow(config.label, {
        url: config.url,
        title: config.title,
        width: config.width,
        height: config.height,
        center: config.center,
        resizable: config.resizable,
        minimizable: config.minimizable,
        maximizable: config.maximizable,
        closable: config.closable,
        fullscreen: config.fullscreen,
        theme: theme,
        devtools: false,
      })

      // Setup theme listener for this window
      this.setupThemeListenerForWindow(webviewWindow)

      return this.toWindowInstance(config.label, webviewWindow)
    } catch (error) {
      console.error('Error creating Tauri window:', error)
      throw error
    }
  }

  async getWebviewWindowByLabel(
    label: string
  ): Promise<WebviewWindowInstance | null> {
    try {
      const existingWindow = await WebviewWindow.getByLabel(label)

      if (existingWindow) {
        return this.toWindowInstance(label, existingWindow)
      }

      return null
    } catch (error) {
      console.error('Error getting Tauri window by label:', error)
      return null
    }
  }

  async openWindow(config: WindowConfig): Promise<void> {
    // Check if window already exists first
    const existing = await this.getWebviewWindowByLabel(config.label)
    if (existing) {
      await existing.show()
      await existing.focus()
    } else {
      await this.createWebviewWindow(config)
    }
  }

  // 窗口标题在创建时按当前界面语言落定，之后切换语言不会回头改已打开的窗口。
  async openLogsWindow(): Promise<void> {
    try {
      await this.openWindow({
        url: '/logs',
        label: 'logs-app-window',
        title: i18n.t('settings:windowTitle.appLogs'),
        width: 800,
        height: 600,
        resizable: true,
        center: true,
      })
    } catch (error) {
      console.error('Error opening logs window in Tauri:', error)
      throw error
    }
  }

  async openSystemMonitorWindow(): Promise<void> {
    try {
      await this.openWindow({
        url: '/system-monitor',
        label: 'system-monitor-window',
        title: i18n.t('settings:windowTitle.systemMonitor'),
        width: 1000,
        height: 700,
        resizable: true,
        center: true,
      })
    } catch (error) {
      console.error('Error opening system monitor window in Tauri:', error)
      throw error
    }
  }

  private toWindowInstance(
    label: string,
    webviewWindow: WebviewWindow
  ): WebviewWindowInstance {
    return {
      label,
      async close() {
        await webviewWindow.close()
      },
      async show() {
        await webviewWindow.show()
      },
      async hide() {
        await webviewWindow.hide()
      },
      async focus() {
        await webviewWindow.setFocus()
      },
      async setTitle(title: string) {
        await webviewWindow.setTitle(title)
      },
    }
  }

  private setupThemeListenerForWindow(window: WebviewWindow): void {
    // Follow the authoritative broadcast, not the window's own theme changes.
    import('@tauri-apps/api/event')
      .then(({ listen }) => {
        return listen<AppThemePayload>('app-theme-changed', async (event) => {
          const resolved = event.payload?.resolved
          if (resolved !== 'dark' && resolved !== 'light') return
          try {
            await window.setTheme(resolved)
          } catch (err) {
            console.error('Failed to update window theme:', err)
          }
        })
      })
      .catch((err) => {
        console.error('Failed to setup theme listener for window:', err)
      })
  }
}
