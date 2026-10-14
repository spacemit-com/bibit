import { describe, expect, it } from 'vitest'
import { projectSessionEvents, sessionMessageToUIMessage, sessionApprovalToPermission, sessionResourceUrl, type SessionEvent } from '../runtime-session-projection'
import { extractRuntimeTurnV2FromUIMessage } from '../messages'
import { appendFolded, foldSessionEvents } from '../runtime-session-fold'

const event = (seq: number, type: string, data: Record<string, unknown> = {}, run_id: string | null = 'r1'): SessionEvent =>
  ({ seq, type, data, run_id, time: seq })

// 增量路径只在「事件前缀引用不变、新增部分是同 Run 的 delta」时接管；
// 它必须与全量投影逐字段一致，否则未受影响的消息引用会被错误地留用。
describe('尾部 delta 增量投影', () => {
  const scope = { targetId: 'target', runtimeId: 'bianbu' as const, sessionId: 's', runtimeEpoch: 'e' }
  const user = event(0, 'user/message', { message_id: 'u1', content: '问题' }, null)
  const fold = (folded: SessionEvent[], raw: SessionEvent) => {
    const next = [...folded]
    appendFolded(next, raw)
    return next
  }
  const compare = (previous: SessionEvent[], next: SessionEvent[], hidden: string[] = []) => {
    const baseline = projectSessionEvents(previous, hidden, scope)
    const incremental = projectSessionEvents(next, hidden, scope,
      { events: previous, hiddenRunIds: hidden, identity: scope, projection: baseline })
    expect(incremental).toEqual(projectSessionEvents(next, hidden, scope))
    return { baseline, incremental }
  }

  it('正文继续追加时历史消息保持引用，尾部换新对象且旧对象不被改写', () => {
    const stage1 = fold(fold([user], event(1, 'assistant/text.delta', { text: '前' })), event(2, 'assistant/text.delta', { text: '半' }))
    const stage2 = fold(stage1, event(3, 'assistant/text.delta', { text: '段' }))
    const { baseline, incremental } = compare(stage1, stage2)
    expect(incremental.messages[0]).toBe(baseline.messages[0])
    expect(incremental.messages.at(-1)).not.toBe(baseline.messages.at(-1))
    expect(baseline.messages.at(-1)!.content).toBe('前半')
    expect(incremental.messages.at(-1)!.content).toBe('前半段')
  })

  it('思考继续追加只保留折叠组的组首 seq，不补入被并掉的原始 seq', () => {
    const stage1 = fold([user], event(1, 'assistant/reasoning.delta', { text: '想' }))
    const stage2 = fold(stage1, event(2, 'assistant/reasoning.delta', { text: '考' }))
    const { baseline, incremental } = compare(stage1, stage2)
    expect(incremental.messages.at(-1)!.turn!.items[0]).toMatchObject({
      kind: 'reasoning', markdown: '想考', card: { sourceSeqs: [1] } })
    expect(baseline.messages.at(-1)!.turn!.items[0]).toMatchObject({ markdown: '想', card: { sourceSeqs: [1] } })
  })

  it('同 Run 的思考转正文新开 item，并带上自己的源事件', () => {
    const stage1 = fold([user], event(1, 'assistant/reasoning.delta', { text: '想' }))
    const stage2 = fold(stage1, event(2, 'assistant/text.delta', { text: '答' }))
    const { incremental } = compare(stage1, stage2)
    expect(incremental.messages.at(-1)!.turn!.items.map(item => item.kind)).toEqual(['reasoning', 'answer'])
    expect(incremental.messages.at(-1)!.content).toBe('答')
  })

  it('空 delta 只前移折叠区间时消息对象原样保留，trajectory 指向新的折叠组', () => {
    const stage1 = fold([user], event(1, 'assistant/text.delta', { text: '答' }))
    const stage2 = fold(stage1, event(2, 'assistant/text.delta', { text: '' }))
    const { baseline, incremental } = compare(stage1, stage2)
    expect(incremental.messages.at(-1)).toBe(baseline.messages.at(-1))
    expect(incremental.trajectory.at(-1)).toBe(stage2.at(-1))
  })

  it('工具与终态等非 delta 事件回落到全量投影，结果仍与全量一致', () => {
    const stage1 = fold([user], event(1, 'assistant/text.delta', { text: '答' }))
    const stage2 = [...stage1, event(2, 'tool/call.started', { call_id: 'c1', name: 'read' })]
    const { baseline, incremental } = compare(stage1, stage2)
    // 全量回落只换真正变了的行：用户那条没变，沿用旧对象；尾部多了工具卡片，换新。
    expect(incremental.messages[0]).toBe(baseline.messages[0])
    expect(incremental.messages.at(-1)).not.toBe(baseline.messages.at(-1))
    expect(incremental.messages.at(-1)!.turn!.items.map(item => item.kind)).toEqual(['answer', 'tool'])
    const stage3 = [...stage2, event(3, 'run/completed', { content: '答' })]
    compare(stage2, stage3)
  })

  it('尾部折叠组属于隐藏 Run 时回落全量，不把隐藏正文并进可见消息', () => {
    const stage1 = fold([user], event(1, 'assistant/text.delta', { text: '前' }))
    const stage2 = fold(stage1, event(2, 'assistant/text.delta', { text: '半' }))
    const { incremental } = compare(stage1, stage2, ['r1'])
    expect(incremental.messages.map(message => message.role)).toEqual(['user'])
  })

  it('尾部不是当前消息时（压缩后追加 system）回落全量', () => {
    const stage1 = [...fold([user], event(1, 'assistant/text.delta', { text: '答' })),
      event(5, 'context/compressed', { compressed: true, summary: '摘要' })]
    const stage2 = fold(stage1, event(6, 'assistant/text.delta', { text: '续' }))
    const { baseline, incremental } = compare(stage1, stage2)
    expect(incremental.messages[0]).toBe(baseline.messages[0])
    expect(incremental.messages.at(-1)).not.toBe(baseline.messages.at(-1))
    expect(incremental.messages.map(message => message.role)).toEqual(['user', 'assistant', 'system', 'assistant'])
    expect(incremental.messages.at(-1)!.content).toBe('续')
  })

  it('重复和乱序 delta 回落全量，避免把替换内容拼接两次', () => {
    const previous = [user, event(2, 'assistant/text.delta', { text: '原文' })]
    compare(previous, [...previous, event(2, 'assistant/text.delta', { text: '修订' })])
    compare(previous, [...previous, event(1, 'assistant/text.delta', { text: '前文' })])
    compare(previous, [...previous, event(4, 'assistant/text.delta', { text: '后文' }),
      event(3, 'assistant/text.delta', { text: '中间' })])
  })

  it('尾部时间被修订时重新计算消息元数据', () => {
    const previous = [user, event(1, 'assistant/text.delta', { text: '原文' })]
    compare(previous, [user, { ...previous[1], time: 99, data: { text: '原文新增' } }])
  })

  it('非法 seq 在增量路径中也会被拒绝', () => {
    const previous = [user, event(1, 'assistant/text.delta', { text: '原文' })]
    const projection = projectSessionEvents(previous, [], scope)
    const baseline = { events: previous, hiddenRunIds: [], identity: scope, projection }
    for (const seq of [NaN, -1, 2.5]) {
      expect(() => projectSessionEvents([...previous, event(seq, 'assistant/text.delta', { text: '新增' })], [], scope, baseline)).toThrow()
    }
  })

  // 随机流逐步投影：每一步都必须和全量投影逐字段一致，而且确实有大量步骤走了增量。
  it('随机事件流下每批结果与全量投影严格等价', () => {
    let seed = 20260917
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pick = (values: string[]) => values[Math.floor(random() * values.length)]
    const attempt = (run: () => ReturnType<typeof projectSessionEvents>) => {
      try { return { value: run() } } catch (cause) { return { error: String(cause) } }
    }
    let seq = 0
    let folded = fold([], user)
    let baseline: Parameters<typeof projectSessionEvents>[3]
    let incrementalSteps = 0
    for (let step = 0; step < 400; step++) {
      // 真实流式会话里七成以上是同一 Run 的 delta，其余才是打断增量的事件。
      const runId = random() < 0.85 ? 'r1' : 'r2'
      const shape = random() < 0.7 ? pick(['text', 'text', 'reasoning'])
        : pick(['tool', 'approval', 'end', 'terminal', 'user', 'compress', 'artifact', 'progress'])
      seq += 1
      const data: Record<string, unknown> = {}
      let type = 'assistant/text.delta'
      if (shape === 'text' || shape === 'reasoning') {
        data.text = pick(['甲', '乙丙', '', '丁'])
        type = shape === 'text' ? 'assistant/text.delta' : 'assistant/reasoning.delta'
      } else if (shape === 'tool') {
        type = pick(['tool/call.started', 'tool/call.progress', 'tool/call.completed'])
        Object.assign(data, { call_id: pick(['c1', 'c2']), name: 'read', status: 'success' })
      } else if (shape === 'approval') {
        type = pick(['approval/requested', 'approval/resolved'])
        Object.assign(data, { approval_id: pick(['a1', 'a2']), decision: 'approve' })
      } else if (shape === 'end') type = 'assistant/message.end'
      else if (shape === 'terminal') type = pick(['run/completed', 'run/failed', 'run/cancelled'])
      else if (shape === 'user') { type = 'user/message'; Object.assign(data, { message_id: `u${seq}`, content: '问' }) }
      else if (shape === 'compress') { type = 'context/compressed'; Object.assign(data, { compressed: true, summary: '摘要' }) }
      else if (shape === 'artifact') { type = 'run/event'; Object.assign(data, { kind: 'artifact', payload: { url: '/x' } }) }
      else { type = 'run/progress'; Object.assign(data, { phase: pick(['working', 'recovering']) }) }
      const next = [...folded]
      appendFolded(next, { seq, time: seq, run_id: runId, type, data })
      // 偶尔整表重排折叠：引用全变，增量必须让位给全量。
      folded = step % 37 === 36 ? foldSessionEvents(next) : next
      const full = attempt(() => projectSessionEvents(folded, [], scope))
      const incremental = attempt(() => projectSessionEvents(folded, [], scope, baseline))
      expect(incremental).toEqual(full)
      if (full.error || !full.value || !('value' in incremental) || !incremental.value) { baseline = undefined; continue }
      if (baseline?.projection.messages[0] && incremental.value.messages[0] === baseline.projection.messages[0]) incrementalSteps += 1
      baseline = { events: folded, hiddenRunIds: [], identity: scope, projection: incremental.value }
    }
    expect(incrementalSteps).toBeGreaterThan(50)
  })
})

