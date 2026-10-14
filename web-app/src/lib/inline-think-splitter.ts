/**
 * Split `<think>…</think>` out of a streamed text channel.
 *
 * ACP already separates thinking from the answer: `agent_thought_chunk` maps to
 * `reasoning_delta`, `agent_message_chunk` to `text_delta`. But some agent /
 * model combinations (Hermes + MiniMax today) only put a decorative status line
 * in the thought channel and leave the real reasoning inline in the message
 * channel, wrapped in literal `<think>` tags. Without this splitter those tags
 * reach the renderer verbatim and only turn into a reasoning card once the
 * message is persisted and read back through `parseReasoning`.
 *
 * Feed every text delta through `push()` and emit the returned pieces in order.
 * Call `flush()` when the stream ends so a partially-buffered tag is not lost.
 */

const OPEN_TAGS = ['<think>', '<thought>'] as const
const CLOSE_TAGS = ['</think>', '</thought>'] as const

export type ThinkPiece =
  | { channel: 'text'; delta: string }
  | { channel: 'reasoning'; delta: string }

/**
 * True when `text` ends with a strict prefix of `tag` — i.e. the tag may still
 * be completed by the next delta. `<th` is a prefix of `<think>`; a full
 * `<think>` is not (it is a match, not a pending prefix).
 */
function endsWithPartialTag(text: string, tags: readonly string[]): boolean {
  for (const tag of tags) {
    const max = Math.min(text.length, tag.length - 1)
    for (let len = max; len > 0; len--) {
      if (text.endsWith(tag.slice(0, len))) return true
    }
  }
  return false
}

function firstIndexOfAny(
  text: string,
  tags: readonly string[]
): { index: number; tag: string } | null {
  let best: { index: number; tag: string } | null = null
  for (const tag of tags) {
    const index = text.indexOf(tag)
    if (index < 0) continue
    if (!best || index < best.index) best = { index, tag }
  }
  return best
}

export class InlineThinkSplitter {
  /** Bytes held back because they may be the start of a tag split across deltas. */
  private pending = ''
  /** Inside a `<think>` block — subsequent text routes to the reasoning channel. */
  private inThink = false
  /**
   * Whether any answer text has been emitted for this message yet. A `<think>`
   * opener is only honoured before the answer starts; afterwards the model is
   * quoting the tag rather than opening a block (e.g. explaining the syntax).
   * Mirrors `parseReasoning`, which also only matches the first occurrence.
   */
  private sawText = false

  push(delta: string): ThinkPiece[] {
    const pieces: ThinkPiece[] = []
    let buffer = this.pending + delta
    this.pending = ''

    while (buffer.length > 0) {
      if (this.inThink) {
        const close = firstIndexOfAny(buffer, CLOSE_TAGS)
        if (close) {
          const body = buffer.slice(0, close.index)
          if (body) pieces.push({ channel: 'reasoning', delta: body })
          buffer = buffer.slice(close.index + close.tag.length)
          this.inThink = false
          continue
        }
        // No close tag yet. Hold back only a possible partial tag; emit the rest
        // so reasoning streams live instead of buffering to the end of the block.
        if (endsWithPartialTag(buffer, CLOSE_TAGS)) {
          const keep = this.partialTagLength(buffer, CLOSE_TAGS)
          const body = buffer.slice(0, buffer.length - keep)
          if (body) pieces.push({ channel: 'reasoning', delta: body })
          this.pending = buffer.slice(buffer.length - keep)
          return pieces
        }
        pieces.push({ channel: 'reasoning', delta: buffer })
        return pieces
      }

      // Outside a think block. Once the answer has started, tags are literal.
      if (this.sawText) {
        pieces.push({ channel: 'text', delta: buffer })
        return pieces
      }

      const open = firstIndexOfAny(buffer, OPEN_TAGS)
      if (open) {
        const head = buffer.slice(0, open.index)
        if (head.trim()) {
          // Real answer text preceded the tag, so this is not a leading think
          // block — treat the whole buffer as literal from here on.
          this.sawText = true
          pieces.push({ channel: 'text', delta: buffer })
          return pieces
        }
        // Drop insignificant whitespace before the opener.
        buffer = buffer.slice(open.index + open.tag.length)
        this.inThink = true
        continue
      }

      if (endsWithPartialTag(buffer, OPEN_TAGS)) {
        const keep = this.partialTagLength(buffer, OPEN_TAGS)
        const head = buffer.slice(0, buffer.length - keep)
        if (head) {
          if (head.trim()) this.sawText = true
          pieces.push({ channel: 'text', delta: head })
        }
        this.pending = buffer.slice(buffer.length - keep)
        return pieces
      }

      if (buffer.trim()) this.sawText = true
      pieces.push({ channel: 'text', delta: buffer })
      return pieces
    }

    return pieces
  }

  /**
   * Emit anything still buffered. Called when the run ends: a truncated or
   * cancelled turn can leave a dangling `<think>` or a partial tag, and those
   * characters must not be silently dropped.
   */
  flush(): ThinkPiece[] {
    if (!this.pending) return []
    const rest = this.pending
    this.pending = ''
    return [{ channel: this.inThink ? 'reasoning' : 'text', delta: rest }]
  }

  /** Length of the trailing run of characters that may still become a tag. */
  private partialTagLength(text: string, tags: readonly string[]): number {
    let longest = 0
    for (const tag of tags) {
      const max = Math.min(text.length, tag.length - 1)
      for (let len = max; len > 0; len--) {
        if (text.endsWith(tag.slice(0, len))) {
          if (len > longest) longest = len
          break
        }
      }
    }
    return longest
  }
}
