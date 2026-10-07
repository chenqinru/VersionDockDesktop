# VersionDock Desktop

VersionDock Desktop 是独立的 Git / SVN 桌面工作台。源码、GitHub 安装包、更新清单和问题反馈统一保存在公开仓库 `chenqinru/VersionDockDesktop`；公司 GitLab 的 `VersionDockDesktop-Releases` 继续作为安装包镜像。

## 下载与首次安装

**[打开最新版本下载页](https://github.com/chenqinru/VersionDockDesktop/releases/latest)**

| 系统 | 首次安装 | 应用内自动更新使用的文件 |
| --- | --- | --- |
| macOS Apple Silicon / Intel | 下载 `.dmg`，打开后将 App 拖到“应用程序”目录 | universal `.app.tar.gz` |
| Windows x64 | 下载 `-setup.exe` 并运行安装程序 | NSIS `.exe` |
| Linux x64 | 下载 `.AppImage`，添加执行权限后运行；也提供构建生成的 `.deb` / `.rpm` | `.AppImage` |

Linux AppImage 可使用 `chmod +x VersionDock*.AppImage` 添加执行权限。默认推荐 AppImage；生成了签名 MSI、deb 或 rpm 安装包的版本会提供对应格式的应用内更新入口，系统安装工具可能要求管理员确认。

安装程序未获得操作系统认可的代码签名时，macOS 或 Windows 可能要求用户确认允许运行。Tauri 更新包签名校验与操作系统代码签名是不同机制。

## 后续更新

默认在 App 启动时检查更新。发现新版本后点击“下载并安装更新”，根据界面提示重启；也可以在“关于与更新”中手动检查，或在设置中关闭启动检查。

公司和家庭电脑都使用同一更新入口，不需要登录 GitHub；所在网络需要能访问 GitHub Releases 及其文件下载域名。

已安装的旧版本需要手动安装使用新地址的版本一次，后续由 App 自动检测更新。旧 GitHub 下载仓库已删除；GitLab 的 `VersionDockDesktop-Releases` 镜像继续发布。

## 反馈

通过 [Issues](https://github.com/chenqinru/VersionDockDesktop/issues) 反馈问题。请提供 App 版本、操作系统、复现步骤及相关错误信息；提交前移除日志或截图中的公司内部信息和凭据。
