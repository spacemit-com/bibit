import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FeaturePageProps } from '@bibit/feature-sdk'
import { useFeatureCapability } from '@bibit/feature-sdk'
import { FeaturePageHost } from '../FeaturePageHost'
import {
  createFeatureRegistryProjection,
  type FeatureNavigate,
} from '../registry'
import { clearFeatureModuleCache } from '../loadFeatureModule'
import { createTestEntry } from './testRegistry'
import i18n, { registerFeatureLocales } from '@/i18n/setup'

afterEach(() => clearFeatureModuleCache())

describe('FeaturePageHost', () => {
  it('provides the injected capability-scoped Host API to the Feature', async () => {
    const Page = () => {
      const service = useFeatureCapability('external-service:store')
      return <div>{service ? 'Store capability' : 'No capability'}</div>
    }
    const registry = createFeatureRegistryProjection(
      [createTestEntry({ page: Page })],
      { target: 'desktop', surface: 'main' }
    )
    render(
      <FeaturePageHost
        registry={registry}
        featureId="store"
        routeSubpath=""
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
        hostApiFactory={() => ({
          sdkApiVersion: 1,
          featureId: 'store',
          grantedCapabilities: ['external-service:store'],
          getCapability: () => ({ request: vi.fn() }) as never,
        })}
      />
    )
    expect(await screen.findByText('Store capability')).toBeInTheDocument()
  })
  it('registers Feature locales after module loading', async () => {
    const Page = () => <div>Localized page</div>
    const registry = createFeatureRegistryProjection(
      [
        createTestEntry({
          page: Page,
          load: () =>
            Promise.resolve({
              default: {
                sdkApiVersion: 1,
                pages: { home: Page },
                locales: { en: { title: 'Agent Store' } },
              },
            }),
        }),
      ],
      { target: 'desktop', surface: 'main' }
    )
    render(
      <FeaturePageHost
        registry={registry}
        featureId="store"
        routeSubpath=""
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )
    await screen.findByText('Localized page')
    expect(i18n.t('store:title')).toBe('Agent Store')
  })

  it('contains locale registration failure without polluting other namespaces', async () => {
    delete i18n.resources.en?.store
    registerFeatureLocales('memory', { en: { title: 'Memory' } })
    const Page = () => null
    const registry = createFeatureRegistryProjection(
      [
        createTestEntry({
          page: Page,
          load: () =>
            Promise.resolve({
              default: {
                sdkApiVersion: 1,
                pages: { home: Page },
                locales: { en: null },
              },
            }),
        }),
      ],
      { target: 'desktop', surface: 'main' }
    )
    render(
      <FeaturePageHost
        registry={registry}
        featureId="store"
        routeSubpath=""
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Feature could not be loaded'
    )
    expect(i18n.t('memory:title')).toBe('Memory')
    expect(i18n.resources.en?.store).toBeUndefined()
  })
  it('loads a deep link and passes normalized public props', async () => {
    const Page = ({ featureId, contributionId, subpath, search }: FeaturePageProps) => (
      <div data-testid="page-props">
        {featureId}|{contributionId}|{subpath}|{search.tab}
      </div>
    )
    const registry = createFeatureRegistryProjection(
      [createTestEntry({ page: Page, pagePath: 'agents' })],
      { target: 'desktop', surface: 'main' }
    )

    render(
      <FeaturePageHost
        registry={registry}
        featureId="store"
        routeSubpath="agents/42"
        search={{ tab: 'skills' }}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )

    expect(await screen.findByTestId('page-props')).toHaveTextContent(
      'store|home|42|skills'
    )
  })

  it.each([
    ['missing', '', 'unknown-feature'],
    ['store', 'skills', 'path-not-found'],
  ])('renders a local state for %s/%s', (featureId, routeSubpath, reason) => {
    const registry = createFeatureRegistryProjection(
      [createTestEntry({ page: () => null, pagePath: 'agents' })],
      { target: 'desktop', surface: 'main' }
    )
    render(
      <FeaturePageHost
        registry={registry}
        featureId={featureId}
        routeSubpath={routeSubpath}
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )
    expect(screen.getByTestId('feature-unavailable')).toHaveAttribute(
      'data-reason',
      reason
    )
  })

  it('contains dynamic import rejection and retries only the failed Feature', async () => {
    const Page = () => <div>Recovered page</div>
    const failingLoader = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue({
        default: { sdkApiVersion: 1, pages: { home: Page } },
      })
    const registry = createFeatureRegistryProjection(
      [createTestEntry({ page: Page, load: failingLoader })],
      { target: 'desktop', surface: 'main' }
    )

    render(
      <FeaturePageHost
        registry={registry}
        featureId="store"
        routeSubpath=""
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Feature could not be loaded'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Recovered page')).toBeInTheDocument()
    expect(failingLoader).toHaveBeenCalledTimes(2)
  })

  it('contains component render errors inside the current Feature', async () => {
    const Broken = () => {
      throw new Error('render failed')
    }
    const registry = createFeatureRegistryProjection(
      [createTestEntry({ page: Broken })],
      { target: 'desktop', surface: 'main' }
    )
    render(
      <FeaturePageHost
        registry={registry}
        featureId="store"
        routeSubpath=""
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Feature could not be loaded'
    )
  })

  it('clears a failed boundary when navigation switches to another Feature', async () => {
    const Broken = () => {
      throw new Error('store render failed')
    }
    const Healthy = () => <div>Memory page</div>
    const registry = createFeatureRegistryProjection(
      [
        createTestEntry({ id: 'store', page: Broken }),
        createTestEntry({ id: 'memory', page: Healthy }),
      ],
      { target: 'desktop', surface: 'main' }
    )
    const view = render(
      <FeaturePageHost
        registry={registry}
        featureId="store"
        routeSubpath=""
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    view.rerender(
      <FeaturePageHost
        registry={registry}
        featureId="memory"
        routeSubpath=""
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )
    expect(await screen.findByText('Memory page')).toBeInTheDocument()
  })

  it('provides namespace-relative navigation and restores focus on route changes', async () => {
    let props: FeaturePageProps | undefined
    const Page = (nextProps: FeaturePageProps) => {
      props = nextProps
      return <div>Page</div>
    }
    const navigate = vi.fn<FeatureNavigate>().mockResolvedValue(undefined)
    const back = vi.fn()
    const registry = createFeatureRegistryProjection(
      [createTestEntry({ page: Page, pagePath: 'agents' })],
      { target: 'desktop', surface: 'main' }
    )
    const view = render(
      <FeaturePageHost
        registry={registry}
        featureId="store"
        routeSubpath="agents"
        search={{}}
        navigate={navigate}
        back={back}
      />
    )
    await screen.findByText('Page')
    const mount = screen.getByTestId('feature-page-host')
    await waitFor(() => expect(document.activeElement).toBe(mount))
    expect(mount).toHaveClass(
      'h-full',
      'min-h-0',
      'min-w-0',
      'w-full',
      'outline-none'
    )

    props?.navigation.push('detail/42', { tab: 'history' })
    props?.navigation.replace('detail/43')
    props?.navigation.back()
    expect(navigate).toHaveBeenNthCalledWith(1, {
      to: '/features/$featureId/$',
      params: { featureId: 'store', _splat: 'agents/detail/42' },
      search: { tab: 'history' },
      replace: false,
    })
    expect(navigate).toHaveBeenNthCalledWith(2, {
      to: '/features/$featureId/$',
      params: { featureId: 'store', _splat: 'agents/detail/43' },
      search: undefined,
      replace: true,
    })
    expect(back).toHaveBeenCalledTimes(1)
    expect(() => props?.navigation.push('../escape')).toThrow(
      'Invalid Feature subpath'
    )

    view.rerender(
      <FeaturePageHost
        registry={registry}
        featureId="store"
        routeSubpath="agents/detail/42"
        search={{}}
        navigate={navigate}
        back={back}
      />
    )
    await waitFor(() => expect(document.activeElement).toBe(mount))
  })
})
