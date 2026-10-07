# 发布维护指南

本指南面向维护者。安装与日常更新见 [README](../README.md#下载安装)，GitCode 配置及排障见 [镜像维护指南](gitcode-update-mirror.md)。流程以 [Release 工作流](../.github/workflows/release.yml) 为准。

GitHub 源码、Releases、安装包和更新清单统一位于公开仓库 `chenqinru/VersionDockDesktop`，默认分支为 `main`。GitCode 的 `chenqinru/VersionDockDesktop-Releases` 作为安装包镜像，不同步源码。

## 发布配置

| 配置 | 用途 |
| --- | --- |
| `GITHUB_TOKEN` | Actions 自动提供；仅 `publish` 任务授予 `contents: write`，用于本仓库 Release 发布 |
| `TAURI_SIGNING_PRIVATE_KEY` | 已保存的更新签名私钥，用于三平台更新产物签名 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥有密码时设置的可选 Secret |
| `GITCODE_RELEASE_REPOSITORY` | Actions Variable 为 `chenqinru/VersionDockDesktop-Releases`，启用镜像构建配置与发布任务 |
| `GITCODE_RELEASE_BRANCH` | 可选 Variable，固定更新清单所在分支，默认 `main` |
| `GITCODE_RELEASE_TOKEN` | 镜像发布 Secret，仅注入 GitCode 发布步骤，不进入客户端 |

GitHub 发布无需额外 PAT 或 `RELEASES_TOKEN`。更新签名私钥必须与 `src-tauri/tauri.conf.json` 中的公钥匹配，发布步骤会校验所有更新签名；不要通过更换密钥绕过失败。

检查、三平台构建、产物准备、GitHub `publish` 和 GitCode `publish-gitcode` 均使用 GitHub 托管 runner；发布前安装 minisign 校验更新包签名。

本地发布测试还需要 Python 3（`python3` 命令），用于真实 ZIP 缓存和安全解压回归；不需要额外 Python 包。

## 发布一个新版本

可以在本项目的 Codex 聊天中使用项目 Skill 自动完成本地准备：

```text
$versiondock-release 准备下一个 patch 版本，生成中英文更新说明并完成本地校验
```

Skill 位于 [`.agents/skills/versiondock-release/SKILL.md`](../.agents/skills/versiondock-release/SKILL.md)，会读取上次版本标签后的提交和实际差异，整理双语记录、同步版本并校验。也支持“只生成更新说明，不修改版本号”。默认完成本地准备；提交、打标签和推送遵从当次发布指令。手动操作步骤如下，Skill 已完成的步骤无需重复执行。

1. 在准备发布的代码上运行 `npm run version:bump -- patch`，也可传入明确的正式版本号。脚本同步 package、Tauri、Cargo 元数据及锁文件。
2. 在 `src/release-notes.json` 首部添加相同版本的记录，填写有效日期、`highlights.zh-CN` 和 `highlights.en`。中文记录生成远程清单的 `notes` 和 Release 正文；应用内历史记录按界面语言展示。
3. 运行 `npm run check`，检查并提交版本、更新说明及实现改动，然后推送 `main`。版本号只接受 `X.Y.Z`，当前发布流程不支持 prerelease 或 build 后缀。
4. 如本次更新了依赖、工具链或发布工作流，先等待 `main` 上的 [Warm release cache](../.github/workflows/warm-release-cache.yml) 完成；也可手动运行该工作流。首次配置时同样建议先预热。
   同一发布提交的 CI 已全部成功时，Release 可复用其结果；同时推送 `main` 和标签、CI 尚未完成时，Release 不等待它，会正常执行自己的检查。
5. 在已提交的发布版本上创建并推送对应标签，触发 Release 工作流：

```bash
task_release_version=$(node -p "require('./package.json').version")
git tag "v$task_release_version"
git push origin "v$task_release_version"
```

缺少该版本更新记录、版本元数据不一致或标签不匹配，都会在构建前失败。修改 updater 地址、镜像配置或发布脚本后，应发布包含这些改动的新版本；重新构建旧标签仍会使用旧标签中的源码与配置。

## 工作流如何发布

1. **固定源码**：解析版本标签并保存源码 SHA，后续所有任务使用同一提交。
2. **检查与构建**：若找到 24 小时内同一源码 SHA、来自本仓库 `main` push、整个 CI 及全部三平台检查均成功的运行，则复用其检查结果；发布关口再次读取 CI 状态确认。未找到、API 不可访问或不符合条件时仍执行全部 Release 检查。前端仅构建一次；Windows、Linux 与 macOS 两个架构并行构建。macOS 合包前校验源码、版本、构建配置、前端资源哈希、二进制哈希和架构，再用 `lipo` 合成 Universal，调用 `tauri bundle` 打包并签名，不重复编译。artifacts 保留 14 天。
3. **验证产物**：全部检查与平台构建成功后，托管 `prepare` 任务验证版本、平台覆盖、SHA-256 和更新签名，再生成 `latest.json`。完整产物作为 `prepared-release-源码SHA` 上传，供两端发布共同使用。
4. **独立发布 GitHub**：托管 runner 下载同一份 prepared artifact，重新校验更新签名，再创建或补齐 Release 草稿，上传附件并下载比对哈希；再次检查版本标签及最新版本，验证通过后公开草稿并设为 latest。
5. **独立更新 GitCode**：托管 runner 下载同一 prepared artifact，创建预发布 Release，上传镜像附件并匿名下载校验哈希，再上传版本清单；确认没有更新版本后将 Release 设为正式版本，最后提交固定 `latest.json`。与 GitHub 发布并行，失败时仅该任务报错。

GitHub 清单默认使用 macOS universal `.app.tar.gz`、Windows NSIS `.exe`、Linux `.AppImage`。生成 MSI、deb 或 rpm 时，也必须提供有效签名及对应格式的清单入口。GitHub 与 GitCode 使用同一更新公钥，但清单内的下载地址分别指向各自平台。

检查失败或任一平台构建失败时，两端都不进入发布。通过 `prepare` 后，GitHub 和 GitCode 发布互不依赖，分别串行保护各自的 latest；一端失败不阻断另一端。公开仓库的 workflow 日志和 artifacts 可被其他有访问权限的用户读取，不应包含凭据或内部资料。

`prepare` 使用仓库原有的 ZIP digest 校验与安全解压能力。GitCode 发布任务通过 `actions/download-artifact` 获取当前运行已准备的同一份产物。

工作流按固定标签源码中可用的脚本启用优化。新标签包含 helper 时使用 macOS 并行构建和 CI 复用；GitCode 镜像接入需要标签源码包含新镜像脚本与构建配置。直接重跑历史任务仍使用当时的工作流。

## 失败与重试

| 情况 | 处理方式 |
| --- | --- |
| 检查或构建失败 | 查看失败日志；代码需要修正时提交改动并使用新版本标签，环境问题可重跑原任务 |
| GitCode 发布权限失败 | 检查 `GITCODE_RELEASE_TOKEN` 是否到期，以及项目读写权限和镜像仓库配置 |
| 上传报 HTTP/2 `REFUSED_STREAM` | 发布步骤与脚本已对 `gh` 配置 HTTP/1.1 并保留 TLS 校验；检查失败日志与远端状态后重跑失败任务 |
| 上传中断或草稿附件不完整 | 原版本未公开时可重试，脚本补齐附件并重新验证 |
| `prepare` 报产物为空或校验失败 | 比较错误中的大小、期望和实际 SHA-256；远端 artifact 正确时只重新下载发布产物，不重编译、不修改校验记录。新流程先验证完整 ZIP 再解压，旧流程需要清理临时下载目录后重跑失败发布任务 |
| GitCode 已更新、GitHub 发布失败 | 镜像可能已提供新版本；仅重跑失败的 GitHub 发布任务，复用已准备的产物 |
| GitHub 已更新、GitCode 发布失败 | GitHub 主更新源已经可用；仅重跑失败的镜像任务，复用当前运行准备好的产物 |
| 签名校验失败 | 检查 Secret、公钥与产物是否匹配，不公开损坏产物 |
| 版本已公开或低于当前 latest | 不覆盖、不移动标签；增加版本号后发布修正版 |

GitHub Release 与 GitCode 清单不是跨平台原子发布：GitCode 完成后 GitHub 仍可能失败。重试前分别检查两端状态。

GitHub 附件上传最多重试三次，网络错误、429 或 5xx 才重试。每次重新读取草稿状态；已经上传且大小、服务端 SHA-256 与本地一致的文件直接复用，残留或不一致的草稿附件才重传。响应丢失时先确认附件是否已完整上传，避免重复 POST；已公开版本或标签变化立即停止。远程下载重试会清除不完整文件，发布前仍完整下载比对哈希。权限错误不自动重试，创建或公开 Release 不盲目重试。

需要使用最新工作流手动重试时，在 Actions → Release → Run workflow 选择 `main`，输入已存在的正式版本标签。直接重跑历史运行会继续使用该运行原有的工作流版本。重试依然会检查标签源码、版本和已公开状态，不能绕过发布保护。

GitHub 已发布、仅 GitCode 失败且镜像脚本已修复时，使用 **Retry GitCode mirror**，输入已公开版本号。该工作流复用 GitHub 安装包及签名，通过服务端 SHA-256 核验后只补发镜像，避免旧版本标签中的脚本重复失败。具体步骤见 [补发镜像](gitcode-update-mirror.md#使用修正后的脚本补发镜像)。

## 发布后核验

- 在 GitHub Release 检查安装包、签名和 `latest.json` 是否齐全，清单版本及下载地址是否正确。
- 用未登录的请求读取 GitCode 清单与安装包，确认镜像可访问；具体命令见 [镜像核验](gitcode-update-mirror.md#首次发布核验)。
- 在目标平台用真实签名安装包验证检测、下载、安装、重启、版本号与设置保留；分别验证 GitHub 下载和 GitCode 备用下载。

macOS 当前使用 ad-hoc 签名，没有 Apple Developer ID 签名或公证。Tauri 更新签名与操作系统应用签名是两套机制，更新签名校验通过不代表系统首次运行不会提示确认。

## 临时安装包

普通 CI 不发布 Release。需要临时包时，在 Actions → CI → Run workflow 勾选 `bundle`，检查通过后生成三平台 `ci-packages-*` artifacts，保留 7 天；该模式不生成自动更新签名产物。

本地打包可运行 `npm run tauri:build -- --ci --config src-tauri/tauri.unsigned.conf.json`。它不更换生产更新公钥，也不能代替正式签名发布。
