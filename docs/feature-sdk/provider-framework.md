# Bibit Service Provider Framework

本文定义 Feature 插件访问模块能力时的平台边界。Feature 只依赖领域 Service API；HTTP、CLI、Unix Socket 等实现由 Bibit Provider Broker 选择，不能进入插件业务代码。

## 1. 分层

```text
Feature Plugin
  -> service:<serviceId> Host capability
  -> Provider Broker（授权、路由、版本、生命周期、限制、诊断）
  -> HTTP / stdio one-shot / stdio managed（后续可增加 Unix Socket）
  -> 模块 Provider
```

SDK v1 的 `external-service:*` 是兼容别名。新插件使用 `service:store`、`service:memory` 或 `service:security`；两种名称在兼容期指向同一个 Host API 实例。

`serviceId` 不是三项枚举。它使用与 Feature ID 相同的稳定 kebab-case 格式，最长 64 字符，例如 `store`、`security`、`knowledge-index`。新增服务时无需修改 SDK 或重编 Bibit，只需同时提供：插件 Manifest 的 `service:<serviceId>`、系统 grant drop-in 中的 operation allowlist，以及 Provider Registry drop-in。旧 `external-service:*` 只为 `store/memory/security` 保留，不再扩展。

## 2. Registry

HTTP v1 配置继续有效：

```json
{"version":1,"services":{"store":{"baseUrl":"http://127.0.0.1:18081","requestTimeoutMs":30000}}}
```

CLI 使用 Registry v2：

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

生产 drop-in 安装到 `/etc/bibit/external-services.d/<module>.json`。`executable` 必须是绝对路径；Broker 使用直接进程启动，不经过 Shell。插件不能传递 executable、argv、环境变量、工作目录、URL 或凭据。

连接配置可声明按 operation 限定的业务参数策略，由 Native Broker 在派发到 HTTP 或 stdio Provider 前验证：

- `credentialParameters`：例如 `{"providers.create.v1":["api_key"]}`，仅允许该操作的顶层字符串字段。字段名限于 `api_key`、`apiKey`、`token`、`password`、`secret`；嵌套凭据仍拒绝。
- `businessObjectParameters`：例如 `{"agents.create.v1":["/permissions/resource_limits/tokens"],"agents.update.v1":["/permissions/resource_limits/tokens"]}`，仅允许精确路径处的 `tokens` 对象。其他操作、服务和路径不继承授权，且对象内部继续递归检查，不能包含 token、api_key、password、headers 等字段。

前端 Gateway 只验证业务参数的对象形状，将业务字段交给已安装的连接策略；普通本地 handler 保持原有字段限制。这些声明不授权插件设置 HTTP 认证或请求头，也不替代 service operation capability 授权。

独立插件的授权安装到 `/etc/bibit/feature-capability-grants.d/<module>.json`：

```json
{
  "version": 1,
  "features": {
    "agent-hub": ["service:store", "file:transfer", "job:manage"]
  },
  "serviceOperations": {
    "agent-hub": {
      "store": [
        "agents.list.v1",
        "agents.upload.v1",
        "agents.download.v1",
        "settings.get.v1",
        "settings.update.v1"
      ]
    }
  }
}
```

该文件由系统包管理器维护，不能由插件 JavaScript 或普通用户目录生成。Bibit 启动时合并合法系统文件；格式错误、未知 capability、operation 越权或重复项会使该文件整体失效并记录诊断，不影响其他 drop-in。

Debug 构建可用 `BIBIT_FEATURE_CAPABILITY_GRANTS_DIR=/absolute/dev/grants.d` 指向开发目录；Release 构建忽略该环境变量，只读取系统目录。授权在 Bibit 启动阶段装载，修改后需要重启应用。

生命周期选择：

- `oneShot`：每次请求启动新进程，完成 `initialize + invoke` 后退出；适合低频、无启动成本的只读 CLI。
- `managed`：每个 `serviceId` 保持一个进程，初始化一次后串行处理多个 invoke；适合频繁调用、需要缓存或持久连接的 CLI。进程崩溃或配置变化后由 Broker 在下一次请求重建。

## 3. Bibit Provider Protocol v1

stdio 使用 UTF-8 NDJSON，每行一个 JSON-RPC 2.0 消息。stdout 只传协议消息，普通日志写 stderr。

每个会话先调用 `bibit.initialize`：

```json
{"jsonrpc":"2.0","id":"request-id:initialize","method":"bibit.initialize","params":{"protocolName":"bibit-provider","supportedProtocolVersions":[1],"serviceId":"store","client":{"name":"Bibit"}}}
```

Provider 返回协商版本、Provider 版本、能力和 operation：

```json
{"jsonrpc":"2.0","id":"request-id:initialize","result":{"protocolVersion":1,"providerVersion":"1.0.0","capabilities":{"invoke":true},"operations":["agents.list.v1"]}}
```

调用使用 `bibit.invoke`：

```json
{"jsonrpc":"2.0","id":"request-id","method":"bibit.invoke","params":{"serviceId":"store","operationId":"agents.list.v1","params":{},"timeoutMs":30000}}
```

成功响应的 `result` 是 operation DTO。失败使用 JSON-RPC error，稳定错误码放在 `error.data.code`；Broker 只向插件暴露允许的错误码，不转发 Provider 堆栈和原始 stderr。

## 4. 生命周期与扩展契约

### Provider Protocol v2 jobs

v2 是 v1 的并行协议版本，不改变 v1 的 `initialize + invoke` 串行语义。Host 在 initialize 中发送 `supportedProtocolVersions: [1, 2]`；只有 Provider 返回下列能力时才启用异步传输：

