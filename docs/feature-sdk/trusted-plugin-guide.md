# Bibit 可信插件开发、签名与加载指南

本文面向安全、记忆、Agent Hub 等模块开发者。目标是让模块位于独立仓库，单独开发、构建和签名；Bibit 不重新编译即可安装新版本插件。

## 1. 交付模型

```text
模块仓库                         Bibit
Feature UI + Manifest            Settings > Extensions
        │                               │
        ├─ Feature Dev Host             ├─ 安装 .bibit-plugin.tgz
        └─ bibit-plugin build ─────────>├─ Rust 验签 + SHA-256 校验
                                        ├─ 激活版本 Registry
                                        └─ 受控重启后加载 Custom Elements
```

方案 A 的信任前提是：插件属于公司内部代码，并由公司 Ed25519 私钥签名。插件不是不可信代码沙箱；签名解决来源和完整性，Host API 解决 Bibit 私有实现耦合。插件不得直接导入 Bibit 源码、`@tauri-apps/*`、ServiceHub 或宿主 Store。

## 2. 平台包

| 包 | 用途 |
| --- | --- |
| `@bibit/feature-contracts` | Manifest、权限与能力纯数据契约 |
| `@bibit/feature-sdk` | Feature Module、Host API hooks、公开 props |
| `@bibit/feature-plugin-sdk` | Custom Element 注册、签名 keygen、插件构建器 |
| `@bibit/feature-dev-host` | 独立浏览器开发工作台和 Host API mock |
| `@bibit/feature-ui` | 可选的稳定 UI primitives |

正式使用时应将这些包发布到公司 npm Registry。当前参考仓库在 `vendor/` 携带 SDK 快照，便于在 Registry 尚未上线时运行。Host 根据公开 schema/API 坐标判断兼容性，不用插件 SemVer 强迫已有仓库同步升级；现有基线见 [Feature Platform 兼容矩阵](./compatibility-matrix.md)。

快照直接由框架仓库的 `packages/` 打包，没有构建步骤（`files` 只包含 `src`/`schema`），因此填充或刷新 `vendor/` 不需要先发版：

```bash
cd bibit-gui/packages/feature-contracts
yarn pack --out ../../<插件仓库>/vendor/bibit-feature-contracts-0.3.0.tgz
```

包名去掉 scope 后拼版本号即文件名。替换 `vendor/` 快照后必须重新生成 `package-lock.json`，并让插件仓库自己的验证流程确认 tarball 内部包名、版本和 SRI。

## 3. 已提供的独立参考仓库

- `bibit-security-plugin`：会话内 `permission-presenter`，演示 `allow_once/deny`、提交中与错误态。
- `bibit-agent-hub-plugin`：主页面 Feature，演示通过 `service:store` 调用版本化 operation。

任一仓库均可独立运行：

```bash
npm install
npm run typecheck
npm run dev
```

浏览器打开 Vite 输出地址。Feature Dev Host 会读取真实 Manifest 和 Feature Module；Security 自动生成模拟权限请求，Agent Hub 注入模拟 Store adapter。此流程不启动、不加载、也不编译 Bibit。

Dev Host 会把 settings contribution 放进模拟的 Bibit Settings Shell，并检查内容区横向溢出。设置 renderer 和 CSS 必须遵守 [设置内容区与插件样式契约](./settings-content-contract.md)。

## 4. 独立仓库的最小结构

```text
<module>-plugin/
├── bibit.feature.json
├── package.json
├── src/
│   ├── feature.tsx       # FeatureModuleV1
│   ├── plugin.tsx        # registerFeaturePlugin
│   └── ...               # 模块 UI
├── dev/main.tsx          # FeatureDevHost + serviceMocks
├── vendor/               # 过渡期固定 SDK 快照
└── artifacts/            # 签名产物，不提交
```

`src/plugin.tsx` 必须保持无业务连接，只注册 Manifest 声明过的渲染器：

```tsx
import { registerFeaturePlugin } from '@bibit/feature-plugin-sdk'
import manifest from '../bibit.feature.json'
import { featureModule } from './feature'

registerFeaturePlugin({ manifest, module: featureModule })
```

插件会打包自身 React 和依赖，并通过带确定性名称的 Custom Element 与宿主交互。因此插件可单独升级，不共享 Bibit 的 React module instance；跨边界只能传递 JSON 数据、回调和 Host API。

