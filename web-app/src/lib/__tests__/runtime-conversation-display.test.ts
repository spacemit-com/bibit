import { describe, expect, it } from 'vitest'
import { projectSessionEvents, sessionMessageToUIMessage, normalizeRuntimeUsage, aggregateSessionUsage, aggregateSessionEventUsage, type SessionEvent } from '../runtime-session-projection'
const event = (seq: number, type: string, data: Record<string, unknown> = {}, run_id: string | null = 'r1'): SessionEvent => ({ seq, type, data, run_id, time: seq })

describe('Runtime accounting history', () => {
  it('retains full compression and usage data across replay', () => {
    const compression = { compressed: true, before_tokens: 10000, after_tokens: 2000, retained_messages: 8, compression_count: 2, used_fallback: true }
    const events = [event(1, 'user/message', { message_id: 'round', content: 'Prompt' }),
      event(2, 'context/compressed', compression), event(3, 'assistant/text.delta', { text: 'working' }),
      event(4, 'run/completed', { content: 'Done', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })]
    const full = projectSessionEvents(events)
    for (let end = 1; end <= events.length; end++) {
      expect(projectSessionEvents([...events.slice(0, end), ...events]).messages).toEqual(full.messages)
    }
    const ui = full.messages.map(message => sessionMessageToUIMessage(message))
    expect(ui[1].metadata).toMatchObject({ compression })
    expect(ui[1].parts).toEqual([{ type: 'text', text: '' }])
    expect(ui[2].metadata).toMatchObject({ usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } })
    expect(full.messages[2].content).toBe('Done')
  })
})

it('normalizes measured counters without fabricating missing values', () => {
  expect(normalizeRuntimeUsage({ input_tokens: 0, output_tokens: 20 })).toEqual({ inputTokens: 0, outputTokens: 20, totalTokens: 20 })
  expect(normalizeRuntimeUsage({ total_tokens: 42 })).toEqual({ totalTokens: 42 })
  expect(normalizeRuntimeUsage({ input_tokens: null, output_tokens: -1 })).toBeUndefined()
  expect(normalizeRuntimeUsage({ input_tokens: 1.5 })).toBeUndefined()
  const messages = projectSessionEvents([
    event(1, 'run/completed', { usage: { input_tokens: 10, output_tokens: 2 } }, 'r1'),
    event(2, 'run/completed', { usage: { input_tokens: 20, output_tokens: 4 } }, 'r2'),
  ]).messages
  expect(aggregateSessionUsage([...messages, messages[0]])).toEqual({ inputTokens: 30, outputTokens: 6, totalTokens: 36 })
  expect(aggregateSessionUsage([])).toBeUndefined()
  messages[1].usage = { total_tokens: 24 }
  expect(aggregateSessionUsage(messages)).toEqual({ totalTokens: 36 })
})

it('keeps compression between assistant segments and terminal text does not duplicate the prefix', () => {
  const events = [event(1, 'user/message', { message_id: 'u', content: 'Run' }),
    event(2, 'assistant/text.delta', { text: 'Before' }),
    event(3, 'context/compressed', { compressed: true, before_tokens: 1000, after_tokens: 200 }),
    event(4, 'assistant/text.delta', { text: 'After' }),
    event(5, 'run/completed', { content: 'BeforeAfter', usage: { input_tokens: 10, output_tokens: 2 } })]
  const projected = projectSessionEvents(events)
  expect(projected.messages.map(message => [message.id, message.role, message.content])).toEqual([
    ['u', 'user', 'Run'], ['r1:2', 'assistant', 'Before'], ['r1:context:3', 'system', ''], ['r1:4', 'assistant', 'After'],
  ])
  expect(projected.messages[1].status).toBe('completed')
  expect(projected.messages[3].usage).toEqual({ input_tokens: 10, output_tokens: 2 })
  expect(projectSessionEvents([...events.slice(0, 3), ...events]).messages).toEqual(projected.messages)
  const revised = projectSessionEvents([...events.slice(0, -1), event(5, 'run/completed', { content: 'Revised answer' })])
  expect(revised.messages.filter(message => message.role === 'assistant').map(message => message.content).join('')).toBe('Revised answer')
})

it('counts terminal run usage across continuation and replay independently of rewritten messages', () => {
  const events = [event(1, 'run/cancelled', { content: 'First', usage: { input_tokens: 10, output_tokens: 2 } }, 'first'),
    event(2, 'run/completed', { content: 'Second', usage: { input_tokens: 20, output_tokens: 4 } }, 'second')]
  expect(aggregateSessionEventUsage([...events, ...events])).toEqual({ inputTokens: 30, outputTokens: 6, totalTokens: 36 })
  expect(aggregateSessionEventUsage([...events, event(3, 'run/completed', { usage: { input_tokens: 21, output_tokens: 5 } }, 'second')])).toEqual({ inputTokens: 31, outputTokens: 7, totalTokens: 38 })
  expect(aggregateSessionEventUsage([event(1, 'run/completed', {}, 'unknown')])).toBeUndefined()
})

