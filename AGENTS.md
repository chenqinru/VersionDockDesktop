# VersionDock Desktop 项目约定

始终使用简体中文回答，代码、命令、专有名词和用户明确要求保留的原文除外。优先选择长期维护成本低、简单且务实的实现；先验证事实，再修改真正负责该行为的代码。

## 项目与开发环境

- 本项目是独立的 Git / SVN 桌面工作台，使用 Tauri 2、Rust、React、TypeScript 和 Zustand，支持 macOS、Windows、Linux。
- Desktop 独立构建和运行。VersionDock 扩展可作为行为参考；默认只修改当前仓库，不引入扩展运行时、跨仓库源码路径、符号链接或 `file:` 依赖。
- 使用 Node.js 20+ 和 npm；安装依赖用 `npm ci`。Rust 版本及组件以 `rust-toolchain.toml` 为准，不随意切换工具链。
- 原生开发需要对应平台的 Tauri 系统依赖；仓库集成测试需要真实 Git、SVN，发布测试需要 minisign。具体环境和安装步骤见 [README](README.md) 与 `.github/workflows/ci.yml`。
- 桌面开发用 `npm run tauri:dev`。在应用内操作本项目仓库时，可用 `npm run tauri:dev -- --stable` 关闭监听，避免检出等操作触发重载。
- 仅调试前端用 `npm run browser:dev`；该模式使用开发 Bridge，不能代替真实仓库操作和桌面验收。

## 代码职责与入口

| 路径 | 职责 |
| --- | --- |
| `src/components/`、`src/styles.css` | 工作台界面、交互与样式 |
| `src/store/`、`src/progress/` | 工作区状态、更新状态和任务进度 |
| `src/platform/bridge.ts`、`src/platform/context.tsx` | `VersionDockBridge`、原生请求及事件接口 |
| `src/platform/browserDevBridge.ts` | 浏览器开发演示 |
| `src/bindings/generated.ts` | Rust 导出的 IPC 类型 |
| `src/settings/`、`src/i18n/`、`src/theme/` | 设置、翻译与主题 |
| `src-tauri/src/commands.rs`、`models.rs`、`state.rs` | 命令分发、共享类型、后端状态与仓库写锁 |
| `src-tauri/src/vcs.rs`、`cli.rs`、`workspace.rs` | Git / SVN 操作、进程执行与工作区扫描 |
| `src/ai/`、`src-tauri/src/ai/` | AI 界面状态、提供商、CLI、上下文与结果校验 |
| `src-tauri/src/integration_tests.rs` | 真实临时 Git / SVN 仓库集成测试 |
| `scripts/`、`.github/workflows/` | 开发辅助、检查、打包和发布 |
| `.agents/skills/`、`docs/` | 项目 Skill 与维护指南 |

## 实现边界

- 开始修改前检查 `git status --short`，保留已有改动和未跟踪文件。只处理当前任务范围，不顺带清理、重构或回退其他工作。
- 仓库读写和原生能力通过 `VersionDockBridge` 接入 Rust 后端；复用现有命令执行、错误、进度、取消和超时机制。仓库写操作保留后端串行保护，不仅依靠界面禁用按钮。
- 异步结果和事件保留工作区、仓库、请求及 generation 上下文，避免切换标签、仓库或筛选条件后旧结果覆盖新状态；订阅和取消状态要随生命周期清理。
- 修改 IPC 命令或 Rust 共享类型后运行 `npm run bindings`，同步生成的 `src/bindings/generated.ts` 和 `src/settings/defaults.generated.json`。修改设置默认值时追溯 Rust 定义，不手工修补生成文件。
- 用户可见文案使用现有翻译机制，同时维护中英文。关于、更新、通知及后端操作进度文案需要内置翻译，不能只依赖异步加载的语言资源。
- 界面改动沿用现有主题、布局密度、图标、对话框和焦点管理能力；检查深浅主题及中英文，避免为了局部效果创建第二套组件或状态机制。
- Git 与 SVN 的操作语义不同，按实际仓库类型和工具能力实现。平台相关进程、路径和编码处理复用 `cli.rs`，尤其注意 Windows 后台窗口和 Unicode 路径、macOS 从 Finder 启动时的工具探测与语言环境。
- 凭据使用现有系统安全存储；托管平台 API 账号与 Git 自身的 SSH / HTTPS 认证分别处理。日志和错误信息不输出 Token、密码或 API 密钥。
- 新增能力应贯通界面、Bridge、Rust 和操作结果；演示数据、占位入口及静态检查不能作为已实现能力的证据。

## 检查与验收

根据变更选择有意义的检查；复用同一代码状态下已通过的结果。纯文档修改只检查内容、链接和格式，不强制运行全套构建。

| 场景 | 命令 |
| --- | --- |
| 前端类型与规范 | `npm run typecheck`、`npm run lint` |
| 指定前端测试 | `npm run test -- src/path/to/example.test.tsx`（替换为实际测试路径） |
| 完整前端检查与构建 | `npm run check:frontend` |
| Rust 格式、Clippy 与测试 | `npm run check:rust` |
| IPC 与设置默认值生成一致性 | `npm run bindings:check` |
| 版本元数据与更新说明 | `npm run check:metadata` |
| 发布脚本与打包测试 | `npm run test:release` |
| 提交或 PR 前的完整质量检查 | `npm run check` |
| 修改文件的空白与格式 | `git diff --check` |

- `npm run build` 和 `npm run bindings:check` 会运行 Rust 导出测试并可能改写生成文件；发现差异时核查来源，不回退用户已有修改来凑检查通过。
- Bug 修复及重要状态、IPC、仓库操作改动优先补充针对行为和边界条件的测试，不编写仅复述实现的测试。
- Git / SVN 写操作用临时仓库验证；不要用用户的工作仓库执行破坏性验收。视觉与交互改动尽量提供实际渲染证据；原生行为在 Tauri 中验证。
- 交付时说明具体变化、实际执行的检查及未验证部分。明确区分类型检查、测试、浏览器演示、原生桌面运行和安装包更新验证，不把其中一种当成另一种。

## 版本与发布

- 准备版本或生成更新说明时使用 [versiondock-release Skill](.agents/skills/versiondock-release/SKILL.md)，无需把详细流程重复写入本文件。
- 版本同步复用 `npm run version:bump -- patch` 或明确版本号；正式发布只支持 `X.Y.Z`。`src/release-notes.json` 同时服务应用内历史、更新提示与 Release 正文，保持中英文内容及版本对应。
- 本地发布准备与实际发布按用户授权范围执行。提交、打标签和推送已有明确授权时继续执行，无需重复确认；不要因生成说明自动触发发布。
- 真实发布以 [发布维护指南](docs/release-publishing.md)、[GitCode 镜像指南](docs/gitcode-update-mirror.md) 和 `.github/workflows/release.yml` 为准。不得移动已发布标签、覆盖已公开版本或更换生产更新密钥绕过签名失败。
- 用户要求提交时，采用 Conventional Commits：`type(scope): 中文总结`，正文用中文归纳行为变化；仅提交本次任务涉及的文件。