`registerFeaturePlugin` 会把 `module.locales` 发布到宿主与 SDK 共享的 locale registry，宿主在首屏渲染前即可拿到导航和标题文案，插件不需要为此额外导出。既有 bundle 若仍在 entry 顶层导出 `pluginLocales`（早期插件模板的写法），宿主继续读取该导出作为兼容路径，无需重新构建。Manifest 在 `contributions.locales` 中声明了却没有提供资源的语言会记一条 `console.warn`，不再静默回退。

## 5. 构建和签名

开发 key 仅用于本地验收：

```bash
npm run keygen
npm run build:plugin
```

`build:plugin` 会拒绝 package/Manifest 版本不同或 Manifest 不合法的构建，但不要求 BOM，也不按插件 SemVer 限制加载。builder 继续检查最终 CSS，并拒绝 `:root`、`html`、`body`、`#root` 和裸 `*` 等越界 selector；`@keyframes`、`@counter-style`、`@property` 和自定义字体等全局名称必须以 Feature id 为前缀。Bibit 加载 bundle 时还会把 CSS 限制在该插件声明的 Custom Element 根内，形成构建期与运行时两层保护。 宿主使用 CSS/selector parser 添加零 specificity 的根选择器前缀和目标边界，避免 WebKitGTK 的原生 `@scope` 使 input/textarea 样式失效；media/supports、伪元素和已命名空间化的全局定义继续保留。`@import`、`@namespace` 和页面/文档级规则会被拒绝，防止移除外层 scope 后激活未经隔离的样式。

开发阶段如暂时没有签名材料，可省略 `privateKeyPath` 和 `keyId` 构建无 `plugin.sig` 的 bundle。当前 Bianbu Debian 包通过 `allow-unsigned-plugins` 构建 feature 直接接受此类 bundle；该包仅适用于公司内部开发环境，不得用于生产发布。普通 release 构建仍强制恢复全部校验。

输出：

```text
.bibit-keys/development-private.pem       # 私钥，禁止提交
.bibit-keys/development-public.json       # 单个信任项
.bibit-keys/development-trust-store.json  # 可直接用于本地 Bibit
artifacts/<feature>-<version>.bibit-plugin.tgz
```

正式产物包含 `plugin.json`、`plugin.sig` 和 `dist/**`。签名覆盖 `plugin.json` 的精确字节；Manifest 中记录每个 `dist` 文件的 SHA-256。Bibit 会拒绝未知 key、签名错误、hash 错误、额外文件、重复路径、路径穿越和超限归档。无签名 bundle 只允许配合上面的 debug 开关使用。

正式 CI 不应生成长期私钥。推荐流程是：CI 构建未签名 staging 内容，公司签名服务持有私钥并生成最终 bundle；Bibit 发布包只内置公钥 `src-tauri/resources/plugin-trusted-keys.json`。

## 6. 在 Bibit 中调试和安装

开发调试启动 Bibit 时可临时指定某个开发 trust store：

```bash
BIBIT_PLUGIN_TRUST_STORE=/absolute/path/.bibit-keys/development-trust-store.json yarn dev:tauri
```

调试独立 Security 插件时不要同时设置 `BIBIT_SECURITY_DEMO=true`；两者都声明 `security` Feature id，宿主会隔离后加载的重复项，但 Bibit 主界面仍可正常启动。

进入 `Settings > Extensions > Trusted plugins`，点击 `Install plugin`，选择 `.bibit-plugin.tgz`。Bibit 会先验签、安装并把目标版本写入 `desired`，然后由设置页触发受控重启；下一次启动准备阶段再次校验 bundle，成功后才提交为 `current` 并加载新页面、设置或权限 presenter。停用和回滚使用同一流程，不在仍运行的 WebView 中热切换已挂载插件。

`Uninstall plugin` 调用 `trusted_plugin_uninstall`：先停止该 Feature 的 request 与 Job，再删除 `plugins/installed/<feature-id>` 下的全部版本，清除 registry 的 `current`、`desired`、`previous`，并把 id 记入 `disabled`。`disabled` 让系统插件目录（Debian 包安装的插件）不会在下次启动时把它重新展开回数据目录：宿主只校验 bundle 的签名清单读出 id 后跳过，既不恢复文件也不重新激活；只有再次显式安装才会清除该标记。相对于只改 registry 的停用，卸载是磁盘空间和反复失败验证的出口。

生产构建忽略 `BIBIT_PLUGIN_TRUST_STORE`，只接受发布包内置的公司公钥。平台管理员必须在发布 Bibit 前登记团队公钥；模块开发者不能通过 Manifest 自行扩大信任。

