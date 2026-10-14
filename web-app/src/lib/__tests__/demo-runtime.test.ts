import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  extractLatestUserMessage,
  extractLatestUserPrompt,
  isDemoRuntimeEvent,
  isTerminalDemoRuntimeEvent,
} from '@/lib/demo-runtime'

describe('demo runtime protocol', () => {
  it('extracts the latest user text and trims it', () => {
    const messages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '第一条' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: '回复' }] },
      {
        id: 'user-2',
        role: 'user',
        parts: [
          { type: 'text', text: ' 你好 ' },
          { type: 'text', text: ' BiBit ' },
        ],
      },
    ] as UIMessage[]

    expect(extractLatestUserPrompt(messages)).toBe('你好  BiBit')
    expect(extractLatestUserMessage(messages)).toEqual({
      id: messages[2].id,
      prompt: '你好  BiBit',
    })
  })

  it('rejects messages without non-blank user text', () => {
    const messages = [
      { role: 'assistant', parts: [{ type: 'text', text: '回复' }] },
      { role: 'user', parts: [{ type: 'text', text: '   ' }] },
    ] as UIMessage[]

    expect(() => extractLatestUserPrompt(messages)).toThrow('消息不能为空')
  })

  it('validates event shape and terminal states', () => {
    const completed = {
      type: 'message_completed',
      runId: 'run-1',
      sessionId: 'session-1',
      sequence: 2,
      content: '完成',
    }

    expect(isDemoRuntimeEvent(completed)).toBe(true)
    expect(isTerminalDemoRuntimeEvent(completed)).toBe(true)
    expect(isDemoRuntimeEvent({ ...completed, sequence: '2' })).toBe(false)
    expect(isDemoRuntimeEvent({ type: 'unknown' })).toBe(false)
  })
})
