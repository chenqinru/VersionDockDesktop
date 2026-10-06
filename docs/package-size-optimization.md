# 发布安装包体积优化

## 构建配置

`src-tauri/Cargo.toml` 的 release profile 使用 `strip = "symbols"`、`lto = "thin"` 和 `codegen-units = 1`，裁剪符号信息并执行跨 crate 链接优化。保留默认发布优化等级和 panic 处理方式。

第一轮删除两张未被界面引用的历史 Logo，Vite 不再将它们复制到 `dist`。当前界面使用的深色、浅色 Logo 和原生图标生成来源保持原路径。

## macOS 实测（2026-10-06）

以同一版本 `0.1.0` 的 macOS universal 发布构建对比，包含 Intel 和 Apple Silicon 两种架构。单位为十进制 MB。

| 产物 | 优化前 | 第一轮优化后 | 减少 |
| --- | ---: | ---: | ---: |
| App | 74.82 MB | 47.86 MB | 36.04% |
| DMG | 35.51 MB | 27.65 MB | 22.14% |
| App 主程序 | 72.99 MB | 46.03 MB | 36.94% |
| 前端 dist | 16.47 MB | 14.65 MB | 11.01% |

## 第二轮：依赖与高亮资源

- 将业务 HTTP 客户端统一到 updater 已使用的 reqwest 0.13，去掉重复的 0.12 依赖。业务请求仍使用显式配置的 Rustls/Ring 和 WebPKI 根证书，保持原有证书及主机名验证、超时和重定向策略。
- 将 Specta 类型导出相关依赖移入开发依赖，只在测试/生成接口时编译类型元数据；保留 Serde 序列化行为及生成的前端接口。
- 差异、合并、主题预览和 AI 预览共用一个 Oniguruma 高亮引擎。显式按需加载应用支持的 33 种语言及嵌入语法，只收录当前使用的 8 个主题，去掉全量语言/主题入口和重复的 JavaScript 正则引擎。
- 深浅 Logo 使用 macOS 连续圆角，保留透明背景且无外围描边；同步重新生成原生图标。ICNS 从 1.83 MB 减至 1.53 MB。

继续保留 macOS universal，无需拆分 Intel 与 Apple Silicon 下载/更新入口。语言加载状态与实际渲染语法对应，语言切换时避免使用旧状态；加载失败可重新尝试，未支持的语法保持文本回退。

| 产物 | 第一轮 | 第二轮 | 本轮减少 |
| --- | ---: | ---: | ---: |
| App | 47.86 MB | 41.24 MB | 13.82% |
| DMG | 27.65 MB | 23.76 MB | 14.07% |
| App 主程序 | 46.03 MB | 39.71 MB | 13.72% |
| 前端 dist | 14.65 MB | 8.59 MB | 41.38% |

相对最初产物，App 累计减少约 44.88%，DMG 约 33.09%。前端文件数从 307 减为 61；`dist` 内资源会嵌入主程序，不能把前端减少量再次叠加到 App 减少量。

本地体积测量使用不生成更新签名的已有配置：

```bash
TAURI_BUNDLER_DMG_IGNORE_CI=true npm run tauri:build -- --ci --config src-tauri/tauri.unsigned.conf.json --target universal-apple-darwin
```

正式 Release 流水线沿用已有更新签名配置。发布优化 profile 同时用于其他平台的 release 构建；Windows、Linux 体积仍需在对应平台重新构建测量。

## 验证

- 第二轮 TypeScript、ESLint、Rust 格式、Clippy、生成接口校验通过；840 项前端测试、13 项发布测试通过。
- 33 种语言在深浅两种主题下的分词和颜色与原 Shiki Diff 渲染结果一致；覆盖并发加载、语言别名和合并视图实际语法加载。
- Rust 常规测试 217 项通过、6 项默认跳过。TLS 测试确认业务客户端拒绝不受信任的自签名服务器；另手动执行真实 GitHub HTTPS 请求测试通过，未放宽证书验证。
- macOS 通用版重新构建成功，`lipo -archs` 确认 `x86_64 arm64`，DMG 校验和验证通过。
- 第二轮最终 App 的实际主程序以 worker 模式执行真实 Git 拉取与 SVN 更新，验证中文路径、远端更新和本地未提交改动保留；Apple Silicon 原生执行与 Intel/Rosetta 执行均通过。所有操作使用临时仓库和独立状态目录，未修改用户应用配置；Rosetta 结果不等于物理 Intel 设备验收。
- Apple Silicon Release 模式 Rust 测试 217 项通过、6 项默认跳过。首次附带的文档测试出现依赖加载错误，在打包结束后单独重试通过（当前无文档测试用例）。
- 本次未开展完整图形界面操作验收、Apple 正式签名/公证及 Windows、Linux 实机验收。

Release 模式回归命令：

```bash
VERSIONDOCK_REQUIRE_VCS_TESTS=1 cargo test --release --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin --features tauri/custom-protocol
```
