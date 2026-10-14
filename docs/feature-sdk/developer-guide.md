# Bibit Internal Feature SDK 开发者手册

> 面向模块开发者。本文是一份可执行接入契约，不是架构概览。
>
> 适用版本：`manifestSchemaVersion = 1`、`sdkApiVersion = 1`。当前 SDK 状态仍为
> `foundation / experimental`，公共契约的事实来源始终是仓库中的 Schema 和 TypeScript 类型。
>
> 本文主体描述随 Bibit 编译的 workspace Feature。模块需要独立仓库、单独构建和安装时，请直接使用 [可信插件指南](./trusted-plugin-guide.md)。两种交付方式复用同一 Manifest、Feature Module 与 Host API 契约。

## 1. 阅读后的完成目标

完成本手册后，一个内部模块应当能够：

- 作为 `features/<feature-id>` 下的 Yarn workspace 随 Bibit 一起编译发布；
- 自动出现在主导航或设置导航，不修改宿主导航清单；
- 在固定 Feature namespace 中实现列表、详情、编辑、弹窗和深链等复杂界面；
- 通过 Host API 调用模块对应的外部系统服务，不在 Feature 中持有 URL 或凭据；
- 对需要权限审批的 Feature，通过统一 `PermissionPresenterHost` 自定义确认界面；
- 在构建期被 Manifest Schema、Registry、能力 grants、Feature boundary lint 和测试门禁检查；
- 在模块失败时只影响自己的区域，不破坏 Bibit 其他页面或默认权限确认组件。

本文同时说明哪些工作可以由模块团队独立完成，哪些工作必须由 Bibit 平台维护者完成。

## 2. 先确认当前能力是否已经端到端可用

| 能力 | 当前状态 | 模块团队能否独立接入 |
| --- | --- | --- |
| 主页面 `pages` | 已接入路由、导航、lazy loader、错误边界 | 可以 |
| 复杂设置 `settings` | 已接入 Settings Shell、深链和相对导航 | 可以 |
| Security `permission-presenter` | 已接入当前 tool approval 和 Hermes Runtime 权限链路 | 可以，但只能有一个正式 presenter |
| 外部 Store/Memory/Security 服务 | Host API 契约已存在，但默认 capability Registry 目前为空 | 不可以；需平台维护者同时注册 adapter |
| 其他对话 kind（`tool-result`、`plan`、`diff`、`terminal`） | v1 已从 Manifest、SDK 和 Host 中移除，Schema 与 Native 校验直接拒绝 | 不可以；需先升级公共契约并补统一消息事件分发 |
| 新 icon、navigation group | 声明值是开放 token；宿主不认识时降级呈现（通用图标、回退分组） | 可以直接声明，插件无需等框架先行 |
| 新 capability | 除 `service:<id>` 外仍是封闭枚举，未知 capability 不授权 | 不可以直接扩展；需先升级公共契约、Schema 和 UI Kit |
| 新 WebView surface 或 mobile target | v1 仅 `desktop/main` | 不可以；需平台级设计 |

遇到“当前状态为平台缺口”的场景时，Feature Agent 必须停在清晰的接口边界上，提交平台缺口说明，不能绕过 SDK 直接调用宿主私有代码。

### 2.1 已发生问题与强制门禁

首个 Security trusted plugin 的真实接入暴露了以下问题。后续模块不得依赖人工经验规避，必须通过对应门禁消除：

| 现象 | 根因 | 强制门禁 |
| --- | --- | --- |
| 进入插件设置后宿主“设置”标题或菜单滚动消失 | 插件重复渲染 `main/header/aside` 和外层滚动容器 | settings contribution 只渲染内容；Dev Host 必须无 nested-shell/overflow 报警 |
| 页面拥挤、反复切换后卡顿 | 固定宽度第二侧栏、横向溢出，以及未清理 listener/observer/timer/request | 760px 和窄内容区验证；切换 50 次；卸载时清理所有副作用 |
| 插件样式影响宿主或其他插件 | 使用 `:root`、`body`、`#root`、裸 `*` 或未加 Feature 前缀的全局 CSS 名称 | `build:plugin` CSS 门禁必须通过；禁止运行时插入全局样式绕过检查 |
| 插件加载成功但设置页显示服务不可用 | capability、Registry、Adapter 和业务后端是四个独立环节 | 按“插件加载 → Registry → 协议探针 → Bibit 业务请求”逐层验收 |
| 页面在 capability 存在时误报“已连接” | 把 capability grant 或端口监听当成业务健康 | 只有一次真实、成功且 DTO 合法的业务 operation 才能显示已连接 |
| Dev Host 正常、真实 Bibit 白屏或 DTO 不兼容 | Mock 与 Adapter 返回结构不同，或只验证了浏览器预览 | operation/DTO 以模块 contracts 为唯一来源，并同步 Mock、Adapter 和协议测试 |
| 系统安装后仍需写用户目录才能工作 | 缺少模块独立的系统 Registry drop-in | deb 只安装 `/etc/bibit/external-services.d/<service>.json`，不得修改 `/home/<user>` |

开发者不得通过插件直连后端、复制宿主布局、关闭 CSS 校验或写用户 Registry 来“临时修好”以上问题。这些做法会把平台缺口变成每个插件各自维护的隐性耦合。

## 3. 强制架构边界

```text
Feature React UI
  │
  ├─ 页面/设置 ──> FeatureModuleV1 ──> Generated Registry ──> Bibit Host
  │
  ├─ 外部数据 ──> useFeatureCapability ──> Host service adapter ──> 外部系统服务
  │
  └─ 权限决定 ──> PermissionPresenterProps.decide ──> Runtime Gateway
                                                        │
                                                        └─ 唯一最终权威
```

模块前端和 Bibit 同仓编译，属于可信内部代码，但仍必须遵守最小依赖边界：