it('retains both cancelled and continued run accounting when history replaces the first answer', () => {
  const events = [event(1, 'user/message', { message_id: 'u', content: 'Question' }),
    event(2, 'assistant/text.delta', { text: 'First' }),
    event(3, 'run/cancelled', { content: 'First', usage: { input_tokens: 10, output_tokens: 2 } }),
    event(4, 'conversation/changed', { action: 'continue', operation_id: 'c', message_id: 'r1:2' }, null),
    event(5, 'user/message', { message_id: 'u', content: 'Question', request: { metadata: { history_operation_id: 'c' } } }, 'r2'),
    event(6, 'run/completed', { content: 'Second', usage: { input_tokens: 20, output_tokens: 4 } }, 'r2')]
  const state = projectSessionEvents(events)
  expect(state.messages.map(message => message.content)).toEqual(['Question', 'FirstSecond'])
  expect(aggregateSessionEventUsage(state.trajectory)).toEqual({ inputTokens: 30, outputTokens: 6, totalTokens: 36 })
})

it('replays recovery as a system notice between preserved assistant segments', () => {
  const progress = { phase: 'recovering', attempt: 1, message: '保留已有进度，正在分步继续。' }
  const events = [event(1, 'user/message', { content: 'create app' }),
    event(2, 'assistant/text.delta', { text: 'before' }), event(3, 'run/progress', progress),
    event(4, 'assistant/text.delta', { text: 'after' }), event(5, 'run/completed', { content: 'beforeafter' })]
  const projection = projectSessionEvents(events)
  expect(projection.messages.map(message => message.role)).toEqual(['user', 'assistant', 'system', 'assistant'])
  const ui = projection.messages.map(message => sessionMessageToUIMessage(message))
  expect(ui[2].metadata).toMatchObject({ progress })
  expect(projection.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['before', 'after'])
  expect(projectSessionEvents([...events, ...events]).messages).toEqual(projection.messages)
})

it('shows the recoverable Runtime error with preserved partial output', () => {
  const error = { code: 'model_recovery_exhausted', message: '自动恢复未能完成当前任务。可以在当前会话继续。', details: { resumable: true } }
  const projection = projectSessionEvents([
    event(1, 'assistant/text.delta', { text: '已完成骨架' }),
    event(2, 'run/failed', { content: '已完成骨架', error }),
  ])
  const ui = sessionMessageToUIMessage(projection.messages[0])
  expect(ui.parts).toContainEqual({ type: 'text', text: '已完成骨架' })
  // details 必须一路带到界面层：用户需要看到「可继续」的依据，而不是只有一句话。
  expect(ui.parts).toContainEqual({ type: 'data-runtime-diagnostic', data: {
    level: 'warning', message: error.message, code: error.code,
    details: error.details,
  } })
})


it('retracts only the timed out attempt when replaying recovery', () => {
  const events = [event(1, 'assistant/text.delta', {text: 'Saved. '}),
    event(2, 'tool/call.completed', {call_id: 'saved', name: 'save', result: 'saved'}),
    event(3, 'assistant/text.delta', {text: 'Hello 🌏'}),
    event(4, 'run/progress', {phase: 'recovering', discarded_text: 'Hello 🌏'}),
    event(5, 'assistant/text.delta', {text: 'Hello 🌏 world'}),
    event(6, 'run/completed', {content: 'Saved. Hello 🌏 world'})]
  const pending = projectSessionEvents(events.slice(0, -1))
  expect(pending.messages.filter(m => m.role === 'assistant').map(m => m.content).join('')).toBe('Saved. Hello 🌏 world')
  const state = projectSessionEvents(events)
  expect(state.messages.filter(m => m.role === 'assistant').map(m => m.content).join('')).toBe('Saved. Hello 🌏 world')
  const ui = state.messages.map(m => sessionMessageToUIMessage(m))
  expect(ui.flatMap(m => m.parts).filter(p => p.type === 'text').map(p => p.text).join('')).toBe('Saved. Hello 🌏 world')
  expect(ui.flatMap(m => m.parts).filter(p => p.type === 'data-runtime-tool')).toHaveLength(1)
  expect(projectSessionEvents([...events, ...events]).messages).toEqual(state.messages)
})
