# FileGrant 与异步 Job 开发指南

本文是插件实现“用户选择文件或保存位置，再由模块 Provider 异步处理”的公共开发契约。适用于 Agent、Skill、模型、知识包等传输场景，不规定任何模块的业务格式。

## 1. 何时使用

| 场景 | API |
| --- | --- |
| 小型、短时、纯 JSON 请求 | `service:<serviceId>.request(...)` |
| 用户选择上传文件或下载位置 | `file:transfer.select(...)` |
| Feature 自己产出的小体量导出文件 | `file:transfer.select(...)` 后接 `file:transfer.publish(...)`，不需要 Provider |
| 需要进度、取消、页面重进恢复或大文件处理 | `job:manage` + Provider Protocol v2 |

Feature 不得接收绝对路径、启动 CLI、拼接 argv、轮询日志或直接调用 Tauri。Host 拥有文件选择、staging、Provider 进程和最终发布；Feature 只持有 `grantId`、`jobId` 与安全元数据。

## 2. 接入前置条件

同一个功能必须同时满足四层契约：

1. Manifest 声明 `service:<serviceId>`、`file:transfer` 和 `job:manage`；
2. capability grant 批准这三项能力和精确 operation；
3. Provider Registry 注册 managed stdio Provider，并允许协议 v2；
4. Provider 在 `bibit.initialize` 中返回 v2、`jobs`、`cancellation` 和正整数 `maxConcurrentJobs`。

Manifest 示例：

```json
{
  "requiredHostCapabilities": [
    "service:store",
    "file:transfer",
    "job:manage"
  ]
}
```

系统 grant 示例：

```json
{
  "version": 1,
  "features": {
    "agent-hub": ["service:store", "file:transfer", "job:manage"]
  },
  "serviceOperations": {
    "agent-hub": {
      "store": ["agents.upload.v1", "agents.download.v1"]
    }
  }
}
```

Provider Registry 示例：

```json
{
  "version": 2,
  "services": {
    "store": {
      "transport": "stdio",
      "executable": "/usr/libexec/bibit/bibit-agenthub",
      "args": ["provider"],
      "lifecycle": "managed",
      "protocolVersions": [1, 2],
      "requestTimeoutMs": 30000
    }
  }
}
```

三处 capability、`serviceId` 或 operation 不一致时，Host 必须拒绝调用。Feature 不能通过降级到 `fetch` 或直接执行 CLI 绕过授权。

## 3. Feature 侧公共 API

获取能力：

```tsx
import { useFeatureCapability } from '@bibit/feature-sdk'

const store = useFeatureCapability('service:store')
const files = useFeatureCapability('file:transfer')
const jobs = useFeatureCapability('job:manage')
```

任一能力为 `undefined` 时显示当前 Feature 的局部不可用状态。开始传输前还应检查 Provider v2：

```ts
const availability = await jobs.availability('store')

if (!availability.available) {
  // provider_v2_unavailable: Provider 只支持 v1 短请求
  // provider_unavailable: Provider 当前不可用
}
```

### 3.1 上传

```ts
const grant = await files.select({
  version: 1,
  serviceId: 'store',
  operationId: 'agents.upload.v1',
  direction: 'upload',
  maxBytes: 256 * 1024 * 1024,
})

if (!grant) return // 用户取消原生文件选择，不显示错误

const idempotencyKey = globalThis.crypto.randomUUID()
const { job } = await jobs.start({
  version: 1,
  serviceId: 'store',
  operationId: 'agents.upload.v1',
  idempotencyKey,
  grantId: grant.grantId,
  input: { displayName: grant.displayName },
})
```

上传 Grant 会把用户选择的字节复制到 Host staging。Feature 只能看到展示名称、大小和过期时间，不能看到源路径。若 `jobs.start` 的结果不确定，重试同一启动意图时复用同一个 `idempotencyKey`；用户明确发起新的传输时再生成新 key。

### 3.2 下载

```ts
const grant = await files.select({
  version: 1,
  serviceId: 'store',
  operationId: 'agents.download.v1',
  direction: 'download',
  suggestedName: 'incident-helper.demo-agent',
})

if (!grant) return

const { job } = await jobs.start({
  version: 1,
  serviceId: 'store',
  operationId: 'agents.download.v1',
  idempotencyKey: globalThis.crypto.randomUUID(),
  grantId: grant.grantId,
  input: { agentId: 'incident-helper' },
})
```

