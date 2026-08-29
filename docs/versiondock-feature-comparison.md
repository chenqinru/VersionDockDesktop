# VersionDock 与 VersionDock Desktop 非 AI 功能对比审计

## 1. 审计范围

本次以以下两个仓库的当前源码进行只读对比：

- VersionDock 插件：`/Users/chenqinru/Project/VersionDock`
- VersionDock Desktop：`/Users/chenqinru/Project/VersionDockDesktop`

以下功能明确排除，不计入功能缺口：

- 所有 AI 功能
- Git/SVN Ghost Text
- Git/SVN Blame
- 基于 Blame 的编辑器行标注

结论：Desktop 的主要 Git/SVN 工作流已经基本覆盖插件，但仍有 5 类明确功能缺口和若干行为差异；同时，Desktop 增加了大量独立客户端运行所需的能力。

本文件记录的是源码静态审计结果，不等同于 Runtime 操作验收。随着两个仓库继续演进，结论需要重新核对。

## 2. 插件有、Desktop 明确未实现的功能

### 2.1 提交信息辅助

#### 提交信息历史

插件会跨仓库读取最近提交信息，按时间排序、去重并回填提交框；Desktop 没有对应 Bridge 命令或 UI。

插件参考：`VersionDock/src/host/panels/CommitPanelProvider.ts`。

#### 复用最后一次提交信息

插件支持一键读取指定仓库最后一条提交信息；Desktop 只有 Amend，两者并不等价。

插件参考：`VersionDock/src/host/panels/CommitPanelProvider.ts`。

### 2.2 仓库初始化与 Clone

#### 初始化 Git 仓库

插件在空文件夹状态提供 Initialize Repository；Desktop 只能打开已有目录并扫描其中已经存在的仓库。

插件参考：`VersionDock/src/host/panels/CommitPanelProvider.ts`。

#### Clone 仓库

插件可以通过 VS Code Git Clone 流程克隆仓库；Desktop 欢迎页只有打开本地文件夹，没有 Clone URL、目标目录、进度和认证流程。

插件参考：`VersionDock/src/host/panels/CommitPanelProvider.ts`。

### 2.3 GitHub/GitLab Provider 与远程仓库发布

#### GitHub 账号接入

插件可通过 VS Code GitHub Authentication 登录并提供凭据；Desktop 中现有 GitHub 相关代码只用于检查自身更新。

插件参考：`VersionDock/src/host/remote/RemoteRepositoryService.ts`。

#### GitLab 账号管理

插件支持 GitLab.com、自建 GitLab、PAT 添加、重新认证和删除；Desktop 没有对应账号模型。

#### 浏览和搜索远程仓库

插件将 GitHub/GitLab 仓库注册为 Clone 来源，可搜索远程仓库并返回 Clone URL；Desktop 没有对应流程。

#### 创建远程仓库

插件支持选择 Provider、Namespace 和可见性，并通过 API 创建 GitHub/GitLab 项目；Desktop 没有对应入口。

#### 发布已有仓库

插件可以创建远端项目、配置 `origin` 并继续 Push；Desktop 目前只能手工添加 Remote URL。

插件参考：

- `VersionDock/src/host/remote/RemoteRepositoryService.ts`
- `VersionDock/src/host/remote/GitHubRemoteProvider.ts`
- `VersionDock/src/host/remote/GitLabRemoteProvider.ts`

### 2.4 Pull/Update 后更新摘要

插件会在操作前后建立快照，统计新增 Commit 和变更文件，支持“查看更新详情”和部分仓库失败摘要。

Desktop 当前 Sync 完成后进行精确状态刷新，但没有本次 Pull/Update 的 Commit/File 变化摘要。

插件参考：`VersionDock/src/host/update/UpdateSummaryService.ts`。

Desktop 参考：`VersionDockDesktop/src/store/appStore.ts`。

### 2.5 历史路径筛选与在线作者头像

#### 历史路径筛选

插件支持按文件路径筛选 Git/SVN Log；Desktop 的主 History 请求只有通用 Filter 和 Revision。Desktop 的 File History 能按文件读取历史，但不等价于在主历史视图中进行路径筛选。

#### 在线作者头像

插件会解析 GitHub noreply 邮箱并尝试加载 GitHub Avatar 或 Gravatar，失败后再回退到首字母；Desktop 始终使用本地彩色首字母头像。

插件参考：`VersionDock/src/webview/gitLog/components/AuthorAvatar.tsx`。

## 3. 部分实现或行为不一致的功能

