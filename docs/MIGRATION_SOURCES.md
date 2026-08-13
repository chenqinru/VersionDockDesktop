# VersionDock 迁移来源

参考源：VersionDock `dev` 分支，桌面工程建立时版本为 3.1.0。参考源只用于审计和一次性迁移；VersionDock Desktop 不通过 import、绝对路径、`file:`、符号链接、Submodule 或构建脚本依赖该目录。

## 已迁移/适配

- `src/webview/undockedPanel`：Commit Panel 与 Git Log 的横向信息架构。
- `src/webview/commitPanel`：仓库分组、文件状态、选择、提交表单与冲突提示语义。
- `src/webview/gitLog`：分支侧栏、虚拟提交列表、提交详情与仓库颜色语义。
- `src/webview/mergeEditor`、`src/webview/conflicts`：冲突列表、ours/base/theirs 与结果编辑流程。
- `src/webview/shared`：Codicon、Shiki、主题变量、路径/日期/分支的纯前端语义。
- `src/host/types`、`src/host/git`、`src/host/svn`、`src/host/vcs`：数据结构、Git literal pathspec、Git/SVN 参数与解析规则、路径边界和错误语义。
- `l10n`、`media/codicons`、`media/icons`：翻译、Codicons 与应用标志。

## 已重写

- VS Code Host/Webview 消息改为 `VersionDockBridge` + `TauriBridge`。
- VS Code Workspace、Window、Command、Editor、SecretStorage 和 State 改为 Tauri/Rust 实现。
- `simple-git`、VS Code Git API 和 Node CLI 改为 Rust `tokio::process::Command`。
- VS Code CSP/Webview URI/主题注入改为 Tauri CSP、静态资源和 Theme Adapter。

## 未迁移

- 所有 AI 服务、Provider、Prompt、API Key、AI 消息和按钮。
- Git Blame 编辑器装饰、Status Bar、Activity Bar Badge、Command Palette、VS Code Editor Context Menu。
- 未完成的第二阶段 capability 不显示 UI 入口。
