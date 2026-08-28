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

use crate::models::{
    AppStateSnapshot, DesktopError, DesktopSettings, LanguagePreference, LayoutState,
    ThemePreference, UiFontSizePreference, WorkspaceDescriptor,
};

pub struct AppState {
    pub config_dir: PathBuf,
    pub app: RwLock<AppStateSnapshot>,
    pub cancellations: Mutex<HashMap<String, CancellationToken>>,
    pub read_limit: Semaphore,
    pub write_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub window_workspaces: std::sync::Mutex<HashMap<String, Vec<Vec<String>>>>,
    pub window_bounds: std::sync::Mutex<HashMap<String, (f64, f64, f64, f64)>>,
    watchers: std::sync::Mutex<HashMap<String, Vec<RecommendedWatcher>>>,
    generation: AtomicU32,
}

impl AppState {
    pub fn load(config_dir: PathBuf) -> Self {
        let state_path = config_dir.join("state.json");
        let mut app: AppStateSnapshot = std::fs::read(&state_path)
            .ok()
            .and_then(|bytes| migrate_state(&bytes))
            .unwrap_or_default();
        app.schema_version = 3;
        app.settings = app.settings.normalize();
        if app.layout.stash_view_mode != "list" && app.layout.stash_view_mode != "tree" {
            app.layout.stash_view_mode = "tree".into();
        }
        if app.layout.file_view_mode != "list" && app.layout.file_view_mode != "tree" {
            app.layout.file_view_mode = "tree".into();
        }
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
                        app.last_workspace_id = Some(descriptor.id.clone());
                        app.active_workspace_id = Some(descriptor.id.clone());
                        if !app.open_workspace_ids.contains(&descriptor.id) {
                            app.open_workspace_ids.insert(0, descriptor.id);
                        }
                    }
                }
            }
        }
        if app.open_workspace_ids.is_empty() {
            if let Some(last_id) = &app.last_workspace_id {
                app.open_workspace_ids.push(last_id.clone());
            }
        }
        if app.active_workspace_id.is_none() {
            app.active_workspace_id = app.last_workspace_id.clone();
        }
        Self {
            config_dir,
            app: RwLock::new(app),
            cancellations: Mutex::new(HashMap::new()),
            read_limit: Semaphore::new(4),
            write_locks: Mutex::new(HashMap::new()),
            window_workspaces: std::sync::Mutex::new(HashMap::new()),
            window_bounds: std::sync::Mutex::new(HashMap::new()),
            watchers: std::sync::Mutex::new(HashMap::new()),
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
        settings: &DesktopSettings,
        app: AppHandle,
    ) -> Result<(), DesktopError> {
        let mut watchers = self.watchers.lock().map_err(|_| {
            DesktopError::new(
                "WATCHER_LOCK_FAILED",
                "Unable to update file watchers",
                true,
            )
        })?;
        let mut workspace_watchers = Vec::new();
        let last_emit = Arc::new(std::sync::Mutex::new(
            HashMap::<String, std::time::Instant>::new(),
        ));
        let generation = self.next_generation();
        for root in &workspace.paths {
            let workspace_id = workspace.id.clone();
            let last_emit = last_emit.clone();
            let app = app.clone();
            let ignored = settings.ignored_folders.clone();
            let mut watcher =
                notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                    let Ok(event) = result else {
                        return;
                    };
                    let vcs_metadata = event.paths.iter().any(|path| {
                        path.components()
                            .any(|part| part.as_os_str() == ".git" || part.as_os_str() == ".svn")
                    });
                    if !vcs_metadata
                        && event.paths.iter().all(|path| {
                            path.components().any(|part| {
                                ignored
                                    .iter()
                                    .any(|item| item == &part.as_os_str().to_string_lossy())
                            })
                        })
                    {
                        return;
                    }
                    let reason = watcher_reason(&event.paths);
                    let Ok(mut last) = last_emit.lock() else {
                        return;
                    };
                    if last.get(reason).is_some_and(|instant| {
                        instant.elapsed() < std::time::Duration::from_millis(300)
                    }) {
                        return;
                    }
                    last.insert(reason.into(), std::time::Instant::now());
                    let _ = app.emit(
                        "versiondock://event",
                        crate::models::WorkspaceEvent {
                            workspace_id: workspace_id.clone(),
                            generation,
                            reason: reason.into(),
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
            workspace_watchers.push(watcher);
        }
        watchers.insert(workspace.id.clone(), workspace_watchers);
        Ok(())
    }

    pub fn retain_workspace_watchers(
        &self,
        workspace_ids: &std::collections::HashSet<String>,
    ) -> Result<(), DesktopError> {
        let mut watchers = self.watchers.lock().map_err(|_| {
            DesktopError::new(
                "WATCHER_LOCK_FAILED",
                "Unable to update file watchers",
                true,
            )
        })?;
        watchers.retain(|workspace_id, _| workspace_ids.contains(workspace_id));
        Ok(())
    }

    pub fn unregister_window(&self, window_label: &str) -> Result<(), DesktopError> {
        let workspace_ids = {
            let mut workspaces = self.window_workspaces.lock().map_err(|_| {
                DesktopError::new(
                    "WINDOW_STATE_LOCK_FAILED",
                    "Unable to remove window state",
                    true,
                )
            })?;
            workspaces.remove(window_label);
            workspaces
                .values()
                .flat_map(|paths| paths.iter().map(|value| workspace_id(value)))
                .collect::<std::collections::HashSet<_>>()
        };
        if let Ok(mut bounds) = self.window_bounds.lock() {
            bounds.remove(window_label);
        }
        self.retain_workspace_watchers(&workspace_ids)
    }
}

fn watcher_reason(paths: &[PathBuf]) -> &'static str {
    if paths.iter().any(|path| {
        let value = path.to_string_lossy().replace('\\', "/");
        value.ends_with("/.git/HEAD")
            || value.contains("/.git/refs/")
            || value.ends_with("/.git/packed-refs")
    }) {
        "refs"
    } else if paths.iter().any(|path| {
        let value = path.to_string_lossy().replace('\\', "/");
        value.ends_with("/.git/index") || value.ends_with("/.svn/wc.db")
    }) {
        "status"
    } else {
        "worktree"
    }
}

