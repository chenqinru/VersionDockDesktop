# VersionDock `dcdb4d5` 后续提交同步审计

## 范围

- 源仓库：`/Users/chenqinru/Project/VersionDock`
- 源范围：`dcdb4d5..378d8ea`，共 119 个提交
- 目标仓库：`/Users/chenqinru/Project/VersionDockDesktop`
- 目标基线：`3e7b1da`（声明已同步 `dcdb4d5..505da16`）
- 审计原则：同步产品行为，不复制 VS Code Extension Host/Webview 消息层；Desktop 公共契约继续由 Rust/Specta 生成。
- 静态映射分类：55 条完全对齐、37 条 Desktop 等价、7 条部分对齐、11 条扩展版本排除、5 条 AI 排除、4 条布局排除；119 个源提交哈希与下方证据表机械对账无差异。分类表示代码入口和已知语义的对照，不等于所有平台及真实远端流程均已验收。

## 已声明同步区间复查

`dcdb4d5..505da16` 共 25 个提交：

`5c79dcf 36a77c6 0ec3334 b2fa662 b48e166 f1594e6 b1e2899 6cc8ed8 c7f5800 f13c745 93ca19f bbe4d8f 3b54562 72f54c0 53cc17c 0fc73b2 8800b60 315eaef 3987559 e37c127 ab05e98 edcbed3 9a78b93 f1fb635 505da16`

复查结果：不能只按“已有组件/命令”判定完成。除修复汇总提交带入的 4 个 ESLint 问题、3 个 Rust Clippy 问题和 `BranchRefBadge.selected` 视觉状态外，第三轮复查确认 `e37c127` 的大文件树虚拟化此前没有真正落到 Desktop；现已对 Changes 的树形/平铺列表统一做可见行扁平化，并在超过 40 行时启用虚拟渲染。

## `505da16` 后续提交处置

### 已同步或确认 Desktop 已有等价实现（40）

| 主题 | 源提交 | Desktop 处置 |
| --- | --- | --- |
| Log、分支、状态、缓存与失效 | `6cf3c4c c9d3717 e1fed9a 8833ba3 7ce35bc 8f2d9f7 b278769 7f51666 bf46455 f6a8982 9e53c3b 2e87502 91f4e5c 8d920c9 1ba5d73` | 复用 Desktop 的请求 generation/AbortController、RepositoryEvent scope、并发读写限制和按仓库刷新；补充快速搜索；右键菜单统一使用外部点击、Escape、窗口失焦、页面隐藏关闭，右键未选中行不破坏多选。 |
| Commit、Incoming、Fetch/Pull/Push 与搜索 | `f790fbf 062f7a2 15d5797 453c19f 4a365ac 2129e2b c33053c 0926be3 2fa46f9 585adbe 5157e19 8c1a8f8 dd118a8 cb6eb5d f825c58 712edba fc8f34c 5e1c939` | Push 页升级为 Sync；新增 incoming commit 查询、完整提交正文、逐提交潜在冲突、单提交与聚合 Changes、Fetch All/单仓库 Fetch、Pull 策略、单仓库/全仓库 Sync、Push Tags、Incoming 单个/批量 Cherry-pick 与建分支、合并提交保护、全选/反选和键盘快速搜索；窗口重新获得焦点时按三分钟冷却静默 Fetch，并提供设置开关。第三轮复查把 Outgoing/Incoming 聚合改为 Backend 计算 merge-base/最老提交父节点到目标 tip 的真实净差异，文件 Diff 也使用同一 revision range；Sync 工具栏与 Push 列表共用仓库选择状态。现有 Amend、统计、仓库可见性、Stash 文件预载缓存、更新摘要与剪贴板能力复核保留。 |
| Submodule 生命周期与安全 | `7fc1ede c2ded2f c86dcca 5db297e` | 新增独立 Submodule 页；扩展 HEAD/Index/冲突 Stage/类型变更/伴生路径/指针差异契约；支持 Add/Init/Update/Update All/Sync/Deinit/Remove/冲突选边、子模块自身 Pull/Push、文件管理器与新窗口打开；本地路径协议需显式确认；删除前检查工作区与本地独有提交；父仓库 Push 前检查 dirty/未推送子模块。 |
| Subtree 状态与刷新 | `a46d72b 4743ddf` | 在既有 Subtree 注册、Pull/Push/Split/Merge 上补接真实 split hash、远端 hash 和 ahead 状态；状态计算走仓库写锁与全局并发协调，增加 60 秒状态缓存、按 prefix 最后提交复用 split hash、8 秒远端探测超时和可取消请求；加载中或失败不再用缺省值误报 Up to date。 |
| 文案 | `2c8ef82` | 以 Desktop 中英文词条同步产品语义，不复制 Extension 专属文案键。 |

