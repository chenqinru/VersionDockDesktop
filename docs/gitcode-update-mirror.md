# GitCode 镜像维护指南

GitHub `chenqinru/VersionDockDesktop` 是源码与主发布仓库。公开 GitCode 仓库 [`chenqinru/VersionDockDesktop-Releases`](https://gitcode.com/chenqinru/VersionDockDesktop-Releases) 只保存版本说明、安装包、更新签名和清单，不同步源码。完整发版步骤见 [发布维护指南](release-publishing.md)。

## 发布配置

| 配置 | 值或用途 |
| --- | --- |
| Actions Variable `GITCODE_RELEASE_REPOSITORY` | `chenqinru/VersionDockDesktop-Releases`，格式必须为 `owner/repo` |
| Actions Variable `GITCODE_RELEASE_BRANCH` | 可选，固定清单所在分支，默认 `main` |
| Actions Secret `GITCODE_RELEASE_TOKEN` | 有项目读写权限的 GitCode PAT，仅供发布步骤使用 |

镜像仓库需初始化默认分支，公开项目、仓库文件和 Release 附件应允许匿名读取。客户端不携带 PAT。令牌创建见 [GitCode 官方说明](https://docs.gitcode.com/docs/help/home/user_center/security_management/user_pat/)，保存至 [GitHub Actions Secrets](https://github.com/chenqinru/VersionDockDesktop/settings/secrets/actions)。项目读写用于 Release、附件和 Contents API；当前发布不通过 Git 推送，不要求额外 Repository 推送权限。

2026-10-07 已核对：GitHub 的 `GITCODE_RELEASE_TOKEN` Secret 存在，`GITCODE_RELEASE_REPOSITORY` 已设置为上述镜像仓库；镜像 `main` 分支和 README 能匿名读取。Secret 存在不等于令牌权限、上传额度或实际更新已验证；首次发布必须完成下文核验。

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

发布 PAT 仅通过请求头发送到 GitCode API，不跟随重定向。安装包 PUT 只使用 API 返回的存储签名与 `x-obs-*` 请求头；允许 GitCode 与华为云 HTTPS 存储域名，禁止转发 PAT。日志不输出完整存储 URL、签名查询参数或密钥。

## 发布 runner

`publish-gitcode` 使用 GitHub 托管 `ubuntu-24.04` runner，下载当前运行的 prepared artifact 并安装 minisign。它与 GitHub Release 独立执行，镜像失败不阻断 GitHub 发布。

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
| GitHub 成功、GitCode 失败 | 仅重跑镜像任务，使用当前运行相同产物 |
