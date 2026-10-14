import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Route as GeneralRoute } from '../general'

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => tauri.invoke(...args),
}))

// Mock all the dependencies
vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <div data-testid="settings-menu">Settings Menu</div>,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/containers/Card', () => ({
  Card: ({
    title,
    children,
  }: {
    title?: string
    children: React.ReactNode
  }) => (
    <div data-testid="card" data-title={title}>
      {title && <div data-testid="card-title">{title}</div>}
      {children}
    </div>
  ),
  CardItem: ({
    title,
    description,
    actions,
    className,
  }: {
    title?: string
    description?: string
    actions?: React.ReactNode
    className?: string
  }) => (
    <div data-testid="card-item" data-title={title} className={className}>
      {title && <div data-testid="card-item-title">{title}</div>}
      {description && (
        <div data-testid="card-item-description">{description}</div>
      )}
      {actions && <div data-testid="card-item-actions">{actions}</div>}
    </div>
  ),
}))

vi.mock('@/containers/LanguageSwitcher', () => ({
  default: () => <div data-testid="language-switcher">Language Switcher</div>,
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }) => (
    <input
      data-testid="switch"
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    [key: string]: any
  }) => (
    <button
      data-testid="button"
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input data-testid="input" {...props} />
  ),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog">{children}</div>
  ),
  DialogClose: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-close">{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-description">{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-title">{children}</div>
  ),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-trigger">{children}</div>
  ),
}))

vi.mock('@/services/models/default', () => ({
  DefaultModelsService: vi.fn().mockImplementation(() => ({
    stopAllModels: vi.fn(),
  })),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    app: () => ({
      getJanDataFolder: vi.fn().mockResolvedValue('/test/data/folder'),
    }),
    models: () => ({
      stopAllModels: vi.fn(),
    }),
    dialog: () => ({
      open: vi.fn().mockResolvedValue('/test/path'),
    }),
    events: () => ({
      emit: vi.fn(),
    }),
    window: () => ({
      openLogsWindow: vi.fn(),
    }),
    opener: () => ({
      revealItemInDir: vi.fn(),
    }),
    path: () => ({
      join: vi.fn().mockResolvedValue('/test/data/folder/logs'),
      sep: vi.fn().mockReturnValue('/'),
      dirname: vi.fn().mockResolvedValue('/test/data/folder'),
      basename: vi.fn().mockResolvedValue('logs'),
      extname: vi.fn().mockResolvedValue(''),
    }),
  }),
}))

// Add tests for rfd dialog
// vi.mock('@tauri-apps/plugin-dialog', () => ({
//   open: vi.fn(),
// }))

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: vi.fn(),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => {
  const MockWebviewWindow = vi
    .fn()
    .mockImplementation((label: string, options: any) => ({
      once: vi.fn(),
      setFocus: vi.fn(),
    }))
  MockWebviewWindow.getByLabel = vi.fn().mockReturnValue(null)

  return {
    WebviewWindow: MockWebviewWindow,
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/utils', () => ({
  isDev: vi.fn().mockReturnValue(false),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      general: '/settings/general',
    },
    appLogs: '/logs',
  },
}))

vi.mock('@/constants/windows', () => ({
  windowKey: {
    logsAppWindow: 'logs-app-window',
  },
}))

vi.mock('@/types/events', () => ({
  SystemEvent: {
    KILL_SIDECAR: 'kill-sidecar',
  },
}))


vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (path: string) => (config: any) => ({
    ...config,
    component: config.component,
  }),
}))

// Mock global variables
global.VERSION = '1.0.0'
global.IS_TAURI = false
global.window = {
  ...global.window,
  core: {
    api: {
      relaunch: vi.fn(),
      getConnectedServers: vi.fn().mockResolvedValue([]),
    },
  },
}

// Mock navigator clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn(),
  },
})

