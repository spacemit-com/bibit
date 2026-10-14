# Feature Platform 兼容矩阵

Bibit 只加载公司内部签名插件。框架以 bundle、Manifest 和 SDK API 的公开坐标判断兼容性，不使用插件 SemVer 或跨仓库 BOM 作为安装门禁。

开发调试可在 debug 构建中设置 `BIBIT_PLUGIN_SKIP_VERIFY=1`，临时接受省略签名和文件哈希校验的 bundle。该开关只作用于 debug 构建，release 构建始终要求签名和完整校验。

## 构建口径

| 构建入口 | feature | 产物 | 可发布 | 用途 |
| --- | --- | --- | --- | --- |
| `yarn build:deb:linux`（`debian/rules` 也调用它） | `allow-unsigned-plugins` | `bi-bit_<version>_riscv64.deb` | 否，仅公司内部测试包 | Bianbu 内部联调与交付 |
| `node scripts/build-bibit-release.mjs` | 拒绝任何 `--features`（`scripts/build-bibit-release.test.mjs` 断言） | `BiBit_<version>_riscv64.deb` | 是 | 生产 release，强制验签 |

内部测试包在 `debian/changelog` 里标注该差异，不得当作生产 release 分发。信任库随包分发：`src-tauri/resources/plugin-trusted-keys.json` 由 `src-tauri/tauri.conf.json` 的 `bundle.resources` 打进 deb，运行期从 `resource_dir()/resources/` 读取。平台覆盖层（`tauri.linux.conf.json`）不得自带 `bundle.resources`：tauri 按 RFC 7396 合并平台配置，数组是整体替换而不是追加，平台层漏写一项就会让该项从包里消失（信任库曾因此没进 deb，而 `allow-unsigned-plugins` 编译期短路验签把问题挡在了内部测试包之外）。

## 当前公开坐标

| 坐标 | 支持值 | 管理范围 |
| --- | --- | --- |
| `pluginSchemaVersion` | `1` | `plugin.json`、文件哈希和签名结构 |
| `manifestSchemaVersion` | `1` | `bibit.feature.json` 结构 |
| `sdkApiVersion` | `1` | Feature Module、Host API 和公开 props |

插件自己的 `version` 只标识插件发布版本。只要以上公开坐标受支持、Manifest capability 合法、公司签名可信，Bibit 不因插件使用 `0.2.x` 或 `0.3.x` 而拒绝加载。

## 既有插件基线

| 插件 | 既有版本 | 既有 capability | 框架承诺 |
| --- | --- | --- | --- |
| Security | `0.2.3` | `external-service:security`、`runtime:permission` | 无需修改 Manifest、SDK 依赖或构建命令即可继续加载 |
| Agent Hub | `0.3.0` | `service:store`、`file:transfer`、`job:manage` | 无需修改 Manifest、SDK 依赖或构建命令即可继续加载 |

兼容 fixture 固定在框架仓库，由 `yarn test:trusted-plugin-interop` 构建两个签名 bundle，并交给同一个 Rust installer 验证共同安装。

## Capability 兼容

| 既有名称 | 规范名称 | 状态 |
| --- | --- | --- |
| `external-service:store` | `service:store` | 支持；新插件推荐使用规范名称 |
| `external-service:memory` | `service:memory` | 支持；新插件推荐使用规范名称 |
| `external-service:security` | `service:security` | 支持；Security 0.2 无需迁移 |

Host 为明确列出的旧名称和规范名称提供同一个 Service API。Native 层始终校验 Feature instance、插件版本、request owner 和精确 operation grant；兼容别名不能绕过授权。

## 对话 kind 收敛

v1 只保留 `permission-presenter`。`tool-result`、`plan`、`diff` 和 `terminal` 从来没有宿主分发点：声明它们不会报错，但也不会渲染任何内容。这些值现在被 JSON Schema 和 Native Manifest 校验拒绝。这是有意收紧而不是新的 breaking change——一个不存在的宿主行为不构成兼容面；如果后续补上统一消息分发，会随新的 schema/API 版本一起重新引入，并同时提供 Host 组件与端到端证据。

`runtime:permission` 同理由「宿主拥有的 capability」改为声明专用项：Manifest 仍可声明，但宿主不注册可调用实现，`getCapability('runtime:permission')` 恒为 `undefined`。权限往返继续只走 presenter props 的 `decide`，既有 Security 插件的行为不变。

## 构建与安装

既有构建命令保持不变：

```bash
bibit-plugin build \
  --key /secure/path/company-signing-private.pem \
  --key-id company-release-key
```

builder 校验 Feature Manifest、package/Manifest 版本一致性、CSS 作用域和签名文件清单。产物继续包含 `plugin.json`、`plugin.sig` 和 `dist/**`；不要求 BOM 或 release attestation。

安装、激活和受控重启重新校验公司签名、文件 SHA-256、公开 schema/API 和 Manifest。Provider 暂时离线不会使格式正确的插件失去安装资格；调用时按 capability availability 返回不可用。显式回滚仍验证当前 grant 和 Provider Registry，避免恢复一个无法获得所声明能力的版本。

## 版本协调规则

