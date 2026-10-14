import { describe, expect, it } from 'vitest'
import { segmentMarkdown } from '../streaming-markdown'

describe('streaming Markdown blocks', () => {
  it('reuses completed blocks while reparsing the trailing root nodes', () => {
    const first = segmentMarkdown('First **paragraph**.\n\nTail')
    const next = segmentMarkdown(`${first.source} grows`, first)
    expect(next.blocks[0]).toBe(first.blocks[0])
    expect(next.blocks[1].content).toBe('Tail grows')
    expect(next.tailStart).toBe(first.tailStart)
  })

  it.each([
    'Heading\n===\n\nText',
    '| a | b |\n|---|---|\n| 1 | 2 |\n\nEnd',
    '- first\n\n- second\n\nEnd',
    '1. first\n\n10. tenth\n\nEnd',
    '  - first\n\n  - second\n\nEnd',
    '  ```js\n  const x = 1\n  ```\n\nEnd',
    '> quote\n>\n> - nested\n\nEnd',
    'Text\n\n````js\n```\n\nconst x = 1\n````\n\nEnd',
    'Text\n\n~~~js\nconst x = 1\n~~~\n\nEnd',
    'Text\n\n$$\nx^2\n\n+ y^2\n$$\n\nEnd',
    'Text\n\n\\[\nx^2\n\n+ y^2\n\\]\n\nEnd',
    '[link][id]\n\n[id]: https://example.com\n\nEnd',
    'note[^1]\n\n[^1]: footnote\n\nEnd',
    'First\r\n\r\nSecond\r\n\r\nThird',
    'First\r\rSecond\r\rThird',
    '  ```js\r  const x = 1\r  ```\r\rEnd',
  ])('matches a fresh parse after every character: %s', source => {
    let snapshot = segmentMarkdown('')
    for (let end = 1; end <= source.length; end++) {
      const partial = source.slice(0, end)
      snapshot = segmentMarkdown(partial, snapshot)
      expect(snapshot.blocks).toEqual(segmentMarkdown(partial).blocks)
    }
  })

  it('preserves leading indentation in independently rendered blocks', () => {
    expect(segmentMarkdown('  - first\n\n  - second').blocks[0].content)
      .toBe('  - first\n\n  - second')
    expect(segmentMarkdown('  ```js\n  const x = 1\n  ```').blocks[0].content)
      .toBe('  ```js\n  const x = 1\n  ```')
  })

  it('keeps CR-separated blocks distinct without duplicating their content', () => {
    const snapshot = segmentMarkdown('One\r\rTwo\r\rThree')
    expect(snapshot.blocks.map(block => block.content)).toEqual(['One', 'Two', 'Three'])
    expect(snapshot.blocks.map(block => block.start)).toEqual([0, 5, 10])
    expect(segmentMarkdown('One\r\n').blocks[0].complete).toBe(false)
    expect(segmentMarkdown('One\r\n\r\n').blocks[0].complete).toBe(true)
  })

  it('marks a fence complete immediately when its real closing delimiter arrives', () => {
    const open = segmentMarkdown('```js\nconst x = 1\n')
    expect(open.blocks[0].complete).toBe(false)
    expect(segmentMarkdown(`${open.source}\`\`\``, open).blocks[0].complete).toBe(true)
    expect(segmentMarkdown('```js\nconst x = 1\n``').blocks[0].complete).toBe(false)
    expect(segmentMarkdown('```js\nconst x = 1\n    ```').blocks[0].complete).toBe(false)
  })

  it('resets on replacements, truncation and empty content', () => {
    const old = segmentMarkdown('Old.\n\nTail')
    for (const source of ['New.\n\nTail', 'Old.', '']) {
      expect(segmentMarkdown(source, old)).toEqual(segmentMarkdown(source))
    }
  })
})
