# 提交日志与变更详情对齐记录（2026-10-01）

范围：日志列表与筛选、右侧变更详情、独立单提交详情、聚合提交详情、文件 diff 和全部变更入口。继续排除 AI 与舒适布局，保留已验收的分支图谱及灰色选中/加载语义。用户截图记录 App 当前状态，插件源码和实际 Extension Development Host 才是参考目标。

## 对照依据

只读核对插件 `src/webview/gitLog/main.tsx`、`CommitList.tsx`、`CommitFiltersBar.tsx`、`CommitDetail.tsx`，以及宿主 `GitLogPanelProvider.ts`、`CommitDetailPanel.ts`、Git/SVN 日志服务。App 使用 React/Zustand/Rust/Tauri 的独立实现，没有导入 VS Code 运行时代码。

实际打开插件与原生 Tauri App，使用同一套临时 Git/SVN 仓库比较页面、选择、菜单和文件内容。原生截图、测试输出和版本信息位于 `docs/manual/history-detail-2026-10-01/`。

## 行为核对与修改

| 范围 | 核对结果与本轮修改 |
| --- | --- |
| 日志筛选 | 保留文本/作者/仓库/本地分支及标签/日期/文件与行历史筛选、清空和分页链路；核对仓库与 ref 范围联动。更多菜单补齐 Escape 和失焦关闭。 |
| 行选择与操作 | 保留单选、Ctrl/Cmd 多选、Shift 范围、单/多提交 patch、cherry-pick、revert、reset、分支、标签、编辑/撤销/丢弃/合并；修正反复 Shift 选择时的固定锚点、最后一项 Ctrl/Cmd 取消后的选择保持。跨仓库右键退回单提交操作与插件一致。 |
| 推送状态 | 无 upstream 且无远程 refs 时将所有可见提交标记为未推送；存在远程 refs 时排除已在远程可达的提交；有 upstream 时使用 upstream..HEAD。去除标记查询的 500 条截断。由此恢复未发布提交的箭头和重写菜单入口。SVN 以本地有效 revision 标记待更新提交。 |
| 侧栏文件区 | 对齐文件单复数、树/平铺、仓库分组条件、22px 虚拟行高、收起/展开及文件状态统计。删除无对应插件入口的文件历史按钮与文件历史右键项；右键文件使用灰色高亮。 |
| 文件搜索 | 提炼可编辑搜索框和搜索 hook，支持 Cmd/Ctrl+F、直接键入、上下/Enter/Shift+Enter、匹配数、自动展开父目录、虚拟列表滚动定位、Escape 恢复。搜索不再 4 秒自动消失。 |
| 侧栏摘要 | “默认展开提交信息”保存为偏好，并作用于随后选择的提交；修正拖动仍被 48% CSS 上限限制的问题，按自身容器高度约束，复用已有拖动清理逻辑。 |
| 独立详情 | 左摘要/右文件结构已存在，本轮修正左右占比、最小宽度、36px 作者头像和元数据字号/间距；显示完整文件列表，不受日志文件历史筛选裁剪。每个工作区及独立选择保存树/平铺偏好。 |
| 聚合详情 | 保留提交数量、仓库数量、时间范围、逐条完整消息/作者/日期/短 hash/refs；按仓库隔离相同路径、按较新状态保留文件并累计统计。独立聚合页只提供 diff、打开文件、定位；独立单提交页仅提供适用的还原，侧栏保留 cherry-pick，合并父提交禁用写操作。 |
| diff 范围 | 多选包含 Git 根提交时以空树为基准；普通多选使用最早提交的第一父提交至最新提交，SVN 使用最早 revision-1。合并父提交使用指定父 hash。统一 diff 旧版本元数据，修正 SVN 与根提交行历史/文件内容入口。全部变更入口加载完整文件。 |
| 异步保护 | 切换提交清除旧文件/diff，并废弃迟到的 diff；文件/目录确认框打开期间切换工作区时不执行写操作。清理延迟加载图标定时器。 |
| 冗余清理 | 删除未使用的详情类型、revision helper；共用比较基准和已有拖动 hook，保持不同页面的菜单语义。 |

## 原生验收

- 单提交详情：真实作者、邮箱、完整 hash、时间、包含分支、完整消息；文件 diff 与返回详情/历史。
- 包含根提交的两提交聚合：汇总两个文件，`root.txt` 累计 +2；实际 diff 左侧为空，右侧同时出现 `root line` 与 `second line`。
- 跨仓库聚合：alpha 与 beta 的 `src/renamed.txt` 独立显示，三个汇总文件；聚合文件菜单不出现还原或 cherry-pick。
- 65 文件：实际树/平铺切换，Cmd+F 打开可编辑搜索，定位 `item_64.ts` 显示 1/1 并滚动至最后一行；Escape 关闭。输入法影响键入时，精确查询通过 macOS Accessibility 设置原生输入框值，未注入页面脚本。
- 摘要 resize：实际拖动从 220px 扩大至约 498px，超过原来的 48% 限制，文件区仍有空间。
- 合并提交：无冲突提示、两组父提交，展开主线父提交后真实加载 `feature.txt`，实际 diff 显示 `feature detail`。
- SVN：真实 r3 的 `payment.txt` diff 同时显示原有 `payment base` 和新增 `payment next`。
- 最新 Rust 原生运行中，无 remote/upstream 的 alpha/beta 提交显示未推送箭头。
- 插件实际打开相同单提交/聚合详情，核对信息、分区及聚合菜单；VS Code Explorer 定位与 OS 定位在 App 中合为系统文件管理器入口。宿主编辑器布局差异不机械复制。

## 检查与边界

- `npm run check:frontend`：523 个测试（50 个文件），i18n、类型、lint、bindings 和生产构建全部通过。
- `VERSIONDOCK_REQUIRE_VCS_TESTS=1 cargo test --locked --manifest-path src-tauri/Cargo.toml -- --test-threads=1`：117 个真实 Git/SVN 与后端测试全部通过。
- `cargo fmt --check`、全 targets/features 的 clippy（`-D warnings`）通过；标准 identifier 的 debug 构建已恢复。
- 插件仓库保持干净，App 修改未提交。
- 原生验收覆盖 macOS 及上述明确场景。Windows/Linux、真实网络账户和所有破坏性操作确认分支未逐项原生重演；这些操作的后端由真实临时仓库集成检查覆盖。主题、语言、头像与宿主外框不同，不宣称整页像素误差为零。


## 灰色选中反馈补齐（同日反馈）

用户标记的树/平铺切换按钮背景已经使用灰色，但旧规则仍把图标颜色设为强调蓝。本轮将该规则改为共享选中前景变量，并补齐 toolbar/menu 的共享颜色映射及 `--versiondock-selection-border`。统一设置导航、主题/图标选择卡、输出菜单和开关、下拉选项、checkbox、tab 指示线、当前分支菜单、已选分支标签、文件选择标记及合并面板切换的选中状态。普通分支/文件状态/推送方向的语义颜色保留。

原生 App 已确认树/平铺按钮和选中提交中的分支标签为灰色；证据为 `app-neutral-selection.png`。523 个前端测试及完整 frontend 检查通过。

右键菜单删除的是详情区原先额外的「文件历史」「在提交日志中显示」入口，相关文件历史功能本身保留。侧栏保留「还原所选更改」「优选所选更改」；独立单提交详情提供适用的还原，独立聚合详情与合并父提交不提供写操作。这是页面范围规则，不是删除后端能力。
