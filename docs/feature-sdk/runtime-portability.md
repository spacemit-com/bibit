# Runtime 可移植性与当前交付边界

本文记录 2026-08-20 对会话内权限审批框架的可移植性审查结论，并明确内部 Feature 可依赖的稳定边界。

## 结论

权限框架已经按 Runtime 无关的方式设计，但 Bibit 的生产 Runtime 接线目前仍是 **Hermes-first**，还不是仅修改配置即可替换 Runtime 的插件系统。权限请求统一投影为单动作或批量 `actions`，以稳定 JSON 字段顺序计算 SHA-256 `actionSetDigest`；resolve 必须携带同一 digest，变化后返回 stale。未知 Runtime decision 被保留为不支持标记，Host 只允许显式支持的 Allow/Deny。

- Feature SDK、权限 presenter、会话内审批 UI、全局审批状态和结构化回执可以复用于其他 Agent Runtime。
- 新 Runtime 必须先由 Bibit 宿主映射到统一 Runtime Contract；Feature 不感知 Runtime 的进程、协议或 IPC。
- 当前 Rust Gateway 已依赖 `RuntimeDriver` 抽象，但生产 Factory、前端 Runtime Contract、工作目录、错误码、实验开关和部分文案仍绑定 Hermes。
- 本轮交付不实施 Runtime Registry、通用 ACP Driver 或多 Runtime 并存；这些是独立的平台演进工作，不阻塞内部模块使用 Feature SDK。

## 当前交付给模块团队的稳定边界

模块团队只依赖以下公开边界：

1. `@bibit/feature-contracts` 中的 Manifest、Host API、权限请求和结构化回执类型；
2. `@bibit/feature-sdk` 中的 `FeatureModuleV1`、页面/设置 renderer 和 permission presenter；
3. `@bibit/feature-ui` 中的共享 UI 原语；
4. Manifest 声明的 contribution 和 `requiredHostCapabilities`；
5. 宿主提供的窄 DTO service adapter。

Security presenter 接收标准化的 `PermissionRequestV1`，并通过 `decide` 返回决定。它不得：

- 导入 `web-app/src/**`、Rust Runtime 或 Hermes 实现；
- 判断 Hermes 进程状态或 ACP 协议细节；
- 直接调用 `runtime_permission_resolve`、Tauri `invoke` 或恢复 Runtime；
- 自行生成 Runtime identity、过期终态或“始终允许”能力；
- 假设 `runtimeId` 永远是 `hermes`。

只要后续 Runtime adapter 继续产出同一 `PermissionRequestV1` 并返回同一结构化 receipt，模块团队不需要修改 presenter。

## 当前宿主的 Hermes-first 耦合

下列耦合属于 Bibit 平台实现，不属于 Feature SDK 公共契约：

| 耦合点 | 当前状态 | 后续改造方向 |
| --- | --- | --- |
| TypeScript Runtime Contract | `runtimeId` 和部分错误码为 Hermes 字面量 | 使用注册的 Runtime descriptor 和通用错误分类 |
| Rust production Gateway | 直接构造 `HermesAcpDriver` | 通过 Runtime Registry/Factory 创建 Driver |
| ACP 与 Runtime quirks | 通用 ACP 逻辑和 Hermes 适配位于同一模块 | 拆分 `StdioAcpDriver` 与 `HermesProfile` |
| 生命周期 UI | 开关、状态文案和组件名绑定 Hermes | 从 Runtime descriptor 投影 |
| 数据目录与提醒 source | 使用 `runtime/hermes`、`runtime-hermes` | 按 `runtimeId/runtimeInstanceId` 隔离 |

因此当前更准确的能力描述是：**权限审批框架 Runtime-neutral，生产 Runtime integration Hermes-first。**

## 新 Runtime 的接入责任

如果后续替换 Hermes，Bibit Runtime 团队负责实现或配置 Driver/Profile，并完成以下映射：

