# 公开安装包发布流程

源码、安装包、更新清单和问题反馈统一使用公开 GitHub 仓库 [`chenqinru/VersionDockDesktop`](https://github.com/chenqinru/VersionDockDesktop)，默认分支为 `main`。GitHub 不再使用独立下载仓库；公司 GitLab 的 `VersionDockDesktop-Releases` 仍仅保存安装包、签名和更新清单，作为备用更新源。下载与更新说明见 [下载指南](public-downloads.md)。

## 一次性设置

1. 将 GitHub 项目仓库设为公开。发布任务会校验仓库身份、公开可见性及 `main` 默认分支。
2. GitHub 发布使用当前工作流自动生成的 `GITHUB_TOKEN`，仅 `publish` 任务授予 `contents: write`，其他任务保持只读。无需跨仓库 PAT 或 `RELEASES_TOKEN` Secret。
3. 复用已有 `TAURI_SIGNING_PRIVATE_KEY`。如果密钥带密码，增加 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。发布任务使用客户端公钥验证所有更新包，匹配失败时不公开版本；不要重新生成密钥来绕过校验。
4. 保留 GitLab 的 `GITLAB_RELEASE_PROJECT_ID`、可选镜像 Variables 和 `GITLAB_RELEASE_TOKEN` Secret，具体设置见 [GitLab 镜像](gitlab-update-mirror.md)。GitLab 令牌仅注入镜像发布步骤，不进入构建任务或客户端。

公开仓库的 workflow 日志和 artifacts 可被有访问权限的用户读取，不能作为私有存储。Secrets 的值不会因仓库公开而直接公开，仍不得写入日志或 artifacts。公司自托管 runner 只用于正式 Release 发布；普通 PR 检查继续使用 GitHub 托管 runner。

## 日常发版

1. 运行 `npm run version:bump -- patch`（或明确的正式版本号），在 `src/release-notes.json` 首部补齐该版本的日期及中英文公开更新内容，一起提交版本及改动。仅支持 `0.1.1` 这样的正式 SemVer，不支持 beta 或 build 后缀。缺少版本更新记录时，元数据检查会在构建前失败。
2. 推送代码及匹配的版本标签，例如 `v0.1.1`。标签必须和 package、Tauri、Cargo 元数据一致；不能移动已发布标签。
3. Release workflow 先解析标签、验证版本并固定提交 SHA，随后并行执行前端检查、Rust 完整检查和前端资源构建。资源构建完成后，三平台立即复用同一份前端资源，并行构建 macOS universal、Windows x64、Linux x64，无需等待其他检查结束。签名产物先保存在 workflow artifacts，保留 14 天；只有全部检查和全部平台构建成功后才进入公开发布。
4. 最终发布任务验证版本、平台覆盖、SHA-256 和全部更新签名，再生成单份 `latest.json`。默认入口采用 macOS universal、Windows NSIS 和 Linux AppImage；如果构建了 MSI、deb 或 rpm，必须提供有效签名，并登记对应安装包类型的入口，避免混用格式。先上传公开仓库草稿，下载附件校验内容，一切完整后才公开并设为 latest。

可在 Actions 页面选择 Release → Run workflow，输入已存在的版本标签重试。只有草稿可被补齐；已公开版本禁止覆盖。发布更低或相同版本也会失败。三平台任意构建失败，公开仓库保持上一版本。

GitHub Actions 的并发组会串行执行公开发布，待执行任务受 GitHub 的 pending 队列规则影响；同一时间不要连续触发大量发版。被取消的待发布版本可按上述方式重试。

草稿中的安装包在正式公开前不可匿名下载。所有上传与远程内容校验成功后，工作流才解除草稿状态。更新清单使用本项目仓库的版本下载地址。发布前及正式公开前都会确认已有版本标签指向已验证的构建 SHA；Release 使用该 SHA，不另外创建基于 `main` 的标签。

公开说明按版本从 `src/release-notes.json` 读取实际更新内容，不自动复制提交信息或 CI 日志。记录的中文内容同时生成更新清单 `notes` 和 GitHub Release 正文，GitLab 镜像复用同一内容；应用内历史更新日志从同一文件按界面语言显示。更新提示读取远程清单中对应待安装版本的说明，并按 Markdown 渲染。已经公开的安装包和清单保持不可覆盖，新说明生成逻辑需要随新版本发布。项目首页的下载徽章及应用内下载、更新日志、反馈入口均指向 `chenqinru/VersionDockDesktop`。

## 本地检查与普通 CI

- 本地完整检查需要 Git、SVN、Rust、Node 20+ 及 `minisign`：macOS 使用 `brew install minisign`；Ubuntu 使用 `sudo apt-get install minisign`。运行 `npm run check`，其中 `npm run test:release` 使用临时测试密钥验证发布逻辑，不接触生产密钥。
- 普通 `main` push / pull request CI 并行检查前端和 Rust，保留三平台真实 Git/SVN 测试；macOS 还检查另一种 CPU 架构。日常 CI 不生成完整安装包。
- 临时需要安装包时，在 Actions → CI → Run workflow 勾选 `bundle`。通过检查后生成三平台安装包，保存为 `ci-packages-*` workflow artifacts，保留 7 天；该任务不会发布公开 Release。
- 正式打包启用了 `bundle.createUpdaterArtifacts`，需要签名环境变量。不生成更新包的本地打包使用 `npm run tauri:build -- --ci --config src-tauri/tauri.unsigned.conf.json`；手动 CI 打包也使用该配置，不更换客户端更新公钥或地址。
- 公钥与签名文本使用 Tauri 的 Base64 包装格式；校验复用 minisign，避免自行实现签名算法。

正式发布复用一份前端资源，并在 `main` 分支预热三平台的 Rust 构建缓存。首次配置或依赖发生较大变化时，先等待 `Warm release cache` 成功，再推送版本标签；标签任务只恢复缓存，避免反复上传无法跨标签复用的缓存。

## macOS 免费分发与磁盘权限

- 当前选择不购买 Apple Developer Program。`tauri.macos.conf.json` 使用 `signingIdentity: "-"` 对完整 App bundle 做 ad-hoc 签名，并启用 hardened runtime；这会绑定 Info.plist 和资源，避免只有 Mach-O 编译器临时签名、应用资源未封装的问题。
- ad-hoc 签名不等于 Developer ID 签名或 Apple 公证。首次从网络下载安装时，macOS 仍可能阻止打开；确认来源后按系统「隐私与安全性」提供的入口允许打开。正常安全检查保持启用。
- Tauri 的更新包签名继续使用原有私钥和公钥，与上述 macOS 应用签名分别验证。不需要新增 Apple Secrets，也不会修改已有更新密钥。
- 欢迎页只展示已保存的最近项目，不在启动时读取这些项目目录。点击项目后才验证路径并加载仓库；此前不可用的历史项目也可点击重试。通过明确的工作区启动参数打开项目时仍需访问磁盘。
- 同一安装包的磁盘权限应由系统保存；每次重建或更新，ad-hoc 代码签名身份可能变化，系统可能再次询问。此方案不能保证跨版本保留权限，也不能消除真正访问受保护目录时的系统授权。
- 当前 App 版本在 `src/version.ts` 统一导出，欢迎页、设置页、关于弹窗、更新检查和诊断报告均从这里读取 `package.json` 的版本号。原生 macOS「关于」菜单使用 Tauri 构建元数据，现有检查确保它与 package、Cargo 及锁文件一致。
- 本地 `npm run package:macos:dmg` 按已有 App 的实际架构生成版本化文件名，并拒绝打包版本或应用标识不一致的旧产物。通用版或指定构建路径可运行 `npm run package:macos:dmg -- /绝对路径/VersionDock\ Desktop.app`。历史更新日志和版本比较测试保留各自的版本号。修改源码后需发布新版本，旧安装包不会自动获得这些修正。

## 发版验证

正式发版后，在目标平台验证检测更新、安装、重启、版本号和设置保留；分别确认 GitHub 下载以及 GitLab 备用下载正常，损坏的包被签名校验拒绝。自动化检查和构建通过不能代替实机升级验证。

旧 GitHub 下载仓库已删除，不迁移历史 Releases，也不提供旧地址兼容。已安装客户端需要手动安装使用新地址的版本一次；GitLab 镜像继续发布。

失败版本应增加版本号后发布修正版，不能修改已经公开的安装包。