### 不直接修改 Desktop 产品版本（3）

`d8b5b1b b663413 ab868db` 仅将 VS Code 扩展版本推进到 3.8.0/3.8.1/3.8.2。Desktop 有独立的版本和打包通道，因此不把 `versiondock-desktop` 从 0.1.0 改成扩展版本。

### 延续既定非 AI 边界（2）

`5298ed0 6d5bcf6` 只修改 AI Commit Message/Prompt/用户意图草稿。Desktop 当前能力契约明确 `ai: false`，本次不引入 AI Provider、密钥或 Prompt 体系；这两条已审计但不移植。

## 架构映射说明

- `CommitPanelProvider`、`GitLogPanelProvider`、VS Code command/menu contribution 和 Webview 消息协议不会逐文件复制；对应行为落在 Tauri `BridgeCommand`、Rust VCS 服务、Zustand Store 和 React Desktop 组件中。
- VS Code 状态栏颜色配置、Explorer/Editor/New Window 命令使用 Desktop 自有 TitleBar、StatusBar、系统打开和多窗口模型。
- 源仓库缓存优化不会绕过 Desktop 的 CancellationToken、读写 semaphore、repository write lock 和 watcher generation。
- `src/bindings/generated.ts` 由 `npm run bindings` 生成，没有手工维护。

## 119 条逐提交证据表

状态含义：`完全对齐` 表示 Desktop 直接具有同一产品行为；`部分对齐` 表示只同步当前明确保留的非布局部分；`Desktop 等价` 表示 Extension Host/Webview 调用链已转换成 Tauri/Rust/Store/React；`Host 专属` 表示只适用于 VS Code/JetBrains 宿主；`版本排除`、`AI 排除` 和 `布局排除` 为明确不移植项。表内证据是当前实现入口，不以提交标题或组件文件存在作为结论。

