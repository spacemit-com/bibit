import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markProjectionDone, markStreamArrival, markStreamCommit, resetStreamTimings,
  setStreamTimingsEnabled, streamTimingReport } from '../stream-timings'
import { projectSessionEvents, type SessionEvent } from '../runtime-session-projection'

function project(seq: number, content: string) {
  const events: SessionEvent[] = [{ seq: 1, time: 0, type: 'assistant/text.delta', run_id: 'r1',
    data: { text: content, seq_range: [1, seq] } }]
  markProjectionDone(1, 's1', events, projectSessionEvents(events).messages)
}

describe('流式计时采样', () => {
  beforeEach(() => { setStreamTimingsEnabled(false); resetStreamTimings() })
  afterEach(() => vi.restoreAllMocks())

  it('默认不采样：关闭时不记任何样本', () => {
    markStreamArrival('s1', 'r1', 1)
    project(1, 'A')
    markStreamCommit('r1:1', 'A')
    expect(streamTimingReport().samples).toBe(0)
  })

  it('没有在途批次时提交不凭空产生样本', () => {
    setStreamTimingsEnabled(true)
    markStreamCommit('r1:1', 'A')
    expect(streamTimingReport().samples).toBe(0)
  })

  it('到达与提交配对成样本，超上限后只保留最近的一段', () => {
    setStreamTimingsEnabled(true)
    for (let index = 1; index <= 2_500; index++) {
      markStreamArrival('s1', 'r1', index)
      project(index, String(index))
      markStreamCommit('r1:1', String(index))
    }
    const report = streamTimingReport()
    expect(report.enabled).toBe(true)
    expect(report.samples).toBe(2_000)
    expect(report.commitLatencyMs?.count).toBe(2_000)
    expect(report.projectionMs?.p50).toBeGreaterThanOrEqual(1)
  })

  it('B先到达而A才显示时，A和B分别使用自己的事件时间', () => {
    const now = vi.spyOn(performance, 'now')
    setStreamTimingsEnabled(true)
    now.mockReturnValue(20)
    markStreamArrival('s1', 'r1', 1)
    project(1, 'A')
    now.mockReturnValue(99)
    markStreamArrival('s1', 'r1', 2)
    now.mockReturnValue(100)
    markStreamCommit('r1:1', 'A\n')
    expect(streamTimingReport().commitLatencyMs?.p50).toBe(80)
    project(2, 'AB')
    now.mockReturnValue(200)
    markStreamCommit('r1:1', 'AB')
    expect(streamTimingReport().commitLatencyMs).toMatchObject({ count: 2, p95: 101 })
    project(2, 'AB')
    markStreamCommit('r1:1', 'AB')
    expect(streamTimingReport().samples).toBe(2)
  })

  it('其他消息或不同内容不会消费当前快照', () => {
    setStreamTimingsEnabled(true)
    markStreamArrival('s1', 'r1', 1)
    project(1, 'A')
    markStreamCommit('other', 'A')
    markStreamCommit('r1:1', 'B')
    expect(streamTimingReport().samples).toBe(0)
    markStreamCommit('r1:1', 'A')
    expect(streamTimingReport().samples).toBe(1)
  })

  it('真实对话中用户和助手共用runId时，只匹配助手正文', () => {
    const now = vi.spyOn(performance, 'now')
    setStreamTimingsEnabled(true)
    const events: SessionEvent[] = [
      { seq: 1, time: 0, type: 'user/message', run_id: 'r1', data: { message_id: 'u1', content: '问题' } },
      { seq: 2, time: 0, type: 'assistant/reasoning.delta', run_id: 'r1', data: { text: '思考' } },
      { seq: 3, time: 0, type: 'assistant/text.delta', run_id: 'r1', data: { text: '回答' } },
    ]
    const messages = projectSessionEvents(events).messages
    expect(messages.map(message => [message.role, message.runId])).toEqual([['user', 'r1'], ['assistant', 'r1']])
    now.mockReturnValue(20)
    markStreamArrival('s1', 'r1', 3)
    markProjectionDone(1, 's1', events, messages)
    now.mockReturnValue(100)
    markStreamCommit('u1', '回答')
    expect(streamTimingReport().samples).toBe(0)
    markStreamCommit('r1:2', '回答\n')
    expect(streamTimingReport().commitLatencyMs).toMatchObject({ count: 1, p95: 80 })
  })
})
