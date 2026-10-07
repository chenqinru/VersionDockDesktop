<p align="center">
  <img src="./public/icons/versiondock-logo-dark.png" alt="VersionDock Desktop" width="128" height="128">
</p>

<h1 align="center">VersionDock Desktop</h1>

<p align="center">在一个独立桌面应用中管理 Git、SVN 和多个项目。</p>

<p align="center">
  <a href="https://github.com/chenqinru/VersionDockDesktop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/chenqinru/VersionDockDesktop/ci.yml?branch=main&amp;label=CI&amp;logo=github" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0"></a>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README_en.md">English</a> ·
  <a href="https://github.com/chenqinru/VersionDockDesktop/releases">下载安装</a> ·
  <a href="https://github.com/chenqinru/VersionDockDesktop/issues">问题反馈</a>
</p>

VersionDock Desktop 面向需要同时处理多个仓库的开发者：查看工作区改动、比较文件、组织提交、同步远端、浏览历史和解决冲突，都可以在同一个工作台完成。一个项目可以包含多个目录，也可以混合使用 Git 和 SVN。

应用基于 Tauri 2、Rust、React 和 TypeScript 构建，支持 macOS、Windows 和 Linux。日常使用不需要安装 VS Code 或 Node.js；仓库操作调用本机 Git / SVN 命令行工具。AI 功能按需配置，不影响普通版本管理操作。

## 下载安装

