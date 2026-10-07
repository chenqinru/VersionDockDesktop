# 发布维护指南

本指南面向维护者。安装与日常更新见 [README](../README.md#下载安装)，GitLab 配置及排障见 [镜像维护指南](gitlab-update-mirror.md)。流程以 [Release 工作流](../.github/workflows/release.yml) 为准。

GitHub 源码、Releases、安装包和更新清单统一位于公开仓库 `chenqinru/VersionDockDesktop`，默认分支为 `main`。公司 GitLab 的 `VersionDockDesktop-Releases` 保留为安装包镜像，不同步源码。旧 GitHub 同名下载仓库已删除，不维护旧地址兼容。

## 发布配置

| 配置 | 用途 |
| --- | --- |
| `GITHUB_TOKEN` | Actions 自动提供；仅 `publish` 任务授予 `contents: write`，用于本仓库 Release 发布 |
| `TAURI_SIGNING_PRIVATE_KEY` | 已保存的更新签名私钥，用于三平台更新产物签名 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥有密码时设置的可选 Secret |
| `GITLAB_RELEASE_PROJECT_ID` | 当前 Actions Variable 为 `93`，启用镜像构建配置与发布步骤 |
| `GITLAB_RELEASE_TOKEN` | 已保存的镜像发布 Secret，仅注入 GitLab 上传步骤 |

GitHub 发布无需额外 PAT 或 `RELEASES_TOKEN`。更新签名私钥必须与 `src-tauri/tauri.conf.json` 中的公钥匹配，发布步骤会校验所有更新签名；不要通过更换密钥绕过失败。

前端检查、Rust 检查和三平台构建使用 GitHub 托管 runner；最终 `publish` 任务使用标签 `[self-hosted, linux, x64, gitlab-publish]`。其工具与网络要求见 [GitLab runner 配置](gitlab-update-mirror.md#发布-runner)。

## 发布一个新版本

1. 在准备发布的代码上运行 `npm run version:bump -- patch`，也可传入明确的正式版本号。脚本同步 package、Tauri、Cargo 元数据及锁文件。
2. 在 `src/release-notes.json` 首部添加相同版本的记录，填写有效日期、`highlights.zh-CN` 和 `highlights.en`。中文记录生成远程清单的 `notes` 和 Release 正文；应用内历史记录按界面语言展示。
3. 运行 `npm run check`，检查并提交版本、更新说明及实现改动，然后推送 `main`。版本号只接受 `X.Y.Z`，当前发布流程不支持 prerelease 或 build 后缀。
4. 如本次更新了依赖、工具链或发布工作流，先等待 `main` 上的 [Warm release cache](../.github/workflows/warm-release-cache.yml) 完成；也可手动运行该工作流。首次配置时同样建议先预热。
5. 在已提交的发布版本上创建并推送对应标签，触发 Release 工作流：

```bash
task_release_version=$(node -p "require('./package.json').version")
git tag "v$task_release_version"
git push origin "v$task_release_version"
```

缺少该版本更新记录、版本元数据不一致或标签不匹配，都会在构建前失败。修改 updater 地址、镜像配置或发布脚本后，应发布包含这些改动的新版本；重新构建旧标签仍会使用旧标签中的源码与配置。

## 工作流如何发布

1. **固定源码**：解析版本标签并保存源码 SHA，后续所有任务使用同一提交。
2. **检查与构建**：前端检查、Rust 检查和前端资源构建并行。资源生成后，macOS universal、Windows x64、Linux x64 并行打包并生成更新签名。安装包 artifacts 保留 14 天。
3. **验证产物**：全部检查与平台构建成功后，验证版本、平台覆盖、SHA-256 和更新签名，再生成 `latest.json`。
4. **更新 GitLab**：上传镜像附件，匿名下载校验哈希，最后提交镜像 `latest.json`。
5. **发布 GitHub**：创建或补齐 Release 草稿，上传附件并下载比对哈希；再次检查版本标签及最新版本，验证通过后公开草稿并设为 latest。

GitHub 清单默认使用 macOS universal `.app.tar.gz`、Windows NSIS `.exe`、Linux `.AppImage`。生成 MSI、deb 或 rpm 时，也必须提供有效签名及对应格式的清单入口。GitHub 与 GitLab 使用同一更新公钥，但清单内的下载地址分别指向各自平台。

`publish` 任务串行执行。检查失败或任一平台构建失败时，不进入发布；GitLab 发布失败时，不继续公开 GitHub Release。公开仓库的 workflow 日志和 artifacts 可被其他有访问权限的用户读取，不应包含凭据或内部资料。

## 失败与重试

| 情况 | 处理方式 |
| --- | --- |
| 检查或构建失败 | 查看失败日志；代码需要修正时提交改动并使用新版本标签，环境问题可重跑原任务 |
| 自托管发布任务排队 | 检查 runner 是否在线、标签是否匹配，以及服务用户的工具与网络配置 |
| 上传中断或草稿附件不完整 | 原版本未公开时可重试，脚本补齐附件并重新验证 |
| GitLab 已更新、GitHub 发布失败 | 镜像可能已提供新版本；可用同一版本重试，镜像仅复用内容一致的产物，随后继续发布 GitHub |
| 签名校验失败 | 检查 Secret、公钥与产物是否匹配，不公开损坏产物 |
| 版本已公开或低于当前 latest | 不覆盖、不移动标签；增加版本号后发布修正版 |

GitHub Release 与 GitLab 清单不是跨平台原子发布：GitLab 完成后 GitHub 仍可能失败。重试前分别检查两端状态。

需要使用最新工作流手动重试时，在 Actions → Release → Run workflow 选择 `main`，输入已存在的正式版本标签。直接重跑历史运行会继续使用该运行原有的工作流版本。重试依然会检查标签源码、版本和已公开状态，不能绕过发布保护。

## 发布后核验

- 在 GitHub Release 检查安装包、签名和 `latest.json` 是否齐全，清单版本及下载地址是否正确。
- 用未登录的请求读取 GitLab 清单与安装包，确认镜像可访问；具体命令见 [镜像核验](gitlab-update-mirror.md#核验与排障)。
- 在目标平台用真实签名安装包验证检测、下载、安装、重启、版本号与设置保留；分别验证 GitHub 下载和 GitLab 备用下载。

macOS 当前使用 ad-hoc 签名，没有 Apple Developer ID 签名或公证。Tauri 更新签名与操作系统应用签名是两套机制，更新签名校验通过不代表系统首次运行不会提示确认。

## 临时安装包

普通 CI 不发布 Release。需要临时包时，在 Actions → CI → Run workflow 勾选 `bundle`，检查通过后生成三平台 `ci-packages-*` artifacts，保留 7 天；该模式不生成自动更新签名产物。

本地打包可运行 `npm run tauri:build -- --ci --config src-tauri/tauri.unsigned.conf.json`。它不更换生产更新公钥，也不能代替正式签名发布。
