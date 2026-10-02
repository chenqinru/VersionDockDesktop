# 文件 diff 功能检查（2026-10-02）

本轮仅检查，没有修改业务源码。对照了插件调用 VS Code 原生 diff 的代码路径，审查 App 的 Rust diff 生成、状态传递与 React 渲染，并在独立原生 Tauri App 的临时 Git/SVN 仓库复现。

## 确认的问题

| 优先级 | 问题 | 复现及影响 |
|---|---|---|
| 高 | 未暂存差异左侧版本用于选区历史时不正确 | 后端 `git diff` 实际比较索引与工作区，但 `DiffWorkspace` 默认将左侧设为 HEAD。先暂存两行插入再修改，索引行号比 HEAD 多两行；左侧选区历史却使用 HEAD 和索引行号，查到错误位置或报错。组件复现断言确认传入 HEAD。 |
| 高 | 暂存的纯重命名显示为整文件新增 | `old-name.txt` 改为 `new-name.txt`，内容不变。暂存差异只限制新路径，没有与旧路径一起解析重命名，原生 App 左侧为空、右侧整行绿色新增。历史/显式范围路径已有候选旧路径处理，工作区/暂存分支缺失。 |
| 高 | SVN 无法展开完整上下文，跨区块行号直接跳跃 | 80 行文件只改第 5、65 行。后端默认 SVN diff 仅提供每处 3 行上下文，点击“扩大差异”仍只有 14 行代码；画面第 8 行紧接第 62 行，没有缺失区段的展开入口。Git 使用全上下文参数，两端实现不一致。 |
| 中 | 分栏视图跳过元信息 | 渲染遇到 `meta` 直接 return null。纯重命名元信息、文件权限变化、末尾缺换行说明和 SVN 属性标题无法显示。组件用标准纯重命名 patch 验证：分栏显示“无更改”，切到内联才显示 rename from/to。SVN 属性区块还被当作文件行号渲染。 |
| 中 | 选中右侧未改动文本也会禁用选区历史 | 判断条件把所有带 `.new` 的单元格都当作未提交新增，不区分 `.context`。原生选中右侧 `line 002 original content` 后，“显示选区历史”置灰；该文本已有提交历史。 |
| 中 | 窗口缩放覆盖用户手动选择的视图 | ResizeObserver 每次直接按宽度设置 split/inline。原生先选内联，再轻微放宽窗口，自动恢复分栏。组件重现也通过。 |
| 中 | 文件内容搜索未接入 | diff 组件未使用现有搜索 hook/搜索控件，也没有 Cmd/Ctrl+F 处理。原生鼠标位于 diff 区按 Cmd+F，没有搜索输入或匹配结果。 |
| 低 | 顶部行数实际统计 patch 行数 | `make_diff` 对 patch 文本做 lines().count，包含头部和新旧双方修改。真实 82 行的 Git 文件显示 89 行；真实 80 行 SVN 文件显示 22 行。截图中的数字不能代表文件行数。 |
| 低 | 没有选区时复制操作可点，但没有作用 | 内层菜单始终启用 Copy，处理函数只有 selectionText 非空才写剪贴板。组件交互确认无选区点击后不调用 writeText，应禁用或提供明确复制范围。 |

## 定位

- [左右版本语义](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/DiffWorkspace.tsx:43)
- [工作区/暂存 Git diff](/Volumes/WorkSSD/Project/VersionDockDesktop/src-tauri/src/vcs.rs:1129)
- [SVN diff 参数](/Volumes/WorkSSD/Project/VersionDockDesktop/src-tauri/src/vcs.rs:1143)
- [patch 行数统计](/Volumes/WorkSSD/Project/VersionDockDesktop/src-tauri/src/vcs.rs:1203)
- [选区历史禁用条件](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/UnifiedDiffView.tsx:645)
- [复制处理](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/UnifiedDiffView.tsx:661)
- [视图自动覆盖](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/UnifiedDiffView.tsx:775)
- [分栏忽略元信息](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/UnifiedDiffView.tsx:869)

## 本轮截图

- [Git 工作区 diff：82 行文件显示 89 行](git-working.png)
- [Cmd+F 后没有搜索控件](cmd-f.png)
- [手动内联视图](manual-inline.png)
- [缩放后恢复分栏](resize-overrides.png)
- [未改动文本的选区历史被禁用](context-selected.png)
- [SVN 扩大差异后的缺失上下文](svn-expanded.png)
- [暂存纯重命名被显示为新增](rename-split.png)

## 验证与边界

现有 diff 的 20 个组件测试通过，额外 5 个临时检查验证了元信息丢失、左侧历史版本传递、视图覆盖、无选区复制等行为。JSDOM 无法忠实模拟真实浏览器选区包含关系，因此未改动文本被禁用的判断以原生截图为证，不以该临时 JSDOM 检查作为证明。

未把左右简单按序配对直接判为错误，也未仅凭截图断言水平滚动有缺陷。超大文件、跨虚拟行复制、stash/shelf 切换竞争、全部二进制类型等边界没有完成原生验收，不列为已确认问题。

建议先修正左右版本、重命名和 SVN 上下文，再补齐搜索/选区操作与视图状态，最后处理统计和展示细节。插件使用 VS Code 编辑器，App 使用自实现视图；若后续要求同等编辑器能力，需要明确选择继续维护当前组件还是引入专门的 diff 编辑器。