从 [GitHub Releases](https://github.com/chenqinru/VersionDockDesktop/releases) 选择对应系统的安装包：

| 系统 | 推荐安装方式 |
| --- | --- |
| macOS Apple Silicon / Intel | 下载 universal `.dmg`，打开后将应用拖入“应用程序” |
| Windows x64 | 下载 `-setup.exe` 并运行；发布版本也可提供 `.msi` |
| Linux x64 | 下载 `.AppImage`，添加执行权限后运行；发布版本也可提供 `.deb` / `.rpm` |

Linux AppImage 可使用 `chmod +x 文件名.AppImage` 添加执行权限。macOS 当前采用 ad-hoc 签名，没有 Apple Developer ID 签名或公证；首次打开时如被系统阻止，请在确认来源后通过“隐私与安全性”允许打开。

安装前准备好需要使用的工具：

- **Git 仓库**：Git 2.23 或更新版本。
- **SVN 工作副本**：SVN 1.9 或更新版本；使用应用保存密码的认证方式需要 SVN 1.10 或更新版本。

优先将工具加入 `PATH`。macOS 也会检查 Homebrew 和 MacPorts 常见安装路径；Windows 会检查 Git for Windows 注册表及常见安装目录。工具缺失或版本不满足要求时，应用会显示对应功能不可用的原因。

### 后续更新

默认在启动时检查更新，之后每 15 分钟及网络恢复时再次检查；也可在“关于与更新”中手动检查，或在设置中关闭自动检查。发现新版本后，按界面提示下载、安装并重启。

正式构建以 GitHub 为主更新源，并通过 GitCode 镜像提供备用下载；用户下载安装和更新不需要登录 GitHub 或提供镜像令牌。更新使用 macOS universal `.app.tar.gz`、Windows NSIS `.exe` 和 Linux `.AppImage`；发布版本也可提供有对应签名的 MSI、deb 或 rpm 更新入口。

更新包通过 Tauri 签名校验，这与操作系统的应用签名不同。仍使用旧 GitHub 下载仓库地址的客户端，需要手动安装使用新地址的版本一次；后续通过应用更新。

## 开始使用

1. 从欢迎页打开项目目录，或克隆远程 Git 仓库、初始化本地 Git 仓库。
2. 在工作区中选择仓库。应用会扫描项目目录中的 Git 仓库和 SVN 工作副本。
3. 在变更列表中选择文件，查看差异并组织提交；Git 支持暂存与取消暂存，SVN 支持选择要提交的文件。
4. 使用同步面板 Fetch / Pull / Push 或执行 SVN Update；在历史视图中查看提交、修订和文件变化。
5. 发生冲突时进入合并工作台，检查三方内容、编辑结果并完成解决。

项目以标签组织，支持多个窗口；常用项目可以从最近项目列表再次打开。界面提供简体中文、英文、多种深浅主题、紧凑与舒适布局，以及可调整的字体和面板尺寸。

## 功能

| 领域 | 当前能力 |
| --- | --- |
| 工作区与变更 | 多目录与嵌套仓库扫描、Git / SVN 混合工作区、文件树与平铺列表、变更列表、批量操作 |
| 提交与同步 | Git 暂存、Commit、Amend、Commit & Push、Fetch / Pull / Push；SVN 选中文件提交与 Update |
| 差异与历史 | 行内 / 并排差异、语法高亮、提交图谱、作者 / 日期 / 文本 / 路径筛选、文件历史、分支比较 |
| 冲突处理 | Git / SVN 冲突列表、三方合并编辑、保存前内容变化校验、解决后暂存或标记 |
| Git 工具 | 分支与标签、Stash、补丁搁置（Shelf）、Worktree、Submodule、Subtree、远端管理、未推送提交整理 |
| 身份与账号 | Git 提交身份配置、SVN 账号管理、GitHub / GitLab / Gitee 账号、远程仓库浏览与创建 / 发布 |
| 操作与保护 | 任务进度、取消、通知和日志；受保护分支确认、`--force-with-lease`、大文件和异常文件名提醒 |

Git 与 SVN 的可用操作不同，应用会按仓库类型、工具版本和当前状态提供相应入口。

### AI 辅助

配置后可用于生成提交信息、解释提交、审查变更、提出冲突解决结果，以及将改动拆分成多个提交。Git 还支持对未推送提交生成重组方案。冲突解决和提交编排先展示结果，由用户确认后应用。

在设置的 AI 页面选择一种执行方式：

- **API 提供商**：OpenAI、Claude、Gemini 或自定义兼容接口。OpenAI / 自定义接口可选择 Chat Completions 或 Responses 协议。
- **Agent CLI**：调用已安装并完成配置的 Claude、Codex、Antigravity 或 OpenCode，支持检测可执行文件、设置模型与超时。

API 模式需要填写模型、接口地址和密钥；CLI 模式需要对应工具及其账号环境。AI 会将当前任务所需的提交信息、差异或冲突上下文交给所选 API / CLI。API 密钥保存到系统安全存储；提示词可按全局或工作区编辑。

### 托管平台与凭据

GitHub 支持 Personal Access Token，以及构建配置允许时的 OAuth Device Flow；GitLab 支持自建 HTTPS 实例和 Token；Gitee 使用 Token。连接后可以浏览账号下的仓库、选择仓库克隆，以及创建远端并发布本地 Git 项目。

托管平台账号用于平台 API；Git 的 Fetch / Pull / Push 仍使用本机 Git 的 SSH、HTTPS 和凭据配置。应用将托管平台 Token、SVN 密码和 AI API 密钥保存在系统安全存储中，普通设置与工作区状态保存在应用配置目录。在线作者头像可在设置中关闭。

## 本地开发

### 环境

| 工具 | 要求 |
| --- | --- |
| Node.js | 20 或更新版本，使用 npm |
| Rust | `rust-toolchain.toml` 固定为 1.99.0，包含 rustfmt 和 Clippy |
| 原生构建依赖 | macOS：Xcode Command Line Tools；Windows：MSVC Build Tools 与 WebView2；Linux：WebKitGTK 4.1、AppIndicator 等 Tauri 依赖 |
| Git / SVN | 仓库操作与集成测试使用真实命令行工具，版本要求同上 |
| minisign | 发布测试与更新包签名校验使用；macOS 可用 `brew install minisign`，Ubuntu 可用 `sudo apt-get install minisign` |

各平台完整系统依赖见 [Tauri 环境准备](https://v2.tauri.app/start/prerequisites/)，CI 使用的安装步骤见 [工作流配置](.github/workflows/ci.yml)。

```bash
git clone https://github.com/chenqinru/VersionDockDesktop.git
cd VersionDockDesktop
npm ci
npm run tauri:dev
```

开发模式默认启用 Vite 热更新，并在 Rust 源码变化后重新编译应用。操作应用自身仓库时，可运行 `npm run tauri:dev -- --stable` 暂时关闭监听，避免 checkout 等操作触发重载。

仅调试前端时使用 `npm run browser:dev`。该模式使用开发 Bridge 演示界面，真实仓库操作应在 Tauri 应用中验证。

GitHub OAuth Device Flow 需要在构建时设置 `VERSIONDOCK_GITHUB_CLIENT_ID`；未设置时仍可使用 GitHub PAT、GitLab 和 Gitee。仅 debug / test 构建可设置 `VERSIONDOCK_ALLOW_INSECURE_PROVIDER_HOSTS=1` 测试 HTTP GitLab，HTTPS 的证书校验保持启用。

Windows SVN 客户端如果使用 ANSI 命令行参数，可能无法处理中文等路径。CI 使用包含 Apache Subversion r1935602 Unicode argv 修复的客户端构建并验证这一场景，准备脚本见 [setup-windows-svn.ps1](scripts/setup-windows-svn.ps1)。

### 检查与构建

```bash
# 完整检查：元数据、前端、构建、Rust 和真实 Git/SVN 测试
npm run check

# 单独检查前端或 Rust
npm run check:frontend
npm run check:rust

# 修改 Rust IPC 类型后，重新生成并校验前端绑定
npm run bindings
npm run bindings:check

# 本机打包，不生成自动更新签名产物
npm run tauri:build -- --ci --config src-tauri/tauri.unsigned.conf.json
```

本机打包默认使用当前主机架构。macOS universal 构建还需安装 `aarch64-apple-darwin` 与 `x86_64-apple-darwin` Rust target，并增加 `--target universal-apple-darwin`。`tauri.unsigned.conf.json` 只关闭更新签名产物的生成，操作系统的应用签名仍按平台配置执行。

正式发布由版本标签触发，三平台构建、检查和更新包签名校验全部通过后才发布 GitHub Release，并提供 GitCode 安装包镜像。发布配置见 [发布流程](docs/release-publishing.md) 和 [GitCode 镜像说明](docs/gitcode-update-mirror.md)。

### 项目结构

```text
src/          React 界面、状态管理、平台 Bridge 和前端测试
src-tauri/    Rust 后端、Git/SVN 操作、AI、凭据及原生配置
public/       Logo、编辑器图标、语言资源和拖拽预览页
scripts/      开发辅助、接口校验、打包与发布脚本
.github/      CI、缓存预热、三平台发布和 Issue 模板
docs/         发布与 GitCode 镜像维护说明
```

## 参与贡献

使用问题和功能建议请提交 [Issue](https://github.com/chenqinru/VersionDockDesktop/issues)。报告问题时请附上应用版本、系统、Git / SVN 版本、复现步骤和相关错误信息；提交日志前移除凭据及私人仓库信息。代码贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。

如果希望在 VS Code 内使用类似工作流，可以使用独立的 [VersionDock 扩展](https://github.com/chenqinru/VersionDock)。Desktop 是单独构建和运行的应用。

## 许可证

本项目采用 [GPL-3.0-only](LICENSE)。
