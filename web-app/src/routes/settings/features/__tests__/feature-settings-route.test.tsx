import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  params: { featureId: 'memory', _splat: 'items/42' },
  search: { view: 'detail' },
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (path: string) =>
    (options: { component: React.ComponentType }) => ({
      ...options,
      id: path,
      useParams: () => mocks.params,
      useSearch: () => mocks.search,
      useNavigate: () => mocks.navigate,
    }),
}))

vi.mock('@/features/host/FeatureSettingsHost', () => ({
  FeatureSettingsHost: (props: Record<string, unknown>) => (
    <div
      data-testid="settings-host"
      data-feature={props.featureId}
      data-subpath={props.routeSubpath}
      data-search={JSON.stringify(props.search)}
    />
  ),
}))

vi.mock('@/containers/SettingsLayout', () => ({
  SettingsLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="settings-layout">{children}</div>
  ),
}))

import { FeatureSettingsRoute, Route } from '../$featureId/$'

describe('Feature settings route adapter', () => {
  it('uses the fixed namespace and preserves the deep-link state', () => {
    expect(Route.id).toBe('/settings/features/$featureId/$')
    render(<FeatureSettingsRoute />)
    expect(screen.getByTestId('settings-layout')).toContainElement(
      screen.getByTestId('settings-host')
    )
    expect(screen.getByTestId('settings-host')).toHaveAttribute(
      'data-feature',
      'memory'
    )
    expect(screen.getByTestId('settings-host')).toHaveAttribute(
      'data-subpath',
      'items/42'
    )
    expect(screen.getByTestId('settings-host')).toHaveAttribute(
      'data-search',
      JSON.stringify({ view: 'detail' })
    )
  })
})
