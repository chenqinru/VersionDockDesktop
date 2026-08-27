use std::path::Path;

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

use crate::{
    changelist, identity,
    models::{
        BootstrapData, BridgeCommand, ConflictFile, DesktopCapabilities, DesktopError,
        ProgressEvent, RequestEnvelope, ResponseEnvelope, VcsKind,
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
pub async fn bridge_request(
    envelope: RequestEnvelope,
    app: AppHandle,
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
    let mut result = dispatch(envelope.command, &app, &state, &token).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ExternalEditor, VcsKind};

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
