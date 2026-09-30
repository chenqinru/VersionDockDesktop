# 提交面板对照与本轮修复（2026-09-30）

## 范围与依据

- 插件：`/Users/chenqinru/Project/VersionDock`，对照 `src/webview/commitPanel`、`CommitPanelProvider.ts` 与 `GitService.ts`。
- App：`/Users/chenqinru/Project/VersionDockDesktop`，对照 React 组件、Zustand Store 和 Tauri/Rust 操作。
- 排除 AI 与舒适布局；截图只作为更改页的视觉参考，不代表其他标签页已完成像素验收。
- 1421 最初运行的是浏览器演示模式，使用固定仓库数据。已停止该演示服务并改为当前源码的 `tauri:dev`；普通浏览器不能直接替代原生 Tauri 桥接。

## 七个标签页检查记录

以下是本轮代码对照范围及修复，不表示每一项都经过真实 App、远端、凭据或跨平台验收。

| 标签页 | 核对的入口与操作 | 本轮处理 | 仍需原生验收 |
| --- | --- | --- | --- |
| 更改 | 仓库/文件夹/文件勾选、树/列表、暂存/取消暂存、回滚/删除/忽略、提交/提交并推送、保存拆分菜单、历史消息、amend、冲突继续/中止、Changelist/VS Code 视图 | 刷新统一交给 Store，去掉当前页的重复请求；各页重新访问时刷新数据；工作区切换重新隔离组件局部状态 | 截图同尺寸与同数据对照；不同视图菜单与拖动；多工作区连续提交 |
| 搁置 | 恢复并保留、恢复并删除、单文件恢复、删除、文件 diff、树/列表、展开/折叠、搜索 | 有缓存或加载失败记录时不反复从隐藏页加载；手动刷新与重新访问保留刷新路径 | 部分恢复、冲突恢复和失败后再次操作 |
| 暂存（Stash） | Apply/Pop/Drop、文件 diff、稳定 stash hash、树/列表、展开/折叠、搜索 | 删除隐藏页重复加载；refs 变化时刷新 stash 列表与计数 | 外部创建/删除 stash 后的刷新；冲突与 stash 顺序变化 |
| 子模块 | 初始化、普通/远端/全部更新、URL 同步、冲突双方/类型变更、取消初始化/删除、路径打开、仓库分组 | 补初始化状态、父指针、当前/分离 HEAD 与跟踪分支；普通 Update 和 URL Sync 的递归范围对齐插件；取消初始化补确认与失败后强制选项；busy 菜单禁用；避免加载失败自动循环与切工作区后刷新错误目标 | 本地/远端 URL、嵌套子模块、脏状态、取消/强制取消初始化、鼠标/键盘交互 |
| 工作树 | 新建/已有分支、打开、加入工作区、文件管理器、锁定/解锁、普通/强制删除、Prune | 使用已有缓存，去掉仓库状态变化引起的重复加载 | 多工作树锁定/删除、窗口打开和真实目录显示 |
| 子树 | 添加/注册、拉取/推送、Split/Merge、编辑/删除注册、删除文件、路径打开、推送状态 | 去掉已缓存列表的重复加载，保留原有状态检查与操作链路 | 真实远端、状态查询取消/失败、不同历史合并策略 |
| 同步 | 收发方向、仓库选择、提交列表/聚合文件、普通/策略更新、发布/推送、安全强推/标签、Fetch、提交编辑/撤销/Revert/Drop/Squash、Cherry-pick | 消息编辑/Squash 复用多行编辑器与错误显示；详情失败可重试并取消过期请求；Cherry-pick 按源列表逆序执行；增加文件路径搜索、受限并发详情缓存与传入文件冲突警告 | 真实远端与凭据、分叉/拒绝推送、搜索/取消/重试交互与列表像素对照 |

## 后端指针对齐

插件普通子模块 Update 以父仓库 HEAD 中的 gitlink 为目标。Desktop 原来只执行 `git submodule update`，已暂存新指针时会继续沿用 index，可能没有任何变化。

