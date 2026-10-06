# 公开安装包发布流程

源码仓库：`chenqinru/VersionDockDesktop`（私有）。下载仓库：`chenqinru/VersionDockDesktop-Releases`（公开，默认分支 `main`）。公开仓库的 README 来源于 `docs/public-downloads.md`，只发布安装包、更新清单及使用说明。

## 一次性设置

1. 在 GitHub [创建 fine-grained PAT](https://github.com/settings/personal-access-tokens/new)，名称建议 `VersionDock Releases`。Resource owner 选择 `chenqinru`；Repository access 选择 **Only select repositories**，只选择 `VersionDockDesktop-Releases`；Repository permissions 中仅添加 **Contents: Read and write**。按公司策略设置有效期，到期前更新 Secret。
2. 在私有源码仓库的 [Actions Secrets](https://github.com/chenqinru/VersionDockDesktop/settings/secrets/actions) 新增 `RELEASES_TOKEN`，值为上一步 PAT。也可在自己的终端运行 `gh secret set RELEASES_TOKEN --repo chenqinru/VersionDockDesktop`，按提示输入。不要把 Token 写入源码或聊天。
3. 复用已有 `TAURI_SIGNING_PRIVATE_KEY`。如果密钥带密码，增加 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。GitHub Secret 无法被读回，发布任务会使用客户端公钥验证所有更新包，确保现有密钥匹配；匹配失败时不公开版本。不要重新生成密钥来绕过校验。

跨仓库凭据只注入最终发布步骤，不进入构建任务或客户端。默认 `GITHUB_TOKEN` 仅用于当前私有仓库的只读访问。

## 日常发版

1. 运行 `npm run version:bump -- patch`（或明确的正式版本号），提交版本及改动。仅支持 `0.1.1` 这样的正式 SemVer，不支持 beta 或 build 后缀。
2. 推送代码及匹配的版本标签，例如 `v0.1.1`。标签必须和 package、Tauri、Cargo 元数据一致；不能移动已发布标签。
3. Release workflow 先解析标签、验证版本并固定提交 SHA，随后并行执行前端检查和 Rust 完整检查。全部成功后，三平台复用同一份前端资源，并行构建 macOS universal、Windows x64、Linux x64。签名产物先保存在私有 workflow artifacts，保留 14 天。
4. 最终发布任务验证版本、平台覆盖、SHA-256 和全部更新签名，再生成单份 `latest.json`。默认入口采用 macOS universal、Windows NSIS 和 Linux AppImage；如果构建了 MSI、deb 或 rpm，必须提供有效签名，并登记对应安装包类型的入口，避免混用格式。先上传公开仓库草稿，下载附件校验内容，一切完整后才公开并设为 latest。

可在 Actions 页面选择 Release → Run workflow，输入已存在的版本标签重试。只有草稿可被补齐；已公开版本禁止覆盖。发布更低或相同版本也会失败。三平台任意构建失败，公开仓库保持上一版本。

GitHub Actions 的并发组会串行执行公开发布，待执行任务受 GitHub 的 pending 队列规则影响；同一时间不要连续触发大量发版。被取消的待发布版本可按上述方式重试。

草稿中的安装包在正式公开前不可匿名下载。所有上传与远程内容校验成功后，工作流才解除草稿状态。更新清单使用公开仓库版本地址，不依赖私有源码 SHA；公开标签基于公开仓库 `main`。

当前公开说明采用固定的版本与平台说明，不自动复制私有提交信息或 CI 日志。客户端源码仓库首页的下载徽章及应用内下载、更新日志、反馈入口指向公开仓库。

## 本地检查与普通 CI

- 本地完整检查需要 Git、SVN、Rust、Node 20+ 及 `minisign`：macOS 使用 `brew install minisign`；Ubuntu 使用 `sudo apt-get install minisign`。运行 `npm run check`，其中 `npm run test:release` 使用临时测试密钥验证发布逻辑，不接触生产密钥。
- 普通 `main` push / pull request CI 并行检查前端和 Rust，保留三平台真实 Git/SVN 测试；macOS 还检查另一种 CPU 架构。日常 CI 不生成完整安装包。
- 临时需要安装包时，在 Actions → CI → Run workflow 勾选 `bundle`。通过检查后生成三平台安装包，保存为私有 `ci-packages-*` artifacts，保留 7 天；该任务不会发布公开 Release。
- 正式打包启用了 `bundle.createUpdaterArtifacts`，需要签名环境变量。不生成更新包的本地打包使用 `npm run tauri:build -- --ci --config src-tauri/tauri.unsigned.conf.json`；手动 CI 打包也使用该配置，不更换客户端更新公钥或地址。
- 公钥与签名文本使用 Tauri 的 Base64 包装格式；校验复用 minisign，避免自行实现签名算法。

缓存、并行任务及共享前端资源的细节见 [CI 耗时优化](ci-optimization.md)。

## macOS 免费分发与磁盘权限

- 当前选择不购买 Apple Developer Program。`tauri.macos.conf.json` 使用 `signingIdentity: "-"` 对完整 App bundle 做 ad-hoc 签名，并启用 hardened runtime；这会绑定 Info.plist 和资源，避免只有 Mach-O 编译器临时签名、应用资源未封装的问题。
- ad-hoc 签名不等于 Developer ID 签名或 Apple 公证。首次从网络下载安装时，macOS 仍可能阻止打开；确认来源后按系统「隐私与安全性」提供的入口允许打开。正常安全检查保持启用。
- Tauri 的更新包签名继续使用原有私钥和公钥，与上述 macOS 应用签名分别验证。不需要新增 Apple Secrets，也不会修改已有更新密钥。
- 欢迎页只展示已保存的最近项目，不在启动时读取这些项目目录。点击项目后才验证路径并加载仓库；此前不可用的历史项目也可点击重试。通过明确的工作区启动参数打开项目时仍需访问磁盘。
- 同一安装包的磁盘权限应由系统保存；每次重建或更新，ad-hoc 代码签名身份可能变化，系统可能再次询问。此方案不能保证跨版本保留权限，也不能消除真正访问受保护目录时的系统授权。
- 当前 App 版本在 `src/version.ts` 统一导出，欢迎页、设置页、关于弹窗、更新检查和诊断报告均从这里读取 `package.json` 的版本号。原生 macOS「关于」菜单使用 Tauri 构建元数据，现有检查确保它与 package、Cargo 及锁文件一致。
- 本地 `npm run package:macos:dmg` 按已有 App 的实际架构生成版本化文件名，并拒绝打包版本或应用标识不一致的旧产物。通用版或指定构建路径可运行 `npm run package:macos:dmg -- /绝对路径/VersionDock\ Desktop.app`。历史更新日志和版本比较测试保留各自的版本号。修改源码后需发布新版本，旧安装包不会自动获得这些修正。

## 上线验收记录

自动化或构建通过不等于真实升级通过。首次发版后用两个递增版本分别记录以下实机证据：

2026-10-06 已完成：公开下载仓库初始化并核验其公开属性及 `main` 默认分支；确认 `RELEASES_TOKEN` Secret 已保存（未读取值，权限待首次发布验证）；本地完整检查通过，前端 802 项测试、Rust 216 项测试通过（5 项标记 ignored），新增发布测试 13 项通过；Actions 配置通过 actionlint。使用真实 GitHub 草稿完成验证文件上传与下载 SHA-256 校验，临时草稿已删除。下载仓库目前未发布应用版本；源码改动尚未提交推送。

| 检查项 | 当前状态 |
| --- | --- |
| 现有生产签名密钥与客户端公钥匹配 | 等待签名构建及发布校验 |
| macOS Apple Silicon / Intel 检测、安装、重启、版本与设置保留 | 待实机验收 |
| Windows x64 检测、安装、重启、版本与设置保留 | 待实机验收 |
| Linux x64 AppImage 检测、安装、重启、版本与设置保留 | 待实机验收 |
| 公司网络与家庭网络匿名下载及应用内更新 | 待网络验收 |
| macOS 完整 App 的 ad-hoc 签名 | 本地复用已有二进制完成 Tauri 打包及严格签名校验；新版本安装待实机验收 |
| Apple Developer ID 签名与公证 | 按用户选择不付费，不启用 |
| Windows 代码签名 | 沿用现有配置，单独验收 |

首次安装或旧更新地址迁移只需下载新版一次，之后无需人工分发。失败版本应发布修正版并增加版本号，不能修改已经公开的安装包。
