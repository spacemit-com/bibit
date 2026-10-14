import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HeaderPage from '../HeaderPage'
import { useSettingsNavigation } from '@/hooks/useSettingsNavigation'

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  open: true,
  pathname: '/settings/general',
  leftButtons: ['minimize', 'maximize', 'close'],
  rightButtons: [] as string[],
}))

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: h.pathname }),
  useNavigate: () => h.navigate,
}))

vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: () => ({ open: h.open, setLeftPanel: vi.fn() }),
}))

vi.mock('@/stores/titlebar-layout-store', () => ({
  useTitlebarLayout: (
    selector: (state: { layout: { left: string[]; right: string[] } }) => unknown
  ) => selector({ layout: { left: h.leftButtons, right: h.rightButtons } }),
}))

describe('HeaderPage', () => {
  beforeEach(() => {
    h.navigate.mockReset()
    h.open = true
    h.pathname = '/settings/general'
    h.leftButtons = ['minimize', 'maximize', 'close']
    h.rightButtons = []
    useSettingsNavigation.setState({ origin: null })
  })

  it('returns from settings to the recorded origin', () => {
    useSettingsNavigation.setState({ origin: '/threads/thread-1?mode=agent#output' })
    render(<HeaderPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(h.navigate).toHaveBeenCalledWith({
      href: '/threads/thread-1?mode=agent#output',
    })
  })

  it('falls back home when settings has no recorded origin', () => {
    render(<HeaderPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(h.navigate).toHaveBeenCalledWith({ href: '/' })
  })

  it('reserves left-side native controls while settings hides the sidebar', () => {
    const { container } = render(<HeaderPage />)

    expect(container.firstChild).toHaveStyle({ paddingLeft: '120px' })
  })

  it('reserves right-side native controls so header actions stay clear of them', () => {
    h.leftButtons = []
    h.rightButtons = ['minimize', 'maximize', 'close']
    const { container } = render(<HeaderPage />)

    expect(container.firstChild).toHaveStyle({ paddingRight: '120px' })
  })

  it('leaves the right strip alone when the DE anchors no control there', () => {
    h.leftButtons = ['minimize', 'maximize', 'close']
    const { container } = render(<HeaderPage />)

    expect((container.firstChild as HTMLElement).style.paddingRight).toBe('')
  })
})
