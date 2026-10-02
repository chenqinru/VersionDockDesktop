# 图标操作按钮统一反馈（2026-10-01）

用户截图中的日志行「打开提交详情」「打开更改」缺少可辨识的灰色 hover。原先按钮与整行使用相同的 hover 背景，鼠标移入按钮后视觉上没有变化；各组件还存在独立 CSS 和 inline background。

新增 `src/components/IconButton.tsx`，统一灰色 hover、按下、选中、键盘焦点与禁用反馈。使用对比行背景更明显的中性 hover token，并覆盖旧调用处的 inline background；调用者的尺寸、className、style、点击、ref、原生 disabled 行为继续传递。默认 `type="button"` 避免图标动作误提交外层表单，title 作为默认可访问名称。

已迁移 39 个组件文件中的 162 处图标操作按钮，涵盖日志、变更详情、提交面板、同步、搁置/暂存、子模块/工作树、设置/远端、通知、输出、搜索和工作区标签。补齐原先缺失的 tooltip；同步视图按钮补上 aria-pressed。文本按钮和树/文件行继续使用原布局，OS 窗口最小化/最大化/关闭保留平台行为。

`eslint.config.js` 接入 `scripts/eslint-icon-buttons.mjs`：新增纯图标操作按钮必须使用共享组件。实际 lintText 验证中，裸 button + Codicon 被拒绝，IconButton 被接受；完整项目 lint 通过。

验收：

- 原生 macOS App 实际悬停两个日志行按钮，分别显示可辨识灰色背景，见 `docs/manual/icon-button-2026-10-01/log-detail-hover.png` 和 `log-changes-hover.png`。
- 原生实际点击后分别进入完整提交详情与全部变更页面，结果截图在同目录。
- `npm run check:frontend` 全部通过：525 个测试、51 个测试文件，类型/lint/i18n/bindings/生产构建通过。新增 native button contract 测试验证 ref、默认不提交表单、disabled、aria-label 和 aria-pressed。
- `git diff --check` 通过。后端未变更，本轮不把旧 Rust 验收当作新增检查。

源插件未修改，App 改动未提交；原生视觉验收为 macOS 上的明确场景，不宣称全部 162 处已逐项截图或 Windows/Linux 已原生验收。
