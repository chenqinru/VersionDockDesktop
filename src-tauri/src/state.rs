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
    OperationEvent, OperationStatus, RefreshScope, RepositoryCommitSelection, RepositoryEvent,
    RepositoryEventSource, RepositoryMeta, RepositoryStatus, RequestContext, ThemePreference,
    ToolAvailability, UiFontSizePreference, WorkspaceDescriptor,
};

#[derive(Clone)]
pub struct OperationReporter {
    pub app: AppHandle,
    pub operation_id: String,
    pub context: RequestContext,
    pub started_at: String,
}

tokio::task_local! {
    static CURRENT_OPERATION: OperationReporter;
}

pub async fn with_operation_reporter<F: std::future::Future>(
    reporter: OperationReporter,
    future: F,
) -> F::Output {
    CURRENT_OPERATION.scope(reporter, future).await
}

pub fn emit_current_operation(status: OperationStatus, phase: &str, message: &str) {
    let _ = CURRENT_OPERATION.try_with(|reporter| {
        let _ = reporter.app.emit(
            "versiondock://event",
            OperationEvent {
                operation_id: reporter.operation_id.clone(),
                context: reporter.context.clone(),
                status,
                phase: phase.into(),
                message: message.into(),
                started_at: reporter.started_at.clone(),
                cancellable: true,
                completed: None,
                total: None,
                result: None,
                error: None,
            },
        );
    });
}

pub struct AppState {
    pub config_dir: PathBuf,
    pub app: RwLock<AppStateSnapshot>,
    pub application_session_id: String,
    pub launch_workspace_id: std::sync::Mutex<Option<String>>,
    pub cancellations: Mutex<HashMap<String, CancellationToken>>,
    pub read_limit: Semaphore,
    pub write_limit: Semaphore,
    pub write_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    state_write_lock: Mutex<()>,
    repository_cache: RwLock<HashMap<String, HashMap<String, RepositoryMeta>>>,
    tool_cache: RwLock<Option<ToolAvailability>>,
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
        app.schema_version = 7;
        app.settings = app.settings.normalize();
        if app.layout.stash_view_mode != "list" && app.layout.stash_view_mode != "tree" {
            app.layout.stash_view_mode = "tree".into();
        }
        if app.layout.file_view_mode != "list" && app.layout.file_view_mode != "tree" {
            app.layout.file_view_mode = "tree".into();
        }
        let mut launch_workspace_id = None;
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
                        launch_workspace_id = Some(descriptor.id.clone());
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
            application_session_id: uuid::Uuid::new_v4().to_string(),
            launch_workspace_id: std::sync::Mutex::new(launch_workspace_id),
            cancellations: Mutex::new(HashMap::new()),
            read_limit: Semaphore::new(4),
            write_limit: Semaphore::new(2),
            write_locks: Mutex::new(HashMap::new()),
            state_write_lock: Mutex::new(()),
            repository_cache: RwLock::new(HashMap::new()),
            tool_cache: RwLock::new(None),
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

    pub async fn cancel_all(&self) {
        let mut cancellations = self.cancellations.lock().await;
        for token in cancellations.values() {
            token.cancel();
        }
        cancellations.clear();
    }

    pub fn has_registered_windows(&self) -> bool {
        self.window_workspaces
            .lock()
            .map(|windows| !windows.is_empty())
            .unwrap_or(false)
    }

    pub async fn write_lock(&self, repo_id: &str) -> Arc<Mutex<()>> {
        self.write_locks
            .lock()
            .await
            .entry(repo_id.to_string())
            .or_default()
            .clone()
    }

    pub async fn cache_repositories(&self, workspace_id: &str, repositories: &[RepositoryStatus]) {
        self.repository_cache.write().await.insert(
            workspace_id.to_string(),
            repositories
                .iter()
                .map(|repository| (repository.meta.id.clone(), repository.meta.clone()))
                .collect(),
        );
    }

    pub async fn cached_repository(
        &self,
        workspace_id: &str,
        repository_id: &str,
    ) -> Option<RepositoryMeta> {
        self.repository_cache
            .read()
            .await
            .get(workspace_id)
            .and_then(|repositories| repositories.get(repository_id))
            .cloned()
    }

