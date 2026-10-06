# 发布安装包体积优化

## 构建配置

`src-tauri/Cargo.toml` 的 release profile 使用 `strip = "symbols"`、`lto = "thin"` 和 `codegen-units = 1`，裁剪符号信息并执行跨 crate 链接优化。保留默认发布优化等级和 panic 处理方式。

两张未被界面引用的历史 Logo 已删除，Vite 不再将它们复制到 `dist`。当前界面使用的深色、浅色 Logo 和原生图标生成来源保持原路径。语法高亮语言及引擎未调整。

## macOS 实测（2026-10-06）

以同一版本 `0.1.0` 的 macOS universal 发布构建对比，包含 Intel 和 Apple Silicon 两种架构。单位为十进制 MB。

| 产物 | 优化前 | 优化后 | 减少 |
| --- | ---: | ---: | ---: |
| App | 74.82 MB | 47.86 MB | 36.04% |
| DMG | 35.51 MB | 27.65 MB | 22.14% |
| App 主程序 | 72.99 MB | 46.03 MB | 36.94% |
| 前端 dist | 16.47 MB | 14.65 MB | 11.01% |

本地体积测量使用不生成更新签名的已有配置：

```bash
TAURI_BUNDLER_DMG_IGNORE_CI=true npm run tauri:build -- --ci --config src-tauri/tauri.unsigned.conf.json --target universal-apple-darwin
```

正式 Release 流水线沿用已有更新签名配置。发布优化 profile 同时用于其他平台的 release 构建；Windows、Linux 体积仍需在对应平台重新构建测量。

## 验证

- TypeScript、ESLint、Rust 格式检查、生成接口校验通过；802 项前端测试、13 项发布测试通过。
- macOS 通用版重新构建成功，`lipo -archs` 确认 `x86_64 arm64`，DMG 校验和验证通过。
- 优化后 App 的实际主程序以 worker 模式执行真实 Git 拉取与 SVN 更新，验证中文路径、远端更新和本地未提交改动保留；Apple Silicon 原生执行与 Intel/Rosetta 执行均通过。所有操作使用临时仓库和独立状态目录，未修改用户应用配置。
- Apple Silicon Release 模式 Rust 测试通过；本次未开展完整图形界面操作验收、Apple 签名/公证及 Windows、Linux 实机验收。

Release 模式回归命令：

```bash
VERSIONDOCK_REQUIRE_VCS_TESTS=1 cargo test --release --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin --features tauri/custom-protocol
```
