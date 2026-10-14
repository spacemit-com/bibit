/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

const h = vi.hoisted(() => ({
  leftPanelOpen: true,
  sidebarWidth: 260,
  setLeftPanel: vi.fn(),
  setLeftPanelWidth: vi.fn(),
  windowSurface: 'main' as 'main' | 'status-popup',
}))

// Tanstack router — avoid real router internals.
vi.mock('@tanstack/react-router', () => ({
  createRootRoute: (config: any) => ({ ...config, id: '__root' }),
  Outlet: () => <div data-testid="outlet" />,
  useLocation: () => ({
    pathname: window.location.pathname,
    href: `${window.location.pathname}${window.location.search}${window.location.hash}`,
  }),
}))

// Tauri API
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    startDragging: vi.fn().mockResolvedValue(undefined),
  }),
}))

// Providers
vi.mock('@/providers/ThemeProvider', () => ({
  ThemeProvider: () => <div data-testid="theme-provider" />,
}))
vi.mock('@/providers/InterfaceProvider', () => ({
  InterfaceProvider: () => <div data-testid="interface-provider" />,
}))
vi.mock('@/providers/KeyboardShortcuts', () => ({
  KeyboardShortcutsProvider: () => <div data-testid="keyboard-provider" />,
}))
vi.mock('@/providers/DataProvider', () => ({
  DataProvider: () => <div data-testid="data-provider" />,
}))
vi.mock('@/providers/ExtensionProvider', () => ({
  ExtensionProvider: ({ children }: any) => (
    <div data-testid="extension-provider">{children}</div>
  ),
}))
vi.mock('@/providers/ToasterProvider', () => ({
  ToasterProvider: () => <div data-testid="toaster-provider" />,
}))
vi.mock('@/providers/GlobalEventHandler', () => ({
  GlobalEventHandler: () => <div data-testid="global-event" />,
}))
vi.mock('@/providers/ServiceHubProvider', () => ({
  ServiceHubProvider: ({ children }: any) => (
    <div data-testid="service-hub">{children}</div>
  ),
}))
vi.mock('@/providers/ConversationSyncProvider', () => ({
  ConversationSyncProvider: ({ children }: any) => (
    <div data-testid="conversation-sync-provider">{children}</div>
  ),
}))
vi.mock('@/components/StatusPopupHeader', () => ({
  StatusPopupHeader: () => <div data-testid="status-popup-header" />,
}))
vi.mock('@/lib/window-surface', () => ({
  currentWindowSurface: () => h.windowSurface,
}))

// i18n
vi.mock('@/i18n/TranslationContext', () => ({
  TranslationProvider: ({ children }: any) => (
    <div data-testid="translation">{children}</div>
  ),
}))

// Dialogs / containers
vi.mock('@/containers/dialogs/BackendUpdater', () => ({
  default: () => <div data-testid="backend-updater" />,
}))
vi.mock('@/containers/dialogs/OutOfContextDialog', () => ({
  default: () => <div data-testid="oocp" />,
}))
vi.mock('@/containers/dialogs/AttachmentIngestionDialog', () => ({
  default: () => <div data-testid="attach-ingest" />,
}))
vi.mock('@/containers/dialogs/ErrorDialog', () => ({
  default: () => <div data-testid="error-dialog" />,
}))
vi.mock('@/containers/GlobalError', () => ({
  default: ({ error }: any) => <div data-testid="global-error">{error?.message}</div>,
}))

// Components
vi.mock('@/components/left-sidebar', () => ({
  LeftSidebar: () => <div data-testid="left-sidebar" />,
  NavigationDialogs: () => <div data-testid="navigation-dialogs" />,
}))
vi.mock('@/components/WindowControls', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}))
vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: any) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
  SidebarInset: ({ children }: any) => (
    <div data-testid="sidebar-inset">{children}</div>
  ),
}))

// Hooks
vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: () => ({
    open: h.leftPanelOpen,
    setLeftPanel: h.setLeftPanel,
    width: h.sidebarWidth,
    setLeftPanelWidth: h.setLeftPanelWidth,
  }),
}))

vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      index: '/settings',
    },
    systemMonitor: '/system-monitor',
    appLogs: '/logs',
  },
}))

import { Route } from '../__root'
import { useSettingsNavigation } from '@/hooks/useSettingsNavigation'

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

describe('__root route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.windowSurface = 'main'
    useSettingsNavigation.setState({ origin: null })
    // reset document state
    document.body.className = ''
    const loader = document.getElementById('initial-loader')
    if (loader) loader.remove()
    // default pathname: not a logs route
    window.history.pushState({}, '', '/')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders AppLayout by default (non-logs route)', () => {
    renderComponent()
    expect(screen.getByTestId('service-hub')).toBeInTheDocument()
    expect(screen.getByTestId('conversation-sync-provider')).toBeInTheDocument()
    expect(screen.getByTestId('theme-provider')).toBeInTheDocument()
    expect(screen.getByTestId('extension-provider')).toBeInTheDocument()
    expect(screen.getByTestId('data-provider')).toBeInTheDocument()
    expect(screen.getByTestId('left-sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-provider')).toBeInTheDocument()
  })

  it('renders compact popup layout without sidebar or global dialogs', () => {
    h.windowSurface = 'status-popup'
    renderComponent()

    expect(screen.getByTestId('status-popup-layout')).toBeInTheDocument()
    expect(screen.getByTestId('status-popup-header')).toBeInTheDocument()
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
    expect(screen.queryByTestId('left-sidebar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('attach-ingest')).not.toBeInTheDocument()
  })

  it('hides the main sidebar on settings routes', () => {
    window.history.pushState({}, '', '/settings/general')
    renderComponent()

    expect(screen.queryByTestId('left-sidebar')).not.toBeInTheDocument()
    expect(screen.getByTestId('navigation-dialogs')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-inset')).toBeInTheDocument()
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
  })

  it('records the full last non-settings location', () => {
    window.history.pushState({}, '', '/threads/thread-1?mode=agent#latest')
    const view = renderComponent()

    expect(useSettingsNavigation.getState().origin).toBe(
      '/threads/thread-1?mode=agent#latest'
    )

    window.history.pushState({}, '', '/settings/general')
    const Component = Route.component as React.ComponentType
    view.rerender(<Component />)

    expect(useSettingsNavigation.getState().origin).toBe(
      '/threads/thread-1?mode=agent#latest'
    )
  })

  it('renders all persistent dialogs', () => {
    renderComponent()
    expect(screen.getByTestId('attach-ingest')).toBeInTheDocument()
    expect(screen.getByTestId('error-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('oocp')).toBeInTheDocument()
    expect(screen.getByTestId('backend-updater')).toBeInTheDocument()
  })

  it('uses LogsLayout on /logs path (no sidebar)', () => {
    window.history.pushState({}, '', '/logs')
    renderComponent()
    expect(screen.queryByTestId('left-sidebar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-provider')).not.toBeInTheDocument()
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
  })

  it('uses LogsLayout on /system-monitor path', () => {
    window.history.pushState({}, '', '/system-monitor')
    renderComponent()
    expect(screen.queryByTestId('left-sidebar')).not.toBeInTheDocument()
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
  })

  // Loader dismissal moved to ExtensionProvider — see ExtensionProvider.test.tsx.

  it('errorComponent renders GlobalError with provided error', () => {
    const ErrComp = (Route as any).errorComponent as React.ComponentType<{ error: Error }>
    render(<ErrComp error={new Error('broken')} />)
    expect(screen.getByTestId('global-error')).toHaveTextContent('broken')
  })
})
