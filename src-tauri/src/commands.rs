use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::{
    changelist, identity,
    models::{
        BootstrapData, BridgeCommand, ConflictFile, DesktopCapabilities, DesktopError,
        ProgressEvent, RequestEnvelope, ResponseEnvelope, VcsKind, WindowTabImport,
        WindowTabTransferCompleted,
    },
    shelf,
    state::AppState,
    svn_account, vcs, workspace,
};

#[tauri::command]
pub async fn bridge_cancel(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<bool, DesktopError> {
    Ok(state.cancel(&request_id).await)
}

#[tauri::command]
pub fn follow_tab_drag_preview(
    app: AppHandle,
    window: tauri::WebviewWindow,
    label: String,
    tab_id: String,
    tab_name: String,
    tab_width: f64,
    paths: Vec<String>,
) {
    let source_window_label = window.label().to_string();
    tauri::async_runtime::spawn(async move {
        let mut last_broadcast = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(16))
            .unwrap_or_else(std::time::Instant::now);
        loop {
            let Some(preview) = app.get_webview_window(&label) else {
                break;
            };
            if let (Ok(cursor), Ok(size)) = (app.cursor_position(), preview.outer_size()) {
                let x = (cursor.x - f64::from(size.width) / 2.0).round() as i32;
                let y = (cursor.y - f64::from(size.height) / 2.0).round() as i32;
                let _ = preview.set_position(tauri::PhysicalPosition::new(x, y));
                if last_broadcast.elapsed() >= std::time::Duration::from_millis(16) {
                    let scale = preview.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
                    let mut target_window_label: Option<String> = None;
                    let mut target_client_x: Option<f64> = None;
                    for (window_label, window) in app.webview_windows() {
                        if window_label == source_window_label
                            || window_label.starts_with("tab-drag-preview-")
                            || !window.is_visible().unwrap_or(false)
                            || window.is_minimized().unwrap_or(false)
                        {
                            continue;
                        }
                        if let (Ok(position), Ok(window_size), Ok(window_scale)) = (
                            window.outer_position(),
                            window.outer_size(),
                            window.scale_factor(),
                        ) {
                            let window_scale = window_scale.max(f64::EPSILON);
                            let window_x = f64::from(position.x) / window_scale;
                            let window_y = f64::from(position.y) / window_scale;
                            let window_width = f64::from(window_size.width) / window_scale;
                            let point_x = cursor.x / window_scale;
                            let point_y = cursor.y / window_scale;
                            if point_in_tab_snap_zone(
                                point_x,
                                point_y,
                                window_x,
                                window_y,
                                window_width,
                            ) {
                                target_client_x = Some(point_x - window_x);
                                target_window_label = Some(window_label);
                                break;
                            }
                        }
                    }
                    let _ = app.emit(
                        "versiondock://tab-drag-state",
                        serde_json::json!({
                            "sourceWindowLabel": source_window_label,
                            "tabId": tab_id,
                            "tabName": tab_name,
                            "tabWidth": tab_width,
                            "paths": paths,
                            "screenX": cursor.x / scale,
                            "screenY": cursor.y / scale,
                            "targetWindowLabel": target_window_label,
                            "targetClientX": target_client_x,
                        }),
                    );
                    last_broadcast = std::time::Instant::now();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(8)).await;
        }
    });
}

#[tauri::command]
pub async fn bridge_request(
    envelope: RequestEnvelope,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ResponseEnvelope, DesktopError> {
    let request_id = envelope.request_id.clone();
    let (phase, message) = command_progress(&envelope.command);
    let error_context = command_error_context(&envelope.command);
    let token = state.register_request(&request_id).await;
    let _ = app.emit(
        "versiondock://event",
        ProgressEvent {
            request_id: request_id.clone(),
            phase: phase.into(),
            message: message.into(),
            completed: None,
            total: None,
        },
    );
    let mut result = dispatch(envelope.command, &app, &window, &state, &token).await;
    if let Err(error) = &mut result {
        error
            .operation
            .get_or_insert_with(|| error_context.0.clone());
        if error.workspace_id.is_none() {
            error.workspace_id = error_context.1.clone();
        }
        if error.repository_id.is_none() {
            error.repository_id = error_context.2.clone();
        }
        if error.subject.is_none() {
            error.subject = error_context.3.clone();
        }
    }
    state.finish_request(&request_id).await;
    let succeeded = result.is_ok();
    let _ = app.emit(
        "versiondock://event",
        ProgressEvent {
            request_id: request_id.clone(),
            phase: if succeeded { "completed" } else { "failed" }.into(),
            message: if succeeded {
                "Operation completed"
            } else {
                "Operation failed"
            }
            .into(),
            completed: Some(1),
            total: Some(1),
        },
    );
    Ok(match result {
        Ok(value) => ResponseEnvelope::success(request_id, value),
        Err(error) => ResponseEnvelope::failure(request_id, error),
    })
}

fn command_progress(command: &BridgeCommand) -> (&'static str, &'static str) {
    match command {
        BridgeCommand::WorkspaceOpen { .. } | BridgeCommand::WorkspaceRefresh { .. } => {
            ("scanning", "Scanning workspace repositories")
        }
        BridgeCommand::RepositoryStatus { .. } => ("status", "Reading repository status"),
        BridgeCommand::FileDiff { .. }
        | BridgeCommand::StashFileDiff { .. }
        | BridgeCommand::ShelfFileDiff { .. }
        | BridgeCommand::FileRevisionContent { .. } => {
            ("diff", "Loading file content and differences")
        }
        BridgeCommand::Stage { .. } | BridgeCommand::Unstage { .. } => {
            ("index", "Updating repository index")
        }
        BridgeCommand::Discard { .. } => ("discard", "Restoring selected paths"),
        BridgeCommand::Commit { .. } | BridgeCommand::BatchCommit { .. } => {
            ("commit", "Creating repository commit")
        }
        BridgeCommand::Sync { .. } => ("sync", "Synchronizing repository"),
        BridgeCommand::History { .. }
        | BridgeCommand::HistoryTopology { .. }
        | BridgeCommand::FileHistory { .. } => ("history", "Loading repository history"),
        BridgeCommand::ConflictSave { .. }
        | BridgeCommand::ConflictAccept { .. }
        | BridgeCommand::AbortRepositoryOperation { .. } => ("conflict", "Updating conflict state"),
        BridgeCommand::GitIdentity { .. } | BridgeCommand::GitProfileOperation { .. } => {
            ("identity", "Resolving Git identity")
        }
        BridgeCommand::SvnAccount { .. } | BridgeCommand::SvnAccountOperation { .. } => {
            ("authentication", "Checking SVN authentication")
        }
        BridgeCommand::Submodules { .. } | BridgeCommand::SubmoduleOperation { .. } => {
            ("submodule", "Updating Git submodule state")
        }
        BridgeCommand::Subtrees { .. } | BridgeCommand::SubtreeOperation { .. } => {
            ("subtree", "Updating Git subtree state")
        }
        BridgeCommand::SvnOperation { .. } => ("svn", "Updating SVN working copy"),
        BridgeCommand::UnpushedOperation { .. } => ("history", "Updating unpushed commit history"),
        BridgeCommand::UpdateSettings { .. }
        | BridgeCommand::UpdateLayout { .. }
        | BridgeCommand::SaveAppState { .. } => ("persisting", "Saving application settings"),
        _ => ("running", "Running repository operation"),
    }
}

fn command_error_context(
    command: &BridgeCommand,
) -> (String, Option<String>, Option<String>, Option<String>) {
    let operation = command_progress(command).0.to_string();
    match command {
        BridgeCommand::WorkspaceRemoveRecent { workspace_id }
        | BridgeCommand::WorkspaceRefresh { workspace_id }
        | BridgeCommand::Conflicts { workspace_id } => {
            (operation, Some(workspace_id.clone()), None, None)
        }
        BridgeCommand::RepositoryStatus {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::Branches {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::Tags {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::Stashes {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::Shelves {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::Changelists {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::Worktrees {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::Subtrees {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::Submodules {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::Remotes {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::UnpushedCommits {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::CreatePatch {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::GitIdentity {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::SvnAccount {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::AbortRepositoryOperation {
            workspace_id,
            repo_id,
            ..
        } => (
            operation,
            Some(workspace_id.clone()),
            Some(repo_id.clone()),
            None,
        ),
        BridgeCommand::FileDiff {
            workspace_id,
            repo_id,
            relative_path,
            ..
        }
        | BridgeCommand::ConflictVersions {
            workspace_id,
            repo_id,
            relative_path,
        }
        | BridgeCommand::ConflictSave {
            workspace_id,
            repo_id,
            relative_path,
            ..
        }
        | BridgeCommand::ConflictAccept {
            workspace_id,
            repo_id,
            relative_path,
            ..
        }
        | BridgeCommand::FileHistory {
            workspace_id,
            repo_id,
            relative_path,
            ..
        }
        | BridgeCommand::FileRevisionContent {
            workspace_id,
            repo_id,
            relative_path,
            ..
        } => (
            operation,
            Some(workspace_id.clone()),
            Some(repo_id.clone()),
            Some(relative_path.clone()),
        ),
        BridgeCommand::StashFileDiff {
            workspace_id,
            repo_id,
            relative_path,
            ..
        }
        | BridgeCommand::ShelfFileDiff {
            workspace_id,
            repo_id,
            relative_path,
            ..
        } => (
            operation,
            Some(workspace_id.clone()),
            Some(repo_id.clone()),
            Some(relative_path.clone()),
        ),
        BridgeCommand::Commit {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::Sync {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::BranchOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::TagOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::StashOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::ShelfOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::ChangelistOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::WorktreeOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::OpenWorktree {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::WorktreeDiff {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::WorktreeFileDiff {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::BranchWorkingDiff {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::BranchWorkingFileDiff {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::SubtreeOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::SubmoduleOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::HistoryOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::RemoteOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::GitProfileOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::SvnAccountOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::SvnOperation {
            workspace_id,
            repo_id,
            ..
        } => (
            operation,
            Some(workspace_id.clone()),
            Some(repo_id.clone()),
            None,
        ),
        BridgeCommand::BatchCommit { workspace_id, .. } => {
            (operation, Some(workspace_id.clone()), None, None)
        }
        _ => (operation, None, None, None),
    }
}

async fn dispatch(
    command: BridgeCommand,
    app: &AppHandle,
    invoking_window: &tauri::WebviewWindow,
    state: &AppState,
    token: &tokio_util::sync::CancellationToken,
) -> Result<serde_json::Value, DesktopError> {
    match command {
        BridgeCommand::Bootstrap => {
            let mut snapshot = state.app.read().await.clone();
            for workspace in &mut snapshot.recent_workspaces {
                workspace.available = workspace.paths.iter().all(|path| Path::new(path).is_dir());
            }
            json(BootstrapData {
                state: snapshot,
                tools: workspace::tool_availability(token).await,
                capabilities: DesktopCapabilities {
                    stash: true,
                    shelf: true,
                    changelist: true,
                    worktree: true,
                    subtree: true,
                    submodule: true,
                    compare: true,
                    remote_management: true,
                    identity: true,
                    svn_account: true,
                    file_history: true,
                    secure_credentials: true,
                    system_notifications: true,
                    ..DesktopCapabilities::default()
                },
            })
        }
        BridgeCommand::SaveAppState { state: snapshot } => {
            state.save_app_state(snapshot).await?;
            json(true)
        }
        BridgeCommand::UpdateSettings { settings } => {
            let mut snapshot = state.app.read().await.clone();
            let previous = snapshot.settings.clone();
            let settings = settings.normalize();
            let effects = crate::models::SettingsEffects {
                rescan_workspace: previous.repository_scan_depth != settings.repository_scan_depth
                    || previous.ignored_folders != settings.ignored_folders,
                reload_history: previous.maximum_graph_commits != settings.maximum_graph_commits
                    || previous.hidden_repository_ids != settings.hidden_repository_ids,
                restart_auto_refresh: previous.auto_refresh_interval
                    != settings.auto_refresh_interval
                    || previous.fetch_on_startup != settings.fetch_on_startup,
            };
            snapshot.settings = settings.clone();
            state.save_app_state(snapshot).await?;
            json(crate::models::SettingsUpdateResult { settings, effects })
        }
        BridgeCommand::UpdateLayout { mut layout } => {
            if layout.file_view_mode != "list" {
                layout.file_view_mode = "tree".into();
            }
            if layout.stash_view_mode != "list" {
                layout.stash_view_mode = "tree".into();
            }
            layout.panel_sizes.commit = layout.panel_sizes.commit.clamp(280, 620);
            layout.panel_sizes.branches = layout.panel_sizes.branches.clamp(160, 520);
            layout.panel_sizes.detail = layout.panel_sizes.detail.clamp(240, 720);
            let mut snapshot = state.app.read().await.clone();
            snapshot.layout = layout.clone();
            state.save_app_state(snapshot).await?;
            json(layout)
        }
        BridgeCommand::WorkspaceOpen { paths } => {
            let descriptor = workspace::descriptor(paths)?;
            state.upsert_workspace(descriptor.clone()).await?;
            let generation = state.next_generation();
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            let settings = state.app.read().await.settings.clone();
            let snapshot =
                workspace::snapshot(descriptor.clone(), generation, &settings, token).await?;
            state.watch_workspace(&descriptor, &settings, app.clone())?;
            json(snapshot)
        }
        BridgeCommand::WorkspaceRemoveRecent { workspace_id } => {
            let mut snapshot = state.app.read().await.clone();
            snapshot
                .recent_workspaces
                .retain(|workspace| workspace.id != workspace_id);
            if snapshot.last_workspace_id.as_deref() == Some(&workspace_id) {
                snapshot.last_workspace_id = None;
            }
            state.save_app_state(snapshot).await?;
            json(true)
        }
        BridgeCommand::WorkspaceRefresh { workspace_id } => {
            let descriptor = state.workspace(&workspace_id).await?;
            let generation = state.next_generation();
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            let settings = state.app.read().await.settings.clone();
            let snapshot =
                workspace::snapshot(descriptor.clone(), generation, &settings, token).await?;
            state.watch_workspace(&descriptor, &settings, app.clone())?;
            json(snapshot)
        }
        BridgeCommand::WindowOpenNew {
            paths,
            x,
            y,
            width,
            height,
            transfer,
        } => {
            if transfer
                .as_ref()
                .is_some_and(|value| value.source_window_label != invoking_window.label())
            {
                return Err(DesktopError::new(
                    "TAB_TRANSFER_SOURCE_MISMATCH",
                    "The tab transfer source does not match the invoking window",
                    false,
                ));
            }
            let label = format!("window-{}", uuid::Uuid::new_v4().simple());
            let mut query = vec!["window=new".to_string()];
            if let Some(paths) = &paths {
                if !paths.is_empty() {
                    let encoded = serde_json::to_string(paths).unwrap_or_default();
                    query.push(format!("workspacePaths={}", url_encode(&encoded)));
                }
            }
            if let Some(transfer) = &transfer {
                let encoded = serde_json::to_string(transfer).unwrap_or_default();
                query.push(format!("tabTransfer={}", url_encode(&encoded)));
            }
            let query_suffix = format!("?{}", query.join("&"));

            let main_url = app
                .get_webview_window("main")
                .and_then(|window| window.url().ok())
                .or_else(|| invoking_window.url().ok());
            let webview_url = match main_url {
                Some(mut url) if matches!(url.scheme(), "http" | "https") => {
                    url.set_path("/");
                    url.set_query(Some(query_suffix.trim_start_matches('?')));
                    url.set_fragment(None);
                    tauri::WebviewUrl::External(url)
                }
                _ => {
                    let url_path = format!("index.html{}", query_suffix);
                    tauri::WebviewUrl::App(url_path.into())
                }
            };

            let builder = tauri::WebviewWindowBuilder::new(app, &label, webview_url)
                .title(" ")
                .inner_size(width.unwrap_or(880.0), height.unwrap_or(540.0))
                .min_inner_size(800.0, 480.0)
                .resizable(true);

            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);

            #[cfg(target_os = "linux")]
            let builder = builder.decorations(false);

            #[cfg(target_os = "windows")]
            let builder = builder.decorations(true);

            let builder = if let (Some(x), Some(y)) = (x, y) {
                builder.position(x, y)
            } else {
                builder.center()
            };

            let window = builder.build().map_err(|err| {
                DesktopError::new(
                    "WINDOW_CREATE_FAILED",
                    format!("Failed to create window: {err}"),
                    true,
                )
            })?;

            #[cfg(target_os = "windows")]
            {
                use tauri_plugin_window_controls::WindowControlsExt;
                let _ = window.set_title_bar_height(38);
                let _ = window.set_title_bar_overlay(true);
            }

            let _ = window.show();
            let _ = window.set_focus();

            json(label)
        }
        BridgeCommand::WindowSyncTabs {
            workspace_paths,
            active_workspace_id,
        } => {
            let window_label = invoking_window.label().to_string();
            let workspace_ids = {
                let mut map = state.window_workspaces.lock().map_err(|_| {
                    DesktopError::new(
                        "WINDOW_STATE_LOCK_FAILED",
                        "Unable to synchronize window tabs",
                        true,
                    )
                })?;
                map.retain(|label, _| app.get_webview_window(label).is_some());
                map.insert(window_label.clone(), workspace_paths.clone());
                map.values()
                    .flat_map(|paths| paths.iter().map(|value| crate::state::workspace_id(value)))
                    .collect::<std::collections::HashSet<_>>()
            };
            state.retain_workspace_watchers(&workspace_ids)?;

            if window_label == "main" {
                let open_workspace_ids = workspace_paths
                    .iter()
                    .map(|paths| crate::state::workspace_id(paths))
                    .collect::<Vec<_>>();
                let mut snapshot = state.app.read().await.clone();
                snapshot.open_workspace_ids = open_workspace_ids.clone();
                snapshot.active_workspace_id = active_workspace_id
                    .filter(|workspace_id| open_workspace_ids.contains(workspace_id));
                snapshot.last_workspace_id = snapshot.active_workspace_id.clone();
                state.save_app_state(snapshot).await?;
            }
            json(true)
        }
        BridgeCommand::WindowFocusWorkspace { paths } => {
            use tauri::{Emitter, Manager};
            let current_window_label = invoking_window.label().to_string();
            let mut target_window_label: Option<String> = None;
            {
                let mut map = state.window_workspaces.lock().unwrap();
                // 清理已经销毁的窗口
                map.retain(|label, _| app.get_webview_window(label).is_some());

                for (label, workspaces) in map.iter() {
                    if label != &current_window_label {
                        for ws in workspaces {
                            if paths_match(ws, &paths) {
                                target_window_label = Some(label.clone());
                                break;
                            }
                        }
                        if target_window_label.is_some() {
                            break;
                        }
                    }
                }
            }

            if let Some(target_label) = target_window_label {
                if let Some(window) = app.get_webview_window(&target_label) {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("versiondock://focus-tab", &paths);
                    return json(true);
                }
            }

            json(false)
        }
        BridgeCommand::WindowSyncBounds {
            x,
            y,
            width,
            height,
        } => {
            let window_label = invoking_window.label().to_string();
            let mut map = state.window_bounds.lock().unwrap();
            map.insert(window_label, (x, y, width, height));
            json(true)
        }
        BridgeCommand::WindowSetSize {
            width,
            height,
            center,
        } => {
            let is_welcome = width > 0.0 && width < 1000.0;
            let _ = invoking_window.set_resizable(!is_welcome);
            let _ = invoking_window.set_maximizable(!is_welcome);

            if let Ok(Some(monitor)) = invoking_window.current_monitor() {
                let scale = monitor.scale_factor();
                let m_size = monitor.size().to_logical::<f64>(scale);
                let m_pos = monitor.position().to_logical::<f64>(scale);

                let (actual_width, actual_height) = if is_welcome {
                    (width, height)
                } else if width > 0.0 && height > 0.0 {
                    (
                        width.min(m_size.width - 40.0),
                        height.min(m_size.height - 60.0),
                    )
                } else {
                    let w = (m_size.width * 0.88)
                        .clamp(1280.0, 1920.0)
                        .min(m_size.width - 40.0);
                    let h = (m_size.height * 0.88)
                        .clamp(800.0, 1200.0)
                        .min(m_size.height - 60.0);
                    (w, h)
                };

                let _ =
                    invoking_window.set_size(tauri::LogicalSize::new(actual_width, actual_height));
                if center {
                    let target_x = m_pos.x + (m_size.width - actual_width).max(0.0) / 2.0;
                    let target_y = m_pos.y + (m_size.height - actual_height).max(0.0) / 2.0;
                    let _ = invoking_window
                        .set_position(tauri::LogicalPosition::new(target_x, target_y));
                }
            } else {
                let actual_width = if width > 0.0 { width } else { 1560.0 };
                let actual_height = if height > 0.0 { height } else { 980.0 };
                let _ =
                    invoking_window.set_size(tauri::LogicalSize::new(actual_width, actual_height));
                if center {
                    let _ = invoking_window.center();
                }
            }
            json(true)
        }
        BridgeCommand::WindowTabDrop {
            transfer,
            screen_x,
            screen_y,
        } => {
            use tauri::{Emitter, Manager};
            if transfer.source_window_label != invoking_window.label() {
                return Err(DesktopError::new(
                    "TAB_TRANSFER_SOURCE_MISMATCH",
                    "The tab transfer source does not match the invoking window",
                    false,
                ));
            }
            let mut target_window_label: Option<String> = None;
            let registered_windows = state
                .window_workspaces
                .lock()
                .map_err(|_| {
                    DesktopError::new(
                        "WINDOW_STATE_LOCK_FAILED",
                        "Unable to read window tabs",
                        true,
                    )
                })?
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>();

            if screen_x.is_finite() && screen_y.is_finite() {
                let windows = app.webview_windows();
                for (label, window) in windows {
                    if label != transfer.source_window_label
                        && registered_windows.contains(&label)
                        && window.is_visible().unwrap_or(false)
                        && !window.is_minimized().unwrap_or(false)
                    {
                        if let (Ok(pos), Ok(size), Ok(scale)) = (
                            window.outer_position(),
                            window.outer_size(),
                            window.scale_factor(),
                        ) {
                            let scale = if scale <= 0.0 { 1.0 } else { scale };
                            let win_x = pos.x as f64 / scale;
                            let win_y = pos.y as f64 / scale;
                            let win_w = size.width as f64 / scale;
                            if point_in_tab_snap_zone(screen_x, screen_y, win_x, win_y, win_w) {
                                target_window_label = Some(label);
                                break;
                            }
                        }
                    }
                }
            }

            if target_window_label.is_none() {
                let bounds_map = state.window_bounds.lock().map_err(|_| {
                    DesktopError::new(
                        "WINDOW_STATE_LOCK_FAILED",
                        "Unable to read window bounds",
                        true,
                    )
                })?;
                for (label, (win_x, win_y, win_w, _)) in bounds_map.iter() {
                    if label != &transfer.source_window_label
                        && registered_windows.contains(label)
                        && app.get_webview_window(label).is_some()
                        && point_in_tab_snap_zone(screen_x, screen_y, *win_x, *win_y, *win_w)
                    {
                        target_window_label = Some(label.clone());
                        break;
                    }
                }
            }

            if let Some(target_label) = target_window_label {
                if let Some(target) = app.get_webview_window(&target_label) {
                    let _ = target.unminimize();
                    let _ = target.show();
                    let _ = target.set_focus();
                    let payload = WindowTabImport {
                        transfer,
                        screen_x,
                        screen_y,
                    };
                    if target.emit("versiondock://import-tab", payload).is_ok() {
                        return json(true);
                    }
                }
            }

            json(false)
        }
        BridgeCommand::WindowCompleteTabTransfer {
            transfer_id,
            source_window_label,
            tab_id,
            target_window_label,
            accepted,
        } => {
            use tauri::{Emitter, Manager};
            if target_window_label != invoking_window.label() {
                return Err(DesktopError::new(
                    "TAB_TRANSFER_TARGET_MISMATCH",
                    "The tab transfer target does not match the invoking window",
                    false,
                ));
            }
            let Some(source) = app.get_webview_window(&source_window_label) else {
                return json(false);
            };
            source
                .emit(
                    "versiondock://tab-transfer-completed",
                    WindowTabTransferCompleted {
                        transfer_id,
                        source_window_label,
                        tab_id,
                        target_window_label,
                        accepted,
                    },
                )
                .map_err(|error| {
                    DesktopError::new("TAB_TRANSFER_ACK_FAILED", error.to_string(), true)
                })?;
            json(true)
        }
        BridgeCommand::RepositoryStatus {
            workspace_id,
            repo_id,
        } => {
            let descriptor = state.workspace(&workspace_id).await?;
            let repo = workspace::repository(&descriptor, &repo_id)?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(match repo.kind {
                VcsKind::Git => workspace::git_status(repo, token).await?,
                VcsKind::Svn => workspace::svn_status(repo, token).await?,
            })
        }
        BridgeCommand::FileDiff {
            workspace_id,
            repo_id,
            relative_path,
            staged,
            revision,
            from_revision,
            to_revision,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(
                vcs::diff(
                    &repo,
                    &relative_path,
                    staged,
                    revision,
                    from_revision,
                    to_revision,
                    token,
                )
                .await?,
            )
        }
        BridgeCommand::StashFileDiff {
            workspace_id,
            repo_id,
            reference,
            relative_path,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::stash_file_diff(&repo, &reference, &relative_path, token).await?)
        }
        BridgeCommand::ShelfFileDiff {
            workspace_id,
            repo_id,
            shelf_id,
            relative_path,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(shelf::file_diff(&state.config_dir, &repo, &shelf_id, &relative_path).await?)
        }
        BridgeCommand::Stage {
            workspace_id,
            repo_id,
            paths,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::stage(&repo, &paths, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Unstage {
            workspace_id,
            repo_id,
            paths,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::unstage(&repo, &paths, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Discard {
            workspace_id,
            repo_id,
            paths,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::discard(&repo, &paths, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::DeletePaths {
            workspace_id,
            repo_id,
            paths,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::delete_paths(&repo, &paths).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::AddIgnore {
            workspace_id,
            repo_id,
            relative_path,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(
                with_write(state, &repo_id, async {
                    vcs::add_ignore(&repo, &relative_path, token).await
                })
                .await?,
            )
        }
        BridgeCommand::IgnoreRules {
            workspace_id,
            repo_id,
            directory,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(vcs::ignore_rules(&repo, &directory, token).await?)
        }
        BridgeCommand::UpdateIgnoreRules {
            workspace_id,
            repo_id,
            directory,
            patterns,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::update_ignore_rules(&repo, &directory, &patterns, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Commit {
            workspace_id,
            repo_id,
            message,
            amend,
            paths,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let identity = if repo.kind == VcsKind::Git {
                Some(
                    identity::state(&state.config_dir, &repo, token)
                        .await?
                        .effective,
                )
            } else {
                None
            };
            let value = with_write(state, &repo_id, async {
                vcs::commit_with_identity(&repo, &message, amend, &paths, identity.as_ref(), token)
                    .await
            })
            .await?;
            json(value)
        }
        BridgeCommand::BatchCommit {
            workspace_id,
            targets,
            push,
        } => {
            let mut results = Vec::new();
            for target in targets {
                let repo_id = target.repo_id.clone();
                let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
                let identity = if repo.kind == VcsKind::Git {
                    Some(
                        identity::state(&state.config_dir, &repo, token)
                            .await?
                            .effective,
                    )
                } else {
                    None
                };
                let commit_result = with_write(state, &repo_id, async {
                    vcs::commit_with_identity(
                        &repo,
                        &target.message,
                        target.amend,
                        &target.paths,
                        identity.as_ref(),
                        token,
                    )
                    .await
                })
                .await;
                match commit_result {
                    Ok(revision) => {
                        let push_result = if push && repo.kind == VcsKind::Git {
                            with_write(state, &repo_id, async {
                                vcs::sync(&repo, crate::models::SyncAction::Push, None, token).await
                            })
                            .await
                            .map(|_| true)
                        } else {
                            Ok(false)
                        };
                        match push_result {
                            Ok(pushed) => results.push(crate::models::RepositoryOperationResult {
                                repo_id,
                                committed: true,
                                revision: Some(revision),
                                pushed,
                                error: None,
                            }),
                            Err(error) => results.push(crate::models::RepositoryOperationResult {
                                repo_id,
                                committed: true,
                                revision: Some(revision),
                                pushed: false,
                                error: Some(error),
                            }),
                        }
                    }
                    Err(error) => results.push(crate::models::RepositoryOperationResult {
                        repo_id,
                        committed: false,
                        revision: None,
                        pushed: false,
                        error: Some(error),
                    }),
                }
            }
            json(results)
        }
        BridgeCommand::Sync {
            workspace_id,
            repo_id,
            action,
            remote,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let value = with_write(state, &repo_id, async {
                vcs::sync(&repo, action, remote, token).await
            })
            .await?;
            json(value)
        }
        BridgeCommand::History {
            workspace_id,
            repo_id,
            skip,
            limit,
            filter,
            revision,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::history(&repo, skip, limit, filter, revision, token).await?)
        }
        BridgeCommand::HistoryTopology {
            workspace_id,
            repo_id,
            svn_limit,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::history_topology(&repo, svn_limit, token).await?)
        }
        BridgeCommand::CommitDetail {
            workspace_id,
            repo_id,
            revision,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::commit_detail(&repo, &revision, token).await?)
        }
        BridgeCommand::CommitMergeCommits {
            workspace_id,
            repo_id,
            revision,
            parents,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::merge_commits(&repo, &revision, &parents, token).await?)
        }
        BridgeCommand::CommitMergeParentFiles {
            workspace_id,
            repo_id,
            revision,
            parent_hash,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::merge_parent_files(&repo, &revision, &parent_hash, token).await?)
        }
        BridgeCommand::UnpushedCommits {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::unpushed_commits(&repo, token).await?)
        }
        BridgeCommand::UnpushedOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::unpushed_operation(&repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::CreatePatch {
            workspace_id,
            repo_id,
            revisions,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::create_patch(&repo, &revisions, token).await?)
        }
        BridgeCommand::HistoryOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::history_operation(&repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Branches {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(vcs::branches(&repo, token).await?)
        }
        BridgeCommand::BranchOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::branch_operation(&repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Tags {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(vcs::tags(&repo, token).await?)
        }
        BridgeCommand::TagOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::tag_operation(&repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Stashes {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(vcs::stashes(&repo, token).await?)
        }
        BridgeCommand::StashOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::stash_operation(&repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::SystemOpen {
            workspace_id,
            repo_id,
            relative_path,
            reveal,
            external,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let target =
                crate::state::safe_relative(Path::new(&repo.root_path), &relative_path, true)?;
            if reveal {
                app.opener()
                    .reveal_items_in_dir([target])
                    .map_err(|error| {
                        DesktopError::new("SYSTEM_REVEAL_FAILED", error.to_string(), true)
                    })?;
            } else if external {
                let editor = state
                    .app
                    .read()
                    .await
                    .settings
                    .external_editor
                    .clone()
                    .ok_or_else(|| {
                        DesktopError::new(
                            "EXTERNAL_EDITOR_NOT_CONFIGURED",
                            "External editor is not configured",
                            true,
                        )
                    })?;
                launch_external_editor(&editor, &repo, &relative_path, &target)?;
            } else {
                app.opener()
                    .open_path(target.to_string_lossy(), None::<&str>)
                    .map_err(|error| {
                        DesktopError::new("SYSTEM_OPEN_FAILED", error.to_string(), true)
                    })?;
            }
            json(true)
        }
        BridgeCommand::Shelves {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(shelf::list(&state.config_dir, &repo).await?)
        }
        BridgeCommand::ShelfOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                shelf::operate(&state.config_dir, &repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Changelists {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(changelist::list(&state.config_dir, &repo).await?)
        }
        BridgeCommand::ChangelistOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                changelist::operate(&state.config_dir, &repo, operation).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Worktrees {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(vcs::worktrees(&repo, token).await?)
        }
        BridgeCommand::WorktreeOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::worktree_operation(&state.config_dir, &repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::OpenWorktree {
            workspace_id,
            repo_id,
            path,
            reveal,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let target = vcs::managed_worktree_path(&state.config_dir, &repo, &path, token).await?;
            if reveal {
                app.opener()
                    .reveal_items_in_dir([target])
                    .map_err(|error| {
                        DesktopError::new("SYSTEM_REVEAL_FAILED", error.to_string(), true)
                    })?;
            } else {
                app.opener()
                    .open_path(target.to_string_lossy(), None::<&str>)
                    .map_err(|error| {
                        DesktopError::new("SYSTEM_OPEN_FAILED", error.to_string(), true)
                    })?;
            }
            json(true)
        }
        BridgeCommand::WorktreeDiff {
            workspace_id,
            repo_id,
            path,
            base_ref,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::worktree_diff(&state.config_dir, &repo, &path, &base_ref, token).await?)
        }
        BridgeCommand::WorktreeFileDiff {
            workspace_id,
            repo_id,
            path,
            base_ref,
            relative_path,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(
                vcs::worktree_file_diff(
                    &state.config_dir,
                    &repo,
                    &path,
                    &base_ref,
                    &relative_path,
                    token,
                )
                .await?,
            )
        }
        BridgeCommand::BranchWorkingDiff {
            workspace_id,
            repo_id,
            base_ref,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::branch_working_diff(&repo, &base_ref, token).await?)
        }
        BridgeCommand::BranchWorkingFileDiff {
            workspace_id,
            repo_id,
            base_ref,
            relative_path,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::branch_working_file_diff(&repo, &base_ref, &relative_path, token).await?)
        }
        BridgeCommand::Subtrees {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::subtrees(&repo, token).await?)
        }
        BridgeCommand::SubtreeOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::subtree_operation(&repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Submodules {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::submodules(&repo, token).await?)
        }
        BridgeCommand::SubmoduleOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::submodule_operation(&repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::SvnOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::svn_operation(&repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::BranchCompare {
            workspace_id,
            repo_id,
            base,
            target,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::branch_compare(&repo, &base, &target, token).await?)
        }
        BridgeCommand::Remotes {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::remotes(&repo, token).await?)
        }
        BridgeCommand::RemoteOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::remote_operation(&repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Conflicts { workspace_id } => {
            let descriptor = state.workspace(&workspace_id).await?;
            let settings = state.app.read().await.settings.clone();
            let snapshot =
                workspace::snapshot(descriptor, state.next_generation(), &settings, token).await?;
            let files = snapshot
                .repositories
                .iter()
                .flat_map(|repository| {
                    repository
                        .files
                        .iter()
                        .filter(|file| file.conflicted)
                        .map(|file| ConflictFile {
                            repo_id: repository.meta.id.clone(),
                            repo_name: repository.meta.name.clone(),
                            repo_color: repository.meta.color.clone(),
                            path: file.path.clone(),
                            kind: repository.meta.kind,
                            binary: std::fs::read(
                                Path::new(&repository.meta.root_path).join(&file.path),
                            )
                            .is_ok_and(|bytes| vcs::bytes_are_binary(&bytes)),
                            conflict_type: file
                                .conflict_type
                                .clone()
                                .unwrap_or_else(|| "text".into()),
                            actions: if file.conflict_type.as_deref().is_some_and(|kind| {
                                kind == "property" || kind == "tree" || kind == "obstruction"
                            }) {
                                vec!["working".into()]
                            } else {
                                vec!["mine".into(), "theirs".into(), "working".into()]
                            },
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            json(files)
        }
        BridgeCommand::ConflictVersions {
            workspace_id,
            repo_id,
            relative_path,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(vcs::conflict_versions(&repo, &relative_path, token).await?)
        }
        BridgeCommand::ConflictSave {
            workspace_id,
            repo_id,
            relative_path,
            content,
            expected_fingerprint,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::conflict_save(
                    &repo,
                    &relative_path,
                    &content,
                    &expected_fingerprint,
                    token,
                )
                .await
            })
            .await?;
            json(true)
        }
        BridgeCommand::ConflictAccept {
            workspace_id,
            repo_id,
            relative_path,
            choice,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::conflict_accept(&repo, &relative_path, choice, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::AbortRepositoryOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, async {
                vcs::abort_operation(&repo, &operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::GitIdentity {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            if repo.kind != VcsKind::Git {
                return Err(DesktopError::new(
                    "UNSUPPORTED_OPERATION",
                    "Git identity is only available for Git repositories",
                    false,
                ));
            }
            json(identity::state(&state.config_dir, &repo, token).await?)
        }
        BridgeCommand::GitProfileOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            if repo.kind != VcsKind::Git {
                return Err(DesktopError::new(
                    "UNSUPPORTED_OPERATION",
                    "Git identity is only available for Git repositories",
                    false,
                ));
            }
            json(identity::operate(&state.config_dir, &repo, operation, token).await?)
        }
        BridgeCommand::SvnAccount {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            if repo.kind != VcsKind::Svn {
                return Err(DesktopError::new(
                    "UNSUPPORTED_OPERATION",
                    "SVN account is only available for SVN repositories",
                    false,
                ));
            }
            json(svn_account::state(&state.config_dir, &repo, token).await?)
        }
        BridgeCommand::SvnAccountOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            if repo.kind != VcsKind::Svn {
                return Err(DesktopError::new(
                    "UNSUPPORTED_OPERATION",
                    "SVN account is only available for SVN repositories",
                    false,
                ));
            }
            json(svn_account::operate(&state.config_dir, &repo, operation, token).await?)
        }
        BridgeCommand::FileHistory {
            workspace_id,
            repo_id,
            relative_path,
            cursor,
            limit,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(vcs::file_history(&repo, &relative_path, cursor.as_deref(), limit, token).await?)
        }
        BridgeCommand::FileRevisionContent {
            workspace_id,
            repo_id,
            relative_path,
            revision,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(vcs::file_revision_content(&repo, &relative_path, &revision, token).await?)
        }
    }
}

fn launch_external_editor(
    editor: &crate::models::ExternalEditor,
    repo: &crate::models::RepositoryMeta,
    relative_path: &str,
    target: &Path,
) -> Result<(), DesktopError> {
    let (executable, args) = external_editor_command(editor, repo, relative_path, target)?;
    let mut child = tokio::process::Command::new(executable)
        .args(args)
        .current_dir(&repo.root_path)
        .kill_on_drop(false)
        .spawn()
        .map_err(|error| DesktopError::new("EXTERNAL_EDITOR_FAILED", error.to_string(), true))?;
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

fn external_editor_command(
    editor: &crate::models::ExternalEditor,
    repo: &crate::models::RepositoryMeta,
    relative_path: &str,
    target: &Path,
) -> Result<(String, Vec<String>), DesktopError> {
    let executable = editor.executable.trim();
    if executable.is_empty()
        || executable.len() > 16 * 1024
        || executable.contains(['\0', '\r', '\n'])
        || editor.args.len() > 128
        || editor
            .args
            .iter()
            .any(|argument| argument.len() > 16 * 1024 || argument.contains('\0'))
    {
        return Err(DesktopError::new(
            "INVALID_EXTERNAL_EDITOR",
            "External editor configuration is invalid",
            false,
        ));
    }
    let path = target.to_string_lossy();
    let mut args = editor
        .args
        .iter()
        .map(|argument| {
            argument
                .replace("{path}", &path)
                .replace("{relativePath}", relative_path)
                .replace("{repo}", &repo.root_path)
        })
        .collect::<Vec<_>>();
    if !editor.args.iter().any(|argument| {
        argument.contains("{path}")
            || argument.contains("{relativePath}")
            || argument.contains("{repo}")
    }) {
        args.push(path.into_owned());
    }
    Ok((executable.to_string(), args))
}

async fn resolve_repo(
    state: &AppState,
    workspace_id: &str,
    repo_id: &str,
) -> Result<crate::models::RepositoryMeta, DesktopError> {
    let descriptor = state.workspace(workspace_id).await?;
    let repo = workspace::repository(&descriptor, repo_id)?;
    if repo.kind == VcsKind::Svn {
        svn_account::hydrate(
            &state.config_dir,
            &repo,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await;
    }
    Ok(repo)
}

async fn with_write<T, F>(state: &AppState, repo_id: &str, operation: F) -> Result<T, DesktopError>
where
    F: std::future::Future<Output = Result<T, DesktopError>>,
{
    let lock = state.write_lock(repo_id).await;
    let _guard = lock.lock().await;
    operation.await
}

fn json<T: serde::Serialize>(value: T) -> Result<serde_json::Value, DesktopError> {
    serde_json::to_value(value)
        .map_err(|error| DesktopError::new("SERIALIZATION_FAILED", error.to_string(), false))
}

fn url_encode(input: &str) -> String {
    let mut encoded = String::new();
    for byte in input.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

fn paths_match(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut a_sorted = a.to_vec();
    let mut b_sorted = b.to_vec();
    a_sorted.sort();
    b_sorted.sort();
    a_sorted == b_sorted
}

const TAB_SNAP_MARGIN: f64 = 40.0;
const TAB_BAR_HEIGHT: f64 = 42.0;

fn point_in_tab_snap_zone(
    point_x: f64,
    point_y: f64,
    window_x: f64,
    window_y: f64,
    window_width: f64,
) -> bool {
    point_x.is_finite()
        && point_y.is_finite()
        && window_x.is_finite()
        && window_y.is_finite()
        && window_width.is_finite()
        && window_width > 0.0
        && point_x >= window_x - TAB_SNAP_MARGIN
        && point_x <= window_x + window_width + TAB_SNAP_MARGIN
        && point_y >= window_y - TAB_SNAP_MARGIN
        && point_y <= window_y + TAB_BAR_HEIGHT + TAB_SNAP_MARGIN
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ExternalEditor, VcsKind};

    #[test]
    fn tab_drop_only_snaps_near_the_target_title_bar() {
        assert!(point_in_tab_snap_zone(500.0, 120.0, 100.0, 100.0, 900.0));
        assert!(point_in_tab_snap_zone(70.0, 80.0, 100.0, 100.0, 900.0));
        assert!(!point_in_tab_snap_zone(500.0, 220.0, 100.0, 100.0, 900.0));
        assert!(!point_in_tab_snap_zone(20.0, 120.0, 100.0, 100.0, 900.0));
    }

    fn repo(root: &Path) -> crate::models::RepositoryMeta {
        crate::models::RepositoryMeta {
            id: "repo".into(),
            name: "repo".into(),
            root_path: root.to_string_lossy().into_owned(),
            color: "#000".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        }
    }

    #[test]
    fn external_editor_uses_argument_templates_without_shell_joining() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("hello world 中文.txt");
        let command = external_editor_command(
            &ExternalEditor {
                executable: "/usr/bin/editor".into(),
                args: vec!["--goto".into(), "{path}:12".into(), "{relativePath}".into()],
            },
            &repo(root.path()),
            "hello world 中文.txt",
            &target,
        )
        .unwrap();
        assert_eq!(command.0, "/usr/bin/editor");
        assert_eq!(
            command.1,
            vec![
                "--goto",
                &format!("{}:12", target.to_string_lossy()),
                "hello world 中文.txt"
            ]
        );
    }

    #[test]
    fn external_editor_rejects_control_characters() {
        let root = tempfile::tempdir().unwrap();
        let result = external_editor_command(
            &ExternalEditor {
                executable: "editor\nmalicious".into(),
                args: vec![],
            },
            &repo(root.path()),
            "file.txt",
            &root.path().join("file.txt"),
        );
        assert_eq!(result.unwrap_err().code, "INVALID_EXTERNAL_EDITOR");
    }
}
