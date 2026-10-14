
import { Components, ExtraProps } from 'react-markdown'
import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import remend from '@janhq/remend'
import {
  cn,
  disableIndentedCodeBlockPlugin,
  splitHtmlArtifacts,
} from '@/lib/utils'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useThrottledValue } from '@/hooks/useThrottledValue'
import { markStreamCommit, noteThrottledEmit } from '@/lib/stream-timings'
import { segmentMarkdown, type MarkdownSnapshot } from '@/lib/streaming-markdown'
import { HtmlArtifact } from '@/components/HtmlArtifact'
// import 'katex/dist/katex.min.css'
import {
  defaultRehypePlugins,
  Streamdown,
  type MermaidErrorComponentProps,
  type StreamdownProps,
} from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'

import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { MermaidError } from '@/components/MermaidError'
import { CitationLink } from '@/components/CitationLink'
import { WebCitationChip } from '@/components/WebCitationChip'
import { MarkdownTable } from '@/components/MarkdownTable'
import { transformOutsideCode } from '@/lib/markdown-code'

const WEB_CITE_MARKER = /\[\[cite:\s*([^\]\s]+?)\s*\]\]/g

// Models sometimes drop the scheme (e.g. "example.com/x"); normalize to https.
function normalizeCiteUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

// Convert model-emitted [[cite:URL]] markers into anchors the Anchor override
// renders as circular favicon chips.
function linkifyWebCitations(text: string): string {
  if (!text.includes('[[cite:')) return text
  return text.replace(
    WEB_CITE_MARKER,
    (_m, url: string) =>
      `[cite](#webcite-${encodeURIComponent(normalizeCiteUrl(url))})`
  )
}

interface MarkdownProps {
  content: string
  className?: string
  components?: Components
  isUser?: boolean
  isStreaming?: boolean
  messageId?: string
  isAnimating?: boolean
  /** Treat single newlines as hard line breaks (used for reasoning text). */
  softBreaks?: boolean
}

// Hoisted so their identity is stable across renders — Streamdown is memoized
// with a shallow prop compare, and fresh literals here would defeat it, forcing
// a full re-parse + re-highlight on every streamed token.
const REMARK_PLUGINS = [remarkGfm, remarkMath, disableIndentedCodeBlockPlugin]
// softBreaks variant: reasoning text separates lines with a single \n, which
// CommonMark folds into a space. remark-breaks turns those into <br> so a
// thought keeps its line structure instead of collapsing into one block.
// Hoisted alongside REMARK_PLUGINS so Streamdown's shallow prop compare holds.
const REMARK_PLUGINS_SOFT_BREAKS = [...REMARK_PLUGINS, remarkBreaks]
const REHYPE_PLUGINS = [rehypeKatex, defaultRehypePlugins.harden]
const STREAMING_REHYPE_PLUGINS = [defaultRehypePlugins.harden]
// mermaid (~500 KB) is pulled in statically by @streamdown/mermaid. A static
// import here makes it a dependency of every route, so Rollup hoists it into
// the route chunk the first paint parses. It loads after mount instead.
// katex stays static: streamdown only builds its unified processor on mount,
// so a rehype plugin that arrives later never reaches the parser.
const STREAMDOWN_PLUGINS_BASE = { code, cjk }
type MermaidPlugin = typeof import('@streamdown/mermaid')['mermaid']
const STREAMDOWN_CONTROLS = { mermaid: { fullscreen: false } }
const LINK_SAFETY = { enabled: false }

// Bound active-block parsing and DOM updates; completed blocks keep their DOM.
// The first value renders immediately, and final content bypasses the throttle.
const STREAM_RENDER_INTERVAL_MS = 100
const EMPTY_MERMAID = {}
// static 模式直接解析 children，不使用内部分块。返回同一空数组也避免
// Streamdown 2.1 的分块同步 effect 每次更新后再触发一次解析。
const EMPTY_BLOCKS: string[] = []
const SKIP_INTERNAL_BLOCKS = () => EMPTY_BLOCKS
// 保守识别富内容；误命中的普通文本只会多一次空闲调度，不改变语义。
const RICH_CONTENT = /`{3,}|~{3,}|\$|\\[([]/
const MERMAID_FENCE = /(?:`{3,}|~{3,})[\t ]*mermaid\b/