安装数据位于 Bibit data 目录的 `plugins/installed/<feature-id>/<version>`，激活映射位于 `plugins/registry.json`。Rust 在每次启动时重新验签和校验 hash，再把同一份已验证 JS/CSS 字节作为只读源码快照交给 WebView；前端不会在校验后重新打开可变磁盘路径。单个插件校验失败时只隔离该插件，其他有效插件继续加载，`Settings > Extensions` 会显示拒绝原因并允许停用故障项。

已验证 descriptor 只包含 id、版本、Manifest 和已验证的代码/样式快照，不包含 Feature instance token。Host 会先为本次进程中的所有有效插件逐一消费一次 Native bootstrap，再开始导入任一插件代码；bootstrap 身份不匹配或已被消费时只拒绝对应插件。插件代码开始执行后，重复调用 active-list、安装或激活接口都不能枚举其他 instance token。

启动加载器调用 `trusted_plugin_prepare_active`：恢复 cleanup ledger、同步系统插件、reconcile `desired/current`、轮换 Feature instance，并清理旧 instance 的 request、FileGrant 和 Job。设置页调用只读的 `trusted_plugin_list_active`：它只返回当前 descriptor、拒绝项和生命周期状态，不修改 Registry、不轮换 instance，也不触发任务清理。两者不能互换，避免普通状态查询改变正在运行的插件。

## 7. Host API 对接边界

- 页面或设置模块只通过 `useFeatureCapability(...)` 请求声明过的能力。
- `service:<id>` 由 Bibit Provider Broker 根据 operation grant 与 Registry 动态注册；插件不得持有服务 URL、token、CLI 路径或直接 `fetch`。
- Service request/cancel 由 Host 自动绑定当前 Feature id、版本、instance、Service、operation 和 request id；插件不得构造或持久化这些 Native envelope 字段。
- 文件操作只通过 `file:transfer` 获取不透明 Grant；插件不得读取路径或文件内容。
- 长时操作只通过 `job:manage` 启动、恢复、订阅和显式取消；组件卸载不得隐式取消任务。
- 权限 presenter 只通过 `PermissionPresenterProps.decide` 提交决定；Runtime Gateway 仍是唯一最终权威。
- 缺少 capability 时要显示不可用状态；不得绕过 SDK 调用 Tauri。
- 一个 target/surface 只能激活一个 `permission-presenter`。静态 Feature 占用该位置时，所有冲突的 runtime entry 都被拒绝；没有静态 Presenter 时，同一位置的 runtime 冲突组会整体拒绝并回退 Builtin，不按发现顺序选择胜者。重复 runtime Feature id 同样整组拒绝，其他无冲突 entry 继续加载。Host 为每个拒绝项记录稳定的结构化 code、位置、冲突方和 reason。

Feature instance token 只用于公司可信同 WebView 模型下的 owner 隔离和审计，不构成恶意插件沙箱。需要抵御恶意已签代码时，必须升级为独立 WebView 或进程边界，不能依赖 token 保密性。

文件选择、Job 状态机、Dev Host Mock 和 Provider v2 的完整要求见 [FileGrant 与异步 Job 开发指南](./file-transfer-and-jobs.md)。

## 8. 版本与升级规则

1. 修改模块代码，同时把 `package.json.version` 与 `bibit.feature.json.version` 提升为同一值。
2. 使用受支持的 `sdkApiVersion` 构建、测试和签名；插件 SemVer 不作为 Host 兼容坐标。
3. 在 Bibit 安装新 bundle：新版本落到 `plugins/installed/<feature-id>/<version>`；同版本重装直接覆盖该版本目录的内容，因此同版本改内容也只需重装加重启。
4. 激活、停用或回滚只原子更新 `plugins/registry.json` 的 `desired` 指针；`current` 是最近一次受控启动冻结的 Registry，`previous` 是当前版本替换前的 known-good 版本，`active` 仅是兼容旧读取方的镜像。
5. 由设置页发起受控重启（不是单纯 WebView reload）。启动阶段先恢复 cleanup ledger，再验证 `desired` bundle 并把它提交为 `current`；验证失败时保留旧 `current`，并在页面显示 `rejected`/`rollback-available`。
6. 回滚会重新验签并验证 previous 的 Manifest、Host capability、operation grant、Provider Registry 和当前安装内容；不兼容或缺失时拒绝回滚并保留 `current`。Registry 的 `desired/current/previous/disabled` 读改写在进程内串行化，系统目录同步不会清除停用标记，也不会绕过用户的回滚意图（见第 7 条）。
7. 系统插件目录（Debian 包安装的 `/usr/lib/bibit/plugins`，可用 `BIBIT_SYSTEM_PLUGIN_DIR` 覆盖）每次启动按内容哈希比对：bundle 内容变了就重新展开，并把该 feature id 的 `current`/`desired` 一起推进到本次目录里版本号最大的那个，旧版本留在 `previous` 供回滚；内容没变就不重装，但注册表指针若落后于已安装的那个版本（0.1.18 之前替换 deb 时只解包、不推进指针留下的状态）会在启动时按 SemVer 补齐，用户的停用状态和 `previous` 里记着的那个被回滚掉的版本仍然不动。所以覆盖安装 deb 或直接替换 tgz 后重启即加载新版本，不需要先卸载，也不要求版本号发生变化；已经装了新版插件却还加载旧版的设备升级 BiBit 后也会自愈。同一个 feature id 在目录里同时留下多个版本时，按 SemVer 取最大的那个（不依赖文件名顺序）。

