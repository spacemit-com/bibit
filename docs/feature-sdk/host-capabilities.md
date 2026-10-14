# Host capabilities

Host capability 是 Feature 访问 Bibit/外部系统能力的唯一公开入口。它不是安全沙箱：Feature 是同仓可信代码；该机制用于最小权限 API、统一连接治理、可测试性和代码审计。

## 四层授权

Feature 只有同时满足以下四项才会获得敏感 Native 能力：

1. Manifest 在 `requiredHostCapabilities` 中声明；
2. 内置 `config/feature-capability-grants.json` 或系统 `/etc/bibit/feature-capability-grants.d/*.json` 对该 Feature 显式 grant；
3. 当前 target 的宿主注册了能力实现。
4. 当前进程存在由 Native 签发、版本匹配且仍有效的 Feature instance。

任何一项缺失时，`useFeatureCapability(capability)` 返回 `undefined`。Feature 必须显示局部不可用状态，不能回退到 `fetch`、`window.core`、ServiceHub 或直接 Tauri 调用。

内置 grant 随 Bibit 发布，并由 Web Host 与 Native 从同一份 `config/feature-capability-grants.json` 读取；独立模块使用系统 drop-in，并由模块 deb 安装。Bibit 启动时按文件名顺序读取、校验并合并合法文件，单个损坏文件不会阻止其他模块加载；合并结果在当前进程中保持不可变，request/cancel 只读取内存快照，不在授权热路径访问文件系统。系统 drop-in 只增加授权，不覆盖或撤销内置授权；新增、修改或撤销独立模块授权后必须重启 Bibit。

## Feature instance 与 bootstrap

公司签名插件通过验签、文件哈希、Manifest 和兼容检查后，Native 先创建 Feature instance。`trusted_plugin_prepare_active` 在应用启动或 WebView 重新加载时冻结 Registry 并轮换 instance；设置页只调用无状态迁移副作用的 `trusted_plugin_list_active`。两个命令以及安装、激活返回的 descriptor 都不包含 token；Host 必须在任何插件代码执行前调用一次 `trusted_plugin_bootstrap`，核对返回的 Feature id 与版本后，才把不透明 token 保存在该 Registry entry 的 Host 闭包中。bootstrap 对同一 instance 只能消费一次，插件代码加载后不能通过 descriptor/list 再次枚举 token。

编译期 Feature 只有在生产 Registry 声明 Service、FileGrant 或 Job 能力，且同时位于 Native 构建期静态 Manifest allowlist 时，才由 `static_feature_bootstrap` 签发进程级 instance。未登记的静态 Feature 不能通过自报 id、版本或 capability 获得 token；bootstrap 失败时宿主会移除该敏感 entry，不暴露一个必然被 Native 拒绝的半可用页面。当前生产编译期 Registry 为空；首次加入敏感内置 Feature 时必须同时更新 Native allowlist，并为这两份输入补充机器一致性门禁。

instance token 是可信同 WebView 模型下的误调用隔离和审计关联值，不是抵御恶意已签代码的沙箱凭据。同一 WebView 中的恶意代码仍可能观察或干扰其他模块；若威胁模型要求抵御它，必须使用独立 WebView 或进程隔离。

## v1 capability 命名空间

下表是当前平台允许声明的访问类别，不是各模块必须使用的能力，也不定义模块业务范围。规范 capability 与兼容别名见 [Feature Platform 兼容矩阵](./compatibility-matrix.md)。

| capability | 接入语义 | v1 状态 |
| --- | --- | --- |
| `service:<serviceId>` | 通过 Provider Broker 访问已授权模块服务 | request API；支持动态 serviceId |
| `external-service:store/memory/security` | 旧插件兼容别名 | 支持既有插件，不再扩展 |
| `runtime:permission` | Runtime 权限往返的声明专用项；只用于 Manifest 治理和 grant 审计 | 声明专用：宿主不实现可调用入口，`getCapability('runtime:permission')` 始终返回 `undefined` |
| `file:transfer` | 请求原生文件选择并获得不透明 `grantId`；下载方向还可把 Feature 提供的字节交给宿主发布 | v1 合同；由宿主管理路径、暂存和发布 |
| `job:manage` | 启动、查询、订阅和取消当前 Feature 的异步任务 | v1 合同；启动时仍须持有目标 `service:<serviceId>` |
| `host:actions` | 请求宿主执行跨 Feature 的动作（新建会话、交接上下文） | v1 合同；只有登记动作可用，统一返回 `completed`/`cancelled`/`rejected` |

