<p align="center">
  <img src="public/icon.png" alt="VersionDock Desktop logo" width="128">
</p>

<h1 align="center">VersionDock Desktop</h1>

<p align="center">
  <strong>A modern, standalone Git and SVN desktop workbench built with Tauri 2, Rust, and React 18.</strong>
</p>

<p align="center">
  <a href="https://github.com/chenqinru/VersionDockDesktop/actions/workflows/ci.yml"><img alt="CI Status" src="https://img.shields.io/github/actions/workflow/status/chenqinru/VersionDockDesktop/ci.yml?branch=main&label=CI&logo=github"></a>
  <a href="https://github.com/chenqinru/VersionDockDesktop/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/chenqinru/VersionDockDesktop?color=green"></a>
  <a href="https://v2.tauri.app/"><img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.0-24C8D8?logo=tauri"></a>
  <a href="https://www.rust-lang.org/"><img alt="Rust" src="https://img.shields.io/badge/Rust-1.78%2B-DEA584?logo=rust"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-GPL--3.0-red"></a>
</p>

<p align="center">
  <a href="README.md"><strong>简体中文</strong></a> | <a href="README_en.md"><strong>English</strong></a>
</p>

VersionDock Desktop is a standalone, lightweight Git & SVN desktop workbench. Built with Tauri 2, Rust, and React, it does not require VS Code and carries zero Node.js runtime overhead in production releases.

---

## 🌐 Ecosystem

Looking for an in-editor VS Code extension instead?

👉 Check out [**VersionDock (VS Code Extension)**](https://github.com/chenqinru/VersionDock) — an IDE-grade VCS workbench embedded right in VS Code.

---

## ✨ Features

- **Multi-Root Workspaces**: Seamlessly handles multi-root workspaces, mixed Git/SVN projects, and deeply nested repositories.
- **Full Git Workflow**: Status, Diffs, stage/unstage, commit/amend, commit & push, fetch/pull/push, log graph, and branch/tag operations.
- **Deep SVN Integration**: Status, diffs, auto-add/delete on commit, update, and revision history.
- **3-Way Merge Editor**: Visual side-by-side conflict resolution with fingerprint collision safeguards.
- **Power Tools**: Stash, local patch Shelving, named Changelists, managed Worktrees, Branch Comparison, and Remote Management.
- **Secure Identity & Credentials**: Multi-profile Git identity management and OS keychain-backed SVN authentication.
- **Refined Desktop UX**: Frameless design with platform-native controls, light/dark themes, i18n, and persistent layout state.

---

## 🛠️ Development

### Requirements
- **Node.js**: `20+`
- **Rust**: `stable` (1.78+)
- **System WebView**: Pre-installed on macOS, Windows, and modern Linux distributions.
- **Git**: 2.23+ in system PATH.
- **SVN**: 1.9+ in system PATH; 1.10+ is required for secure password-stdin integration.

```bash
# Install dependencies
npm install

# Run desktop development mode (Tauri + Vite)
npm run tauri:dev
```

---

## 🧪 Testing & Quality Gates

```bash
npm run check
```

Runs complete automated verification including metadata validation, boundary checks, TypeScript, ESLint, Vitest, Vite build, Rust fmt, Clippy, and Cargo tests.

---

## 📦 Building Releases

```bash
npm run tauri:build
```

- **macOS**: Universal `.dmg` / `.app` (Apple Silicon & Intel)
- **Windows**: NSIS / MSI installers
- **Linux**: AppImage, `.deb`, `.rpm`

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for details.

- 🐛 [Report a Bug](https://github.com/chenqinru/VersionDockDesktop/issues/new?template=bug_report.yml)
- 💡 [Request a Feature](https://github.com/chenqinru/VersionDockDesktop/issues/new?template=feature_request.yml)
- 🔒 [Security Policy](SECURITY.md)

---

## 📄 License

Distributed under the [GNU General Public License v3.0](LICENSE).
