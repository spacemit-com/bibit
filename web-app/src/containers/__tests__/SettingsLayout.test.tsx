import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsLayout } from '../SettingsLayout'

vi.mock('../HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))

vi.mock('../SettingsMenu', () => ({
  default: () => <nav>Settings menu</nav>,
}))
describe('SettingsLayout', () => {
  it('owns the settings header, menu and scrollable content slot', () => {
    render(
      <SettingsLayout>
        <div>Feature content</div>
      </SettingsLayout>
    )

    expect(screen.getByRole('banner')).toHaveTextContent('Settings')
    expect(screen.getByRole('navigation')).toHaveTextContent('Settings menu')
    const content = screen
      .getByText('Feature content')
      .closest('[data-settings-content]')
    expect(content).toHaveClass('overflow-y-auto')
    expect(content).toHaveTextContent('Feature content')
  })
})