| 功能 | VersionDock 插件 | VersionDock Desktop |
| --- | --- | --- |
| 历史作者/日期筛选 | 传给后端，在完整历史范围执行 | 主要在前端过滤当前已加载数据，可能漏掉尚未加载的提交 |
| 历史搜索 | 后端分别处理文本、作者、分支、日期和路径 | Git 后端主要使用 `git log --grep` 搜索提交信息；UI 临时匹配 Hash/作者，结果语义可能不一致 |
| 选中行历史 | 从当前编辑器选择范围进入 Line History | 没有可编辑文本宿主和行选择上下文；如果归入 Blame 排除范围，则不需要补齐 |
| Worktree 在新窗口打开 | 打开新的 VS Code Window，并支持加入当前 Workspace | 菜单写着 Open in New Window，但当前行为通常交给系统 Finder 或默认应用，不是 VersionDock 新窗口；也没有加入当前工作区 |
| Edit Commit Message | 使用独立的大型编辑面板 | 使用通用输入 Dialog，功能存在，但长提交信息体验较弱 |
| Squash Commit Message | 显示待 Squash Commit 列表和大型编辑器 | 使用 Prompt Dialog；底层 Squash 已实现，但确认信息和编辑体验较弱 |
| SVN 账号管理 | 识别 Session、SVN SCM、原生 SVN Cache，支持切换、重新认证和清除原生缓存 | 支持账号、测试、删除和系统安全存储，但没有完整展示 Realm/来源，也不能管理原生 SVN Cache |
| File History | 集成进主 Git Log，支持文件和选中行上下文 | 独立弹窗，支持分页、版本内容和 Diff；属于不同交互方案，不能简单算缺失 |
| 打开全部改动 | 使用 VS Code Staged/Unstaged/Untracked Changes 编辑器 | 逐文件或在内部聚合 Diff 中查看，没有相同的宿主编辑器标签组 |
| 作者信息 | 可显示真实网络头像 | 使用本地彩色首字母，隐私和离线性更好，但视觉信息少一层 |
| Remote 管理 | Add/Rename/Change URL/Remove，并包含 Provider 发布能力 | 没有 Provider 发布，但普通 Remote 管理更完整：Fetch URL、Push URL 可分别设置，并支持 Prune |
| 更新通知 | Pull/Update 后展示本次实际更新的 Commit/File 摘要 | 更偏长期 Incoming/Unpushed 通知中心，不是同一种摘要 |

Desktop 历史实现参考：`VersionDockDesktop/src-tauri/src/vcs.rs`。

Desktop Worktree 实现参考：`VersionDockDesktop/src-tauri/src/commands.rs`。

## 4. VS Code 宿主专属能力

以下能力存在于插件，但依赖 VS Code 宿主，不宜直接视为 Desktop 产品缺陷：

- VS Code Native Changes 模式。
- SCM Resource、Explorer、Editor Context、Line Number Context 菜单。
- 在 VS Code Editor Tab 中打开全部改动。
- Commit/Log 面板 Undock 到 VS Code Editor Tab。
- 使用 `workbench.action.moveEditorToNewWindow` 将面板移到新的 VS Code 窗口。
- 继承当前 VS Code Color Theme、Token Color 和 File Icon Theme。
- 在 VS Code Explorer 中 Reveal。
- 将 Worktree 添加到当前 VS Code 多根 Workspace。
- 从当前活动编辑器读取选择范围。

插件 Undock 参考：`VersionDock/src/host/panels/UndockedPanelProvider.ts`。

Desktop 可以设计自己的等价交互，但没有必要复制 VS Code 的宿主概念。

## 5. Desktop 比插件增加的产品能力