- Feature 只依赖 `@bibit/feature-contracts`、`@bibit/feature-sdk`、`@bibit/feature-ui`、React 和 Feature 自有代码。
- 禁止导入 `@/...`、`web-app/src/...`、其他 Feature、`@tauri-apps/*`。
- 禁止直接使用 `fetch`、`WebSocket`、`EventSource` 及 axios/ky/got/undici 等网络库。
- 禁止访问 `window.core`、ServiceHub、宿主 Store 或直接调用 Tauri command。
- Feature 模块 import 顶层不得连接服务、注册全局监听器或产生业务副作用。
- 外部系统继续拥有领域数据、权限策略、持久化和业务规则；Bibit 中只放前端与窄 adapter。
- 权限 presenter 只展示请求并提交用户决定，不自行恢复 Runtime、不实现第二套审批状态机。

边界由 [`features/eslint.config.js`](../../features/eslint.config.js) 自动检查，不能用 eslint disable 绕过。

## 4. 标准目录

推荐模块使用以下结构：

```text
features/<feature-id>/
├── bibit.feature.json
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── bibit-feature.tsx           # 唯一公开模块入口
    ├── api/
    │   ├── contracts.ts            # operation DTO，仅数据类型
    │   └── use-<feature>-service.ts
    ├── pages/                       # 可选：主页面
    ├── settings/                    # 可选：设置列表/详情/编辑
    ├── conversation/                # 可选：权限 presenter 等
    └── __tests__/
```

不要从 `tests/fixtures/features` 复制生产依赖关系。fixture 是验证 SDK 的测试样例，不会进入生产 Registry；正式代码必须位于 `features/*`。

## 5. Golden Path：从零创建一个 Feature

以下用 `<feature-id>` 表示通过平台校验的任意内部 Feature ID。示例名称只说明接入形态，不定义模块职责。

### 第 1 步：创建 package

`features/<feature-id>/package.json`：

```json
{
  "name": "@bibit/feature-<feature-id>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bibitFeature": "./bibit.feature.json",
  "exports": {
    "./bibit-feature": "./src/bibit-feature.tsx"
  },
  "scripts": {
    "test": "tsc --noEmit && vitest run"
  },
  "dependencies": {
    "@bibit/feature-contracts": "workspace:*",
    "@bibit/feature-sdk": "workspace:*",
    "@bibit/feature-ui": "workspace:*"
  },
  "peerDependencies": {
    "react": "19.0.0",
    "react-dom": "19.0.0"
  },
  "devDependencies": {
    "@testing-library/dom": "10.4.1",
    "@testing-library/react": "16.3.0",
    "@testing-library/user-event": "14.6.1",
    "@types/react": "19.1.2",
    "@types/react-dom": "19.1.2",
    "jsdom": "26.1.0",
    "react": "19.0.0",
    "react-dom": "19.0.0",
    "typescript": "5.9.2",
    "vitest": "3.2.4"
  }
}
```

必须保持以下等式：

```text
Manifest id = <feature-id>
package name = @bibit/feature-<feature-id>
module export = ./bibit-feature
```

生成器会拒绝不一致的 package、越出 package 根目录的 Manifest/export，以及 symlink 逃逸。

`features/<feature-id>/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

`features/<feature-id>/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
```

把 `./features/<feature-id>` 加入根 [`vitest.config.ts`](../../vitest.config.ts) 的 `test.projects`。这是测试发现接线，不是业务特例。否则 Feature 自身测试不会被根测试命令发现。

### 第 2 步：写纯 JSON Manifest

`features/<feature-id>/bibit.feature.json`：

```json
{
  "manifestSchemaVersion": 1,
  "sdkApiVersion": 1,
  "id": "<feature-id>",
  "version": "0.1.0",
  "owner": "<team-id>",
  "display": {
    "titleKey": "<feature-id>:title",
    "fallbackTitle": "<English title>",
    "descriptionKey": "<feature-id>:description",
    "fallbackDescription": "<English description>",
    "iconKey": "feature"
  },
  "targets": ["desktop"],
  "requiredHostCapabilities": [],
  "contributions": {
    "pages": [],
    "settings": [],
    "conversation": [],
    "locales": ["en", "zh-CN"]
  }
}
```

Manifest 只能描述元数据，不能包含组件 import、服务 URL、Tauri command、header、token 或 API key。

#### v1 可用 token

| 类型 | 合法值 |
| --- | --- |
| target | `desktop` |
| surface | `main` |
| page navigation group | 开放 token。宿主已知 `workspace`、`library`、`tools`；未知值排在已知分组之后 |
| settings navigation group | 开放 token。宿主已知 `core`、`features`、`integrations`、`privacy`；未知值进入 `features` 分组 |
| iconKey | 开放 token。宿主已知集合见 `packages/feature-contracts/src/navigation.ts` 的 `FEATURE_ICON_KEYS`，图形见 `packages/feature-ui/src/icons/catalog.tsx`；未知值渲染通用图标 |

设置 navigation 可覆盖 `titleKey`、`fallbackTitle`、`iconKey`。`core` 设置还可用 `section: { id, titleKey?, fallbackTitle }` 聚合为普通设置列表中的与 Features 样式一致的静态标题分组；相同 id 的入口按 `order` 排列，未声明 section 时保持平铺。
| capability | `service:<serviceId>`；旧 `external-service:store/memory/security` 仅兼容；`runtime:permission`（声明专用，无可调用 API） |
| conversation kind | `permission-presenter` |

#### id、path 和 locale 规则

- Feature/contribution id：2–64 字符 kebab-case，例如 `memory-manager`。
- `path`：空字符串或相对 kebab-case segments，例如 `rules`、`items/detail`。
- 禁止以 `/` 开头；每个 segment 不得为 `.` 或 `..`；禁止 query、fragment、空 segment 和反斜杠。例如 `items/detail` 合法，`/items`、`items//detail`、`items/../detail`、`items?id=1` 非法。
- locale 必须包含 `en`，格式为 `en` 或 `zh-CN`。
- `descriptionKey` 与 `fallbackDescription` 必须同时出现或同时省略。
- `order` 是 `-10000` 到 `10000` 的整数；省略时使用宿主默认排序。
- 同一 Feature 内 page、settings、conversation 的 contribution id 全局唯一。
- 同一 surface 上 page/settings 最终 URL 不得重复或前缀重叠。
- `permission-presenter` 在同一 surface 上全局独占。

### 第 3 步：声明贡献

