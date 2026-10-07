# GitLab 镜像维护指南

GitHub `chenqinru/VersionDockDesktop` 是主发布仓库。公司 GitLab 的 `VersionDockDesktop-Releases` 仅保存安装包、更新签名和固定更新清单，作为备用下载与更新源。完整发版步骤见 [发布维护指南](release-publishing.md)。

## 当前配置

2026-10-07 已核对 GitHub Actions 配置：`GITLAB_RELEASE_PROJECT_ID` 为 `93`，`GITLAB_RELEASE_TOKEN` Secret 已保存；其余镜像 Variables 未设置，使用脚本默认值。

| Actions Variable | 当前生效值 | 用途 |
| --- | --- | --- |
| `GITLAB_RELEASE_PROJECT_ID` | `93` | 镜像项目的数字 ID |
| `GITLAB_RELEASE_URL` | `https://git.gsdzone.net`（默认） | GitLab HTTPS 根地址 |
| `GITLAB_RELEASE_PACKAGE` | `versiondock-desktop`（默认） | Generic Package 名称 |
| `GITLAB_RELEASE_BRANCH` | `main`（默认） | 固定清单所在分支 |

配置逻辑见 [gitlab-release-config.mjs](../scripts/gitlab-release-config.mjs)。缺少 Project ID 时，工作流仅发布 GitHub；当前 ID 已设置，镜像发布失败会阻止后续 GitHub 发布。

GitLab 项目需要有 `main` 分支并启用 Package Registry，允许匿名读取安装包和仓库内的 `latest.json`。服务器与客户端均需能访问该 HTTPS 地址并信任其 TLS 证书。Secret 已保存不等于令牌权限、匿名下载和真实更新已经验证，发布时仍须按下文核验。

`GITLAB_RELEASE_TOKEN` 用于上传 Generic Packages 和提交仓库文件。可使用仅限该镜像项目、具有 `api` scope 和 Maintainer 角色的 Project Access Token；实例不支持时，使用有对应项目权限的专用账号 Token。轮换令牌时更新 [GitHub Actions Secrets](https://github.com/chenqinru/VersionDockDesktop/settings/secrets/actions)。令牌只用于发布，客户端不携带它。

## 发布 runner

GitLab 镜像任务 `publish-gitlab` 使用 `[self-hosted, linux, x64, gitlab-publish]`。当前 runner 名称为 `versiondock-release`；检查、三平台构建、产物准备和 GitHub 发布使用 GitHub 托管 runner。两端发布独立，GitLab 失败不会阻断 GitHub Release。

runner 服务用户的 `PATH` 需要包含 `git`、`minisign`、`gh` 和 `python3`。Python 标准库用于安全解压 artifact ZIP，无需安装第三方依赖。Node.js 20 由 `actions/setup-node` 配置；镜像任务不通过 `sudo apt-get` 安装工具。请在服务用户环境中检查：

```bash
command -v git
command -v minisign
command -v gh
command -v python3
gh --version
```

该服务器需要同时访问 GitHub Actions、API、构建产物下载地址和公司 GitLab API。任务长期排队时，先检查 runner 在线状态与标签；任务启动后失败，则按失败步骤检查工具、网络或发布权限。

## 清单与安装包地址

固定更新清单保存在项目 `93` 的 `main` 分支根目录：

```text
https://git.gsdzone.net/api/v4/projects/93/repository/files/latest.json/raw?ref=main
```

版本安装包和签名使用 Generic Package Registry，地址格式为：

```text
https://git.gsdzone.net/api/v4/projects/93/packages/generic/versiondock-desktop/<版本号>/<文件名>
```

每个版本的附件使用独立地址。固定清单通过 Repository Files API 最后提交，不在 Generic Registry 中反复覆盖 `latest/latest.json`。清单中的安装包下载地址全部指向 GitLab。

## 发布顺序与重试

[publish-gitlab-release.mjs](../scripts/publish-gitlab-release.mjs) 在三平台产物校验后执行：

1. 核对版本、安装包及更新签名，将清单的下载地址改为 GitLab 地址。
2. 上传不存在的安装包与签名；已有附件必须与本地产物哈希一致。
3. 匿名读取每个附件并验证 SHA-256。
4. 全部附件验证完成后，提交固定 `latest.json` 并验证匿名读取结果。
GitHub Release 从同一份验证完成的产物独立发布，镜像成功与否都不阻断 GitHub 发布。

网络错误、HTTP 429 或 5xx 最多尝试 3 次，重试间隔为 1 秒、2 秒。同版本重跑仅接受相同内容，保留原镜像发布时间；不覆盖不同内容的附件，不回退清单版本。更新已有清单时使用 `last_commit_id` 检查并发修改。

上传中断不会提前更新清单。若 GitLab 已完成而 GitHub 发布失败，镜像可能已经提供新版本；同一版本重试可复用一致的镜像产物。若需修改产物，应增加版本号。

## 客户端行为

正式构建时生成不含凭据的 updater 配置，依次写入 GitHub 主地址和 GitLab 备用地址。仅修改 Actions Variables 不会改变已安装应用的配置，必须构建并安装包含新配置的版本。

启用自动检查后，客户端在启动、每 15 分钟及网络恢复时检查更新；也可在“关于与更新”中手动检查。欢迎页不显示工作区状态栏，进入工作区后可通过更新状态栏查看状态。

检查优先使用 GitHub，失败时尝试 GitLab，最多检查 3 轮，每个源超时为 15 秒。GitHub 安装包下载失败时，客户端会检查 GitLab 的同版本包；版本不一致则要求重新检查，不自动安装其他版本。下载最多尝试 3 次，每次超时为 180 秒；安装只执行一次，失败需用户重试。两端更新包始终使用同一 Tauri 公钥校验签名。

## 核验与排障

先从发布服务器和实际使用网络分别执行无令牌读取：

```bash
curl --fail --location 'https://git.gsdzone.net/api/v4/projects/93/repository/files/latest.json/raw?ref=main'
```

检查清单的版本及 `platforms` 下载地址，再匿名下载一个真实安装包并核对哈希。首次启用镜像或修改配置后，还需使用签名客户端验证：GitHub 可用时正常更新、GitHub 不可达时通过镜像更新、仅 GitHub 下载失败时切换同版本镜像，以及下载中断重试和损坏包拒绝安装。

| 现象 | 优先检查 |
| --- | --- |
| 上传或文件提交返回 401 / 403 | Secret 是否过期，令牌 scope、项目角色及分支写入权限 |
| 匿名读取返回 401 / 403 | 项目、Package Registry 与仓库文件是否允许匿名访问 |
| 返回 404 | 项目 ID、分支、清单或版本附件是否存在；首次发布前清单可能尚未创建 |
| 连接超时或 TLS 失败 | runner / 用户网络是否能访问 GitLab，证书链是否可信 |
| 同版本哈希不一致或版本回退被拒绝 | 两端版本与本地产物是否匹配；需要修改产物时发新版本 |
| 镜像缺少待安装版本 | 确认镜像发布结果并重新检查更新，不绕过版本及签名校验 |