| Desktop 额外能力 | 说明 |
| --- | --- |
| 独立原生应用 | 自己管理窗口、菜单和生命周期，不依赖 VS Code |
| 多工作区标签 | 一个窗口内同时打开多个 Workspace，每个标签保留自己的仓库、选择和布局状态 |
| 跨窗口标签拖放 | Workspace 标签可以在原生窗口之间转移，并同步所有权 |
| 最近工作区欢迎页 | 支持搜索、删除最近记录、拖入目录和会话恢复 |
| 原生安装包 | 提供 `.app`、`.dmg` 以及 Windows/Linux 安装包配置 |
| 应用更新器 | 检查版本、显示 Release Notes、下载并安装更新、跳过指定版本 |
| About 与诊断报告 | 显示应用、平台、Git/SVN 信息，并可复制脱敏诊断信息 |
| 应用内通知中心 | 保存通知历史、未读状态和操作按钮；系统通知失败时仍保留应用内通知 |
| 外部编辑器配置 | 可配置 Zed、Nvim 或其他命令，从 Desktop 打开文件 |
| 独立主题、语言和 UI 字号 | 可选系统/浅色/深色、中英文和多档字号，不依赖 VS Code 配置 |
| 结构化操作状态 | 按 Workspace、Repository、Domain 区分 `queued/running/succeeded/failed/cancelled/timedOut` |
| 前台操作取消 | Request Context、Generation、AbortController 和 Backend CancellationToken 联动 |
| Backend 并发协调 | 每仓库写锁、全局 2 个写并发、4 个读并发，等待信号量时支持取消 |
| 进程树取消 | CLI 超时、取消和退出时处理整个子进程树，而不是只取消 UI 请求 |
| 精确 Watcher Scope | 区分 Status、Diff、Index、Refs、History、Operation、Conflicts、SVN Revision 等领域，减少全 Workspace 刷新 |
| 多窗口调度去重 | Fetch on Startup、自动刷新和通知基线通过共享 Lease 避免重复执行 |
| Runtime Capability 真值 | 功能入口带有 `available/reasonCode/detail`，不只按 Git/SVN 类型粗略开启 |
| SVN 系统安全存储 | 使用 macOS Keychain、Windows Credential Manager 或 Linux Secret Service；密码只通过 stdin 传入 SVN |
| File History 不透明 Cursor | Cursor 绑定仓库、路径、VCS 和 Revision，防止跨仓库或路径串用 |
| File Revision Content | 在应用内查看历史版本源码，处理 Rename、Delete、Binary 和 Truncated |
| 批量提交部分成功报告 | 明确 Commit/Push 是否尝试、失败阶段、结构化错误和恢复建议 |
| 仅重试失败项 | 只重试失败 Push 或失败仓库，不重新提交已成功的仓库 |
| Remote Push URL 单独设置 | Fetch URL 和 Push URL 可以分别维护 |
| Remote Prune | 针对单个 Remote 清理失效的远程引用 |
| Shelf 数据兼容迁移 | 尝试读取并迁移 VS Code、Cursor、Trae、VSCodium 等环境中的 VersionDock Shelf 数据 |

Desktop 参考：

- `VersionDockDesktop/src-tauri/src/state.rs`
- `VersionDockDesktop/src/store/appStore.ts`
- `VersionDockDesktop/src/bindings/generated.ts`

## 6. 已基本对齐、不应重复开发的能力

以下能力不是缺口：

- Git/SVN Status、Stage、Unstage、Rollback、Delete。
- `.gitignore` 与 SVN Ignore 管理。
- Commit、Commit & Push、Amend、多仓库提交。
- Stash、Shelf、Changelists。
- Unpushed Commit 的 Edit、Squash、Drop、Revert、Undo。
- Git/SVN History、Commit Detail、Merge Commit Parent Changes。
- 多 Commit 聚合详情和聚合 Changes。
- Cherry-pick、Revert、Reset、Checkout、Create Patch。
- Branch、Remote Branch、Tag 的创建、切换、合并、删除和推送。
- Branch Compare、Working Tree Diff、Worktree Diff。
- Git Remote 基础 CRUD。
- Git Identity/Profile。
- Worktree、Subtree、Submodule 的主要操作。
- Git/SVN Conflict 列表和 Merge Editor。
- Git Merge/Rebase/Cherry-pick Abort。
- SVN Cleanup、Resolve、Lock、Unlock、Relocate、Switch、Branch/Tag Copy。
- 仓库隐藏/恢复、Project Colors、自动刷新、Fetch on Startup。
- Incoming/Unpushed 计数和通知。

## 7. 后续实现优先级建议

### 第一批：本地核心闭环

1. Clone 仓库。
2. Initialize Git Repository。
3. 提交信息历史。
4. 复用最后一次提交信息。

### 第二批：历史查询正确性

1. 将作者、日期和路径筛选下沉到 Backend。
2. 统一提交信息、Hash、作者、分支、日期和路径搜索语义。
3. 避免只过滤当前已加载页面而遗漏提交。

### 第三批：远程 Provider 与发布

1. GitHub/GitLab Provider 账号模型。
2. 浏览和 Clone 远程仓库。
3. 创建远程仓库。
4. 发布已有仓库并配置 `origin`。

### 其他建议

- 修复 Worktree “Open in New Window” 名实不符的问题。
- 增加 Pull/Update 前后快照和更新详情，复用现有 Commit Detail 聚合界面。
- SVN 原生认证缓存管理可以后做，因为 Desktop 已有更安全的系统凭据存储。

## 8. 审计边界

- 本次结论来自源码静态审计，没有执行 Runtime 操作验证。
- VersionDock 插件仓库仅用于只读对照，不应由 Desktop 实施任务修改。
- AI、Ghost Text 和 Blame 不进入 Desktop 非 AI 功能补齐计划。
- Desktop 独立客户端所需的并发、取消、Watcher、Capability、安全存储、多窗口和发布能力不应被视为多余功能。