fn migrate_state(bytes: &[u8]) -> Option<AppStateSnapshot> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if value
        .get("schemaVersion")
        .and_then(|item| item.as_u64())
        .unwrap_or(0)
        >= 3
    {
        let mut current = serde_json::from_value::<AppStateSnapshot>(value).ok()?;
        current.schema_version = 3;
        return Some(current);
    }
    let mut settings = DesktopSettings::default();
    settings.theme = serde_json::from_value(value.get("theme").cloned().unwrap_or_default())
        .unwrap_or(ThemePreference::System);
    settings.language = serde_json::from_value(value.get("language").cloned().unwrap_or_default())
        .unwrap_or(LanguagePreference::System);
    settings.ui_font_size =
        serde_json::from_value(value.get("uiFontSize").cloned().unwrap_or_default())
            .unwrap_or(UiFontSizePreference::Standard);
    settings.external_editor = value
        .get("externalEditor")
        .cloned()
        .and_then(|item| serde_json::from_value(item).ok());
    let mut layout = LayoutState::default();
    layout.panel_sizes = value
        .get("panelSizes")
        .cloned()
        .and_then(|item| serde_json::from_value(item).ok())
        .unwrap_or_default();
    layout.active_tab = value
        .get("activeTab")
        .and_then(|item| item.as_str())
        .unwrap_or("changes")
        .into();
    layout.file_view_mode = value
        .get("fileViewMode")
        .and_then(|item| item.as_str())
        .unwrap_or("tree")
        .into();
    layout.stash_view_mode = value
        .get("stashViewMode")
        .and_then(|item| item.as_str())
        .unwrap_or("tree")
        .into();
    layout.branch_sidebar_collapsed = value
        .get("branchSidebarCollapsed")
        .and_then(|item| item.as_bool())
        .unwrap_or(false);
    layout.branch_sidebar_collapsed_sections = value
        .get("branchSidebarCollapsedSections")
        .cloned()
        .and_then(|item| serde_json::from_value(item).ok())
        .unwrap_or_default();
    Some(AppStateSnapshot {
        schema_version: 3,
        settings: settings.normalize(),
        layout,
        last_workspace_id: value
            .get("lastWorkspaceId")
            .and_then(|item| item.as_str())
            .map(str::to_string),
        open_workspace_ids: value
            .get("openWorkspaceIds")
            .cloned()
            .and_then(|item| serde_json::from_value(item).ok())
            .unwrap_or_default(),
        active_workspace_id: value
            .get("activeWorkspaceId")
            .and_then(|item| item.as_str())
            .map(str::to_string),
        recent_workspaces: value
            .get("recentWorkspaces")
            .cloned()
            .and_then(|item| serde_json::from_value(item).ok())
            .unwrap_or_default(),
        theme: None,
        language: None,
        ui_font_size: None,
        panel_sizes: None,
        active_tab: None,
        file_view_mode: None,
        stash_view_mode: None,
        external_editor: None,
        branch_sidebar_collapsed: None,
        branch_sidebar_collapsed_sections: None,
    })
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

    #[test]
    fn migrates_legacy_state_and_normalizes_settings() {
        let legacy = br##"{
          "theme":"dark","language":"zhCn","uiFontSize":"large",
          "lastWorkspaceId":null,"recentWorkspaces":[],
          "panelSizes":{"commit":400,"branches":230,"detail":390},
          "activeTab":"stash","fileViewMode":"list","stashViewMode":"list",
          "externalEditor":{"executable":"/usr/bin/code","args":["{path}"]},
          "branchSidebarCollapsed":true,"branchSidebarCollapsedSections":["tags"]
        }"##;
        let state = migrate_state(legacy).unwrap();
        assert_eq!(state.schema_version, 3);
        assert!(matches!(state.settings.theme, ThemePreference::Dark));
        assert_eq!(state.layout.active_tab, "stash");
        assert_eq!(state.layout.panel_sizes.commit, 400);
        assert_eq!(
            state.settings.external_editor.unwrap().executable,
            "/usr/bin/code"
        );

        let settings = crate::models::DesktopSettings {
            repository_scan_depth: 99,
            maximum_graph_commits: 2,
            ignored_folders: vec![
                " node_modules ".into(),
                "../escape".into(),
                "node_modules".into(),
            ],
            project_colors: [
                ("ok".into(), "#4ec9b0".into()),
                ("bad".into(), "red".into()),
            ]
            .into(),
            ..Default::default()
        }
        .normalize();
        assert_eq!(settings.repository_scan_depth, 10);
        assert_eq!(settings.maximum_graph_commits, 100);
        assert_eq!(settings.ignored_folders, vec!["node_modules"]);
        assert_eq!(settings.project_colors.len(), 1);
    }

    #[test]
    fn classifies_vcs_metadata_watcher_events() {
        assert_eq!(watcher_reason(&[PathBuf::from("/repo/.git/HEAD")]), "refs");
        assert_eq!(
            watcher_reason(&[PathBuf::from("/repo/.git/refs/heads/main")]),
            "refs"
        );
        assert_eq!(
            watcher_reason(&[PathBuf::from("/repo/.git/index")]),
            "status"
        );
        assert_eq!(
            watcher_reason(&[PathBuf::from("/repo/.svn/wc.db")]),
            "status"
        );
        assert_eq!(
            watcher_reason(&[PathBuf::from("/repo/src/main.rs")]),
            "worktree"
        );
    }
}
