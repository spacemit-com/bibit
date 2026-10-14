# Feature Manifest v1

`bibit.feature.json` 是纯 JSON 的构建期契约。它只描述元数据、贡献和能力需求，不允许 React 组件、import 路径、服务 URL、Tauri command 或凭据。规范来源是 `packages/feature-contracts/schema/bibit-feature.schema.json`；TypeScript 的 `FeatureManifestV1` 必须与其同步。

## 顶层字段

| 字段 | 规则 |
| --- | --- |
| `manifestSchemaVersion` | 当前只能是 `1`；控制 JSON 结构。 |
| `sdkApiVersion` | 当前只能是 `1`；控制 Feature Module/Host API 兼容性。 |
| `id` | 2–64 字符 kebab-case；package 必须名为 `@bibit/feature-<id>`。 |
| `version` | SemVer；表示 Feature 自身版本。 |
| `owner` | 稳定团队标识，用于诊断和治理，不是授权依据。 |
| `display` | i18n key、英文 fallback、`iconKey`（开放 token，未知值渲染通用图标）；description key/fallback 必须成对。 |
| `targets` | v1 仅支持 `desktop`。 |
| `requiredHostCapabilities` | 唯一能力数组；还必须由平台 grants 显式批准。 |
| `contributions` | `pages`、`settings`、`conversation`、`locales` 四个必填数组。 |

所有对象拒绝未知字段。`locales` 必须包含 `en`；路径只能是 namespace 内的相对 kebab-case segment，不能包含 `/` 开头、`.`、`..`、query 或 fragment。

## 示例

```json
{
  "manifestSchemaVersion": 1,
  "sdkApiVersion": 1,
  "id": "store",
  "version": "0.1.0",
  "owner": "store-team",
  "display": {
    "titleKey": "store:title",
    "fallbackTitle": "Agent Store",
    "descriptionKey": "store:description",
    "fallbackDescription": "Discover agents and skills",
    "iconKey": "store"
  },
  "targets": ["desktop"],
  "requiredHostCapabilities": ["service:store"],
  "contributions": {
    "pages": [
      {
        "id": "catalog",
        "path": "",
        "surfaces": ["main"],
        "navigation": { "group": "library", "order": 100 }
      }
    ],
    "settings": [],
    "conversation": [],
    "locales": ["en", "zh-CN"]
  }
}
```

## 贡献规则

页面最终地址为 `/features/<featureId>/<path>`，设置最终地址为 `/settings/features/<featureId>/<path>`。空 `path` 拥有整个 Feature namespace；同一 kind/surface 内禁止相同或前缀重叠的最终 URL。一个 Feature 内所有 page、settings、conversation contribution id 必须唯一。

导航 group 和 icon 是开放 token：受 `^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$` 和 1–64 字符长度约束，但不限定为宿主已知集合，因此插件可以先声明新 token 而无需等框架先行。宿主已知的设置导航分组为 `core`、`features`、`integrations`、`privacy`，未知分组进入 `features`；`core` 直接显示在普通设置列表中 General 之后。未知图标渲染通用图标。排序按 `order`，相同值由稳定 contribution key 决定，不能依赖 workspace 扫描顺序。

设置 contribution 的 `navigation` 可选声明 `titleKey`、`fallbackTitle` 和 `iconKey`，用于同一个 Feature 暴露多个名称、图标不同的设置入口。未声明时继续使用顶层 `display` 的对应字段，已有 Feature 的显示行为不变。`core` 入口还可声明 `section: { id, titleKey?, fallbackTitle }`；相同 section id 的入口按导航顺序聚合为与 Features 样式一致的静态标题分组，未声明 section 的入口保持平铺。例如：

```json
{
  "id": "runtime-status",
  "path": "runtime-status",
  "surfaces": ["main"],
  "navigation": {
    "group": "core",
    "order": 110,
    "titleKey": "runtime:settings.runtimeStatus",
    "fallbackTitle": "Runtime Status",
    "iconKey": "settings",
    "section": {
      "id": "runtime-monitoring",
      "titleKey": "runtime:settings.monitoring",
      "fallbackTitle": "监控"
    }
  }
}
```

`permission-presenter` 是 v1 唯一的对话 kind，且在同一 surface 上全局独占。`tool-result`、`plan`、`diff` 和 `terminal` 不可声明：JSON Schema、语义校验和 Native Manifest 校验都会拒绝，避免出现「能声明但没有宿主分发」的假接入。

## 发现和生成

生成器只扫描根 `package.json` 声明的 Yarn workspaces，并且只选择含 `bibitFeature` 字段的 package。每个 Feature 必须导出存在于包内的 `./bibit-feature` 文件。生成 import specifier 由 package name 派生，Manifest 不能控制它。

生成器在输出前验证 JSON Schema、SDK 版本、package/id 对应、export 路径、能力 grants、贡献冲突和 URL 冲突。Registry 按稳定规则排序，文件头含生成器版本与规范化输入 SHA-256；`yarn feature:registry:check` 发现缺失或陈旧产物时失败。

Registry 包含所有已验证目标 metadata，宿主运行时再按 target/surface 投影；环境变量不得改变提交产物内容。

## 兼容规则

- `manifestSchemaVersion` 只管理 Manifest JSON 结构；`sdkApiVersion` 管理 Feature Module、公开 props 和 Host API。Feature 自身 `version` 不替代平台契约版本。
- 只增加可选字段属于候选向后兼容变更，但仍需同步 Schema、TS 类型、生成器测试和本文档。
- 删除/重命名字段、改变语义、收紧已有合法值或修改公开 props 属于不兼容变更，必须提升 `sdkApiVersion` 或 `manifestSchemaVersion`，提供迁移说明和兼容窗口。
- 例外：收紧一个从来没有宿主实现的取值（例如声明后无人渲染的对话 kind）不属于破坏性变更，因为没有插件能依赖一个不存在的宿主行为。这类收紧仍需在下面的一致性用例里写明理由，判定依据见 [Feature Platform 兼容矩阵](./compatibility-matrix.md)。
- Foundation 阶段的 v1 仍是 experimental；首个真实 Feature conformance 和 desktop debug 验收前不得承诺 stable 兼容周期。

## 校验一致性用例

`tests/fixtures/manifest-conformance/cases/*.json` 是 JSON Schema、TypeScript 语义校验和 Native 校验共用的用例集。每个文件含 `name`、`expect`（`accept` 或 `reject`）、`note` 和 `manifest`。

- TypeScript 侧由 `packages/feature-contracts/src/manifest.conformance.test.ts` 先用 Ajv 跑 Schema，再跑 `validateFeatureManifestSemantics`。
- Native 侧由 `trusted_plugins::tests::conformance_cases_match_the_shared_expectations` 用 `validate_feature_manifest` 跑同一批文件。

新增或收紧规则时必须补用例：收紧合法取值加 `reject`，新增合法取值加 `accept`。只在一边改规则时，另一侧会在这个门禁上失败，而不是等到设备上才发现。
