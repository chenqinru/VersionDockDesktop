use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, RwLock, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::models::{AppStateSnapshot, DesktopError, WorkspaceDescriptor};

pub struct AppState {
    pub config_dir: PathBuf,
    pub app: RwLock<AppStateSnapshot>,
    pub cancellations: Mutex<HashMap<String, CancellationToken>>,
    pub read_limit: Semaphore,
    pub write_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    watchers: std::sync::Mutex<Vec<RecommendedWatcher>>,
    generation: AtomicU32,
}

impl AppState {
    pub fn load(config_dir: PathBuf) -> Self {
        let state_path = config_dir.join("state.json");
        let mut app: AppStateSnapshot = std::fs::read(&state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let mut arguments = std::env::args_os().skip(1);
        while let Some(argument) = arguments.next() {
            if argument == "--workspace" {
                if let Some(path) = arguments.next().and_then(|value| value.into_string().ok()) {
                    if let Ok(root) = canonical_directory(&path) {
                        let paths = vec![root.to_string_lossy().into_owned()];
                        let descriptor = WorkspaceDescriptor {
                            id: workspace_id(&paths),
                            name: root
                                .file_name()
                                .and_then(|value| value.to_str())
                                .unwrap_or("Workspace")
                                .to_string(),
                            paths,
                            last_opened_at: chrono::Utc::now().to_rfc3339(),
                            available: true,
                        };
                        app.recent_workspaces
                            .retain(|item| item.id != descriptor.id);
                        app.recent_workspaces.insert(0, descriptor.clone());
                        app.recent_workspaces.truncate(10);
                        app.last_workspace_id = Some(descriptor.id);
                    }
                }
            }
        }
        Self {
            config_dir,
            app: RwLock::new(app),
            cancellations: Mutex::new(HashMap::new()),
            read_limit: Semaphore::new(4),
            write_locks: Mutex::new(HashMap::new()),
            watchers: std::sync::Mutex::new(Vec::new()),
            generation: AtomicU32::new(1),
        }
    }

    pub fn next_generation(&self) -> u32 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub async fn register_request(&self, request_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.cancellations
            .lock()
            .await
            .insert(request_id.to_string(), token.clone());
        token
    }

    pub async fn finish_request(&self, request_id: &str) {
        self.cancellations.lock().await.remove(request_id);
    }

    pub async fn cancel(&self, request_id: &str) -> bool {
        if let Some(token) = self.cancellations.lock().await.get(request_id) {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub async fn write_lock(&self, repo_id: &str) -> Arc<Mutex<()>> {
        self.write_locks
            .lock()
            .await
            .entry(repo_id.to_string())
            .or_default()
            .clone()
    }

    pub async fn save_app_state(&self, snapshot: AppStateSnapshot) -> Result<(), DesktopError> {
        *self.app.write().await = snapshot.clone();
        std::fs::create_dir_all(&self.config_dir).map_err(io_error)?;
        let target = self.config_dir.join("state.json");
        let temporary = self.config_dir.join("state.json.tmp");
        let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|error| {
            DesktopError::new("STATE_SERIALIZE_FAILED", error.to_string(), true)
        })?;
        std::fs::write(&temporary, bytes).map_err(io_error)?;
        std::fs::rename(&temporary, &target).map_err(io_error)
    }

    pub async fn workspace(&self, workspace_id: &str) -> Result<WorkspaceDescriptor, DesktopError> {
        self.app
            .read()
            .await
            .recent_workspaces
            .iter()
            .find(|item| item.id == workspace_id)
            .cloned()
            .ok_or_else(|| {
                DesktopError::new(
                    "WORKSPACE_NOT_FOUND",
                    "The workspace is no longer available",
                    true,
                )
            })
    }

    pub async fn upsert_workspace(
        &self,
        workspace: WorkspaceDescriptor,
    ) -> Result<(), DesktopError> {
        let mut snapshot = self.app.read().await.clone();
        snapshot
            .recent_workspaces
            .retain(|item| item.id != workspace.id);
        snapshot.recent_workspaces.insert(0, workspace.clone());
        snapshot.recent_workspaces.truncate(10);
        snapshot.last_workspace_id = Some(workspace.id);
        self.save_app_state(snapshot).await
    }

    pub fn watch_workspace(
        &self,
        workspace: &WorkspaceDescriptor,
        app: AppHandle,
    ) -> Result<(), DesktopError> {
        let mut watchers = self.watchers.lock().map_err(|_| {
            DesktopError::new(
                "WATCHER_LOCK_FAILED",
                "Unable to update file watchers",
                true,
            )
        })?;
        watchers.clear();
        let last_emit = Arc::new(std::sync::Mutex::new(
            std::time::Instant::now() - std::time::Duration::from_secs(1),
        ));
        for root in &workspace.paths {
            let workspace_id = workspace.id.clone();
            let last_emit = last_emit.clone();
            let app = app.clone();
            let mut watcher =
                notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                    let Ok(event) = result else {
                        return;
                    };
                    if event.paths.iter().all(|path| {
                        path.components().any(|part| {
                            part.as_os_str() == "target"
                                || part.as_os_str() == "node_modules"
                                || part.as_os_str() == "dist"
                                || part.as_os_str() == ".git"
                                || part.as_os_str() == ".svn"
                        })
                    }) {
                        return;
                    }
                    let Ok(mut last) = last_emit.lock() else {
                        return;
                    };
                    if last.elapsed() < std::time::Duration::from_millis(300) {
                        return;
                    }
                    *last = std::time::Instant::now();
                    let _ = app.emit(
                        "versiondock://event",
                        crate::models::WorkspaceEvent {
                            workspace_id: workspace_id.clone(),
                            generation: 0,
                            reason: "file-change".into(),
                        },
                    );
                })
                .map_err(|error| {
                    DesktopError::new("WATCHER_START_FAILED", error.to_string(), true)
                })?;
            watcher
                .watch(Path::new(root), RecursiveMode::Recursive)
                .map_err(|error| {
                    DesktopError::new("WATCHER_START_FAILED", error.to_string(), true)
                })?;
            watchers.push(watcher);
        }
        Ok(())
    }
}

