# VersionDock Desktop V3 验收记录

日期：2026-08-23

## 自动化检查

- `npm run check`：通过。
  - 独立性、窗口配置、TypeScript、ESLint、Specta bindings、Vite build、Rustfmt、Clippy 全部通过。
  - Vitest：18 个测试文件、98 个用例通过。
  - Rust：34 个用例通过；本机 Git 2.53.0、SVN/SVNAdmin 1.14.5 可用，真实 Git/SVN 用例未跳过。
- `npm run tauri:build`：通过，生成 macOS `.app` 与 arm64 `.dmg`。
- `git diff --check`：通过。
- `npm run fixture:runtime`：通过，创建包含中文和空格路径的真实 Git/SVN 混合工作区。

## macOS Runtime

执行：

```bash
npm run tauri:dev -- --workspace <fixture-path>
```

Tauri DevCommand 成功编译并启动 `target/debug/versiondock-desktop --workspace <fixture-path>`，未发生启动 panic。验收机当时处于 macOS 锁屏状态，因此本轮不能把深浅主题、中英文、1024×680 和新增弹窗的可见效果标记为人工视觉通过；这些项目保留为解锁后的人工清单。

## 平台边界

- macOS：静态检查、真实 Git/SVN 测试、bundle 和 Runtime 进程启动已验证；人工视觉验收受锁屏限制。
- Windows/Linux：CI 已配置安装 SVN 并以 `VERSIONDOCK_REQUIRE_VCS_TESTS=1` 禁止将缺少工具静默计为通过；本轮未做实机视觉与交互验收。