| 源提交 | 实际主题 | 状态 | Desktop 证据 |
| --- | --- | --- | --- |
| `5c79dcf` | 分支状态失效通知与状态栏刷新 | Desktop 等价 | `appStore.ts` RepositoryEvent scope；`StatusBar/BranchStatusBarItem.tsx` |
| `36a77c6` | Git 错误格式化、提交/更新安全检查、PR URL | 完全对齐 | `vcs.rs` 安全错误；`PushPanel.tsx`；`UpdateStatusBarItem.tsx`；`history/prUrlHelper.ts` |
| `0ec3334` | Git/SVN/Shelf 操作与本地化补强 | Desktop 等价 | `vcs.rs`；`ShelfPanel.tsx`；`appStore.ts`；`i18n/index.tsx` |
| `b2fa662` | WorkspaceGitManager 状态竞争处理 | Desktop 等价 | `appStore.ts` generation/cancellation；Rust repository lock 与 semaphore |
| `b48e166` | 扩展 3.7.0 版本发布 | 版本排除 | Desktop 保持独立 `0.1.0` 版本线 |
| `f1594e6` | 分支 upstream/ahead/behind 跟踪 | 完全对齐 | `models.rs::BranchInfo`；`vcs.rs` branches/status；`BranchSidebar.tsx` |
| `b1e2899` | Push 前保护与错误提示 | 完全对齐 | `PushPanel.tsx` dirty/unpushed submodule 检查；`vcs.rs` push safety |
| `6cc8ed8` | IDE 第一阶段：分支命名、Git 操作、状态 UI | Desktop 等价 | `vcs.rs`；`BranchMenuPopover.tsx`；VS Code/JetBrains contribution 为 Host 专属 |
| `c7f5800` | IDE 第二阶段：更新摘要与状态提示 | Desktop 等价 | `UpdateStatusBarItem.tsx`；`appStore.ts::openUpdateResults` |
| `f13c745` | IDE 第三阶段：GitHub/GitLab、远端仓库、分支处理 | Desktop 等价 | `ProviderPanel.tsx`；`models.rs` provider commands；`vcs.rs` |
| `93ca19f` | Commit Form 选择与交互 | 完全对齐 | `CommitPanel.tsx`；workspace 持久化 `commitSelections` |
| `bbe4d8f` | 项目更新通知 | Desktop 等价 | `UpdateStatusBarItem.tsx`；`NotificationCenterPopover.tsx` |
| `3b54562` | IDE 第四阶段 Git 状态收口 | Desktop 等价 | `vcs.rs`；`appStore.ts`；宿主命令 contribution 不复制 |
| `72f54c0` | 扩展 3.7.1 版本发布 | 版本排除 | Desktop 独立版本线 |
| `53cc17c` | 未推送/未接收提交通知 | 完全对齐 | `unpushedCommits`/`incomingCommits` BridgeCommand；`BranchStatusBarItem.tsx` |
| `0fc73b2` | 文件删除与 working tree 判定 | 完全对齐 | `vcs.rs` delete/discard/status；`appStore.ts::deletePaths` |
| `8800b60` | 提交安全、并发与刷新性能 | Desktop 等价 | Rust cancellation/locks；`appStore.ts` generation；AI review 部分不在非 AI 范围 |
| `315eaef` | 冲突解析、终止操作、受保护分支 | 完全对齐 | `MergeWorkspace.tsx`；`ConflictBanner.tsx`；`history/branchProtection.ts`；abort command |
| `3987559` | 合并冲突自动进入 Merge Editor | 完全对齐 | `appStore.ts::openMerge`；`MergeWorkspace.tsx` |
| `e37c127` | 大文件树虚拟化 | 完全对齐 | `CommitPanel.tsx` 在可见节点超过 40 时启用 TanStack Virtual |
| `ab05e98` | Merge Editor 合并流程增强 | 完全对齐 | `mergeEditorModel.ts`；`MergeWorkspace.tsx` 三方选择与并发指纹保护 |
| `edcbed3` | 丢弃/删除更改语义 | 完全对齐 | `appStore.ts::discard/deletePaths`；`vcs.rs` |
| `9a78b93` | 扩展 3.7.2 版本发布 | 版本排除 | Desktop 独立版本线 |
| `f1fb635` | Commit Detail、SVN/Shelf 文件详情 | 完全对齐 | `CommitDetailPanel.tsx`；`CommitDetailWorkspace.tsx`；Shelf/SVN diff commands |
| `505da16` | Commit Detail 修订范围与过滤补强 | 完全对齐 | `CommitDetailWorkspace.tsx`；`HistoryFilterControls.tsx`；generated contracts |
| `6cf3c4c` | Git Log 请求性能与过期结果保护 | Desktop 等价 | `appStore.ts` AbortController/generation；`HistoryWorkspace.tsx` |
| `c9d3717` | Branch Sidebar 过滤交互 | 完全对齐 | `BranchSidebar.tsx` 搜索、过滤、折叠状态 |
| `e1fed9a` | Commit Detail 异步请求取消 | 完全对齐 | `selectedCommitLoading`/generation；`CommitDetailWorkspace.tsx` |
| `f790fbf` | Push 提交/文件/汇总 Changes 视图 | 完全对齐 | `PushPanel.tsx`；`RevisionChanges` Backend revision range |
| `062f7a2` | Push/Stash/Shelf 细节、聚合文件范围 | 完全对齐 | `PushPanel.tsx`；`StashPanel.tsx`；`ShelfPanel.tsx`；`vcs.rs` |
| `8833ba3` | 数据失效通知与按域刷新 | Desktop 等价 | `appStore.ts` refresh scope、RepositoryEvent、session cache |
| `7fc1ede` | Submodule 独立页、生命周期与操作锁 | 完全对齐 | `SubmodulePanel.tsx`；`SubmoduleOperation`；Rust repository write lock |
| `c2ded2f` | Submodule 安全、冲突、Push 保护 | 完全对齐 | `vcs.rs` submodule dirty/unpushed/local-only 检查；`PushPanel.tsx` |
| `c86dcca` | Submodule 元数据与状态读取 | 完全对齐 | `models.rs::SubmoduleEntry`；`vcs.rs::submodules` |
| `15d5797` | UpdateSummary 提交/文件细节 | 完全对齐 | `models.rs::UpdateSummary`；`appStore.ts::openUpdateDetails` |
| `453c19f` | Pull 策略、Push/Sync、多仓库操作 | 完全对齐 | `SyncPanel.tsx`；`appStore.ts::sync`；`vcs.rs::sync` |
| `7ce35bc` | 状态栏同步颜色 | 完全对齐 | `BranchStatusBarItem.tsx` `needs-sync`；`styles.css` 独立 Sync 色 |
| `8f2d9f7` | SVN 状态缓存、扫描限制与超时 | Desktop 等价 | `vcs.rs` SVN filtered history 15 秒超时/扫描上限 |
| `b278769` | SVN branch/tag 加载与缓存 | Desktop 等价 | `vcs.rs` branch/tag 5 分钟缓存、3 秒探测；写后失效 |
| `4a365ac` | Push 页升级为统一 Sync 页 | 完全对齐 | `CommitPanel.tsx` Sync tab；`SyncPanel.tsx` incoming/outgoing 混合时间线 |
| `5db297e` | Submodule HEAD/Index/冲突 stage/type-change | 完全对齐 | `SubmoduleEntry` 全字段；`SubmodulePanel.tsx` 状态 badge、Merge Editor/选边 |
| `7f51666` | Git/SVN 日志字段、分页与详情 | Desktop 等价 | `HistoryPage`/`CommitDetail` commands；`HistoryWorkspace.tsx` |
| `2129e2b` | Incoming 提交与 per-repo 同步数据 | 完全对齐 | `IncomingCommit`；`incomingCommits` command；`SyncPanel.tsx` |
| `d8b5b1b` | 扩展 3.8.0 版本发布 | 版本排除 | Desktop 独立版本线 |
| `c33053c` | Update Project、Fetch/Pull/Push 错误与保护 | 完全对齐 | `appStore.ts::updateProject/sync`；`SyncPanel.tsx`；`vcs.rs` |
| `bf46455` | 分支状态栏与 Update Summary | 完全对齐 | `BranchStatusBarItem.tsx`；`UpdateStatusBarItem.tsx` |
| `f6a8982` | 通知消息与 AI Prompt 管理器改动 | Desktop 等价 | 非 AI 通知由 `NotificationCenterPopover.tsx` 承接；AI 文件按既定边界排除 |
| `0926be3` | Shelf 文件与 Push 保护 | 完全对齐 | `ShelfPanel.tsx`；`PushPanel.tsx` |
| `2fa46f9` | 冲突警告、全选/反选和操作入口 | 完全对齐 | `ConflictBanner.tsx`；Commit/History selection；Codicon，不复制扩展 SVG |
| `b663413` | 扩展 3.8.1 版本发布 | 版本排除 | Desktop 独立版本线 |
| `9e53c3b` | 多仓库错误格式化与本地化 | Desktop 等价 | Rust structured error；`i18n/index.tsx`；notification/toast |
| `2e87502` | 合并冲突提示语义 | 完全对齐 | `ConflictBanner.tsx`；merge/rebase/cherry-pick operation state |
| `2c8ef82` | 中文本地化修订 | 完全对齐 | `i18n/index.tsx` 对应 Desktop 产品语义 |
| `a46d72b` | Subtree split/remote/ahead 状态 | 完全对齐 | `vcs.rs` subtree status；`models.rs::SubtreeEntry` |
| `4743ddf` | Subtree 状态加载/失败表现 | 完全对齐 | `SubtreePanel.tsx` loading/error/known state，不用默认值误报 |
| `91f4e5c` | Commit Panel 精确刷新 scope | Desktop 等价 | `appStore.ts` 按 domain/repository 刷新 |
| `585adbe` | Commit Panel 跨页快速搜索 | 完全对齐 | `useSpeedSearch.ts` 覆盖 Changes/Sync/Submodule/Subtree/Stash/Shelf/Worktree |
| `5157e19` | Amend/修订提交流程 | 完全对齐 | `CommitPanel.tsx` `amendRepoIds`、最后提交信息与选择 |
| `8c1a8f8` | 文件增删统计 | 完全对齐 | `CommitDetail`、`IncomingCommit`、`UnpushedCommit` additions/deletions |
| `dd118a8` | 仓库可见性与多仓库筛选 | Desktop 等价 | `allRepositories`/visible snapshot；侧栏 repository filters |
| `cb6eb5d` | Stash 文件按 hash 获取 | 完全对齐 | `vcs.rs` stash file command；`StashPanel.tsx` |
| `f825c58` | Incoming 聚合 Changes、冲突路径与操作 | 完全对齐 | `RevisionChanges`；`IncomingCommit.potentialConflictPaths`；`SyncPanel.tsx` |
| `712edba` | 剪贴板与上下文菜单 | Desktop 等价 | Tauri/Browser clipboard；`ContextMenu.tsx`；commit form 粘贴 |
| `8d920c9` | Git/SVN branch 管理与缓存 | Desktop 等价 | `vcs.rs`；`appStore.ts::branchOperation`；`BranchSidebar.tsx` |
| `ab868db` | 扩展 3.8.2 版本发布 | 版本排除 | Desktop 独立版本线 |
| `5298ed0` | AI Commit Message 行数上下文 | AI 排除 | Desktop capability 明确 `ai: false` |
| `6d5bcf6` | AI 用户意图草稿 | AI 排除 | 不引入 Provider、密钥、Prompt 与草稿通道 |
| `fc8f34c` | Stash 文件预载缓存 | 完全对齐 | `appStore.ts`/session 按稳定 stash hash 复用文件列表 |
| `5e1c939` | 窗口聚焦自动 Fetch 与冷却 | 完全对齐 | `App.tsx` focus listener、三分钟冷却、设置开关；启动 Sync future 堆分配修复 |
| `1ba5d73` | Commit/Branch 右键菜单关闭与多选 | 完全对齐 | `ContextMenu.tsx` 外点/Escape/blur/pagehide；`HistoryWorkspace.tsx` |
| `90cf735` | comfortable/compact 密度契约 | 布局排除 | 按当前范围不新增布局设置；`LayoutDensityPreference`、设置项和根节点 `data-density` 均未保留 |
| `8ab72b2` | 各 Commit Panel 页签统一密度与表面 | 部分对齐 | 不引入双密度；`styles.css` 只保留截图对应的统一齐边标题和列表表面 |
| `aaa0c91` | 分组标题、共享交互和结构收口 | 完全对齐 | `repo-heading`/`sync-repo-heading`/`repository-group-header` 同一设计语言 |
| `3804d00` | margin、hover、字体、虚线/分割线微调 | 部分对齐 | 保留 hover、字体和分割线细节；不保留按密度分支的 margin/radius |
| `597e728` | 仓库组折叠 | 完全对齐 | Sync/Submodule/Subtree/Stash/Shelf/Worktree 均有本地折叠状态 |
| `55c99c1` | 行间分割线一致性 | 完全对齐 | `--versiondock-border-soft`/`--versiondock-border` 分层 |
| `56d4835` | Commit Detail 密度 | 布局排除 | 按当前范围暂不增加 Commit Detail 密度设置 |
| `ada47a4` | Branch 异步加载、缓存和 stale 保护 | Desktop 等价 | `appStore.ts` per-repo cache、generation、AbortController |
| `08c3b35` | Branch Sidebar 密度与视觉 | 部分对齐 | 保留 Branch Sidebar 的齐边紧凑视觉；不引入密度切换 |
| `239adfe` | Commit Detail 多密度细节 | 布局排除 | 按当前范围暂不增加 Commit Detail 多密度分支 |
| `492b3a6` | Commit List 动态内边距 | 部分对齐 | 保留当前统一紧凑内边距，不按布局设置动态切换 |
| `332c49b` | Changelist/Commit Form 布局细节 | 完全对齐 | `ChangelistGroup.tsx`；`CommitPanel.tsx`；`styles.css` |
| `da668b5` | Commit Filters Bar 交互与密度 | 完全对齐 | `HistoryFilterControls.tsx`；`styles.css` |
| `4c5e222` | 最终 Commit Panel 间距、字体、分组视觉 | 部分对齐 | 按最终 `PushTab.tsx`/`SubmodulePanel.tsx` 同步齐边紧凑样式；布局切换部分排除 |
| `fc4c732` | 本地 Agent CLI 与 AI Provider 接入 | AI 排除 | 按当前范围不引入 Agent CLI、AI Provider、Prompt 与模型接入 |
| `038420f` | comfortable 密度侧栏间距 | 布局排除 | 按当前范围不引入 comfortable/compact 布局分支 |
| `5a393c1` | Commit/Stash/Shelf 成功后安全清空草稿 | 完全对齐 | `CommitPanel.tsx` 仅在操作成功且用户未在等待期间修改草稿时清空输入 |
| `e39246f` | 扩展 4.0.0 版本发布 | 版本排除 | Desktop 保持独立 `0.1.0` 版本线 |
| `be56c13` | Windows Agent CLI 启动修复 | AI 排除 | Agent CLI 不在当前范围 |
| `461b004` | Sync 合并提交变更展示 | 完全对齐 | `UnpushedCommit.parents`；`vcs.rs::commit_detail` combined diff；`SyncPanel.tsx` 合并提交空状态 |
| `b64040d` | OpenAI/自定义 Provider Responses API | AI 排除 | AI Provider 与 Responses API 不在当前范围 |
| `032fa60` | 扩展 4.0.2 版本发布 | 版本排除 | Desktop 独立版本线 |
| `4ee1351` | Compare 过滤器可见性与层级 | 完全对齐 | `BranchComparePanel.tsx`；`styles.css` pane z-index、visible overflow 与 date filter 最小宽度 |
| `d45539d` | Worktree Diff 视觉与布局密度 | 部分对齐 | `BranchWorkingDiffPanel.tsx`/`styles.css` 同步工具组、hover、行高和紧凑表面；不引入双密度属性 |
| `6514855` | SVN Checkout | 完全对齐 | `CheckoutSvnRepository`；`vcs.rs::checkout_svn_repository`；`RepositoryCheckoutDialog.tsx`；Welcome/空仓库入口 |
| `de94b98` | Git Clone、Publish 与远程账户入口 | Desktop 等价 | Clone/Publish 映射到 Tauri/Rust/ProviderPanel；空仓库与 Welcome 有 Clone；Remote Manager 提供 Publish |
| `fe67437` | 扩展 4.0.3 版本发布 | 版本排除 | Desktop 独立版本线 |
| `45816c0` | 远程操作取消错误处理 | Desktop 等价 | `isAbortError` 识别 `REQUEST_CANCELLED`；Store/Provider UI 静默处理取消，不产生失败通知 |
| `45a967f` | GitHub 账户管理 | Desktop 等价 | `ProviderPanel.tsx` 多账户、重新认证、删除与打开 GitHub 主页；安全存储由 Desktop provider 承接 |
| `0a884d7` | Commit Form Git 操作按钮布局 | 完全对齐 | `CommitPanel.tsx` 仅在 Git 目标存在时渲染 Stash/Shelf 操作组 |
| `8f6438e` | Clone/Checkout 安全收口、SVN 最近提交、Sync 合并文案及 AI 修订 | 部分对齐 | 非 AI 部分全部落在原子 staging、目录名校验、凭据 stdin、SVN `HEAD:1`/10 秒 fallback、Sync 文案；AI 文件按范围排除 |
| `17347c2` | 远程账户管理修复 | Desktop 等价 | `provider.rs` 账户安全存储、重新认证与删除；`ProviderPanel.tsx` |
| `375e8fe` | Commit/Log 面板远程账户获取 | Desktop 等价 | `ResolveAuthorAvatar` BridgeCommand；`AuthorAvatar.tsx` 按仓库解析 |
| `6191b82` | AuthorAvatar 自定义字体/尺寸 | 完全对齐 | `AuthorAvatar.tsx` `size` 驱动头像、占位字和字体尺寸 |
| `ab33996` | Gitee 远程平台 | Desktop 等价 | `RemoteProviderKind::Gitee`；`provider.rs::gitee_save/repositories/namespaces/create_repository`；`ProviderPanel.tsx` |
| `9737b0b` | 头像解析与作者映射修复 | Desktop 等价 | `provider.rs::resolve_author_avatar`；默认按仓库远程主机限定平台，跨平台回退须用户单独开启；账户/作者/邮箱候选匹配。私有 GitLab 与真实账户仍需实机验收 |
| `d730e0b` | Profile 状态栏远程账户管理 | Desktop 等价 | `ProfileMenuPopover.tsx` 显示 GitHub/GitLab/Gitee 账户并打开统一管理面板 |
| `b35dca9` | 远程账户缓存修复 | Desktop 等价 | Provider 账户每次从配置与系统安全存储读取，不持有失效 token 缓存 |
| `d730409` | 头像缓存键与查询优化 | Desktop 等价 | `AuthorAvatar.tsx` 缓存键包含 repo/email/size/privacy 开关，按仓库远程平台隔离 |
| `b53b114` | 头像缓存清理修复 | Desktop 等价 | 头像缓存为有界 256 项、正负结果独立 TTL；账户变化后新 repo/account 作用域不会复用旧键 |
| `6e11ec5` | 合并提交 combined diff 统计 | 完全对齐 | `vcs.rs` 同时读取 `diff-tree --cc --name-status` 与 `--numstat` 并合并 additions/deletions |
| `99a649c` | SVN 未受控目录递归探测 | Desktop 等价 | `workspace.rs::collect_svn_untracked`：每个未受控目录 500 项、8 层，忽略规则、符号链接/嵌套 VCS 不递归、截断原因；Stage/Discard 双重安全校验 |
| `2c5f23a` | Commit Panel 截断、分阶段与头像收口 | Desktop 等价 | Changes/Changelist 截断项禁选；单目录确认后递归 Add；批量选择与 Rollback 跳过截断项；统一 AuthorAvatar |
| `905b5ae` | 混合 Git/SVN 工作区标签 | 完全对齐 | `repoLabel.ts`；Changes/History 在混合仓库时显示 `[Git]`/`[SVN]`，Branch Sidebar 保留已有 VCS badge |
| `a7eeff7` | 扩展 4.0.4 版本发布 | 版本排除 | Desktop 保持独立 `0.1.0` 版本线 |
| `648058a` | 分支查询超时与加载状态收口 | Desktop 等价 | `appStore.ts` 每仓库 Branch/Tag 请求独立 12 秒超时，失败保留已缓存结果；`BranchSidebar.tsx` 只按分支请求状态显示加载提示 |
| `ac577b4` | Subtree 刷新时保留旧状态 | Desktop 等价 | `SubtreePanel.tsx` 已保留 `loadedStatuses`，各仓库结果汇总后一次 `setLoadedStatuses`；刷新期间不将旧状态改成 loading |
| `7e95fb3` | 扩展 4.0.5 版本发布 | 版本排除 | Desktop 保持独立 `0.1.0` 版本线 |
| `378d8ea` | Push/Sync 聚合文件加载与缓存 | Desktop 等价 | `SyncPanel.tsx` 按工作区、仓库、方向、提交哈希分别缓存聚合差异；展开时预载，切换方向/视图时复用并在哈希变化后重新获取 |

