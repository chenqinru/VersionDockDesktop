# 文件历史面板功能检查（2026-10-02）

本轮只检查，没有修改业务源码。审查前端 FileHistoryPanel、SourceCodeView、Store、Bridge 和 Rust 文件历史/历史版本读取链路，结合独立 QA 原生 App 及临时 Git/SVN 仓库复现。

插件的文件历史入口主要将路径/选区筛选发送到提交日志面板，App 增加了独立弹窗。因此本轮同时检查弹窗自身的行为一致性，不把插件未提供的弹窗设计直接判为缺陷。

## 确认的九项问题

| 优先级 | 问题 | 事实、影响与定位 |
| --- | --- | --- |
| 高 | 重复点击当前版本后无限加载 | `choose()` 清空 document/diff 并设置 loading，但 setSelected 仍是同一个对象，版本加载 effect 不重新执行。原生点击默认选中的最新版本后右侧持续“正在加载文件...”；组件验证没有产生新请求。[选择处理](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/FileHistoryPanel.tsx:84) |
| 高 | SVN 重命名前的版本无法读取 | SVN log 能跟随复制历史返回旧路径的 revision，但所有 entry.path 固定为当前 new-name.txt，previousPath 一直为空。r3 重命名之后查看 r2，实际请求 new-name.txt@2，原生报 W160013 path not found，应读取 old-name.txt@2。[SVN 条目构造](/Volumes/WorkSSD/Project/VersionDockDesktop/src-tauri/src/vcs.rs:2480) |
| 中 | Git 特殊文件名被解析错误 | Git name-status 输出对制表符等进行 C 风格引号转义，当前按文本行和 TAB 分隔却没有解码，也未使用 NUL 分隔。真实 `tab<TAB>file.txt` 被记录为带引号和反斜线的路径，后续相对路径转换将其变成 `"tab/tfile.txt"`，原生读取报 fatal path does not exist。普通空格、中文的既有测试不能覆盖此问题。[Git 条目解析](/Volumes/WorkSSD/Project/VersionDockDesktop/src-tauri/src/vcs.rs:2530) |
| 中 | “打开此版本”和“查看差异”执行同一操作 | 两个菜单项都调用 choose(entry)，没有源码/差异模式区分。选一个非当前条目并执行 Open Revision，组件仍显示 UnifiedDiffView，不能按菜单含义直接打开完整源码；对当前条目执行还会触发第 1 项。[菜单处理](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/FileHistoryPanel.tsx:126) |
| 中 | 差异加载失败后静默退化为源码 | 比较请求 catch(() => undefined)，失败原因没有进入弹窗 error。组件模拟失败后只显示该版本源码，未说明比较失败，也没有单独重试入口。全局操作通知可能另行报告失败，本项针对弹窗内的错误和视图语义。[比较请求](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/FileHistoryPanel.tsx:78) |
| 中 | 初次创建版本的源码视图缺少内容搜索 | 没有 previousRevision 时使用 SourceCodeView；它没有搜索控件和 Cmd/Ctrl+F 处理。原生查看 Git 根提交并在源码区按 Cmd+F，没有搜索输入，和相邻版本的 diff 搜索行为不一致。[源码视图](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/SourceCodeView.tsx:31) |
| 中 | 弹窗未管理 Escape 和焦点范围 | 没有接入现有 useDialogFocusTrap。原生按 Escape 弹窗不关闭；打开弹窗后按 Tab，AX 焦点落到弹窗背后的左下角分支状态栏。aria-modal=true 没有实现实际焦点隔离。[弹窗结构](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/FileHistoryPanel.tsx:108) |
| 低 | 空历史没有说明 | 未跟踪、尚未提交文件的历史返回空数组后，左侧和右侧全部空白，没有“暂无历史/文件尚未提交”等提示。组件和原生均复现。[列表与主体](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/FileHistoryPanel.tsx:117) |
| 低 | 日期直接显示原始时间串 | 列表直接拼接 entry.date，Git 展示 2026-10-02T18:35:41+08:00，SVN 展示含小数秒的 UTC 字符串，和主日志日期格式不一致。截图也能看到原始时间占据列表空间。[列表日期](/Volumes/WorkSSD/Project/VersionDockDesktop/src/components/FileHistoryPanel.tsx:117) |

SVN 条目解析另有同一代码路径下的问题：它选取 verbose log 的第一个 changed path 决定 status，而不匹配目标文件。本轮临时仓库的 r5 同时新增 a-file.txt、修改 z-file.txt，z-file.txt 的日志 XML 第一项为 a-file.txt/A，因此后端会把 z-file.txt 标成 A。本项记录为 SVN 解析缺陷的补充证据；没有把尚未完成原生复现的错误删除预览作为单独结论。

## 复现证据

- [Git 文件历史初始状态及原始日期](git-history-open.png)
- [重复点击选中条目后无限加载](reselect-stuck.png)
- [Escape 后弹窗仍在](escape-still-open.png)，[Tab 焦点进入背景状态栏](tab-focus-outside.txt)
- [SVN 文件历史包含重命名前的记录](svn-history-open.png)，[点击旧路径版本后报错](svn-before-rename-error.png)
- [Git 制表符文件名读取失败](git-tab-error.png)，[实际 Git name-status 输出](git-tab-history.log)
- [未提交文件历史全空白](empty-history.png)
- [首次创建版本源码及 Cmd+F 后无搜索控件](initial-version-no-search.png)
- [SVN 原始历史 XML](svn-history.xml)、[多文件提交 XML](svn-z-history.xml)

## 验证与边界

既有 V3 身份/文件历史组件测试 4 个通过，相关 Rust 历史测试 5 个通过。新增临时审查测试 6 个通过，验证了重复选择、菜单操作、空列表、Escape、错误吞掉行为，并反证了“Git 旧文件名选区历史仍用当前路径”的猜测：UnifiedDiffView 实际会传入历史 path，调用结果正确，不列为缺陷。见 [临时测试源码](probe-source.txt)、[审查测试结果](probe-tests.log)、[既有组件测试](existing-tests.log)、[Rust 测试](rust-existing-tests.log)。临时测试已经从 src/components 移除。

重复选择、SVN 旧路径、Git 特殊文件名、空历史、源码搜索、Escape/焦点以及日期显示均有原生证据。右键两个菜单项的语义和比较失败处理以源码及组件测试为证，没有伪装成已完成原生菜单或网络故障验收。

本轮没有对全部分支、100 条以上分页、所有二进制类型、远程凭据过期或全部历史删除场景做完整验收，也没有把所有用例通过表达为面板无缺陷。现有分页游标绑定仓库/路径/版本，关闭和切换路径时取消请求的保护已存在。

建议先修复重复选择及历史路径解析，再区分源码/差异模式和错误状态，最后统一搜索、弹窗交互及日期显示。QA 使用独立 App profile，检查后已停止自己的进程并恢复 profile；未修改插件或用户的项目仓库，未自动提交。