#### 主页面

```json
"pages": [
  {
    "id": "catalog",
    "path": "",
    "surfaces": ["main"],
    "navigation": { "group": "library", "order": 100 }
  }
]
```

最终 URL：`/features/<feature-id>`。如果 `path` 是 `catalog`，最终 URL 为
`/features/<feature-id>/catalog`。

#### 设置页面

```json
"settings": [
  {
    "id": "manager",
    "path": "",
    "surfaces": ["main"],
    "navigation": { "group": "privacy", "order": 100 }
  }
]
```

最终 URL：`/settings/features/<feature-id>`。Feature 可以在这个 namespace 内自行实现任意层级的列表、详情和编辑界面。

不要为列表页和详情页分别声明相互重叠的 `path: ""` 与 `path: "items"`。让一个 contribution 拥有 namespace，再使用 `subpath` 分发内部页面。

#### 权限 presenter

```json
"conversation": [
  {
    "id": "approval",
    "kind": "permission-presenter",
    "surfaces": ["main"],
    "order": 100
  }
]
```

Security Feature 同时在 `requiredHostCapabilities` 中声明 `runtime:permission`。这个 capability 是治理声明，不是供 Feature 调用 Runtime 的通用 hook；Feature 仍只能调用 presenter props 中的 `decide`。

### 第 4 步：提交 capability grant 申请，由平台 owner 批准

Manifest 申请的每项能力最终都必须出现在内置 [`config/feature-capability-grants.json`](../../config/feature-capability-grants.json) 或模块 deb 安装的 `/etc/bibit/feature-capability-grants.d/<module>.json`：

```json
{
  "version": 1,
  "features": {
    "store": ["service:store"],
    "memory": ["service:memory"],
    "security": ["service:security", "runtime:permission"]
  }
}
```

三重条件全部满足后，外部服务 capability 才可用：

1. Manifest 声明；
2. grants 文件批准；
3. 宿主注册了 capability 实现。

仅添加 grants 不会自动连接服务。Service Host API 由平台动态创建，但真实调用还必须存在 `/etc/bibit/external-services.d/<module>.json` 指向的 Provider。

所有权约定：模块团队提出 grant 需求并解释最小权限；平台 owner 审查其内容。内置模块由平台修改编译期文件；独立模块将批准后的 grant 作为 root-owned deb 文件安装，不要求修改或重编 Bibit。插件运行时不得生成或修改 grant。

### 第 5 步：实现 Feature Module

`src/bibit-feature.tsx` 只做 renderer 和 locale 的静态装配。下面是结构示意；只保留 Manifest 已声明的 contribution。

```tsx
import type { FeatureModuleV1 } from '@bibit/feature-sdk'
import { CatalogPage } from './pages/CatalogPage'
import { ModuleSettings } from './settings/ModuleSettings'

export const featureModule: FeatureModuleV1 = {
  sdkApiVersion: 1,
  // 仅当 Manifest 声明 pages.catalog 时保留。
  pages: {
    catalog: CatalogPage,
  },
  // 仅当 Manifest 声明 settings.manager 时保留。
  settings: {
    manager: ModuleSettings,
  },
  locales: {
    en: {
      title: 'Example Feature',
      description: 'Example description',
    },
    'zh-CN': {
      title: '示例模块',
      description: '示例说明',
    },
  },
}

export default featureModule
```

Manifest contribution id 必须和 Module map key 完全一致。Manifest 声明 `catalog`，就必须有 `pages.catalog`；否则路由能匹配，但 lazy loader 会显示 “Feature contribution renderer is missing”。该失败**只影响这一个入口**：同一插件的其他入口照常渲染，不会因为缺一个 renderer 拖垮整个插件；入口加载失败时宿主会在该入口给出局部错误与升级提示。

### 第 6 步：实现页面与复杂设置

页面与设置 renderer 都收到 namespace 内相对路由信息：

settings renderer 只负责当前菜单项的页面内容。Bibit 根据 Manifest 自动生成 submenu，并统一提供 `HeaderPage`、`SettingsMenu`、选中状态和滚动容器；插件不得导入这些宿主私有组件。`FeatureSettingsPage` 只用于内容标题和宽度排版，可按页面需要选用。完整的布局、CSS 禁用项、Dev Host 校验和验收要求见 [设置内容区与插件样式契约](./settings-content-contract.md)。

```ts
interface FeatureSettingsProps {
  language?: string // 宿主当前语言：en / zh-CN；缺省按 en 处理
  featureId: string
  contributionId: string
  subpath: string
  search: Readonly<Record<string, string | readonly string[] | undefined>>
  navigation: {
    push(subpath: string, search?: Record<string, string | readonly string[] | undefined>): void
    replace(subpath: string, search?: Record<string, string | readonly string[] | undefined>): void
    back(): void
  }
}
```

页面和设置 contribution 的 `language` 会随宿主语言设置更新，并通过 custom element 的 `bibitContext.props` 传入独立 React 根。插件应读取该 prop，不读取宿主私有 React context。Dev Host 可用 `<FeatureDevHost language="zh-CN" ... />` 验证中文，省略时使用 `en`。导航可见的 Feature 模块会在宿主首屏渲染前预加载并注册 `locales`，因此菜单不依赖用户先打开插件页面；中文资源键应使用 `zh-CN`。

复杂设置推荐采用 URL 驱动状态，而不是只把选中项放在内存中：

```tsx
import type { FeatureSettingsProps } from '@bibit/feature-sdk'
import {
  Button,
  FeatureEmptyState,
  FeatureSettingsPage,
} from '@bibit/feature-ui'

export function MemorySettings({
  subpath,
  search,
  navigation,
}: FeatureSettingsProps) {
  const detail = /^items\/([^/]+)$/.exec(subpath)

  if (detail) {
    const memoryId = decodeURIComponent(detail[1])
    return (
      <FeatureSettingsPage title="Memory detail">
        <MemoryEditor memoryId={memoryId} />
        <Button onClick={() => navigation.replace('', search)}>返回列表</Button>
      </FeatureSettingsPage>
    )
  }

  if (subpath !== '') {
    return <FeatureEmptyState title="页面不存在" description={subpath} />
  }

  return (
    <FeatureSettingsPage title="Memory" description="管理已保存的记忆">
      <MemoryList
        search={search}
        onOpen={(id) =>
          navigation.push(`items/${encodeURIComponent(id)}`, search)
        }
      />
    </FeatureSettingsPage>
  )
}
```

