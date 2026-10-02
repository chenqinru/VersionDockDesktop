# 日志底部加载提示对齐

用户图一为 App，图二为插件。插件参考为只读仓库 `VersionDock/src/webview/gitLog/components/CommitList.tsx` 的 `loadingMore`、`bgLoadingBar` 和动画规则。

原 App 用整条底栏显示加载提示。现在改为日志可视区域底部居中的悬浮提示：距底部 8px、最小高度 26px、左右内边距 10px、4px 圆角、边框和阴影，配 14px 旋转图标。分页时增加插件同款 2px 底部动态进度条；图标和进度条沿用用户要求的灰色加载语义。

提示放在滚动容器外的定位框内，滚动时位置固定，不占据列表高度。已有提交继续显示；加载期间禁止重复触发分页，完成后提示消失。保留原分页状态和请求方式，不增加生产延迟或模拟数据。

## 验证

- `npm run check:frontend` 通过，51 个测试文件、526 个测试；类型、lint、i18n 和构建通过。构建仍有现有 chunk 体积提示。
- 新增分页回归：已有提交保留、提示在滚动容器外、加载期间不重复请求、完成后消失且可继续分页。
- macOS 原生 Tauri QA App 使用临时真实 Git 仓库的 220 个提交，连续分页从 100 到 200，再到 220。为捕捉加载状态，仅对独立 QA 进程的 PATH 加入临时 Git wrapper，对临时仓库的 `git log` 延迟 3 秒后执行真实 `/usr/bin/git`。
- 原生截图确认底部加载提示居中、列表滚动后仍固定、完成后消失；图谱与提交行滚动正常，最终可见第 001 条根提交。没有对 Windows/Linux 逐项验收。
- 未修改插件和 Rust 生产代码，未自动提交。独立 QA 进程已退出，QA 配置恢复，用户已有开发服务保持运行。

截图与日志：`docs/manual/history-loading-2026-10-02/`。其中 `paging-loading.png` 为第一次分页加载，`paging-scrolled-loading.png` 为第二次分页期间向上滚动，`paging-complete.png` 为加载完成，`final-page.png` 为最后一页。
