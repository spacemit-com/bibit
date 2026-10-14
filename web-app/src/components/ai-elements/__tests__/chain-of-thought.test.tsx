import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'

// The reasoning header shows user-facing copy, so this suite renders it with
// the real translator instead of the key-echoing test default.
vi.mock('../shimmer', () => ({
  Shimmer: ({ children }: { children: ReactNode }) => (
    <span data-testid="shimmer">{children}</span>
  ),
}))

import {
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtContent,
  useChainOfThought,
} from '../chain-of-thought'

describe('ChainOfThought', () => {
  it('renders children inside a Collapsible, defaults open', () => {
    render(
      <ChainOfThought>
        <ChainOfThoughtHeader />
        <ChainOfThoughtContent>
          <p>Inner content</p>
        </ChainOfThoughtContent>
      </ChainOfThought>
    )
    expect(screen.getByText('Inner content')).toBeInTheDocument()
  })

  it('defaults to open state', () => {
    render(
      <ChainOfThought>
        <ChainOfThoughtHeader />
        <ChainOfThoughtContent>
          <p>Visible</p>
        </ChainOfThoughtContent>
      </ChainOfThought>
    )
    expect(screen.getByText('Visible')).toBeVisible()
  })

  it('can start closed with defaultOpen=false', () => {
    render(
      <ChainOfThought defaultOpen={false}>
        <ChainOfThoughtHeader />
        <ChainOfThoughtContent>
          <p>Hidden content</p>
        </ChainOfThoughtContent>
      </ChainOfThought>
    )
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument()
  })

  it('auto-collapses when shouldCollapse becomes true', () => {
    const { rerender } = render(
      <ChainOfThought shouldCollapse={false}>
        <ChainOfThoughtHeader />
        <ChainOfThoughtContent>
          <p>Content here</p>
        </ChainOfThoughtContent>
      </ChainOfThought>
    )
    expect(screen.getByText('Content here')).toBeInTheDocument()

    rerender(
      <ChainOfThought shouldCollapse={true}>
        <ChainOfThoughtHeader />
        <ChainOfThoughtContent>
          <p>Content here</p>
        </ChainOfThoughtContent>
      </ChainOfThought>
    )
    expect(screen.queryByText('Content here')).not.toBeInTheDocument()
  })

  it('calls onOpenChange when toggled', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <ChainOfThought onOpenChange={onOpenChange}>
        <ChainOfThoughtHeader />
        <ChainOfThoughtContent>
          <p>Content</p>
        </ChainOfThoughtContent>
      </ChainOfThought>
    )
    await user.click(screen.getByRole('button'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('ChainOfThoughtHeader', () => {
  it('shows the streaming label while thinking', () => {
    render(
      <ChainOfThought isStreaming={true}>
        <ChainOfThoughtHeader />
      </ChainOfThought>
    )
    expect(screen.getByTestId('shimmer')).toHaveTextContent('Thinking…')
  })

  it('shows the completed label when no duration was observed', () => {
    render(
      <ChainOfThought isStreaming={false}>
        <ChainOfThoughtHeader />
      </ChainOfThought>
    )
    expect(screen.getByText('Thought')).toBeInTheDocument()
  })

  it('reports the observed duration once the stream stops', async () => {
    vi.useFakeTimers()
    const view = (streaming: boolean) => (
      <ChainOfThought isStreaming={streaming} defaultOpen={false}>
        <ChainOfThoughtHeader />
      </ChainOfThought>
    )
    const { rerender } = render(view(true))
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    rerender(view(false))
    expect(screen.getByText('Thought for 2s')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('prefers an explicit title over the default label', () => {
    render(
      <ChainOfThought isStreaming={false}>
        <ChainOfThoughtHeader title="Analyzing code" />
      </ChainOfThought>
    )
    expect(screen.getByText('Analyzing code')).toBeInTheDocument()
  })

  it('renders custom children instead of default content', () => {
    render(
      <ChainOfThought>
        <ChainOfThoughtHeader>
          <span>Custom header</span>
        </ChainOfThoughtHeader>
      </ChainOfThought>
    )
    expect(screen.getByText('Custom header')).toBeInTheDocument()
    expect(screen.queryByText('Thought')).not.toBeInTheDocument()
  })
})

describe('ChainOfThoughtContent', () => {
  it('renders children inside CollapsibleContent', () => {
    render(
      <ChainOfThought>
        <ChainOfThoughtHeader />
        <ChainOfThoughtContent>
          <p>Step details</p>
        </ChainOfThoughtContent>
      </ChainOfThought>
    )
    expect(screen.getByText('Step details')).toBeInTheDocument()
  })
})

describe('useChainOfThought', () => {
  it('throws when used outside ChainOfThought', () => {
    // Suppress console.error from React for the expected error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => {
      renderHook(() => useChainOfThought())
    }).toThrow('ChainOfThought components must be used within ChainOfThought')
    spy.mockRestore()
  })

  it('returns context values when used inside ChainOfThought', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChainOfThought isStreaming={true}>{children}</ChainOfThought>
    )
    const { result } = renderHook(() => useChainOfThought(), { wrapper })
    expect(result.current.isStreaming).toBe(true)
    expect(result.current.isOpen).toBe(true)
    expect(typeof result.current.setIsOpen).toBe('function')
  })
})