### Sync/Submodule 逐字段与逐命令复核

- Sync 仓库标题字段：checkbox、collapse、repo color/name、branch badge、ahead/behind pills 均已映射；分支 badge 可直接打开当前仓库的完整分支/标签菜单，方向 pill 可以独立开关 incoming/outgoing。
- Sync 提交字段：方向、short hash、message、author、relative date、files changed、additions、deletions、body、逐文件 detail 均来自 Backend 数据；Incoming 额外保留 parents 和 potential conflict paths。
- Sync 命令：Fetch、Fetch All、Pull、Pull Rebase、Pull FF-only、Push、Push Tags、Sync Selected、Incoming Cherry-pick/Create Branch、Outgoing Edit/Revert/Undo/Drop 和 Open in Log 均有入口。
- Submodule 字段：initialized、revision/currentBranch/detached、recordedCommit、syncStatus、dirty、unpushedCount、conflictStages、typeChange、companionPath、diffSummary 均已保留。
- Submodule 命令：Add、Init、Update、Update Remote、Update All、Sync URL、Deinit、Remove/Force Remove、Pull、Push、Resolve Ours/Theirs、Merge Editor、Reveal、File Manager、New Window 均已保留；常用命令显示在 hover，完整集合放在右键菜单。

## 验证边界

