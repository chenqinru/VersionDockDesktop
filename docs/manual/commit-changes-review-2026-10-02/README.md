# “打开更改”页面检查（2026-10-02）

本轮仅检查，没有修改业务源码。审查 CommitChangesWorkspace、Store 的打开/加载路径、聚合文件目标和插件 vscode.changes 的调用；用独立 QA 原生 App 和真实临时 Git/SVN 仓库验证页面行为。

## 确认的五项问题

| 优先级 | 问题 | 影响与证据 |
| --- | --- | --- |
| 高 | 工作区差异的选区历史版本错误 | 此页面仍把工作区左侧统一设成 HEAD、右侧设成 undefined。Git 已暂存应为 HEAD/INDEX，未暂存应为 INDEX/WORKTREE；SVN 也未明确传 BASE/WORKING。真实 Git 先在索引头插入两行，再修改原第 5 行：未暂存左侧第 7 行被直接查询为 HEAD 第 7 行，只返回 base history，漏掉真正修改它的 first edit demo；正确映射应为 HEAD 第 5 行。差异内容本身是索引与工作区比较，错误发生在选区历史版本/坐标。[版本传递](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/CommitChangesWorkspace.tsx:55)、[原生错误历史](wrong-line-history.png)、[Git 对比证据](line-history-evidence.txt) |
| 中 | 打开更改会丢掉文件历史路径筛选 | 日志筛选 demo.txt 后右侧变更详情只有 1 个文件，点击“打开更改”却显示当前提交的全部 4 个文件。Store 调用 buildCommitFileTargets 时没有传 historyQuery.path；插件传入的是 activeFiles，即过滤后的文件。[打开逻辑](/Volumes/WorkSSD/Project/VersionDockDesktop/src/store/appStore.ts:3031)、[筛选后的日志](filtered-history.png)、[打开后多出无关文件](filter-lost-in-changes.png) |
| 中 | 聚合提交下同一文件重复显示，分组和实际差异不一致 | buildCommitFileTargets 已按仓库/路径去重并为目标设置整个选区的起止版本，页面却按 commitHashes 再将同一个目标放到每个提交组。组件用两个提交均修改 same.txt 验证：目标数为 1，但渲染 2 行、2 行同时选中，点击两行均对应同一个聚合范围，而不是组标题代表的单次提交差异；加减统计也来自同一个合并目标。插件聚合入口是按仓库去重后生成资源。本项以真实组件 DOM 与数据链路为证，不宣称完成了原生多选截图。[分组渲染](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/CommitChangesWorkspace.tsx:125)、[临时验证](probe-source.txt) |
| 中 | 加载中再次点击当前文件会取消并重新加载 | handleSelect 把“尚未加载完成”视为需要重试，没有排除 diffLoading。组件延迟返回验证：初次请求 1 次，再点当前行增加为 2 次，第一条 AbortSignal 被取消。慢仓库下重复点击会不断重置等待；不是“加载完成后重复点击”问题，后者既有测试已经保护。[选择逻辑](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/CommitChangesWorkspace.tsx:76) |
| 低 | 长路径省略后无法确认当前文件全名 | 文件名 span 没有 title，成功预览又没有当前文件路径标题，顶部只显示提交消息。长目录前缀把 basename 挤到省略号后，悬停列表也没有完整路径提示。加载/错误占位有路径，不弥补成功预览缺失。[文件行](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/CommitChangesWorkspace.tsx:127)、[原生长路径预览](long-path-preview.png) |

## 验证结果与边界

既有 CommitChangesWorkspace 的 4 个测试通过，新增临时审查的 5 个测试通过，共 9 个。新增测试分别覆盖版本标识、聚合重复项、路径筛选、加载中重复请求、路径显示，见 [测试结果](component-tests.log)。审查源码保存为 txt，临时 src/components 测试已移除。

工作区错误选区历史、路径筛选丢失和长路径显示均有原生截图；聚合重复项和加载时重复请求通过组件及实际 Store/Bridge 调用验证。临时 Git 的 HEAD 文件 80 行、索引 82 行，原第 5 行与索引第 7 行的历史查询区别可直接从 Git 输出核对。

共享 UnifiedDiffView 的代码搜索、横向同步、选区保持，以及此页面的二进制/过大/加载失败重试占位已有实现，不重复判为缺失；既有测试验证正常切换只发一次请求、切换清除旧预览、失败重试恢复。单个提交的 Git/SVN 基本差异可以加载。

本轮没有覆盖全部跨分支/非连续聚合、全部二进制格式、所有删除/重命名操作、超过 100 个文件的性能和全部外部编辑器配置。没有把现有测试通过当成整页无问题。

建议先复用统一差异版本语义并保留路径筛选，再将聚合文件列表与聚合范围统一，排除加载中的重复请求，最后补齐路径提示/当前文件标题。本轮不修改实现，未自动提交。QA App/server 已停止，QA profile 已恢复，未改插件或用户项目仓库。
