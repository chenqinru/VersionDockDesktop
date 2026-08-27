# VersionDock Desktop

VersionDock Desktop 是基于 Tauri 2、Rust、React 18 和 TypeScript 的独立 Git/SVN 桌面工作台。它不要求安装 VS Code，发布包运行时也不依赖 Node.js。

## 当前能力

- 打开、拖入、恢复和移除最近工作区；支持多根目录、Git/SVN 混合与嵌套仓库。
- Git status、Diff、stage/unstage、commit/amend、commit & push、fetch/pull/push、历史、提交详情、分支与 Tag。
- SVN status、Diff、自动 add/delete 后 commit、update、revision history 与提交详情。
- Git/SVN 冲突列表、版本加载、三栏 Merge Editor、fingerprint 防覆盖与解决后 stage/resolve；二进制冲突提供 mine/theirs/working 整体选择。
- Git Stash、应用数据目录 Shelf、Changelist、托管 Worktree、Branch Compare 与 Remote 管理。
- Git Identity Profile、SVN 账号安全存储与测试连接，以及 Git/SVN 原生 File History。
- 无边框窗口、平台窗口按钮、系统/浅色/深色主题、中英文、分栏持久化、文件拖入、系统打开与定位和去重通知。
- AI capability 固定关闭；应用不包含 Provider、API Key、Prompt 或 AI 网络请求。

Subtree、Identity Profile、SVN 账号管理和 File History 均由仓库级 capability 控制。Shelf 提供安全的完整补丁 create/apply/drop；Changelist 提供元数据管理和文件移动；Worktree 只允许管理应用数据目录中的托管工作树。外部编辑器支持可执行文件与逐行参数模板，占位符为 `{path}`、`{relativePath}`、`{repo}`，执行时不经过 Shell。

## 开发

要求：Node.js 20+、Rust stable、系统 WebView；Git 与 SVN 按需安装。

```bash
npm install
npm run tauri:dev
```

前端开发服务可单独启动，但真实仓库操作必须通过 Tauri 运行：

```bash
npm run dev
```

## 测试与检查

```bash
npm run check
```

该命令执行独立性扫描、TypeScript、ESLint、Vitest、Vite build、Rust fmt、Clippy 和 Cargo tests。Rust 测试会在本机工具可用时创建真实临时 Git/SVN 仓库；测试数据不写入用户仓库。

生成并校验 Rust → TypeScript 契约：

```bash
npm run bindings
npm run bindings:check
```

## 打包

```bash
npm run tauri:build
```

- macOS：`.app`、`.dmg`
- Windows：NSIS/MSI（以 Tauri 构建机配置为准）
- Linux：AppImage、deb、rpm

`.github/workflows/ci.yml` 在三平台运行静态检查、测试和 bundle 构建。CI 构建成功不等同于各平台已完成视觉运行验收。

## 安全边界

- React 只依赖 `VersionDockBridge`；Tauri API 封装在平台层。
- Rust 仅公开 `bridge_request` 和 `bridge_cancel`，并在服务端重新解析 workspace/repository ID。
- Git/SVN 使用 `tokio::process::Command` 与参数数组；不拼接 Shell 字符串。
- 用户路径必须是仓库内相对路径，并拒绝越界、NUL 和符号链接祖先。
- 普通命令默认 120 秒，网络命令 10 分钟，单路输出上限 20 MiB；单文件 Diff 超过 5 MiB 或 50,000 行不渲染。
- App 状态写入标准应用配置目录，不污染工作区；Git Profile 不改写 Git 配置；SVN 密码只进入系统安全凭据存储并通过 stdin 交给 SVN。

## 许可证

本项目使用 GPL-3.0-only。迁移来源和第三方资源见 [docs/MIGRATION_SOURCES.md](docs/MIGRATION_SOURCES.md) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
