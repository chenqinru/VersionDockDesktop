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

App state is atomically persisted under Tauri's application config directory. Window geometry/maximized state is managed by `tauri-plugin-window-state`. File watchers emit only `versiondock://event`, use 300 ms deduplication, and are replaced when the active workspace changes.