// While streaming, the active (unclosed) code block would be re-highlighted by
// Shiki over its whole contents on every commit — O(n) per render, and the
// highlighted DOM is re-inserted wholesale (slow on webkitgtk). Render plain
// text instead; closed blocks are refined after the body has committed.
type CodeProps = React.HTMLAttributes<HTMLElement> & ExtraProps
function StreamingCode({ node, className, children, ...props }: CodeProps) {
  const pos = node?.position
  const isInline = !pos || pos.start.line === pos.end.line
  if (isInline) {
    return (
      <code
        className={cn(
          'rounded bg-muted px-1.5 py-0.5 font-mono text-sm',
          className
        )}
        {...props}
      >
        {children}
      </code>
    )
  }
  return <PlainCodeBlock className={className}>{children}</PlainCodeBlock>
}

function PlainCodeBlock({ children, className }: React.HTMLAttributes<HTMLElement>) {
  return (
    <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-secondary p-4">
      <code className={cn('font-mono text-sm', className)}>{children}</code>
    </pre>
  )
}
const STREAMING_COMPONENTS: Components = { code: StreamingCode }

const ZWSP = '​'

// "word**,**" is neither left- nor right-flanking per CommonMark, so the markers
// render literally; a ZWSP just inside restores flanking (U+200B is treated as
// non-punctuation). Runs after math/code are masked, so '_'/'*' subscripts never
// get a ZWSP — that made KaTeX warn "Unrecognized Unicode character 8203".
const fixEmphasisFlanking = (s: string): string =>
  s.includes('*') || s.includes('_')
    ? s
        .replace(/(?<=[\p{L}\p{N}])(\*\*?|__?)(?=[^\s\p{L}\p{N}*_])/gu, `$1${ZWSP}`)
        .replace(/(?<=[^\s\p{L}\p{N}*_])(\*\*?|__?)(?=[\p{L}\p{N}])/gu, `${ZWSP}$1`)
    : s

// Placeholder-protection pipeline (adapted from llama.cpp's webui / LibreChat):
// remark-math only parses $…$/$$…$$, so brackets need converting — but converting,
// escaping currency, and fixing emphasis would corrupt each other unless code and
// math are protected first. Code is excluded using Markdown source ranges;
// math uses a prefix verified to be absent from this input.
const BRACKET_MATH =
  /(\$\$[\s\S]*?\$\$|(?<!\\)\\\[[\s\S]*?\\\]|(?<!\\)\\\(.*?\\\))/g

// Mask genuine inline $…$ math; leave currency/identifiers ($5, a$b) in place.
// Per-line so a stray $ can't swallow the rest.
const maskInlineMath = (content: string, store: string[], token: (n: number) => string): string => {
  if (!content.includes('$')) return content
  return content
    .split('\n')
    .map((line) => {
      if (!line.includes('$')) return line
      let out = ''
      let pos = 0
      while (pos < line.length) {
        const open = line.indexOf('$', pos)
        if (open === -1) {
          out += line.slice(pos)
          break
        }
        const close = line.indexOf('$', open + 1)
        if (close === -1) {
          out += line.slice(pos)
          break
        }

        const before = open > 0 ? line[open - 1] : ''
        const afterOpen = line[open + 1]
        const beforeClose = open + 1 < close ? line[close - 1] : ''
        const afterClose = close + 1 < line.length ? line[close + 1] : ''

        const empty = close === open + 1
        const gluedLeft = /[A-Za-z0-9_$-]/.test(before)
        const looksMoney =
          /[0-9]/.test(afterOpen) &&
          (/[A-Za-z0-9_$-]/.test(afterClose) || beforeClose === ' ')

        if (empty || gluedLeft || looksMoney) {
          out += line.slice(pos, open + 1)
          pos = open + 1
          continue
        }

        out += line.slice(pos, open)
        store.push(line.slice(open, close + 1))
        out += token(store.length - 1)
        pos = close + 1
      }
      return out
    })
    .join('\n')
}