pub fn workspace_id(paths: &[String]) -> String {
    let mut normalized = paths.to_vec();
    normalized.sort();
    let hash = Sha256::digest(normalized.join("\0").as_bytes());
    format!("ws-{}", hex::encode(&hash[..8]))
}

pub fn canonical_directory(value: &str) -> Result<PathBuf, DesktopError> {
    if value.contains('\0') {
        return Err(DesktopError::new(
            "INVALID_PATH",
            "Path contains a NUL byte",
            false,
        ));
    }
    let path = std::fs::canonicalize(value).map_err(|_| {
        DesktopError::new(
            "PATH_NOT_FOUND",
            format!("Path is not available: {value}"),
            true,
        )
    })?;
    if !path.is_dir() {
        return Err(DesktopError::new(
            "NOT_A_DIRECTORY",
            format!("Not a directory: {value}"),
            true,
        ));
    }
    Ok(path)
}

pub fn safe_relative(
    root: &Path,
    relative: &str,
    include_leaf: bool,
) -> Result<PathBuf, DesktopError> {
    if relative.contains('\0') || Path::new(relative).is_absolute() {
        return Err(outside_error(relative));
    }
    let mut target = root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            std::path::Component::Normal(value) => target.push(value),
            std::path::Component::CurDir => {}
            _ => return Err(outside_error(relative)),
        }
    }
    let boundary = if include_leaf {
        target.as_path()
    } else {
        target.parent().unwrap_or(root)
    };
    let mut cursor = root.to_path_buf();
    if let Ok(suffix) = boundary.strip_prefix(root) {
        for component in suffix.components() {
            cursor.push(component);
            match std::fs::symlink_metadata(&cursor) {
                Ok(meta) if meta.file_type().is_symlink() => return Err(outside_error(relative)),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) => return Err(outside_error(relative)),
            }
        }
    }
    Ok(target)
}

fn outside_error(path: &str) -> DesktopError {
    DesktopError::new(
        "PATH_OUTSIDE_WORKSPACE",
        format!("Path is outside the repository: {path}"),
        false,
    )
}

fn io_error(error: std::io::Error) -> DesktopError {
    DesktopError::new("STATE_IO_FAILED", error.to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_parent_and_absolute_paths() {
        let root = tempdir().unwrap();
        assert!(safe_relative(root.path(), "../escape", false).is_err());
        assert!(safe_relative(root.path(), "/tmp/escape", false).is_err());
        assert!(safe_relative(root.path(), "hello world/中文.txt", false).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_ancestors() {
        use std::os::unix::fs::symlink;
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        symlink(outside.path(), root.path().join("link")).unwrap();
        assert!(safe_relative(root.path(), "link/file.txt", false).is_err());
    }
}
