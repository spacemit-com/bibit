# Bibit 设置内容区与插件样式契约

本契约适用于 workspace Feature 和 trusted plugin 的 `settings` contribution。目标是让模块只提供设置内容，由 Bibit 统一维护设置外壳，并阻止插件样式污染宿主或其他插件。

## 1. 所有权边界

| Bibit Host 负责 | 插件负责 |
| --- | --- |
| `HeaderPage`、“设置”标题、返回行为 | 当前 contribution 的内容标题和说明 |
| `SettingsMenu`、菜单项、选中态 | 列表、详情、表单和局部导航 |
| 内容区尺寸、滚动容器、主题 | 内容区内的 loading/empty/error 状态 |
| contribution 挂载和卸载 | 卸载时取消请求、订阅和定时器 |

设置 renderer 必须是 content-only。不得再渲染应用级 `main`、设置页头、设置侧栏或全屏滚动容器；不得导入 Bibit 私有的 `HeaderPage`、`SettingsMenu` 或路由实现。需要内容标题时可使用 `FeatureSettingsPage`，它不是 Settings Shell。

## 2. 布局要求

- 根节点必须适应父容器：`display: block; min-width: 0; max-width: 100%`。trusted plugin 的 Custom Element 根由 Host 自动设置这些约束。
- 使用容器可用宽度，不使用 `100vw`、固定桌面宽度或额外的应用级侧栏。
- 宽表格、代码块等局部区域自行 `overflow: auto`；不能让整个设置内容区产生横向溢出。
- 一个 contribution 只拥有自己的滚动状态。不要监听或修改 `document.body` 的滚动、尺寸和 class。
- 异步任务在 renderer 卸载时必须取消；事件监听、observer 和定时器必须清理，保证反复切换菜单不会累积资源。

## 3. CSS 隔离

trusted plugin 仍使用 Light DOM，以便复用与目标 Bibit 完全一致的 React 和 UI SDK 样式。Host 加载插件 CSS 时，会把样式限制在该插件 Manifest 声明的 Custom Element 根内；样式不会匹配宿主或其他插件。

`bibit-plugin build` 同时拒绝以下越界选择器：

```css
:root { }       /* 禁止 */
html { }        /* 禁止 */
body { }        /* 禁止 */
#root { }       /* 禁止 */
* { }           /* 禁止 */
*::before { }   /* 禁止 */
*::after { }    /* 禁止 */
```

局部 universal selector 必须有插件命名空间，例如：

```css
.security-plugin,
.security-plugin * {
  box-sizing: border-box;
}
```

类名和 CSS custom property 应使用 Feature id 前缀。`@keyframes`、`@-webkit-keyframes`、`@counter-style`、`@property` 名称以及 `@font-face` 的 `font-family` 必须使用 `<feature-id>-` 前缀；构建器会拒绝未加前缀的全局 CSS 名称。插件不得覆盖 Bibit token；需要主题颜色时优先使用 `@bibit/feature-ui` 暴露的 token。

## 4. 开发期门禁

```bash
npm run dev
npm run build:plugin
```

Feature Dev Host 对 settings contribution 使用与 Bibit 相同的“页头 + 子设置菜单 + 受限内容区”结构，而不是把设置 renderer 当作完整页面显示。Dev Host 会提示嵌套的 `main`/`role="main"` 外壳和内容区横向溢出；出现红色提示时，必须先消除重复外壳、固定宽度或额外侧栏。

`build:plugin` 会解析最终生成的 CSS；发现越界 selector 时直接失败，并报告生成 CSS 文件和 selector。不要通过压缩、动态插入 `<style>` 或运行时修改 `document` 绕过门禁。

## 5. 验收清单

- [ ] Dev Host 中只出现一个“设置”页头和一个设置菜单；
- [ ] 760px 及更窄窗口下无内容区横向溢出；
- [ ] 连续切换当前设置页与其他设置页 50 次，无卡死、重复监听或未取消请求；
- [ ] `build:plugin` 通过 CSS 越界校验；
- [ ] 插件样式不改变 Bibit 页头、菜单、其他页面和其他插件；
- [ ] 在目标 Tauri/WebKitGTK 中用 `getComputedStyle` 验证插件根样式生效，宿主 sibling 不受影响；
- [ ] 宽表格只在自身容器内滚动；
- [ ] 卸载后 observer、事件监听、定时器和请求均已清理。

验收失败时先修 renderer 根节点和副作用清理，不在 Bibit `HeaderPage`、`SettingsMenu` 或根滚动容器中增加插件特例。宿主对所有 settings contribution 使用同一布局契约。

Manifest 不新增 layout 配置：`settings` contribution 固定遵守 content-only 契约，避免每个模块重新选择外壳模式。