// Cache for normalized LaTeX content
const latexCache = new Map<string, string>()

const normalizeLatex = (input: string): string => {
  if (latexCache.has(input)) return latexCache.get(input)!

  const math: string[] = []
  let prefix = '\uE000L'
  while (input.includes(prefix)) prefix = `\uE000${prefix}`
  const token = (n: number) => `${prefix}${n}\uE001`

  let s = input
    .replace(BRACKET_MATH, (m) => token(math.push(m) - 1))

  s = maskInlineMath(s, math, token)
  s = s.replace(/\$(?=\d)/g, '\\$') // leftover currency renders literally
  s = fixEmphasisFlanking(s)

  // Restore math, converting bracket delimiters to $… / $$… for remark-math.
  s = s.replace(new RegExp(`${prefix}(\\d+)\uE001`, 'g'), (_, n) => {
    const expr = math[Number(n)]
    if (expr.startsWith('\\[')) return `$$\n${expr.slice(2, -2).trim()}\n$$`
    if (expr.startsWith('\\(')) return `$${expr.slice(2, -2).trim()}$`
    return expr
  })

  if (latexCache.size > 100) {
    const firstKey = latexCache.keys().next().value || ''
    latexCache.delete(firstKey)
  }
  latexCache.set(input, s)
  return s
}

function RenderMarkdownComponent({
  content,
  className,
  isUser,
  components,
  messageId,
  isAnimating,
  isStreaming,
  softBreaks,
}: MarkdownProps) {
  const renderHtmlArtifacts = useInterfaceSettings(
    (s) => s.renderHtmlArtifacts
  )

  // Coalesce rapid streamed updates and bound active-block parsing. This does not feed a
  // `useDeferredValue`: on SpacemiT K3 that second layer starved under a continuous
  // delta stream and let a whole answer land in only two or three commits, which
  // is exactly the "chunky" streaming this file is trying to avoid. The throttle
  // always converges (trailing edge), and the non-streaming path uses content
  // as-is.
  const throttledContent = useThrottledValue(
    content,
    STREAM_RENDER_INTERVAL_MS,
    isStreaming ?? false
  )
  const effectiveContent = isStreaming ? throttledContent : content

  // 采样：节流真的发出了几帧（默认关闭时不打印）。
  useEffect(() => {
    if (isStreaming) noteThrottledEmit(effectiveContent.length)
  }, [effectiveContent, isStreaming])

  // 采样用：提交与该正文快照对应的事件配对，不消费尚未显示的后到事件。
  // 计时有专门的开关（见 stream-timings），默认不采样。
  useLayoutEffect(() => {
    if (!softBreaks) markStreamCommit(messageId, effectiveContent)
  }, [effectiveContent, messageId, softBreaks])

  const mergedComponents = useMemo<Components>(() => {
    const Anchor = (
      props: React.AnchorHTMLAttributes<HTMLAnchorElement>
    ) => {
      const { href, children, className: aClass } = props
      if (typeof href === 'string' && href.startsWith('#cite-')) {
        return (
          <CitationLink href={href} className={aClass}>
            {children}
          </CitationLink>
        )
      }
      if (typeof href === 'string' && href.startsWith('#webcite-')) {
        const url = decodeURIComponent(href.slice('#webcite-'.length))
        return <WebCitationChip messageId={messageId} url={url} />
      }
      return <a {...props}>{children}</a>
    }
    return { a: Anchor, table: MarkdownTable, ...(components ?? {}) } as Components
  }, [components, messageId])

  // Interactive HTML artifacts: only when the user opted in and the stream is
  // complete (an incomplete fence must not be torn out mid-token). Splitting the
  // string keeps Streamdown's code/mermaid/inline handling intact for everything
  // else — overriding its `code` component would replace all of it.
  const segments = useMemo(() => {
    if (isStreaming || !renderHtmlArtifacts) return null
    const segs = splitHtmlArtifacts(effectiveContent)
    return segs.some((s) => s.type === 'html' || s.type === 'svg')
      ? segs
      : null
  }, [effectiveContent, isStreaming, renderHtmlArtifacts])

  return (
    <div
      dir="auto"
      className={cn(
        'markdown wrap-break-word select-text',
        isUser && 'is-user',
        className
      )}
    >
      {segments
        ? segments.map((seg, i) =>
            seg.type === 'html' ? (
              <HtmlArtifact key={i} code={seg.content} />
            ) : seg.type === 'svg' ? (
              <HtmlArtifact
                key={i}
                code={seg.content}
                allowScripts={false}
                language="xml"
              />
            ) : (
              <StreamdownView
                key={i}
                content={seg.content}
                isStreaming={isStreaming}
                isAnimating={isAnimating}
                messageId={messageId}
                className={className}
                components={mergedComponents}
                softBreaks={softBreaks}
              />
            )
          )
        : (
          <StreamdownView
            content={effectiveContent}
            isStreaming={isStreaming}
            isAnimating={isAnimating}
            messageId={messageId}
            className={className}
            softBreaks={softBreaks}
            components={mergedComponents}
          />
        )}
    </div>
  )
}