下载 Provider 只向 Host 预建的相对 resource 写入字节。Host 校验相对路径、字节数和 SHA-256 后原子发布到用户选择的位置；Provider 和 Feature 都不能获得最终绝对路径。

### 3.3 小体量导出（Feature 产出字节）

Feature 自己就能产出的内容（例如设置页导出的 JSON）不需要 Provider，也不需要 `job:manage`：先按 §3.2 选好保存位置，再把字节交给宿主发布。

```ts
const files = useFeatureCapability('file:transfer')

const grant = await files.select({
  version: 1,
  serviceId: 'memory',
  operationId: 'privacy.export_data',
  direction: 'download',
  suggestedName: 'export.json',
})

if (!grant) return // 用户取消原生保存对话框，不显示错误

await files.publish({
  version: 1,
  grantId: grant.grantId,
  serviceId: 'memory',
  operationId: 'privacy.export_data',
  content: new TextEncoder().encode(JSON.stringify(payload, null, 2)),
})
```

宿主把内容写入暂存，核对自己算出的长度与 SHA-256，核对通过才原子替换用户选定的文件；失败时清理暂存并返回错误，目标位置不会留下半成品。`select` 与 `publish` 都必须带上同一个 `serviceId` 与 `operationId`，否则四层授权校验会拒绝。能力缺失时 Feature 应显示局部不可用状态或保留自身回退路径，不得改用 `fetch` 或直接 Tauri 调用。

### 3.4 公共 DTO 速查

| DTO | 必填字段 | 可选字段 / 返回值 |
| --- | --- | --- |
| `FileGrantRequestV1` | `version`、`serviceId`、`operationId`、`direction` | `suggestedName`、`maxBytes` |
| `FileGrantV1` | `version`、`grantId`、`direction`、`displayName`、`expiresAt` | 上传时可返回 `byteLength`；永远不返回路径 |
| `ServiceJobStartRequestV1` | `version`、`serviceId`、`operationId`、`idempotencyKey`、`grantId`、`input` | 无 |
| `ServiceJobStartResultV1` | `version`、`job` | `job` 是当前 `ServiceJobSnapshotV1` |
| `ServiceJobSubscriptionV1` | `version`、`jobId`、`afterSequence` | 无 |
| `ServiceJobEventBatchV1` | `snapshot`、`events`、`hasGap` | 有缺口时以 `snapshot` 为准 |
| `ServiceJobCancelRequestV1` | `version`、`jobId` | 返回更新后的 `ServiceJobSnapshotV1` |

`ServiceJobSnapshotV1` 固定包含 `version`、`jobId`、`owner.featureId`、`serviceId`、`operationId`、`idempotencyKey`、`status` 和 `lastSequence`，按状态附带 `progress`、`result` 或安全的 `error`。正式类型以 `@bibit/feature-contracts` 导出为准；插件不得复制一份私有类型再自行扩展字段。

## 4. 订阅、恢复与取消

Job 状态固定为：

```text
queued -> running -> finalizing -> succeeded
                  -> cancel_requested -> cancelled
                  -> failed
```

终态只有 `succeeded`、`failed`、`cancelled`。每个 Job 最多产生一个终态。

订阅从当前快照的 `lastSequence` 开始：

```ts
const unsubscribe = jobs.subscribe(
  {
    version: 1,
    jobId: job.jobId,
    afterSequence: job.lastSequence,
  },
  ({ snapshot, events, hasGap }) => {
    setJob(snapshot)
    if (hasGap) {
      // 事件窗口存在缺口，以 snapshot 为权威状态重绘，不重放副作用。
    }
  }
)

return unsubscribe
```

组件卸载只调用 `unsubscribe`，不得自动取消 Job。只有用户执行明确的取消动作时调用：

```ts
const snapshot = await jobs.cancel({ version: 1, jobId: job.jobId })
setJob(snapshot)
```

页面挂载时恢复当前 Feature instance 的 Job：

```ts
const history = await jobs.list('store')
const active = history.find((item) =>
  !['succeeded', 'failed', 'cancelled'].includes(item.status)
)
const restored = active ?? history.at(-1)
```

