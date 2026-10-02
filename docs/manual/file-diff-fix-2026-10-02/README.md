# 文件 diff 修复验收（2026-10-02）

处理此前审查确认的九项问题，以及追加的左右分栏横向滚动同步。插件源码仅作为只读参考；本轮只修改独立 App。

## 修复及证据

| 项目 | 实现行为 | 验证 |
| --- | --- | --- |
| 左右版本与选区历史 | Git 未暂存比较 INDEX/WORKTREE，已暂存比较 HEAD/INDEX；SVN 比较 BASE/WORKING。Rust 将可变版本的选区映射回真实提交的路径、行号；纯新增行返回无历史，并丢弃切换文件后的旧查询结果。 | Git/SVN 真实仓库集成测试；组件 Bridge 参数、无历史和竞态测试；[原生历史结果](mapped-history.png) |
| 暂存纯重命名 | 查找新旧候选路径后同时参与 diff，保留 rename from/to，不误显示整文件新增。 | 真实 Git 集成测试；[原生纯重命名](rename-split-fixed.png) |
| SVN 全文上下文 | 主查询和历史 fallback 使用内部 diff 的完整上下文参数，能够真正展开中间行。 | 真实 SVN 集成测试；[80 行全文](svn-full-context.png) |
| 分栏元信息 | 按原位置保留路径、权限、缺尾换行、SVN 属性信息；属性内容不参与源文件行号。纯元信息不再显示“无更改”。 | 组件测试；[SVN 属性区块](svn-property-metadata.png)、纯重命名截图 |
| 右侧选区历史 | 未改动文本和有对应旧行的替换文本允许查询；仅未提交的纯新增行无历史。 | 组件测试；[右侧未改动选区菜单](context-history-enabled.png) |
| 手动视图选择 | 窗口尺寸只决定自动模式，用户明确选定的内联/分栏模式保持。 | ResizeObserver 组件测试；[原生缩放后内联](inline-after-resize.png) |
| 文件内容搜索 | 搜索按钮及 Cmd/Ctrl+F，匹配计数、上下跳转、Enter/Shift+Enter/F3、Escape；搜索完整已解析内容，能跳转到折叠区和屏幕外。搜索与文本选区使用全局灰色。 | 组件测试；[原生折叠内部搜索](find-hidden-line.png)、[Cmd+F](cmd-f-fixed.png) |
| 行数统计 | 主 diff 统计文件行号范围，元信息变更补读目标文件；删除文件显示旧侧行数。补丁大小限制独立保留。搁置 diff 复用统一文档生成函数。 | 真实 Git 82 行、SVN 81 行集成测试；[原生 Git 82 行](git-working-fixed.png)、SVN 原生 80 行截图 |
| 复制 | 有选区复制选区；无选区复制点击的代码或元信息行，无内容禁用。记录右键前的选区，避免 WebKit 自动选中单词导致只复制片段。 | 组件测试；[原生菜单](copy-no-selection-menu.png)、[复制验证结果](copy-native.json) |
| 横向滚动同步 | 两侧双向同步 scrollLeft，使用全文共同宽度和永久宽度占位，避免短侧提前到达滚动终点或长行被虚拟卸载后宽度缩小；切换视图保留位置，切换文件归零。 | 组件双向滚动、视图/文件切换测试；[左侧滚动](horizontal-from-left.png)、[右侧滚动](horizontal-from-right.png)、[最右端](horizontal-at-end.png)、[长行卸载后](horizontal-virtual-unmounted.png) |

## 原生验收

使用独立 QA Tauri App 和临时 Git/SVN 仓库，经过真实 Rust Backend 与 Bridge；未操作用户的项目仓库或现有 App 进程。

横向验收使用左右长度不同的修改行。AX 坐标记录显示，从左侧滚动 180px 时两侧文本都移动 180px；从右侧反向滚动 100px 时两侧都移动 100px。滚过短侧文本末尾、达到最右端仍保持相同偏移。再补入 500 行共同上下文，让最长行完全退出虚拟渲染范围，在底部滚动 240px 后两侧均移动 240px，返回顶部保持该位置。见 [坐标记录](horizontal-native.json)。

复制验收通过真实鼠标打开菜单、点击复制，核对无选区时复制整行 `line 010 original content`，已有选区时只复制 `line`。验收前后保存、恢复全部剪贴板类型，没有保留用户剪贴板内容。

## 检查结果与边界

- `npm run check:frontend` 通过：类型、lint、国际化、绑定、构建和 56 个文件中的 555 个测试，见 [前端日志](frontend-check.log)。
- `npm run check:rust` 通过：fmt、clippy 和 124 个测试，包含新增真实 Git/SVN 集成测试，见 [Rust 日志](rust-check.log)。
- 原生 QA 构建及验收完成，标准开发构建已恢复，见 [构建日志](standard-build.log)。
- `git diff --check` 通过。

本轮验证聚焦上述问题；不把浏览器 mock 或静态检查当作原生功能证据。旧搁置补丁可能仅含有限上下文，不能由补丁末尾行号推断完整文件总行数，本轮没有补做旧搁置全文恢复。超大文件、跨虚拟行复制以及全部二进制格式也未做完整原生覆盖。未自动提交。