本轮 `npm run check:frontend`（含 TypeScript、ESLint、245 项 Vitest、bindings、i18n 与 Vite build）和 `npm run check:rust`（fmt、Clippy、72 项 Rust 测试）已通过，`git diff --check` 无空白错误。SVN 的选中路径提交、500 项截断和嵌套 VCS 元数据拦截已用临时本地仓库做集成回归；真实远端 Push/Pull、凭据交互、私有 GitLab 头像以及 Windows/Linux Runtime 未验收。下方“完全对齐”/“Desktop 等价”是静态代码与本地行为审计结论，不承诺未执行的远端、账户及跨平台路径。

## 第四轮遗漏修正

- 复查 `2c5f23a` 时发现 Desktop 的 SVN commit 仍对目录使用默认递归深度，可能把未勾选子文件一起提交。现与源实现一致使用 `--depth empty`，仅提交明确选中的路径；新增未受控文件时补齐 SVN 自动加入的祖先目录，新选中的未受控目录则明确纳入其新增后代。空选择直接报错，不再退化为整个工作副本提交。
- SVN 未受控扫描改为每个未受控目录独立计数，遵循客户端与继承的 `svn:global-ignores`，不展示 `.git`/`.hg` 元数据；Stage 前对未忽略的嵌套元数据做安全拦截，已忽略的子树不误拦截。截断目录继续要求单独确认，不能直接勾选提交或批量回滚。
- 作者头像解析按真实远程主机匹配，普通 GitHub 邮箱不推断为用户名，私有 GitLab 头像尝试受限大小、同源认证下载；跨平台回退改为默认关闭的独立设置。取消请求不再被头像查询的容错路径吞掉。这些账户与网络分支只完成代码审计，尚无真实账户验收。
- 复查最新 `378d8ea` 时确认 Desktop 原先只有一个聚合差异缓存槽，切换 Incoming/Outgoing 过滤会丢失另一方向的数据并重复请求。现按方向和提交哈希分开缓存，视图切换复用已加载结果。
- Changes 中未受控文件的右键菜单在普通视图下也恢复 Add to Git/SVN 入口；SVN 截断目录仍需单独确认。SVN 的嵌套元数据检查移到阻塞任务池执行，避免扫描较大目录时占用 Tokio 工作线程。

