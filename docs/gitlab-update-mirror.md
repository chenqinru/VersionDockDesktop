# GitLab 安装包镜像与自动更新

公开 GitHub 仓库 `chenqinru/VersionDockDesktop` 同时保存源码和安装包，继续作为主更新源；公司 GitLab 16.6.0 的独立公开项目仅存安装包、签名和更新清单，不存源码。

## 待提供的配置

建议项目名 `VersionDockDesktop-Releases`，包名 `versiondock-desktop`。需要确认 GitLab 项目的命名空间、数字 Project ID、公开可见性，以及 GitHub Actions 是否能通过 HTTPS 访问 `https://git.gsdzone.net`。若公司不允许公开项目，需要另设允许匿名读取安装包和清单的发布入口；客户端不内置访问令牌。

在 GitLab 创建空项目并初始化 `main` 分支（可仅创建 README）。启用 Package Registry，允许未登录用户读取；项目中不要放源码或内部资料。

GitHub 项目仓库的 Actions Variables：

| 名称 | 值 |
| --- | --- |
| `GITLAB_RELEASE_PROJECT_ID` | 新项目的数字 ID；未设置时继续使用现有 GitHub 发布链路 |
| `GITLAB_RELEASE_URL` | `https://git.gsdzone.net`，可省略 |
| `GITLAB_RELEASE_PACKAGE` | `versiondock-desktop`，可省略 |
| `GITLAB_RELEASE_BRANCH` | `main`，可省略 |

在 GitHub Actions Secrets 中设置 `GITLAB_RELEASE_TOKEN`：使用仅限该安装包项目的 Project Access Token，授予 `api` scope 和 Maintainer 角色，用于上传 Generic Packages 和提交 `latest.json`。若 GitLab 授权/版本不支持 Project Access Token，可使用专用发布账号的 Token，并仅给予该项目权限。令牌由管理员直接保存到 GitHub Secret，无需发到聊天。Tauri 签名私钥及密码继续保存在流水线 Secrets 中。GitHub 发布使用工作流的 `GITHUB_TOKEN`，不再需要 `RELEASES_TOKEN`。

## 公司发布 runner

`release.yml` 的 `publish` 任务使用 `[self-hosted, linux, x64, gitlab-publish]`，对应已注册的 `versiondock-release`。检查和三平台构建继续使用原有 GitHub 托管 runner，构建完成后由公司服务器下载产物并发布。

runner 服务用户的 PATH 需要包含 `git`、`minisign` 和 `gh`；Node.js 20 由 `actions/setup-node` 配置。发布任务只检查预装工具，不执行 `sudo apt-get`，可以使用普通用户运行。该服务器必须能访问 GitHub 的 Actions、API、构建产物下载地址，以及 GitLab HTTPS API。

提交工作流修改后，在 Actions 的 Release 中选择 `main` 手动运行，`tag` 填要发布的正式版本标签。直接重跑旧的失败任务仍会使用旧工作流的 runner 配置。此调整只迁移发布任务，检查和三平台构建仍受 GitHub 托管 runner 的计费规则约束。

## 地址与发布顺序

版本包地址（将 `ID` 替换为真实项目 ID）：

```text
https://git.gsdzone.net/api/v4/projects/ID/packages/generic/versiondock-desktop/0.1.5/安装包文件名
```

固定清单地址：

```text
https://git.gsdzone.net/api/v4/projects/ID/repository/files/latest.json/raw?ref=main
```

固定清单保存在该独立项目的根目录，通过 Repository Files API 最后提交，避免在 Generic Registry 中重复覆盖 `latest/latest.json` 所造成的版本歧义。每个发布版本的安装包和签名保存在 Generic Registry，清单中的下载地址全部指向 GitLab。

发布流程：三平台构建成功 → 校验 Tauri 签名 → 上传 GitLab 安装包及签名 → 匿名下载并校验每个文件 SHA-256 → 最后提交 GitLab `latest.json` → 发布 GitHub Release。上传和读取发生网络错误、429 或 5xx 时最多尝试 3 次，退避间隔为 1 秒、2 秒。任何文件不完整时都不会更新清单；重跑可复用哈希一致的附件，同版本不同内容和版本回退会被拒绝。提交清单使用 `last_commit_id` 防止并发覆盖。

## 客户端行为与验收

客户端优先检查 GitHub，失败时由原生 updater 尝试 GitLab 备用地址；检查失败最多尝试 3 轮，每个源的请求超时为 15 秒。已从 GitHub 获得清单但下载失败时，会尝试 GitLab 的同版本包，继续使用原有 Tauri 公钥验证签名。每次下载超时为 180 秒，最多尝试 3 次，安装只执行一次；安装失败需用户重试，避免自动重复执行安装器。

启动后检查更新，之后每 15 分钟再次检查，网络恢复时重查。状态栏在欢迎页和工作区都显示检查中、检查失败及可重试入口；选择跳过的版本不主动提示。

配置后需要重新构建发布含镜像地址的客户端；旧客户端只有 GitHub 地址，仍需通过 GitHub 更新或手动安装一次。

验收需使用真正的签名发布包：允许 GitHub 时从 GitHub 更新；阻断 GitHub 时检查和下载都从 GitLab 完成；仅阻断 GitHub 安装包下载时切换 GitLab；中断下载后重试；损坏包拒绝安装；上传中断不提前更新清单。GitLab API 必须由 GitHub runner 和用户电脑同时可达，TLS 证书须可信。

## Windows 问题

Git 工具检测现在除 PATH 外查找 Git for Windows 注册表的 InstallPath、Program Files、用户 Programs/Git 及 Scoop 常见路径；真正的检测与克隆命令共用相同解析逻辑。自定义安装位置通过 Git for Windows 注册表覆盖。对于非 Git for Windows 且没有 PATH 的其他便携发行版，仍需把其 `git.exe` 加入 PATH。

当前 `icon.ico` 已使用 Windows 专用画布，包含 16、24、32、48、64、128、256 七种分辨率，256 像素图标主体为 240×240（93.75%），没有 macOS Dock 的额外缩小和阴影。Windows 原生窗口及安装包使用该 ICO。需要在更新后的真实 Windows 安装包上检查任务栏；旧快捷方式可取消固定后重新固定。

本地静态检查与自动化测试不能替代 Windows 安装、任务栏截图和公司 GitLab 实际上传验证。
