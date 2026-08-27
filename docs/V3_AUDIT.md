# VersionDock Desktop V3 功能真实性矩阵

更新时间：2026-08-23。状态以当前 `VersionDockDesktop` 源码、真实临时仓库测试和 Tauri Runtime 证据为准；浏览器 Demo 不计为完成证据。

| 领域 | 状态 | 优先级 | Backend / Bridge / UI | 自动化证据 | Runtime 证据 |
| --- | --- | --- | --- | --- | --- |
| 工作区打开、恢复、切换、拖入 | 已实现 | P0 | Rust 解析 ID，打开即替换 watcher；Bridge 支持取消 | Rust 路径测试、Store 竞态测试 | macOS 待最终复核 |
| 仓库扫描与工具缺失 | 已实现 | P0 | 扫描深度、忽略目录来自设置；仓库返回 `toolAvailable` | 扫描深度/特殊路径测试 | macOS 待最终复核 |
| watcher 与自动刷新 | 已实现但需运行压力复核 | P0 | 区分 worktree/status/refs，保留关键 `.git/.svn` 元数据 | watcher 元数据分类测试 | Runtime 已启动，压力复核待人工完成 |
| Git 核心工作流 | 已实现 | P0 | 真实 Git CLI、参数数组、路径校验、逐仓库批量结果 | `real_git_core_workflow` 等 | macOS 待最终复核 |
| SVN 核心工作流 | 已实现 | P0 | 真实 SVN CLI、结构化参数 | `real_svn_core_workflow` | macOS 待最终复核 |
| 文件 Diff 与面板右键 | 已实现 | P0 | 工作区/index/commit/range、未跟踪、Stash、Shelf、Worktree 均使用独立真实 patch；所有业务面板接入应用内右键菜单 | `real_git_core_workflow`、98 个 React 用例 | macOS 待最终复核 |
| History / 未推送提交操作 | 已实现 | P0 | Checkout、Cherry-pick、Revert、Reset、文件恢复、Patch 导出、Edit/Undo/Drop/Squash | `real_git_history_context_operations_modify_the_expected_targets`、`real_git_unpushed_history_operations_are_effective_and_safe` | macOS 待最终复核 |
| 冲突与 Merge Editor | 已实现，SVN 复杂冲突仍需实机复核 | P1 | fingerprint、Git stage、SVN resolve、二进制整体选择、property/tree/obstruction 类型与 working-copy 动作 | Git text/binary 集成测试；SVN 类型解析测试 | macOS 待最终复核 |
| 非 AI 设置 | 已实现 | P0 | 版本化设置、校验、迁移、原子写、即时 effect | Rust/React 设置测试 | macOS 待最终复核 |
| Git Identity Profile | 已实现 | P0 | 独立原子文件、逐仓库选择、命令级 `-c` 注入 | 真实 Git 配置隔离测试 | Runtime 已启动，Keychain 交互待人工完成 |
| SVN 账号 | 已实现 | P0 | repository root 映射、系统安全存储、stdin 密码；旧 SVN 禁用密码保存 | 安全存储使用内存替身测试待补 | macOS Keychain 待最终复核 |
| File History | 已实现 | P1 | Git `--follow`、SVN peg revision、分页/取消/内容/Diff | 真实 Git rename 与 SVN revision 测试 | Runtime 已启动，视觉交互待人工完成 |
| Stash | 已实现 | P1 | create/apply/pop/drop/按文件/include-untracked | Rust + React 测试 | macOS 待最终复核 |
| Shelf | 已实现 | P1 | 原子元数据、部分/全部 apply/drop | Rust + React 测试 | macOS 待最终复核 |
| Changelist | 已实现 | P1 | CRUD/assign/remove、仓库隔离 | Rust + React 测试 | macOS 待最终复核 |
| Worktree | 已实现 | P1 | list/create/remove/lock/unlock/prune、系统打开、工作树文件 Diff（含 untracked） | `real_git_core_workflow`、Worktree React 测试 | macOS 待最终复核 |
| Subtree | 已实现 | P1 | register/add/pull/push/split/merge/edit/unregister/remove files/pending recovery | `real_git_subtree_registry_and_operations` | macOS 待最终复核 |
| Submodule | 已实现 | P1 | 无独立标签；父仓库 gitlink 文件/仓库右键提供 init/update/recursive/sync/deinit/open/reveal | `real_git_submodule_lifecycle_supports_uninitialized_modules` | macOS 待最终复核 |
| SVN 高级工作副本操作 | 已实现 | P1 | cleanup、resolve working、lock/unlock、switch、relocate、remote copy branch/tag | `real_svn_advanced_working_copy_operations` | macOS 待最终复核 |
| 隐藏仓库 | 已实现 | P1 | Backend 保留完整扫描；UI 投影隐藏，设置页可恢复 | Settings/Store/Commit Panel React 测试 | macOS 待最终复核 |
| Branch Compare / Remote | 已实现 | P1 | 真实 base/target；URL 脱敏 | `real_git_branch_compare_and_remote_management` | macOS 待最终复核 |
| AI、Prompt、编辑器注解 | 明确不实现且已隐藏 | — | `DesktopCapabilities.ai=false` | Settings UI 测试 | 不适用 |

## 发布阻断规则

- 任一可见入口缺少真实 Backend、失败反馈或真实仓库测试时，关闭对应仓库 capability。
- Windows/Linux 仅有 CI 构建时必须标记“未完成实机交互验收”。
- 每次阶段验收记录实际命令及结果；静态检查、bundle 构建和 Tauri Runtime 结论分开记录。
