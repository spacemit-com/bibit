import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'

const parser = unified().use(remarkParse).use(remarkGfm)
const CODE_CANDIDATE = /`|~{3,}|(?:^|\n)(?: {4}|\t)/

/** Source offsets preserve delimiters, nesting and whitespace without serialization. */
export function markdownCodeRanges(content: string) {
  const ranges: { start: number; end: number }[] = []
  visit(parser.parse(content), ['code', 'inlineCode'], (node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end !== undefined) ranges.push({ start, end })
  })
  return ranges
}

export function transformOutsideCode(content: string, transform: (text: string) => string) {
  if (!CODE_CANDIDATE.test(content)) return transform(content)
  const ranges = markdownCodeRanges(content)
  if (!ranges.length) return transform(content)
  // Transform prose as one document so emphasis around inline code retains
  // its context. Select a collision-free prefix even for literal PUA input.
  let prefix = '\uE000C'
  while (content.includes(prefix)) prefix = `\uE000${prefix}`
  const parts: string[] = []
  let cursor = 0
  for (const [index, { start, end }] of ranges.entries()) {
    parts.push(content.slice(cursor, start), `${prefix}${index}\uE001`)
    cursor = end
  }
  parts.push(content.slice(cursor))
  return transform(parts.join('')).replace(new RegExp(`${prefix}(\\d+)\uE001`, 'g'), (_, index) => {
    const { start, end } = ranges[Number(index)]
    return content.slice(start, end)
  })
}
