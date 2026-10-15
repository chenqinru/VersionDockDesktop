# 输入控件约定

普通单行输入使用 `Input`，普通多行输入使用 `Textarea`，搜索入口使用 `SearchInput`，标签、说明和错误使用 `FormField`。公共样式由 `src/inputs.css` 管理，在 `src/main.tsx` 加载；页面仅管理布局和必要的内容展示（例如忽略规则使用等宽字体）。

```tsx
<FormField label={t('Username')} description={hint} error={error} required>
  <Input value={username} onChange={event => setUsername(event.target.value)} />
</FormField>

<FormField id="description" label={t('Description')}>
  <Textarea id="description" rows={4} value={description} onChange={event => setDescription(event.target.value)} />
</FormField>

<SearchInput
  aria-label={t('Search commits…')}
  value={query}
  onChange={event => setQuery(event.target.value)}
  onClear={() => setQuery('')}
/>
```

## 公共状态与尺寸

- `controlSize="xs" | "sm" | "md"` 控制外观，默认 `sm`，高度分别为 24、28、36px，随应用字号缩放。原生 `size` 仍保留其原有含义。
- 悬停和聚焦使用控件主题变量 `--versiondock-control-hover-border` / `--versiondock-control-focus-border`：2026 深浅主题保持中性焦点，其余主题跟随各自强调色；错误状态保持主题错误色。
- `invalid` 或 `aria-invalid` 控制错误外观；`readOnly`、`disabled` 使用原生行为，保留 `fieldset` 的禁用继承。
- `Input`、`Textarea` 和 `SearchInput` 透传原生属性、事件和 ref，不管理业务值。多行输入保留原生 `rows`，公共最小高度为 72px；页面可按内容用途调整高度。
- `FormField` 为一个输入控件生成稳定 id，关联标签、说明和错误，合并控件已有的 `aria-describedby`。需要显式 id 时，将同一个 id 传给字段和控件；一个字段只放一个主要输入控件，选择目录等附属按钮可以放在其中。
- `FormField` 的 `required` 同步原生必填状态；`error` 自动关联错误文案、错误外观和 `role="alert"`。控件显式设置的 `required` / `aria-invalid` 优先。
- `SearchInput` 复用输入和图标按钮。受控 `value` 非空并提供 `onClear` 时显示清空按钮；只读隐藏清空，禁用阻止操作。清空只调用业务回调，不伪造 `onChange`，并恢复输入焦点。
- `containerClassName` 管理搜索框布局，`className` 作用于内部输入；`showIcon` 控制搜索图标，`trailing` 可展示匹配数量。

## 业务边界

保存时机、校验、防抖、中文输入法处理、Enter / Escape 操作和异步请求继续留在业务组件中。公共组件不增加自动保存或提交逻辑。

设置项继续使用 `SettingText` 和现有设置元数据布局，内部输入复用 `Input`。密码显隐使用 `vd-input-with-action` 容器配合已有 `IconButton`，避免文字与按钮重叠。

提交信息框、AI 提示编辑器、代码及合并编辑器保留专用交互；数字步进、复选框、单选框、颜色选择和隐藏兼容控件使用原有组件。全局及弹窗输入规则排除公共输入，页面不再另设背景、边框、悬停和焦点状态。