describe('General Settings Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.IS_TAURI = false
  })

  it('should render the general settings page', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('should render app version', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
  })

  it('renders the public Beta release label', async () => {
    global.VERSION = '1.0.0-beta.1'
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })
    expect(screen.getByText('v1.0Beta1')).toBeInTheDocument()
    global.VERSION = '1.0.0'
  })

  it('does not expose legacy Jan or GitLab placeholder links', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const links = screen.queryAllByRole('link')
    expect(links).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain('gitlab.dc.com')
    expect(document.body.innerHTML).not.toContain('github.com/janhq')
    expect(document.body.innerHTML).not.toContain('discord.com/invite')
  })

  it('loads the product and build versions from the desktop artifact', async () => {
    global.IS_TAURI = true
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_delivery_information') {
        return Promise.resolve({
          productVersion: '0.1.3',
          buildVersion: 'dev-test',
          notice: 'BiBit notice',
          licenses: [],
          thirdPartyManifest: '{"schemaVersion":1}',
        })
      }
      return Promise.resolve(false)
    })

    const Component = GeneralRoute.component as React.ComponentType
    render(<Component />)

    expect(await screen.findByText('v0.1.3')).toBeInTheDocument()
    expect(screen.getByText('dev-test')).toBeInTheDocument()
    expect(screen.queryByText('BiBit notice')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Copy version information' })
    )
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'BiBit 0.1.3\ndev-test'
    )
  })

  it('should handle logs window opening', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const buttons = screen.getAllByTestId('button')
    const openLogsButton = buttons.find((button) =>
      button.textContent?.includes('openLogs')
    )

    if (openLogsButton) {
      expect(openLogsButton).toBeInTheDocument()
      // Test that button is interactive
      await act(async () => {
        fireEvent.click(openLogsButton)
      })
      expect(openLogsButton).toBeInTheDocument()
    }
  })

  it('should handle reveal logs folder', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const buttons = screen.getAllByTestId('button')
    const revealLogsButton = buttons.find((button) =>
      button.textContent?.includes('openContainingFolder')
    )

    if (revealLogsButton) {
      expect(revealLogsButton).toBeInTheDocument()
      // Test that button is interactive
      await act(async () => {
        fireEvent.click(revealLogsButton)
      })
      expect(revealLogsButton).toBeInTheDocument()
    }
  })

  it('should show the Linux containing-folder label', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(
      screen.getByText('Open Containing Folder')
    ).toBeInTheDocument()
  })

  it('loads and saves the quick-chat geometry', async () => {
    global.IS_TAURI = true
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'get_delivery_information') {
        return Promise.resolve({
          productVersion: '0.1.3',
          buildVersion: 'dev-test',
          notice: 'BiBit notice',
          licenses: [],
          thirdPartyManifest: '{"schemaVersion":1}',
        })
      }
      if (command === 'desktop_integration_status') {
        return Promise.resolve({
          residentEnabled: true,
          autostartEnabled: true,
          autostartRegistered: true,
          popupGeometry: {
            screenIndex: 0,
            width: 420,
            height: 600,
            rightMargin: 24,
            bottomMargin: 12,
          },
        })
      }
      if (command === 'desktop_integration_set_popup_geometry') {
        return Promise.resolve({
          residentEnabled: true,
          autostartEnabled: true,
          autostartRegistered: true,
          popupGeometry: {
            screenIndex: 0,
            width: 500,
            height: 600,
            rightMargin: 24,
            bottomMargin: 12,
          },
        })
      }
      return Promise.resolve(false)
    })

    const Component = GeneralRoute.component as React.ComponentType
    render(<Component />)

    const width = await screen.findByLabelText(
      'Quick chat width'
    )
    fireEvent.change(width, { target: { value: '500' } })
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(tauri.invoke).toHaveBeenCalledWith(
      'desktop_integration_set_popup_geometry',
      {
        screenIndex: 0,
        width: 500,
        height: 600,
        rightMargin: 24,
        bottomMargin: 12,
      }
    )
  })
})
