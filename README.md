# BiBit GUI

公开版本：**1.0Beta1**。

BiBit GUI 是面向 Agent 系统助手的桌面前端。项目以 [Jan](https://github.com/janhq/jan) 为代码骨架，当前优先保留并演进对话交互、富消息、附件、会话历史、桌面容器和设置界面，为后续接入正式 Agent Runtime 提供稳定的产品界面。

## 当前范围

- 产品显示名：`BiBit`
- 桌面应用标识：`com.dc.bibit.gui`
- 默认数据目录：`BiBit/data`
- 默认助手显示名：`BiBit`
- 桌面端自动更新：默认关闭，尚未配置 BiBit 更新通道
- Agent Runtime：当前沿用 Jan 兼容实现，后续通过 Adapter 接入正式 Runtime

本次初始化不包含正式 Agent Runtime 的实现，也不批量重命名 Jan 的内部兼容标识。

## 技术结构

- 前端：React 19、TypeScript、Vite
- 桌面容器：Tauri 2
- 原生层：Rust
- 包管理：Yarn 4 Workspace

项目有意保留内部 `@janhq/*` 包名、默认助手 ID `jan`、Jan Model 名称、`jan-cli` 以及历史迁移标识。这些名称属于上游依赖关系或兼容边界，不代表最终产品品牌。

## 开发环境

Feature SDK 文档见 [`docs/feature-sdk/README.md`](docs/feature-sdk/README.md)。

基础要求：

- Node.js 20 或更高版本
- Corepack
- Yarn 4.5.3
- Rust 工具链
- Tauri 对应平台的系统依赖

安装依赖并构建核心包：

```bash
corepack yarn@4.5.3 install --immutable
corepack yarn@4.5.3 build:core
```

启动桌面开发环境：

```bash
corepack yarn@4.5.3 dev
```

仅启动 Web 前端：

```bash
corepack yarn@4.5.3 dev:web
```

构建 Web 前端：

```bash
IS_TAURI=true IS_DEV=false TAURI_ENV_PLATFORM=linux corepack yarn@4.5.3 build:web
```

构建 Linux Debian 包：

```bash
corepack yarn@4.5.3 build:deb:linux
```

产物位于 `src-tauri/target/release/bundle/deb/`。安装后不需要 Node.js、Yarn 或 Corepack。

仓库根目录同时维护标准 Debian 源码打包元数据。Bianbu 4.x
`riscv64` 构建机安装 `debian/control` 中的构建依赖后可直接执行；
`debian/rules` 会使用源码内固定的 Yarn 4.5.3 release，按锁文件安装依赖并
完成完整构建，不依赖构建机的 Corepack 版本；同时限制 Yarn WASM worker
并发，避免 RISC-V 首次安装依赖时耗尽内存：

这是 Bianbu 自研 native 包：`debian/source/format` 为 `3.0 (native)`，
`debian/bianbu.conf` 固定 `upstream = False` 和
`targetsuite = resolute-customization`。公开发布标签为 `1.0Beta1`。

```bash
sudo apt update
sudo apt build-dep .
dpkg-checkbuilddeps
dpkg-buildpackage -us -uc -b
```

该入口会通过 `debian/rules` 调用源码内固定的 Yarn 4.5.3 和 Tauri
Debian bundler，再由 debhelper 生成最终控制信息，产出
`../bi-bit_1.0.0~beta1_riscv64.deb`。需要限制并行度时可向标准命令追加
`-jN`，该设置会沿 GNU Make jobserver 传递给 Tauri 和 Cargo。

运行测试：

```bash
corepack yarn@4.5.3 test
```

Windows、macOS 和包含上游 Runtime 的完整桌面打包仍需下载相应运行时二进制、构建 CLI，并准备各平台签名和打包依赖，具体入口见根目录 `package.json` 和 `Makefile`。

## Runtime 接入边界

正式 Agent Runtime 由独立团队提供后，BiBit GUI 将通过 Adapter 接入会话、消息流、工具调用状态和任务事件。前端不直接依赖某个具体 Runtime 的内部实现，以便演示实现和正式实现可以替换。

## 发布说明

- Tauri 配置中不包含 Jan 桌面应用更新端点。
- 在 BiBit 签名密钥和更新服务就绪前，不启用桌面自动更新。
- 当前暂时沿用上游 Jan 图标资源；专用 BiBit 品牌素材准备完成后再替换。

## 上游与许可证

本仓库基于 Jan 项目构建：

- 上游仓库：<https://github.com/janhq/jan>
- 上游开发者：Menlo Research
- 产品仓库：<https://github.com/spacemit-com/bibit>

本仓库沿用上游的混合许可结构：根目录上游作品适用 Apache License 2.0，Rust/Tauri 主包及部分插件声明 MIT，`core` 与多个扩展声明 AGPL-3.0。每个组件以其 `Cargo.toml` 或 `package.json` 中的许可字段为准，完整许可文本见 `LICENSE`、`LICENSES/MIT.txt`、`LICENSES/AGPL-3.0.txt` 和 `NOTICE`。