## 二次复查修正

第一次审计把若干“已有组件外壳”错误归类为“已有等价实现”。二次逐字段、逐命令核对后补齐了 Subtree 状态 Backend、Submodule 高级状态与子仓库操作、Incoming 完整正文/逐提交冲突/聚合操作，以及 Shelf、Stash、Worktree、Subtree 等页签的快速搜索。本文以上述二次复查后的结论为准。

## 第三轮逐提交语义复查

- 重新以源提交的实际 diff（而非提交标题）核对目标实现；当轮源仓库新增 14 个提交，范围更新为 `dcdb4d5..4c5e222`，共 84 个提交。
- 修正 `e37c127`：Changes 文件树/平铺列表超过 40 个可见节点后使用虚拟渲染。
- 修正 `f790fbf`、`062f7a2`、`4a365ac`：Outgoing 与 Incoming 的聚合文件不再是逐提交文件并集，而是带 rename/numstat 的真实 revision-range 净差异；聚合文件打开的也是同一范围 Diff。
- 修正 `7ce35bc`：同时存在 incoming/outgoing 时，状态栏使用独立 Sync 色，而不是降级为单纯 Behind 色。
- 加固 `8f2d9f7`、`b278769`：SVN filtered history 设置扫描上限和 15 秒超时，拓扑读取限制为 100；远端 branch/tag 使用 5 分钟缓存与 3 秒探测，incoming 计数使用 60 秒缓存与 20 秒探测，写操作后主动失效。
- 加固 `fc8f34c`：Stash 文件列表按稳定 stash hash 复用缓存，避免每次刷新重复读取相同 stash 内容。
- 仍不复制 VS Code Webview/Extension Host 专属通道；`d8b5b1b b663413 ab868db` 仍属于扩展发布版本，`5298ed0 6d5bcf6` 仍属于明确排除的 AI 范围。

