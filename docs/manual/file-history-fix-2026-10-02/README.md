# 文件历史面板修复验收（2026-10-02）

修复此前检查确认的九项问题，包含 SVN 多文件提交状态解析的补充缺陷。只修改独立 App，插件继续作为只读参考。

## 修复结果

| 项目 | 完成行为 | 证据 |
| --- | --- | --- |
| 重复点击当前版本 | 保留当前预览和视图模式，不清空内容或卡在加载中。列表分页与版本预览分别管理加载状态；关闭/切换目标时取消请求并丢弃旧结果。 | [原生重复点击](reselect-fixed.png)，组件重复选择和旧请求测试 |
| 历史源码与差异模式 | “打开此版本”显示完整源码，“查看差异”显示对应版本的变化，右键与顶部按钮语义一致。首次创建版本默认源码，无前置版本时禁用差异模式。 | [源码](source-mode-fixed.png)、[差异](diff-mode-fixed.png)、[右键打开版本](menu-source-fixed.png)、[右键查看差异](menu-diff-fixed.png) |
| 加载失败与重试 | 不再吞掉比较错误或静默退化为源码，显示错误及重试；历史列表请求也提供重试。 | [真实仓库不可用后的错误](comparison-error-visible.png)、[恢复后重试成功](comparison-retry-fixed.png) |
| 源码内容搜索 | 复用搜索控件，支持 Cmd/Ctrl+F、匹配计数、上下跳转、Enter/Shift+Enter/F3、Escape，并保留语法颜色。纯文本/无法高亮的行始终显示原文，搜索使用灰色高亮。 | [原生首次版本 Cmd+F](source-search-fixed.png)，源码回退及搜索测试 |
| 弹窗交互 | 接入统一焦点管理，Tab/Shift+Tab 限制在弹窗内；Escape 先关闭菜单/搜索，再关闭弹窗并恢复之前焦点。 | [关闭搜索](escape-search-closed.png)、[关闭弹窗](escape-dialog-closed.png)、[Tab 焦点记录](focus-native.txt) |
| 空历史与日期 | 空列表显示“暂无历史”，Git/SVN 时间统一复用主日志日期格式，并保留原始日期 tooltip。 | [空历史](empty-history-fixed.png)，列表截图及组件测试 |
| Git 特殊路径 | 文件历史使用 NUL 分隔和 literal pathspec，保留制表符、换行、引号、控制分隔符以及 Unix 文件名中的反斜线。 | [原生制表符文件名](git-special-filename-fixed.png)，真实 Git 特殊路径及分页集成测试 |
| SVN 重命名、目录复制和状态 | 按目标路径匹配 verbose log 的 changed path，沿 copyfrom 追踪文件/父目录历史，正确区分新增、修改、复制和重命名；历史读取通过带 peg revision 的仓库路径访问已不在工作副本中的旧文件，并正确编码 URL 路径。 | [旧路径版本差异](svn-old-path-fixed.png)、[旧路径源码](svn-old-source-fixed.png)，真实 SVN 文件重命名、跨目录复制、分页、状态和特殊 URL 路径集成测试 |

## 验证

- 完整前端检查通过，包含类型、lint、国际化、绑定、构建及 58 个测试文件中的 565 个测试，见 [前端日志](frontend-check.log)。
- 完整 Rust fmt、clippy 和 126 个测试通过，见 [Rust 日志](rust-check.log)。
- 原生使用独立 QA App/profile，真实临时 Git/SVN 仓库。通过鼠标、AX 和系统快捷键操作，不把 mock 测试视为原生验收。
- 原生验证重复选择、菜单/顶部模式切换、首次源码搜索、Escape 分层关闭、焦点范围、空历史、日期、特殊 Git 文件名、SVN 旧路径读取及比较失败恢复。见 [Git 结果](git-native.json)、[其他功能结果](other-native.json)、[右键菜单结果](menu-native.json)。
- 比较失败通过临时移走测试 SVN 仓库模拟，恢复后点击重试成功。测试仓库已恢复；验证复制版本号时保存和恢复全部剪贴板类型，没有保留用户剪贴板内容。
- 标准开发构建已恢复；QA App/server 已停止，QA profile 已恢复，见 [清理结果](cleanup.json)。未自动提交。

本轮范围为确认的问题及相关回归。真实集成测试覆盖小分页和历史追踪，不将其描述为完成所有超大仓库、全部二进制类型、所有远程网络和平台组合的验收。
