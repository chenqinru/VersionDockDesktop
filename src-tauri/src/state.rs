use std::{
    collections::{HashMap, HashSet},
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
    ToolAvailability, UiFontSizePreference, WindowTabTransfer, WorkspaceDescriptor,
};

#[derive(Clone)]
pub struct OperationReporter {
    pub app: AppHandle,
    pub window_label: String,
    pub operation_id: String,
    pub context: RequestContext,
    pub started_at: String,
}

tokio::task_local! {
    static CURRENT_OPERATION: OperationReporter;
}

pub(crate) fn current_operation_reporter() -> Option<OperationReporter> {
    CURRENT_OPERATION.try_with(Clone::clone).ok()
}

pub async fn with_operation_reporter<F: std::future::Future>(
    reporter: OperationReporter,
    future: F,
) -> F::Output {
    CURRENT_OPERATION.scope(reporter, future).await
}

pub(crate) fn current_log_context() -> Option<crate::logger::LogContext> {
    CURRENT_OPERATION
        .try_with(|reporter| crate::logger::LogContext {
            workspace_id: reporter.context.workspace_id.clone(),
            repository_id: reporter.context.repository_id.clone(),
            operation_id: Some(reporter.operation_id.clone()),
            workspace_name: None,
            repository_name: None,
        })
        .ok()
}

pub fn emit_current_operation(status: OperationStatus, phase: &str, message: &str) {
    emit_current_operation_progress(status, phase, message, None, None);
}
pub(crate) fn emit_current_operation_progress(
    status: OperationStatus,
    phase: &str,
    message: &str,
    completed: Option<u32>,
    total: Option<u32>,
) {
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
                completed,
                total,
                result: None,
                error: None,
            },
        );
    });
}

pub struct AppState {
    pub config_dir: PathBuf,
    pub protection: crate::protection::ProtectionCache,
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
    pub tab_sessions: std::sync::Mutex<HashMap<String, PendingTabSession>>,
    watchers: std::sync::Mutex<HashMap<String, Vec<RecommendedWatcher>>>,
    pub pending_repo_status_events: std::sync::Mutex<HashSet<String>>,
    generation: AtomicU32,
}

