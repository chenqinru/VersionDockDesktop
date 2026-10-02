# 外观主题和文件图标主题检查（2026-10-02）

结论：正常单次点击可以即时改变外观和图标并写入配置；值得优化，优先修复保存和主题生效一致性，再改善预览和键盘操作。本轮只检查，不修改产品实现。

## 检查步骤

| 步骤 | 操作与健康度 | 当前证据 |
| --- | --- | --- |
| 1 | 打开设置／外观：正常，但主题区域较高，图标选择在首屏以下 | [深色设置](01-settings-dark.png) |
| 2 | 切换 2026 浅色：当前窗口即时变化且配置已保存；部分其他组件的主题判断有错误 | [浅色设置](02-settings-light.png) |
| 3 | 搜索图标设置：正常展示四种选择，预览使用真实 FileIcon；样例小且没有文件名说明 | [图标预览](03-icons-light.png) |
| 4 | 选择 Codicon，关闭设置查看详情树：保存、生效正常，实际彩色与“经典单色”名称不符 | [选中 Codicon](04-codicon-light.png)、[工作区图标](05-workspace-codicon.png) |
| 5 | 聚焦 Catppuccin 卡片后发送右方向键：不切换选项；目前需要 Tab 加 Enter／Space | [键盘操作](08-icons-keyboard.png)、[AX 选中状态](08-icons-keyboard.ax) |

## 问题与优先级

### P1 设置保存存在竞争

`src/store/appStore.ts:1569` 更新时提交整个 settings 快照，成功后无条件覆盖当前设置，失败则回退整个旧快照。点击主题后立即点击图标，旧主题响应晚到会把新图标选择覆盖；旧请求失败也会撤销后续成功选择。

受控异步调用真实 Store 已复现两种情况，见 [测试源](settings-race.test.ts.txt) 和 [结果](settings-race.log)。这证明当前 Store 没有顺序保护，未声称已在原生磁盘慢写环境制造了乱序。Rust 更新接收整个 settings，不能仅靠前端忽略旧响应保证持久化正确。

建议：统一设置保存协调器，合并连续 patch、串行写入，UI 保持即时预览；失败仅回退相应失败版本，保护后续选择。多窗口并发如纳入支持，还需后端按 patch／版本合并，不能只加入前端请求序号。

### P1 主题生效判断不一致

- `src/components/branchColor.ts:35` 只认 `light`，把 `light2026` 当深色；分支、HEAD、tag 及配色调节因此采用深色规则。[分类复现测试](theme-classification.test.ts.txt) 确认 `isLightTheme('light2026')` 为 true，但分支 helper 返回深色。
- `src/components/TitleBar.tsx:488` 拖拽标签预览同样只认 `light`。
- `src/components/ThreeWayLayout.tsx:76` 主题获取始终返回 null；其 `getShikiTheme` 检查 `body.vscode-light`，而桌面 App 在 html 上设置 `data-theme`。因此冲突编辑器不接入当前主题解析，回退 github-dark；也没有与普通 Diff 一致的主题订阅。

建议：复用现有 `isLightTheme`、`resolveShikiTheme` 和一个响应式有效主题来源，移除 Desktop 中失效的 VS Code 主题桥接与重复判断。后两项为代码路径确认，本轮没有单独原生验收拖拽预览和冲突页。

### P2 图标风格、命名与浅色适配

[步骤 4](04-codicon-light.png) 的 Codicon 文件图标明显仍为蓝、橙、红色：FileIcon 为其设置 tone 类，CSS 决定颜色，与“经典单色”描述矛盾。应明确产品目标：保留当前颜色并更名为“经典线性”，或真正采用主题前景色。

所有 SVG resolver 都未接收明暗模式，Catppuccin 固定使用 Mocha 配色。浅色背景下部分浅黄、浅粉和浅蓝辨识度较低。按现有 CSS 色值计算：Codicon JavaScript 黄 `#e8d44d` 对 `#FAFAFD` 为 1.44:1，Rust 为 2.05:1；Catppuccin 黄 `#f9e2af` 为 1.22:1。这是色值对比分析，未据此宣称所有装饰图标都必须满足同一 WCAG 阈值。

建议：图标 resolver 支持浅／深模式，保持同一图形，仅调整必要的颜色；浅色 Catppuccin 可使用相应 Latte 配色。选中行仍使用项目统一灰色反馈，文件和 VCS 语义色不应被全局去色。

### P2 预览与实际主题重复维护

`src/styles.css` 的 `theme-preview-*` 与根主题、Shiki 颜色各自维护。已确认经典深色预览主区为 `#1e1e1e`、侧栏为 `#252526`，实际根主题为 `#181818`／`#1f1f1f`。预览侧栏 active 色使用 accent，真实项目当前使用中性灰色选中，含义也不完全一致。

建议：主题清单、标识、明暗属性、UI token 与预览读取统一定义；代码预览复用真实高亮主题，避免再维护一组手写颜色。保留现有 9 个主题即可，无须先增加数量。

### P2 键盘和辅助技术重复入口

ThemePreviewSelector、FileIconThemePreviewSelector 为 radio 卡片，没有方向键处理和 roving tabIndex；同时 1px 裁剪的原生 select 保留焦点和辅助技术入口。AX 实际同时出现原生 PopUpButton 与同名 radio 卡片，属于重复控件。步骤 5 发送右方向键后仍选中 Catppuccin。

建议：仅保留一套可访问选择控件，原生 radio 或完整 radiogroup；实现方向键、Home／End、一个 Tab 入口和明确焦点提示。现有全局 focus-visible 可见，但颜色使用 accent；如统一中性反馈，应单独配置焦点 token，而不是删除焦点提示。

### P3 布局和样例易读性

步骤 1、2 的主题区占据三行，语言、字号之后图标区需滚动；可将主题与图标作为相邻的独立设置区，简化文案并按窗口宽度适配。步骤 3 的每组预览只有五个小图标、缺少文件名且全部文件为关闭目录／几种语言文件；建议加入打开目录、普通文件、图片、配置文件，配简短文件名，方便用户判断差异。窄窗口和最大字号未原生验收，不把固定网格直接等同于已复现溢出。

## 建议实施顺序

1. 修复设置保存顺序、失败回退及全局主题判断，统一冲突页高亮。
2. 修正图标命名与浅色配色，合并主题／预览定义。
3. 完善键盘选择，压缩布局并增大图标预览。

## 证据和边界

- 独立原生 QA App 完成设置入口、2026 深／浅即时变化、Material／Codicon／Catppuccin 点击与配置、文件树生效和键盘检查。
- 设置竞争测试 2 个通过；设置／图标／主题回归与分类诊断 5 个文件、18 个测试通过，见 [定向日志](targeted-tests.log)。诊断测试以复现现有缺陷为断言，不代表缺陷已修复。
- 未逐一原生覆盖全部 9 个主题与全部 4 个图标主题、系统实际明暗变更、多窗口同步、冲突页、拖拽预览、完整屏幕阅读器及 Windows／Linux。
- 产品源码未修改；临时诊断测试已移出 src，归档为文本。QA App 与 Vite 已停止，QA 配置已恢复，见 [清理记录](cleanup.json)。
