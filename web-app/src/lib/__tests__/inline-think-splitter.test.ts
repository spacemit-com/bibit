import { describe, expect, it } from 'vitest'
import { InlineThinkSplitter, type ThinkPiece } from '@/lib/inline-think-splitter'

/** Feed deltas one by one and collect every piece, including the final flush. */
function run(deltas: string[]): ThinkPiece[] {
  const splitter = new InlineThinkSplitter()
  const pieces: ThinkPiece[] = []
  for (const delta of deltas) pieces.push(...splitter.push(delta))
  pieces.push(...splitter.flush())
  return pieces.filter((p) => p.delta !== '')
}

/** Concatenate one channel, mirroring how the UI accumulates a part. */
function channel(pieces: ThinkPiece[], name: ThinkPiece['channel']): string {
  return pieces
    .filter((p) => p.channel === name)
    .map((p) => p.delta)
    .join('')
}

describe('InlineThinkSplitter', () => {
  it('splits a complete think block from the answer', () => {
    const pieces = run(['<think>weighing options</think>Here is the answer.'])
    expect(channel(pieces, 'reasoning')).toBe('weighing options')
    expect(channel(pieces, 'text')).toBe('Here is the answer.')
  })

  it('splits when the tag is torn across deltas', () => {
    // The opener, body and closer each straddle a delta boundary.
    const pieces = run(['<th', 'ink>rea', 'soning', '</thi', 'nk>ans', 'wer'])
    expect(channel(pieces, 'reasoning')).toBe('reasoning')
    expect(channel(pieces, 'text')).toBe('answer')
  })

  it('splits when every character arrives separately', () => {
    const pieces = run([...'<think>abc</think>xyz'])
    expect(channel(pieces, 'reasoning')).toBe('abc')
    expect(channel(pieces, 'text')).toBe('xyz')
  })

  it('streams reasoning before the block closes', () => {
    const splitter = new InlineThinkSplitter()
    const first = splitter.push('<think>partial thought')
    // Reasoning must surface immediately, not buffer until </think> arrives.
    expect(first.filter((p) => p.delta)).toEqual([
      { channel: 'reasoning', delta: 'partial thought' },
    ])
  })

  it('treats an unclosed block as reasoning and flushes the tail', () => {
    const pieces = run(['<think>cut off mid-th', 'ought'])
    expect(channel(pieces, 'reasoning')).toBe('cut off mid-thought')
    expect(channel(pieces, 'text')).toBe('')
  })

  it('flushes a dangling partial tag rather than dropping it', () => {
    // Stream ends mid-tag: those characters are real output, not a control token.
    const pieces = run(['answer', '<thi'])
    expect(channel(pieces, 'text')).toBe('answer<thi')
  })

  it('keeps a literal think tag that follows answer text', () => {
    const pieces = run(['Use the <think> tag to mark reasoning.'])
    expect(channel(pieces, 'reasoning')).toBe('')
    expect(channel(pieces, 'text')).toBe('Use the <think> tag to mark reasoning.')
  })

  it('passes through text with no tags at all', () => {
    const pieces = run(['plain ', 'answer'])
    expect(channel(pieces, 'reasoning')).toBe('')
    expect(channel(pieces, 'text')).toBe('plain answer')
  })

  it('supports the thought tag spelling', () => {
    const pieces = run(['<thought>considering</thought>done'])
    expect(channel(pieces, 'reasoning')).toBe('considering')
    expect(channel(pieces, 'text')).toBe('done')
  })

  it('ignores whitespace between the block and the answer', () => {
    const pieces = run(['  <think>t</think>\n\nanswer'])
    expect(channel(pieces, 'reasoning')).toBe('t')
    expect(channel(pieces, 'text')).toBe('\n\nanswer')
  })

  it('emits reasoning before text so parts stay ordered', () => {
    const pieces = run(['<think>first</think>second'])
    expect(pieces.map((p) => p.channel)).toEqual(['reasoning', 'text'])
  })
})