本轮在普通 Update/UpdateAll 前，仅针对非冲突且 index 与父 HEAD 指针不同的已声明子模块恢复 index 指针；远端更新不使用此步骤。沿用仓库相对路径校验、literal pathspec、现有写锁和命令错误传播。状态判断也比较父 HEAD 与子模块当前 HEAD，避免已暂存新指针掩盖未同步状态。

## 删除冗余

`PushPanel.tsx` 完整旧推送组件已无运行时调用；`SyncPanel` 仅依赖其中的文件列表。已提取为 `SyncFileList.tsx`，删除旧组件及只覆盖旧组件的测试。保留现有同步页和 Store 的回归测试，没有新增单元测试；调整原有刷新断言以检查不重复加载。

## 修改文件

| 文件 | 作用 |
| --- | --- |
| `src/components/CommitPanel.tsx` | 各页重新访问时刷新，删除手动刷新中的重复请求 |
| `src/App.tsx` | 按 workspace ID 隔离面板局部状态 |
| `src/components/StashPanel.tsx`、`ShelfPanel.tsx`、`WorktreePanel.tsx`、`SubtreePanel.tsx` | 缓存与失败状态保护，减少重复加载 |
| `src/components/SubmodulePanel.tsx` | 元数据、Update/Sync 范围、取消初始化确认与 busy/工作区保护 |
| `src/components/SyncPanel.tsx` | 详情错误处理、多行消息编辑、Cherry-pick 顺序、路径搜索与冲突提示 |
| `src/components/SyncFileList.tsx` | 从旧推送组件提取的实际文件列表，搜索展开与潜在冲突标记 |
| `src/store/appStore.ts` | 外部 stash/子模块变化刷新，子模块操作后的工作区保护 |
| `src-tauri/src/vcs.rs` | 子模块父指针比较和 Update 指针对齐 |
| `src/i18n/index.tsx`、`src/styles.css` | 对应翻译、状态与错误提示样式 |
| `src/components/CommitPanel.test.tsx` | 调整既有刷新断言 |
| `src/components/PushPanel.tsx`、`PushPanel.test.tsx`（删除） | 已无运行时入口的旧组件及对应测试 |
| `docs/commit-panel-parity-2026-09-30.md` | 本轮对照范围、修复和验收限制 |

## 验证边界

- 前端：11 个相关测试文件、227 项既有测试通过；TypeScript、ESLint、i18n 检查通过。
- Rust：6 项子模块相关既有检查通过，包括真实 Git 生命周期和冲突处理；fmt 与 clippy 通过。
- 构建：前端构建、bindings 一致性检查及 macOS Debug App 打包通过。既有打包体积/静态与动态 import 警告仍存在。
- 原生 App 已启动；界面自动化读取控件与截图超时，因此未取得本轮原生交互截图，不能宣称七页已完成像素或真实运行验收。
- 最初浏览器演示截图不作为当前版本的验收证据。
- 真实远端/凭据、Windows/Linux，以及子模块已暂存指针场景的 App 内操作仍待实际验收。

## 后续截图反馈修复

用户明确要求同步提交初始收起；该项以本次要求为准，覆盖插件当前源码自动展开首条待推送提交的行为。

- 更改页仓库标题整行响应折叠和 pointer；目录/文件 hover 操作区补打开文件、回滚、冲突编辑器与 SVN 添加，复用现有确认和操作路径。
- 同步提交初始收起，移除仓库标题上的冲突数量；保留传入文件本身的潜在冲突标记。
- 更改页各视图和同步页的分支徽标复刻 hover 上浮、增亮和阴影；标签按钮与仓库标题补 hover 背景。
- 修订按钮从删除仓库小按钮的固定 12px CSS 中排除，禁止缩窄和换行；选择框边框由 1px 改为 1.5px、圆角由 2px 改为 3px。
- “在日志中打开”保留当前日志筛选，逐页查找目标提交、滚动并选中，搜索框不写入 hash。用户确认之前的定位实现正确，已撤回随后误加的内部 hash 筛选。
- 仓库类型徽标统一使用插件的 charts-orange/charts-purple 颜色；SVN 的 trunk 是分支名，使用 git-branch 图标和分支色，HEAD/BASE 仍使用 versions 图标。
- 默认仓库调色板顺序与插件对齐，自定义颜色不覆盖。SVN HEAD 为金色、BASE 为其分支色；被选中日志行的 ref 徽标使用实色背景和深色文字。
- SVN 有效 revision 使用 svnversion 区间上界与根目录 revision 的较大值，对齐插件对部分提交后混合 revision 工作副本的处理；缺少 svnversion 时回退根目录 revision。
- 排除远端 HEAD 使用完整 ref 路径，避免其短名称缩成 origin 后成为多余远端分支。