    pub async fn cache_repository(&self, workspace_id: &str, repository: RepositoryMeta) {
        self.repository_cache
            .write()
            .await
            .entry(workspace_id.to_string())
            .or_default()
            .insert(repository.id.clone(), repository);
    }

    pub async fn cached_repositories(&self, workspace_id: &str) -> Vec<RepositoryMeta> {
        self.repository_cache
            .read()
            .await
            .get(workspace_id)
            .map(|repositories| repositories.values().cloned().collect())
            .unwrap_or_default()
    }

    pub async fn remove_cached_workspace(&self, workspace_id: &str) {
        self.repository_cache.write().await.remove(workspace_id);
    }

    pub async fn cache_tools(&self, tools: ToolAvailability) {
        *self.tool_cache.write().await = Some(tools);
    }

    pub async fn cached_tools(&self) -> Option<ToolAvailability> {
        self.tool_cache.read().await.clone()
    }

    pub async fn acquire_write(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<tokio::sync::SemaphorePermit<'_>, DesktopError> {
        emit_current_operation(
            OperationStatus::Queued,
            "waitingForWriteSlot",
            "Waiting for a repository write slot",
        );
        let permit = tokio::select! {
            _ = cancellation.cancelled() => Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)),
            permit = self.write_limit.acquire() => permit.map_err(|_| DesktopError::new("APP_CLOSING", "Application is closing", true)),
        }?;
        emit_current_operation(
            OperationStatus::Running,
            "runningRepositoryOperation",
            "Running repository operation",
        );
        Ok(permit)
    }

    pub async fn acquire_read(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<tokio::sync::SemaphorePermit<'_>, DesktopError> {
        emit_current_operation(
            OperationStatus::Queued,
            "waitingForReadSlot",
            "Waiting for a repository read slot",
        );
        let permit = tokio::select! {
            _ = cancellation.cancelled() => Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)),
            permit = self.read_limit.acquire() => permit.map_err(|_| DesktopError::new("APP_CLOSING", "Application is closing", true)),
        }?;
        emit_current_operation(
            OperationStatus::Running,
            "readingRepository",
            "Reading repository data",
        );
        Ok(permit)
    }

    pub async fn save_app_state(&self, mut snapshot: AppStateSnapshot) -> Result<(), DesktopError> {
        let _state_write = self.state_write_lock.lock().await;
        snapshot.commit_selections = self.app.read().await.commit_selections.clone();
        self.save_app_state_locked(snapshot).await
    }

    async fn save_app_state_locked(&self, snapshot: AppStateSnapshot) -> Result<(), DesktopError> {
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

    pub async fn save_commit_selections(
        &self,
        workspace_id: &str,
        selections: Vec<RepositoryCommitSelection>,
    ) -> Result<Vec<RepositoryCommitSelection>, DesktopError> {
        let mut normalized = selections
            .into_iter()
            .map(|mut selection| {
                selection.paths = selection
                    .paths
                    .into_iter()
                    .map(|value| value.trim().replace('\\', "/"))
                    .filter(|value| {
                        !value.is_empty()
                            && !value.contains('\0')
                            && !value.starts_with('-')
                            && !value
                                .split('/')
                                .any(|part| part.is_empty() || part == "." || part == "..")
                    })
                    .collect();
                selection.paths.sort();
                selection.paths.dedup();
                selection
            })
            .filter(|selection| !selection.repo_id.trim().is_empty())
            .collect::<Vec<_>>();
        normalized.sort_by(|left, right| left.repo_id.cmp(&right.repo_id));
        normalized.dedup_by(|left, right| left.repo_id == right.repo_id);
        let _state_write = self.state_write_lock.lock().await;
        let mut snapshot = self.app.read().await.clone();
        if normalized.is_empty() {
            snapshot.commit_selections.remove(workspace_id);
        } else {
            snapshot
                .commit_selections
                .insert(workspace_id.to_string(), normalized.clone());
        }
        self.save_app_state_locked(snapshot).await?;
        Ok(normalized)
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
        repositories: &[RepositoryStatus],
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
        let mut repository_roots = repositories
            .iter()
            .map(|repository| {
                (
                    PathBuf::from(&repository.meta.root_path),
                    repository.meta.id.clone(),
                )
            })
            .collect::<Vec<_>>();
        repository_roots.sort_by_key(|(path, _)| std::cmp::Reverse(path.components().count()));
        for root in &workspace.paths {
            let workspace_id = workspace.id.clone();
            let last_emit = last_emit.clone();
            let app = app.clone();
            let ignored = settings.ignored_folders.clone();
            let repository_roots = repository_roots.clone();
            let mut watcher =
                notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                    let Ok(event) = result else {
                        return;
                    };
                    let is_ignored = event.paths.iter().all(|path| {
                        if let Some(ext) = path.extension() {
                            let ext_str = ext.to_string_lossy();
                            if ext_str == "log"
                                || ext_str == "tmp"
                                || ext_str == "swp"
                                || ext_str == "lock"
                            {
                                return true;
                            }
                        }
                        path.components().any(|part| {
                            let s = part.as_os_str().to_string_lossy();
                            s == "logs"
                                || s == "log"
                                || s == "target"
                                || s == "dist"
                                || s == ".vite"
                                || s.contains(".vd-staging-")
                                || ignored.iter().any(|item| item == &s)
                        })
                    });
                    if is_ignored {
                        return;
                    }

                    // 检查是否为内部 .git 瞬态文件（如 index.lock, COMMIT_EDITMSG 等）
                    let is_pure_index_touch = event.paths.iter().all(|path| {
                        let s = path.to_string_lossy().replace('\\', "/");
                        s.ends_with("/.git/index")
                            || s.ends_with("/.git/index.lock")
                            || s.contains("/.git/logs/")
                            || s.ends_with("/.git/COMMIT_EDITMSG")
                    });
                    if is_pure_index_touch {
                        let key = "pure_git_index_touch";
                        let Ok(mut last) = last_emit.lock() else {
                            return;
                        };
                        if last.get(key).is_some_and(|instant| {
                            instant.elapsed() < std::time::Duration::from_millis(2000)
                        }) {
                            return;
                        }
                        last.insert(key.to_string(), std::time::Instant::now());
                    }

                    let repository_id = event.paths.iter().find_map(|event_path| {
                        repository_roots
                            .iter()
                            .find(|(root, _)| event_path.starts_with(root))
                            .map(|(_, id)| id.clone())
                    });
                    let scopes = watcher_scopes(&event.paths, repository_id.is_some());
                    let key = format!("{:?}:{:?}", repository_id, scopes);
                    let Ok(mut last) = last_emit.lock() else {
                        return;
                    };
                    if last.get(&key).is_some_and(|instant| {
                        instant.elapsed() < std::time::Duration::from_millis(300)
                    }) {
                        return;
                    }
                    last.insert(key, std::time::Instant::now());
                    let _ = app.emit(
                        "versiondock://event",
                        RepositoryEvent {
                            workspace_id: workspace_id.clone(),
                            repo_id: repository_id,
                            generation,
                            source: RepositoryEventSource::Watcher,
                            scopes,
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

fn watcher_scopes(paths: &[PathBuf], repository_known: bool) -> Vec<RefreshScope> {
    if !repository_known {
        return vec![RefreshScope::WorkspaceSnapshot];
    }
    let mut scopes = Vec::new();
    if paths.iter().any(|path| {
        let value = path.to_string_lossy().replace('\\', "/");
        value.ends_with("/.git/HEAD")
            || value.contains("/.git/refs/")
            || value.ends_with("/.git/packed-refs")
    }) {
        add_scope(&mut scopes, RefreshScope::Refs);
        add_scope(&mut scopes, RefreshScope::History);
    }
    if paths.iter().any(|path| {
        let value = path.to_string_lossy().replace('\\', "/");
        value.contains("/.git/rebase-")
            || value.contains("/.git/MERGE_")
            || value.ends_with("/.git/CHERRY_PICK_HEAD")
            || value.ends_with("/.git/REVERT_HEAD")
    }) {
        add_scope(&mut scopes, RefreshScope::Operation);
        add_scope(&mut scopes, RefreshScope::Conflicts);
        add_scope(&mut scopes, RefreshScope::Status);
    }
    if paths.iter().any(|path| {
        let value = path.to_string_lossy().replace('\\', "/");
        value.ends_with("/.git/index")
    }) {
        add_scope(&mut scopes, RefreshScope::Index);
        add_scope(&mut scopes, RefreshScope::Status);
        add_scope(&mut scopes, RefreshScope::Conflicts);
    }
    if paths.iter().any(|path| {
        path.to_string_lossy()
            .replace('\\', "/")
            .ends_with("/.svn/wc.db")
    }) {
        add_scope(&mut scopes, RefreshScope::Status);
        add_scope(&mut scopes, RefreshScope::Conflicts);
        add_scope(&mut scopes, RefreshScope::SvnRevision);
    }
    let ordinary_worktree = paths.iter().any(|path| {
        !path
            .components()
            .any(|part| part.as_os_str() == ".git" || part.as_os_str() == ".svn")
    });
    if ordinary_worktree || scopes.is_empty() {
        add_scope(&mut scopes, RefreshScope::Status);
        add_scope(&mut scopes, RefreshScope::Diff);
    }
    scopes
}

fn add_scope(scopes: &mut Vec<RefreshScope>, scope: RefreshScope) {
    if !scopes.contains(&scope) {
        scopes.push(scope);
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
        if current.schema_version < 7 {
            current.settings.notify_incoming_commits = true;
            current.settings.notify_unpushed_commits = true;
        }
        current.schema_version = 7;
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
        schema_version: 7,
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
        commit_selections: Default::default(),
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
        assert_eq!(state.schema_version, 7);
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
    fn migrates_v5_commit_selections_without_cross_workspace_loss() {
        let value = br##"{
          "schemaVersion":5,"lastWorkspaceId":null,"openWorkspaceIds":[],"activeWorkspaceId":null,
          "recentWorkspaces":[],"commitSelections":{"workspace-a":[{"repoId":"repo-a","paths":["src/a.ts"]}]}
        }"##;
        let state = migrate_state(value).unwrap();
        assert_eq!(state.schema_version, 7);
        assert_eq!(state.commit_selections["workspace-a"][0].repo_id, "repo-a");
        assert_eq!(
            state.commit_selections["workspace-a"][0].paths,
            ["src/a.ts"]
        );
    }

    #[test]
    fn v6_notification_defaults_are_replaced_before_release() {
        let mut state = AppStateSnapshot {
            schema_version: 6,
            ..Default::default()
        };
        state.settings.notify_incoming_commits = false;
        state.settings.notify_unpushed_commits = false;
        let bytes = serde_json::to_vec(&state).unwrap();
        let migrated = migrate_state(&bytes).unwrap();
        assert_eq!(migrated.schema_version, 7);
        assert!(migrated.settings.notify_incoming_commits);
        assert!(migrated.settings.notify_unpushed_commits);
    }

    #[test]
    fn application_session_id_is_stable_for_one_process_and_defaults_enable_notifications() {
        let root = tempdir().unwrap();
        let state = AppState::load(root.path().to_path_buf());
        assert!(!state.application_session_id.is_empty());
        let next_process = AppState::load(root.path().to_path_buf());
        assert_ne!(
            state.application_session_id,
            next_process.application_session_id
        );
        let defaults = DesktopSettings::default();
        assert!(defaults.notify_incoming_commits);
        assert!(defaults.notify_unpushed_commits);
    }

    #[test]
    fn classifies_vcs_metadata_watcher_events() {
        assert_eq!(
            watcher_scopes(&[PathBuf::from("/repo/.git/HEAD")], true),
            vec![RefreshScope::Refs, RefreshScope::History]
        );
        assert_eq!(
            watcher_scopes(&[PathBuf::from("/repo/.git/refs/heads/main")], true),
            vec![RefreshScope::Refs, RefreshScope::History]
        );
        assert_eq!(
            watcher_scopes(&[PathBuf::from("/repo/.git/index")], true),
            vec![
                RefreshScope::Index,
                RefreshScope::Status,
                RefreshScope::Conflicts
            ]
        );
        assert_eq!(
            watcher_scopes(&[PathBuf::from("/repo/.svn/wc.db")], true),
            vec![
                RefreshScope::Status,
                RefreshScope::Conflicts,
                RefreshScope::SvnRevision
            ]
        );
        assert_eq!(
            watcher_scopes(&[PathBuf::from("/repo/src/main.rs")], true),
            vec![RefreshScope::Status, RefreshScope::Diff]
        );
        assert_eq!(
            watcher_scopes(&[PathBuf::from("/workspace/new/.git")], false),
            vec![RefreshScope::WorkspaceSnapshot]
        );
    }
}