// 回合边界上的 request/context、run/event、run/completed 都不是 delta，会走全量重投影。
// 全量必须把没变的行沿用旧对象：否则下游按引用做的缓存（UIMessage WeakMap、MessageItem
// 的 memo）全部落空，整屏历史行跟着重渲染，代价还随会话长度一起涨。
describe('全量重投影沿用未变化的消息对象', () => {
  const scope = { targetId: 'target', runtimeId: 'bianbu' as const, sessionId: 's', runtimeEpoch: 'e' }
  // 两轮历史：第一轮已终态，第二轮还在流式。
  const history = [
    event(0, 'user/message', { message_id: 'u1', content: '第一问' }, null),
    event(1, 'assistant/text.delta', { text: '第一答' }, 'r1'),
    event(2, 'run/completed', { content: '第一答' }, 'r1'),
    event(3, 'user/message', { message_id: 'u2', content: '第二问' }, null),
    event(4, 'assistant/text.delta', { text: '第二答' }, 'r2'),
  ]
  const reproject = (previous: SessionEvent[], next: SessionEvent[]) => {
    const baseline = projectSessionEvents(previous, [], scope)
    const full = projectSessionEvents(next, [], scope,
      { events: previous, hiddenRunIds: [], identity: scope, projection: baseline })
    // 引用可以复用，值必须和无基线的一次性全量投影完全一致。
    expect(full).toEqual(projectSessionEvents(next, [], scope))
    return { baseline, full }
  }

  it('尾部非 delta 事件没有改动任何消息时，整段历史沿用同一批对象', () => {
    const { baseline, full } = reproject(history, [...history, event(5, 'run/event', { kind: 'note' }, 'r2')])
    expect(full.messages).toHaveLength(baseline.messages.length)
    full.messages.forEach((message, index) => expect(message).toBe(baseline.messages[index]))
  })

  it('终态只改尾部时，历史行沿用旧对象、尾部换新', () => {
    const { baseline, full } = reproject(history, [...history, event(5, 'run/completed', { content: '第二答' }, 'r2')])
    expect(full.messages.at(-1)).not.toBe(baseline.messages.at(-1))
    full.messages.slice(0, -1).forEach((message, index) => expect(message).toBe(baseline.messages[index]))
    expect(full.messages.at(-1)!.content).toBe('第二答')
  })

  it('历史行内容真的被修订时，不复用旧对象、也不把旧内容粘住', () => {
    const { baseline, full } = reproject(history, [...history, event(5, 'run/completed', { content: '第一答（修订）' }, 'r1')])
    const revised = full.messages.find(message => message.runId === 'r1')!
    expect(revised.content).toBe('第一答（修订）')
    expect(revised).not.toBe(baseline.messages.find(message => message.runId === 'r1'))
  })
})

