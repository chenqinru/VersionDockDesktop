# GitCode 镜像维护指南

GitHub `chenqinru/VersionDockDesktop` 是源码与主发布仓库。公开 GitCode 仓库 [`chenqinru/VersionDockDesktop-Releases`](https://gitcode.com/chenqinru/VersionDockDesktop-Releases) 只保存版本说明、安装包、更新签名和清单，不同步源码。完整发版步骤见 [发布维护指南](release-publishing.md)。

## 发布配置

| 配置 | 值或用途 |
| --- | --- |
| Actions Variable `GITCODE_RELEASE_REPOSITORY` | `chenqinru/VersionDockDesktop-Releases`，格式必须为 `owner/repo` |
| Actions Variable `GITCODE_RELEASE_BRANCH` | 可选，固定清单所在分支，默认 `main` |
| Actions Secret `GITCODE_RELEASE_TOKEN` | 有项目读写权限的 GitCode PAT，仅供发布步骤使用 |

镜像仓库需初始化默认分支，公开项目、仓库文件和 Release 附件应允许匿名读取。客户端不携带 PAT。令牌创建见 [GitCode 官方说明](https://docs.gitcode.com/docs/help/home/user_center/security_management/user_pat/)，保存至 [GitHub Actions Secrets](https://github.com/chenqinru/VersionDockDesktop/settings/secrets/actions)。项目读写用于 Release、附件和 Contents API；当前发布不通过 Git 推送，不要求额外 Repository 推送权限。

2026-10-07 已核对：GitHub 的 `GITCODE_RELEASE_TOKEN` Secret 存在，`GITCODE_RELEASE_REPOSITORY` 已设置为上述镜像仓库；`0.1.8` 已由 `versiondock-release` runner 成功发布，14 个附件齐全，正式 Release 与固定清单均为该版本，清单可匿名读取且下载地址指向 GitCode。客户端实际下载、安装和重启仍需按下文验证。

缺少 `GITCODE_RELEASE_REPOSITORY` 时只构建 GitHub 更新地址并跳过镜像任务。配置存在时，由 [gitcode-release-config.mjs](../scripts/gitcode-release-config.mjs) 生成不含凭据的构建配置，依次写入 GitHub 主地址和 GitCode 备用地址。

## 地址与发布顺序

固定更新清单：

```text
https://api.gitcode.com/api/v5/repos/chenqinru/VersionDockDesktop-Releases/raw/latest.json?ref=main
```

版本附件，包括安装包、签名和对应版本的 `latest.json`：

```text
https://gitcode.com/chenqinru/VersionDockDesktop-Releases/releases/download/v<版本号>/<文件名>
```

[publish-gitcode-release.mjs](../scripts/publish-gitcode-release.mjs) 使用 GitCode v5 API 执行：

1. 校验本地版本、更新清单、发布说明与 minisign 签名，拒绝版本回退和已发布版本内容变更。
2. 检查镜像分支，创建或复用 `vX.Y.Z` 的预发布 Release。标签指向镜像分支，不代表源码提交；源码身份由 GitHub 版本标签和 prepared artifact 保证。
3. 为缺失附件获取上传 URL，以新的文件流执行 PUT；随后匿名完整读取并校验 SHA-256。已有同名附件必须与本地产物一致，不覆盖不同内容。
4. 将下载地址改为 GitCode，上传并验证版本 `latest.json`，保持原 GitHub 清单不变。同版本重跑复用已发布清单的时间，避免重试时变化。
5. 再次检查固定清单版本，确认无较新版本后将 Release 设为正式 latest，最后通过 Contents API 更新分支根目录的固定 `latest.json`。更新已有文件必须提供读取时的 Blob SHA，拒绝并发覆盖。
6. 匿名读取固定清单并验证完整哈希。

固定清单仅在附件验证完成后更新。预发布 Release 的附件可能已经可见，但不会提前向自动更新客户端提供半成品。若正式 Release 已完成而固定清单提交失败，重跑原镜像任务可继续完成；失败不能通过覆盖安装包或降低版本解决。

匿名读取、网络错误、HTTP 429 和 5xx 最多尝试三次，间隔为 1 秒、2 秒。上传失败先读取远程文件确认是否已成功，再申请新 URL 重试，避免直接重复带回调的 PUT。创建、公开 Release 和提交清单不盲目重放；响应丢失时读取实际结果。401、403 等权限错误不自动重试。

发布 PAT 仅通过请求头发送到 GitCode API，不跟随重定向。安装包 PUT 使用 `curl --http1.1` 直接上传文件，只使用 API 返回的存储签名与 `x-obs-*` 请求头；允许 GitCode 与华为云 HTTPS 存储域名，禁止转发 PAT。签名 URL 与请求头通过 curl 标准输入传递，不进入进程参数；禁止读取用户 curl 配置和跟随上传重定向，并清空 `Expect` 头，避免额外的 100-continue 握手。连接超时为 30 秒，单次上传总超时为 180 秒。失败日志只记录文件名、大小、目标主机、HTTP 状态、curl 退出码、耗时和发送/接收字节数，不输出完整存储 URL、签名查询参数或密钥。

## 发布 runner

`publish-gitcode` 和 **Retry GitCode mirror** 使用 `[self-hosted, linux, x64, gitcode-publish]`，复用原有 `versiondock-release` runner。服务器只下载已经构建好的安装包、校验签名和发布 GitCode；源码检查、三平台构建与 GitHub Release 继续使用 GitHub 托管 runner。两端独立执行，镜像任务排队或失败不阻断 GitHub 发布。

采用国内 runner 是因为托管 runner 在上传 `0.1.8` 时成功上传六个小签名，却连续三次在安装包发送约 2.4～2.7 MB 后达到 180 秒超时。更换上传网络后，`0.1.8` 的完整镜像发布与远程哈希核验已通过。

服务器服务用户的 `PATH` 需包含 `minisign` 和 `curl`；补发工作流还需 `gh` 从 GitHub 获取已有 Release。Node.js 20 由 `actions/setup-node` 配置。工作流只检查工具，不调用 `sudo apt-get` 安装。缺少工具时应在服务器上为 runner 服务用户准备：

```bash
command -v minisign
command -v curl
command -v gh
```

服务器必须能访问 GitHub Actions、API、artifacts 和 Releases 下载地址，以及 GitCode API、附件上传和下载地址。GitHub 下载可沿用原有代理；发布步骤设置 `NO_PROXY` 和 `no_proxy`，让 `gitcode.com`、其子域和 `myhuaweicloud.com` 子域直接访问，避免安装包上传再绕经境外代理。代理环境仅供传输使用，不关闭 TLS 校验。

runner 在 GitHub 仓库中的自定义标签需为 `gitcode-publish`，无需重新注册或安装 GitLab。它与两条工作流共用一个镜像并发组，防止同时发布时改写固定清单。

## 使用修正后的脚本补发镜像

普通 Release 工作流固定使用版本标签中的脚本。直接重跑旧失败任务仍执行旧脚本；修复上传脚本后，使用 [Retry GitCode mirror 工作流](../.github/workflows/gitcode-mirror.yml) 补发已有版本：

1. 将修复推送到 `main`，在 GitHub Actions 打开 **Retry GitCode mirror**，选择 `main`。
2. 输入 GitHub 已公开的正式版本号，例如 `0.1.8`，不带 `v`。
3. 工作流使用当前修复版本的镜像工具，读取对应 GitHub Release，下载安装包与签名，逐个比较 GitHub 提供的 SHA-256，再复用原版清单中的更新说明。
4. 从原版本标签读取更新公钥，调用同一镜像脚本上传并核验 GitCode 安装包与固定清单。

该工作流只补发 GitCode 镜像，不重建安装包，不创建或修改 GitHub Release、版本标签或更新密钥。与普通镜像发布共享并发组，同版本附件仍必须匹配已有内容。GitHub Release 必须已经公开且非预发布，全部附件需有有效的服务端 SHA-256。

## 客户端行为

检查优先使用 GitHub，失败时尝试 GitCode，最多检查三轮，每个源超时 15 秒。GitHub 安装包下载失败时，客户端检查 GitCode 的同版本包；版本不一致则要求重新检查，不自动安装其他版本。下载最多尝试三次，每次超时 180 秒；安装只执行一次，失败后需用户重试。两端更新包使用同一 Tauri 公钥校验签名。

当前通过配置替换更新源，复用现有客户端和 Rust 镜像检查，不新增另一套更新状态。更改 Actions Variables 不会改变已经构建的客户端；包含新配置的标签才能构建 GitCode 更新入口。

## 首次发布核验

```bash
curl --fail --location 'https://api.gitcode.com/api/v5/repos/chenqinru/VersionDockDesktop-Releases/raw/latest.json?ref=main'
```

首次发布前清单不存在，404 是预期状态。发布后检查清单版本与所有平台地址，匿名完整下载安装包并比较 SHA-256。在真实 Tauri 客户端验证 GitHub 正常更新、GitHub 不可达时镜像更新、主包下载失败后的同版本备用下载，以及损坏包拒绝安装。

本地 HTTP 回归覆盖签名上传、内容核验、响应丢失、部分失败重跑、版本回退与并发修改。它不能替代 GitCode 实际上传额度、PAT 权限、CDN 下载和桌面安装验证。

| 现象 | 排查方向 |
| --- | --- |
| API 401 / 403 | PAT 到期、项目读写权限、镜像项目是否可访问 |
| 匿名下载 401 / 403 | 仓库公开状态、附件访问权限 |
| 初次读取清单 404 | 尚未完成首次镜像发布；已发布时检查仓库路径与分支 |
| 文件更新冲突 | Blob SHA 对应文件已变化，重查版本；不要绕过并发保护 |
| 已有同名附件哈希不同 | 原版本不能覆盖，修改产物需发布新版本 |
| 上传地址校验失败 | 核对 GitCode 当前存储域名及 API 文档，再决定是否扩展允许域名 |
| 上传 curl 28 | 连接或传输超时，根据主机和耗时检查网络；30 秒附近为连接阶段，180 秒附近为总超时 |
| HTTP 100 后超时 | 100 只是中间响应；比较已发送字节数与文件大小，判断文件传输是否完成。若全量发送后仍超时，需检查存储服务响应或回调，不按上传成功处理 |
| 上传 curl 6 / 7 / 60 | 分别检查 DNS、连接和证书链；不关闭 TLS 校验绕过证书错误 |
| GitHub 成功、GitCode 失败 | 原脚本不变时仅重跑镜像任务；脚本已修复时使用 Retry GitCode mirror 补发原版本 |