注意：当前 host 对 subpath 只接受合法相对 segments。业务 id 如果包含斜杠，不应直接作为 path segment；应使用稳定无斜杠 id 或映射后的安全 id。

页面必须包含以下局部状态：

- loading：使用 `Skeleton` 或等价的可访问状态；
- empty：使用 `FeatureEmptyState`；
- error/offline：使用 `FeatureErrorState`，只重试当前模块请求；
- incompatible：明确提示需要升级模块或服务，不要无限重试；
- unauthorized：引导用户完成宿主控制的重新认证，不展示 token；
- deep link：刷新详情 URL 后能够只根据 URL 与服务数据恢复页面；
- unmount/cancel：组件卸载时中止尚未完成的请求。

### 第 7 步：在 Feature 中调用外部服务

先在 `src/api/contracts.ts` 定义窄 DTO。不要把服务端原始响应类型直接扩散到整个 UI：

```ts
export interface ListAgentsInput {
  query?: string
  cursor?: string
  limit: number
}

export interface AgentSummary {
  id: string
  name: string
  description?: string
  version: string
}

export interface ListAgentsResult {
  items: readonly AgentSummary[]
  nextCursor?: string
}
```

在组件或模块自有 hook 中调用 capability：

```tsx
import { useEffect, useState } from 'react'
import {
  useFeatureCapability,
  type FeatureExternalServiceErrorV1,
} from '@bibit/feature-sdk'
import type { ListAgentsInput, ListAgentsResult } from './contracts'

export function useAgents(query: string) {
  const service = useFeatureCapability('service:store')
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; data: ListAgentsResult }
    | { status: 'error'; error: FeatureExternalServiceErrorV1 }
  >({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })

    if (!service) {
      setState({
        status: 'error',
        error: {
          version: 1,
          code: 'unavailable',
          message: 'Store capability is unavailable',
        },
      })
      return () => controller.abort()
    }

    const params: ListAgentsInput = {
      query,
      limit: 50,
    }

    service
      .request<ListAgentsResult>({
        serviceId: 'store',
        operationId: 'agents.list.v1',
        params,
        timeoutMs: 10_000,
        signal: controller.signal,
      })
      .then((data) => setState({ status: 'ready', data }))
      .catch((error: FeatureExternalServiceErrorV1) => {
        if (!controller.signal.aborted) setState({ status: 'error', error })
      })

    return () => controller.abort()
  }, [query, service])

  return state
}
```

Host API 默认 timeout 是 30 秒，合法自定义范围是 `1..300000` 毫秒。必须传有限正整数。

`params` 中出现以下名称或递归嵌套字段会被拒绝为 `incompatible`：URL、header、authorization、token、API key、cookie、credential、secret 等。Feature 传业务 id、筛选条件和业务 DTO；服务发现、transport、认证与凭据由 Host adapter 负责。

错误码处理：

| code | UI 行为 |
| --- | --- |
| `offline` | 显示离线状态和局部 Retry |
| `timeout` | 提示超时，允许 Retry |
| `unauthorized` | 不自动重试；引导重新认证 |
| `incompatible` | 提示版本/operation 不兼容 |
| `cancelled` | 用户或组件主动取消；通常不弹全局错误 |
| `unavailable` | 服务临时不可用；显示局部重试 |
| `provider_crashed` | CLI Provider 异常退出；可重试并关联诊断 |
| `resource_exhausted` | 超过请求/响应资源上限；缩小数据或改用 Job/FileGrant |
| `unknown` | 安全通用错误；可显示 `diagnosticId` 供排查 |

不得显示或记录 Host adapter 的原始异常。只使用映射后的安全 `message`、`code` 和 `diagnosticId`。

#### 长时文件操作：FileGrant + Job

不要用 `service.request()` 携带文件内容、路径或长轮询。需要上传、下载、进度、取消或页面重进恢复时，同时申请 `service:<serviceId>`、`file:transfer` 和 `job:manage`：

```tsx
const files = useFeatureCapability('file:transfer')
const jobs = useFeatureCapability('job:manage')

const grant = await files?.select({
  version: 1,
  serviceId: 'store',
  operationId: 'agents.upload.v1',
  direction: 'upload',
})

if (grant && jobs) {
  const { job } = await jobs.start({
    version: 1,
    serviceId: 'store',
    operationId: 'agents.upload.v1',
    idempotencyKey: globalThis.crypto.randomUUID(),
    grantId: grant.grantId,
    input: { displayName: grant.displayName },
  })

  const unsubscribe = jobs.subscribe(
    { version: 1, jobId: job.jobId, afterSequence: job.lastSequence },
    ({ snapshot }) => setTransfer(snapshot)
  )
  // 组件卸载只 unsubscribe；只有明确的用户动作才调用 jobs.cancel。
}
```

Feature 永远看不到绝对路径，Provider 只接收其数据目录下的相对 resource。页面挂载时用 `jobs.list(serviceId)` 恢复同一 Bibit 进程、同一 Feature instance 的任务；不要宣称跨应用重启持久化。完整代码、状态机、Dev Host 注入、Provider v2 和验收清单见 [FileGrant 与异步 Job 开发指南](./file-transfer-and-jobs.md)。

### 第 8 步：平台维护者注册真实 Host adapter

这一部分不属于 Feature 私有目录，但是真实数据链路不可缺少。模块 Agent 如果没有获准修改宿主，应输出 operation DTO 和 adapter 需求，让平台维护者实现。

推荐在 `web-app/src/features/host-api/adapters/<feature-id>.ts` 建立窄桥接。下面的 factory 本身可以编译；它通过参数接收项目实际的服务 bridge，避免在模板里虚构服务客户端：

