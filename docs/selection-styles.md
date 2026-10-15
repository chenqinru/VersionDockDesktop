# 列表项选中态

账号列表、设置导航、下拉选项、卡片式单选、弹窗选项和工具栏菜单共享 `src/selection.css` 的 `.vd-selectable`。它只提供视觉反馈，不创建新的列表组件，也不处理数据、导航或选择事件。

```tsx
<button className="vd-selectable account-row" aria-pressed={selected} disabled={busy} onClick={chooseAccount}>
  {accountName}
</button>
<a className="vd-selectable settings-nav-item" aria-current={active ? 'location' : undefined} href={target}>
  {label}
</a>
<button role="option" className="vd-selectable" aria-selected={selected} disabled={disabled}>
  {label}
</button>
```

## 状态与语义

- 当前账号、仓库等操作按钮使用 `aria-pressed`，导航使用 `aria-current="page" | "location" | "true"`，选项使用 `aria-selected`，卡片式单选使用 `role="radio"` 和 `aria-checked`。依据元素真实语义选择属性，不为触发颜色随意增加 ARIA。
- 普通悬停、选中、选中后悬停、键盘焦点分别定义；鼠标离开后选中标识保留，悬停不能覆盖选中状态。
- `:focus-visible` 使用控件主题焦点变量，聚焦不自动选择；失焦后选中状态继续保留。
- `disabled` 和继承的 `fieldset disabled` 使用原生禁用行为。`aria-disabled` 只提供语义与视觉，调用方必须阻止点击、键盘操作并根据场景设置 `tabIndex`。
- 禁用项不显示悬停反馈，但仍能辨认原选中项。

## 主题与布局

`--versiondock-item-selected-background`、`--versiondock-item-selected-hover-background`、`--versiondock-item-selected-border` 根据主题强调色与表面色混合；文字使用 `--versiondock-item-selected-foreground`，普通悬停使用 `--versiondock-item-hover-background`。主题预览在自身作用域解析这些变量。

页面只指定尺寸、排列、间距、圆角和必要的默认外观；可通过 `--selectable-background`、`--selectable-border`、`--selectable-foreground` 设置未选中状态的表面和文字角色。公共样式保留 1px 边框占位，状态切换不改变尺寸。

不要叠加 `.selected` / `.active` 的背景和边框规则。这些类可以保留给既有逻辑和字重使用，视觉状态由语义属性驱动。

主题及文件图标卡片继续由 `RadioCards` 处理单选、方向键和 Tab 停靠，外观复用公共状态，内部主题预览保留各自配色。

标签页、树节点、提交图和带业务含义的状态胶囊继续使用专用交互；不将不同结构强制包装成通用列表组件。其中文件树与分支树的行反馈通过下述行样式复用，展开和选中仍是不同状态。

## 工作台列表行

提交历史、同步提交、分支侧栏、工作区更改、更改列表、提交详情、提交更改、分支工作区对比、文件历史、冲突文件和子模块定位行使用 `.vd-row`。最近工作区、历史筛选及外部编辑器选项也采用该规则。公共样式不增加边框、内边距或改变行高，各页面保留原有布局与文件状态色。

- 使用 `data-row-selected` 表示当前行，`data-row-context` 表示右键目标；保留原有类名供业务逻辑使用，禁止另设背景规则。
- 带附属操作按钮的复合行由包住所有按钮的外层承担 `.vd-row` 背景与行状态，主按钮保持透明，避免悬停背景在按钮之间断开。
- 列表容器添加 `.vd-row-scope`。焦点在列表内时，选中行使用公共选中色，悬停后加深；焦点移到其他区域或弹出菜单时，减弱为仍随主题变化的选中背景。键盘焦点另有主题色轮廓，聚焦本身不改变选中数据。
- `div` 实现的可操作行在点击时接收焦点；复合文件行通过内部按钮接收焦点。不得由样式反向触发业务选择。
- 同步卡片与子模块只给标题行添加 `.vd-row`，展开内容保持独立表面。`HEAD`、分支筛选轮廓、仓库颜色、复选框及增删改语义保留原有意义；合并父项展开不冒充行选中。
- 搜索定位行复用主题色轮廓及淡背景，文字匹配标记保留搜索语义。禁用项不响应悬停。

标题栏当前项目标签的底部指示条使用 `--versiondock-accent`，与设置修改标记等强调指示保持一致；所有主题（包括 2026 深浅主题）都跟随主题强调色。标签页保留原有布局、背景及切换和拖拽行为。

弹窗多选按钮使用 `aria-pressed`，保留多选及确认逻辑。工具栏菜单项额外使用 `.vd-menu-item`，复用公共菜单配色；有子菜单的父项通过 `aria-haspopup="menu"` 和 `aria-expanded` 表示展开，展开不等于持久选中。菜单宽度按文案和内边距计算，不从公共反馈样式继承固定宽度。

右键菜单统一由 `ContextMenu` 接入 `.vd-menu-item`；鼠标悬停和键盘聚焦使用 `--versiondock-menu-hover-background`，按下使用 `--versiondock-menu-pressed-background`。背景按主题强调色与菜单表面色混合，采用比普通列表选中态更明显的反馈，不再绑定图标按钮的灰色。

菜单背景与文字成对定义：普通文字使用 `--versiondock-menu-foreground`，`data-danger` 和 `data-accent` 分别使用菜单专用的错误色、强调色。危险项在深色主题优先使用原错误红；对比不足的主题在调色板内提供保持红色饱和度的菜单专用色，不以混白方式提亮。浅色主题适当加深文字；不修改全局强调色、错误色或列表选中色。普通、强调、危险文字在默认、悬停、聚焦及按下背景上均以至少 4.5:1 对比度为验收目标。状态栏菜单同步复用菜单背景、普通文字、错误色和警告色。

禁用项继续降低透明度，不显示悬停和按下反馈。勾号等业务标识及菜单定位、尺寸、方向键导航保持原有逻辑。

危险项（右键菜单的 `data-danger`、状态栏菜单的 `.danger`）统一使用 `--versiondock-menu-danger-hover-background` / `--versiondock-menu-danger-pressed-background`。背景由主题错误色与菜单表面色混合；深色主题降低红色背景的亮度，浅色主题保持淡红底，红色文字和焦点框配套使用菜单错误色；普通项仍使用主题强调色背景。危险项在各交互状态保留相同的文字色，禁用时无高亮。
