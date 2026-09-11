# VersionDock `dcdb4d5` 后续提交同步审计

## 范围

- 源仓库：`/Users/chenqinru/Project/VersionDock`
- 源范围：`dcdb4d5..1ba5d73`，共 70 个提交
- 目标仓库：`/Users/chenqinru/Project/VersionDockDesktop`
- 目标基线：`3e7b1da`（声明已同步 `dcdb4d5..505da16`）
- 审计原则：同步产品行为，不复制 VS Code Extension Host/Webview 消息层；Desktop 公共契约继续由 Rust/Specta 生成。

## 已声明同步区间复查

`dcdb4d5..505da16` 共 25 个提交：

`5c79dcf 36a77c6 0ec3334 b2fa662 b48e166 f1594e6 b1e2899 6cc8ed8 c7f5800 f13c745 93ca19f bbe4d8f 3b54562 72f54c0 53cc17c 0fc73b2 8800b60 315eaef 3987559 e37c127 ab05e98 edcbed3 9a78b93 f1fb635 505da16`

复查结果：不能只按“已有组件/命令”判定完成。除修复汇总提交带入的 4 个 ESLint 问题、3 个 Rust Clippy 问题和 `BranchRefBadge.selected` 视觉状态外，第三轮复查确认 `e37c127` 的大文件树虚拟化此前没有真正落到 Desktop；现已对 Changes 的树形/平铺列表统一做可见行扁平化，并在超过 40 行时启用虚拟渲染。

## `505da16` 后 45 个提交处置

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

## 验证边界

自动化门禁覆盖 TypeScript、ESLint、Vitest、bindings、i18n、Vite build、Rust fmt、Clippy、Rust tests 和 diff whitespace。真实远端 Push/Pull、凭据交互、Windows/Linux Runtime 不在本次自动化验证范围内。

## 二次复查修正

第一次审计把若干“已有组件外壳”错误归类为“已有等价实现”。二次逐字段、逐命令核对后补齐了 Subtree 状态 Backend、Submodule 高级状态与子仓库操作、Incoming 完整正文/逐提交冲突/聚合操作，以及 Shelf、Stash、Worktree、Subtree 等页签的快速搜索。本文以上述二次复查后的结论为准。

## 第三轮逐提交语义复查

- 重新以 70 个源提交的实际 diff（而非提交标题）核对目标实现，范围仍为 `dcdb4d5..1ba5d73`，源 HEAD 未发生变化。
- 修正 `e37c127`：Changes 文件树/平铺列表超过 40 个可见节点后使用虚拟渲染。
- 修正 `f790fbf`、`062f7a2`、`4a365ac`：Outgoing 与 Incoming 的聚合文件不再是逐提交文件并集，而是带 rename/numstat 的真实 revision-range 净差异；聚合文件打开的也是同一范围 Diff。
- 修正 `7ce35bc`：同时存在 incoming/outgoing 时，状态栏使用独立 Sync 色，而不是降级为单纯 Behind 色。
- 加固 `8f2d9f7`、`b278769`：SVN filtered history 设置扫描上限和 15 秒超时，拓扑读取限制为 100；远端 branch/tag 使用 5 分钟缓存与 3 秒探测，incoming 计数使用 60 秒缓存与 20 秒探测，写操作后主动失效。
- 加固 `fc8f34c`：Stash 文件列表按稳定 stash hash 复用缓存，避免每次刷新重复读取相同 stash 内容。
- 仍不复制 VS Code Webview/Extension Host 专属通道；`d8b5b1b b663413 ab868db` 仍属于扩展发布版本，`5298ed0 6d5bcf6` 仍属于明确排除的 AI 范围。
