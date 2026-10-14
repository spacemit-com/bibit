# Bibit Internal Feature SDK

Internal Feature SDK 同时支持随 Bibit 编译的 workspace Feature，以及由公司签名、可独立构建安装的 trusted plugin。Feature 可以贡献主页面、复杂设置页面和登记过的对话组件；宿主继续拥有路由命名空间、能力授权、外部连接治理和 Runtime 最终决定权。

独立仓库、开发工作台、签名/无签名 debug bundle 和无需重编 Bibit 的安装流程见 [可信插件开发、签名与加载指南](./trusted-plugin-guide.md)。
当前公开坐标、既有插件基线和 capability 别名以 [Feature Platform 兼容矩阵](./compatibility-matrix.md) 为准。

准备实现模块时，从 [开发者手册](./developer-guide.md) 开始。该手册包含可直接使用 的目录模板、代码模板、平台接线边界、测试矩阵和完成清单。
设置页面必须遵守 [设置内容区与插件样式契约](./settings-content-contract.md)，只提供内容并通过构建期 CSS 门禁。
独立后端统一遵守 [External Service 开发与部署规范](./external-service-development-and-deployment.md)，通过模块 Adapter 和系统级 Registry drop-in 接入，插件不得直接连接后端。
本地 CLI、HTTP 服务和后续其他传输统一遵守 [Service Provider Framework](./provider-framework.md)。SDK v1 的 `external-service:*` 为兼容别名，新插件优先使用传输无关的 `service:*`。
需要用户选择文件、显示进度、显式取消或页面重进恢复时，使用 [FileGrant 与异步 Job 开发指南](./file-transfer-and-jobs.md)，不得把路径或 CLI 参数放进业务 DTO。

> 当前状态：v1 platform baseline / experimental。`manifestSchemaVersion = 1` 和 `sdkApiVersion = 1` 已用于构建期校验；完成首个真实 Feature conformance、desktop debug 验收和兼容门禁后，才能声明 SDK v1 stable。
>
> 本次交付将带复合 Runtime identity、`supportedDecisions`、异步 `decide` 和结构化 receipt 的权限 Presenter 定义为唯一的 pre-stable v1 baseline。此前仅存在于内部原型、从未向模块团队发布的 `requestedScopes/outcome/scope` 形态不属于受支持 API。自本基线共享给模块团队后，任何破坏性 props 或 decision 变更都必须提升 `sdkApiVersion` 并提供迁移窗口。

模块验证命令见 [兼容性矩阵](./compatibility-matrix.md)。使用公开标签 `1.0Beta1` 获取固定版本。

## 包边界

| 位置 | 职责 | 不应包含 |
| --- | --- | --- |
| `@bibit/feature-contracts` | 纯数据类型、版本常量、错误 DTO、JSON Schema | React、宿主实现、网络调用 |
| `@bibit/feature-sdk` | Feature Module、公开 props、Host API context/hooks | ServiceHub、Tauri、宿主 Store |
| `@bibit/feature-ui` | 稳定 UI primitive、状态页、设置布局、icon token | 业务组件、Feature 私有状态 |
| `web-app/src/features` | Registry projection、Host、Host API 实现、对话适配 | 外部系统领域逻辑 |
| `features/*` | 随 Bibit 编译的内部 Feature 前端 | 宿主私有导入、长期凭据、服务端领域逻辑 |
| 独立插件仓库 | 自包含前端 bundle、Manifest、Dev Host | Bibit 私有导入、签名私钥、服务端领域逻辑 |

两种 Feature 都是受信任的内部代码；trusted plugin 另有公司签名与文件完整性校验，但仍不是不可信代码沙箱。依赖边界由公开 API、Manifest grants、lint、签名和代码审查共同保证。

## 最小 Feature

```text
features/<feature-id>/
├── bibit.feature.json
├── package.json
└── src/bibit-feature.tsx
```

`package.json` 必须选择性加入 Registry，并公开唯一模块入口：

