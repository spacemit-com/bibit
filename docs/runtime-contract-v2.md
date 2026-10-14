# Bibit Runtime Contract v2

Runtime Contract v2 is the normalized boundary between Bibit and agent runtimes.
Hermes ACP and Bianbu HTTP adapters both publish this contract through the shared
Rust gateway; UI code does not branch on their native protocols.

## Wire envelope

New events use `schemaVersion: "2.0"`. The envelope identity, sequencing and
event payloads remain compatible with v1:

- `runtimeId`, `runtimeEpoch`, `sessionId`, `runId`, `sequence` and `eventId`
  identify one ordered run stream.
- `reasoning_delta` belongs to the work lane.
- tool and permission events belong to the work lane and retain their event order.
- `text_delta` belongs to the answer lane.
- exactly one terminal event ends a run.

Readers accept both `1.0` and `2.0`. Writers only emit `2.0`; v1 is read-only
compatibility and is not re-emitted by a new gateway.

## Adapter mapping

| Contract event | Hermes ACP | Bianbu HTTP SSE |
| --- | --- | --- |
| `reasoning_delta` | agent thought chunk | `reasoning` |
| `text_delta` | agent message chunk | `delta` |
| `tool_started` | tool call start | `tool_start` |
| `tool_updated` | tool call update | `tool_progress` |
| `tool_completed` | tool call end | `tool_end` |
| permission events | ACP permission exchange | approval required/resolved |

Adapters only translate native events. The shared gateway assigns v2 envelope
metadata, so Hermes and Bianbu cannot drift to different UI contracts.

## Live event transport

Bibit subscribes to an active Run over the Runtime's SSE stream
(`GET /api/v1/sessions/{session_id}/events/stream`), carrying the cursor it
already holds as `from_seq` and resuming with `Last-Event-ID` after a drop.
Frames are the same envelopes the REST endpoint returns, so event mapping and
gap recovery are unchanged.

Before a Run starts, the cursor comes from the Session watermark
(`/events?tail_only=true`) read before the prompt is submitted: the Runtime can
persist the Run's first deltas before the prompt response returns, and a cursor
taken afterwards would drop them. Adopting a Run that is already executing
seeds the cursor from the newest visible window instead, which is enough to
rebuild the in-flight answer without replaying the whole transcript.

Runtimes that do not have the stream route are polled incrementally at a fixed
short interval. `from_seq` and the stream are additive, so both paths share one
cursor semantic: "the next `seq` to read".

## Skill selection errors

Bianbu Runtime 的 Skill 选择沿用 Session prompt 的 `skill_ids` 字段；Bibit
不上传 `SKILL.md` 正文。Runtime 在 Run 内解析并安全处理 Skill instructions，
无法解析、被禁用或无法通过安全门禁时返回 `skill_unavailable`，并在
`details.skill_ids` 保留受影响的限定 ID。Bibit 的 HTTP adapter 和事件解析必须
保留该错误码及详情，并将其视为不可通过盲目重试解决的确定性失败。

## Canonical persisted turn

Runtime assistant messages persist `metadata.runtimeTurnV2` with
`schemaVersion: 2`, `runtimeId`, optional `runtimeEpoch`, and ordered `items`.
Each item has an explicit lane:

- `reasoning`, `tool`, `permission`, `diagnostic`: `work`
- `answer`: `answer`

Bibit renders all work items, in their original relative order, inside one work
timeline card. Answer items render below it. Tool input, progress, result and
errors are stored on the tool item. Reload uses this canonical turn first;
legacy v1 `ThreadContent`, `<think>` text and tool-call metadata remain readable.

Malformed v2 persisted data is rejected and falls back to the legacy reader.

## Gateway 状态锁不变式（2026-09-16 读会话超时）

现场：Bianbu Runtime 对每次请求都记 `200 OK`，Bibit 侧却固定 15s 后报「读取会话超时」；
重启 GUI 立刻恢复。可观测出来的因果链不在网络、也不在 Runtime，而在客户端自己：
状态锁被「投递到有界事件通道」这条会被背压卡住的路径占住，于是所有读会话一起排队。

三条不变式，违反任何一条都会把「一条流降级」放大成「整机读会话超时」：

1. **锁内不投递。** `RuntimeEventSink::emit` / `emit_session` 是同步调用，会把事件写进有界通道，
   通道满即阻塞。投递一律放在锁外：锁内只做活跃性判断与序号分配，是否落地状态由锁外的投递结果决定。
2. **锁内不 await。** `GatewayState` 用同步互斥（`ObservedMutex`），守卫不是 `Send`，
   「持锁跨 await」是编译错误而不是评审意见。driver 调用（HTTP / mux / 进程）必须在锁外。
3. **长持锁留痕。** 等待或持有超过 2s 记 `code=state_lock_wait` / `code=state_lock_hold`；
   30s 内出现过压力时，读超时文案改为「本机处理繁忙（状态锁排队）」，把自身拥塞和 Runtime 慢区分开。

回归测试：`runtime::gateway::tests::a_stalled_session_broadcast_never_holds_the_state_lock`
——让 `emit_session` 卡住，再断言状态锁仍可被获取（修复前该用例失败，已双向验证）。

故障注入：`BIBIT_FAULT_INJECT=state_hold_ms=60000` 在持锁期间注入停顿，用来在真机上复现
「全局锁被长期占用」；未设置时只是一次 map 查找。

已知取舍：`ObservedMutex` 用同步互斥，等待者不可被 tokio 超时抢占（临界区已是纯内存操作，
微秒级）。若将来出现真实占用竞争，升级路径是 `parking_lot`，或把状态收敛到单 owner task 的 actor 模型
（届时 `ControlState` / `DataState` 可分锁，`RuntimeIdentity` 已先行拆出）。
