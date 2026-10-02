# 身份状态栏对齐验收（2026-10-02）

参考插件：`VersionDock/src/host/ui/ProfileStatusBar.ts`、`VersionDock/src/host/git/GitProfileService.ts` 和 SVN 认证流程。参考仓库保持只读。

## 对齐范围

- 状态栏显示当前 Git 提交身份或 SVN 账号，支持在身份菜单内切换管理仓库；不会改变提交面板的选中仓库或折叠状态，工作树不重复列入管理列表。
- 悬停名片显示姓名、邮箱、身份来源、远程托管账号连接状态、主远程/关联远程标记和当前仓库。头像复用 App 的作者头像服务并遵守现有在线头像设置。
- 主菜单保留身份入口上方的左下角弹出位置；身份动作菜单向右级联，空间不足时翻转并限制在视口内。
- 共用 `StatusBarQuickMenu`：统一标题、返回、搜索清除、名称/描述/详情筛选、方向键/Enter、Home/End、Escape 返回、外部点击/失焦关闭和灰色选择反馈。操作、认证弹窗和远程账号窗口打开时暂停主菜单的外部关闭。
- Git：自定义身份新建、可选立即启用、编辑、确认删除；明确选择 Local 或 Global；按工作区统一生效，影响实际单仓库/批量提交作者，同时保留旧仓库选择兼容读取。不会改写 `.git/config` 或全局 Git 配置。
- 无 Git 仓库的工作区仍可读取全局身份并管理自定义身份；内置身份不能删除，Local/Global 是保留名称。
- SVN：当前账号与凭据来源、复制仓库 URL、切换账号、重新认证、忘记会话、确认清除匹配缓存、测试远程连接；密码遮罩，支持仅本次会话或保存到 SVN 原生缓存。
- 远程账号：GitHub、GitLab、Gitee 连接状态及当前/关联项目标记，按关联程度排序；点击进入对应平台的已有账号管理或连接表单；直接清除真实头像缓存。
- 去掉旧身份菜单的重复加载、仅能跳转管理窗口的占位操作及无引用的身份卡片样式。分支菜单改用同一个公共菜单组件。

## 底层行为

`git-profiles.json` 新增工作区选择。旧 `selectedByRepository` 继续读取；当前工作区明确选择后优先使用新值，清除/删除活动身份后回退到 Git 配置。共享配置文件串行写入，防止多仓库同时修改丢失数据。

新增 SVN `switch` 操作和 `repositoryUrl` 状态字段。切换先访问仓库 URL 验证认证，成功后替换账号；失败保留原会话。密码通过 stdin 交给 SVN，会话模式不持久化用户名/密码。原生缓存匹配检查主机和端口，清除前重新读取缓存并验证选中的凭据仍存在。

身份与远程账号更新立即刷新状态栏；被动远程读取不会触发再次读取。跨工作区或卸载后的弹窗结果不再发送后续写操作。

## 验证结果

- 完整前端检查通过：55 个测试文件、543 个测试；类型检查、lint、国际化检查、生成绑定核对、生产构建通过。
- Rust 格式、clippy 和 122 个测试通过。真实 Git 提交验证作者/提交者为所选工作区身份；验证跨仓库生效、另一工作区隔离、删除回退、旧配置读取、并发写入及配置文件保持原身份。
- 真实临时 svnserve 测试验证错误密码被拒绝、失败切换保留旧会话、成功认证后测试远程连接、忘记会话后不再复用账号，以及工作副本修改保持不变。
- 同时打开独立 Extension Development Host 和原生 Tauri App，比对身份主菜单；App 实际完成新建/启用/编辑/删除身份、跨仓库查看同一工作区身份、Local/Global 选择、悬停信息和 GitLab 管理入口。
- 原生 App 实际连接临时 svnserve：仅本次会话认证、测试连接、忘记会话、保存至系统 SVN 缓存、确认清除缓存；CLI 验证测试认证域已移除，临时 `keep.txt` 修改仍在。
- 最后的样式清理仅删除无引用规则，另行生产构建通过。QA 完成后关闭自建进程，恢复独立 QA 配置，恢复标准原生构建；没有自动提交。

## 验证边界

没有使用真实 GitHub/GitLab/Gitee 令牌执行外部登录。对应入口、平台定位与既有账号管理组件的交互测试通过；不将 MockBridge 测试视为外部 OAuth/PAT 认证验收。不同操作系统的 SVN 原生凭据后端未在本次 macOS 环境逐一验证。

## 截图

- [插件身份主菜单](plugin-root.png)
- [App 身份主菜单](app-root.png)
- [灰色键盘选择](app-gray-selection.png)
- [Global 动作菜单](app-global-actions.png)
- [自定义身份动作](app-profile-actions.png)
- [仓库选择](app-repository-picker.png)
- [另一仓库的工作区身份](app-workspace-profile.png)
- [身份悬停名片](app-tooltip.png)
- [对应平台的管理入口](app-provider.png)
- [SVN 菜单](app-svn-menu.png)
- [密码遮罩](app-svn-password.png)
- [会话与原生缓存选择](app-svn-save-choice.png)
- [原生远程认证成功](app-svn-authenticated.png)
- [清除缓存确认](app-svn-clear-confirm.png)
- [缓存清除结果](app-svn-cache-cleared.png)
- [删除身份确认](app-delete-confirm.png)