| 改动 | 必须动作 |
| --- | --- |
| 内部实现、新增可选字段、新增 `service:*` | 不动坐标，既有插件继续工作 |
| 改公开 props、element tag、`bibitContext` 属性或 Host API 形状，删字段，收紧合法值 | 升 `sdkApiVersion`，所有插件重编 |
| 改 `plugin.json` 结构 | 升 `pluginSchemaVersion` |
| 改 `bibit.feature.json` 结构 | 升 `manifestSchemaVersion` |
| 新增图标字形（`packages/feature-ui` 目录项） | 不动坐标，任何时候都可单独合入 |
| 新增导航 group | 不动坐标；插件可先声明，宿主未认识时按回退分组显示 |
| 新增业务 operation | 直接用无版本名（`agents.list`）；`.v<n>` 后缀只是别名，grant、connection 策略和 provider 都可继续用带后缀的写法 |
| 改业务 operation 语义 | 必须新增 operation，不能原地改写旧名 |
| 新增 `host:actions` 动作 | 不动坐标；动作注册表是追加式的。插件必须先拿到已下发的能力，未登记动作返回 `UNSUPPORTED` |
| 改已有 `host:actions` 动作的输入或结果语义 | 必须新增动作，不能原地改写旧动作 ID |

例外：收紧一个从未存在宿主实现的取值不算 breaking change，见 `manifest-v1.md` 的对话 kind 收敛。

### 声明取值是开放 token，不是闭合枚举

`display.iconKey`、`navigation.group`（page 与 settings）和 `navigation.iconKey` 在 Manifest 里是**开放 token**：受 `#/$defs/declaredToken` 约束（1–64 字符、`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`），但不限定为宿主已知的集合。原生校验器对应实现是 `trusted_plugins.rs` 的 `valid_declared_token`。

这样做的原因是这两种取值都属于**呈现元数据**：宿主不认识一个图标或分组，不应该让一个签名合法的插件整体装不上。识别不了就在本地降级：

| 取值 | 宿主认识 | 宿主不认识 |
| --- | --- | --- |
| `display.iconKey`、`navigation.iconKey` | 渲染对应图标 | 渲染通用 `feature` 图标 |
| page `navigation.group` | 按 `workspace`/`library`/`tools` 排序 | 排在所有已知分组之后，仍可见 |
| settings `navigation.group` | 进入对应设置分组 | 进入 `features` 分组，仍可见 |

`FEATURE_ICON_KEYS`、`FEATURE_PAGE_NAVIGATION_GROUPS`、`FEATURE_SETTINGS_NAVIGATION_GROUPS` 保留为**宿主已知集合**，用来驱动图标目录和菜单排序；它们描述这一版宿主会渲染什么，不再限制插件可以声明什么。因此新增图标字形或新增分组都是纯增量改动，不需要升任何公开坐标，也不再要求"框架先行"。

按这条边界，**插件可以先声明新图标或新分组再等宿主跟进**：宿主未认识时只降级呈现，不会拒签。反过来，收紧 `declaredToken`（改短长度上限、改字符集）仍然是 breaking change，必须走升版本流程。

### 降级边界

以下失败仍然整插件拒绝，属于安全边界，不做降级：

- 签名、文件 SHA-256、路径穿越、入口不在 `files` 清单内；
- `pluginSchemaVersion`、`manifestSchemaVersion`、`sdkApiVersion` 不受支持；
- 核心字段类型错误、contribution id 重复、路径重叠、`targets`/`surfaces`/`locales` 非法；
- 未知 capability 一律不授权（插件继续加载，`getCapability` 返回 `undefined`）。

- 新 Service 使用 `service:<id>`，但不能通过删除旧别名强迫既有插件迁移。
- 插件仓库迁移只能由各自维护团队决定，不能作为 Bibit 框架安全修复或生命周期增强的前置条件。

## 桥接触面清单

改动以下任一处都属于 breaking change，必须走上一节的升版本流程：

- element tag 命名；
- `bibitContext` 属性契约；
- Feature 公开 props 形状；
- Host API 对象形状；
- 插件模块的顶层导出（`registerFeaturePlugin`、`pluginLocales` 等）。
- `host:actions` 已登记动作的输入形状与结果语义（新增动作不在此列，属追加式改动）。

## 门禁检查矩阵

| 契约 | 自动检查 | 挂点 |
| --- | --- | --- |
| Manifest 结构与语义 | `manifest.test.ts`、`manifest.conformance.test.ts` | CI `feature-sdk`（`yarn test:all`） |
| Manifest 运行期校验与两侧一致 | Rust `conformance_cases_match_the_shared_expectations` | CI `runtime-permission` |
| 包边界与包依赖 | `yarn test:feature-boundaries` | CI `feature-sdk` |
| 生成 Registry 新鲜度 | `yarn feature:registry:check` | pre-push + CI `feature-sdk` |
| 启动顺序（投影晚于注册） | `registry-boot-order.test.ts` | CI `feature-sdk`（`yarn test:all`） |
| 插件互操作（旧 bundle 仍可加载） | `yarn test:trusted-plugin-interop` | CI `runtime-permission` |
| 签名与信任库 | Rust `trusted_plugins` 套件（默认不带 `allow-unsigned-plugins`） | CI `runtime-permission` |
| 实机行为 | 在目标设备上安装构建产物，验证启动、会话、语音入口和插件加载 | 记录设备环境、产物摘要与验证结果 |

## 验收命令

```bash
yarn workspace @bibit/feature-plugin-sdk test
yarn test:all
yarn feature:registry:check
yarn test:feature-boundaries
yarn test:trusted-plugin-interop
```