describe('审批卡片的人话说明', () => {
  it('token_budget 审批用 message 作卡片说明，不再是空白卡', () => {
    // 2026-09-13 板上会话 01M2AF5MZAYMAN9T09994AJ98B 的真实 approval/requested 载荷。
    const requested = event(3356, 'approval/requested', {
      approval_id: 'token-budget-62c2442d-1064-470d-98ab-294d1440015a-6bb2db7e01034e6ba9c9e8d59748a84f',
      kind: 'token_budget',
      message: 'Token quota reached: used=2876063; limit=100000',
      quota: { limit: 100000, on_exceed: 'pause_and_notify', scope: 'conversation', used: 2876063 },
      actions: [{ name: 'token.budget', description: 'Token quota reached: used=2876063; limit=100000',
        arguments: { agent_id: 'com.bianbu.ea1751d69f08', limit: 100000, scope: 'conversation', used: 2876063 },
        allowed_decisions: ['approve', 'reject'] }],
    }, '62c2442d-1064-470d-98ab-294d1440015a')
    const scope = { targetId: 'target', runtimeId: 'bianbu' as const, sessionId: 's', runtimeEpoch: 'epoch' }
    const state = projectSessionEvents([requested], [], scope)
    const approval = Object.values(state.approvals)[0]
    expect(approval.data.title).toBeUndefined()
    expect(sessionApprovalToPermission(approval, scope).description).toBe('Token quota reached: used=2876063; limit=100000')
    expect(sessionMessageToUIMessage(state.messages[0]).parts[0]).toMatchObject({ type: 'data-runtime-permission',
      data: { description: 'Token quota reached: used=2876063; limit=100000', canAllowOnce: true, canDeny: true } })
  })
  it('工具审批没有顶层说明时取 action.description，顶层 description 仍优先', () => {
    // 板上会话 01M24HW1TG5KW24APZQFFPJFDA seq=324 的载荷形状：只有 actions，没有 title/description/tool_name。
    const tool = event(324, 'approval/requested', { approval_id: 'a',
      actions: [{ description: '工具执行需要人工批准\n\nTool: memory_retrieve', arguments: { query: 'x' }, allowed_decisions: ['approve', 'reject'] }] })
    const scope = { targetId: 't', runtimeId: 'bianbu' as const, sessionId: 's', runtimeEpoch: 'e' }
    const projected = Object.values(projectSessionEvents([tool], [], scope).approvals)[0]
    expect(sessionApprovalToPermission(projected, scope).description).toBe('工具执行需要人工批准\n\nTool: memory_retrieve')
    const explicit = Object.values(projectSessionEvents([event(1, 'approval/requested', { approval_id: 'a', description: '顶层说明',
      actions: [{ description: '动作说明', allowed_decisions: ['approve'] }] })], [], scope).approvals)[0]
    expect(sessionApprovalToPermission(explicit, scope).description).toBe('顶层说明')
  })
})