```text
外部 Runtime 协议
        ↓
RuntimeDriver / RuntimeProfile
        ↓
Bibit Runtime Contract
        ↓
PermissionRequestV1 + PermissionDecisionReceiptV1
        ↓
会话 UI / Security Feature
```

新 Runtime 至少需要提供：

- 生命周期：check、start、stop 和异常退出；
- 会话：create session，并绑定稳定 cwd；
- Run：prompt、stream、cancel 和唯一终态；
- 事件：text、reasoning、tool、permission、diagnostic；
- 权限：能力声明、过期、resolve/cancel 和 exactly-once 语义；
- 身份：`runtimeId/runtimeEpoch/sessionId/runId/requestId/toolCallId`；
- 恢复：snapshot 或明确的安全取消策略。

Runtime Gateway 会为每次决定生成 accepted/duplicate/stale/expired/rejected receipt，并把拒绝原因与 digest 写入 `permission_audit` 事件；本地部署可选启用 `permission-receipts.json` 作为最小持久回执存储。内存与文件只保留最近 4096 个复合 identity，重复 identity 更新会替换旧状态并移到保留窗口末尾，避免主窗口内长期运行造成无界增长。`permission_audit` Run Event 是授权审计事实源，回执文件是可重建的有界本地审计副本：文件目录、写入或原子替换失败只记录诊断并保留内存中的权威结果，不会在 Provider 已完成决定后伪造撤销。启动时会清理失败的临时文件；发布环境必须监控该路径可写性，若产品需要强制审计耐久性，应在决定前提供独立 durable event store，而不是把当前副本误当作事务提交。

前端权限控制器的 identity key 包含 `runtimeId`、`runtimeEpoch`、session、thread、run、request、tool 和 `actionSetDigest`。同一请求身份但动作摘要变化时，旧的 stale 结果不会阻塞新一轮 pending 审批；thread 与 session 分离的 Runtime 也不会发生前端状态碰撞。若 Runtime 未提供独立 `threadId`，Host 才回退使用 `sessionId`；stale receipt 和 Presenter 失败降级请求沿用同一规则。

`permission_audit.actionSetDigest` 与 permission request/receipt 使用同一 64 位十六进制 SHA-256 校验，格式不合法的审计事件在 Web 合约边界直接拒绝，避免审计记录与实际动作投影脱节。

Rust Gateway 与 TypeScript parser 共用 `tests/fixtures/runtime-contract-v1.json` 中的权限动作投影和 digest 断言；Bianbu/Python 的真实 Runtime 事件仍需在 `bianbu-agent-runtime` 仓库补充同一 fixture 消费测试后，才能宣称跨语言 conformance。

如果新 Runtime 支持兼容的 ACP，可以复用未来拆出的通用 ACP Driver，只新增 Profile/quirks。如果不是 ACP，则实现新的 `RuntimeDriver` adapter，但上层权限框架保持不变。

## 当前交付范围

平台交付 package/Manifest/Registry/contribution、Host capability 和 permission presenter 接入契约，以及对应授权、构建和验收门禁。各 Feature 的页面、operation、数据模型和业务流程不属于本文规范。

本轮不因为未来 Runtime 替换而要求 Feature 等待，也不提前暴露尚未冻结的 Runtime Registry API。Feature 不得绕过公开 SDK，以免把当前 Hermes-first 实现固化为新的依赖。

## 后续通用化触发条件

出现以下任一条件时，应单独规划 Runtime 通用化，而不是在 Feature PR 中顺带修改：

- 确定第二个生产 Runtime；
- 需要在同一安装中并存多个 Runtime；
- 新 Runtime 需要不同的 permission capability；
- Hermes 特例开始进入 Feature 公共契约；
- 新 Runtime 无法无损映射到当前 Runtime Contract。

通用化完成的最低证明是增加一个非 Hermes 的 Fake Runtime，并在不修改 Security Feature 的情况下通过生命周期、流式事件、权限 allow/deny、失败重试、过期、重复 resolve 和会话切换测试。