pub struct PendingTabSession {
    pub transfer: WindowTabTransfer,
    pub session: serde_json::Value,
    pub target: Option<String>,
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
            protection: crate::protection::ProtectionCache::default(),
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
            tab_sessions: std::sync::Mutex::new(HashMap::new()),
            watchers: std::sync::Mutex::new(HashMap::new()),
            pending_repo_status_events: std::sync::Mutex::new(HashSet::new()),
            generation: AtomicU32::new(1),
        }
    }

    pub fn next_generation(&self) -> u32 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn bind_tab_session(
        &self,
        transfer: &WindowTabTransfer,
        target: &str,
    ) -> Result<(), DesktopError> {
        let mut sessions = self.tab_sessions.lock().map_err(|_| {
            DesktopError::new(
                "WINDOW_STATE_LOCK_FAILED",
                "Unable to read tab transfer state",
                true,
            )
        })?;
        if let Some(session) = sessions.get_mut(&transfer.transfer_id) {
            if session.transfer.source_window_label != transfer.source_window_label
                || session.transfer.tab_id != transfer.tab_id
                || session.transfer.paths != transfer.paths
                || session
                    .target
                    .as_deref()
                    .is_some_and(|label| label != target)
            {
                return Err(DesktopError::new(
                    "TAB_TRANSFER_MISMATCH",
                    "Tab transfer identity does not match",
                    false,
                ));
            }
            session.target = Some(target.into());
        }
        Ok(())
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

    pub fn record_pending_repo_status_changed(&self, repo_id: &str) {
        if let Ok(mut pending) = self.pending_repo_status_events.lock() {
            pending.insert(repo_id.to_string());
        }
    }

    pub fn take_pending_repo_status_changed(&self, repo_ids: &[String]) -> Vec<String> {
        let Ok(mut pending) = self.pending_repo_status_events.lock() else {
            return Vec::new();
        };
        let mut matched = Vec::new();
        for id in repo_ids {
            if pending.remove(id) {
                matched.push(id.clone());
            }
        }
        matched
    }

    pub async fn pre_cache_repositories(&self, workspace_id: &str, metas: &[RepositoryMeta]) {
        {
            let mut cache = self.repository_cache.write().await;
            let entry = cache.entry(workspace_id.to_string()).or_default();
            for meta in metas {
                entry.insert(meta.id.clone(), meta.clone());
            }
        }
        let repo_ids: Vec<String> = metas.iter().map(|meta| meta.id.clone()).collect();
        let pending = self.take_pending_repo_status_changed(&repo_ids);
        if !pending.is_empty() {
            if let Some(app) = crate::logger::global_app_handle() {
                use tauri::Emitter;
                let generation = self.next_generation();
                for repo_id in pending {
                    let _ = app.emit(
                        "versiondock://event",
                        crate::models::RepositoryEvent {
                            workspace_id: workspace_id.to_string(),
                            repo_id: Some(repo_id),
                            generation,
                            source: crate::models::RepositoryEventSource::Watcher,
                            scopes: vec![crate::models::RefreshScope::Status],
                        },
                    );
                }
            }
        }
    }

    pub async fn cache_repositories(&self, workspace_id: &str, repositories: &[RepositoryStatus]) {
        self.repository_cache.write().await.insert(
            workspace_id.to_string(),
            repositories
                .iter()
                .map(|repository| (repository.meta.id.clone(), repository.meta.clone()))
                .collect(),
        );
        let repo_ids: Vec<String> = repositories.iter().map(|r| r.meta.id.clone()).collect();
        let pending = self.take_pending_repo_status_changed(&repo_ids);
        if !pending.is_empty() {
            if let Some(app) = crate::logger::global_app_handle() {
                use tauri::Emitter;
                let generation = self.next_generation();
                for repo_id in pending {
                    let _ = app.emit(
                        "versiondock://event",
                        crate::models::RepositoryEvent {
                            workspace_id: workspace_id.to_string(),
                            repo_id: Some(repo_id),
                            generation,
                            source: crate::models::RepositoryEventSource::Watcher,
                            scopes: vec![crate::models::RefreshScope::Status],
                        },
                    );
                }
            }
        }
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

    pub async fn workspaces_for_repository(&self, repository_id: &str) -> Vec<String> {
        self.repository_cache
            .read()
            .await
            .iter()
            .filter(|(_, repos)| repos.contains_key(repository_id))
            .map(|(workspace_id, _)| workspace_id.clone())
            .collect()
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

    pub async fn update_settings(
        &self,
        incoming: DesktopSettings,
        changed_fields: Option<&[String]>,
    ) -> Result<crate::models::SettingsUpdateResult, DesktopError> {
        let _state_write = self.state_write_lock.lock().await;
        let mut snapshot = self.app.read().await.clone();
        let previous = snapshot.settings.clone();
        let settings = if let Some(fields) = changed_fields {
            let mut current = serde_json::to_value(&previous).map_err(|error| {
                DesktopError::new("SETTINGS_SERIALIZE_FAILED", error.to_string(), false)
            })?;
            let incoming = serde_json::to_value(incoming).map_err(|error| {
                DesktopError::new("SETTINGS_SERIALIZE_FAILED", error.to_string(), false)
            })?;
            for field in fields {
                if current.get(field).is_none() || incoming.get(field).is_none() {
                    return Err(DesktopError::new(
                        "INVALID_SETTINGS_FIELD",
                        format!("Unknown setting: {field}"),
                        false,
                    ));
                }
                current[field] = incoming[field].clone();
            }
            serde_json::from_value::<DesktopSettings>(current)
                .map_err(|error| {
                    DesktopError::new("SETTINGS_SERIALIZE_FAILED", error.to_string(), false)
                })?
                .normalize()
        } else {
            incoming.normalize()
        };
        let effects = crate::models::SettingsEffects {
            rescan_workspace: previous.repository_scan_depth != settings.repository_scan_depth
                || previous.ignored_folders != settings.ignored_folders
                || previous.exclude_ignored_directories != settings.exclude_ignored_directories,
            reload_history: previous.maximum_graph_commits != settings.maximum_graph_commits
                || previous.hidden_repository_ids != settings.hidden_repository_ids,
            restart_auto_refresh: previous.auto_fetch_interval_minutes
                != settings.auto_fetch_interval_minutes
                || previous.auto_refresh_interval != settings.auto_refresh_interval
                || previous.fetch_on_startup != settings.fetch_on_startup,
        };
        if previous.sync_protected_branches_from_github
            != settings.sync_protected_branches_from_github
        {
            self.protection.clear();
        }
        snapshot.settings = settings.clone();
        self.save_app_state_locked(snapshot).await?;
        Ok(crate::models::SettingsUpdateResult { settings, effects })
    }

    pub async fn update_layout(&self, layout: LayoutState) -> Result<(), DesktopError> {
        let _state_write = self.state_write_lock.lock().await;
        let mut snapshot = self.app.read().await.clone();
        snapshot.layout = layout;
        self.save_app_state_locked(snapshot).await
    }

    pub async fn save_app_state(&self, mut snapshot: AppStateSnapshot) -> Result<(), DesktopError> {
        let _state_write = self.state_write_lock.lock().await;
        snapshot.commit_selections = self.app.read().await.commit_selections.clone();
        self.save_app_state_locked(snapshot).await
    }

    async fn save_app_state_locked(&self, snapshot: AppStateSnapshot) -> Result<(), DesktopError> {
        std::fs::create_dir_all(&self.config_dir).map_err(io_error)?;
        let target = self.config_dir.join("state.json");
        let temporary = self.config_dir.join("state.json.tmp");
        let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|error| {
            DesktopError::new("STATE_SERIALIZE_FAILED", error.to_string(), true)
        })?;
        std::fs::write(&temporary, bytes).map_err(io_error)?;
        std::fs::rename(&temporary, &target).map_err(io_error)?;
        *self.app.write().await = snapshot;
        Ok(())
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
        let _state_write = self.state_write_lock.lock().await;
        let mut snapshot = self.app.read().await.clone();
        snapshot
            .recent_workspaces
            .retain(|item| item.id != workspace.id);
        snapshot.recent_workspaces.insert(0, workspace.clone());
        snapshot.recent_workspaces.truncate(10);
        snapshot.last_workspace_id = Some(workspace.id);
        self.save_app_state_locked(snapshot).await
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
            let watched_root = PathBuf::from(root);
            let last_emit = last_emit.clone();
            let app = app.clone();
            let ignored = settings.ignored_folders.clone();
            let repository_roots = repository_roots.clone();
            let mut watcher =
                notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                    let Ok(event) = result else {
                        return;
                    };
                    // Reads performed by our own status queries are not changes.
                    if matches!(event.kind, notify::EventKind::Access(_)) {
                        return;
                    }
                    let paths: Vec<_> = event
                        .paths
                        .into_iter()
                        .filter(|path| !watcher_ignored_path(path, &watched_root, &ignored))
                        .collect();
                    if paths.is_empty() {
                        return;
                    }

                    let repository_id = paths.iter().find_map(|event_path| {
                        repository_roots
                            .iter()
                            .find(|(root, _)| event_path.starts_with(root))
                            .map(|(_, id)| id.clone())
                    });
                    let scopes = watcher_scopes(&paths, repository_id.is_some());
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
        if let Ok(mut sessions) = self.tab_sessions.lock() {
            sessions.retain(|_, session| {
                session.transfer.source_window_label != window_label
                    && session.target.as_deref() != Some(window_label)
            });
        }
        self.retain_workspace_watchers(&workspace_ids)
    }
}

fn watcher_ignored_path(path: &Path, workspace_root: &Path, ignored: &[String]) -> bool {
    let Ok(relative) = path.strip_prefix(workspace_root) else {
        return true;
    };
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let name = component.as_os_str().to_string_lossy();
        if name == ".git" {
            let suffix = components
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            if suffix.ends_with(".lock") {
                return true;
            }
            return !(suffix.is_empty()
                || matches!(
                    suffix.as_str(),
                    "index"
                        | "HEAD"
                        | "packed-refs"
                        | "config"
                        | "FETCH_HEAD"
                        | "ORIG_HEAD"
                        | "shallow"
                        | "MERGE_HEAD"
                        | "MERGE_MSG"
                        | "MERGE_MODE"
                        | "CHERRY_PICK_HEAD"
                        | "REVERT_HEAD"
                )
                || suffix == "refs"
                || suffix.starts_with("refs/")
                || suffix.starts_with("rebase-")
                || suffix == "sequencer"
                || suffix.starts_with("sequencer/"));
        }
        if name == ".svn" {
            let suffix = components
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            return !matches!(suffix.as_str(), "" | "wc.db" | "wc.db-wal" | "entries");
        }
        // Ignore generated directories, not arbitrary tracked *.log/*.tmp/*.lock files.
        if components.peek().is_some()
            && (matches!(name.as_ref(), "target" | "dist" | ".vite")
                || name.contains(".vd-staging-")
                || ignored.iter().any(|item| item == &name))
        {
            return true;
        }
    }
    false
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
            || value.ends_with("/.git/config")
            || value.ends_with("/.git/FETCH_HEAD")
            || value.ends_with("/.git/ORIG_HEAD")
            || value.ends_with("/.git/shallow")
    }) {
        add_scope(&mut scopes, RefreshScope::Refs);
        add_scope(&mut scopes, RefreshScope::History);
        add_scope(&mut scopes, RefreshScope::Status);
        add_scope(&mut scopes, RefreshScope::Unpushed);
        add_scope(&mut scopes, RefreshScope::Diff);
    }
    if paths.iter().any(|path| {
        let value = path.to_string_lossy().replace('\\', "/");
        value.contains("/.git/rebase-")
            || value.contains("/.git/MERGE_")
            || value.ends_with("/.git/CHERRY_PICK_HEAD")
            || value.ends_with("/.git/REVERT_HEAD")
            || value.contains("/.git/sequencer")
    }) {
        add_scope(&mut scopes, RefreshScope::Operation);
        add_scope(&mut scopes, RefreshScope::Conflicts);
        add_scope(&mut scopes, RefreshScope::Diff);
        add_scope(&mut scopes, RefreshScope::Status);
    }
    if paths.iter().any(|path| {
        let value = path.to_string_lossy().replace('\\', "/");
        value.ends_with("/.git/index")
    }) {
        add_scope(&mut scopes, RefreshScope::Index);
        add_scope(&mut scopes, RefreshScope::Status);
        add_scope(&mut scopes, RefreshScope::Conflicts);
        add_scope(&mut scopes, RefreshScope::Diff);
    }
    if paths.iter().any(|path| {
        path.to_string_lossy()
            .replace('\\', "/")
            .ends_with("/.svn/wc.db")
            || path
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with("/.svn/wc.db-wal")
            || path
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with("/.svn/entries")
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

    #[tokio::test]
    async fn plugin_aligned_scan_default_and_large_input_budget_survive_restart() {
        let root = tempdir().unwrap();
        let state = AppState::load(root.path().to_path_buf());
        let mut settings = state.app.read().await.settings.clone();
        assert_eq!(settings.repository_scan_depth, 1);
        assert_eq!(settings.ignored_folders, vec!["node_modules"]);
        assert_eq!(settings.ai_config.max_input_tokens, 128_000);
        settings.repository_scan_depth = 4;
        settings.ai_config.max_input_tokens = 2_500_000;
        let result = state
            .update_settings(
                settings,
                Some(&["repositoryScanDepth".into(), "aiConfig".into()]),
            )
            .await
            .unwrap();
        assert!(result.effects.rescan_workspace);
        assert_eq!(result.settings.ai_config.max_input_tokens, 2_500_000);
        let restored = AppState::load(root.path().to_path_buf());
        let settings = restored.app.read().await.settings.clone();
        assert_eq!(settings.repository_scan_depth, 4);
        assert_eq!(settings.ai_config.max_input_tokens, 2_500_000);
        let mut below_minimum = settings;
        below_minimum.ai_config.max_input_tokens = 0;
        assert_eq!(below_minimum.normalize().ai_config.max_input_tokens, 4_096);
    }

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

    #[tokio::test]
    async fn failed_settings_write_keeps_confirmed_memory() {
        let root = tempdir().unwrap();
        let state = AppState::load(root.path().to_path_buf());
        let before = state.app.read().await.settings.clone();
        std::fs::create_dir(root.path().join("state.json")).unwrap();
        let mut incoming = before.clone();
        incoming.theme = ThemePreference::Dracula;
        assert!(state
            .update_settings(incoming, Some(&["theme".into()]))
            .await
            .is_err());
        assert_eq!(
            serde_json::to_value(&state.app.read().await.settings).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }

    #[tokio::test]
    async fn settings_updates_merge_only_changed_fields_and_preserve_layout() {
        let root = tempdir().unwrap();
        let state = AppState::load(root.path().to_path_buf());
        let mut a = state.app.read().await.settings.clone();
        let mut b = a.clone();
        a.theme = ThemePreference::Light2026;
        b.file_icon_theme = crate::models::FileIconThemePreference::Catppuccin;
        let theme_fields = ["theme".into()];
        let icon_fields = ["fileIconTheme".into()];
        let (first, second) = tokio::join!(
            state.update_settings(a, Some(&theme_fields)),
            state.update_settings(b, Some(&icon_fields)),
        );
        first.unwrap();
        second.unwrap();
        let mut layout = state.app.read().await.layout.clone();
        layout.panel_sizes.commit = 500;
        state.update_layout(layout).await.unwrap();
        let saved = AppState::load(root.path().to_path_buf());
        assert_eq!(saved.app.read().await.layout.panel_sizes.commit, 500);
        assert!(matches!(
            saved.app.read().await.settings.theme,
            ThemePreference::Light2026
        ));
        assert!(matches!(
            saved.app.read().await.settings.file_icon_theme,
            crate::models::FileIconThemePreference::Catppuccin
        ));
        assert_eq!(
            saved.app.read().await.layout.panel_sizes.commit,
            state.app.read().await.layout.panel_sizes.commit
        );
        let incoming = state.app.read().await.settings.clone();
        assert!(state
            .update_settings(incoming, Some(&["unknown".into()]))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn scrollbar_mode_persists_without_refreshing_workspace() {
        use crate::models::ScrollbarVisibility;
        let root = tempdir().unwrap();
        let state = AppState::load(root.path().to_path_buf());
        assert_eq!(
            state.app.read().await.settings.scrollbar_visibility,
            ScrollbarVisibility::System
        );
        let before_layout = serde_json::to_value(&state.app.read().await.layout).unwrap();
        let mut incoming = state.app.read().await.settings.clone();
        incoming.scrollbar_visibility = ScrollbarVisibility::Visible;
        let result = state
            .update_settings(incoming, Some(&["scrollbarVisibility".into()]))
            .await
            .unwrap();
        assert!(!result.effects.rescan_workspace);
        assert!(!result.effects.reload_history);
        assert!(!result.effects.restart_auto_refresh);
        let restarted = AppState::load(root.path().to_path_buf());
        assert_eq!(
            restarted.app.read().await.settings.scrollbar_visibility,
            ScrollbarVisibility::Visible
        );
        assert_eq!(
            serde_json::to_value(&restarted.app.read().await.layout).unwrap(),
            before_layout
        );
        assert!(
            serde_json::from_value::<ScrollbarVisibility>(serde_json::json!("invalid")).is_err()
        );
    }

    #[tokio::test]
    async fn layout_density_defaults_for_existing_settings_and_survives_restart() {
        use crate::models::LayoutDensity;
        let root = tempdir().unwrap();
        let initial = AppState::load(root.path().to_path_buf());
        let mut legacy = serde_json::to_value(initial.app.read().await.clone()).unwrap();
        legacy["settings"]
            .as_object_mut()
            .unwrap()
            .remove("layoutDensity");
        std::fs::write(
            root.path().join("state.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let state = AppState::load(root.path().to_path_buf());
        assert_eq!(
            state.app.read().await.settings.layout_density,
            LayoutDensity::Comfortable
        );
        let before_layout = serde_json::to_value(&state.app.read().await.layout).unwrap();
        let mut incoming = state.app.read().await.settings.clone();
        incoming.layout_density = LayoutDensity::Compact;
        let result = state
            .update_settings(incoming, Some(&["layoutDensity".into()]))
            .await
            .unwrap();
        assert!(!result.effects.rescan_workspace);
        assert!(!result.effects.reload_history);
        assert!(!result.effects.restart_auto_refresh);
        let restarted = AppState::load(root.path().to_path_buf());
        assert_eq!(
            restarted.app.read().await.settings.layout_density,
            LayoutDensity::Compact
        );
        assert_eq!(
            serde_json::to_value(&restarted.app.read().await.layout).unwrap(),
            before_layout
        );
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
            vec![
                RefreshScope::Refs,
                RefreshScope::History,
                RefreshScope::Status,
                RefreshScope::Unpushed,
                RefreshScope::Diff
            ]
        );
        assert_eq!(
            watcher_scopes(&[PathBuf::from("/repo/.git/refs/heads/main")], true),
            vec![
                RefreshScope::Refs,
                RefreshScope::History,
                RefreshScope::Status,
                RefreshScope::Unpushed,
                RefreshScope::Diff
            ]
        );
        assert_eq!(
            watcher_scopes(&[PathBuf::from("/repo/.git/index")], true),
            vec![
                RefreshScope::Index,
                RefreshScope::Status,
                RefreshScope::Conflicts,
                RefreshScope::Diff
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

    #[test]
    fn watcher_filter_keeps_vcs_state_and_real_files_under_default_ignored_directories() {
        let ignored = DesktopSettings::default().ignored_folders;
        let root = Path::new("/workspace/logs/project");
        for suffix in [
            ".git/HEAD",
            ".git/index",
            ".git/refs/heads/main",
            ".git/refs/remotes/origin/main",
            ".git/packed-refs",
            ".git/FETCH_HEAD",
            ".git/config",
            ".git/rebase-merge/done",
            ".svn/wc.db",
            ".svn/wc.db-wal",
            "src/tracked.log",
            "Cargo.lock",
            "src/tracked.tmp",
        ] {
            assert!(
                !watcher_ignored_path(&root.join(suffix), root, &ignored),
                "{suffix}"
            );
        }
        for suffix in [
            ".git/index.lock",
            ".git/refs/heads/main.lock",
            ".git/objects/ab/cd",
            ".git/logs/HEAD",
            ".git/COMMIT_EDITMSG",
            ".svn/pristine/ab/cd",
            "node_modules/pkg/file.js",
            "target/debug/app",
            "dist/bundle.js",
            ".vite/deps/cache.js",
        ] {
            assert!(
                watcher_ignored_path(&root.join(suffix), root, &ignored),
                "{suffix}"
            );
        }
        assert!(watcher_ignored_path(
            Path::new("/other/repository/.git/HEAD"),
            root,
            &ignored
        ));
    }

    #[tokio::test]
    async fn real_watcher_detects_external_git_stage_commit_and_push() {
        use std::process::Command;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let working = root.join("working");
        let remote = root.join("remote.git");
        std::fs::create_dir(&working).unwrap();
        let run = |cwd: &Path, args: &[&str]| {
            let result = Command::new(crate::cli::resolve_executable("git"))
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{:?}: {}",
                args,
                String::from_utf8_lossy(&result.stderr)
            );
        };
        run(&root, &["init", "--bare", remote.to_str().unwrap()]);
        run(&working, &["init", "-b", "main"]);
        run(&working, &["config", "user.name", "Watcher QA"]);
        run(&working, &["config", "user.email", "watcher@example.test"]);
        std::fs::write(working.join("file.txt"), "base\n").unwrap();
        run(&working, &["add", "."]);
        run(&working, &["commit", "-m", "base"]);
        run(
            &working,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run(&working, &["push", "-u", "origin", "main"]);
        let ignored = DesktopSettings::default().ignored_folders;
        let watched_root = working.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    if matches!(event.kind, notify::EventKind::Access(_)) {
                        return;
                    }
                    for path in event.paths {
                        if !watcher_ignored_path(&path, &watched_root, &ignored) {
                            let _ = sender.send(watcher_scopes(&[path], true));
                        }
                    }
                }
            })
            .unwrap();
        watcher.watch(&working, RecursiveMode::Recursive).unwrap();
        let wait_for = |expected: RefreshScope| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
            loop {
                let scopes = receiver
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                    .expect("external Git change must reach the watcher");
                if scopes.contains(&expected) {
                    assert!(scopes.contains(&RefreshScope::Status));
                    break;
                }
            }
        };
        std::fs::write(working.join("file.txt"), "external\n").unwrap();
        run(&working, &["add", "file.txt"]);
        wait_for(RefreshScope::Index);
        // Let any initial platform watcher batch drain before the next operation.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        while receiver.try_recv().is_ok() {}
        run(&working, &["commit", "-m", "external commit"]);
        wait_for(RefreshScope::Unpushed);
        let meta = RepositoryMeta {
            id: "watcher-qa".into(),
            name: "working".into(),
            root_path: working.to_string_lossy().into_owned(),
            color: "#ffffff".into(),
            kind: crate::models::VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let status = crate::workspace::git_status(meta.clone(), &CancellationToken::new())
            .await
            .unwrap();
        assert!(status.files.is_empty());
        assert_eq!(status.ahead, 1);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        while receiver.try_recv().is_ok() {}
        run(&working, &["push"]);
        wait_for(RefreshScope::Unpushed);
        let status = crate::workspace::git_status(meta, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(status.ahead, 0);
    }

    #[tokio::test]
    async fn pre_cache_and_pending_status_changed_records_and_clears() {
        let temp_dir = tempfile::tempdir().unwrap();
        let state = AppState::load(temp_dir.path().to_path_buf());

        state.record_pending_repo_status_changed("repo-pending-1");
        assert!(state
            .pending_repo_status_events
            .lock()
            .unwrap()
            .contains("repo-pending-1"));

        let meta = RepositoryMeta {
            id: "repo-pending-1".into(),
            name: "repo".into(),
            root_path: "/test/repo".into(),
            color: "#fff".into(),
            kind: crate::models::VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };

        state.pre_cache_repositories("workspace-1", &[meta]).await;
        let workspaces = state.workspaces_for_repository("repo-pending-1").await;
        assert_eq!(workspaces, vec!["workspace-1".to_string()]);

        // Pending events should be cleared when pre-cached or cached
        assert!(!state
            .pending_repo_status_events
            .lock()
            .unwrap()
            .contains("repo-pending-1"));
    }
}