三个 `external-service:store/memory/security` 别名长期映射到对应 `service:*`，既有插件无需迁移。别名不会降低 Native instance、capability 和精确 operation grant 校验；新 Service 不得新增 `external-service:*` 别名。

`file:transfer` 和 `job:manage` 是通用宿主原语，不代表任意文件或进程权限。Feature 不能取得绝对路径，也不能选择 executable、argv 或工作目录。每个 FileGrant 绑定 Feature id、插件版本、Feature instance、Service、operation、方向、大小、过期时间和单次消费状态；`job:manage` 的 Native envelope 同样校验插件版本，并且只允许访问同一 Feature instance 创建的任务。

下载方向的 `file:transfer` 有两种发布方式：小体量内容由 Feature 直接发布（`publish`），字节先进入宿主暂存，宿主核对长度与 SHA-256 后原子写入用户选定的位置；需要进度、取消、断点恢复或大文件时仍走 `job:manage` 与 Provider Protocol v2。两种方式都单次消费同一个 Grant，失败时清理暂存且不留下半成品文件。

公开 FileGrant 只包含 `grantId`、方向、展示名称、安全大小元数据和过期时间。平台固定限制为每个 Feature/Service 最多 4 个未过期 Grant、单文件 256 MiB、累计 staging 512 MiB。Provider 收到的文件定位符必须相对其数据目录，绝对路径、父目录跳转和反斜杠路径均无效。

异步任务状态固定为 `queued`、`running`、`finalizing`、`cancel_requested`、`succeeded`、`failed`、`cancelled`。Host 为 Web 可见事件分配单调递增 sequence，并保证最多一个终态；页面卸载只解除订阅，不取消任务。任务进程内保留，每个任务最多 256 个事件，progress 最多向 UI 转发 10 次/秒。

Feature 侧的上传、下载、订阅、恢复、取消代码和 Dev Host Mock 要求见 [FileGrant 与异步 Job 开发指南](./file-transfer-and-jobs.md)。

外部服务调用只接受窄 DTO：

```ts
service.request({
  serviceId: 'store',
  operationId: 'agents.list.v1',
  params: { query: 'writer' },
  timeoutMs: 10_000,
  signal: abortController.signal,
})
```

Feature 不传 URL、header、cookie、token、API key 或 credential。鉴权、服务发现、网络策略和敏感日志清理由宿主 adapter 负责。参数树出现运输层敏感字段时请求会以 `incompatible` 拒绝。

上述 TypeScript API 不是最终授权边界。Host 内部调用 Native 时会附加 `featureId`、Manifest `version`（内部字段名 `pluginVersion`）、`featureInstanceToken`、`serviceId`、`operationId` 和 `requestId`；这些身份字段不会转发给 Provider。Native 在读取 Provider Registry 或建立 Provider 连接之前依次校验：

1. 调用来自主窗口；
2. Feature id、版本和 token 对应当前有效 instance；
3. instance 的已验证 Manifest 声明规范 `service:<id>`，或声明平台明确映射的 `external-service:store/memory/security` 兼容别名；
4. Native 合并后的系统 grant 同时批准 capability 和精确 `operationId`。

任一校验失败时 request 返回标准 `unauthorized` gateway envelope，Provider 不会收到请求。兼容别名仍必须同时具备对应 `service:<id>` 与同一 operation grant，不形成旁路。

活动 request 以 `(featureId, pluginVersion, featureInstanceToken, requestId)` 作为 owner key，并额外记录 Service 与 operation。cancel 必须携带与原请求相同的六项身份；不同 Feature、不同 token、旧版本、错误 Service 或错误 operation 都不能取消该请求。两个 Feature 可以安全地同时使用相同 `requestId`。Feature instance 停用或轮换时，Host 会取消该 owner 的活动 request，并继续回收其 FileGrant 与 Job。

AgentHub Demo 的版本化传输 operation 固定为 `agents.upload.v1` 和 `agents.download.v1`。上传结果仅含 Agent 标识、展示名称、字节数和 SHA-256；下载结果仅含 Agent 标识、字节数和 SHA-256，不含任何路径。不同业务模块应定义自己的版本化 operation，不能复用这两个 AgentHub operation 表达其他语义。

## 宿主动作（host:actions）

