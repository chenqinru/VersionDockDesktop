# “打开更改”页面修复验收（2026-10-02）

修复此前检查确认的五项问题，保留原有单提交、工作区和跨仓库入口。

## 完成项

| 项目 | 修复行为 | 验证 |
| --- | --- | --- |
| 差异版本和选区历史 | 抽取 resolveDiffRevisions，单文件和更改页面共同使用。Git 已暂存传 HEAD/INDEX，未暂存及未跟踪传 INDEX/WORKTREE，SVN 传 BASE/WORKING；提交及聚合范围继续使用真实比较起止版本。 | [已暂存版本](staged-revisions-fixed.png)、[未暂存版本](unstaged-revisions-fixed.png)、[SVN 工作区](svn-working-revisions-fixed.png)，三个真实组件/Bridge 映射场景测试 |
| 路径筛选 | openCommitChanges 将 historyQuery.path 交给现有文件目标生成器，仅打开当前筛选内的文件。 | [原生只保留 demo.txt](path-filter-preserved.png)，Store 筛选测试 |
| 聚合列表 | 同一仓库的文件目标只渲染一次，不再按每个提交重复放置同一聚合目标；多提交显示聚合摘要，文件统计和选中行与实际聚合范围一致。 | [原生聚合 2 个提交、5 个唯一文件](aggregate-files-fixed.png)，组件验证一个同名目标只出现一次、仅一行选中及真实起止版本请求 |
| 重复请求 | 当前目标加载中点击行或右键查看差异保持请求，Store 也跳过相同目标的并发加载；切换到其他目标仍正常取消旧请求，失败仍可重试。 | 异步组件/Store 测试确认重复点击及直接重复调用不增加请求、不取消现有信号；已有切换和失败恢复测试通过 |
| 文件路径提示 | 所有文件行及名称有完整路径 tooltip，成功预览增加文件类型图标、当前完整路径及版本范围标题。合并重复文件行渲染，并使顶部图标按钮复用统一样式。 | [原生长路径标题](long-path-title-fixed.png)，组件路径、图标和 tooltip 测试 |

## 选区历史原生复现

沿用真实临时 Git 仓库：HEAD 文件 80 行，索引先插入两行，未暂存修改原第 5 行。原实现把未暂存左侧第 7 行直接查作 HEAD 第 7 行，仅返回 base history；修复后传入 INDEX 交给 Rust 映射成 HEAD 第 5 行，正确返回 first edit demo。见 [映射后的历史](mapped-line-history-fixed.png)。

## 检查结果

- 完整 `npm run check:frontend` 通过：类型、lint、国际化、绑定、构建，以及 59 个测试文件中的 573 个测试，见 [日志](frontend-check.log)。
- 定向更改页面、差异页面和选区历史回归共 18 个测试通过，见 [定向日志](targeted-tests.log)。新增测试调用真实组件及 Store，验证 Bridge 的可变版本和行号映射、聚合范围、筛选、请求去重与路径显示。
- 独立原生 QA App 使用真实 Git/SVN 仓库，完成版本、历史结果、路径筛选、聚合列表、SVN 和长路径显示验证，见 [原生结果](native.json)。加载中请求去重以受控异步组件/Store 测试为证，不宣称已覆盖全部原生慢网络场景。
- `git diff --check` 通过。本轮没有 Rust 或绑定结构变更，沿用已验收的真实后端映射能力，未重复跑 Rust 全套。
- QA App/server 已停止，QA profile 已恢复，未自动提交，见 [清理结果](cleanup.json)。插件及用户的项目仓库没有作为测试对象修改。

本轮按仓库保留已有聚合目标及比较范围，不把它描述为完成所有跨分支、非连续选区、超大仓库和二进制类型组合的验收。