```json
{
  "name": "@bibit/feature-<feature-id>",
  "private": true,
  "type": "module",
  "bibitFeature": "./bibit.feature.json",
  "exports": {
    "./bibit-feature": "./src/bibit-feature.tsx"
  }
}
```

模块只导出公开契约，不在 import 顶层连接服务。以下代码仅演示装配形态，不规定任何模块的页面或业务操作：

```tsx
import type { FeatureModuleV1 } from '@bibit/feature-sdk'

export const featureModule: FeatureModuleV1 = {
  sdkApiVersion: 1,
  pages: { catalog: StorePage },
  locales: { en: { title: 'Agent Store' } },
}

export default featureModule
```

Manifest 的完整字段和限制见 [Manifest v1](./manifest-v1.md)，能力申请和错误处理见 [Host capabilities](./host-capabilities.md)。可运行参考位于 `tests/fixtures/features`；它们由测试 harness 显式注入，不属于根 workspace，因此不会进入生产 Registry。

## 贡献类型

- 主页面：固定挂载到 `/features/<featureId>/*`，可声明主导航入口。
- 设置页面：固定挂载到 `/settings/features/<featureId>/*`，复用 Bibit Settings Shell，Feature 自主管理 namespace 内的列表、详情和编辑状态。
- 对话组件：声明已登记的 `kind`。`permission-presenter` 每个 surface 只能有一个，宿主保持唯一 resolve 权并在失败、超时或关闭时 fail closed。
- locale：模块加载后以 Feature id 为 namespace 注册，必须包含 `en` fallback。

新增合规 Feature 不应修改 `NavMain`、`SettingsMenu`、`routeTree` 或根布局的业务清单。导航和宿主入口从 Registry projection 自动产生。

## 本地工作流

```bash
yarn feature:registry
yarn feature:registry:check
yarn workspace @bibit/feature-contracts test
yarn workspace @bibit/feature-sdk test
yarn workspace @bibit/feature-ui test
yarn test:features
yarn test:web
yarn lint
yarn build:web
```

提交前必须提交最新的 `web-app/src/features/generated/feature-registry.gen.ts`。不要手工编辑生成文件。CI 会从 clean checkout 执行 Registry freshness、公共包类型/测试、边界 lint、完整 JavaScript 测试和生产 Web build。

## 故障处理

- `generated Feature Registry is stale`：运行 `yarn feature:registry` 并检查 Manifest/grants 的预期差异。
- Schema、重复 id、URL overlap、permission presenter 冲突：修正 Manifest；不要在宿主写特殊分支绕过生成器。
- `Feature could not be loaded`：保持错误局部化，检查 lazy export 是否为 `FeatureModuleV1`、贡献 id 是否一致；Retry 会清除该 Feature 的 loader cache。
- capability 返回 `undefined`：依次检查 Manifest 声明、内置或 `/etc/bibit/feature-capability-grants.d/*.json` grant、当前 Feature instance、operation allowlist 和 Provider Registry。
- 文件传输按钮不可用：除上述四层授权外，检查 `file:transfer`、`job:manage`、Provider v2 协商和 `jobs/cancellation/maxConcurrentJobs`。
- 跨 Feature 动作不可用（例如"用此专家新建会话"）：`getCapability('host:actions')` 返回 `undefined` 时依次检查 Manifest 是否声明、系统 drop-in 是否 grant、宿主是否实现；拿到能力后若某动作返回 `rejected`，按 `code` 区分 `UNSUPPORTED`（动作未登记）、`NOT_GRANTED`、`INVALID_INPUT`（资源引用非法或目标不可用）和 `FAILED`。`conversation.compose` 在首页已有未发送草稿时返回可重试的 `FAILED`，这不是能力问题，提示用户清空输入框即可。详见 [Host capabilities](./host-capabilities.md)。
- 外部服务错误：依据结构化 `code` 展示可恢复状态，只向日志关联 `diagnosticId`，不要展示或记录凭据。
- permission presenter 失败：Builtin fallback 必须保持可交互；未明确允许时 Runtime 不得继续。

真实模块接入和兼容升级步骤见 [Migration guide](./migration-guide.md)。

