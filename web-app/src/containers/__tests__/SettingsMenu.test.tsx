import { render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import SettingsMenu, { getFeatureSettingsNavigation } from '../SettingsMenu'
import type { FeatureManifestV1 } from '@bibit/feature-contracts'
import {
  groupFeatureSettingsNavigation,
  mergeFeatureSettingsNavigation,
} from '@/features/navigation'

// Mock global platform constants - simulate desktop (Tauri) environment
Object.defineProperty(global, 'IS_WEB_APP', { value: false, writable: true })

// Mock dependencies
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: any) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: vi.fn(() => ({})),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}))


describe('SettingsMenu', () => {
  it('projects contribution navigation metadata and preserves display defaults', () => {
    const manifest = {
      manifestSchemaVersion: 1,
      sdkApiVersion: 1,
      id: 'runtime',
      version: '1.0.0',
      owner: 'runtime-team',
      display: {
        titleKey: 'runtime:title',
        fallbackTitle: 'Runtime',
        iconKey: 'feature',
      },
      targets: ['desktop'],
      requiredHostCapabilities: [],
      contributions: {
        pages: [],
        settings: [
          {
            id: 'expert',
            path: 'expert',
            surfaces: ['main'],
            navigation: {
              group: 'core',
              order: 10,
              titleKey: 'runtime:expert',
              fallbackTitle: 'Expert',
              iconKey: 'settings',
              section: {
                id: 'runtime-management',
                fallbackTitle: '管理',
              },
            },
          },
          {
            id: 'legacy-defaults',
            path: 'legacy-defaults',
            surfaces: ['main'],
            navigation: { group: 'features' },
          },
          {
            id: 'fallback-only',
            path: 'fallback-only',
            surfaces: ['main'],
            navigation: {
              group: 'core',
              order: 20,
              fallbackTitle: 'Configuration',
            },
          },
        ],
        conversation: [],
        locales: ['en'],
      },
    } satisfies FeatureManifestV1

    expect(
      getFeatureSettingsNavigation([
        { packageName: 'trusted-plugin:runtime', manifest, load: async () => ({}) },
      ])
    ).toEqual([
      expect.objectContaining({
        id: 'runtime:expert',
        title: 'Expert',
        titleKey: 'runtime:expert',
        iconKey: 'settings',
        section: {
          id: 'runtime-management',
          fallbackTitle: '管理',
        },
      }),
      expect.objectContaining({
        id: 'runtime:fallback-only',
        title: 'Configuration',
        titleKey: undefined,
      }),
      expect.objectContaining({
        id: 'runtime:legacy-defaults',
        title: 'Runtime',
        titleKey: 'runtime:title',
        iconKey: 'feature',
      }),
    ])
  })

  it('sorts visible Feature settings and omits deep-link-only entries', () => {
    const merged = mergeFeatureSettingsNavigation([
        { id: 'b', group: 'privacy', order: 2, title: 'Rules', path: '/b', iconKey: 'security' },
        { id: 'hidden', title: 'Hidden', path: '/hidden', iconKey: 'feature' },
        { id: 'a', group: 'features', order: 1, title: 'Memory', path: '/a', iconKey: 'memory' },
        { id: 'integration', group: 'integrations', order: 1, title: 'Store', path: '/integration', iconKey: 'store' },
        { id: 'unicode', group: 'features', order: 1, title: 'ä', path: '/unicode', iconKey: 'feature' },
        { id: 'ascii', group: 'features', order: 1, title: 'z', path: '/ascii', iconKey: 'feature' },
      ])
    const grouped = groupFeatureSettingsNavigation(merged)
    expect(grouped.features.map((item) => item.id)).toEqual(['a', 'ascii', 'unicode'])
    expect(grouped.integrations.map((item) => item.id)).toEqual(['integration'])
    expect(grouped.privacy.map((item) => item.id)).toEqual(['b'])
  })

  it('defaults Feature settings order to 1000 and breaks ties by full contribution id', () => {
    const merged = mergeFeatureSettingsNavigation([
      {
        id: 'z-feature:settings',
        group: 'features',
        title: 'Aardvark',
        path: '/z',
        iconKey: 'feature',
      },
      {
        id: 'a-feature:settings',
        group: 'features',
        title: 'Zulu',
        path: '/a',
        iconKey: 'feature',
      },
      {
        id: 'm-feature:settings',
        group: 'features',
        order: 999,
        title: 'Middle',
        path: '/m',
        iconKey: 'feature',
      },
    ])

    expect(merged.map((item) => item.id)).toEqual([
      'm-feature:settings',
      'a-feature:settings',
      'z-feature:settings',
    ])
  })

  it('renders Feature settings in their contracted sections', () => {
    render(
      <SettingsMenu
        featureSettingsItems={[
          { id: 'memory', group: 'features', title: 'Memory', path: '/memory', iconKey: 'memory' },
          { id: 'store', group: 'integrations', title: 'Store', path: '/store', iconKey: 'store' },
          { id: 'rules', group: 'privacy', title: 'Rules', path: '/rules', iconKey: 'security' },
        ]}
      />
    )
    expect(within(screen.getByTestId('feature-settings-navigation')).getByText('Memory')).toBeInTheDocument()
    expect(within(screen.getByTestId('integration-settings-navigation')).getByText('Store')).toBeInTheDocument()
    expect(within(screen.getByTestId('feature-settings-privacy')).getByText('Rules')).toBeInTheDocument()
  })
  it('renders management and monitoring with the same static title style as Features', () => {
    render(
      <SettingsMenu
        featureSettingsItems={[
          { id: 'runtime:logs', group: 'core', order: 20, title: 'Logs', path: '/logs', iconKey: 'security', section: { id: 'runtime-monitoring', fallbackTitle: '监控' } },
          { id: 'runtime:expert', group: 'core', order: 10, title: 'Expert', path: '/expert', iconKey: 'settings', section: { id: 'runtime-management', fallbackTitle: '管理' } },
          { id: 'flat', group: 'core', order: 30, title: 'Flat', path: '/flat', iconKey: 'feature' },
          { id: 'other', group: 'features', title: 'Other feature', path: '/other', iconKey: 'feature' },
        ]}
      />
    )

    const links = screen.getAllByRole('link').map((link) => link.textContent)
    expect(links.slice(0, 2)).toEqual(['common:general', 'common:appearance'])
    expect(links.indexOf('Expert')).toBeGreaterThan(links.indexOf('common:extensions'))
    expect(links.slice(links.indexOf('Expert'), links.indexOf('Expert') + 4)).toEqual([
      'Expert', 'Logs', 'Flat', 'Other feature',
    ])
    const featuresSection = screen.getByTestId('feature-settings-navigation')
    for (const name of ['管理', '监控']) {
      const title = screen.getByText(name)
      const section = title.parentElement
      expect(title.className).toBe(within(featuresSection).getByText('Features').className)
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
      expect(section?.parentElement).toBe(featuresSection.parentElement)
    }
    expect(screen.getByText('Expert')).toBeInTheDocument()
    expect(screen.getByText('Logs')).toBeInTheDocument()
    expect(screen.getByText('Flat')).toBeInTheDocument()
  })
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders all menu items', () => {
    render(<SettingsMenu />)

    expect(screen.getByText('common:general')).toBeInTheDocument()
    expect(screen.getByText('common:appearance')).toBeInTheDocument()
    expect(screen.getByText('common:keyboardShortcuts')).toBeInTheDocument()
    expect(screen.queryByText('common:privacy')).not.toBeInTheDocument()
  })

  it('renders core settings links', () => {
    render(<SettingsMenu />)
    expect(screen.getByText('common:keyboardShortcuts')).toBeInTheDocument()
    expect(screen.queryByText('common:attachments')).not.toBeInTheDocument()
    expect(screen.getByText('common:extensions')).toBeInTheDocument()
  })

  it('renders an empty integrations section', () => {
    render(<SettingsMenu />)
    // Non-core entries (mcp-servers, claude_code) are hidden from navigation.
    expect(
      screen.getByTestId('integration-settings-navigation')
    ).toBeInTheDocument()
    expect(screen.queryByText('common:mcp-servers')).not.toBeInTheDocument()
    expect(screen.queryByText('common:claude_code')).not.toBeInTheDocument()
  })

  it('does not render the legacy model providers entry', () => {
    render(<SettingsMenu />)
    expect(screen.queryByText('common:modelProviders')).not.toBeInTheDocument()
  })
})
