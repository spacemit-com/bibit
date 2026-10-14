# Feature SDK migration guide

本指南用于把外部系统的 Bibit 前端迁入 Internal Feature SDK。领域数据、授权策略和业务规则继续由外部系统服务负责。

## 接入步骤

1. 在 `features/<id>` 建立 workspace，package 命名为 `@bibit/feature-<id>`，添加 `bibitFeature` 和 `./bibit-feature` export。
2. 创建纯 JSON `bibit.feature.json`，明确 owner、target、贡献和最小能力需求。
3. 在内置 grant 或系统 `/etc/bibit/feature-capability-grants.d/*.json` 申请平台 grant；需要的新非 Service Host capability 必须先完成平台级设计和审查。
4. 只依赖 `@bibit/feature-contracts`、`@bibit/feature-sdk`、`@bibit/feature-ui` 及 Feature 自有代码。通过 Host API 连接外部服务。
5. 导出 `FeatureModuleV1`。renderer key 必须与 Manifest contribution id 一致，模块 import 顶层不得建立网络、ServiceHub 或 Tauri 连接。
6. 添加 Feature 自身契约/组件测试和至少一条宿主集成测试，覆盖成功、空、离线/错误、深链或对话失败路径。
7. 运行 `yarn feature:registry` 并提交生成产物；执行 README 中的全部本地门禁。
8. 在 CODEOWNERS 为新 Feature 和必要的服务 adapter 指定真实维护团队。

新增 Feature 不需要、也不应为了装配而修改 `NavMain`、`SettingsMenu`、TanStack `routeTree` 或根布局清单。若接入要求修改这些热点，先判断是不是 SDK 契约缺口，并由平台团队修订公共能力，而不是加入 Feature 特例。

## 非规范接入示例

以下示例只展示 contribution 与 Host API 的组合方式，不定义任何模块必须提供的页面、operation、状态或业务责任。正式模块应只选择自身需要的部分。

### Store 页面

- 若需要主页面，可声明 page/navigation；若需要外部能力，再声明对应 capability。
- 模块自行定义窄 operation DTO，不把 URL 或凭据带入组件。
- 页面提供与其实际流程匹配的局部状态，故障不扩散到宿主。

### Memory 复杂设置

- 若需要复杂设置，可声明 settings namespace contribution，并用 `subpath` 和 `navigation` 管理模块内页面。
- Bibit 会根据 settings contribution 自动提供“设置”页头、子设置菜单和滚动容器；Feature 只渲染内容。`FeatureSettingsPage` 仅是可选的内容排版组件，不代表宿主 Settings Shell。刷新深链后应能重建必要状态，并遵守 [设置内容区与插件样式契约](./settings-content-contract.md)。
- 领域数据和持久化规则不进入 Bibit 平台契约。

### Security 权限与规则设置

- permission presenter 只使用公开的 `{ request, surface, viewState, decide }`，不直接恢复 Runtime。
- 同一个 `requestId` 的重复点击/事件只能解析一次；loader/render/timeout/window close 均 fail closed。
- 自定义 presenter 只在正式 Runtime Contract adapter 启用后生效，Builtin fallback 始终保留。
- 若同一 Feature 还需要复杂设置 UI，使用独立 settings contribution；其领域契约不属于权限 presenter props。
- 不判断 `runtimeId === 'hermes'`，不导入 Hermes/ACP/Tauri 实现。Runtime 差异由宿主 adapter 收敛，详见 [Runtime 可移植性与当前交付边界](./runtime-portability.md)。

## Runtime 可移植性边界

当前权限 SDK 和会话内 presenter 面向标准化 Runtime Contract，模块实现应保持 Runtime-neutral。Bibit 的生产 Runtime 接线目前仍是 Hermes-first，但这不属于 Feature 的依赖面，也不阻塞其他 Feature 按当前 SDK 接入。

如果未来替换 Agent Runtime，由平台团队提供新的 Driver/Profile 和 Runtime adapter。只要适配后仍输出 `PermissionRequestV1` 和 `PermissionDecisionReceiptV1`，Security Feature 不应修改。Runtime Registry、多 Runtime 并存和通用 ACP Driver 不纳入当前模块迁移范围。

## 版本升级

变更公共契约前先分类：

- 兼容：增加真正可选的字段/导出，旧 Feature 行为不变。同步类型、Schema、文档和测试。
- 不兼容：删除/重命名、收紧合法输入、改变 props/错误语义或 capability 行为。提升对应版本，提供旧版兼容窗口和逐 Feature 迁移说明；生成器必须在构建期拒绝不支持版本。
- 兼容别名：`external-service:store`、`external-service:memory` 和 `external-service:security` 是既有内部插件的受支持读取路径，继续映射到对应的 `service:*`。新插件使用规范名称，但 Bibit 不因别名或插件 SemVer 强制其他仓库同步迁移；删除别名必须先提升对应 schema/API 版本并提供旧读取路径。

平台公开兼容坐标为 `pluginSchemaVersion`、`manifestSchemaVersion` 和 `sdkApiVersion`；插件自身 `version` 只标识发布版本，不替代平台坐标。迁移窗口以可验证的双版本共存为准，不以口头日期替代。当前 v1 仍按 experimental 管理，U7 只代表 Bibit 仓库本地兼容基线；在真实 Feature conformance 和 desktop debug 证据完成前，不得声明 stable 或 SDK `1.0`。

插件升级、停用和回滚先原子更新 `desired`，再通过受控重启由启动准备阶段 reconcile 到 `current`。每次受控启动或版本切换都会轮换 Feature instance；旧 instance 的 Service request、FileGrant 和 Job 全部失效。当前 v1 不跨重启恢复业务 Job，只执行 cleanup ledger 中的 Provider 取消和 staging 清理。

## 合入与回滚

合入证据至少包括 Registry check、包测试、Feature boundary lint、Web 集成测试和生产 build。用户可见流程还需 desktop debug build 手工检查键盘操作、焦点、读屏状态、deep link、错误重试和 permission fallback。

若 Feature 造成生产问题，优先从 workspace 移除其 `bibitFeature` opt-in 或回滚对应 Feature/Registry 变更；不要删除固定 namespace host 或破坏其他 Feature。权限路径出现异常时保持 Builtin presenter，并禁用自定义 presenter，未获允许的操作继续 deny。

## v1 stable release gate（当前为 U8 后续门禁）

只有以下条件全部满足才可冻结 SDK API v1：

- 至少一个真实 Feature 在不修改宿主导航、根路由或根布局业务清单的情况下完成 Registry 装配；
- 该 Feature 的 declaration、grant、宿主实现和 capability unavailable 降级均有集成证据；
- Registry freshness、公共包测试、Feature boundary lint、Web 集成测试和 production build 全部通过；
- 开发 Demo 不进入 production bundle，移除或禁用该 Feature 不影响宿主与其他 Feature 启动；
- 涉及 desktop target、外部服务或权限 Presenter 的接线已在 Tauri desktop debug 中完成对应端到端验收；
- conformance 发现的兼容缺口已同步修订 contracts、Schema、生成器和文档。
