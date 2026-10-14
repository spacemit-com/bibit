import { ExtensionManager } from '@/lib/extension'
import { APIs } from '@/lib/service'
import { EventEmitter } from '@/services/events/EventEmitter'
import { EngineManager, ModelManager } from '@janhq/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit } from '@tauri-apps/api/event'
import { PropsWithChildren, useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { logStartupTrace, traceStartup } from '@/services/app/startup-trace'

// Secondary windows (logs, system monitor) reuse the same React bundle but
// their Tauri capabilities do not grant hardware:*/llamacpp:*/etc. Loading
// extensions there triggers ACL-denied invokes and would double-spawn the
// llama-server router. Gate the whole pipeline on the main window.
function isMainWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === 'main'
  } catch {
    return true
  }
}

type SetupStatus = { key: string; vars?: Record<string, unknown> } | null

export function ExtensionProvider({ children }: PropsWithChildren) {
  const { t } = useTranslation()
  const [finishedSetup, setFinishedSetup] = useState(false)
  const [status, setStatus] = useState<SetupStatus>(null)
  const setupExtensions = useCallback(async () => {
    // Setup core window object for both platforms
    window.core = {
      api: APIs,
    }

    window.core.events = new EventEmitter()
    window.core.extensionManager = new ExtensionManager()
    window.core.engineManager = new EngineManager()
    window.core.modelManager = new ModelManager()

    if (!isMainWindow()) {
      setFinishedSetup(true)
      return
    }

    // Register extensions - same pattern for both platforms.
    // Always finish setup even if registration/load throws so a single
    // faulty extension can't gate the entire UI.
    try {
      setStatus({ key: 'registeringExtensions' })
      traceStartup('ext_register_begin')
      await ExtensionManager.getInstance().registerActive()
      traceStartup('ext_register_end')
    } catch (e) {
      console.error('Extension setup failed:', e)
    } finally {
      // The catalogue is registered, so the UI can render. onLoad() per
      // extension is the slow half (migrations, native probes) and it used to
      // hold the splash up for seconds after the app was usable. It now warms
      // up behind the window; settings and engines appear as each one lands.
      setFinishedSetup(true)
    }

    await ExtensionManager.getInstance()
      .load((done, total) => {
        traceStartup(`ext_loaded_${done}of${total}`)
      })
      .catch((e) => {
        console.error('Extension load failed:', e)
      })
    traceStartup('ext_load_done')
    logStartupTrace(true)
  }, [])

  useEffect(() => {
    // Watchdog: a hung extension (stuck migration, blocked invoke) must never
    // leave the app on a blank window. Setup still completes in the background.
    traceStartup('ext_setup_begin')
    const watchdog = setTimeout(() => {
      console.warn('Extension setup exceeded timeout; rendering UI anyway.')
      setFinishedSetup(true)
    }, 20000)

    setupExtensions().finally(() => clearTimeout(watchdog))

    return () => {
      clearTimeout(watchdog)
      if (isMainWindow()) {
        ExtensionManager.getInstance().unload()
      }
    }
  }, [setupExtensions])

  useEffect(() => {
    const caption = document.getElementById('initial-loader-caption')
    if (caption) {
      caption.textContent = status ? t(status.key, status.vars) : t('settingUpJan')
    }
  }, [status, t])

  // Dismiss the loader only once the gated UI is ready, not on a fixed timer.
  useEffect(() => {
    if (!finishedSetup) return
    traceStartup('ui_ready')
    logStartupTrace(true)
    if (isMainWindow()) emit('app-ready').catch(() => {})
    let removeTimer: ReturnType<typeof setTimeout>
    const raf = requestAnimationFrame(() => {
      document.body.classList.add('loaded')
      traceStartup('shell_paint')
      removeTimer = setTimeout(() => {
        document.getElementById('initial-loader')?.remove()
        traceStartup('loader_removed')
        logStartupTrace(true)
      }, 300)
    })
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(removeTimer)
    }
  }, [finishedSetup])

  return <>{finishedSetup && children}</>
}