新增涉及文件：`src/components/BranchRefBadge.tsx`、`src/components/CommitDetailPanel.tsx`、`src/components/HistoryWorkspace.tsx`、`src/components/ChangelistGroup.tsx`、`src/components/ChangelistView.tsx`、`src/components/VscodeChangesView.tsx`、`src-tauri/src/workspace.rs`，以及上方已列出的面板、Store、样式和 VCS 文件。

后续验证：232 项相关既有前端测试、27 项 SVN 相关 Rust 检查通过；TypeScript、lint、i18n、bindings、前端构建与 macOS Debug App 打包通过。1422 的固定演示数据不作为原生 App 验收依据；该地址虽运行当前源码，仍无法代表真实仓库或后端运行。

## 全标签页展开与 hover 补漏

- 新增 `RepositoryGroup.tsx`，供搁置、暂存、工作树、Subtree 复用可展开的仓库标题。更改的三个视图、子模块、同步补全标题空白区域点击与 `aria-expanded`；操作按钮与选择框不会触发标题折叠。
- 搁置、暂存的仓库展开状态接入原有全部展开/收起命令；工作树、Subtree 单仓库也有可展开标题。搜索不会阻止同步仓库收起。
- 面板按钮 hover 使用浅色半透明背景与 4px 圆角。仓库标题维持仓库色，文件/目录主按钮保持透明，由整行提供列表 hover；只给右侧操作按钮独立背景。保留提交、推送、拉取、危险操作原有强调色与拆分按钮形状。
- 同步待推送/待拉取徽标排除通用 hover，背景、颜色与 8px 胶囊圆角保持稳定。
- 提交输入框暗文显式使用 placeholder 主题色，缺失时回退灰色 `versiondock-muted`，不再回退正文色；保持不透明度 1。
- 文件右侧冲突处理图标使用插件的 `gitDecoration-conflictingResourceForeground`，缺失时回退红色 `versiondock-danger`；hover 保持红色图标与浅色圆角操作背景。
- 同步汇总更改不再传入潜在冲突标记，移除汇总文件旁黄色警告图标；提交详情的原有标记单独保留。
- 本轮在当前源码的 1430 浏览器演示中，七页仓库标题都检查过展开→收起→展开，工作树标题操作按钮也检查过不误触折叠。之后浏览器工具连续超时，未完成后续颜色修正的截图验收；演示验证不代表原生桥接或真实仓库验收。
- 最后补漏后，11 个文件、230 项既有前端测试通过，未新增单元测试；TypeScript、lint、i18n 与 diff 空白检查通过。bindings 一致性检查和 macOS Debug App 打包成功；汇总文件冲突标记已移除，hover 排除规则已加入。后续恢复日志定位、调整红色冲突图标和灰色暗文；原生交互及后续 hover 颜色截图仍未验收。

本轮主要涉及 `RepositoryGroup.tsx`、`StashPanel.tsx`、`ShelfPanel.tsx`、`WorktreePanel.tsx`、`SubtreePanel.tsx`、`SubmodulePanel.tsx`、`CommitPanel.tsx`、`ChangelistGroup.tsx`、`ChangelistView.tsx`、`VscodeChangesView.tsx`、`SyncPanel.tsx`、`HistoryWorkspace.tsx`、`appStore.ts` 和 `styles.css`。