Job 当前只保证在同一 Bibit 进程和同一 Feature instance 内恢复。插件停用、重新激活或版本切换会轮换 instance token，Host 会取消并清理旧 instance 的任务和 Grant；不要把它描述成跨应用重启的持久队列。

### 4.1 崩溃与重启清理

Job 创建成功后，Host 会立即把 `featureId`、`featureInstanceId`、`serviceId`、`jobId` 和受校验的 staging 相对目录写入 `plugins/cleanup-ledger.json`。这不是可恢复执行队列，也不保存输入、结果或业务状态。

Bibit 下次启动时先读取 ledger，按 service 建立受控 Provider v2 会话，再向仍可达的 Provider 发送一次取消请求，并删除该 Job 的本地 staging 目录。两者都成功后删除 ledger 条目；Provider 不可用、取消失败、旧 ledger 缺少 staging 句柄、路径校验失败或本地删除失败时保留条目并显示 `rejected`/cleanup pending，下一次启动继续重试。未登记的残留 staging 只能在 ledger 处理之后清理：扫描只递归 `providers/<service>/transfers` 下的非符号链接目录，保留 ledger 精确拥有的 Job 根目录及其内容，同时删除同一 Feature 下未登记的 Job 目录。恢复过程不会重放、续跑或自动发布业务 Job。

停用、升级和回滚在 Provider 尚未确认取消时不会删除 Host Job/Grant；迟到的 Provider 终态用于完成回收，避免把单个旧实例的迟到事件误判为整个 Provider 协议错误。

停用、升级、回滚和正常终态会同步清理 Grant、Job、staging 与 ledger。ledger 只接受 `providers/<service>/transfers` 下的相对目录，拒绝绝对路径、`..`、符号链接和跨服务路径。

## 5. 并发、重试与错误

- Provider 必须声明 `maxConcurrentJobs`；AgentHub 示例为 1。
- 同一 Feature/Service 已有活跃 Job 时，内部 Registry 拒绝新建任务，公开 API 返回 `resource_exhausted`；UI 应先用 `jobs.list(serviceId)` 恢复已有活跃快照，不建立隐藏队列。
- `failed` 后的用户重试是新传输：重新选择 Grant，并生成新的 idempotency key。
- 启动响应丢失等不确定结果才复用原 key，以取回同一 Job。
- `provider_v2_unavailable` 只禁用异步传输；Provider v1 的列表、设置等短请求仍可继续。
- 页面不得无限自动重试。`unauthorized`、`incompatible` 和资源上限错误需要用户或部署修复。