```ts
import { createExternalServiceApi } from '../externalService'

type ListAgentsInput = { query?: string; limit: number; cursor?: string }
type ListAgentsResult = {
  items: readonly { id: string; name: string; version: string }[]
  nextCursor?: string
}

export interface StoreServiceBridge {
  listAgents(
    input: ListAgentsInput,
    options: { signal: AbortSignal }
  ): Promise<ListAgentsResult>
}

const validateListAgentsInput = (
  params: Readonly<Record<string, unknown>>
): ListAgentsInput => {
  const allowed = new Set(['query', 'limit', 'cursor'])
  if (
    Object.keys(params).some((key) => !allowed.has(key)) ||
    (params.query !== undefined && typeof params.query !== 'string') ||
    (params.cursor !== undefined && typeof params.cursor !== 'string') ||
    typeof params.limit !== 'number' ||
    !Number.isInteger(params.limit) ||
    params.limit < 1 ||
    params.limit > 100
  ) {
    throw Object.assign(new Error('invalid agents.list.v1 input'), {
      code: 'INCOMPATIBLE',
    })
  }
  return {
    ...(typeof params.query === 'string' ? { query: params.query } : {}),
    ...(typeof params.cursor === 'string' ? { cursor: params.cursor } : {}),
    limit: params.limit,
  }
}

export const createStoreFeatureApi = (bridge: StoreServiceBridge) =>
  createExternalServiceApi('store', {
    'agents.list.v1': ({ params, signal }) =>
      bridge.listAgents(validateListAgentsInput(params), { signal }),
  })
```

项目相关的服务发现和 transport bridge 由平台 owner 提供。注册点需要显式 import；以下是接线形状，其中 `storeServiceBridge` 必须替换为仓库中真实、经过审查的实现：

```ts
import { createStoreFeatureApi } from './adapters/store'
import { storeServiceBridge } from '@/services/<approved-store-bridge>'

const storeFeatureApi = createStoreFeatureApi(storeServiceBridge)
```

如果仓库尚无 approved bridge，这一步就是阻塞项，不能用 `fetch` 临时填充。

Host adapter 必须：

- 对每个 `operationId` 校验 input DTO，拒绝未知字段；
- 将外部服务响应投影成稳定 DTO，不把 transport 对象交给 Feature；
- 使用宿主拥有的认证、服务发现、代理和网络策略；
- 传播 `AbortSignal`，设置下游 timeout；
- 映射 401/403、426、503、offline 和 timeout；
- 清除日志中的 URL、headers、credential 和原始敏感 payload；
- 为每个 operation 写成功、取消、超时、错误映射和敏感字段测试。

然后在 [`web-app/src/features/host-api/index.ts`](../../web-app/src/features/host-api/index.ts) 的 `hostCapabilities` 注册。只注册本次已经实现的 API；不要为了让示例编译而引用不存在的 `memoryFeatureApi` 或 `securityFeatureApi`：

```ts
const hostCapabilities: FeatureCapabilityRegistry = {
  'service:store': storeFeatureApi,
}
```

不要把 `runtime:permission` 注册为可任意调用的 external service。权限往返继续由 Runtime adapter 和 `PermissionPresenterHost` 管理。

### 第 9 步：实现 Security 权限 presenter

Manifest 声明 `permission-presenter` 后，在 Module 中用相同 id 注册：

```tsx
import type { PermissionPresenterProps } from '@bibit/feature-sdk'
import { Button } from '@bibit/feature-ui'

const KNOWN_DECISIONS = new Set(['allow_once', 'deny'])

function isValidPermissionRequest(
  request: PermissionPresenterProps['request']
) {
  const createdAt = Date.parse(request.createdAt)
  const expiresAt = Date.parse(request.expiresAt)
  const identityIsValid = Boolean(
    request.runtimeInstanceId &&
      request.runtimeId &&
      request.runtimeEpoch &&
      request.sessionId &&
      request.threadId &&
      request.runId &&
      request.requestId &&
      request.toolCallId &&
      request.action.name &&
      request.action.summary &&
      Number.isFinite(createdAt) &&
      Number.isFinite(expiresAt) &&
      expiresAt > Date.now()
  )
  return (
    identityIsValid &&
    request.supportedDecisions.length > 0 &&
    request.supportedDecisions.every((decision) =>
      KNOWN_DECISIONS.has(decision)
    )
  )
}

export function SecurityPermissionPresenter({
  request,
  decide,
  viewState,
}: PermissionPresenterProps) {
  const valid = isValidPermissionRequest(request)
  const identity = {
    runtimeInstanceId: request.runtimeInstanceId,
    runtimeId: request.runtimeId,
    runtimeEpoch: request.runtimeEpoch,
    sessionId: request.sessionId,
    threadId: request.threadId,
    runId: request.runId,
    requestId: request.requestId,
    toolCallId: request.toolCallId,
  }
  const disabled =
    viewState.status === 'submitting' || viewState.status === 'resolved'

  return (
    <section
      role="region"
      aria-label="Agent 权限确认"
      aria-labelledby={`permission-${request.requestId}`}
      aria-describedby={`permission-summary-${request.requestId}`}
    >
      <h2 id={`permission-${request.requestId}`}>Agent 请求权限</h2>
      <p id={`permission-summary-${request.requestId}`}>
        {request.action.summary}
      </p>

      {!valid ? (
        <p role="alert">
          权限请求身份、decision 集合或有效期无效，只能拒绝本次操作。
        </p>
      ) : null}

      {request.supportedDecisions.includes('deny') ? (
        <Button
          disabled={disabled}
          onClick={() =>
            void decide({
              version: 1,
              ...identity,
              decision: 'deny',
              reason: 'user-denied',
            })
          }
        >
          拒绝
        </Button>
      ) : null}

      {valid && request.supportedDecisions.includes('allow_once') ? (
        <Button
          disabled={disabled}
          onClick={() =>
            void decide({
              version: 1,
              ...identity,
              decision: 'allow_once',
            })
          }
        >
          仅允许本次
        </Button>
      ) : null}
    </section>
  )
}
```

```ts
export const featureModule: FeatureModuleV1 = {
  sdkApiVersion: 1,
  settings: { rules: SecurityRulesSettings },
  permissionPresenters: { approval: SecurityPermissionPresenter },
  locales: { /* ... */ },
}
```

