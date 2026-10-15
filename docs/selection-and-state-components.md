# 选择控件与状态提示

公共控件样式在 `src/controls.css`，状态提示样式在 `src/states.css`，入口统一加载。页面仅处理位置、可用宽度和业务文案，不另设聚焦、悬停或禁用颜色。

## Select

```tsx
<FormField label={t('Visibility')} error={error}>
  <Select
    value={visibility}
    options={[
      { value: 'private', label: t('Private') },
      { value: 'public', label: t('Public') },
    ]}
    onChange={setVisibility}
  />
</FormField>
```

- `value` 和 `onChange(value)` 由调用处管理；组件不自动保存、不推断业务默认值。找不到当前值时展示原值，空选项或所有选项不可选时禁用。
- `options` 的每项为 `{ value, label, disabled? }`，`value` 需唯一。文案在调用处翻译；动态仓库、账号和用户内容原样展示。
- `controlSize="xs" | "sm" | "md"` 与输入框保持 24 / 28 / 36px 尺寸并跟随字号；默认 `sm`。`containerClassName` 管理外层布局，`className` 作用于触发控件。
- `ref` 指向触发按钮。只有一个可访问的 `combobox`，标签可通过 `FormField` 或 `id` / `htmlFor` 关联；可用 `aria-label` 单独命名。
- 方向键、Home / End、英文前缀查找导航选项；Enter / Space 确认，Escape 关闭并回到触发控件，Tab 继续前往下一控件。禁用选项不参与键盘导航。
- 菜单在可用空间不足时向上展开，并限制在窗口及滚动面板内；滚动和窗口调整时重算位置。点击外部关闭且不抢回焦点，滚动条交互按现有滚动条归属规则判断。
- 保留原生按钮对 `disabled` 和 `fieldset disabled` 的支持；操作期间字段集禁用会关闭列表。错误通过 `invalid` / `aria-invalid` / `FormField.error` 设置，正常聚焦与悬停使用控件主题变量，与输入框保持一致。
- 可传 `name` 输出隐藏表单值；业务校验由调用处执行，`required` 用于可访问的必填提示。

设置项仍使用 `SettingSelect` 保留元数据和恢复默认值入口，内部复用 `Select`。输出面板仍使用 `OutputDropdown` 保留枚举类型与翻译边界。

## Checkbox 与 Switch

```tsx
<label><Checkbox checked={included} onChange={event => setIncluded(event.target.checked)} />{t('Include')}</label>
<Switch aria-label={t('Fetch on startup')} checked={enabled} onChange={event => setEnabled(event.target.checked)} />
```

- 二者完整透传原生 checkbox 的值、事件、ref、标签关联、表单行为和字段集禁用，保留 checkbox 可访问语义。
- 选中背景与标记使用 `--versiondock-control-checked-background` / `--versiondock-control-checked-foreground`，跟随主题强调色；列表选中色独立管理。
- `Checkbox.indeterminate` 同步原生半选状态；受控和非受控输入均可用。`Switch.controlSize="sm" | "md"` 对应紧凑和普通尺寸。
- `containerClassName` 用于外层布局，原生属性和 `className` 作用于内部 input。
- 文件及仓库行继续使用 `SelectionCheckbox`，由它保留点击隔离；普通复选框不默认阻止冒泡。
- `SettingToggle` 保留设置标签、说明和恢复默认值，内部使用 `Switch`。
- 不额外引入业务状态；不能用禁用替代后端写锁或权限检查。

## EmptyState、LoadingState 与 ErrorNotice

```tsx
<EmptyState icon="history" description={t('Try another branch')}>{t('No history')}</EmptyState>
<LoadingState>{t('Loading files...')}</LoadingState>
<ErrorNotice onRetry={() => void reload()} retrying={loading}>{error}</ErrorNotice>
```

- `EmptyState` 支持可选图标、说明和 `actions`；`compact` 用于列表内提示。它表示空结果，不代表错误或加载。
- `LoadingState` 默认紧凑，`compact={false}` 用于面板占位，提供 `role="status"` 和状态播报；文案可由业务指定，尊重系统减少动态效果偏好。
- `ErrorNotice` 提供 `role="alert"`、错误详情和可选重试。`retrying` 禁止重复操作；组件不发请求、不吞错误、不自动重试。
- 状态栏等需要菜单键盘导航的重试入口保留专用菜单项，可作为内容或 `actions` 传入。
- 欢迎页引导、提交编辑器、复杂差异占位和更新胶囊保留专用布局与交互，不为了共用外观合并业务状态。
