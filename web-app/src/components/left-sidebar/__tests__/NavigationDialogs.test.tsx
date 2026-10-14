import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  useNavigate: () => vi.fn(),
}))

vi.mock('@/features/host/registry', () => ({
  desktopMainFeatureRegistry: { pages: [] },
}))

vi.mock('@/hooks/useSearchDialog', () => ({
  useSearchDialog: () => ({ open: true, setOpen: vi.fn() }),
}))

vi.mock('@/containers/dialogs/SearchDialog', () => ({
  SearchDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="search-dialog" /> : null,
}))

import { NavigationDialogs } from '../NavMain'

describe('NavigationDialogs', () => {
  it('hosts the search dialog independently of the sidebar', () => {
    render(<NavigationDialogs />)

    expect(screen.getByTestId('search-dialog')).toBeInTheDocument()
  })
})