### 8.1 生命周期状态与恢复边界

| 状态 | 含义 | 合法动作 |
| --- | --- | --- |
| `pending-restart` | `desired` 已改变，尚未进入新的冻结 Registry | 受控重启、取消待定变更 |
| `active` | `current` 已加载且无 previous | 停用、升级 |
| `rollback-available` | 当前 active 且存在 previous known-good | 回滚、升级、停用 |
| `recovered` | 启动时清理了崩溃遗留的 Provider Job/staging | 仅查看诊断 |
| `pending-cleanup` | 关联的 Provider Job 还在清理，宿主尚未重载该插件 | 等待清理完成，或卸载 |
| `rejected` / `disabled` | 当前版本校验失败或 desired 已停用 | 修复 bundle、回滚或重新激活 |

Feature instance token 每次受控启动或版本切换都会轮换。旧 instance 的 Service request/cancel、FileGrant 和 Job 全部失效。当前 experimental v1 不跨重启恢复业务 Job：启动只读取最小 cleanup ledger，取消 Provider 任务并删除 staging；Provider 不可用时条目保留并在下一次启动重试。

权限决定回执按运行时工作目录下的 `permission-receipts.json` 原子写入，回执只包含身份、决定、状态、拒绝原因和动作摘要 digest，不包含工具输入或凭据；内存与文件最多保留最近 4096 个复合 identity。文件写入失败不会改变 Runtime 的授权判断，但应通过 Runtime 诊断暴露，发布环境必须监控该路径的可写性。

`sdkApiVersion` 不匹配时插件不得加载。破坏性契约变更必须提升 SDK major/API version，并在 Bibit 中保留明确迁移窗口。

## 9. 模块交付清单

- `bibit.feature.json` 通过 Schema 和语义校验。
- `npm ci && npm run typecheck && npm run build:dev` 通过。
- Dev Host 中逐一检查所有 page/settings/permission contribution。
- Settings 预览只有一层宿主页头/菜单，且没有内容区横向溢出提示。
- 插件 CSS 通过越界 selector 校验，类名和全局命名使用 Feature id 前缀。
- `npm run build:plugin` 使用既有命令生成签名 bundle。
- 平台仓库的 `yarn test:trusted-plugin-interop` 会构建 Security 0.2.3 与 Agent Hub 0.3.0 兼容 fixture，并把两个 SDK 产物交给同一个 Rust 安装器。升级构建器、签名格式、Manifest 或安装器时必须通过。
- 用目标 Bibit 的信任公钥配置完成一次安装、激活、刷新、停用和回退。
- 外部服务模块另附 operation DTO 与平台 adapter 需求；Security 另附允许、拒绝、失败重试和超时验收。
- 使用文件任务时另附 Provider v2 协商、上传/下载哈希、取消、页面重进恢复、staging 清理和 Feature instance 回收证据。
- 交付固定 Git commit SHA、SDK 版本、bundle SHA-256 和签名 key id，不只交付会变化的 `main` 链接。

## 10. 当前边界

v1 支持公司签名、`desktop/main`、页面、设置、权限 presenter、Service capability、FileGrant 和异步 Job。Provider 进程由 Bibit Broker 根据系统 Registry 管理，不属于插件后台代码。暂不提供第三方沙箱、在线自动更新市场、跨应用重启的 Job 持久化或运行时热替换已挂载插件；开发工作台支持源码热更新，Bibit 中的版本切换通过 UI 刷新生效。