权限 presenter 的强制规则：

- 只显示 `request.supportedDecisions` 明确允许的决定；v1 只支持 `allow_once/deny`。
- 未识别 decision、缺少 identity 或映射失败时必须 deny/fail closed，不能降级成 allow once。
- 使用传入的 `requestId`；禁止自己生成审批 id。
- `decide` 是异步的；提交中禁用重复点击，Promise settle 后恢复组件可操作状态。Runtime/IPC 错误由宿主容器呈现，Feature 不读取原始异常。
- 不直接调用 `runtime_permission_resolve`、Tauri invoke 或 Runtime Store。
- 不把组件卸载、路由切换或 React StrictMode cleanup 自行解释成允许。
- loader/render 失败时宿主会显示 Builtin presenter；Feature 不应移除该 fallback。
- `action.details` 已是宿主投影，仍应按字段渲染，避免无界 JSON 或把内容复制到日志。

至少为 `['unknown']`、`['allow_once', 'unknown']`、缺失 runtime epoch/run/tool identity、非法日期和已过期 `expiresAt` 编写负向测试；这些情况均不得渲染任何 Allow 按钮。

### 第 10 步：生成 Registry

完成 package、Manifest 和 grants 后运行：

```bash
yarn install
git diff -- yarn.lock
yarn feature:registry
git diff -- web-app/src/features/generated/feature-registry.gen.ts
yarn feature:registry:check
yarn install --immutable
```

新增 workspace 会改变 `yarn.lock`，因此第一次使用普通 `yarn install` 更新并提交 lockfile；最后用 `--immutable` 模拟 CI，确认仓库声明完整。

必须提交生成后的 [`feature-registry.gen.ts`](../../web-app/src/features/generated/feature-registry.gen.ts)，但禁止手工编辑它。

Registry 生成器会验证：

- JSON Schema 与 SDK 版本；
- package name、Manifest id、export target；
- capability grants；
- 重复 Feature/contribution id；
- page/settings URL overlap；
- 全局独占 permission presenter；
- 规范化输入 SHA-256 与生成文件 freshness。

新增合规 Feature 不应修改 `NavMain`、`SettingsMenu`、TanStack route tree 或根布局业务清单。导航和固定 namespace 路由由 Registry 自动投影。

## 6. 示例边界

本文中的 Store、Memory、Security、operationId、URL 和页面名称都是非规范示例。平台不规定 Feature 必须实现哪些页面、操作、数据字段或工作流。

接入时只按实际需要组合公开能力：

- 页面或复杂设置使用 page/settings contribution 与 Feature namespace；
- 外部调用只能使用当前 contracts 中已批准的 capability；
- 新访问类别先按 [Host capability 规范](./host-capabilities.md)升级公共契约，不能自行拼接 capability ID；
- 权限审批使用 `permission-presenter`、完整 Runtime identity、异步 `decide` 和结构化 receipt；
- 模块自行定义并版本化 operation DTO，平台只审查 Host adapter、安全边界和兼容证据。

开发态 Security Demo 是权限 Presenter 的参考实现，不是模块或业务规范。可通过 `yarn dev:security-demo` 启动。

## 7. 测试要求

### Feature 自身测试

每个正式 Feature 按其实际 contribution 和 operation 覆盖适用项：

- Module export 的 `sdkApiVersion` 和 renderer key；
- 主成功路径；
- loading、empty、offline/timeout/incompatible；
- request cancel/unmount；
- 页面或设置 deep link；
- mutation 重复点击和失败恢复；
- permission presenter 的 allow/deny、decision 过滤、异步失败和可访问性（若声明）。

测试 Host API 时注入假的 `FeatureHostApiProvider`，不要 mock 宿主私有 Store。

最小 Host API 注入形状：

```tsx
import { render, screen } from '@testing-library/react'
import {
  FeatureHostApiProvider,
  type FeatureHostApiV1,
} from '@bibit/feature-sdk'
import { vi } from 'vitest'
import { StoreCatalogPage } from '../pages/StoreCatalogPage'

const request = vi.fn().mockResolvedValue({ items: [], nextCursor: undefined })
const fakeHostApi = {
  sdkApiVersion: 1,
  featureId: 'store',
  grantedCapabilities: ['service:store'],
  getCapability: () => ({ request }),
} as FeatureHostApiV1

it('loads Store through its granted Host API', async () => {
  render(
    <FeatureHostApiProvider value={fakeHostApi}>
      <StoreCatalogPage />
    </FeatureHostApiProvider>
  )
  expect(await screen.findByText('No agents found')).toBeTruthy()
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      serviceId: 'store',
      operationId: 'agents.list.v1',
    })
  )
})
```

Memory deep-link 测试至少直接传入 `subpath: 'items/<id>'` 和查询条件，并断言返回列表时 `navigation.replace('', search)`；Security 负向测试至少构造完整 Runtime identity，然后把 `supportedDecisions` 强制设为 `['allow_once', 'future-decision']`，断言没有任何 Allow 按钮但仍有 Deny：

```tsx
import { render, screen } from '@testing-library/react'
import type { PermissionPresenterProps } from '@bibit/feature-sdk'
import { vi } from 'vitest'
import { SecurityPermissionPresenter } from '../conversation/SecurityPermissionPresenter'

it('fails closed when the Runtime includes an unknown decision', () => {
  const request = {
    version: 1,
    runtimeInstanceId: 'hermes:epoch-1',
    runtimeId: 'hermes',
    runtimeEpoch: 'epoch-1',
    sessionId: 'thread-1',
    threadId: 'thread-1',
    runId: 'run-1',
    requestId: 'request-1',
    toolCallId: 'tool-1',
    action: { kind: 'tool', name: 'shell', summary: 'Run shell' },
    supportedDecisions: ['allow_once', 'future-decision'],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as PermissionPresenterProps['request']

  render(
    <SecurityPermissionPresenter
      request={request}
      surface="main"
      viewState={{ status: 'pending' }}
      decide={vi.fn()}
    />
  )
  expect(screen.queryByRole('button', { name: /允许/ })).toBeNull()
  expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy()
})
```

