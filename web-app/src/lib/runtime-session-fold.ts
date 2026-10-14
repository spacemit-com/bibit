import type { SessionEvent } from './runtime-session-projection'

/**
 * 与服务端读模型同源的折叠规则（`bianbu_agent/api/sessions.py::_fold_history_events`）：
 * 只合并**相邻**、同 `(run_id, type)` 的 token delta，保留首条的 seq/time，
 * 正文拼接进 `data.text`，被并掉的 seq 记在 `data.seq_range`。
 *
 * 等价性：`projectSessionEvents` 本来就是「同 kind 且未被 message.end 关闭时
 * `markdown += delta`」，中间插入任何事件都会让它开新 item，而“相邻”保证折叠
 * 不会跨过这些边界。
 *
 * 两个用途：
 * - 历史窗口由 Runtime 折叠后下发，客户端直接投影；
 * - 实时增量在客户端用同一规则折叠，窗口体积因此与消息数成正比，而不是与 token 数成正比。
 */
const FOLDABLE_TYPES = new Set(['assistant/text.delta', 'assistant/reasoning.delta'])

function foldable(previous: SessionEvent, event: SessionEvent) {
  return FOLDABLE_TYPES.has(event.type)
    && event.type === previous.type
    && (event.run_id ?? null) === (previous.run_id ?? null)
}

function rangeStart(event: SessionEvent) {
  const span = event.data.seq_range
  return Array.isArray(span) && span.length === 2 && Number.isSafeInteger(span[0]) ? Number(span[0]) : event.seq
}

/** 把 `event` 追加到 `folded` 尾部；命中折叠规则时原地并进最后一条。 */
export function appendFolded(folded: SessionEvent[], event: SessionEvent) {
  const previous = folded[folded.length - 1]
  if (!previous || !foldable(previous, event)) {
    folded.push(event)
    return
  }
  folded[folded.length - 1] = {
    ...previous,
    data: {
      ...previous.data,
      text: `${String(previous.data.text ?? '')}${String(event.data.text ?? '')}`,
      seq_range: [rangeStart(previous), event.seq],
    },
  }
}

export function foldSessionEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const folded: SessionEvent[] = []
  for (const event of events) appendFolded(folded, event)
  return folded
}
