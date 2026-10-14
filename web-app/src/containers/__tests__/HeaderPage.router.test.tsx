import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HeaderPage from '../HeaderPage'
import { useSettingsNavigation } from '@/hooks/useSettingsNavigation'

vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: () => ({ open: true, setLeftPanel: vi.fn() }),
}))

vi.mock('@/stores/titlebar-layout-store', () => ({
  useTitlebarLayout: (
    selector: (state: { layout: { left: string[]; right: string[] } }) => unknown
  ) => selector({ layout: { left: [], right: [] } }),
}))

describe('HeaderPage routing', () => {
  beforeEach(() => useSettingsNavigation.setState({ origin: null }))

  it('restores the full origin href', async () => {
    const rootRoute = createRootRoute({ component: Outlet })
    const settingsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/settings/general',
      component: HeaderPage,
    })
    const threadRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/threads/$threadId',
      component: () => null,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([settingsRoute, threadRoute]),
      history: createMemoryHistory({ initialEntries: ['/settings/general'] }),
    })
    useSettingsNavigation.setState({
      origin: '/threads/thread-1?mode=agent#output',
    })

    render(<RouterProvider router={router} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))

    await waitFor(() => {
      expect(router.state.location.href).toBe(
        '/threads/thread-1?mode=agent#output'
      )
    })
  })
})