### 宿主集成测试

涉及新 Feature 时，至少增加一条宿主集成测试，验证生成 Registry entry 可以 lazy load，Manifest contribution id 能找到 Module renderer，路由/导航或 presenter 真实装配成功。

最小 Registry/Module 对齐检查可放在 `web-app/src/features/__tests__`：

```ts
import { expect, it } from 'vitest'
import { featureRegistry } from '@/features/generated/feature-registry.gen'
import { unwrapFeatureModule } from '@/features/host/loadFeatureModule'

it('loads the Store renderer declared by its Manifest', async () => {
  const entry = featureRegistry.find((item) => item.manifest.id === 'store')
  expect(entry).toBeDefined()
  const module = unwrapFeatureModule(await entry!.load())
  const contributionId = entry!.manifest.contributions.pages[0]?.id
  expect(contributionId).toBe('catalog')
  expect(module.pages?.[contributionId!]).toBeDefined()
})
```

涉及外部服务 adapter 时，测试：

- 仅已注册 operation 可调用；
- timeout 与 AbortSignal；
- 未声明/未 grant/未实现 capability 返回不可用；
- 敏感 transport 字段被拒绝；
- 错误被映射且不泄露原始异常。

### 提交前完整命令

```bash
yarn feature:registry
yarn feature:registry:check
yarn workspace @bibit/feature-<feature-id> test
yarn test:features
yarn test:web
yarn lint
yarn build:web
git diff --check
```

### 开发启动与路由 smoke

纯 UI/路由开发可以运行：

```bash
yarn feature:registry
yarn dev:web
```

然后打开该 Feature 实际声明的 URL，例如：

```text
http://localhost:1420/features/<feature-id>
http://localhost:1420/settings/features/<feature-id>
http://localhost:1420/settings/features/<feature-id>/<subpath>
```

Web 模式只能验证 UI、lazy load、路由和 capability unavailable 状态。真实 Host adapter、Tauri IPC、文件 scope 和 Hermes 权限必须在 desktop debug 中验证：

```bash
BIBIT_HERMES_ACP_EXPERIMENTAL=true yarn dev:tauri
```

正式 Security 接入时不要设置 `BIBIT_SECURITY_DEMO=true`。

平台与 Security Demo 联合验收可直接运行：

```bash
yarn dev:security-demo
```

根脚本会构建 Tauri plugin API、Core 和扩展，并为开发调试关闭 updater 初始化；不需要在
`src-tauri` 中单独执行 `cargo run`。

### Security/Runtime 精确门禁

下面的 Rust tests 会展开 Tauri `generate_context!()`，因此先生成
`web-app/dist`；在干净 worktree 中不要跳过第一条命令：

```bash
yarn build:web

yarn workspace @janhq/web-app exec vitest run \
  src/features/conversation/__tests__/PermissionPresenterHost.test.tsx \
  src/components/__tests__/RuntimeEventPart.test.tsx

cargo test --manifest-path src-tauri/Cargo.toml --lib \
  runtime::gateway::tests::permission_resolve_is_bound_to_the_run_and_idempotent \
  -- --exact

cargo test --manifest-path src-tauri/Cargo.toml \
  --no-default-features --features cli,runtime-test-agent \
  --test hermes_acp_driver

cargo test --manifest-path src-tauri/Cargo.toml \
  --no-default-features --features cli,runtime-test-agent \
  --test fake_acp_agent
```

desktop 手工验收至少完成：

1. 启动 Hermes Runtime 并产生一个真实权限请求；
2. 确认由正式 Security presenter 渲染，不出现第二套审批按钮；
3. Allow once 后 Agent 仅继续本次操作；
4. 新请求选择 Deny 后 Agent 不执行受保护操作；
5. 快速双击只产生一次决定；
6. 模拟 IPC 失败后显示宿主错误且仍可拒绝/重试；
7. presenter loader/render 失败时 Builtin fallback 可用；
8. 后端 expiry、Runtime 关闭和主窗口关闭均不产生隐式 allow；
9. status popup 不能直接提交决定；
10. 用键盘完成读取、拒绝、允许，焦点和读屏名称正确。

任何 allow/deny 重复、非主窗口可授权、未知 scope 出现 Allow 或失败后 Runtime 继续执行，都是停止合入条件。

### 生产桌面打包

`yarn build:web` 只证明 Web 生产 bundle。Linux/DEB 交付还需在具备 Tauri 系统依赖的构建机运行：

```bash
yarn build:deb:linux
```

检查 `src-tauri/target/release/bundle/deb/` 下产物，安装到隔离测试环境后重复该 Feature 声明的导航、深链、capability unavailable/错误态，以及适用的 Builtin permission fallback smoke。其他平台使用仓库对应的 `build:tauri:<platform>` 命令。若本地没有打包依赖，应明确记录为“待构建机/板卡验收”，不能用 `build:web` 替代。

## 8. CODEOWNERS 与评审边界

新增模块时同步更新 [`.github/CODEOWNERS`](../../.github/CODEOWNERS)：

```text
/features/<feature-id>/ @<module-owner>
/web-app/src/features/host-api/adapters/<feature-id>.ts @<module-owner> @<platform-owner>
```

建议评审拆成两个责任域：

- 模块团队：Feature UI、业务 DTO、状态与交互、模块测试；
- 平台团队：Manifest/SDK 变更、新 capability、grants、Host adapter、Tauri scope、Runtime 与生产门禁。

如果实现要求修改公共 contracts、Schema、Registry generator、固定路由或 `PermissionPresenterHost`，不要和普通 Feature PR 混在一起。先提交平台契约变更及迁移说明，再让模块消费新版本。

