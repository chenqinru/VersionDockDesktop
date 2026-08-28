# Contributing to VersionDock Desktop

Thank you for your interest in contributing to VersionDock Desktop!

## 📋 Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## 🛠️ Getting Started

### Prerequisites

- **Node.js**: `v20` or higher
- **Rust**: `stable` (via rustup)
- **Tauri CLI Prerequisites**: System WebView, C build tools (Xcode CLI on macOS, MSVC on Windows, webkit2gtk on Linux)
- **Git**: Installed and available in PATH
- **SVN** (optional): Installed and available in PATH

### Development Workflow

1. **Clone the repository:**
   ```bash
   git clone https://github.com/<your-username>/VersionDockDesktop.git
   cd VersionDockDesktop
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start Desktop in Development Mode:**
   ```bash
   npm run tauri:dev
   ```

4. **Web-only UI Development:**
   ```bash
   npm run dev
   ```

## 🧪 Comprehensive Quality Checks

Before committing or opening a PR, run the automated quality gate:

```bash
npm run check
```

This single command executes:
- Project version metadata validation
- Independence and boundary checks
- Window configuration checks
- TypeScript type-checking (`tsc --noEmit`)
- ESLint checks (`eslint . --max-warnings=0`)
- Frontend unit tests (`vitest run`)
- Vite production build
- Rust formatting (`cargo fmt --check`)
- Rust Clippy lints (`cargo clippy -- -D warnings`)
- Rust unit and integration tests (`cargo test`)

### Updating IPC Bindings

If you modify Tauri/Rust commands or Specta types, export and verify the bindings:

```bash
npm run bindings
npm run bindings:check
```

## 📝 Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `refactor:`, `perf:`, `docs:`, `test:`, `chore:`.