## `1ba5d73..4c5e222` 新增 14 个提交

`90cf735 8ab72b2 aaa0c91 3804d00 597e728 55c99c1 56d4835 ada47a4 08c3b35 239adfe 492b3a6 332c49b da668b5 4c5e222`

这一段同时包含布局密度和后续视觉/交互收口。按当前明确范围，Desktop 不新增 `comfortable` / `compact` 设置，也不保留两套混用样式：`90cf735`、`56d4835`、`239adfe` 的密度契约暂不同步；其他提交只同步与布局开关无关的折叠、缓存、右键、hover、字体、分割线和齐边紧凑视觉。Changes、Sync、Submodule、Subtree 的仓库标题统一为同一条 26px 齐边色带。`ada47a4` 的分支加载优化继续由 Desktop 既有按仓库缓存、请求取消和 watcher generation 模型承接。

## `4c5e222..8f6438e` 新增 17 个提交

`fc4c732 038420f 5a393c1 e39246f be56c13 461b004 b64040d 032fa60 4ee1351 d45539d 6514855 de94b98 fe67437 45816c0 45a967f 0a884d7 8f6438e`

本轮按实际 diff 逐项复查。明确排除 3 条 AI、1 条 comfortable 布局和 3 条扩展版本提交；`d45539d` 只保留统一紧凑布局下的 Worktree Diff 修复，`8f6438e` 只排除其中的 AI 文件。其余非 AI 行为已同步：Commit/Stash/Shelf 成功后仅安全清空原草稿；Sync 识别 outgoing merge parents 并显示 combined-diff 空状态；Compare 修复过滤器层级和最小宽度；新增完整 SVN Checkout；现有 Git Clone/Publish 增加原子 staging、跨平台目录名校验、Provider 凭据解析和取消处理；GitHub 账户管理补齐主页入口；SVN 最近提交优先 `HEAD:1` 并设置 10 秒 fallback。Clone/Checkout staging 目录同时从工作区扫描和 watcher 中排除，失败会清理半成品，目标目录在执行期间发生竞争变化时保留 staging 供恢复。

