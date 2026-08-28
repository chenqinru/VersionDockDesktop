<p align="center">
  <img src="public/icon.png" alt="VersionDock Desktop logo" width="128">
</p>

<h1 align="center">VersionDock Desktop</h1>

<p align="center">
  <strong>基于 Tauri 2、Rust 和 React 打造的现代化独立 Git & SVN 桌面工作台</strong>
</p>

<p align="center">
  <a href="https://github.com/chenqinru/VersionDockDesktop/actions/workflows/ci.yml"><img alt="CI Status" src="https://img.shields.io/github/actions/workflow/status/chenqinru/VersionDockDesktop/ci.yml?branch=main&label=CI&logo=github"></a>
  <a href="https://github.com/chenqinru/VersionDockDesktop/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/chenqinru/VersionDockDesktop?color=green"></a>
  <a href="https://v2.tauri.app/"><img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.0-24C8D8?logo=tauri"></a>
  <a href="https://www.rust-lang.org/"><img alt="Rust" src="https://img.shields.io/badge/Rust-1.78%2B-DEA584?logo=rust"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-GPL--3.0-red"></a>
</p>

<p align="center">
  <a href="README.md"><strong>简体中文</strong></a> | <a href="README_en.md"><strong>English</strong></a>
</p>

VersionDock Desktop 是基于 Tauri 2、Rust、React 18 和 TypeScript 构建的高性能独立 Git/SVN 桌面端工作台。无需安装 VS Code，发布运行时无任何 Node.js 依赖，为多仓库协同、差异对比与版本管理提供极速流畅的桌面级原生体验。

---

## 🌐 生态系统

如果您更习惯在 VS Code 内部直接使用该工作流：

👉 欢迎使用 [**VersionDock (VS Code 扩展)**](https://github.com/chenqinru/VersionDock) —— 拥有完整一致的提交面板、图谱与冲突解决工作台。

---

## ✨ 核心能力

- **多根工作区与仓库智能感知**：支持多根目录、Git/SVN 混合与多层嵌套仓库，拖入即开。
- **Git 完整工作流**：Status、Diff、暂存/取消暂存、Commit/Amend、Commit & Push、Fetch/Pull/Push、提交历史、图谱与 Tag。
- **SVN 深度集成**：Status、Diff、自动 Add/Delete 后 Commit、Update、修订历史（Revision History）与详情。
- **三栏冲突解决（Merge Editor）**：Git/SVN 冲突列表、版本加载、防覆盖指纹校验与解决后自动暂存/标记。
- **高级版本控制工具**：Git Stash、本地补丁搁置（Shelf）、变更列表（Changelist）、托管 Worktree、分支对比（Branch Compare）与 Remote 管理。
- **身份多 Profile 与安全凭据**：支持工作区专属 Git Profile、系统安全钥匙串（Keychain）存储 SVN 凭据。
- **极致原生体验**：无边框窗口、平台原生按钮、系统/浅色/深色主题、中英双语、分栏状态持久化。

---

## 🛠️ 本地开发

### 环境要求
- **Node.js**: `20+`
- **Rust**: `stable` (1.78+)
- **System WebView**: 系统自带组件（macOS WebKit, Windows WebView2, Linux WebKit2GTK）
- **Git** / **SVN**: 按需安装

> Windows 上当前稳定的 SVN 1.14.5 CLI 会将命令行参数转换到系统 ANSI code page，无法可靠处理中文等超出该代码页的路径；1.15.0-rc3 源码同样尚未包含修复。此类路径需要使用包含 Apache Subversion r1935602 Unicode argv 修复的客户端。CI 会从固定源码提交构建并验证该能力，待修复进入正式版后再切换到对应稳定版本。

```bash
# 安装依赖
npm install

# 启动桌面开发环境（Tauri + Vite）
npm run tauri:dev
```

前端 UI 服务可单独启动（仅用于 UI 样式调试，真实仓库操作需通过 Tauri 运行）：
```bash
npm run dev
```

---

## 🧪 自动化测试与质量门禁

```bash
npm run check
```

该命令校验项目版本元数据，并串联执行独立性扫描、TypeScript、ESLint、Vitest、Vite build、Rust fmt、Clippy 和 Cargo tests。

生成并校验 Rust → TypeScript IPC 契约：
```bash
npm run bindings
npm run bindings:check
```

---

## 📦 打包构建

```bash
npm run tauri:build
```

- **macOS**：Apple Silicon / Intel 通用 `.dmg`、`.app`
- **Windows**：NSIS / MSI 安装包
- **Linux**：AppImage、deb、rpm

---

## 🛡️ 安全与设计边界

- **架构解耦**：React 前端仅依赖 `VersionDockBridge`，Tauri API 严格封装在平台层。
- **零 Shell 拼接注入**：Rust 端 Git/SVN 进程调用全部使用参数数组（`tokio::process::Command`），杜绝 Shell 注入漏洞。
- **严格路径白名单**：用户路径必须是仓库内相对路径，严格拒绝越界（Path Traversal）、NUL 字符和符号链接逃逸。
- **资源保护上限**：普通命令默认 120s 超时，网络命令 10 分钟，单路输出上限 20 MiB；超大 Diff 自动降级截断。
- **无污染存储**：App 状态写入系统标准配置目录，不污染用户代码仓库。

---

## 🤝 参与贡献

欢迎提交 Pull Request 和 Issue！请参考 [CONTRIBUTING.md](CONTRIBUTING.md) 了解详情。

- 🐛 [报告 Bug](https://github.com/chenqinru/VersionDockDesktop/issues/new?template=bug_report.yml)
- 💡 [提出 Feature](https://github.com/chenqinru/VersionDockDesktop/issues/new?template=feature_request.yml)
- 🔒 [安全政策](SECURITY.md)

---

## 📄 许可证

本项目采用 [GNU General Public License v3.0](LICENSE) 开源。