interface StreamdownViewProps {
  content: string
  components: Components
  className?: string
  isStreaming?: boolean
  isAnimating?: boolean
  messageId?: string
  softBreaks?: boolean
}

function StreamdownViewComponent({
  content,
  components,
  className,
  isStreaming,
  isAnimating,
  messageId,
  softBreaks,
}: StreamdownViewProps) {
  const previous = useRef<MarkdownSnapshot | undefined>(undefined)
  const hasStreamed = useRef(false)
  const useBlocks = Boolean(isStreaming) || hasStreamed.current
  const snapshot = useMemo(
    () => useBlocks ? segmentMarkdown(content, previous.current) : undefined,
    [content, useBlocks]
  )
  useLayoutEffect(() => {
    previous.current = snapshot
    if (isStreaming) hasStreamed.current = true
  }, [snapshot, isStreaming])

  const mermaidOptions = useMemo(
    () =>
      messageId
        ? {
            errorComponent: (props: MermaidErrorComponentProps) => (
              <MermaidError messageId={messageId} {...props} />
            ),
          }
        : EMPTY_MERMAID,
    [messageId]
  )

  const mergedClassName = useMemo(
    () =>
      cn('w-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className),
    [className]
  )

  // 已完成的块保留组件与 DOM；流结束时也不切换回整篇渲染，以免全部重挂载。
  const blocks = snapshot?.blocks ?? [{ start: 0, content, complete: true }]
  return (
    <div className="space-y-4">
      {blocks.map(block => (
        <MarkdownBlockView
          key={block.start}
          content={block.content}
          plainCode={block.plainCode}
          active={Boolean(isStreaming) && !block.complete}
          deferEnhancement={useBlocks}
          documentScope={snapshot?.documentScope ?? true}
          className={mergedClassName}
          components={components}
          softBreaks={softBreaks}
          mermaid={mermaidOptions}
          animate={!useBlocks && (isAnimating ?? true)}
        />
      ))}
    </div>
  )
}

const MarkdownBlockView = memo(function MarkdownBlockView({
  content, plainCode, active, deferEnhancement, documentScope, className, components, softBreaks, mermaid, animate,
}: {
  content: string
  plainCode?: string
  active: boolean
  deferEnhancement: boolean
  documentScope: boolean
  className: string
  components: Components
  softBreaks?: boolean
  mermaid: StreamdownProps['mermaid']
  animate: boolean
}) {
  const rich = RICH_CONTENT.test(content)
  const hasMermaid = MERMAID_FENCE.test(content)
  const [refinedContent, setRefinedContent] = useState<string | null>(null)
  const ready = !active && (!deferEnhancement || refinedContent === content)
  useEffect(() => {
    if (!rich || active || !deferEnhancement || refinedContent === content) return
    // 正文先提交；精排让出当前任务，并允许 React 优先处理后续正文。
    // ponytail: 单个富块解析仍同步；只有实测超大块阻塞时才拆分解析器。
    const refine = () => startTransition(() => setRefinedContent(content))
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(refine, { timeout: 500 })
      return () => window.cancelIdleCallback(id)
    }
    const id = window.setTimeout(refine, 32)
    return () => window.clearTimeout(id)
  }, [rich, active, deferEnhancement, content, refinedContent])

  // 只给已闭合的图表加载插件，普通消息不再为 Mermaid 额外渲染一遍。
  const [mermaidPlugin, setMermaidPlugin] = useState<MermaidPlugin | null>()
  useEffect(() => {
    if (!hasMermaid || !ready || mermaidPlugin !== undefined) return
    let alive = true
    void import('@streamdown/mermaid')
      .then(module => {
        if (alive) startTransition(() => setMermaidPlugin(module.mermaid))
      })
      .catch(() => {
        if (alive) setMermaidPlugin(null)
      })
    return () => { alive = false }
  }, [hasMermaid, ready, mermaidPlugin])
  const plugins = useMemo(
    () => mermaidPlugin
      ? { ...STREAMDOWN_PLUGINS_BASE, mermaid: mermaidPlugin }
      : STREAMDOWN_PLUGINS_BASE,
    [mermaidPlugin]
  )
  const lightweight = rich && (!ready || (hasMermaid && mermaidPlugin === undefined))
  const normalizedContent = useMemo(() => {
    if (lightweight && plainCode !== undefined) return content
    // A closed block without syntax that needs repair or conversion renders as-is.
    if (!active && !/[$\\*_]|\[\[cite:/.test(content)) return content
    // remend and normalizeLatex must not touch code: remend's strikethrough
    // completion otherwise appends ~~ inside tilde fences.
    return transformOutsideCode(content, (text) =>
      linkifyWebCitations(active ? remend(text) : normalizeLatex(text))
    )
  }, [content, active, lightweight, plainCode])
  // Streamdown 2.1 的节点 memo 只比较位置，组件 memo 还忽略插件选项。
  // 追加时保持 DOM；语义修订、文档引用变化或渲染模式切换时重置该块。
  const previous = useRef({ normalizedContent, lightweight, components, softBreaks, mermaid, revision: 0 })
  const before = previous.current
  const reset = before.lightweight !== lightweight || before.components !== components ||
    before.softBreaks !== softBreaks || before.mermaid !== mermaid ||
    (normalizedContent !== before.normalizedContent &&
      (documentScope || !normalizedContent.startsWith(before.normalizedContent)))
  const revision = before.revision + Number(reset)
  useLayoutEffect(() => {
    previous.current = { normalizedContent, lightweight, components, softBreaks, mermaid, revision }
  }, [normalizedContent, lightweight, components, softBreaks, mermaid, revision])
  const effectiveComponents = useMemo(
    () => lightweight ? { ...components, ...STREAMING_COMPONENTS } : components,
    [components, lightweight]
  )
  if (lightweight && plainCode !== undefined) {
    return <PlainCodeBlock>{plainCode + '\n'}</PlainCodeBlock>
  }
  return (
    <Streamdown
      key={revision}
      mode="static"
      parseMarkdownIntoBlocksFn={SKIP_INTERNAL_BLOCKS}
      parseIncompleteMarkdown={false}
      animate={animate}
      animationDuration={500}
      linkSafety={LINK_SAFETY}
      className={className}
      remarkPlugins={
        softBreaks ? REMARK_PLUGINS_SOFT_BREAKS : REMARK_PLUGINS
      }
      rehypePlugins={lightweight ? STREAMING_REHYPE_PLUGINS : REHYPE_PLUGINS}
      components={effectiveComponents}
      plugins={plugins}
      controls={STREAMDOWN_CONTROLS}
      mermaid={mermaid}
    >
      {normalizedContent}
    </Streamdown>
  )
})

const StreamdownView = memo(StreamdownViewComponent)
export const RenderMarkdown = memo(RenderMarkdownComponent)
