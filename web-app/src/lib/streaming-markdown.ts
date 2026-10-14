import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { visit } from 'unist-util-visit'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

export type MarkdownBlock = {
  start: number
  content: string
  complete: boolean
  plainCode?: string
}

export type MarkdownSnapshot = {
  source: string
  blocks: MarkdownBlock[]
  tailStart: number
  documentScope: boolean
}

function closedFence(content: string, type: string): boolean {
  const lines = content.trimEnd().split(/\r\n|\r|\n/)
  if (lines.length < 2) return false
  const opening = lines[0].match(type === 'math' ? /^ {0,3}(\${2,})/ : /^ {0,3}(`{3,}|~{3,})/)
  if (!opening) return false
  const marker = opening[1]
  const closing = lines.at(-1)!.replace(/^ {0,3}/, '').replace(/[\t ]+$/, '')
  return closing.length >= marker.length && [...closing].every(char => char === marker[0])
}

/** Keep two trailing nodes reparsable: an unfinished list marker can join them. */
export function segmentMarkdown(source: string, previous?: MarkdownSnapshot): MarkdownSnapshot {
  if (previous?.source === source) return previous
  const append = previous && source.startsWith(previous.source)
  const tailStart = append ? previous.tailStart : 0
  const documentScope = append && previous.documentScope
  if (documentScope) {
    // ponytail: references/footnotes need document scope; keep their full parse.
    return { source, blocks: [{ start: 0, content: source, complete: false }], tailStart: 0, documentScope: true }
  }

  const tail = source.slice(tailStart)
  // Same-width aliases let the existing math parser find bracket-math blocks
  // without changing source offsets or code-fence contents passed to rendering.
  const parseSource = tail.replace(/(?<!\\)\\[[\]]/g, '$$$$')
  const tree = parser.parse(parseSource)
  let needsDocument = false
  visit(tree, node => {
    if (node.type === 'definition' || node.type === 'footnoteDefinition' || node.type === 'footnoteReference') {
      needsDocument = true
    }
    // CommonMark can interpret a numbered line after indented code as a paragraph.
    // Parsing that paragraph alone would turn it into a list.
    if (node.type === 'paragraph' && /^ {0,3}\d+[.)][\t ]/.test(
      tail.slice(node.position!.start.offset!, node.position!.end.offset!)
    )) needsDocument = true
  })
  if (needsDocument) {
    return { source, blocks: [{ start: 0, content: source, complete: false }], tailStart: 0, documentScope: true }
  }

  const blocks = append ? previous.blocks.slice(0, -2) : []
  tree.children.forEach((node, index) => {
    const offset = node.position!.start.offset!
    // Preserve indentation: parsing a node from its marker changes list/code semantics.
    const lineStart = Math.max(
      parseSource.lastIndexOf('\n', offset - 1),
      parseSource.lastIndexOf('\r', offset - 1)
    ) + 1
    const start = tailStart + lineStart
    const end = tailStart + node.position!.end.offset!
    const content = source.slice(start, end)
    const complete = index < tree.children.length - 1 ||
      /\n[\t ]*\n/.test(source.slice(end).replace(/\r\n|\r/g, '\n')) ||
      closedFence(parseSource.slice(lineStart, node.position!.end.offset!), node.type)
    const prior = previous?.blocks[blocks.length]
    // 直接复用首次解析得到的代码正文；括号别名会改写代码内的原文，保守回退。
    const plainCode = node.type === 'code' && /^ {0,3}(`{3,}|~{3,})/.test(content) &&
      !/\\[[\]]/.test(content) ? node.value : undefined
    blocks.push(prior?.start === start && prior.content === content && prior.complete === complete
      ? prior : { start, content, complete, plainCode })
  })
  return { source, blocks, tailStart: blocks.at(-2)?.start ?? blocks[0]?.start ?? 0, documentScope: false }
}
