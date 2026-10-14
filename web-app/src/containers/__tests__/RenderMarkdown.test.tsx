import { render, waitFor, act, cleanup, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RenderMarkdown } from '../RenderMarkdown'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { markProjectionDone, markStreamArrival, resetStreamTimings, setStreamTimingsEnabled, streamTimingReport } from '@/lib/stream-timings'
import { projectSessionEvents, type SessionEvent } from '@/lib/runtime-session-projection'

vi.mock('@i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

// Mock clipboard API
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn(),
  },
})

describe('RenderMarkdown', () => {
  it('keeps a plain paragraph DOM when it closes and the stream ends', async () => {
    const view = render(<RenderMarkdown content="First paragraph." isStreaming />)
    const paragraph = view.container.querySelector('p')
    view.rerender(<RenderMarkdown content={'First paragraph.\n\nNext'} isStreaming />)
    await waitFor(() => expect(view.container.textContent).toContain('Next'))
    expect(view.container.querySelector('p')).toBe(paragraph)
    view.rerender(<RenderMarkdown content={'First paragraph.\n\nNext'} />)
    expect(view.container.querySelector('p')).toBe(paragraph)
  })

  it('commits body text before closed rich blocks and cancels obsolete refinement', async () => {
    const callbacks = new Map<number, IdleRequestCallback>()
    let nextId = 0
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      callbacks.set(++nextId, callback)
      return nextId
    })
    vi.stubGlobal('cancelIdleCallback', (id: number) => callbacks.delete(id))
    const view = render(<RenderMarkdown content={'```js\nconst old = 1\n```\n\n$$x^2$$\n\nBody'} isStreaming />)
    try {
      expect(view.container.textContent).toContain('Body')
      expect(view.container.textContent).toContain('const old = 1')
      expect(view.container.querySelector('[data-streamdown="code-block"]')).toBeNull()
      expect(view.container.querySelector('.katex')).toBeNull()
      const obsolete = [...callbacks.keys()]
      // Final text bypasses the throttle, but still does not wait for refinement.
      view.rerender(<RenderMarkdown content={'```js\nconst new = 2\n```\n\n$$y^2$$\n\nFinal body'} />)
      expect(view.container.textContent).toContain('Final body')
      expect(view.container.textContent).toContain('const new = 2')
      expect(obsolete.every(id => !callbacks.has(id))).toBe(true)
      await act(async () => {
        for (const [id, callback] of [...callbacks]) {
          callbacks.delete(id)
          callback({ didTimeout: true, timeRemaining: () => 0 })
        }
      })
      await waitFor(() => expect(view.container.querySelector('[data-streamdown="code-block"]')).toBeTruthy())
      expect(view.container.querySelector('.katex')).toBeTruthy()
      expect(view.container.textContent).not.toContain('const old = 1')
      view.rerender(<RenderMarkdown content={'```js\nconst end = 3\n```'} />)
      expect(callbacks.size).toBeGreaterThan(0)
      view.unmount()
      expect(callbacks.size).toBe(0)
    } finally {
      view.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('keeps context-sensitive numbered paragraphs equivalent after streaming and history reopen', async () => {
    const content = '    example\n\n2. second\n3. third\n\nTail'
    const view = render(<RenderMarkdown content={content} isStreaming />)
    view.rerender(<RenderMarkdown content={content} isStreaming={false} />)
    await waitFor(() => expect(view.container.textContent).toContain('Tail'))
    const shape = () => [...view.container.querySelectorAll('p,ol,li')].map(node => [node.tagName, node.textContent])
    const streamed = shape()
    view.unmount()
    const history = render(<RenderMarkdown content={content} />)
    expect([...history.container.querySelectorAll('p,ol,li')].map(node => [node.tagName, node.textContent])).toEqual(streamed)
  })
  it('finishes code and math blocks before the response ends and keeps their DOM', async () => {
    const prefix = 'First paragraph.\n\n```js\nconst x = 1\n```\n\n$$\nx^2\n$$\n\n'
    const view = render(<RenderMarkdown content={prefix + 'Tail'} isStreaming />)
    await waitFor(() => expect(view.container.querySelector('[data-streamdown="code-block"]')).toBeTruthy())
    await waitFor(() => expect(view.container.querySelector('.katex')).toBeTruthy())
    const paragraph = view.container.querySelector('p')
    const codeBlock = view.container.querySelector('[data-streamdown="code-block"]')
    const math = view.container.querySelector('.katex')
    view.rerender(<RenderMarkdown content={prefix + 'Tail grows'} isStreaming />)
    await waitFor(() => expect(view.container.textContent).toContain('Tail grows'))
    view.rerender(<RenderMarkdown content={prefix + 'Tail grows'} />)
    expect(view.container.querySelector('p')).toBe(paragraph)
    expect(view.container.querySelector('[data-streamdown="code-block"]')).toBe(codeBlock)
    expect(view.container.querySelector('.katex')).toBe(math)
  })

  it('keeps an unfinished fence lightweight and upgrades it as soon as it closes', async () => {
    const content = '```js\nconst x = 1\n'
    const view = render(<RenderMarkdown content={content} isStreaming />)
    expect(view.container.textContent).toContain('const x = 1')
    expect(view.container.querySelector('[data-streamdown="code-block"]')).toBeNull()
    view.rerender(<RenderMarkdown content={content + '```'} isStreaming />)
    await waitFor(() => expect(view.container.querySelector('[data-streamdown="code-block"]')).toBeTruthy())
  })

  it.each([
    ['~~~js\nconst x = "<tag>"\n~~~', 'const x = "<tag>"'],
    ['````text\n```\nvalue\n````', '```\nvalue'],
    ['```text\n\\[not math\\]\n```', '\\[not math\\]'],
  ])('preserves literal code before and after refinement: %s', async (content, expected) => {
    const view = render(<RenderMarkdown content={content + '\n\nBody'} isStreaming />)
    expect(view.container.querySelector('pre code')?.textContent).toContain(expected)
    await waitFor(() => expect(view.container.querySelector('[data-streamdown="code-block"]')).toBeTruthy())
    // 高亮器以独立行 span 排版，textContent 不包含行之间的换行符。
    expect(view.container.querySelector('pre code')?.textContent?.replace(/\n/g, ''))
      .toContain(expected.replace(/\n/g, ''))
    expect(view.container.querySelector('.katex')).toBeNull()
  })

  it('resolves late reference definitions without losing previously rendered text', async () => {
    const content = 'Read [the guide][guide].\n\nMore text.'
    const view = render(<RenderMarkdown content={content} isStreaming />)
    view.rerender(<RenderMarkdown content={content + '\n\n[guide]: https://example.com/guide'} isStreaming />)
    await waitFor(() => expect(view.container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/guide'))
    expect(view.container.textContent).toContain('More text.')
  })

  it('normalizes bracket math with blank lines when its block closes', async () => {
    const view = render(<RenderMarkdown content={'\\[\nx^2\n\n+ y^2\n\\]\n\nTail'} isStreaming />)
    await waitFor(() => expect(view.container.querySelector('.katex')).toBeTruthy())
    expect(view.container.textContent).toContain('Tail')
  })

  it('updates display props even when text is unchanged', () => {
    const view = render(<RenderMarkdown content="Same text" className="before" />)
    view.rerender(<RenderMarkdown content="Same text" className="after" isUser />)
    expect(view.container.querySelector('.markdown')?.classList.contains('after')).toBe(true)
    expect(view.container.querySelector('.markdown')?.classList.contains('is-user')).toBe(true)
  })

  it('replaces same-length text and finalizes math without stale position-based nodes', async () => {
    const view = render(<RenderMarkdown content={'Hello\n\n$$\nx^2\n'} isStreaming />)
    expect(view.container.querySelector('.katex')).toBeNull()
    view.rerender(<RenderMarkdown content={'Hello\n\n$$\nx^2\n$$'} isStreaming />)
    await waitFor(() => expect(view.container.querySelector('.katex')).toBeTruthy())
    view.rerender(<RenderMarkdown content={'World\n\n$$\nx^2\n$$'} />)
    expect(view.container.textContent).toContain('World')
    expect(view.container.textContent).not.toContain('Hello')
  })

  describe('command output preservation', () => {
    const output = '1: lo: <LOOPBACK,UP>\n    inet 127.0.0.1/8  scope host lo\n\n\tvalid_lft forever\n    $100 \\(x\\) word**,** [[cite:https://example.com]]'
    // Streamdown renders highlighted lines as block spans, not newline nodes.
    const readCode = (container: HTMLElement) => {
      const code = container.querySelector('pre code')
      return code?.children.length
        ? Array.from(code.children, (line) => line.textContent).join('\n')
        : code?.textContent
    }

    it.each(['```', '~~~', '~~~text', '````text'])('preserves output and copies literal text in %s', async (opener) => {
      const closer = opener.startsWith('~') ? '~~~' : opener.match(/^`+/)![0]
      const { container, getByRole } = render(
        <RenderMarkdown content={`${opener}\n${output}\n${closer}`} />
      )
      await waitFor(() => expect(readCode(container)).toBe(output))
      fireEvent.click(getByRole('button', { name: /copy/i }))
      // mdast -> hast adds one terminal LF; the body copy button keeps it.
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(`${output}\n`))
    })

    it('protects unclosed streamed code and the completed message', async () => {
      const { container, rerender } = render(
        <RenderMarkdown content={`~~~text\n${output}`} isStreaming />
      )
      await waitFor(() => expect(container.querySelector('pre code')?.textContent).toBe(`${output}\n`))
      expect(container.querySelector('a')).toBeNull()
      rerender(<RenderMarkdown content={`~~~text\n${output}\n~~~`} isStreaming={false} />)
      await waitFor(() => expect(readCode(container)).toBe(output))
    })

    it('protects multi-backtick inline code and literal placeholder-like input', () => {
      const literal = '` $100 \\(x\\) [[cite:https://example.com]]'
      const marker = '\uE000L0\uE000'
      const { container } = render(<RenderMarkdown content={`${marker} $x$ and \`\` ${literal} \`\``} />)
      expect(container.querySelector('code')?.textContent).toBe(literal)
      expect(container.textContent).toContain(marker)
      expect(container.querySelector('.katex')).toBeTruthy()
    })

    it('keeps spaces and emphasis around inline code while streaming', () => {
      const { container } = render(<RenderMarkdown content={'**use `ip a` now**'} isStreaming />)
      expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('use ip a now')
    })

    it.each([
      '> ~~~\n>     $100 [[cite:https://example.com]]\n> ~~~',
      '- output:\n\n  ~~~\n      $100 [[cite:https://example.com]]\n  ~~~',
    ])('protects a nested fenced block', async (content) => {
      const { container } = render(<RenderMarkdown content={content} />)
      await waitFor(() => expect(container.querySelector('pre code')?.textContent).toBe('    $100 [[cite:https://example.com]]'))
    })
  })

  it('preserves line breaks in model responses (when isUser == undefined)', () => {
    const modelResponseWithNewLines = `This is line 1
    This is line 2
    This is line 3`
    render(<RenderMarkdown content={modelResponseWithNewLines} />)
    const markdownContainer = document.querySelector('.markdown')
    // Line breaks are preserved as newlines in the rendered HTML (not <br> tags)
    const text = markdownContainer?.textContent || ''
    expect(text).toContain('This is line 1')
    expect(text).toContain('This is line 2')
    expect(text).toContain('This is line 3')
  })

  it('preserves line breaks in user message (when isUser == true)', () => {
    const userMessageWithNewlines = `User question line 1
    User question line 2
    User question line 3`
    render(<RenderMarkdown content={userMessageWithNewlines} isUser={true} />)
    const markdownContainer = document.querySelector('.markdown')
    expect(markdownContainer).toBeTruthy()
    // Line breaks are preserved as newlines in the rendered HTML
    const text = markdownContainer?.textContent || ''
    expect(text).toContain('User question line 1')
    expect(text).toContain('User question line 2')
    expect(text).toContain('User question line 3')
  })

  it('turns single newlines into <br> when softBreaks is set', () => {
    // Reasoning text separates lines with a bare \n, which CommonMark folds into
    // a space. The CoT card opts into softBreaks so a thought keeps its shape.
    const { container } = render(
      <RenderMarkdown content={'thought one\nthought two'} softBreaks />
    )
    expect(container.querySelectorAll('br').length).toBeGreaterThan(0)
  })

  it('folds single newlines into one paragraph without softBreaks', () => {
    const { container } = render(
      <RenderMarkdown content={'body one\nbody two'} />
    )
    expect(container.querySelectorAll('br')).toHaveLength(0)
  })

  it('renders markdown structure inside reasoning content', () => {
    const { container } = render(
      <RenderMarkdown content={'## Plan\n\n- first\n- second'} softBreaks />
    )
    expect(container.querySelector('h2')?.textContent).toBe('Plan')
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it('preserves line breaks with different line ending types', () => {
    const contentWithDifferentLineEndings = 'Line1\nLine2\r\nLine3\rLine4'
    render(<RenderMarkdown content={contentWithDifferentLineEndings} />)
    const markdownContainer = document.querySelector('.markdown')
    // Line breaks are preserved as newlines in the rendered HTML
    const text = markdownContainer?.textContent || ''
    expect(text).toContain('Line1')
    expect(text).toContain('Line2')
    expect(text).toContain('Line3')
    expect(text).toContain('Line4')
  })

  it('handles empty lines correctly', () => {
    const contentWithEmptyLines =
      'Line 1\n\nLine 3 (after empty line)\n\nLine 5 (after two empty lines)'
    render(<RenderMarkdown content={contentWithEmptyLines} />)
    const markdownContainer = document.querySelector('.markdown')
    const text = markdownContainer?.textContent || ''
    // All content lines should be present
    expect(text).toContain('Line 1')
    expect(text).toContain('Line 3 (after empty line)')
    expect(text).toContain('Line 5 (after two empty lines)')
  })

  describe('LaTeX normalization - dollar sign escaping', () => {
    it('escapes dollar signs followed by numbers to prevent LaTeX interpretation', () => {
      const content = 'The price is $200 for the item'
      render(<RenderMarkdown content={content} />)
      const markdownContainer = document.querySelector('.markdown')
      const text = markdownContainer?.textContent || ''
      expect(text).toContain('$200')
    })

    it('handles multiple dollar amounts in the same content', () => {
      const content = 'Items cost $100, $200, and $350 respectively'
      render(<RenderMarkdown content={content} />)
      const markdownContainer = document.querySelector('.markdown')
      const text = markdownContainer?.textContent || ''
      expect(text).toContain('$100')
      expect(text).toContain('$200')
      expect(text).toContain('$350')
    })

    it('handles single digit dollar amounts', () => {
      const content = 'Only $5 or $9 available'
      render(<RenderMarkdown content={content} />)
      const markdownContainer = document.querySelector('.markdown')
      const text = markdownContainer?.textContent || ''
      expect(text).toContain('$5')
      expect(text).toContain('$9')
    })

    it('handles large dollar amounts', () => {
      const content = 'The total is $1000000 for the project'
      render(<RenderMarkdown content={content} />)
      const markdownContainer = document.querySelector('.markdown')
      const text = markdownContainer?.textContent || ''
      expect(text).toContain('$1000000')
    })

    it('preserves dollar amounts in sentences with mixed content', () => {
      const content = 'I paid $50 yesterday and will pay $75 tomorrow.'
      render(<RenderMarkdown content={content} />)
      const markdownContainer = document.querySelector('.markdown')
      const text = markdownContainer?.textContent || ''
      expect(text).toContain('$50')
      expect(text).toContain('$75')
    })

    it('does not interfere with actual LaTeX inline math', () => {
      const content = 'The equation $x + y = z$ is simple'
      render(<RenderMarkdown content={content} />)
      const katexContainer = document.querySelector('.katex')
      // LaTeX should be rendered (KaTeX will process it)
      expect(katexContainer).toBeTruthy()
    })

    it('does not interfere with actual LaTeX inline math (numerical expression)', () => {
      const content = 'The equation $12 \\times 12 = 144$ is simple'
      render(<RenderMarkdown content={content} />)
      const katexContainer = document.querySelector('.katex')
      // LaTeX should be rendered (KaTeX will process it)
      expect(katexContainer).toBeTruthy()
    })

    it('does not interfere with display math blocks', () => {
      const content = '$$\nx^2 + y^2 = r^2\n$$'
      render(<RenderMarkdown content={content} />)
      const katexContainer = document.querySelector('.katex')
      // Display math should be rendered
      expect(katexContainer).toBeTruthy()
    })

    it('does not interfere with display math blocks (numerical expression)', () => {
      const content = '$$12 \\times 12 = 144$$'
      render(<RenderMarkdown content={content} />)
      const katexContainer = document.querySelector('.katex')
      const katexError = document.querySelector('.katex-error')
      // Display math should be rendered
      expect(katexContainer).toBeTruthy()
      expect(katexError).toBeNull()
    })

    it('does not inject a ZWSP into subscripts (emphasis fix must skip math)', () => {
      // '_' is a LaTeX subscript; the emphasis-flanking fix must not touch it,
      // else KaTeX warns "Unrecognized Unicode character 8203" (U+200B).
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const content = 'The term $x_{i}$ and $a_1 + b_2$ are indexed'
      render(<RenderMarkdown content={content} />)
      expect(document.querySelector('.katex')).toBeTruthy()
      const warnedAboutZwsp = warn.mock.calls
        .flat()
        .some((arg) => typeof arg === 'string' && arg.includes('8203'))
      expect(warnedAboutZwsp).toBe(false)
      warn.mockRestore()
    })
  })

  it('does not format 4-space indented text as code blocks', () => {
    const contentWithIndentedText = `Please explain this code block.

    <!DOCTYPE html>
    <html lang="en">
    <body>
        <header>
            <h1>Welcome to My Website</h1>
            <p>A sample HTML document showcasing various HTML elements</p>
        </header>
        
        <nav>
            <a href="#home">Home</a>
            <a href="#about">About</a>
            <a href="#services">Services</a>
            <a href="#contact">Contact</a>
        </nav>
        
        <div class="container">
            <section id="home">
                <h2>Home</h2>
                <div class="card">
                    <p>This is a sample HTML document that demonstrates various HTML elements and their structure.</p>
                    <p>HTML (HyperText Markup Language) is the standard markup language for creating web pages.</p>
                </div>
            </section>
            
        </div>
        
        <footer>
            <p>&copy; ${new Date().getFullYear()} My Sample Website. All rights reserved.</p>
        </footer>
    </body>
    </html>
    `
    render(
      <RenderMarkdown
        content={contentWithIndentedText}
      />
    )
    const markdownContainer = document.querySelector('.markdown')
    const html = markdownContainer?.innerHTML || ''
    expect(html).not.toContain('<pre>')
    expect(html).toContain('<p>')
    // Left and right brackets get escaped as &lt; and &gt; respectively
    expect(html).toContain('&lt;!DOCTYPE html&gt;')
  })
  
  it('formats fenced code blocks correctly', async () => {
    const contentWithFencedCodeBlock = `Please explain this code block.

\`\`\`html
<!DOCTYPE html>
<html lang="en">
<body>
    <header>
        <h1>Welcome to My Website</h1>
        <p>A sample HTML document showcasing various HTML elements</p>
    </header>
    
    <nav>
        <a href="#home">Home</a>
        <a href="#about">About</a>
        <a href="#services">Services</a>
        <a href="#contact">Contact</a>
    </nav>
    
    <div class="container">
        <section id="home">
            <h2>Home</h2>
            <div class="card">
                <p>This is a sample HTML document that demonstrates various HTML elements and their structure.</p>
                <p>HTML (HyperText Markup Language) is the standard markup language for creating web pages.</p>
            </div>
        </section>
    </div>
    
    <footer>
        <p>&copy; ${new Date().getFullYear()} My Sample Website. All rights reserved.</p>
    </footer>
</body>
</html>
\`\`\`
`
    const { container, findByText}  = render(
      <RenderMarkdown
        content={contentWithFencedCodeBlock}
      />
    )
    // Wait for the code content to be rendered (async operation)
    await findByText('<!DOCTYPE html>', { exact: false })
    const markdownContainer = container.querySelector('.markdown')
    const text = markdownContainer?.textContent || ''
    const codeBlock = container.querySelector('[data-streamdown="code-block"]')
      // Check that the code content is present
    expect(text).toContain('<!DOCTYPE html>')
    expect(text).toContain('<html lang="en">')
    expect(text).toContain('Welcome to My Website')
    expect(codeBlock).toBeTruthy()
  })

  it('formats fenced code blocks without lang spec correctly', async () => {
    const contentWithFencedCodeBlock = `Please explain this code block.

\`\`\`
<!DOCTYPE html>
<html lang="en">
<body>
    <header>
        <h1>Welcome to My Website</h1>
        <p>A sample HTML document showcasing various HTML elements</p>
    </header>
    
    <nav>
        <a href="#home">Home</a>
        <a href="#about">About</a>
        <a href="#services">Services</a>
        <a href="#contact">Contact</a>
    </nav>
    
    <div class="container">
        <section id="home">
            <h2>Home</h2>
            <div class="card">
                <p>This is a sample HTML document that demonstrates various HTML elements and their structure.</p>
                <p>HTML (HyperText Markup Language) is the standard markup language for creating web pages.</p>
            </div>
        </section>
    </div>
    
    <footer>
        <p>&copy; ${new Date().getFullYear()} My Sample Website. All rights reserved.</p>
    </footer>
</body>
</html>
\`\`\`
`
    const { container, findByText}  = render(
      <RenderMarkdown
        content={contentWithFencedCodeBlock}
      />
    )
    // Wait for the code content to be rendered (async operation)
    await findByText('<!DOCTYPE html>', { exact: false })
    const markdownContainer = container.querySelector('.markdown')
    const text = markdownContainer?.textContent || ''
    const codeBlock = container.querySelector('[data-streamdown="code-block"]')
      // Check that the code content is present
    expect(text).toContain('<!DOCTYPE html>')
    expect(text).toContain('<html lang="en">')
    expect(text).toContain('Welcome to My Website')
    expect(codeBlock).toBeTruthy()
  })

  describe('LaTeX normalization - display math', () => {
    it('converts \\[...\\] to $$ display math', () => {
      const content = 'Here is math:\n\\[\nx^2 + y^2\n\\]\nDone'
      render(<RenderMarkdown content={content} />)
      const katexContainer = document.querySelector('.katex')
      // Display math should be rendered by KaTeX
      expect(katexContainer).toBeTruthy()
    })

    it('converts \\[...\\] to $$ display math (numerical expression)', () => {
      const content = 'Here is math:\n\\[\n3^2 + 4^2\n\\]\nDone'
      render(<RenderMarkdown content={content} />)
      const katexContainer = document.querySelector('.katex')
      // Display math should be rendered by KaTeX
      expect(katexContainer).toBeTruthy()
    })
  })

  describe('LaTeX normalization - inline math', () => {
    it('converts \\(...\\) to $ inline math', () => {
      const content = 'The formula \\(E = mc^2\\) is famous'
      render(<RenderMarkdown content={content} />)
      const katexContainer = document.querySelector('.katex')
      // Inline math should be rendered
      expect(katexContainer).toBeTruthy()
    })

    it('converts \\(...\\) to $ inline math (numerical expression)', () => {
      const content = 'The formula \\(3^2 + 4^2 = 5^2\\) is famous'
      render(<RenderMarkdown content={content} />)
      const katexContainer = document.querySelector('.katex')
      // Inline math should be rendered
      expect(katexContainer).toBeTruthy()
    })

    it('converts \\[...\\] mid-sentence (no surrounding newlines)', () => {
      const content = 'Inline display \\[a^2 + b^2\\] right here'
      render(<RenderMarkdown content={content} />)
      expect(document.querySelector('.katex')).toBeTruthy()
      expect(document.querySelector('.katex-error')).toBeNull()
    })
  })

  describe('LaTeX normalization - code block preservation', () => {
    it('does not process dollar amounts inside code blocks', () => {
      const content = '```\nconst price = $100\n```'
      render(<RenderMarkdown content={content} />)
      const markdownContainer = document.querySelector('.markdown')
      const text = markdownContainer?.textContent || ''
      // Code blocks should preserve original content
      expect(markdownContainer).toBeTruthy()
      expect(text).toContain('$100')
    })

    it('does not process dollar amounts inside inline code', () => {
      const content = 'Use `$100` in the variable'
      render(<RenderMarkdown content={content} />)
      const markdownContainer = document.querySelector('.markdown')
      const text = markdownContainer?.textContent || ''
      expect(text).toContain('$100')
    })

    it('does not convert bracket math inside inline code', () => {
      // Code is masked first, so \(x\) stays literal instead of becoming $x$.
      const content = 'Type `\\(x\\)` to write inline math'
      render(<RenderMarkdown content={content} />)
      const text = document.querySelector('.markdown')?.textContent || ''
      expect(text).toContain('\\(x\\)')
      expect(document.querySelector('.katex')).toBeNull()
    })
  })

  describe('emphasis glued to punctuation (CommonMark flanking)', () => {
    const strong = () =>
      document.querySelector('.markdown [data-streamdown="strong"]')

    it('renders bold punctuation glued to a word as strong', async () => {
      render(
        <RenderMarkdown content={'I went home**,** and slept'} isAnimating={false} />
      )
      await waitFor(() => expect(strong()).toBeTruthy())
      expect(strong()?.textContent?.replace(/​/g, '')).toBe(',')
      expect(document.querySelector('.markdown')?.textContent).not.toContain('**')
    })

    it('handles glued bold around CJK punctuation', async () => {
      render(<RenderMarkdown content={'中文**，**测试'} isAnimating={false} />)
      await waitFor(() => expect(strong()).toBeTruthy())
      expect(strong()?.textContent?.replace(/​/g, '')).toBe('，')
    })

    it('leaves stray asterisks alone (no false emphasis)', async () => {
      render(<RenderMarkdown content={'use 2 ** 3 maybe'} isAnimating={false} />)
      await waitFor(() =>
        expect(document.querySelector('.markdown p')).toBeTruthy()
      )
      expect(strong()).toBeNull()
    })

    it('does not touch normal bold spans', async () => {
      render(<RenderMarkdown content={'a **bold** word'} isAnimating={false} />)
      await waitFor(() => expect(strong()).toBeTruthy())
      expect(strong()?.textContent).toBe('bold')
    })
  })

  describe('LaTeX normalization - HTML tag recognition', () => {
    it('does not treat invalid ("<",">") pairs as HTML tag', () => {
      const content = '$1 < $2, So choose the $1 one.\n\n> quoted content'
      render(<RenderMarkdown content={content} />)
      const katexContainer = document.querySelector('.katex')
      // Should not treat < $2, So choose the $1 one.\n\n> as HTML tag
      expect(katexContainer).toBeNull()
    })
  })

  describe('interactive HTML artifacts', () => {
    const HTML_MSG = 'Here:\n\n```html\n<h1>hi</h1>\n```\n'

    // CodeBlock highlights via async Shiki; await the resulting <pre> so the
    // post-render state update settles inside the test rather than leaking.
    const flush = (container: HTMLElement) =>
      waitFor(() => expect(container.querySelector('pre')).toBeTruthy())

    afterEach(() => {
      // Unmount before resetting so the store update doesn't re-render a live,
      // subscribed RenderMarkdown outside act.
      cleanup()
      act(() => {
        useInterfaceSettings.getState().setRenderHtmlArtifacts(false)
      })
    })

    it('renders the Streamdown code block (not an artifact) when the setting is off', async () => {
      const { container } = render(<RenderMarkdown content={HTML_MSG} />)
      expect(container.querySelector('[data-testid="html-artifact"]')).toBeNull()
      expect(
        container.querySelector('[data-streamdown="code-block"]')
      ).toBeTruthy()
      await flush(container)
    })

    it('renders an HtmlArtifact when the setting is on and not streaming', async () => {
      useInterfaceSettings.getState().setRenderHtmlArtifacts(true)
      const { container } = render(<RenderMarkdown content={HTML_MSG} />)
      expect(
        container.querySelector('[data-testid="html-artifact"]')
      ).toBeTruthy()
      // Defaults to the Preview iframe (no async Shiki highlight to flush).
      expect(
        container.querySelector('[data-testid="html-artifact-iframe"]')
      ).toBeTruthy()
    })

    it('falls through to the code block while streaming even when the setting is on', async () => {
      useInterfaceSettings.getState().setRenderHtmlArtifacts(true)
      const { container } = render(
        <RenderMarkdown content={HTML_MSG} isStreaming />
      )
      expect(container.querySelector('[data-testid="html-artifact"]')).toBeNull()
      await flush(container)
    })

    it('does not create an artifact for non-html code when the setting is on', async () => {
      useInterfaceSettings.getState().setRenderHtmlArtifacts(true)
      const { container } = render(
        <RenderMarkdown content={'```js\nconst x = 1\n```'} />
      )
      expect(container.querySelector('[data-testid="html-artifact"]')).toBeNull()
      await flush(container)
    })
  })

  describe('web citation markers', () => {
    it('renders a [[cite:URL]] marker as a favicon link to the source', () => {
      const { container } = render(
        <RenderMarkdown
          content={'Paris is the capital of France.[[cite:https://en.wikipedia.org/wiki/Paris]]'}
          messageId="m1"
        />
      )
      const link = container.querySelector(
        'a[href="https://en.wikipedia.org/wiki/Paris"]'
      )
      expect(link).toBeTruthy()
      expect(link?.querySelector('img')).toBeTruthy()
      // The raw marker text must not leak into the rendered output.
      expect(container.textContent).not.toContain('[[cite:')
    })

    it('normalizes a scheme-less marker URL to https', () => {
      const { container } = render(
        <RenderMarkdown
          content={'The TPU is fast.[[cite:example.com/article/foo-bar]]'}
          messageId="m3"
        />
      )
      const link = container.querySelector(
        'a[href="https://example.com/article/foo-bar"]'
      )
      expect(link).toBeTruthy()
      expect(link?.querySelector('img')).toBeTruthy()
      expect(container.textContent).not.toContain('[[cite:')
    })

    it('leaves text without markers untouched', () => {
      const { container } = render(
        <RenderMarkdown content={'No citations here.'} messageId="m2" />
      )
      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toContain('No citations here.')
    })
  })

  // 流式节流的两条不变量：首段不额外等待，终态一次性给全文。
  describe('streaming cadence', () => {
    it('节流提交按实际显示的正文配对，后到事件不提前消耗', () => {
      vi.useFakeTimers()
      vi.setSystemTime(1000)
      const now = vi.spyOn(performance, 'now').mockReturnValue(0)
      const log = vi.spyOn(console, 'info').mockImplementation(() => {})
      resetStreamTimings()
      setStreamTimingsEnabled(true)
      const view = render(<RenderMarkdown messageId="r1:1" content="Seed" isStreaming />)
      const project = (seq: number, text: string) => {
        const events: SessionEvent[] = [{ seq: 1, time: 0, type: 'assistant/text.delta', run_id: 'r1', data: { text, seq_range: [1, seq] } }]
        markProjectionDone(1, 's1', events, projectSessionEvents(events).messages)
        view.rerender(<RenderMarkdown messageId="r1:1" content={text + '\n'} isStreaming />)
      }
      try {
        act(() => vi.advanceTimersByTime(20))
        now.mockReturnValue(20)
        markStreamArrival('s1', 'r1', 1)
        project(1, 'Seed A')
        act(() => vi.advanceTimersByTime(79))
        now.mockReturnValue(99)
        markStreamArrival('s1', 'r1', 2)
        now.mockReturnValue(100)
        act(() => vi.advanceTimersByTime(1))
        expect(view.container.textContent).toContain('Seed A')
        expect(streamTimingReport().commitLatencyMs).toMatchObject({ count: 1, p50: 80 })
        project(2, 'Seed AB')
        expect(view.container.textContent).not.toContain('Seed AB')
        now.mockReturnValue(200)
        act(() => vi.advanceTimersByTime(100))
        expect(view.container.textContent).toContain('Seed AB')
        expect(streamTimingReport().commitLatencyMs).toMatchObject({ count: 2, p95: 101 })
      } finally {
        view.unmount()
        setStreamTimingsEnabled(false)
        resetStreamTimings()
        now.mockRestore()
        log.mockRestore()
        vi.useRealTimers()
      }
    })

    it('首个非空文本立即出现，结束后直接渲染全文', async () => {
      const view = render(<RenderMarkdown content="" isStreaming />)
      view.rerender(<RenderMarkdown content="第一段" isStreaming />)
      await waitFor(() => expect(view.container.textContent).toContain('第一段'))
      view.rerender(<RenderMarkdown content="第一段，第二段" isStreaming />)
      view.rerender(<RenderMarkdown content="第一段，第二段" />)
      await waitFor(() => expect(view.container.textContent).toContain('第一段，第二段'))
    })
  })
})