`service:*` 表达"访问某个模块的数据"，`host:actions` 表达"请宿主做一件事"。跨 Feature 的行为——打开会话、跳到宿主界面、把一段上下文交给另一个作用域——走这里；不要塞进 Feature 内导航，也不要为某个具体插件加宿主特判。

动作是**登记过的稳定 ID + 显式输入**，不是自由 `invoke(anything, payload)`。v1 登记的动作：

| action | input | 语义 |
| --- | --- | --- |
| `conversation.create` | `{ target?: FeatureResourceRefV1 }` | 新建一个会话，可绑定目标（例如某个 Runtime 专家），随后进入该会话 |
| `conversation.compose` | `{ target?: FeatureResourceRefV1; skills?: FeatureResourceRefV1[]; prompt?: string }` | 新建一个会话并预置内容（专家、临时技能、草稿文本），**从不发送**；草稿留在输入框里，等用户自己编辑后发送 |

`conversation.compose` 的两个保证写在动作语义里，调用方不需要猜：**一定新建会话**，**一定不发送**。预置的技能等同于用户手点“临时使用技能”，预置文本等同于用户自己敲进去的草稿，两者用户都能改。

```ts
type FeatureResourceRefV1 = { namespace: string; type: string; id: string }

type FeatureHostActionResultV1 =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | {
      status: 'rejected'
      error: {
        code: 'NOT_GRANTED' | 'UNSUPPORTED' | 'INVALID_INPUT' | 'FAILED'
        message: string
        retryable?: boolean
      }
    }

await host.getCapability('host:actions')?.invoke('conversation.create', {
  target: { namespace: 'runtime', type: 'agent', id: expertId },
})

// 带着技能和草稿开一个新会话：用户接手继续写，发送由用户决定。
await host.getCapability('host:actions')?.invoke('conversation.compose', {
  skills: [{ namespace: 'runtime', type: 'skill', id: skillId }],
  prompt: '把下面的需求拆成可执行的步骤：',
})
```

约定：

- **`conversation.compose` 的输入边界**：`skills` 只接受 `{ namespace: 'runtime', type: 'skill' }`，去重后最多 100 个（对齐 Runtime 的 `skill_ids`）；`prompt` 最多 16 000 字符（对齐宿主既有输入通道），空白文本按未提供处理。技能必须存在且可分配，否则整次调用按 `INVALID_INPUT` 拒绝，不写任何状态。
- **预置不覆盖用户正在写的东西**。首页新会话的草稿只活在内存里，覆盖即永久丢失，所以此时 `conversation.compose` 返回 `rejected(FAILED, retryable: true)`，调用方要提示用户先清空输入框，不要自动重试。会话内的草稿按会话落盘，覆盖后切回仍能恢复，因此不拦。
- **上下文用不透明资源引用传递**。Feature 只给出 `namespace/type/id`，不传宿主路由、绝对路径或另一个插件的内部标识；解析、可用性校验和路由由宿主负责。Runtime 目标形如 `{ namespace: 'runtime', type: 'agent', id }`：提供方不需要理解它的含义，也不需要知道宿主最终落在哪个页面。
- **结果必须结构化处理**。调用方要区分 `completed`、`cancelled` 与 `rejected` 并给出对应用户反馈；`rejected.code` 区分未授权、不支持、输入非法和宿主失败，`message` 可以展示。不要 fire-and-forget。
- **动作语义不交给调用方猜**。`conversation.create` 一定新建会话，宿主不得解释成复用已有会话；反过来，Feature 也不能靠动作 ID 推断宿主的页面结构。
- **不作为插件间 IPC**。不要用 localStorage、URL query 或宿主存储键在插件之间传状态；写入、消费、过期和清理的交接生命周期由宿主统一持有。
- **能力缺失即降级**。`getCapability('host:actions')` 返回 `undefined`，或某个动作返回 `UNSUPPORTED`，都只禁用对应入口并说明原因；不伪造动作结果，也不自行改走 Tauri 命令。

新增动作的要求：在 `FeatureHostActionRegistryV1` 登记 action id 与输入类型，在宿主实现，并按需补授权。未知 action、未知资源类型和非法输入必须在写入任何状态或导航**之前**返回 `rejected`。审查问题见文末清单。

## operation 与 DTO 版本

capability 只表达访问类别；模块自行定义在该类别下消费的 `operationId` 及 DTO，平台不规定 operation 集合。

