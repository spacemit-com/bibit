import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  params: { featureId: 'store', _splat: 'agents/42' },
  search: { tab: 2, tags: ['a', 3], ignored: { nested: true } },
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

vi.mock('@/features/host/FeaturePageHost', () => ({
  FeaturePageHost: (props: Record<string, unknown>) => (
    <div
      data-testid="page-host"
      data-feature={props.featureId}
      data-subpath={props.routeSubpath}
      data-search={JSON.stringify(props.search)}
    />
  ),
}))

import { FeaturePageRoute, Route } from '../$featureId/$'

describe('Feature page route adapter', () => {
  beforeEach(() => mocks.navigate.mockReset())

  it('uses the fixed namespace and converts params/search for the host', () => {
    expect(Route.id).toBe('/features/$featureId/$')
    render(<FeaturePageRoute />)
    expect(screen.getByTestId('page-host')).toHaveAttribute(
      'data-feature',
      'store'
    )
    expect(screen.getByTestId('page-host')).toHaveAttribute(
      'data-subpath',
      'agents/42'
    )
    expect(screen.getByTestId('page-host')).toHaveAttribute(
      'data-search',
      JSON.stringify({ tab: '2', tags: ['a', '3'] })
    )
  })
})