```json
{"jsonrpc":"2.0","id":"request-id:initialize","result":{"protocolVersion":2,"providerVersion":"1.0.0","capabilities":{"invoke":true,"jobs":true,"cancellation":true,"maxConcurrentJobs":1},"operations":["agents.list.v1","agents.upload.v1","agents.download.v1"]}}
```

Host 使用 `bibit.job.start` 立即交付稳定 `jobId`、版本化 operation、窄业务输入和 Provider 数据目录下的相对 resource；Provider 立即确认接收，后台 worker 再执行传输。主 NDJSON 读循环必须在 worker 运行期间继续响应 `bibit.invoke`、`bibit.job.cancel` 和 `bibit.shutdown`。

Provider 通过 JSON-RPC notification 报告 `progress`、`result_ready`、`cancelled` 或 `failed`，并附带仅在 Provider channel 内使用的单调 `providerSequence`。Host 负责去重、拒绝乱序并为 Web 事件重新分配全局于该 Job 的 sequence。`result_ready` 不是终态授权：Host 完成 staging 校验、入库或原子发布后，Job Registry 才能写入 `succeeded`。

每个 v2 Provider 必须声明正整数 `maxConcurrentJobs`。AgentHub Demo 固定为 1；同一 Feature/Service 已有活跃传输时，Host 返回 `busy` 和现有 Job 快照，不建立用户可见队列。Provider 不得收到原始选择路径，文件仅通过其数据目录内的相对 resource 交接。

| 能力 | 协议位置 | 平台状态 |
| --- | --- | --- |
| HTTP request/response | `/bibit/v1/invoke` | 已实现 |
| stdio one-shot | `initialize` + `invoke` + 退出 | 已实现 |
| stdio managed | 单进程多请求、崩溃重启、`shutdown` | 已实现；v1 按服务串行调用 |
| cancellation | HTTP 中断；managed 发送 `bibit.cancel` 后回收会话 | 已实现 |
| progress/events | v2 JSON-RPC notification | 已实现；Host 去重、限频并分配公开 sequence |
| managed jobs | v2 `bibit.job.start/cancel`，Host 提供 get/list/events/subscribe/cancel | 已实现；v1 不变 |
| file access | opaque FileGrant + Provider 相对 resource | 已实现；Host 管理选择、staging、校验和发布 |

后三项已经作为通用 Host 原语实现，Feature 侧公共用法见 [FileGrant 与异步 Job 开发指南](./file-transfer-and-jobs.md)。它们继续共享 Provider Protocol 和 Service API，不得另建 AgentHub 专用 Tauri command。需要扩大并发或改变实时通知语义时提升 Provider Protocol 版本，在初始化能力中协商，不能悄悄改变 v1 的串行语义。

扩展遵循以下分级，避免平台核心被业务模块反复修改：

- 新增领域或 operation：新增 `service:<serviceId>`、operation DTO、grant 和 Registry，不修改 SDK 公共类型；
- 新增通用宿主原语：例如事件订阅、后台任务或文件授权，先增加 Feature SDK API 与 Host 实现，再由 Provider 初始化能力协商支持；
- 改变传输时序或并发语义：发布新的 Provider Protocol major，Broker 同时保留旧版本 Driver；
- 删除或收紧既有行为：经过弃用周期发布 SDK major，不能通过 Registry 配置静默改变现有插件语义。

因此，动态 Service 命名空间负责业务横向扩展，版本协商负责协议纵向扩展；二者不能互相替代。

## 5. 授权与错误

授权粒度为 `Feature ID + serviceId + operationId`。Manifest 先声明 capability，内置 grant 或系统 grant drop-in 再批准 capability 和 operation；未批准的 operation 不进入 Tauri Gateway。

平台错误包括 `cancelled`、`offline`、`timeout`、`unauthorized`、`incompatible`、`unavailable`、`provider_crashed`、`resource_exhausted` 和 `unknown`。领域错误由各 operation DTO 定义，不能伪装成平台错误。

## 6. 资源和进程边界

- 请求最大 1 MiB，响应最大 4 MiB；
- 默认超时 30 秒，最大 300 秒；
- stdio Provider 继承空环境，仅获得 `LANG`、`BIBIT_PROVIDER_PROTOCOL` 和模块数据目录；
- 非零退出映射为 `provider_crashed`，非法协商或响应映射为 `incompatible`；
- 超时后 Broker 终止子进程；managed 模式必须支持显式 shutdown 和崩溃重启；
- Bibit 退出时向 managed Provider 发送 `bibit.shutdown`，等待短暂退出窗口后强制回收；
- 上传下载不得在 DTO 中传任意绝对路径，必须使用 FileGrant。
- 每个 Feature/Service 最多 4 个活跃 Grant；单文件 256 MiB，累计 staging 512 MiB；Provider 持久包总量 512 MiB；每个 Job 最多 256 个事件，progress 对 UI 最多 10 Hz。
- stdout、Web DTO 和诊断只能包含 feature/service/operation/grant/job/provider 标识、状态、字节数与摘要；原始路径、文件内容、凭据和完整请求体不得记录。

## 7. 独立部署

推荐拆分为 `bibit`、前端插件包和模块 Provider/CLI 包。模块 deb 拥有 executable、Provider Registry drop-in 和 capability grant drop-in，插件构建只拥有签名 bundle。双方通过 Service、Provider Protocol 和 operation 版本兼容，不通过源码或安装路径耦合。
