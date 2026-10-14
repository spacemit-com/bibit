import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Route as ExtensionsRoute } from '../extensions'

const tauri = vi.hoisted(() => ({ invoke: vi.fn(() => new Promise(() => {})) }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => tauri.invoke(...args),
}))

// Mock dependencies
vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <div data-testid="settings-menu">Settings Menu</div>,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/containers/Card', () => ({
  Card: ({ header, children }: { header?: React.ReactNode; children: React.ReactNode }) => (
    <div data-testid="card">
      {header && <div data-testid="card-header">{header}</div>}
      {children}
    </div>
  ),
  CardItem: ({ title, description, actions }: { title?: string; description?: string; actions?: React.ReactNode }) => (
    <div data-testid="card-item" data-title={title}>
      {title && <div data-testid="card-item-title">{title}</div>}
      {description && <div data-testid="card-item-description">{description}</div>}
      {actions && <div data-testid="card-item-actions">{actions}</div>}
    </div>
  ),
}))

vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      extensions: '/settings/extensions',
    },
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (path: string) => (config: any) => ({
    ...config,
    component: config.component,
  }),
}))

describe('Extensions Settings Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauri.invoke.mockImplementation(() => new Promise(() => {}))
  })

  it('should offer an enable action for a deactivated plugin', async () => {
    tauri.invoke.mockImplementation((command: string) =>
      command === 'trusted_plugin_list_active'
        ? Promise.resolve({
            plugins: [],
            rejected: [],
            lifecycle: [
              { id: 'agent-hub', version: '0.1.0', status: 'disabled' },
            ],
          })
        : new Promise(() => {})
    )

    const Component = ExtensionsRoute.component as React.ComponentType
    render(<Component />)

    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }))

    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith('trusted_plugin_activate', {
        id: 'agent-hub',
        version: '0.1.0',
      })
    )
  })

  it('should render the extensions settings page', () => {
    const Component = ExtensionsRoute.component as React.ComponentType
    render(<Component />)

    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('should render only the trusted plugins card', () => {
    const Component = ExtensionsRoute.component as React.ComponentType
    render(<Component />)

    expect(screen.getAllByTestId('card')).toHaveLength(1)
    expect(screen.getByText('Trusted plugins')).toBeInTheDocument()
    expect(screen.getByText('Install plugin')).toBeInTheDocument()
  })

  it('should not list built-in extensions anymore', () => {
    const Component = ExtensionsRoute.component as React.ComponentType
    render(<Component />)

    // The bundled-extension card rendered labels through these namespaces; the
    // catalogue is gone with its strings, so a reintroduced card would surface
    // raw keys here.
    expect(document.body.textContent).not.toMatch(
      /extensionNames|extensionDescriptions/
    )
  })

  it('should have proper layout structure', () => {
    const Component = ExtensionsRoute.component as React.ComponentType
    render(<Component />)

    const headerPage = screen.getByTestId('header-page')
    expect(headerPage).toBeInTheDocument()
    
    const settingsMenu = screen.getByTestId('settings-menu')
    expect(settingsMenu).toBeInTheDocument()
  })

  it('should call translation function with correct keys', () => {
    const Component = ExtensionsRoute.component as React.ComponentType
    render(<Component />)

    // Test that translations are rendered
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByText('Trusted plugins')).toBeInTheDocument()
  })

  it('should render with proper responsive classes', () => {
    const Component = ExtensionsRoute.component as React.ComponentType
    render(<Component />)

    const settingsContent = screen.getByTestId('settings-menu').nextElementSibling
    expect(settingsContent).toHaveClass('p-4', 'pt-0', 'w-full', 'overflow-y-auto')
  })

  const mockActivePlugin = () => {
    tauri.invoke.mockImplementation((command: string) =>
      command === 'trusted_plugin_list_active'
        ? Promise.resolve({
            plugins: [
              {
                id: 'agent-hub',
                version: '0.1.0',
                featureManifest: {
                  display: { titleKey: 'pluginTitle', fallbackTitle: 'Agent Hub' },
                },
              },
            ],
            rejected: [],
            lifecycle: [],
          })
        : new Promise(() => {})
    )
  }

  it('should confirm before uninstalling a plugin', async () => {
    mockActivePlugin()

    const Component = ExtensionsRoute.component as React.ComponentType
    render(<Component />)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Uninstall plugin' })
    )
    expect(
      await screen.findByRole('heading', { name: 'Uninstall plugin' })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Agent Hub v0\.1\.0/, { selector: 'p' })
    ).toBeInTheDocument()
    expect(tauri.invoke).not.toHaveBeenCalledWith('trusted_plugin_uninstall', {
      id: 'agent-hub',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))

    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith('trusted_plugin_uninstall', {
        id: 'agent-hub',
      })
    )
  })

  it('should leave the plugin untouched when a lifecycle action is cancelled', async () => {
    mockActivePlugin()

    const Component = ExtensionsRoute.component as React.ComponentType
    render(<Component />)

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }))
    expect(
      await screen.findByRole('heading', { name: 'Deactivate plugin' })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Deactivate plugin' })
      ).not.toBeInTheDocument()
    )
    expect(tauri.invoke).not.toHaveBeenCalledWith('trusted_plugin_deactivate', {
      id: 'agent-hub',
    })
  })
})
