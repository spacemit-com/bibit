import { describe, expect, it } from 'vitest'
import { foldSessionEvents } from '@/lib/runtime-session-fold'
import { projectSessionEvents, type SessionEvent, type SessionMessage } from '@/lib/runtime-session-projection'

const event = (seq: number, type: string, data: Record<string, unknown> = {}, runId = 'run-1'): SessionEvent =>
  ({ seq, type, time: seq, run_id: runId, data })

// 覆盖：相邻折叠、被 message.end 打断、跨 run、混入工具调用与审批。
const raw: SessionEvent[] = [
  event(1, 'user/message', { message_id: 'm1', content: '跑一下' }, undefined as unknown as string),
  event(2, 'agent/inbox/claimed', { message_ids: ['m1'] }),
  event(3, 'assistant/reasoning.delta', { text: '想' }),
  event(4, 'assistant/reasoning.delta', { text: '一下' }),
  event(5, 'assistant/message.end', {}),
  event(6, 'assistant/reasoning.delta', { text: '再想' }),
  event(7, 'tool/call.started', { call_id: 'c1', name: '读文件' }),
  event(8, 'tool/call.completed', { call_id: 'c1', result: 'ok' }),
  event(9, 'assistant/reasoning.delta', { text: '接着想' }),
  event(10, 'assistant/text.delta', { text: '答' }),
  event(11, 'assistant/text.delta', { text: '案' }),
  event(12, 'run/completed', { usage: { input_tokens: 3, output_tokens: 4 } }),
  event(13, 'assistant/text.delta', { text: '第二轮' }, 'run-2'),
  event(14, 'run/failed', {}, 'run-2'),
]

/** card.sourceSeqs 是唯一被折叠影响的字段，且其消费方只取首项（见 conversation-card-state.ts）。 */
const anchorFree = (messages: SessionMessage[]) => messages.map(message => ({
  ...message,
  turn: message.turn
    ? { ...message.turn, items: message.turn.items.map(item => {
        if (!item.card) return item
        return { ...item, card: { ...item.card, sourceSeqs: item.card.sourceSeqs.slice(0, 1) } }
      }) }
    : message.turn,
}))

describe('会话事件折叠', () => {
  const folded = foldSessionEvents(raw)

  it('只并相邻、同 (run_id, type) 的 delta，并保留首个 seq 与 seq_range', () => {
    expect(folded.map(item => item.seq)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 12, 13, 14])
    expect(folded.find(item => item.seq === 3)?.data).toMatchObject({ text: '想一下', seq_range: [3, 4] })
    // message.end 之后的同类型 delta 必须开新片段，否则会跨过客户端投影的关闭边界。
    expect(folded.find(item => item.seq === 6)?.data.text).toBe('再想')
    expect(folded.find(item => item.seq === 10)?.data.text).toBe('答案')
  })

  it('跨 run_id 不合并', () => {
    expect(folded.filter(item => item.type === 'assistant/text.delta').map(item => item.seq)).toEqual([10, 13])
  })

  it('非 delta 事件原样保留', () => {
    expect(folded.find(item => item.seq === 7)).toBe(raw[6])
    expect(folded.filter(item => item.type.startsWith('tool/'))).toHaveLength(2)
  })

  it('折叠前后的客户端投影一致（除 card.sourceSeqs 锚点集合）', () => {
    const before = projectSessionEvents(raw)
    const after = projectSessionEvents(folded)
    expect(anchorFree(after.messages)).toEqual(anchorFree(before.messages))
    expect(after.inputs).toEqual(before.inputs)
    expect(after.approvals).toEqual(before.approvals)
    expect(after.messages).toHaveLength(before.messages.length)
  })

  it('折叠是幂等的', () => {
    expect(foldSessionEvents(folded)).toEqual(folded)
  })
})