## 9. 常见错误

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| Registry 显示 0 个 Feature | 代码放在 fixture、package 缺 `bibitFeature`，或不在 `features/*` workspace | 创建正式 workspace 并检查 package 字段 |
| `generated Feature Registry is stale` | Manifest/grants/package 变了但未生成 | 运行 `yarn feature:registry` 并提交生成文件 |
| required capability not granted | Manifest 申请但 grants 未批准 | 更新 grants，并由平台 owner 审查 |
| capability 是 `undefined` | 声明、grant、宿主实现三者缺一 | 逐项检查；不要回退到 fetch/Tauri |
| renderer is missing | Manifest contribution id 与 Module map key 不一致 | 统一 id |
| duplicate/overlapping URL | 同一 namespace 声明了前缀重叠 contribution | 用一个 contribution + `subpath` 管理内部路由 |
| permission presenter conflict | 同一 surface 有多个正式 presenter | 只保留一个，其他改为普通设置或平台策略 |
| Feature test 没被执行 | 根 `vitest.config.ts` 未加入项目 | 添加 `./features/<id>` project |
| Feature import 被 lint 拒绝 | 导入了宿主私有代码、其他 Feature、网络或 Tauri | 改用公共 SDK/UI/Host API |
| upload/download 需要 URL/header | transport 泄漏进 Feature DTO | 在 Host adapter 内处理 URL、认证和下载 scope |
| Retry 后仍加载失败 | lazy import 错误或 Module export 不符合 v1 | 检查 default/featureModule export 和 sdkApiVersion |
| Security 点击允许无效 | scope 不支持、request 过期、identity 错配或 IPC 失败 | 显示结构化失败并允许拒绝/重试，不得扩权 |

## 10. 每个 PR 的完成定义

以下条目全部满足才算模块接入完成：

- [ ] 正式代码位于 `features/<id>`，不是 fixture 或 demo 目录；
- [ ] package name、Manifest id、Module export 一致；
- [ ] Manifest 只包含声明数据，通过 Schema 和语义校验；
- [ ] contribution id 与 Module renderer key 一致；
- [ ] 页面/设置深链刷新可恢复；
- [ ] settings renderer 遵守 content-only 契约，Dev Host 无内容区横向溢出；
- [ ] 插件 CSS 不包含 `:root`、`html`、`body`、`#root` 或裸 `*` selector；
- [ ] React、React DOM、`@bibit/feature-*` 和可选 `@bibit/feature-ui` 与目标 Bibit 发布矩阵完全一致；
- [ ] loading、empty、error、retry、cancel 状态完整；
- [ ] renderer 卸载会取消请求并清理 listener、observer 和 timer；
- [ ] Feature 不导入宿主私有代码、不直接联网、不调用 Tauri；
- [ ] 外部服务 capability 同时具备声明、grant、Host adapter 与测试；
- [ ] “已连接”由真实业务 operation 成功驱动，不由 capability、进程或端口状态驱动；
- [ ] 敏感字段不进入 Feature DTO、UI 或日志；
- [ ] Security presenter 对重复点击、失败、超时、关闭和错误 scope fail closed；
- [ ] Feature 单测和宿主集成测试已加入真实 CI 发现路径；
- [ ] 生成 Registry 已提交且 freshness check 通过；
- [ ] Feature boundary、全量 Web、lint、production build 通过；
- [ ] CODEOWNERS 指向真实模块与平台维护者；
- [ ] 用户可见流程完成 desktop debug 人工验收；
- [ ] 没有为了接入修改宿主导航清单、根 route tree 或加入 Feature 特例。

## 11. 可直接使用 的任务模板

将下面内容连同本文件路径交给负责模块的 Agent，并替换尖括号部分：

```text
你正在 Bibit 仓库中实现正式内部 Feature：<feature-id>。

首先完整阅读 docs/feature-sdk/developer-guide.md、
docs/feature-sdk/manifest-v1.md 和 docs/feature-sdk/host-capabilities.md。
以 packages/feature-contracts/schema/bibit-feature.schema.json 和公开 TypeScript
类型为最终事实来源，不根据测试 fixture 推断不存在的能力。

目标：
1. 在 features/<feature-id> 创建正式 Yarn workspace；
2. 实现 <主页面/设置页面/权限 presenter>；
3. 如需宿主能力，仅通过 <approved-capability-id> 调用；该 ID 必须已存在于公开 allowlist；
4. 实现 loading、empty、error、retry、cancel、deep link；
5. 添加 Feature 单测和宿主集成测试；
6. 生成并提交 Registry；
7. 运行开发手册列出的全部门禁。

范围边界：
- 外部系统的数据、认证、策略和持久化不迁入 Feature 前端；
- 禁止 Feature 直接 fetch/WebSocket/Tauri/window.core/ServiceHub；
- 禁止导入 @/、web-app/src、其他 Feature；
- 不修改 NavMain、SettingsMenu、route tree 或根布局业务清单；
- 如果 Host capability adapter 尚不存在，先输出 operation DTO 和平台缺口，
  仅在明确授权后修改 web-app/src/features/host-api；
- 如果需要新 icon/group/capability/surface/conversation dispatch，停止添加特例，
  将其作为公共 SDK 平台变更单独实现和评审；
- Security 权限只通过 PermissionPresenterProps.decide 返回，任何异常都 fail closed。

实现前先输出：
A. 计划创建/修改的文件；
B. Manifest contributions 和最终 URL；
C. required capabilities（Service 命名空间或显式 allowlist）、operation grants 与 Provider Registry 状态；
D. operationId 及 request/response DTO；
E. 测试矩阵。

实现后输出：
A. 文件级改动摘要；
B. Registry 生成结果；
C. 每条测试/构建命令及真实结果；
D. 未完成的平台依赖和人工验收项。

不要把 capability 未注册、真实 Tauri 未验收或仅 fixture 通过描述为功能完成。
```

## 12. 事实来源

公共契约发生冲突时按以下优先级判断：

1. [`bibit-feature.schema.json`](../../packages/feature-contracts/schema/bibit-feature.schema.json)
2. [`@bibit/feature-contracts`](../../packages/feature-contracts/src/index.ts)
3. [`@bibit/feature-sdk`](../../packages/feature-sdk/src/index.ts)
4. Registry generator 与 Feature boundary lint
5. 本手册和其他说明文档
6. `tests/fixtures/features` 示例

相关文档：

- [Feature SDK 概览](./README.md)
- [Manifest v1](./manifest-v1.md)
- [Host capabilities](./host-capabilities.md)
- [Migration guide](./migration-guide.md)
