# 代码选区右键高亮修复（2026-10-02）

通用 ContextMenu 原先在挂载时主动执行 removeAllRanges，导致代码选区高亮消失。为菜单增加 preserveSelection，差异视图及外层差异复制菜单启用该选项；点击菜单时阻止鼠标默认清除选区，保留已有复制和选区历史参数。App 的代码选区判定补齐 unified-diff 内的元信息代码。

[主差异视图右键菜单](selected-menu-open.png)和[文件历史多行选区](history-selected-menu-detail.png)均已在独立原生 QA App 验证，菜单显示时原灰色文本选中背景保留。

相关 5 个文件、87 个组件测试通过，新增回归覆盖选区在菜单打开、鼠标按下与复制时保持；类型检查、针对变更文件的 lint 和 git diff --check 通过。剪贴板验证前后保存、恢复全部类型，没有保留用户剪贴板。QA App/server 已停止并恢复 QA profile。本轮没有 Rust 变更，未自动提交。
