import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { codeToHtml } from 'shiki'

import { CodeBlock, CodeBlockCopyButton, highlightCode } from '../code-block'

const terminalOutput =
  '1: lo: <LOOPBACK,UP>\r\n    inet 127.0.0.1/8  scope host lo\r\n\r\n' +
  '\tvalid_lft forever  preferred_lft forever\r\n'

vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue('<pre><code>highlighted</code></pre>'),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(codeToHtml).mockResolvedValue(
    '<pre><code>highlighted</code></pre>'
  )
})

describe('highlightCode', () => {
  it('returns light and dark HTML strings', async () => {
    const [light, dark] = await highlightCode('const x = 1', 'typescript')

    expect(codeToHtml).toHaveBeenCalledTimes(2)
    expect(codeToHtml).toHaveBeenCalledWith(
      'const x = 1',
      expect.objectContaining({ theme: 'one-light' })
    )
    expect(codeToHtml).toHaveBeenCalledWith(
      'const x = 1',
      expect.objectContaining({ theme: 'one-dark-pro' })
    )
    expect(light).toBe('<pre><code>highlighted</code></pre>')
    expect(dark).toBe('<pre><code>highlighted</code></pre>')
  })

  it('passes line number transformer when showLineNumbers is true', async () => {
    await highlightCode('code', 'javascript', true)

    expect(codeToHtml).toHaveBeenCalledWith(
      'code',
      expect.objectContaining({
        transformers: expect.arrayContaining([
          expect.objectContaining({ name: 'line-numbers' }),
        ]),
      })
    )
  })

  it('passes empty transformers when showLineNumbers is false', async () => {
    await highlightCode('code', 'javascript', false)

    expect(codeToHtml).toHaveBeenCalledWith(
      'code',
      expect.objectContaining({ transformers: [] })
    )
  })
})

describe('CodeBlock', () => {
  it('renders raw code immediately while highlighting is pending', () => {
    vi.mocked(codeToHtml).mockImplementation(() => new Promise(() => {}))

    const { container, rerender } = render(
      <CodeBlock code={terminalOutput} language="shell" />
    )

    const pre = container.querySelector('pre')!
    expect(pre.textContent).toBe(terminalOutput)
    expect(pre).toHaveClass('overflow-auto', 'whitespace-pre')
    expect(pre).not.toHaveClass('whitespace-pre-wrap', 'break-words')

    rerender(<CodeBlock code='{"output":"/workspace"}' language="json" />)
    expect(screen.getByText('{"output":"/workspace"}')).toBeInTheDocument()
  })

  it('keeps terminal whitespace and horizontal scrolling when highlighting fails', async () => {
    vi.mocked(codeToHtml).mockRejectedValue(new Error('Highlight unavailable'))

    const { container } = await act(async () =>
      render(<CodeBlock code={terminalOutput} language="shell" />)
    )

    const pre = container.querySelector('pre')!
    expect(pre.textContent).toBe(terminalOutput)
    expect(pre).toHaveClass('overflow-auto', 'whitespace-pre')
    expect(pre).not.toHaveClass('whitespace-pre-wrap', 'break-words')
  })

  it('renders and calls codeToHtml to highlight code', async () => {
    render(<CodeBlock code="const x = 1" language="typescript" />)

    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalled()
    })
  })

  it('shows light and dark theme containers', async () => {
    const { container } = render(
      <CodeBlock code="hello" language="javascript" />
    )

    await waitFor(() => {
      const lightDiv = container.querySelector('.dark\\:hidden')
      const darkDiv = container.querySelector('.dark\\:block')
      expect(lightDiv).toBeInTheDocument()
      expect(darkDiv).toBeInTheDocument()
    })
  })

  it('renders highlighted HTML after loading', async () => {
    const { container } = render(
      <CodeBlock code="const x = 1" language="typescript" />
    )

    await waitFor(() => {
      expect(container.innerHTML).toContain('highlighted')
    })
  })

  it('passes children positioned absolutely', async () => {
    await act(async () => render(
      <CodeBlock code="const x = 1" language="typescript">
        <span data-testid="child">Copy</span>
      </CodeBlock>
    ))

    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.getByTestId('child').parentElement).toHaveClass('absolute')
  })
})

describe('CodeBlockCopyButton', () => {
  it.each(['pending', 'highlighted', 'failed'])(
    'copies terminal text exactly while highlighting is %s',
    async (state) => {
      const user = userEvent.setup()
      if (state === 'pending') {
        vi.mocked(codeToHtml).mockImplementation(() => new Promise(() => {}))
      } else if (state === 'failed') {
        vi.mocked(codeToHtml).mockRejectedValue(new Error('Highlight unavailable'))
      }

      render(
        <CodeBlock code={terminalOutput} language="shell">
          <CodeBlockCopyButton />
        </CodeBlock>
      )

      // Spy on the clipboard writeText that userEvent.setup() provides
      const writeTextSpy = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue(undefined)

      const button = screen.getByRole('button')
      await user.click(button)

      await waitFor(() => {
        expect(writeTextSpy).toHaveBeenCalledWith(terminalOutput)
      })
    }
  )

  it('shows CheckIcon after copy', async () => {
    const user = userEvent.setup()

    render(
      <CodeBlock code="const x = 1" language="typescript">
        <CodeBlockCopyButton />
      </CodeBlock>
    )

    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)

    const button = screen.getByRole('button')
    await user.click(button)

    await waitFor(() => {
      // After copy, the icon changes from CopyIcon to CheckIcon
      const svg = button.querySelector('svg')
      expect(svg).toBeInTheDocument()
    })
  })

  it('calls onCopy callback', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn()

    render(
      <CodeBlock code="const x = 1" language="typescript">
        <CodeBlockCopyButton onCopy={onCopy} />
      </CodeBlock>
    )

    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)

    const button = screen.getByRole('button')
    await user.click(button)

    await waitFor(() => {
      expect(onCopy).toHaveBeenCalledOnce()
    })
  })

  it('calls onError when clipboard API is unavailable', async () => {
    const user = userEvent.setup()
    const onError = vi.fn()

    render(
      <CodeBlock code="const x = 1" language="typescript">
        <CodeBlockCopyButton onError={onError} />
      </CodeBlock>
    )

    // Remove clipboard after userEvent.setup() attached it
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    const button = screen.getByRole('button')
    await user.click(button)

    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Clipboard API not available' })
    )
  })

  it('calls onError when writeText rejects', async () => {
    const user = userEvent.setup()
    const onError = vi.fn()
    const writeError = new Error('Permission denied')

    render(
      <CodeBlock code="const x = 1" language="typescript">
        <CodeBlockCopyButton onError={onError} />
      </CodeBlock>
    )

    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(
      writeError
    )

    const button = screen.getByRole('button')
    await user.click(button)

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(writeError)
    })
  })
})