公共错误码及 UI 行为见 [Host capabilities](./host-capabilities.md#错误契约)。Job 自身的 `snapshot.error` 是安全错误 DTO，不显示 Provider stderr、路径或原始请求体。

### 5.1 排查顺序

1. `useFeatureCapability(...)` 为 `undefined`：依次核对 Manifest、capability grant 和 Feature id。
2. `unauthorized`：核对 `serviceOperations` 中的 service/operation allowlist，不要改成直接 `fetch`。
3. `provider_unavailable`：核对 Provider Registry、固定 executable、权限和 stderr。
4. `provider_v2_unavailable`：核对 Registry 的 `protocolVersions`，以及 initialize 返回的 v2、`jobs`、`cancellation`、`maxConcurrentJobs`。
5. `resource_exhausted`：先用 `jobs.list(serviceId)` 恢复活跃 Job，再检查 Grant、文件、staging 和 Provider 存储上限。
6. 进度停滞或下载失败：按 `diagnosticId` 关联 Host/Provider 日志，核对 sequence、resourcePath、字节数和 SHA-256；不要把 stderr 原文展示给用户。

## 6. Dev Host Mock

`FeatureDevHost` 的 `serviceMocks/serviceConnections` 只自动创建 Service request API。使用 FileGrant/Job 的插件必须像 AgentHub 示例一样显式注入完整 `hostApi`：

```tsx
<FeatureDevHost manifest={manifest} module={featureModule} hostApi={hostApi} />
```

Mock 至少实现：

- `file:transfer.select` 的用户取消、upload metadata 和 download metadata；
- `job:manage.availability/start/list/get/events/subscribe/cancel`；
- running、progress、succeeded、failed、cancelled；
- 页面卸载后 Job 继续、重新挂载后通过 `list` 恢复；
- capability 缺失和 Provider v2 不可用状态。

浏览器 Mock 不读取真实文件、不启动 Provider、不创建下载文件，也不证明 Tauri command、staging、路径隔离或原子发布有效。真实文件传输必须在 Tauri Debug Bibit 中验收。

## 7. Provider Protocol v2

Provider 使用 UTF-8 NDJSON；stdout 只能输出 JSON-RPC 2.0，日志写 stderr。初始化必须返回：

```json
{"jsonrpc":"2.0","id":"session:initialize","result":{"protocolVersion":2,"providerVersion":"1.0.0","capabilities":{"invoke":true,"jobs":true,"cancellation":true,"maxConcurrentJobs":1},"operations":["agents.upload.v1","agents.download.v1"]}}
```

Host 发送 `bibit.job.start` 后，Provider 必须立即返回 accepted，并由后台 worker 执行。主读循环在 Job 运行期间继续处理 `bibit.invoke`、`bibit.job.cancel` 和 `bibit.shutdown`。

Provider notification 使用严格递增的 `providerSequence`：

```json
{"jsonrpc":"2.0","method":"bibit.jobEvent","params":{"serviceId":"store","jobId":"<jobId>","providerSequence":1,"kind":"progress","progress":{"completedBytes":65536,"totalBytes":1048576}}}
```

下载完成提议示例：

```json
{"jsonrpc":"2.0","method":"bibit.jobEvent","params":{"serviceId":"store","jobId":"<jobId>","providerSequence":2,"kind":"result_ready","result":{"output":{"agentId":"demo","bytes":128,"sha256":"<sha256>"},"resource":{"resourcePath":"transfers/agent-hub/<random>/output.bin","byteLength":128,"sha256":"<sha256>"}}}}
```

`result_ready` 不是公开终态。只有 Host 完成资源校验和发布后，Feature 才看到 `succeeded`。完整 initialize、cancel、failed 和资源边界见 [Service Provider Framework](./provider-framework.md#provider-protocol-v2-jobs)。

## 8. 固定资源限制

| 限制 | v1 值 |
| --- | --- |
| 每个 Feature/Service 活跃 Grant | 4 |
| 单文件 | 256 MiB |
| 每个 Feature/Service staging | 512 MiB |
| Provider 持久包总量 | 512 MiB |
| 每个 Job 事件 | 256 |
| progress 对 UI 转发 | 10 Hz |

超限返回 `resource_exhausted`。Feature 不得通过切片隐藏文件、拆分并行 Job 或转用 Service JSON 请求绕过限制；需要更大上限时必须作为平台安全边界变更评审。

## 9. 提交与验收清单

模块前端：

- Manifest、grant、Registry 与 operation 完全一致；
- capability 缺失、Provider v2 不可用和用户取消选择都有局部 UI；
- 上传、下载、进度、失败、重试、显式取消和页面重进恢复有组件测试；
- Dev Host Mock 与生产 DTO 一致，但结论明确标记为 Mock；
- 插件不导入 Bibit 私有源码、不直接执行 CLI、不接触路径。

Provider：

- initialize 协商 v1/v2，声明 operation、jobs、cancellation 和并发限制；
- 主读循环与 Job worker 分离；取消后仍可处理短请求；
- resourcePath 只相对 `BIBIT_PROVIDER_DATA_DIR`，拒绝绝对路径、`..`、反斜杠和符号链接跳转；
- stdout 无日志污染，stderr 和诊断无路径、凭据或完整 payload；
- 自检覆盖上传、下载、SHA-256、取消和容量错误。

Tauri Debug Bibit：

- 记录 Bibit/插件/Provider 固定版本、bundle hash、key id、Registry 和 grant 摘要；
- 真实上传和下载的源、Provider package、目标 SHA-256 一致；
- 取消只有一个终态，目标无半成品，staging 已清理；
- 页面重进恢复同一 Job，其他页面和会话不受阻塞；
- 插件停用或 instance 轮换会回收所属 Job 与 Grant。

只通过 Dev Host、Provider 自检、进程存在或插件入口可见，都不能替代真实 Tauri 端到端验收。
