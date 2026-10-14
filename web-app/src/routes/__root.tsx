import { OverlayConversationLifecycle } from '@/components/OverlayConversationLifecycle'
import { createRootRoute, Outlet, useLocation } from '@tanstack/react-router'
import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
// import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import BackendUpdater from '@/containers/dialogs/BackendUpdater'
import { Fragment } from 'react/jsx-runtime'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { InterfaceProvider } from '@/providers/InterfaceProvider'
import { KeyboardShortcutsProvider } from '@/providers/KeyboardShortcuts'
import { DataProvider } from '@/providers/DataProvider'
import { route } from '@/constants/routes'
import { ExtensionProvider } from '@/providers/ExtensionProvider'
import { ToasterProvider } from '@/providers/ToasterProvider'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { TranslationProvider } from '@/i18n/TranslationContext'
import OutOfContextPromiseModal from '@/containers/dialogs/OutOfContextDialog'
import AttachmentIngestionDialog from '@/containers/dialogs/AttachmentIngestionDialog'
import GlobalError from '@/containers/GlobalError'
import { GlobalEventHandler } from '@/providers/GlobalEventHandler'
import { ServiceHubProvider } from '@/providers/ServiceHubProvider'
import { ConversationSyncProvider } from '@/providers/ConversationSyncProvider'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { LeftSidebar, NavigationDialogs } from '@/components/left-sidebar'
import { WindowControls } from '@/components/WindowControls'
import { WindowResizeGrips } from '@/components/WindowResizeGrips'
import ErrorDialog from '@/containers/dialogs/ErrorDialog'
import LlamacppBusyOnExitDialog from '@/containers/dialogs/LlamacppBusyOnExitDialog'
import LlamacppOomListener from '@/containers/dialogs/LlamacppOomListener'
import MissingDependenciesDialog from '@/containers/dialogs/MissingDependenciesDialog'
import { StatusPopupHeader } from '@/components/StatusPopupHeader'
import { currentWindowSurface } from '@/lib/window-surface'
import { useSettingsNavigation } from '@/hooks/useSettingsNavigation'
import { VoiceOverlayBridge } from '@/components/VoiceOverlayBridge'
import { VoiceStatusBridge } from '@/components/VoiceStatusBridge'
import { WindowDragRegion } from '@/components/WindowDragRegion'
import { WindowSurfaceShell } from '@/components/WindowSurfaceShell'
import { VoiceBallBusyBridge } from '@/components/VoiceBallBusyBridge'
import { useTranslation } from '@/i18n'
import { traceStartup } from '@/services/app/startup-trace'

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: ({ error }) => <GlobalError error={error} />,
})

const AppLayout = () => {
  // 归因用：React 第一次真正调用 AppLayout 的时刻（finishedSetup 之后）。
  if (!appLayoutRenderMarked) {
    appLayoutRenderMarked = true
    traceStartup('app_layout_render')
  }
  const { t } = useTranslation()
  const { href, pathname } = useLocation()
  const isSettingsRoute =
    pathname === route.settings.index ||
    pathname.startsWith(`${route.settings.index}/`)
  const setSettingsOrigin = useSettingsNavigation((state) => state.setOrigin)
  const {
    open: isLeftPanelOpen,
    setLeftPanel,
    width: sidebarWidth,
    setLeftPanelWidth,
  } = useLeftPanel()

  useEffect(() => {
    if (!isSettingsRoute) setSettingsOrigin(href)
  }, [href, isSettingsRoute, setSettingsOrigin])

  return (
    <WindowSurfaceShell mode="main">
      <SidebarProvider
        open={isLeftPanelOpen}
        onOpenChange={setLeftPanel}
        defaultWidth={sidebarWidth}
        onWidthChange={setLeftPanelWidth}
      >
        <KeyboardShortcutsProvider />
        <NavigationDialogs />
        {/* Fake absolute panel top to enable window drag */}
        {IS_LINUX && (
          <>
            <WindowControls />
            <WindowResizeGrips />
          </>
        )}
        {IS_TAURI && (
          <WindowDragRegion
            className="fixed w-full h-12 z-20 top-0 cursor-grab active:cursor-grabbing"
            title={t('common:dragWindow')}
            aria-label={t('common:windowDragArea')}
          />
        )}
        <BackendUpdater />
        {!isSettingsRoute && <LeftSidebar />}
        <SidebarInset>
          <div className="bg-neutral-50 dark:bg-background size-full">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </WindowSurfaceShell>
  )
}