describe('Session 原始事件统一投影', () => {
  it.each(['failed', 'cancelled', 'completed'])('终态 %s 结束未完成工具并保留其他 Run', terminal => {
    const state = projectSessionEvents([
      event(1, 'tool/call.completed', { call_id: 'done', status: 'success', result: 'ok' }),
      event(2, 'tool/call.started', { call_id: 'pending' }),
      event(3, 'tool/call.started', { call_id: 'pending' }, 'other'),
      event(4, `run/${terminal}`, { error: { code: 'security_denied', message: 'Denied' } }),
    ])
    const own = state.messages.find(m => m.runId === 'r1')!
    expect(own.turn!.items.filter(i => i.kind === 'tool').map(i => i.status)).toEqual(['completed', 'failed'])
    expect(own.turn!.items.find(i => i.kind === 'tool' && i.toolCallId === 'pending')).toMatchObject({ error: 'Denied' })
    const other = state.messages.find(m => m.runId === 'other')!
    expect(other.turn!.items[0]).toMatchObject({ status: 'running' })
  })

  it('纯文本的错误原样成为工具失败原因', () => {
    const state = projectSessionEvents([
      event(1, 'tool/call.started', { call_id: 'pending' }),
      event(2, 'run/failed', { error: 'upstream exploded' }),
    ])
    const tool = state.messages.find(m => m.runId === 'r1')!.turn!.items.find(i => i.kind === 'tool')!
    expect(tool).toMatchObject({ status: 'failed', error: 'upstream exploded' })
  })

  it('审批先出现时后续消息身份与 Runtime 历史操作对齐，原位审批不丢失', () => {
    const events = [event(0, 'user/message', { message_id: 'u1', content: '执行' }),
      event(1, 'approval/requested', { approval_id: 'a' }),
      event(2, 'assistant/text.delta', { text: '结果' }),
      event(3, 'run/completed'),
      event(4, 'conversation/changed', { action: 'regenerate', message_id: 'r1:2', operation_id: 'op' })]
    const before = projectSessionEvents(events.slice(0, 4))
    expect(before.messages[1].id).toBe('r1:2')
    expect(before.messages[1].turn!.items.map(item => item.kind)).toEqual(['permission', 'answer'])
    expect(() => projectSessionEvents(events)).not.toThrow()
  })
  it('思考前缀补页保留共有源事件，工具与审批中断片段，UI 转换保留身份', () => {
    const events = [event(90, 'assistant/reasoning.delta', { text: '前' }),
      event(100, 'assistant/reasoning.delta', { text: '后' }),
      event(101, 'approval/requested', { approval_id: 'a' }),
      event(102, 'assistant/reasoning.delta', { text: '新段' })]
    const full = projectSessionEvents(events).messages[0]
    const partial = projectSessionEvents(events.slice(1)).messages[0]
    expect(full.turn!.items[0].card).toEqual({ kind: 'reasoning', runId: 'r1', id: '90', sourceSeqs: [90, 100] })
    expect(partial.turn!.items[0].card?.sourceSeqs).toEqual([100])
    expect(full.turn!.items[2].card?.id).toBe('102')
    const scope = { targetId: 'target', runtimeId: 'bianbu' as const, sessionId: 's', runtimeEpoch: 'epoch' }
    const ui = sessionMessageToUIMessage(full, undefined, scope)
    expect(ui.metadata).toMatchObject({ conversationCardScope: { targetId: 'target', runtimeId: 'bianbu', sessionId: 's' } })
    expect(extractRuntimeTurnV2FromUIMessage(ui)?.items.map(item => item.card)).toEqual(full.turn!.items.map(item => item.card))
  })
  it.each(['completed', 'failed', 'cancelled'])('审批先于正文，%s 后原位失效，缺身份不可决定', status => {
    const scope = { targetId: 'target', runtimeId: 'bianbu' as const, sessionId: 's', runtimeEpoch: 'epoch' }
    const request = event(1, 'approval/requested', { approval_id: 'a', actions: [{ name: 'write', allowed_decisions: ['approve', 'reject'], arguments: { token: 'secret' } }] })
    const pending = projectSessionEvents([request], [], scope)
    const approval = Object.values(pending.approvals)[0]
    expect(sessionApprovalToPermission(approval).canAllowOnce).toBe(false)
    expect(sessionApprovalToPermission(approval, scope).canAllowOnce).toBe(true)
    const state = projectSessionEvents([request, event(2, `run/${status}`)], [], scope)
    const part = sessionMessageToUIMessage(state.messages[0]).parts[0]
    expect(part).toMatchObject({ type: 'data-runtime-permission', data: { status: 'resolved', expiredReason: expect.any(String), canAllowOnce: false, canDeny: false } })
    expect(JSON.stringify(part)).not.toContain('secret')
  })
  it('审批 timeout 回执原位显示超时失效，后续任务失败不丢失原因', () => {
    const scope = { targetId: 'target', runtimeId: 'bianbu' as const, sessionId: 's', runtimeEpoch: 'epoch' }
    const events = [event(1280, 'approval/requested', { approval_id: 'budget', kind: 'token_budget', actions: [{ name: 'token.budget' }] }),
      event(1281, 'approval/resolved', { approval_id: 'budget', decision: 'timeout' }),
      event(1282, 'run/failed', { error: { code: 'TOKEN_BUDGET_APPROVAL_TIMEOUT' } })]
    for (const batch of [events.slice(0, 2), events, [...events].reverse().concat(events)]) {
      const state = projectSessionEvents(batch, [], scope)
      const approval = Object.values(state.approvals)[0]
      expect(approval).toMatchObject({ status: 'expired', decision: 'timeout', expiredReason: 'timeout' })
      expect(state.messages[0].turn!.items.filter(item => item.kind === 'permission')).toHaveLength(1)
      expect(sessionMessageToUIMessage(state.messages[0]).parts[0]).toMatchObject({
        type: 'data-runtime-permission', data: { status: 'resolved', expiredReason: 'timeout', canAllowOnce: false, canDeny: false },
      })
      expect(sessionApprovalToPermission(approval, scope).decision).toBeUndefined()
    }
  })
  it('孤立 resolved 不制造请求，重复 request 不移动位置或回退状态', () => {
    expect(projectSessionEvents([event(1, 'approval/resolved', { approval_id: 'a' })]).messages).toEqual([])
    const state = projectSessionEvents([event(1, 'approval/requested', { approval_id: 'a' }),
      event(2, 'approval/resolved', { approval_id: 'a', decision: 'reject' }),
      event(3, 'assistant/text.delta', { text: '正文' }),
      event(4, 'approval/requested', { approval_id: 'a' })])
    expect(state.messages[0].turn!.items.map(item => item.kind)).toEqual(['permission', 'answer'])
    expect(Object.values(state.approvals)[0].status).toBe('resolved')
  })
  it('审批在触发位置更新，身份按 Run 隔离且与历史重放相同', () => {
    const events = [event(1, 'assistant/reasoning.delta', { text: '思考' }),
      event(2, 'approval/requested', { approval_id: 'a' }),
      event(3, 'approval/resolved', { approval_id: 'a', decision: 'approve' }),
      event(4, 'tool/call.started', { call_id: 't' }),
      event(5, 'assistant/text.delta', { text: '正文' }),
      event(6, 'approval/requested', { approval_id: 'a' }, 'r2')]
    const state = projectSessionEvents(events)
    expect(state.messages[0].turn!.items.map(item => item.kind)).toEqual(['reasoning', 'permission', 'tool', 'answer'])
    expect(Object.values(state.approvals)).toHaveLength(2)
    expect(sessionMessageToUIMessage(state.messages[0]).parts[1]).toMatchObject({ data: { status: 'resolved', decision: 'allow_once' } })
    expect(projectSessionEvents([...events].reverse().concat(events))).toEqual(state)
  })
  it('缺少工具名称时安全降级，失败原因交给原工具组件脱敏呈现', () => {
    const result = { message: '命令失败', token: 'sensitive-token' }
    const state = projectSessionEvents([event(1, 'tool/call.completed', { call_id: 't1', status: 'failed', result })])
    const tool = sessionMessageToUIMessage(state.messages[0]).parts.find(part => part.type === 'data-runtime-tool')
    expect(tool).toMatchObject({ data: { name: '', status: 'failed', error: JSON.stringify(result) } })
  })
  it.each(['failed', 'cancelled'] as const)('任务终态 %s 有明确文字且不直接暴露原始错误', status => {
    const state = projectSessionEvents([event(1, `run/${status}`, { error: { token: 'sensitive-token' } })])
    const parts = sessionMessageToUIMessage(state.messages[0]).parts
    expect(parts).toContainEqual({ type: 'data-runtime-diagnostic', data: {
      level: status === 'failed' ? 'warning' : 'info',
      message: status === 'failed' ? 'run_failed' : 'run_cancelled',
    } })
    expect(JSON.stringify(parts)).not.toContain('sensitive-token')
  })
  it('失败同时保留 Runtime 原文与可翻译的错误代码', () => {
    // 2026-09-13 板上会话 01M2BKX7VVEGRPQ5D08EEKWCB6 seq=6860 的真实 run/failed 载荷。
    const state = projectSessionEvents([event(6860, 'run/failed', {
      error: { code: 'worker_rpc_error', details: {}, message: 'EOFError' },
    })])
    expect(sessionMessageToUIMessage(state.messages[0]).parts).toContainEqual({
      type: 'data-runtime-diagnostic',
      data: { level: 'warning', message: 'EOFError', code: 'worker_rpc_error' },
    })
  })
  it('错误只有文本时按文本呈现且不重复成 detail', () => {
    const state = projectSessionEvents([event(1, 'run/failed', { error: 'Runtime Run failed' })])
    expect(sessionMessageToUIMessage(state.messages[0]).parts).toContainEqual({
      type: 'data-runtime-diagnostic',
      data: { level: 'warning', message: 'Runtime Run failed' },
    })
  })
  it('终态失败把结构化 details 与 retryable 一并交给界面层', () => {
    // 用户报的症状：Runtime WebUI 能显示「缺哪条能力」，Bibit 只剩一句通用文案。
    const details = { tool: 'web_search', capability: 'network.access', risk_level: 'L2' }
    const state = projectSessionEvents([event(7, 'run/failed', {
      error: { code: 'security_denied', message: '[bianbu-security] 能力未授权',
        retryable: false, details },
    })])
    expect(sessionMessageToUIMessage(state.messages[0]).parts).toContainEqual({
      type: 'data-runtime-diagnostic',
      data: { level: 'warning', message: '[bianbu-security] 能力未授权',
        code: 'security_denied', retryable: false, details },
    })
  })
  it('运行过程中的 error 事件也变成可见诊断，不再被丢弃', () => {
    // 上游 429 的具体原因只出现在过程事件里；以前 run/event 只认 artifact。
    const state = projectSessionEvents([
      event(3, 'run/event', { kind: 'error', payload: {
        code: 'provider_rate_limited', message: '上游返回 429：请求数已耗尽',
        retryable: true, details: { provider: 'deepseek', http_status: 429 },
      } }),
      event(4, 'run/failed', { error: {
        code: 'run_failed', message: '任务执行失败', retryable: true, details: {},
      } }),
    ])
    const parts = sessionMessageToUIMessage(state.messages[0]).parts
    expect(parts).toContainEqual({
      type: 'data-runtime-diagnostic',
      data: { level: 'warning', message: '上游返回 429：请求数已耗尽',
        code: 'provider_rate_limited', retryable: true,
        details: { provider: 'deepseek', http_status: 429 } },
    })
    expect(parts).toContainEqual({
      type: 'data-runtime-diagnostic',
      data: { level: 'warning', message: '任务执行失败', code: 'run_failed', retryable: true },
    })
  })
  it('空的 details 不会变成空诊断行', () => {
    const state = projectSessionEvents([event(1, 'run/event', {
      kind: 'error', payload: { code: 'run_failed', message: 'boom', details: {} },
    })])
    const diagnostic = sessionMessageToUIMessage(state.messages[0]).parts
      .find(part => part.type === 'data-runtime-diagnostic')
    expect(diagnostic?.data).not.toHaveProperty('details')
  })
  it('同源的诊断与终态只显示一次', () => {
    // 板上真实载荷（SpacemiT K3 会话 device-verify-reason，Runtime 先写诊断再写终态，
    // 两条内容完全相同）。以前会显示两遍同一句话。
    const failure = {
      code: 'skill_unavailable',
      retryable: false,
      details: { skill_ids: ['global/definitely-missing-skill'] },
      message: 'Selected Skills are unavailable: global/definitely-missing-skill',
    }
    const state = projectSessionEvents([
      event(7, 'run/event', { kind: 'error', payload: failure }),
      event(8, 'run/failed', { error: failure }),
    ])
    const diagnostics = sessionMessageToUIMessage(state.messages[0]).parts
      .filter(part => part.type === 'data-runtime-diagnostic')
    expect(diagnostics).toHaveLength(1)
    // 留下的那条仍带完整原因：去重不能把细节丢掉。
    expect(diagnostics[0].data).toEqual({
      level: 'warning', message: failure.message, code: failure.code,
      retryable: false, details: failure.details,
    })
  })
  it('诊断与终态原因不同时两条都保留', () => {
    const state = projectSessionEvents([
      event(3, 'run/event', { kind: 'error', payload: {
        code: 'provider_rate_limited', message: '上游返回 429：请求数已耗尽', details: {},
      } }),
      event(4, 'run/failed', { error: {
        code: 'run_failed', message: '任务执行失败', details: {},
      } }),
    ])
    const diagnostics = sessionMessageToUIMessage(state.messages[0]).parts
      .filter(part => part.type === 'data-runtime-diagnostic')
    expect(diagnostics).toHaveLength(2)
  })
  it('同码同话但原因不同时不去重', () => {
    const state = projectSessionEvents([
      event(3, 'run/event', { kind: 'error', payload: {
        code: 'security_denied', message: '拒绝', details: { capability: 'net' },
      } }),
      event(4, 'run/failed', { error: {
        code: 'security_denied', message: '拒绝', details: { capability: 'terminal' },
      } }),
    ])
    const diagnostics = sessionMessageToUIMessage(state.messages[0]).parts
      .filter(part => part.type === 'data-runtime-diagnostic')
    expect(diagnostics).toHaveLength(2)
  })
  it('终态修订正文时用权威内容替换，保留工具位置且不重复答案', () => {
    const state = projectSessionEvents([
      event(0, 'assistant/text.delta', { text: '旧正文' }),
      event(1, 'tool/call.started', { call_id: 't', name: 'read' }),
      event(2, 'assistant/text.delta', { text: '后半段' }),
      event(3, 'run/completed', { content: '修订后的完整正文' }),
    ])
    expect(state.messages[0].content).toBe('修订后的完整正文')
    expect(state.messages[0].turn!.items.filter(item => item.kind === 'answer').map(item => item.markdown).join('')).toBe('修订后的完整正文')
    expect(state.messages[0].turn!.items[1].kind).toBe('tool')
  })
  it('思考阶段在工具和 message.end 时结束，后续思考独立展开', () => {
    const frames = [event(0, 'assistant/reasoning.delta', { text: '第一阶段' })]
    const states = () => sessionMessageToUIMessage(projectSessionEvents(frames).messages[0]).parts
      .filter(part => part.type === 'reasoning').map(part => part.state)
    expect(states()).toEqual(['streaming'])
    frames.push(event(1, 'tool/call.started', { call_id: 'tool', name: 'read' }))
    expect(states()).toEqual(['done'])
    frames.push(event(2, 'assistant/reasoning.delta', { text: '第二阶段' }))
    expect(states()).toEqual(['done', 'streaming'])
    frames.push(event(3, 'assistant/message.end'))
    expect(states()).toEqual(['done', 'done'])
  })
  it('按 Run 配对 Hook，并仅预览 Runtime 同源媒体', () => {
    const state = projectSessionEvents([
      event(0, 'hook/invoked', { invocation_id: 'h', hook_id: 'intent' }),
      event(1, 'hook/result', { invocation_id: 'h', result: 'ok' }),
      event(2, 'run/event', { kind: 'artifact', payload: { url: '/api/v1/files/image', media_type: 'image/png' } }),
      event(3, 'run/event', { kind: 'artifact', payload: { path: '/home/bianbu/private.png', media_type: 'image/png' } }),
    ])
    expect(state.hooks).toHaveLength(1)
    expect(state.hooks[0].invoked?.seq).toBe(0)
    expect(state.hooks[0].result?.seq).toBe(1)
    expect(sessionMessageToUIMessage(state.messages[0], 'http://device:9899/api/v1/').parts).toEqual([
      { type: 'file', url: 'http://device:9899/api/v1/files/image', mediaType: 'image/png', filename: undefined },
    ])
    expect(sessionResourceUrl('https://evil.test/image', 'http://device:9899/')).toBeUndefined()
    expect(sessionResourceUrl('javascript:alert(1)', 'http://device:9899/')).toBeUndefined()
  })
  it('合并 inbox 与 user/message，保留交错片段，不重复终态正文', () => {
    const events = [
      event(0, 'agent/inbox/spliced', { message: { message_id: 'm1', content: '你好' } }, null),
      event(1, 'agent/inbox/claimed', { message_ids: ['m1'] }),
      event(2, 'user/message', { message_id: 'm1', content: '你好' }),
      event(3, 'assistant/reasoning.delta', { text: '思考' }),
      event(4, 'tool/call.started', { call_id: 't1', name: 'read', arguments: { path: '/tmp/a' } }),
      event(5, 'assistant/text.delta', { text: '第一段' }),
      event(6, 'tool/call.completed', { call_id: 't1', result: 'ok', status: 'success' }),
      event(7, 'tool/call.started', { call_id: 't2', name: 'read' }),
      event(8, 'assistant/text.delta', { text: '第二段' }),
      event(9, 'run/completed', { content: '第一段第二段', usage: { total_tokens: 42 } }),
    ]
    const state = projectSessionEvents(events)
    expect(state.messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(state.inputs.m1.status).toBe('executing')
    const assistant = state.messages.find(m => m.role === 'assistant')!
    expect(assistant.turn!.items.map(p => p.kind)).toEqual(['reasoning', 'tool', 'answer', 'tool', 'answer'])
    expect(assistant.content).toBe('第一段第二段')
    expect(assistant.status).toBe('completed')
    expect(assistant.usage).toEqual({ total_tokens: 42 })
    expect(projectSessionEvents([...events].reverse().concat(events))).toEqual(state)
  })

  it('隐藏标题 Run，保留多条输入以及稍后 Run 的技能消息', () => {
    const events = [
      event(0, 'agent/inbox/spliced', { message: { message_id: 'm2', content: '技能消息', skill_ids: ['s1'] } }, null),
      event(1, 'user/message', { content: '内部标题', console_operation: 'generate_title' }, 'title'),
      event(2, 'assistant/text.delta', { text: '绝不显示' }, 'title'),
      event(3, 'user/message', { message_id: 'm2', content: '技能消息' }, 'r2'),
    ]
    const state = projectSessionEvents(events, ['title'])
    expect(state.messages.map(m => m.content)).toEqual(['技能消息'])
    expect(state.trajectory.some(e => e.run_id === 'title')).toBe(false)
    expect(state.inputs.m2.skillIds).toEqual(['s1'])
    expect(state.inputs.m2.runId).toBe('r2')
  })

  it('审批解决保留历史，终态使未决审批失效，message.end 分隔片段', () => {
    const state = projectSessionEvents([
      event(0, 'approval/requested', { approval_id: 'a1', call_id: 't', name: 'write' }),
      event(1, 'approval/resolved', { approval_id: 'a1', decision: 'reject' }),
      event(2, 'assistant/reasoning.delta', { text: '一' }),
      event(3, 'assistant/message.end'),
      event(4, 'assistant/reasoning.delta', { text: '二' }),
      event(5, 'approval/requested', { approval_id: 'a2', call_id: 't2' }),
      event(6, 'run/cancelled'),
    ])
    expect(state.approvals['["r1","a1"]'].status).toBe('resolved')
    expect(state.approvals['["r1","a1"]'].decision).toBe('reject')
    expect(state.approvals['["r1","a2"]'].status).toBe('expired')
    expect(state.messages[0].turn!.items.filter(p => p.kind === 'reasoning')).toHaveLength(2)
  })

  it('窗口可从非零开始，未知事件不制造消息，非法序号拒绝', () => {
    expect(projectSessionEvents([event(30, 'future/event')]).messages).toEqual([])
    expect(() => projectSessionEvents([event(-1, 'future/event')])).toThrow()
  })
})

describe('Session 历史分支保持原对话交互', () => {
  const original = [
    event(0, 'user/message', { message_id: 'u', content: '问题' }),
    event(1, 'assistant/text.delta', { text: '原回答' }),
    event(2, 'run/completed', { content: '原回答' }),
    event(3, 'user/message', { message_id: 'u2', content: '追问' }, 'r2'),
    event(4, 'run/completed', { content: '后续回答' }, 'r2'),
  ]
  it('编辑建立同级版本，切换旧版恢复原后续，删除保持后续顺序', () => {
    const edited = [...original, event(5, 'conversation/changed', {
      action: 'edit', operation_id: 'edit', message_id: 'r1:1', content: '新回答',
    }, null)]
    let state = projectSessionEvents(edited)
    expect(state.messages.map(m => m.content)).toEqual(['问题', '新回答'])
    expect(state.messages[1]).toMatchObject({ id: 'history:edit', parentId: 'u' })
    const switched = [...edited, event(6, 'conversation/changed', {
      action: 'switch_version', operation_id: 'switch', message_id: 'r1:1',
    }, null)]
    state = projectSessionEvents(switched)
    expect(state.messages.map(m => m.content)).toEqual(['问题', '原回答', '追问', '后续回答'])
    state = projectSessionEvents([...switched, event(7, 'conversation/changed', {
      action: 'delete', operation_id: 'delete', message_id: 'r1:1',
    }, null)])
    expect(state.messages.map(m => m.content)).toEqual(['问题', '追问', '后续回答'])
  })
  it('用户编辑后的 Run 不重复用户气泡，重新生成保留旧答案版本', () => {
    const edited = [...original.slice(0, 3), event(3, 'conversation/changed', {
      action: 'edit', operation_id: 'edit', message_id: 'u', content: '新问题',
    }, null), event(4, 'user/message', { message_id: 'history:edit', content: '新问题' }, 'r2'),
    event(5, 'run/completed', { content: '新答案' }, 'r2')]
    expect(projectSessionEvents(edited).messages.map(m => m.content)).toEqual(['新问题', '新答案'])
    const regenerated = [...edited, event(6, 'conversation/changed', {
      action: 'regenerate', operation_id: 'regen', message_id: 'r2:5',
    }, null), event(7, 'user/message', { message_id: 'history:edit', content: '新问题' }, 'r3'),
    event(8, 'run/completed', { content: '再答' }, 'r3')]
    expect(projectSessionEvents(regenerated).messages.map(m => m.content)).toEqual(['新问题', '再答'])
  })
})

it('续写替换部分回答，保留工具和正文，下一输入不继承前缀', () => {
  const events = [event(0, 'user/message', { message_id: 'u', content: '问题' }),
    event(1, 'assistant/text.delta', { text: '前半段' }),
    event(2, 'tool/call.started', { call_id: 'tool', name: 'read' }),
    event(3, 'tool/call.completed', { call_id: 'tool', result: '内容' }),
    event(4, 'run/cancelled', { content: '前半段' }),
    event(5, 'conversation/changed', { action: 'continue', operation_id: 'c', message_id: 'r1:1' }, null),
    event(6, 'user/message', { message_id: 'u', content: '问题', request: { metadata: { history_operation_id: 'c' } } }, 'r2'),
    event(7, 'assistant/text.delta', { text: '后半段' }, 'r2'),
    event(8, 'run/cancelled', { content: '后半段' }, 'r2')]
  let state = projectSessionEvents(events)
  expect(state.messages.map(m => m.content)).toEqual(['问题', '前半段后半段'])
  expect(state.allMessages.some(m => m.id === 'r1:1')).toBe(false)
  expect(state.messages[1].turn?.items.filter(item => item.kind === 'tool')).toHaveLength(1)
  const again = [...events,
    event(9, 'conversation/changed', { action: 'continue', operation_id: 'c2', message_id: 'r2:7' }, null),
    event(10, 'user/message', { message_id: 'u', content: '问题', request: { metadata: { history_operation_id: 'c2' } } }, 'r3'),
    event(11, 'run/completed', { content: '结尾' }, 'r3')]
  state = projectSessionEvents(again)
  expect(state.messages.map(m => m.content)).toEqual(['问题', '前半段后半段结尾'])
  expect(sessionMessageToUIMessage(state.messages[1]).parts.filter(p => p.type === 'text').map(p => p.text).join('')).toBe('前半段后半段结尾')
  state = projectSessionEvents([...again, event(12, 'user/message', { message_id: 'next', content: '下一问' }, 'r3'),
    event(13, 'run/completed', { content: '下一答' }, 'r3')])
  expect(state.messages.at(-1)?.content).toBe('下一答')
})
