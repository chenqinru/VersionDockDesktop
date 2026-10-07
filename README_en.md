<p align="center">
  <img src="./public/icons/versiondock-logo-dark.png" alt="VersionDock Desktop" width="128" height="128">
</p>

<h1 align="center">VersionDock Desktop</h1>

<p align="center">Manage Git, SVN, and multiple projects in one standalone desktop application.</p>

<p align="center">
  <a href="https://github.com/chenqinru/VersionDockDesktop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/chenqinru/VersionDockDesktop/ci.yml?branch=main&amp;label=CI&amp;logo=github" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0"></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong> ·
  <a href="https://github.com/chenqinru/VersionDockDesktop/releases">Download</a> ·
  <a href="https://github.com/chenqinru/VersionDockDesktop/issues">Issues</a>
</p>

VersionDock Desktop brings working changes, file comparisons, commits, remote synchronization, history, and conflict resolution into one workspace. Projects can contain multiple directories, nested repositories, and a mix of Git repositories and SVN working copies.

Built with Tauri 2, Rust, React, and TypeScript, it supports macOS, Windows, and Linux. Using the application does not require VS Code or Node.js; repository operations use your local Git / SVN command-line tools. AI assistance is optional and configured separately.

## Installation

Choose a package for your system from [GitHub Releases](https://github.com/chenqinru/VersionDockDesktop/releases):

| System | Recommended installation |
| --- | --- |
| macOS Apple Silicon / Intel | Open the universal `.dmg` and drag the application into Applications |
| Windows x64 | Run the `-setup.exe` installer; releases may also provide `.msi` |
| Linux x64 | Make the `.AppImage` executable and run it; releases may also provide `.deb` / `.rpm` |

For AppImage, use `chmod +x filename.AppImage`. macOS builds currently use ad-hoc signing without Apple Developer ID signing or notarization. If macOS blocks the first launch, verify the source and allow the application through Privacy & Security.

Install the tools required for your repositories:

- **Git repositories**: Git 2.23 or newer.
- **SVN working copies**: SVN 1.9 or newer; password authentication using the application's saved credentials requires SVN 1.10 or newer.

Adding tools to `PATH` is recommended. On macOS, the application also checks common Homebrew and MacPorts paths. On Windows, it checks Git for Windows registry entries and common installation directories. Unavailable operations show a reason when tools are missing or do not meet version requirements.

### Updates

Automatic checks run at startup, every 15 minutes, and when connectivity returns. You can also check manually through About & Updates or disable automatic checks in settings. Follow the prompts to download, install, and restart when an update is available.

Release builds use GitHub as the primary source and a GitCode mirror for fallback downloads. Installation and updates do not require a GitHub login or a mirror token. Updates use a universal `.app.tar.gz` on macOS, an NSIS `.exe` on Windows, and an `.AppImage` on Linux; releases may also provide signed MSI, deb, or rpm update entries.

Tauri verifies update signatures separately from operating-system application signing. Clients still using the old GitHub download repository must install a version with the new update address manually once; subsequent updates can use the application.

## Getting started

1. Open a project directory from the welcome screen, clone a remote Git repository, or initialize a local Git repository.
2. Select a repository in the workspace. The application scans project directories for Git repositories and SVN working copies.
3. Select files in the changes list, inspect their differences, and organize a commit. Git supports staging and unstaging; SVN supports committing selected files.
4. Use the synchronization panel for Fetch / Pull / Push or SVN Update, and browse commits, revisions, and file changes in history.
5. When conflicts occur, open the merge workspace, inspect the three versions, edit the result, and finish resolving the conflict.

Projects use tabs and can be opened in multiple windows. Recent projects are available from the welcome screen. The interface supports Simplified Chinese and English, light and dark themes, compact and comfortable layouts, and adjustable fonts and panel sizes.

## Features

| Area | Capabilities |
| --- | --- |
| Workspaces and changes | Multiple directories, nested repository discovery, mixed Git / SVN workspaces, tree and flat file lists, changelists, batch operations |
| Commits and synchronization | Git staging, Commit, Amend, Commit & Push, Fetch / Pull / Push; selected-file commits and Update for SVN |
| Differences and history | Inline / side-by-side diffs, syntax highlighting, commit graphs, author / date / text / path filters, file history, branch comparison |
| Conflicts | Git / SVN conflict lists, three-way merge editing, content checks before saving, staging or marking resolved files |
| Git tools | Branches and tags, Stash, local patch shelves, Worktree, Submodule, Subtree, remotes, unpushed commit editing |
| Identity and accounts | Git commit identities, SVN accounts, GitHub / GitLab / Gitee accounts, remote repository browsing and creation / publishing |
| Operations and protection | Progress, cancellation, notifications and logs; protected branch confirmation, `--force-with-lease`, large-file and invalid-filename warnings |

Available operations depend on the repository type, tool version, and current state. Git and SVN do not expose the same operations.

### AI assistance

Configured AI can generate commit messages, explain commits, review changes, propose conflict resolutions, and split changes into multiple commits. For Git, it can also propose reorganizing unpushed commits. Conflict resolutions and commit plans are shown for review before you confirm applying them.

Choose an execution mode in AI settings:

- **API provider**: OpenAI, Claude, Gemini, or a custom compatible endpoint. OpenAI and custom endpoints support Chat Completions or Responses.
- **Agent CLI**: An installed and configured Claude, Codex, Antigravity, or OpenCode tool, with executable detection, model selection, and timeout settings.

API mode requires a model, endpoint, and key. CLI mode requires the corresponding tool and its authentication environment. Task-specific commit, diff, or conflict context is passed to the selected API / CLI. API keys are saved in system secure storage; prompts can be edited globally or per workspace.

### Hosting platforms and credentials

GitHub supports Personal Access Tokens and OAuth Device Flow when enabled in the build. GitLab supports Tokens and self-hosted HTTPS instances; Gitee uses Tokens. Connected accounts can browse repositories, select a repository to clone, and create a remote repository to publish a local Git project.

Platform accounts authorize platform API calls. Git Fetch / Pull / Push continue to use your local Git SSH, HTTPS, and credential configuration. Platform Tokens, SVN passwords, and AI API keys use system secure storage. Regular settings and workspace state use the application's configuration directory. Online author avatars can be disabled in settings.

## Development

### Requirements

| Tool | Requirement |
| --- | --- |
| Node.js | 20 or newer, with npm |
| Rust | 1.99.0, pinned in `rust-toolchain.toml`, including rustfmt and Clippy |
| Native build dependencies | macOS: Xcode Command Line Tools; Windows: MSVC Build Tools and WebView2; Linux: WebKitGTK 4.1, AppIndicator, and other Tauri dependencies |
| Git / SVN | Real command-line tools for repository operations and integration tests, with the versions listed above |
| minisign | Used by release tests and update signature verification; install with `brew install minisign` on macOS or `sudo apt-get install minisign` on Ubuntu |
| curl | Used by GitCode attachment uploads and release regression tests; included with macOS, or install with `sudo apt-get install curl` on Ubuntu |

See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for platform dependencies and the [CI workflow](.github/workflows/ci.yml) for installation steps used in CI.

```bash
git clone https://github.com/chenqinru/VersionDockDesktop.git
cd VersionDockDesktop
npm ci
npm run tauri:dev
```

Development mode enables Vite hot reload and rebuilds the application when Rust sources change. When working on the application's own repository, use `npm run tauri:dev -- --stable` to disable watching and avoid reloads caused by checkout and similar operations.

For frontend-only work, run `npm run browser:dev`. This mode uses a development Bridge to demonstrate the interface; verify real repository operations in the Tauri application.

GitHub OAuth Device Flow requires `VERSIONDOCK_GITHUB_CLIENT_ID` at build time. Without it, GitHub PAT authentication, GitLab, and Gitee remain available. Debug / test builds can set `VERSIONDOCK_ALLOW_INSECURE_PROVIDER_HOSTS=1` to test HTTP GitLab instances; HTTPS certificate verification remains enabled.

Windows SVN clients that convert command-line arguments to an ANSI code page can fail with paths such as Chinese filenames. CI builds and verifies a client containing the Apache Subversion r1935602 Unicode argv fix. See [setup-windows-svn.ps1](scripts/setup-windows-svn.ps1).

### Checks and builds

```bash
# Complete checks: metadata, frontend, build, Rust, and real Git/SVN tests
npm run check

# Check frontend or Rust separately
npm run check:frontend
npm run check:rust

# Regenerate and verify frontend bindings after changing Rust IPC types
npm run bindings
npm run bindings:check

# Package for the host system without producing signed update artifacts
npm run tauri:build -- --ci --config src-tauri/tauri.unsigned.conf.json
```

Local packaging uses the host architecture by default. A macOS universal build also requires the `aarch64-apple-darwin` and `x86_64-apple-darwin` Rust targets and `--target universal-apple-darwin`. The unsigned configuration only disables update artifact generation; operating-system application signing still follows the platform configuration.

Stable version tags trigger release workflows. GitHub Releases are published only after all three platform builds, checks, and update signature verification succeed; a GitCode package mirror provides fallback downloads. See the [publishing guide](docs/release-publishing.md) and [GitCode mirror guide](docs/gitcode-update-mirror.md).

### Project layout

```text
src/          React UI, state, platform Bridge, and frontend tests
src-tauri/    Rust backend, Git/SVN, AI, credentials, and native configuration
public/       Logos, editor icons, translations, and the tab drag preview page
scripts/      Development helpers, binding checks, packaging, and publishing
.github/      CI, cache warmup, platform releases, and issue templates
docs/         Publishing and GitCode mirror maintenance guides
```

## Contributing

Report problems and feature requests through [Issues](https://github.com/chenqinru/VersionDockDesktop/issues). Include the application version, operating system, Git / SVN versions, reproduction steps, and relevant errors. Remove credentials and private repository details from logs before sharing them. See [CONTRIBUTING.md](CONTRIBUTING.md) for code contributions and [SECURITY.md](SECURITY.md) for vulnerability reports.

For a similar workflow inside VS Code, see the separate [VersionDock extension](https://github.com/chenqinru/VersionDock). Desktop is built and runs as an independent application.

## License

Licensed under [GPL-3.0-only](LICENSE).