const LogsLayout = () => {
  return (
    <Fragment>
      <main className="relative h-svh text-sm antialiased select-text bg-app">
        <div className="flex h-full">
          {/* Main content panel */}
          <div className="h-full flex w-full">
            <div className="bg-background text-foreground border w-full overflow-hidden">
              <Outlet />
            </div>
          </div>
        </div>
      </main>
    </Fragment>
  )
}

const StatusPopupLayout = () => {
  const isVoiceOverlay = currentWindowSurface() === 'voice-overlay'
  console.info(
    '[status-popup-layout] surface=',
    currentWindowSurface(),
    'isVoiceOverlay=',
    isVoiceOverlay
  )

  useEffect(() => {
    const hideOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      void invoke(isVoiceOverlay ? 'hide_voice_overlay' : 'hide_status_popup')
    }
    window.addEventListener('keydown', hideOnEscape)
    return () => window.removeEventListener('keydown', hideOnEscape)
  }, [isVoiceOverlay])

  return (
    <WindowSurfaceShell
      mode={isVoiceOverlay ? 'voice-overlay' : 'compact'}
      className="status-popup-layout"
      testId="status-popup-layout"
    >
      <StatusPopupHeader />
      {!isVoiceOverlay && <WindowResizeGrips />}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {isVoiceOverlay && <><OverlayConversationLifecycle /><VoiceOverlayBridge /><VoiceBallBusyBridge /></>}
        <Outlet />
      </main>
    </WindowSurfaceShell>
  )
}

// 归因用：只记第一次渲染，之后的重渲染不再打点。
let rootRenderMarked = false
let appLayoutRenderMarked = false

function RootLayout() {
  if (!rootRenderMarked) {
    rootRenderMarked = true
    traceStartup('root_render')
  }
  const surface = currentWindowSurface()
  const isStatusPopup = surface === 'status-popup'
  const isVoiceOverlay = surface === 'voice-overlay'
  const getInitialLayoutType = () => {
    const pathname = window.location.pathname
    return (
      pathname === route.systemMonitor ||
      pathname === route.appLogs
    )
  }

  const IS_LOGS_ROUTE = getInitialLayoutType()

  return (
    <Fragment>
      <ServiceHubProvider>
        <ConversationSyncProvider>
          <ThemeProvider />
          <InterfaceProvider />
          <ToasterProvider />
          <TranslationProvider>
            <ExtensionProvider>
              <DataProvider />
              <VoiceStatusBridge />
              <GlobalEventHandler />
              {isStatusPopup || isVoiceOverlay ? (
                <StatusPopupLayout />
              ) : IS_LOGS_ROUTE ? (
                <LogsLayout />
              ) : (
                <AppLayout />
              )}
            </ExtensionProvider>
            {/* <TanStackRouterDevtools position="bottom-right" /> */}
            {!isStatusPopup && !isVoiceOverlay && <AttachmentIngestionDialog />}
            {!isStatusPopup && !isVoiceOverlay && <ErrorDialog />}
            {!isStatusPopup && !isVoiceOverlay && <LlamacppBusyOnExitDialog />}
            {!isStatusPopup && !isVoiceOverlay && <LlamacppOomListener />}
            {!isStatusPopup && !isVoiceOverlay && <MissingDependenciesDialog />}
            {!isStatusPopup && !isVoiceOverlay && <OutOfContextPromiseModal />}
          </TranslationProvider>
        </ConversationSyncProvider>
      </ServiceHubProvider>
    </Fragment>
  )
}
