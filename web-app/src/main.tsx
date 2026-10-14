import { StrictMode, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { VoiceBall } from '@/components/VoiceBall'
import { currentWindowSurface } from '@/lib/window-surface'
import { installConsoleLogForwarding } from '@/services/app/console-logger'
import { logStartupTrace, traceStartup } from '@/services/app/startup-trace'

import './index.css'

// Mobile-specific viewport and styling setup
const setupMobileViewport = () => {
  // Check if running on mobile platform (iOS/Android via Tauri)
  const isMobile =
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    window.matchMedia('(max-width: 768px)').matches

  if (isMobile) {
    // Update viewport meta tag to disable zoom
    const viewportMeta = document.querySelector('meta[name="viewport"]')
    if (viewportMeta) {
      viewportMeta.setAttribute(
        'content',
        'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
      )
    }

    // Add mobile-specific styles for status bar
    const style = document.createElement('style')
    style.textContent = `
      body {
        padding-top: env(safe-area-inset-top);
        padding-bottom: env(safe-area-inset-bottom);
        padding-left: env(safe-area-inset-left);
        padding-right: env(safe-area-inset-right);
      }

      #root {
        min-height: calc(100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom));
      }

      /* Prevent zoom on input focus */
      input, textarea, select {
        font-size: 16px !important;
      }
    `
    document.head.appendChild(style)
  }
}

// Prevent browser from opening dropped files
const preventDefaultFileDrop = () => {
  document.addEventListener('dragover', (e) => {
    e.preventDefault()
  })
  document.addEventListener('drop', (e) => {
    e.preventDefault()
  })
}

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}

const renderRoot = (content: ReactNode) => {
  const rootElement = document.getElementById('root')
  if (!rootElement || rootElement.innerHTML) return false

  ReactDOM.createRoot(rootElement).render(<StrictMode>{content}</StrictMode>)
  return true
}

// ExtensionProvider emits `app-ready` once the gated UI is mounted.
const appReady = async (): Promise<void> => {
  try {
    const { once } = await import('@tauri-apps/api/event')
    await new Promise<void>((resolve) => {
      void once('app-ready', () => resolve())
    })
  } catch {
    // Non-Tauri (vite dev host) has no event bus; warm the cache right away.
  }
}

const boot = async () => {
  traceStartup('boot_start')
  const surface = currentWindowSurface()
  // 每个 webview 都有自己的 JS 上下文，语言包也得各自加载。浮窗窗面里也有 t()
  // 出来的文案（悬浮球 tooltip / aria-label），少这一步就会退回显示 i18n key。
  // The base locales carry no feature-registry dependency and take real time to
  // fetch and evaluate, so start them now and let them overlap the plugin IPC
  // below instead of running after it.
  const localesReady = import('./i18n').then(({ ensureLocalesLoaded }) =>
    ensureLocalesLoaded()
  )
  if (surface === 'voice-ball') {
    document.documentElement.classList.add('bibit-voice-surface')
    document.body.classList.add('bibit-voice-surface')
    await localesReady
    const content = <VoiceBall />
    if (renderRoot(content)) document.body.classList.add('loaded')
    return
  }

  if (surface === 'main') {
    // 扩展的类模块原本整段取数延迟落在首帧门控的
    // `ext_register` 里（实测 168ms，其中解析只占约 35ms）；这里在 boot 起点
    // 先把 fetch 打出去，让它和后面的插件/注册表 IPC 重叠（浮窗窗面不需要）。
    void import('@/services/core/bundled-extensions')
      .then(({ prefetchBundledExtensionClasses }) =>
        void prefetchBundledExtensionClasses()
      )
      .catch(() => {})
  }

  installConsoleLogForwarding()
  console.info(
    '[surface-diag] window=',
    getCurrentWindow().label,
    'webview=',
    getCurrentWebviewWindow().label,
    'surface=',
    currentWindowSurface()
  )
  setupMobileViewport()
  preventDefaultFileDrop()

  if (surface === 'main') {
    const [
      { loadTrustedPluginEntries },
      { bootstrapStaticFeatureRegistry, setRuntimeFeatureRegistry },
      { loadRuntimeFeatureCapabilityGrants },
    ] = await Promise.all([
      import('./features/host/trustedPluginLoader'),
      import('@/features/activeFeatureRegistry'),
      import('@/features/host-api'),
    ])
    traceStartup('feature_modules_ready')
    await bootstrapStaticFeatureRegistry()
    traceStartup('static_registry_ready')
    const [pluginEntries] = await Promise.all([
      loadTrustedPluginEntries(),
      loadRuntimeFeatureCapabilityGrants(),
    ])
    traceStartup('feature_entries_ready')
    setRuntimeFeatureRegistry(pluginEntries)
    // Feature Registry projections freeze their input when the module that
    // builds them is evaluated, so the projection host must load only after the
    // runtime entries are merged in. Importing it earlier silently drops every
    // dynamic plugin page and navigation entry; do not hoist this import.
    await import('@/features/host/registry')
    traceStartup('host_registry_ready')
  }
  // Dynamic imports keep store hydration off the static boot graph.
  const { routeTree } = await import('./routeTree.gen')
  traceStartup('route_tree_ready')
  await localesReady
  traceStartup('i18n_ready')

  const router = createRouter({ routeTree })

  // Subscribe before rendering so the signal cannot be missed.
  const windowReady = surface === 'main' ? appReady() : undefined

  renderRoot(<RouterProvider router={router} />)
  traceStartup('rendered')
  logStartupTrace()

  if (surface === 'main') {
    const [{ activeFeatureRegistry }, { preloadFeatureNavigationLocales }] =
      await Promise.all([
        import('@/features/activeFeatureRegistry'),
        import('./features/host/preloadFeatureNavigationLocales'),
      ])
    // The plugin entry bundles are ~1.4 MB of JS the main thread has to parse
    // and evaluate; importing them here ran ahead of React's first commit and
    // held the window back by seconds. The labels they carry are only
    // observable once the sidebar renders, so warm them up after the UI.
    void windowReady?.then(() => {
      traceStartup('feature_preload_begin')
      preloadFeatureNavigationLocales(activeFeatureRegistry)
    })
  }
}

boot().catch((e) => console.error('Failed to boot app:', e))
