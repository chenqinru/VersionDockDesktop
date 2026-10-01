# Design QA — Sync / Submodule parity

## Comparison target

- Source visual truth:
  - `design-qa-source-sync-final.png` (Sync selected repository and expanded commit tree; copied from the user's latest attachment)
  - `design-qa-source-sync-header-final.png` (Sync repository-header detail; copied from the user's latest attachment)
  - `design-qa-source-submodule-final.png` (Submodule empty state; copied from the user's attachment)
- Browser-rendered implementation:
  - `design-qa-sync-panel-final.png`
  - `design-qa-submodule-panel-final.png`
- URL: `http://127.0.0.1:4173/`, Codex in-app browser.
- Theme/state: dark theme; multi-repository browser demo; 382 CSS-pixel commit panel; Sync API repository selected with one commit expanded; Submodule first repository header hovered.

## Viewport and normalization

- Browser viewport: 1280 × 900 CSS pixels; commit panel width: 382 CSS pixels.
- Sync source: 764 × 1656 physical pixels at 2× density, normalized to 382 × 828 CSS pixels.
- Sync implementation: 382 × 828 pixels at 1× normalized density.
- Submodule source: 764 × 1654 physical pixels at 2× density, normalized to 382 × 827 CSS pixels.
- Submodule implementation: 382 × 827 pixels at 1× normalized density.
- Source and implementation were opened together in the same comparison input. Repository names, commit counts, and file contents differ because the Desktop browser fixture is not the source repository; those data-only differences are not visual defects.

## Comparison history

### Iteration 1 — blocked (the earlier report incorrectly said passed)

- P1: Sync was only a simplified repository list and omitted source behavior including selection commands, per-commit file trees, batch commit actions, split primary actions, and repository context actions.
- P1: Submodule and Sync used container/card treatments that did not match the source repository header and list rhythm.
- P2: The Sync badge counted outgoing commits only.

Fixes:

- Restored the complete source interaction model: incoming/outgoing mixed timeline, aggregate changes, commit detail trees, multi-selection, contextual actions, repository selection pills, pull strategies, safe force push, tags, and dynamic Fetch/Update/Push/Sync actions.
- Added representative browser-demo data so incoming, outgoing, detail, and action states could be exercised.

### Iteration 2 — blocked

- P2: The first visual pass introduced a comfortable/compact layout setting while some Desktop surfaces still used the existing dense layout, producing mixed geometry.
- P2: Repository bodies were wrapped in rounded cards instead of keeping the body flat and applying the repository color to the full-width title row.
- P2: The Sync repository header lacked the source hover Fetch shortcut, and a single-repository workspace still required an explicit checkbox selection.

Fixes:

- Removed the layout-density contract, generated type, Store action, settings UI, and root data attribute.
- Standardized Changes, Sync, Submodule, and Subtree repository headers on one full-width 26px row with the same padding, color treatment, branch badge, typography, and divider.
- Added the Fetch hover shortcut and single-repository implicit selection/action behavior.
- Matched source commit typography, direction-pill geometry, empty-state height, footer spacing, selection pill, and Submodule row/header rhythm.

### Iteration 3 — passed

- Full-view comparison: tab hierarchy, full-width repository bands, flat commit list, direction counts, selected-repository footer, split action, Submodule empty state, and panel density now match the source structure.
- Focused comparison: repository checkbox/disclosure/color dot/name/branch order and spacing match the source header detail; hover-only Fetch/diff/add controls are present and usable.
- Required fidelity surfaces:
  - Fonts and typography: repository 11px bold uppercase with 0.05em tracking; commit message 12px/500/16px; metadata and hash 10px/14px.
  - Spacing and layout: one 26px edge-to-edge repository row; 44px commit rows; no mixed card gutters or alternate density.
  - Colors and tokens: repository tint derives from `--repo-color`; incoming/outgoing and status colors use the existing semantic tokens.
  - Image and icon fidelity: existing Codicon/FileIcon assets are used; no placeholder or CSS-drawn image assets were introduced.
  - Copy/content: visible actions and empty states use the existing localized source semantics.
- No actionable P0/P1/P2 visual mismatch remains. Data-volume differences are fixture constraints, not implementation drift.

## Primary interactions tested

- Sync badge includes incoming plus outgoing counts.
- Select all, clear, and invert repository selection.
- Repository expand/collapse and independent incoming/outgoing filters.
- Commit expand/collapse, body, full file tree, and tree/flat view switching.
- Fetch/Update/Push/Sync main action changes, repository pills, and split-menu placement inside the commit panel.
- Header hover Fetch/aggregated changes shortcuts and Submodule hover Add action.
- Sync branch badge opens the current repository branch/tag menu without collapsing the repository group.
- Browser console checked: no warnings or errors from the implementation.

## Follow-up polish

- None required for the selected visual target.

### Iteration 4 — reopened from the user's new Sync screenshots

- New reference states: `codex-clipboard-ff00907d-8e8e-41e3-8f17-33a73ab65467.png` (unselected/expanded files), `codex-clipboard-f96f52a7-17e2-431e-b4cb-bcbb02042c4a.png` (selected repository/footer), and `codex-clipboard-f3c940ed-3b26-4f7e-94a0-0db57f4e5315.png` (hover/full-message tooltip), under `/var/folders/bq/cspkcw_164z5kwlznr65bnxm0000gn/T/`.
- Source captures are 764 × 1584, 758 × 1566, and 1068 × 1584 physical pixels. At approximately 2× density, the first two show a 379–382 CSS-pixel sidebar. The Desktop browser demo was inspected at 1200 × 800 CSS pixels with its commit panel set to 381 CSS pixels, then the temporary viewport and panel width were restored.
- The earlier `passed` conclusion was too broad for these newly supplied states. The new reference exposed a P1 mismatch: Sync's incoming blue variable was undefined, so incoming arrows and pills rendered gray. This is now set to the source's blue chart color; active pills use a full-color border and inactive pills a transparent border.
- Another P1 mismatch was the inline commit body above expanded files, which the source does not show. The Desktop tree now begins directly below the selected commit row. The complete message remains in the title tooltip, matching the source's hover behavior.
- The existing commit-row structure, folder/tree indentation, selected-repository pill, split Update action, and header control positions were inspected against the new screenshots. Demo repository names, counts, avatars, and file icon theme differ from the user's live repositories and were not judged as layout defects.
- Frontend typecheck, lint, i18n scan, 245 tests, bindings check, production build, and `git diff --check` passed after these changes. In-browser repository selection, commit expansion, aggregate/commit view switching, and footer action rendering were exercised.
- The final image-to-image QA remains open: the browser security policy prevented loading the user's local reference image into the browser comparison surface, and the latest Desktop browser capture is available only inline in the tool output, not as a persisted screenshot file. No bypass was attempted. The actual native Desktop window with the user's repository data was not captured.

### Iteration 5 — incoming/outgoing aggregate and single-repository references

- New source references: `codex-clipboard-673c2006-3ec5-4788-a9b0-7e6d17454fd6.png` (incoming aggregate), `codex-clipboard-24ae0697-7699-4dc2-8645-8891bcde039c.png` (single-repository outgoing commit), and `codex-clipboard-9f8a924f-df2c-4da4-a6fd-3567bf12de7b.png` (outgoing aggregate), under the same user-attachment directory. They are 758 × 1564, 764 × 1584, and 764 × 1586 physical pixels respectively, approximately 2× density.
- P1 found: the default `all` aggregate view hid its section header when the other direction had no commits. The source screenshots retain “待更新更改 (N)” or “待推送更改 (N)” in that case. The Sync panel now renders the matching heading in `all` mode, omits the count while files load, and uses the source's exact Chinese wording. The in-app browser demo visibly showed both heading states after the fix.
- The file tree's directory-chain collapsing algorithm already matches the source `PushTab` implementation; differences in visible directory nesting depend on the files in each repository. The single-repository path already omits the checkbox and uses the green Push primary action when there are outgoing commits. This path was confirmed in code but not reproduced in the multi-repository browser fixture.
- The latest native Desktop window with the user's repositories and these exact three interaction states has not been captured. The browser demo's different data and the blocked same-input screenshot comparison still prevent a final pixel-level pass.

final result: blocked

---

# 分支面板视觉 QA

## 基准与捕获

用户两张附件是 App 原有状态；视觉目标采用实际 VS Code Extension Development Host 的紧凑分支面板。原始插件截图：`docs/manual/branch-sidebar-2026-10-01/plugin-final.png`；App 原始截图：`docs/manual/branch-sidebar-2026-10-01/native-final.png`。

两端 viewport 均为 1440×900 CSS px，原始 PNG 均为 1440×900，捕获 DPR=1。分支面板宽度均为 220 CSS px。插件裁剪 `(353,107,220,370)`，App 裁剪 `(405,75,220,370)`，以搜索栏顶端对齐；并排图片等比例放大 2 倍，未重绘或修改原始 UI。菜单分别裁剪 215×230、180×230；宽度按各自语言文本自适应。

状态：同一个临时工作区，两 Git 仓库 main、SVN trunk，本地 4 个聚合分支、origin 2 个聚合分支、混合 VCS 同名标签 2 行，展开全部分组。主题的背景、前景、仓库颜色、accent、badge 与 VCS 颜色在独立 VS Code 验收配置中归一到 App 现有 dark2026 token。

完整截图检查整体比例、分组和滚动区域。聚焦证据：`sidebar-comparison.png`、`menu-comparison.png`。内置浏览器连接因工具可信路径错误不可用；本次没有采用浏览器演示，而是捕获实际 App 和实际插件宿主。

## 五项检查

- 字体：仓库 10px/700，分组 11px/700，分支 12px，主要分支 500/HEAD 600，徽章 9px、计数 10px；同一行保持单行截断，无徽章挤压换行。
- 间距：搜索栏 35px，仓库 20px，分组/分支 22px；内边距、7px 圆点和徽章顺序与当前插件源码对照；长分支截断，右侧元数据保留。
- 色彩：既有 App 主题决定宿主色彩；HEAD 边线、绿色 detached tag、VCS Git/SVN 色、选中/筛选/右键状态分别呈现。主题带来的菜单边框/分隔线明暗差异保留，未硬编码 VS Code 的全局默认菜单色。
- 资产：全为 UI 文本和原有 Codicons，无照片/插图资产，没有新增位图或重绘截图内容。
- 文案：菜单项目/顺序对齐插件语义。插件宿主为英文、App 为中文；该运行时语言差异明确保留，并通过英中文案资源核对，而非把两种语言声称为相同像素。

## 比较历史

1. 原生 `native-local.png` 与插件 `plugin-maximized.png`：发现分组标题 25px 对 22px、菜单 padding 每项多 1px，累计改变行位置，记为 P2。
2. 修复分组高度、字号、行内 padding、右键状态和菜单紧凑变体；最终原始截图及两张并排图验证分组节奏/菜单高度。没有剩余 P0/P1/P2。
3. 复核实际操作：共享仓库检出、部分/全部 HEAD、两仓库标签检出、当前标签无删除入口、仓库选择、双方独有提交比较、真实工作区文件内容 diff、SVN Switch。自动化回归另覆盖取消、远程 ref 范围、异步标签折叠与键盘激活。

## 可接受差异与 P3

- 中文与英文的字体形态、文案长度及菜单宽度来自语言选择。
- 完全同名的 Git/SVN 标签 tie 顺序：插件由异步响应插入顺序决定，App 按工作区仓库顺序稳定呈现，保持两个独立 VCS 操作目标。
- WebKit/Chromium 字形抗锯齿和现有宿主主题分隔线亮度有轻微差异，未影响密度或核心可用性。
- 未验证跨平台像素、真实账号/网络远端操作；不把此次视觉验收扩展为这些能力的手动验收。

## 实施检查

源项目未修改；无 AI 或舒适布局新增。完整结果、测试及运行时限制参见 `docs/branch-sidebar-parity-2026-10-01.md`。

final result: passed


## 颜色反馈后续修正

用户明确要求列表选中背景及加载提示为灰色，覆盖此前蓝色宿主 selection token。已统一主题变量与兼容别名；当前原生 App 选中效果见 `docs/manual/branch-sidebar-2026-10-01/native-neutral-selection.png`。

8 主题 WebKit 计算样式验证见 `neutral-theme-colors.json`；这是实际 CSS 的独立渲染核验，没有把模拟 loading 状态当作 App 后端运行证明。原生瞬态加载截图未捕获。

final result: passed
