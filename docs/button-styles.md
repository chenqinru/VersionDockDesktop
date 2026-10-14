# 按钮样式

普通操作按钮统一使用 `src/components/Button.tsx`，外观由 `src/buttons.css` 管理，入口 `src/main.tsx` 加载一次。页面样式只处理位置、宽度、排列和响应式布局，不再各自定义主次颜色、悬停颜色或禁用透明度。

```tsx
<Button variant="primary" onClick={save}>保存</Button>
<Button onClick={cancel}>取消</Button>
<Button danger onClick={remove}>删除</Button>
<Button variant="primary" danger onClick={confirmRemove}>确认删除</Button>
<Button variant="ghost" size="xs" onClick={refresh}>刷新</Button>
<Button variant="link" onClick={openLink}>查看详情</Button>
<Button loading={saving} onClick={save}>保存</Button>
```

实际用户文案仍使用 `t(...)` 并维护中英文翻译。

## 外观与尺寸

| 参数 | 用途 |
| --- | --- |
| `variant="primary"` | 主操作，使用主题主按钮色 |
| `variant="secondary"` | 默认值，次操作，有边框 |
| `variant="ghost"` | 轻量操作，透明背景 |
| `variant="link"` | 文本链接操作 |
| `danger` | 危险操作；与主按钮组合时使用危险实色背景 |
| `size="xs"` | 紧凑工具栏，基础高度 22px |
| `size="sm"` | 默认尺寸，基础高度 28px |
| `size="md"` | 对话框操作，基础高度 32px |

字体和高度跟随应用字号比例。状态颜色使用已有主题变量，不在调用处硬编码。`loading` 保持按钮内容占位与可访问名称，显示加载动画并禁用重复操作。可取消的运行操作应保留独立的停止按钮，不对停止按钮设置 `loading`。

组件透传原生按钮属性和 ref，默认 `type="button"`；提交表单时明确传入 `type="submit"`。

## 其他交互控件

- 纯图标操作继续使用 `IconButton`，通过已有尺寸和颜色变量定制。
- 提交、暂存等分段操作使用 `Button` 作为主操作，配合 `SplitButtonMore`；容器 `.action-split` 统一管理两部分的背景。
- 菜单项、标签页、选项、树节点、列表行保持原生语义与结构样式，它们的选中和布局行为不由普通按钮负责。
- 欢迎页版本更新胶囊和状态栏控件保留专用外观；避免套用普通按钮的尺寸。全局悬停规则不覆盖 `Button` 与 `IconButton`。
