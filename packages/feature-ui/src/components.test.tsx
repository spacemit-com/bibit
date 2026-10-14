import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_ICON_KEYS } from '@bibit/feature-contracts'
import {
  Button,
  Dialog,
  FeatureEmptyState,
  FeatureErrorState,
  FeatureSettingsPage,
  Skeleton,
  getFeatureIcon,
} from './index'

describe('Feature UI public surface', () => {
  it('renders accessible primitives and stable states', () => {
    const html = renderToStaticMarkup(
      <>
        <Button ref={createRef<HTMLButtonElement>()}>Save</Button>
        <Dialog open title="Confirm" onClose={() => undefined}>Body</Dialog>
        <Skeleton aria-label="Loading" />
        <FeatureErrorState title="Failed" onRetry={() => undefined} />
        <FeatureEmptyState title="Empty" />
        <FeatureSettingsPage title="Memory">Content</FeatureSettingsPage>
      </>
    )
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Memory')
    expect(getFeatureIcon('memory')).toBeTypeOf('function')
    expect(getFeatureIcon('unknown' as never)).toBe(getFeatureIcon('feature'))
  })

  it('draws a non-empty glyph for every catalogued icon key', () => {
    for (const key of FEATURE_ICON_KEYS) {
      const html = renderToStaticMarkup(<>{getFeatureIcon(key)({})}</>)
      expect(html, key).toMatch(/^<svg[\s\S]*<[a-z]+[\s\S]*<\/svg>$/)
    }
  })

  it('supports child focus, Escape close, and unique labels for multiple dialogs', async () => {
    const user = userEvent.setup()
    const firstClose = vi.fn()
    const secondClose = vi.fn()
    render(
      <>
        <Dialog open title="First dialog" onClose={firstClose}>
          <button type="button">First action</button>
        </Dialog>
        <Dialog open title="Second dialog" onClose={secondClose}>
          <button type="button">Second action</button>
        </Dialog>
      </>
    )
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
    expect(dialogs[0].getAttribute('aria-labelledby')).not.toBe(
      dialogs[1].getAttribute('aria-labelledby')
    )
    await waitFor(() => expect(dialogs[1].contains(document.activeElement)).toBe(true))
    await user.tab()
    expect(document.activeElement).toBe(dialogs[1].querySelector('button'))
    await user.keyboard('{Escape}')
    expect(secondClose).toHaveBeenCalledTimes(1)
  })
})