## `8f6438e..a7eeff7` 新增 14 个提交

`17347c2 375e8fe 6191b82 ab33996 9737b0b d730e0b b35dca9 d730409 b53b114 6e11ec5 99a649c 2c5f23a 905b5ae a7eeff7`

这一段没有 AI 或布局设置提交；仅 `a7eeff7` 是扩展版本号，按独立版本线排除。其余非 AI 行为已同步为 Desktop 等价实现：Gitee 接入账户、安全存储、仓库浏览、命名空间、发布、Clone 凭据复用；作者头像按仓库远程平台与账户隔离缓存，并覆盖 History、Commit Detail、Sync、Push、作者筛选；Profile 状态栏显示并管理远程账户；Git merge combined diff 补充增删统计；SVN 未受控目录按 500 项/8 层递归探测，符号链接和嵌套 VCS 不递归，截断目录不能勾选或回滚，只允许单独确认后递归 Add；混合 Git/SVN 工作区在仓库标题中区分类型。

## `a7eeff7..378d8ea` 新增 4 个提交

`648058a ac577b4 7e95fb3 378d8ea`

`648058a` 在 Desktop 的分支/标签请求中落实每仓库独立超时与失败隔离，分支侧栏加载提示不再受提交历史加载牵连。`ac577b4` 所修复的刷新闪烁在 Desktop 原有批量状态更新流程中已经避免。`378d8ea` 对应 Sync 聚合文件按提交哈希缓存、预载及切换方向时更新；空文件结果与加载中的状态分开显示。`7e95fb3` 仅修改扩展版本号。

## 启动崩溃回归修正

同步后 macOS 实机出现 `tokio-rt-worker` stack overflow。DiagnosticReports 的故障调用链明确为 `bridge_request → dispatch → vcs::sync → cli::run_once`：外层 `dispatch` 虽已堆分配，但扩展后的 Sync future 仍在 Tokio worker 栈中展开。现在在单仓库 Sync 与批量 Commit 后 Push 两条入口显式 `Box::pin(vcs::sync(...))`，避免启动自动 Fetch 触发进程级退出；修复后已由用户确认应用可以打开。