- `operationId` 必须稳定且可审查，不得包含 URL、command 或凭据；兼容修改沿用原 ID。
- **规范名不带发布后缀**：新 operation 写 `agents.list`，不写 `agents.list.v1`。`.v1`、`.v12` 这类后缀按**别名**处理——请求、grant 校验、connection 的 credential/business-object 策略和前端 grant 过滤都按规范名比较，两侧拼写不同不影响匹配。
- 语义发生破坏性变化时**新增 operation 或新增 capability**，不要原地改写旧名。后缀只被当别名，不再表达版本，所以不能用它区分语义变化。
- 例外：managed provider 会回写它自己声明的拼写，因此 provider 声明 `agents.list.v1`、调用方请求 `agents.list` 时仍能匹配；one-shot provider 的 initialize 与 invoke 在同一次写入中发出，宿主读到声明时请求已经写出，**仍要求精确拼写**。
- 插件 SemVer、`pluginSchemaVersion`、`manifestSchemaVersion`、`sdkApiVersion` 以及 bundle 与签名的解析版本继续保留；被取消的只是业务接口名里的后缀。
- DTO 类型名携带版本后缀。新增可选字段且旧消费者行为不变可保持版本；删除、重命名、收紧输入或改变错误语义必须升级。
- adapter 必须校验已声明 operation 的请求和响应；未知 operation 返回 `incompatible`，不得静默转发或伪造空数据。

## 错误契约

外部错误被映射为 `FeatureServiceErrorV1`：

| code | 含义 | 一般是否可重试 |
| --- | --- | --- |
| `offline` | 服务或网络离线 | 是 |
| `timeout` | 超过调用时限 | 是 |
| `cancelled` | 调用方主动取消 | 否 |
| `unauthorized` | 服务拒绝授权 | 否；引导重新认证 |
| `incompatible` | operation/DTO/服务版本不兼容 | 否；需要升级 |
| `unavailable` | 服务临时不可用 | 是 |
| `provider_crashed` | Provider 进程异常退出 | 是 |
| `resource_exhausted` | 请求或响应超过平台限制 | 否 |
| `unknown` | 未分类失败 | 谨慎处理 |

UI 可以显示安全的 `message` 和 Retry；`diagnosticId` 用于关联宿主日志。不要把原始异常、服务地址、headers 或凭据放入用户界面或 Feature 日志。

## 权限 presenter

安全 Feature 只控制审批布局和显式交互，通过公开的 `{ request, viewState, surface, decide }` props 返回决定。`decide` 是异步调用并返回结构化 receipt；Feature 必须呈现 submitting/error/resolved 状态，但不能自行恢复 Runtime。宿主负责：

- 使用完整 Runtime identity 幂等解析决定；
- 在 presenter 加载/渲染失败时提供 Builtin fallback；
- 以 Runtime `expiresAt` 和后端终态为授权时钟，普通组件卸载或切换会话不产生决定；
- 仅允许主窗口提交决定，其他 surface 只投影待审批状态；
- 保持最终授权状态和恢复/终止 Runtime 的唯一权威。

正式 Runtime 权限 adapter 已将 Runtime 请求映射到 `PermissionRequestV1`，并校验 `PermissionDecisionReceiptV1`。生产接线当前仍是 Hermes-first，但公开 presenter 契约不得依赖 Hermes；完整边界见 [Runtime 可移植性与当前交付边界](./runtime-portability.md)。可选长期 scope 尚未开放，Feature 只能展示 `supportedDecisions` 明确声明的决定。

## 新增能力的审查清单

- 能否用更窄的 operation/DTO 代替暴露底层对象？
- 是否有超时、取消、错误映射和敏感信息清理？
- Service 是否使用合法 `service:<id>` 并同步 operation grants 与 Registry？非 Service capability 是否同步 contracts、Schema、Host API 和实现？
- 是否有拒绝未声明、未 grant、未实现能力的测试？
- 若新增 `host:actions` 动作：manifest 声明、系统 drop-in grant、宿主实现是否三者齐备？未知 action、未知资源类型、非法输入是否在写入状态或导航之前返回 `rejected`？失败分支是否区分 `NOT_GRANTED`、`UNSUPPORTED`、`INVALID_INPUT`、`FAILED`？
- 是否需要 Tauri command/scope；若需要，权限仍由宿主 target 管理，不能下放 command 名给 Manifest。
- 是否通过 Registry freshness、Feature 集成、类型检查和 production build？

只有访问类别或安全边界变化才新增 capability。新增业务 operation 不应扩大 allowlist；新增 capability 必须同步升级公共契约、Host adapter 和兼容测试。
