# Architecture

```text
React components
  -> VersionDockBridge.request(BridgeCommand)
  -> TauriBridge: requestId / timeout / AbortSignal / event cleanup
  -> bridge_request / bridge_cancel
  -> Rust dispatcher
  -> workspace identity + repository rescan + path validation
  -> bounded read semaphore or per-repository write lock
  -> tokio::process::Command(git|svn, args[], cwd)
```

Rust models derive `serde::Serialize/Deserialize` and `specta::Type`. `npm run bindings` regenerates `src/bindings/generated.ts`; production builds reject stale bindings.

App state uses a versioned `DesktopSettings`/`LayoutState` schema and is atomically persisted under Tauri's application config directory. Window geometry/maximized state is managed by `tauri-plugin-window-state`. File watchers emit scoped `worktree`/`status`/`refs` events, preserve relevant `.git`/`.svn` metadata, use 300 ms per-scope deduplication, and are replaced when the active workspace changes.

Git identity profiles and SVN username mappings use separate atomic files. SVN passwords use the operating-system credential store through `keyring`; supported SVN clients receive passwords only through stdin. File History is queried directly from Git/SVN and is independently cancellable.
