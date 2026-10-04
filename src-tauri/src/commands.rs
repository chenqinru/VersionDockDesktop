use std::{collections::HashSet, path::Path};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::{
    changelist, cli, identity,
    models::{
        BootstrapData, BridgeCommand, CapabilityStatus, CheckoutRepositoryResult,
        CloneRepositoryResult, ConflictFile, ConflictResolutionResult, DesktopCapabilities,
        DesktopError, InitializeRepositoryResult, NotificationPermissionState, OperationEvent,
        OperationStatus, RefreshScope, RepositoryEvent, RepositoryEventSource, RequestEnvelope,
        ResponseEnvelope, RuntimeCapabilities, VcsKind, WindowTabImport,
        WindowTabTransferCompleted,
    },
    provider, shelf,
    state::{self, AppState, OperationReporter},
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
                if preview.is_visible().unwrap_or(false)
                    && last_broadcast.elapsed() >= std::time::Duration::from_millis(16)
                {
                    let scale = preview.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
                    let target =
                        crate::tab_drag::drop_target(&app, &source_window_label, None).await;
                    let target_window_label = target.as_ref().map(|target| target.label.clone());
                    let target_client_x = target.map(|target| target.client_x);
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
    let command = envelope.command;
    let (phase, message) = command_progress(&command);
    let error_context = command_error_context(&command);
    let context = envelope.context.clone();
    let started_at = chrono::Utc::now().to_rfc3339();
    let token = state.register_request(&request_id).await;
    let _ = app.emit(
        "versiondock://event",
        OperationEvent {
            operation_id: request_id.clone(),
            context: context.clone(),
            status: OperationStatus::Queued,
            phase: "queued".into(),
            message: "Waiting to start operation".into(),
            started_at: started_at.clone(),
            cancellable: true,
            completed: None,
            total: None,
            result: None,
            error: None,
        },
    );
    let reporter = OperationReporter {
        app: app.clone(),
        operation_id: request_id.clone(),
        context: context.clone(),
        started_at: started_at.clone(),
    };
    let waits_for_coordinator = error_context.2.is_some()
        || matches!(
            command,
            BridgeCommand::WorkspaceOpen { .. }
                | BridgeCommand::WorkspaceRefresh { .. }
                | BridgeCommand::BatchCommit { .. }
                | BridgeCommand::Conflicts { .. }
        );
    let log_context = crate::logger::LogContext {
        workspace_id: context.workspace_id.clone(),
        repository_id: context.repository_id.clone(),
        operation_id: Some(request_id.clone()),
        workspace_name: match &context.workspace_id {
            Some(id) => state
                .workspace(id)
                .await
                .ok()
                .map(|workspace| workspace.name),
            None => None,
        },
        repository_name: match (&context.workspace_id, &context.repository_id) {
            (Some(workspace), Some(repository)) => state
                .cached_repositories(workspace)
                .await
                .into_iter()
                .find(|repo| &repo.id == repository)
                .map(|repo| repo.name),
            _ => None,
        },
    };
    let mut result = crate::logger::with_log_context(
        log_context,
        state::with_operation_reporter(reporter, async {
            if !waits_for_coordinator {
                state::emit_current_operation(OperationStatus::Running, phase, message);
            }
            match validate_request_context(&context, &error_context) {
                Ok(()) => {
                    // `dispatch` contains every command branch, so its debug-build future is larger
                    // than Tokio's default worker stack. Keep it on the heap or Bootstrap can abort
                    // the process with a stack overflow before the first window finishes loading.
                    Box::pin(dispatch(
                        command.clone(),
                        &app,
                        &window,
                        &state,
                        &token,
                        &request_id,
                        &context,
                        &started_at,
                    ))
                    .await
                }
                Err(error) => Err(error),
            }
        }),
    )
    .await;
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
    let status = match &result {
        Ok(value)
            if value.get("status").and_then(|item| item.as_str()) == Some("partialFailure")
                || value
                    .get("failures")
                    .and_then(|item| item.as_array())
                    .is_some_and(|items| !items.is_empty()) =>
        {
            OperationStatus::Partial
        }
        Ok(value)
            if value.as_array().is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item.get("error").is_some_and(|error| !error.is_null()))
            }) =>
        {
            OperationStatus::Partial
        }
        Ok(_) => OperationStatus::Succeeded,
        Err(error) if error.code == "REQUEST_CANCELLED" => OperationStatus::Cancelled,
        Err(error) if error.code == "COMMAND_TIMEOUT" || error.code == "REQUEST_TIMEOUT" => {
            OperationStatus::TimedOut
        }
        Err(_) => OperationStatus::Failed,
    };
    let event_error = result.as_ref().err().cloned();
    let result_summary = match &result {
        Ok(value) if value.as_array().is_some() => {
            let items = value.as_array().expect("array checked");
            let failed = items
                .iter()
                .filter(|item| item.get("error").is_some_and(|error| !error.is_null()))
                .count() as u32;
            Some(crate::models::OperationResultSummary {
                summary: if failed > 0 {
                    "Partial success"
                } else {
                    "Completed"
                }
                .into(),
                succeeded: items.len() as u32 - failed,
                failed,
            })
        }
        Ok(value) => {
            let partial = value.get("status").and_then(|item| item.as_str())
                == Some("partialFailure")
                || value
                    .get("failures")
                    .and_then(|item| item.as_array())
                    .is_some_and(|items| !items.is_empty());
            Some(crate::models::OperationResultSummary {
                summary: if partial {
                    "Partial success"
                } else {
                    "Completed"
                }
                .into(),
                succeeded: u32::from(!partial),
                failed: u32::from(partial),
            })
        }
        Err(_) => Some(crate::models::OperationResultSummary {
            summary: "Failed".into(),
            succeeded: 0,
            failed: 1,
        }),
    };
    if result.is_ok()
        || matches!(
            command,
            BridgeCommand::ContinueRepositoryOperation { .. }
                | BridgeCommand::AbortRepositoryOperation { .. }
        )
    {
        emit_refresh_events(app.clone(), state.inner(), &command, &result);
    }
    let _ = app.emit(
        "versiondock://event",
        OperationEvent {
            operation_id: request_id.clone(),
            context,
            phase: match status {
                OperationStatus::Succeeded => "completed",
                OperationStatus::Partial => "partial",
                OperationStatus::Cancelled => "cancelled",
                OperationStatus::TimedOut => "timedOut",
                OperationStatus::Failed => "failed",
                _ => "completed",
            }
            .into(),
            message: match status {
                OperationStatus::Succeeded => "Operation completed",
                OperationStatus::Partial => "Operation partially completed",
                OperationStatus::Cancelled => "Operation cancelled",
                OperationStatus::TimedOut => "Operation timed out",
                OperationStatus::Failed => "Operation failed",
                _ => "Operation completed",
            }
            .into(),
            status,
            started_at,
            cancellable: false,
            completed: matches!(command, BridgeCommand::BatchCommit { .. }).then(|| {
                result_summary
                    .as_ref()
                    .map_or(0, |summary| summary.succeeded + summary.failed)
            }),
            total: matches!(command, BridgeCommand::BatchCommit { .. }).then(|| {
                result_summary
                    .as_ref()
                    .map_or(0, |summary| summary.succeeded + summary.failed)
            }),
            result: result_summary,
            error: event_error,
        },
    );
    Ok(match result {
        Ok(value) => ResponseEnvelope::success(request_id, value),
        Err(error) => ResponseEnvelope::failure(request_id, error),
    })
}

fn validate_request_context(
    context: &crate::models::RequestContext,
    command: &(String, Option<String>, Option<String>, Option<String>),
) -> Result<(), DesktopError> {
    if context.workspace_id.is_some() && command.1.is_some() && context.workspace_id != command.1 {
        return Err(DesktopError::new(
            "REQUEST_CONTEXT_MISMATCH",
            "Request workspace context does not match the command target",
            false,
        ));
    }
    if context.repository_id.is_some() && command.2.is_some() && context.repository_id != command.2
    {
        return Err(DesktopError::new(
            "REQUEST_CONTEXT_MISMATCH",
            "Request repository context does not match the command target",
            false,
        ));
    }
    Ok(())
}

fn command_resolved_refresh_scopes(
    command: &BridgeCommand,
    result: &Result<serde_json::Value, DesktopError>,
) -> Vec<RefreshScope> {
    let mut scopes = command_refresh_scopes(command);
    if matches!(
        command,
        BridgeCommand::ConflictSave { .. } | BridgeCommand::ConflictAccept { .. }
    ) {
        if let Ok(value) = result {
            if value
                .get("autoCommitted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                scopes.push(RefreshScope::Refs);
                scopes.push(RefreshScope::History);
                scopes.push(RefreshScope::Unpushed);
            }
        }
    }
    scopes
}

fn emit_refresh_events(
    app: AppHandle,
    state: &AppState,
    command: &BridgeCommand,
    result: &Result<serde_json::Value, DesktopError>,
) {
    let (_, workspace_id, repository_id, _) = command_error_context(command);
    let Some(workspace_id) = workspace_id else {
        return;
    };
    let scopes = command_resolved_refresh_scopes(command, result);
    if scopes.is_empty() {
        return;
    }
    let generation = state.next_generation();
    if matches!(command, BridgeCommand::BatchCommit { .. }) {
        if let Ok(value) = result {
            for repository_id in value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item.get("repoId").and_then(|id| id.as_str()))
            {
                let _ = app.emit(
                    "versiondock://event",
                    RepositoryEvent {
                        workspace_id: workspace_id.clone(),
                        repo_id: Some(repository_id.into()),
                        generation,
                        source: RepositoryEventSource::Operation,
                        scopes: scopes.clone(),
                    },
                );
            }
        }
        return;
    }
    let _ = app.emit(
        "versiondock://event",
        RepositoryEvent {
            workspace_id,
            repo_id: repository_id,
            generation,
            source: RepositoryEventSource::Operation,
            scopes,
        },
    );
}

fn command_refresh_scopes(command: &BridgeCommand) -> Vec<RefreshScope> {
    match command {
        BridgeCommand::InitializeRepository { .. } => vec![RefreshScope::WorkspaceSnapshot],
        BridgeCommand::Stage { .. } | BridgeCommand::Unstage { .. } => vec![
            RefreshScope::Index,
            RefreshScope::Status,
            RefreshScope::Diff,
        ],
        BridgeCommand::Discard { .. }
        | BridgeCommand::DeletePaths { .. }
        | BridgeCommand::AddIgnore { .. }
        | BridgeCommand::UpdateIgnoreRules { .. } => vec![RefreshScope::Status, RefreshScope::Diff],
        BridgeCommand::AiComposerApply { .. }
        | BridgeCommand::Commit { .. }
        | BridgeCommand::BatchCommit { .. } => vec![
            RefreshScope::Status,
            RefreshScope::Refs,
            RefreshScope::History,
            RefreshScope::Unpushed,
        ],
        BridgeCommand::Sync { .. }
        | BridgeCommand::BranchOperation { .. }
        | BridgeCommand::BranchRecovery { .. }
        | BridgeCommand::TagOperation { .. }
        | BridgeCommand::HistoryOperation { .. }
        | BridgeCommand::UnpushedOperation { .. } => vec![
            RefreshScope::Status,
            RefreshScope::Refs,
            RefreshScope::History,
            RefreshScope::Conflicts,
            RefreshScope::Unpushed,
        ],
        BridgeCommand::ConflictSave { .. }
        | BridgeCommand::ConflictAccept { .. }
        | BridgeCommand::AbortRepositoryOperation { .. }
        | BridgeCommand::RestoreConflicts { .. }
        | BridgeCommand::GitUnlockIndex { .. } => vec![
            RefreshScope::Status,
            RefreshScope::Diff,
            RefreshScope::Operation,
            RefreshScope::Conflicts,
        ],
        BridgeCommand::ContinueRepositoryOperation { .. } => vec![
            RefreshScope::Status,
            RefreshScope::Diff,
            RefreshScope::Operation,
            RefreshScope::Conflicts,
            RefreshScope::Refs,
            RefreshScope::History,
            RefreshScope::Unpushed,
        ],
        BridgeCommand::StashOperation { .. }
        | BridgeCommand::ShelfOperation { .. }
        | BridgeCommand::ChangelistOperation { .. } => {
            vec![RefreshScope::Status, RefreshScope::Diff]
        }
        BridgeCommand::WorktreeOperation {
            operation:
                crate::models::WorktreeOperation::Create { .. }
                | crate::models::WorktreeOperation::Remove { .. }
                | crate::models::WorktreeOperation::Prune,
            ..
        } => vec![RefreshScope::WorkspaceSnapshot, RefreshScope::Worktrees],
        BridgeCommand::WorktreeOperation { .. } => vec![RefreshScope::Worktrees],
        BridgeCommand::SubtreeOperation {
            operation:
                crate::models::SubtreeOperation::Register { .. }
                | crate::models::SubtreeOperation::Edit { .. }
                | crate::models::SubtreeOperation::DeleteRegistry { .. },
            ..
        } => vec![RefreshScope::Subtrees],
        BridgeCommand::SubtreeOperation { .. } => vec![
            RefreshScope::Status,
            RefreshScope::Diff,
            RefreshScope::Refs,
            RefreshScope::History,
            RefreshScope::Unpushed,
            RefreshScope::Subtrees,
        ],
        BridgeCommand::SubmoduleOperation {
            operation:
                crate::models::SubmoduleOperation::Add { .. }
                | crate::models::SubmoduleOperation::Init { .. }
                | crate::models::SubmoduleOperation::Deinit { .. }
                | crate::models::SubmoduleOperation::Update { init: true, .. }
                | crate::models::SubmoduleOperation::UpdateAll { init: true, .. }
                | crate::models::SubmoduleOperation::Remove { .. },
            ..
        } => vec![RefreshScope::WorkspaceSnapshot, RefreshScope::Submodules],
        BridgeCommand::SubmoduleOperation { .. } => vec![
            RefreshScope::Status,
            RefreshScope::Refs,
            RefreshScope::History,
            RefreshScope::Unpushed,
            RefreshScope::Submodules,
        ],
        BridgeCommand::RemoteOperation { .. }
        | BridgeCommand::PublishRepository { .. }
        | BridgeCommand::GitProfileOperation { .. }
        | BridgeCommand::SvnAccountOperation { .. } => vec![RefreshScope::Status],
        BridgeCommand::SvnOperation { .. } => vec![
            RefreshScope::Status,
            RefreshScope::Diff,
            RefreshScope::Conflicts,
            RefreshScope::SvnRevision,
            RefreshScope::History,
        ],
        _ => Vec::new(),
    }
}

fn emit_operation_phase(
    app: &AppHandle,
    operation_id: &str,
    context: &crate::models::RequestContext,
    started_at: &str,
    phase: &str,
    message: &str,
    completed: Option<u32>,
    total: Option<u32>,
) {
    let _ = app.emit(
        "versiondock://event",
        OperationEvent {
            operation_id: operation_id.into(),
            context: context.clone(),
            status: OperationStatus::Running,
            phase: phase.into(),
            message: message.into(),
            started_at: started_at.into(),
            cancellable: true,
            completed,
            total,
            result: None,
            error: None,
        },
    );
}

fn tool_capability(available: bool, tool: &str, version: Option<&str>) -> CapabilityStatus {
    if available {
        CapabilityStatus {
            available: true,
            reason_code: None,
            detail: version.map(|value| format!("{tool} {value}")),
        }
    } else {
        CapabilityStatus::unavailable(
            "VCS_TOOL_UNAVAILABLE",
            format!("{tool} is not installed or cannot be executed"),
        )
    }
}

fn system_notification_capability() -> CapabilityStatus {
    CapabilityStatus::unavailable(
        "SYSTEM_NOTIFICATIONS_DISABLED",
        "Notifications are displayed only inside VersionDock",
    )
}

async fn runtime_capabilities() -> RuntimeCapabilities {
    RuntimeCapabilities {
        notification_permission: NotificationPermissionState::Unavailable,
        system_notifications: system_notification_capability(),
        secure_credentials: svn_account::secure_store_capability().await,
    }
}

fn command_progress(command: &BridgeCommand) -> (&'static str, &'static str) {
    match command {
        BridgeCommand::AiComposerApply { .. } => ("aiCompose", "Applying AI commit plan"),
        BridgeCommand::AiComposerPrepare { .. } => ("aiPrepare", "Preparing AI change units"),
        BridgeCommand::WorkspaceOpen { .. } | BridgeCommand::WorkspaceRefresh { .. } => {
            ("scanning", "Scanning workspace repositories")
        }
        BridgeCommand::InitializeRepository { .. } => {
            ("initializing", "Initializing Git repository")
        }
        BridgeCommand::CloneRepository { .. } => ("cloning", "Cloning Git repository"),
        BridgeCommand::CheckoutSvnRepository { .. } => ("checkout", "Checking out SVN repository"),
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
        BridgeCommand::CommitSafetyCheck { .. } => ("safetyCheck", "Checking commit safety"),
        BridgeCommand::Commit { .. } | BridgeCommand::BatchCommit { .. } => {
            ("commit", "Creating repository commit")
        }
        BridgeCommand::Sync { .. } => ("sync", "Synchronizing repository"),
        BridgeCommand::ProviderAccounts
        | BridgeCommand::ProviderRepositories { .. }
        | BridgeCommand::ProviderNamespaces { .. }
        | BridgeCommand::ResolveAuthorAvatar { .. } => ("provider", "Loading remote provider data"),
        BridgeCommand::ProviderGithubBegin { .. }
        | BridgeCommand::ProviderGithubComplete { .. }
        | BridgeCommand::ProviderGithubSave { .. }
        | BridgeCommand::ProviderGitlabSave { .. }
        | BridgeCommand::ProviderGiteeSave { .. }
        | BridgeCommand::ProviderRemove { .. } => {
            ("providerAuth", "Updating remote provider account")
        }
        BridgeCommand::PublishRepository { .. } => ("publish", "Publishing repository"),
        BridgeCommand::RecentCommitMessages { .. } | BridgeCommand::LastCommitMessage { .. } => {
            ("commitMessages", "Loading commit messages")
        }
        BridgeCommand::History { .. }
        | BridgeCommand::HistoryTopology { .. }
        | BridgeCommand::FileHistory { .. }
        | BridgeCommand::UnpushedChanges { .. }
        | BridgeCommand::IncomingChanges { .. } => ("history", "Loading repository history"),
        BridgeCommand::BranchRecovery { .. } => ("branchRecovery", "Recovering branch operation"),
        BridgeCommand::ConflictSave { .. }
        | BridgeCommand::ConflictAccept { .. }
        | BridgeCommand::AbortRepositoryOperation { .. }
        | BridgeCommand::ContinueRepositoryOperation { .. }
        | BridgeCommand::RestoreConflicts { .. } => ("conflict", "Updating conflict state"),
        BridgeCommand::GitUnlockIndex { .. } => ("index", "Unlocking Git index"),
        BridgeCommand::GitIdentity { .. } | BridgeCommand::GitProfileOperation { .. } => {
            ("identity", "Resolving Git identity")
        }
        BridgeCommand::SvnAccount { .. } | BridgeCommand::SvnAccountOperation { .. } => {
            ("authentication", "Checking SVN authentication")
        }
        BridgeCommand::Submodules { .. } | BridgeCommand::SubmoduleOperation { .. } => {
            ("submodule", "Updating Git submodule state")
        }
        BridgeCommand::Subtrees { .. }
        | BridgeCommand::SubtreeStatuses { .. }
        | BridgeCommand::SubtreeOperation { .. } => ("subtree", "Updating Git subtree state"),
        BridgeCommand::SvnOperation { .. } => ("svn", "Updating SVN working copy"),
        BridgeCommand::UnpushedOperation { .. } => ("history", "Updating unpushed commit history"),
        BridgeCommand::UpdateSettings { .. }
        | BridgeCommand::UpdateLayout { .. }
        | BridgeCommand::SaveAppState { .. }
        | BridgeCommand::SaveCommitSelections { .. } => {
            ("persisting", "Saving application settings")
        }
        _ => ("running", "Running repository operation"),
    }
}

fn sync_phase(action: &crate::models::SyncAction) -> (&'static str, &'static str) {
    match action {
        crate::models::SyncAction::Fetch => ("fetching", "Fetching remote references"),
        crate::models::SyncAction::Pull => ("pulling", "Pulling repository changes"),
        crate::models::SyncAction::PullRebase => {
            ("pullingRebase", "Pulling and rebasing repository changes")
        }
        crate::models::SyncAction::PullFfOnly => (
            "pulling",
            "Pulling repository changes with fast-forward only",
        ),
        crate::models::SyncAction::Push => ("pushing", "Pushing repository changes"),
        crate::models::SyncAction::PushTags => ("pushingTags", "Pushing repository tags"),
        crate::models::SyncAction::Update => ("updating", "Updating SVN working copy"),
    }
}

fn svn_phase(operation: &crate::models::SvnOperation) -> (&'static str, &'static str) {
    match operation {
        crate::models::SvnOperation::RemoveIgnoreEntries { .. } => {
            ("svnIgnore", "Removing SVN ignore entries")
        }
        crate::models::SvnOperation::Cleanup { .. } => ("svnCleanup", "Cleaning SVN working copy"),
        crate::models::SvnOperation::ResolveWorking { .. } => {
            ("svnResolve", "Resolving SVN conflicts")
        }
        crate::models::SvnOperation::Lock { .. } => ("svnLock", "Locking SVN paths"),
        crate::models::SvnOperation::Unlock { .. } => ("svnUnlock", "Unlocking SVN paths"),
        crate::models::SvnOperation::Relocate { .. } => {
            ("svnRelocate", "Relocating SVN working copy")
        }
        crate::models::SvnOperation::Switch { .. } => ("svnSwitch", "Switching SVN working copy"),
        crate::models::SvnOperation::Copy { .. } => ("svnCopy", "Creating SVN branch or tag"),
    }
}

fn submodule_phase(operation: &crate::models::SubmoduleOperation) -> (&'static str, &'static str) {
    match operation {
        crate::models::SubmoduleOperation::Add { .. } => ("submoduleAdd", "Adding submodule"),
        crate::models::SubmoduleOperation::Init { .. } => {
            ("submoduleInit", "Initializing submodule")
        }
        crate::models::SubmoduleOperation::Update { .. } => {
            ("submoduleUpdate", "Updating submodule")
        }
        crate::models::SubmoduleOperation::Deinit { .. } => {
            ("submoduleDeinit", "Deinitializing submodule")
        }
        crate::models::SubmoduleOperation::Sync { .. } => {
            ("submoduleSync", "Synchronizing submodule URLs")
        }
        crate::models::SubmoduleOperation::UpdateAll { .. } => {
            ("submoduleUpdateAll", "Updating all submodules")
        }
        crate::models::SubmoduleOperation::Remove { .. } => {
            ("submoduleRemove", "Removing submodule")
        }
        crate::models::SubmoduleOperation::ResolveConflict { .. } => {
            ("submoduleResolve", "Resolving submodule conflict")
        }
        crate::models::SubmoduleOperation::Push { .. } => {
            ("submodulePush", "Pushing submodule commits")
        }
        crate::models::SubmoduleOperation::Pull { .. } => {
            ("submodulePull", "Pulling submodule commits")
        }
    }
}

fn subtree_phase(operation: &crate::models::SubtreeOperation) -> (&'static str, &'static str) {
    match operation {
        crate::models::SubtreeOperation::Add { .. } => ("subtreeAdd", "Adding subtree"),
        crate::models::SubtreeOperation::Pull { .. } => ("subtreePull", "Pulling subtree"),
        crate::models::SubtreeOperation::Push { .. } => ("subtreePush", "Pushing subtree"),
        crate::models::SubtreeOperation::Register { .. } => {
            ("subtreeRegister", "Registering subtree")
        }
        crate::models::SubtreeOperation::Edit { .. } => {
            ("subtreeEdit", "Updating subtree registration")
        }
        crate::models::SubtreeOperation::DeleteRegistry { .. } => {
            ("subtreeDelete", "Deleting subtree registration")
        }
        crate::models::SubtreeOperation::RemoveFiles { .. } => {
            ("subtreeRemove", "Removing subtree files")
        }
        crate::models::SubtreeOperation::Split { .. } => {
            ("subtreeSplit", "Splitting subtree history")
        }
        crate::models::SubtreeOperation::Merge { .. } => {
            ("subtreeMerge", "Merging subtree revision")
        }
    }
}

fn command_error_context(
    command: &BridgeCommand,
) -> (String, Option<String>, Option<String>, Option<String>) {
    let operation = command_progress(command).0.to_string();
    match command {
        BridgeCommand::WorkspaceRemoveRecent { workspace_id }
        | BridgeCommand::WorkspaceRefresh { workspace_id }
        | BridgeCommand::SaveCommitSelections { workspace_id, .. }
        | BridgeCommand::InitializeRepository { workspace_id, .. } => {
            (operation, Some(workspace_id.clone()), None, None)
        }
        BridgeCommand::Conflicts {
            workspace_id,
            repo_id,
        } => (operation, Some(workspace_id.clone()), repo_id.clone(), None),
        BridgeCommand::AiComposerApply {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::AiComposerPrepare {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::RepositoryStatus {
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
        | BridgeCommand::SubtreeStatuses {
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
        | BridgeCommand::UnpushedChanges {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::IncomingChanges {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::CreatePatch {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::SavePatch {
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
        }
        | BridgeCommand::ContinueRepositoryOperation {
            workspace_id,
            repo_id,
            ..
        }
        | BridgeCommand::RestoreConflicts {
            workspace_id,
            repo_id,
        }
        | BridgeCommand::GitUnlockIndex {
            workspace_id,
            repo_id,
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
        | BridgeCommand::BranchRecovery {
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
        BridgeCommand::CommitSafetyCheck {
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
    operation_id: &str,
    request_context: &crate::models::RequestContext,
    started_at: &str,
) -> Result<serde_json::Value, DesktopError> {
    match command {
        BridgeCommand::Bootstrap => {
            let mut snapshot = state.app.read().await.clone();
            for workspace in &mut snapshot.recent_workspaces {
                workspace.available = workspace.paths.iter().all(|path| Path::new(path).is_dir());
            }
            let tools = workspace::tool_availability(token).await;
            state.cache_tools(tools.clone()).await;
            let runtime = runtime_capabilities().await;
            let secure_credentials = runtime.secure_credentials.clone();
            let notification_status = runtime.system_notifications.clone();
            let notifications_available = notification_status.available;
            let mut availability = std::collections::BTreeMap::new();
            availability.insert("systemNotifications".into(), notification_status);
            availability.insert(
                "secureCredentials".into(),
                secure_credentials.status.clone(),
            );
            for key in [
                "stash",
                "worktree",
                "subtree",
                "submodule",
                "remoteManagement",
                "identity",
            ] {
                availability.insert(
                    key.into(),
                    tool_capability(tools.git, "Git", tools.git_version.as_deref()),
                );
            }
            for key in ["initializeRepository", "cloneRepository"] {
                availability.insert(
                    key.into(),
                    tool_capability(tools.git, "Git", tools.git_version.as_deref()),
                );
            }
            availability.insert(
                "githubProvider".into(),
                if secure_credentials.status.available {
                    CapabilityStatus::available()
                } else {
                    CapabilityStatus::unavailable(
                        "SECURE_STORAGE_UNAVAILABLE",
                        "System secure storage is unavailable",
                    )
                },
            );
            availability.insert(
                "githubDeviceFlow".into(),
                if provider::github_available() && secure_credentials.status.available {
                    CapabilityStatus::available()
                } else {
                    CapabilityStatus::unavailable(
                        if provider::github_available() {
                            "SECURE_STORAGE_UNAVAILABLE"
                        } else {
                            "GITHUB_CLIENT_ID_MISSING"
                        },
                        if provider::github_available() {
                            "System secure storage is unavailable"
                        } else {
                            "GitHub OAuth client ID is not configured"
                        },
                    )
                },
            );
            availability.insert(
                "gitlabProvider".into(),
                if secure_credentials.status.available {
                    CapabilityStatus::available()
                } else {
                    CapabilityStatus::unavailable(
                        "SECURE_STORAGE_UNAVAILABLE",
                        "System secure storage is unavailable",
                    )
                },
            );
            availability.insert(
                "giteeProvider".into(),
                if secure_credentials.status.available {
                    CapabilityStatus::available()
                } else {
                    CapabilityStatus::unavailable(
                        "SECURE_STORAGE_UNAVAILABLE",
                        "System secure storage is unavailable",
                    )
                },
            );
            availability.insert(
                "svnAccount".into(),
                tool_capability(tools.svn, "SVN", tools.svn_version.as_deref()),
            );
            let vcs_available = tools.git || tools.svn;
            let vcs_detail = [
                tools
                    .git_version
                    .as_deref()
                    .map(|version| format!("Git {version}")),
                tools
                    .svn_version
                    .as_deref()
                    .map(|version| format!("SVN {version}")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ");
            for key in ["compare", "fileHistory"] {
                availability.insert(
                    key.into(),
                    if vcs_available {
                        CapabilityStatus {
                            available: true,
                            reason_code: None,
                            detail: Some(vcs_detail.clone()),
                        }
                    } else {
                        CapabilityStatus::unavailable(
                            "VCS_TOOL_UNAVAILABLE",
                            "Git and SVN are unavailable",
                        )
                    },
                );
            }
            for key in ["shelf", "changelist"] {
                availability.insert(key.into(), CapabilityStatus::available());
            }
            availability.insert("ai".into(), CapabilityStatus::available());
            json(BootstrapData {
                state: snapshot,
                tools: tools.clone(),
                application_session_id: state.application_session_id.clone(),
                launch_workspace_id: state
                    .launch_workspace_id
                    .lock()
                    .ok()
                    .and_then(|mut launch| launch.take()),
                capabilities: DesktopCapabilities {
                    ai: true,
                    initialize_repository: tools.git,
                    clone_repository: tools.git,
                    stash: tools.git,
                    shelf: true,
                    changelist: true,
                    worktree: tools.git,
                    subtree: tools.git,
                    submodule: tools.git,
                    compare: tools.git || tools.svn,
                    remote_management: tools.git,
                    identity: tools.git,
                    svn_account: tools.svn,
                    file_history: tools.git || tools.svn,
                    secure_credentials: secure_credentials.status.available,
                    system_notifications: notifications_available,
                    availability,
                },
                runtime,
            })
        }
        BridgeCommand::AiRuntime => json(crate::ai::runtime(state).await),
        BridgeCommand::AiSaveKey {
            provider,
            api_url,
            key,
        } => {
            crate::ai::save_key(provider, api_url, key)?;
            json(true)
        }
        BridgeCommand::AiPrompt {
            task,
            workspace_id,
            repo_id,
            scope,
            action,
            text,
        } => {
            json(crate::ai::prompt(state, task, workspace_id, repo_id, scope, action, text).await?)
        }
        BridgeCommand::AiGenerate { request } => {
            json(crate::ai::generate(state, app, request, token).await?)
        }
        BridgeCommand::AiComposerPrepare {
            workspace_id,
            repo_id,
            paths,
            staged_only,
            hashes,
        } => json(
            crate::ai::prepare(
                state,
                &workspace_id,
                &repo_id,
                paths,
                staged_only,
                hashes,
                token,
            )
            .await?,
        ),
        BridgeCommand::AiComposerApply {
            workspace_id,
            repo_id,
            session_id,
            groups,
            no_verify,
        } => json(
            crate::ai::apply(
                state,
                &workspace_id,
                &repo_id,
                &session_id,
                groups,
                no_verify,
                token,
            )
            .await?,
        ),
        BridgeCommand::AiReviewLocate {
            workspace_id,
            anchor,
        } => json(crate::ai::locate(state, &workspace_id, anchor, token).await?),
        BridgeCommand::AiResetCliSession => {
            crate::ai::reset_cli_session();
            json(true)
        }
        BridgeCommand::RuntimeCapabilities => json(runtime_capabilities().await),
        BridgeCommand::SaveAppState { state: snapshot } => {
            state.save_app_state(snapshot).await?;
            json(true)
        }
        BridgeCommand::SaveCommitSelections {
            workspace_id,
            mut selections,
        } => {
            let _ = state.workspace(&workspace_id).await?;
            for selection in &mut selections {
                let repo = resolve_repo(state, &workspace_id, &selection.repo_id).await?;
                selection.paths = vcs::validate_commit_selection_paths(&repo, &selection.paths)?;
            }
            json(
                state
                    .save_commit_selections(&workspace_id, selections)
                    .await?,
            )
        }
        BridgeCommand::UpdateSettings {
            settings,
            changed_fields,
        } => json(
            state
                .update_settings(settings, changed_fields.as_deref())
                .await?,
        ),
        BridgeCommand::UpdateLayout { mut layout } => {
            if layout.file_view_mode != "list" {
                layout.file_view_mode = "tree".into();
            }
            if layout.stash_view_mode != "list" {
                layout.stash_view_mode = "tree".into();
            }
            layout.panel_sizes.commit = layout.panel_sizes.commit.clamp(280, 620);
            layout.panel_sizes.branches = layout.panel_sizes.branches.clamp(120, 400);
            layout.panel_sizes.detail = layout.panel_sizes.detail.clamp(220, 680);
            state.update_layout(layout.clone()).await?;
            json(layout)
        }
        BridgeCommand::WorkspaceOpen { paths } => {
            let _permit = state.acquire_read(token).await?;
            emit_operation_phase(
                app,
                operation_id,
                request_context,
                started_at,
                "validate",
                "Validating workspace paths",
                None,
                None,
            );
            let descriptor = workspace::descriptor(paths)?;
            state.upsert_workspace(descriptor.clone()).await?;
            let generation = state.next_generation();
            let settings = state.app.read().await.settings.clone();
            emit_operation_phase(
                app,
                operation_id,
                request_context,
                started_at,
                "scan",
                "Enumerating directories and repositories",
                None,
                None,
            );
            let mut snapshot =
                workspace::snapshot(descriptor.clone(), generation, &settings, token).await?;
            workspace::reconcile_repositories_incoming(&mut snapshot.repositories);
            state
                .cache_repositories(&descriptor.id, &snapshot.repositories)
                .await;
            state.cache_tools(snapshot.tools.clone()).await;
            emit_operation_phase(
                app,
                operation_id,
                request_context,
                started_at,
                "watch",
                "Starting repository watchers",
                None,
                None,
            );
            state.watch_workspace(&descriptor, &snapshot.repositories, &settings, app.clone())?;
            workspace::reconcile_repositories_incoming(&mut snapshot.repositories);
            state
                .cache_repositories(&descriptor.id, &snapshot.repositories)
                .await;
            json(snapshot)
        }
        BridgeCommand::WorkspaceRemoveRecent { workspace_id } => {
            state.remove_cached_workspace(&workspace_id).await;
            let mut snapshot = state.app.read().await.clone();
            let removed = snapshot
                .recent_workspaces
                .iter()
                .find(|workspace| workspace.id == workspace_id)
                .cloned();
            let mut removed_color_ids = std::collections::HashSet::from([workspace_id.clone()]);
            if let Some(workspace) = removed
                .filter(|workspace| workspace.paths.iter().all(|path| Path::new(path).is_dir()))
            {
                let generation = state.next_generation();
                if let Ok(removed_snapshot) =
                    workspace::snapshot(workspace, generation, &snapshot.settings, token).await
                {
                    removed_color_ids.extend(
                        removed_snapshot
                            .repositories
                            .into_iter()
                            .map(|repository| repository.meta.id),
                    );
                }
            }
            snapshot
                .recent_workspaces
                .retain(|workspace| workspace.id != workspace_id);
            snapshot.commit_selections.remove(&workspace_id);
            if snapshot.last_workspace_id.as_deref() == Some(&workspace_id) {
                snapshot.last_workspace_id = None;
            }
            snapshot
                .settings
                .project_colors
                .retain(|id, _| !removed_color_ids.contains(id));
            state.save_app_state(snapshot).await?;
            state
                .save_commit_selections(&workspace_id, Vec::new())
                .await?;
            json(true)
        }
        BridgeCommand::WorkspaceRefresh { workspace_id } => {
            let _permit = state.acquire_read(token).await?;
            let descriptor = state.workspace(&workspace_id).await?;
            let generation = state.next_generation();
            let settings = state.app.read().await.settings.clone();
            emit_operation_phase(
                app,
                operation_id,
                request_context,
                started_at,
                "scan",
                "Refreshing repository metadata",
                None,
                None,
            );
            let mut snapshot =
                workspace::snapshot(descriptor.clone(), generation, &settings, token).await?;
            workspace::reconcile_repositories_incoming(&mut snapshot.repositories);
            state
                .cache_repositories(&descriptor.id, &snapshot.repositories)
                .await;
            state.cache_tools(snapshot.tools.clone()).await;
            state.watch_workspace(&descriptor, &snapshot.repositories, &settings, app.clone())?;
            workspace::reconcile_repositories_incoming(&mut snapshot.repositories);
            state
                .cache_repositories(&descriptor.id, &snapshot.repositories)
                .await;
            json(snapshot)
        }
        BridgeCommand::InitializeRepository {
            workspace_id,
            target_path,
        } => {
            let descriptor = state.workspace(&workspace_id).await?;
            let target = state::canonical_directory(&target_path)?;
            let allowed = descriptor
                .paths
                .iter()
                .any(|path| state::canonical_directory(path).is_ok_and(|root| root == target));
            if !allowed {
                return Err(DesktopError::new(
                    "PATH_OUTSIDE_WORKSPACE",
                    "Initialization target must be a selected workspace root",
                    false,
                ));
            }
            if vcs::existing_repository(&target, token).await.is_some() {
                return Err(DesktopError::new(
                    "REPOSITORY_ALREADY_EXISTS",
                    "The selected directory already contains a repository",
                    false,
                ));
            }
            let lock_key = format!("path:{}", target.to_string_lossy());
            with_write(state, &lock_key, token, async {
                vcs::initialize_repository(&target, token).await
            })
            .await?;
            let generation = state.next_generation();
            let settings = state.app.read().await.settings.clone();
            let mut snapshot =
                workspace::snapshot(descriptor.clone(), generation, &settings, token).await?;
            workspace::reconcile_repositories_incoming(&mut snapshot.repositories);
            let repository_id = snapshot
                .repositories
                .iter()
                .find(|repo| {
                    repo.meta.kind == VcsKind::Git
                        && state::canonical_directory(&repo.meta.root_path)
                            .is_ok_and(|root| root == target)
                })
                .map(|repo| repo.meta.id.clone())
                .ok_or_else(|| {
                    DesktopError::new(
                        "INITIALIZED_REPOSITORY_NOT_FOUND",
                        "Git initialized but the repository could not be loaded",
                        true,
                    )
                })?;
            state
                .cache_repositories(&descriptor.id, &snapshot.repositories)
                .await;
            state.watch_workspace(&descriptor, &snapshot.repositories, &settings, app.clone())?;
            json(InitializeRepositoryResult {
                snapshot,
                repository_id,
            })
        }
        BridgeCommand::CloneRepository {
            url,
            parent_path,
            target_name,
            provider_account_id,
        } => {
            let parent = state::canonical_directory(&parent_path)?;
            let target = state::safe_relative(&parent, &target_name, true)?;
            let lock_key = format!("path:{}", target.to_string_lossy());
            let credentials = match provider_account_id.as_deref() {
                Some(id) => Some(provider::credentials_for_url(&state.config_dir, id, &url)?),
                None => provider::credentials_for_url_if_unambiguous(&state.config_dir, &url)?,
            };
            let recurse = state.app.read().await.settings.clone_recursive_submodules;
            let path = with_write(state, &lock_key, token, async {
                vcs::clone_repository(
                    &url,
                    &parent,
                    &target_name,
                    credentials.as_ref(),
                    recurse,
                    token,
                )
                .await
            })
            .await?;
            json(CloneRepositoryResult {
                path: path.to_string_lossy().into_owned(),
            })
        }
        BridgeCommand::CheckoutSvnRepository {
            url,
            parent_path,
            target_name,
            username,
            password,
        } => {
            let parent = state::canonical_directory(&parent_path)?;
            let target = state::safe_relative(&parent, &target_name, true)?;
            let lock_key = format!("path:{}", target.to_string_lossy());
            let credentials = match (username, password) {
                (Some(username), Some(password)) => Some((username, password)),
                (None, None) => None,
                _ => {
                    return Err(DesktopError::new(
                        "SVN_CREDENTIALS_INCOMPLETE",
                        "Both SVN username and password are required",
                        false,
                    ))
                }
            };
            let path = with_write(state, &lock_key, token, async {
                vcs::checkout_svn_repository(
                    &url,
                    &parent,
                    &target_name,
                    credentials.as_ref(),
                    token,
                )
                .await
            })
            .await?;
            json(CheckoutRepositoryResult {
                path: path.to_string_lossy().into_owned(),
            })
        }
        BridgeCommand::ProviderAccounts => json(provider::accounts(&state.config_dir)),
        BridgeCommand::ProviderGithubBegin { account_id } => {
            json(provider::github_begin(account_id, token).await?)
        }
        BridgeCommand::ProviderGithubComplete { flow_id } => {
            json(provider::github_complete(&state.config_dir, &flow_id, token).await?)
        }
        BridgeCommand::ProviderGithubSave {
            account_id,
            token: secret,
        } => json(provider::github_save(&state.config_dir, account_id, &secret, token).await?),
        BridgeCommand::ProviderGitlabSave {
            account_id,
            host,
            token: secret,
        } => {
            json(provider::gitlab_save(&state.config_dir, account_id, &host, &secret, token).await?)
        }
        BridgeCommand::ProviderGiteeSave {
            account_id,
            token: secret,
        } => json(provider::gitee_save(&state.config_dir, account_id, &secret, token).await?),
        BridgeCommand::ProviderRemove { account_id } => {
            json(provider::remove(&state.config_dir, &account_id)?)
        }
        BridgeCommand::ProviderRepositories {
            account_id,
            query,
            page,
            per_page,
        } => json(
            provider::repositories(&state.config_dir, &account_id, query, page, per_page, token)
                .await?,
        ),
        BridgeCommand::ProviderNamespaces { account_id } => {
            json(provider::namespaces(&state.config_dir, &account_id, token).await?)
        }
        BridgeCommand::ResolveAuthorAvatar {
            workspace_id,
            repo_id,
            email,
            author_name,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let remotes = if repo.kind == VcsKind::Git {
                vcs::remotes(&repo, token)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .map(|item| item.fetch_url)
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let cross_platform_fallback = state
                .app
                .read()
                .await
                .settings
                .avatar_cross_platform_fallback;
            json(
                provider::resolve_author_avatar(
                    &state.config_dir,
                    &email,
                    &author_name,
                    &remotes,
                    cross_platform_fallback,
                    token,
                )
                .await?,
            )
        }
        BridgeCommand::PublishRepository {
            workspace_id,
            repo_id,
            account_id,
            namespace_id,
            name,
            description,
            visibility,
            push,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let branch = vcs::publish_preflight(&repo, token).await?;
            let created = provider::create_repository(
                &state.config_dir,
                &account_id,
                namespace_id.as_deref(),
                &name,
                &description,
                visibility,
                token,
            )
            .await?;
            let mut result = crate::models::PublishRepositoryResult {
                repository: created.clone(),
                remote_created: true,
                remote_configured: false,
                push_attempted: push,
                pushed: false,
                failed_stage: None,
                recovery_hint: None,
                error: None,
            };
            let local = with_write(state, &repo_id, token, async {
                if !vcs::remotes(&repo, token).await?.is_empty() {
                    return Err(DesktopError::new(
                        "REMOTE_APPEARED",
                        "A remote appeared while publishing",
                        true,
                    ));
                }
                vcs::remote_operation(
                    &repo,
                    crate::models::RemoteOperation::Add {
                        name: "origin".into(),
                        url: created.clone_url.clone(),
                    },
                    token,
                )
                .await?;
                result.remote_configured = true;
                if push {
                    let credentials = provider::credentials_for_url(
                        &state.config_dir,
                        &account_id,
                        &created.clone_url,
                    )?;
                    vcs::push_published(&repo, &branch, &credentials, token).await?;
                    result.pushed = true;
                }
                Ok::<(), DesktopError>(())
            })
            .await;
            if let Err(error) = local {
                result.failed_stage = Some(
                    if result.remote_configured {
                        "push"
                    } else {
                        "localRemote"
                    }
                    .into(),
                );
                result.recovery_hint =
                    Some(created.web_url.clone().unwrap_or(created.clone_url.clone()));
                result.error = Some(error);
            }
            json(result)
        }
        BridgeCommand::WindowStoreTabSession { transfer, session } => {
            if transfer.source_window_label != invoking_window.label()
                || session
                    .pointer("/snapshot/workspace/id")
                    .and_then(|value| value.as_str())
                    != Some(&transfer.tab_id)
                || session.pointer("/snapshot/workspace/paths")
                    != Some(&serde_json::json!(transfer.paths))
            {
                return Err(DesktopError::new(
                    "TAB_TRANSFER_SOURCE_MISMATCH",
                    "The session does not match the source tab",
                    false,
                ));
            }
            let mut sessions = state.tab_sessions.lock().map_err(|_| {
                DesktopError::new(
                    "WINDOW_STATE_LOCK_FAILED",
                    "Unable to store tab session",
                    true,
                )
            })?;
            if sessions.contains_key(&transfer.transfer_id) {
                return Err(DesktopError::new(
                    "TAB_TRANSFER_EXISTS",
                    "The tab transfer already exists",
                    false,
                ));
            }
            sessions.insert(
                transfer.transfer_id.clone(),
                state::PendingTabSession {
                    transfer,
                    session,
                    target: None,
                },
            );
            json(true)
        }
        BridgeCommand::WindowReadTabSession { transfer_id } => {
            let sessions = state.tab_sessions.lock().map_err(|_| {
                DesktopError::new(
                    "WINDOW_STATE_LOCK_FAILED",
                    "Unable to read tab session",
                    true,
                )
            })?;
            match sessions.get(&transfer_id) {
                Some(session) if session.target.as_deref() == Some(invoking_window.label()) => {
                    json(session.session.clone())
                }
                Some(_) => Err(DesktopError::new(
                    "TAB_TRANSFER_TARGET_MISMATCH",
                    "The session belongs to another destination",
                    false,
                )),
                None => json(serde_json::Value::Null),
            }
        }
        BridgeCommand::WindowDiscardTabSession { transfer_id } => {
            let mut sessions = state.tab_sessions.lock().map_err(|_| {
                DesktopError::new(
                    "WINDOW_STATE_LOCK_FAILED",
                    "Unable to release tab session",
                    true,
                )
            })?;
            if sessions.get(&transfer_id).is_some_and(|session| {
                session.transfer.source_window_label != invoking_window.label()
            }) {
                return Err(DesktopError::new(
                    "TAB_TRANSFER_SOURCE_MISMATCH",
                    "The session belongs to another source",
                    false,
                ));
            }
            sessions.remove(&transfer_id);
            json(true)
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
                // The frontend reveals a transfer after rendering its initial tab,
                // without waiting for the workspace scan and repository panels.
                .visible(transfer.is_none())
                .focused(transfer.is_none())
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

            // Bind before building: the new webview may immediately request its session.
            if let Some(transfer) = &transfer {
                state.bind_tab_session(transfer, &label)?;
            }
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

            if transfer.is_none() {
                let _ = window.show();
                let _ = window.set_focus();
            }

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
            if !screen_x.is_finite() || !screen_y.is_finite() {
                return json(false);
            }
            let scale = invoking_window.scale_factor().unwrap_or(1.0);
            let drop_target = crate::tab_drag::drop_target(
                app,
                &transfer.source_window_label,
                Some(tauri::PhysicalPosition::new(
                    screen_x * scale,
                    screen_y * scale,
                )),
            )
            .await;

            if let Some(drop_target) = drop_target {
                let target_label = drop_target.label;
                if let Some(target) = app.get_webview_window(&target_label) {
                    state.bind_tab_session(&transfer, &target_label)?;
                    let _ = target.unminimize();
                    let _ = target.show();
                    let _ = target.set_focus();
                    let transfer_id = transfer.transfer_id.clone();
                    let payload = WindowTabImport {
                        transfer,
                        screen_x,
                        screen_y,
                        target_client_x: Some(drop_target.client_x),
                    };
                    if target.emit("versiondock://import-tab", payload).is_ok() {
                        return json(true);
                    }
                    if let Ok(mut sessions) = state.tab_sessions.lock() {
                        if let Some(session) = sessions.get_mut(&transfer_id) {
                            session.target = None;
                        }
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
            {
                let mut sessions = state.tab_sessions.lock().map_err(|_| {
                    DesktopError::new(
                        "WINDOW_STATE_LOCK_FAILED",
                        "Unable to complete tab transfer",
                        true,
                    )
                })?;
                if let Some(session) = sessions.get(&transfer_id) {
                    if session.target.as_deref() != Some(invoking_window.label())
                        || session.transfer.source_window_label != source_window_label
                        || session.transfer.tab_id != tab_id
                    {
                        return Err(DesktopError::new(
                            "TAB_TRANSFER_MISMATCH",
                            "Tab acknowledgement does not match its session",
                            false,
                        ));
                    }
                }
                sessions.remove(&transfer_id);
            }
            // Fallback if the first-render reveal failed, including failed imports.
            // Do not steal focus again when background loading finishes.
            if !invoking_window.is_visible().unwrap_or(false) {
                invoking_window.show().map_err(|error| {
                    DesktopError::new("WINDOW_SHOW_FAILED", error.to_string(), true)
                })?;
                let _ = invoking_window.set_focus();
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
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            let tools = match state.cached_tools().await {
                Some(tools) => tools,
                None => workspace::tool_availability(token).await,
            };
            let secure_credentials = svn_account::secure_store_capability().await;
            let mut status = match repo.kind {
                VcsKind::Git => workspace::git_status(repo, token).await?,
                VcsKind::Svn => workspace::svn_status(repo, token).await?,
            };
            workspace::apply_runtime_capabilities(&mut status, &tools, &secure_credentials);
            let metas = state.cached_repositories(&workspace_id).await;
            workspace::apply_nested_git_ownership_with_metas(
                std::slice::from_mut(&mut status),
                &metas,
            );
            json(status)
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
            let _permit = state.acquire_read(token).await?;
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
            let _permit = state.acquire_read(token).await?;
            json(vcs::stash_file_diff(&repo, &reference, &relative_path, token).await?)
        }
        BridgeCommand::ShelfFileDiff {
            workspace_id,
            repo_id,
            shelf_id,
            relative_path,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(shelf::file_diff(&state.config_dir, &repo, &shelf_id, &relative_path).await?)
        }
        BridgeCommand::Stage {
            workspace_id,
            repo_id,
            paths,
            allow_truncated,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
                if repo.kind == VcsKind::Svn {
                    let status = workspace::svn_status(repo.clone(), token).await?;
                    let truncated = status
                        .files
                        .iter()
                        .filter(|file| file.is_truncated && paths.contains(&file.path))
                        .count();
                    if truncated > 0 && !allow_truncated {
                        return Err(DesktopError::new(
                            "SVN_TRUNCATED_DIRECTORY_CONFIRMATION_REQUIRED",
                            "Adding a truncated SVN directory recursively requires confirmation",
                            true,
                        ));
                    }
                    if allow_truncated && (truncated != 1 || paths.len() != 1) {
                        return Err(DesktopError::new(
                            "SVN_TRUNCATED_DIRECTORY_SINGLE_TARGET_REQUIRED",
                            "Add one truncated SVN directory at a time",
                            false,
                        ));
                    }
                }
                vcs::stage(&repo, &paths, allow_truncated, token).await
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
            with_write(state, &repo_id, token, async {
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
            with_write(state, &repo_id, token, async {
                if repo.kind == VcsKind::Svn {
                    let status = workspace::svn_status(repo.clone(), token).await?;
                    if status
                        .files
                        .iter()
                        .any(|file| file.is_truncated && paths.contains(&file.path))
                    {
                        return Err(DesktopError::new(
                            "SVN_TRUNCATED_DIRECTORY_DISCARD_FORBIDDEN",
                            "A truncated SVN directory cannot be discarded safely",
                            false,
                        ));
                    }
                }
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
            with_write(state, &repo_id, token, async {
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
                with_write(state, &repo_id, token, async {
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
        BridgeCommand::SvnIgnoreEntries {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(vcs::svn_ignore_entries(&repo, token).await?)
        }
        BridgeCommand::UpdateIgnoreRules {
            workspace_id,
            repo_id,
            directory,
            patterns,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
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
            no_verify,
            staged_only,
        } => {
            emit_operation_phase(
                app,
                operation_id,
                request_context,
                started_at,
                "preparingCommit",
                "Preparing commit inputs and identity",
                None,
                None,
            );
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let identity = if repo.kind == VcsKind::Git {
                Some(
                    identity::state(&state.config_dir, &workspace_id, Some(&repo), token)
                        .await?
                        .effective,
                )
            } else {
                None
            };
            let value = with_write(state, &repo_id, token, async {
                emit_operation_phase(
                    app,
                    operation_id,
                    request_context,
                    started_at,
                    if paths.is_empty() {
                        "committing"
                    } else {
                        "stagingAndCommitting"
                    },
                    if paths.is_empty() {
                        "Creating commit"
                    } else {
                        "Staging selected paths and creating commit"
                    },
                    None,
                    None,
                );
                if staged_only {
                    vcs::unstage_unexpected_cached(&repo, &paths, &[], token).await?;
                }
                vcs::commit_with_identity(
                    &repo,
                    &message,
                    amend,
                    &paths,
                    identity.as_ref(),
                    no_verify,
                    staged_only,
                    token,
                )
                .await
            })
            .await?;
            json(value)
        }
        BridgeCommand::CommitSafetyCheck {
            workspace_id,
            repo_id,
            paths,
            staged_only,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let settings = state.app.read().await.settings.clone();
            let root = Path::new(&repo.root_path);
            let mut result = crate::models::CommitSafetyCheckResult::default();
            let max_size_bytes = (settings.large_file_size_limit_mb.max(1) as u64) * 1024 * 1024;
            let forbidden_chars = ['<', '>', ':', '"', '|', '?', '*'];
            let reserved_names = [
                "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
                "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8",
                "lpt9",
            ];

            let mut seen_lower = std::collections::HashMap::new();

            for rel_path in paths {
                let base = Path::new(&rel_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| rel_path.clone());

                // 1. Sensitive
                if !base.ends_with(".example")
                    && !base.ends_with(".sample")
                    && !base.ends_with(".template")
                {
                    let is_sensitive = base.starts_with(".env")
                        || base.ends_with(".pem")
                        || base.ends_with(".key")
                        || base.ends_with(".pfx")
                        || base.ends_with(".p12")
                        || base.ends_with(".kdbx")
                        || base.starts_with("id_rsa")
                        || base.starts_with("id_ed25519");
                    if is_sensitive {
                        result.sensitive_files.push(rel_path.clone());
                    }
                }

                // 2. Invalid names
                if settings.warn_on_invalid_file_names {
                    let base_no_ext = base.split('.').next().unwrap_or("").to_ascii_lowercase();
                    if base
                        .chars()
                        .any(|c| forbidden_chars.contains(&c) || (c as u32) < 32)
                    {
                        result
                            .invalid_file_names
                            .push(crate::models::InvalidFileNameInfo {
                                path: rel_path.clone(),
                                reason: "contains characters forbidden on Windows (: * ? \" < > |)"
                                    .into(),
                            });
                    } else if base.ends_with(' ') || base.ends_with('.') {
                        result
                            .invalid_file_names
                            .push(crate::models::InvalidFileNameInfo {
                                path: rel_path.clone(),
                                reason: "ends with space or dot".into(),
                            });
                    } else if reserved_names.contains(&base_no_ext.as_str()) {
                        result
                            .invalid_file_names
                            .push(crate::models::InvalidFileNameInfo {
                                path: rel_path.clone(),
                                reason: format!("uses Windows-reserved name \"{base_no_ext}\""),
                            });
                    }

                    let lower = rel_path.to_ascii_lowercase();
                    if let Some(existing) = seen_lower.get(&lower) {
                        if existing != &rel_path {
                            result
                                .invalid_file_names
                                .push(crate::models::InvalidFileNameInfo {
                                    path: rel_path.clone(),
                                    reason: format!("case collision with \"{existing}\""),
                                });
                        }
                    } else {
                        seen_lower.insert(lower, rel_path.clone());
                    }
                }

                // 3. File size & CRLF
                let full_path = root.join(&rel_path);
                let (file_size, has_crlf) =
                    if staged_only && repo.kind == crate::models::VcsKind::Git {
                        match vcs::inspect_staged_file_for_safety(
                            &repo,
                            &rel_path,
                            settings.warn_on_crlf,
                            token,
                        )
                        .await
                        {
                            Ok(Some((size, crlf))) => (Some(size), crlf),
                            _ => read_disk_file_safety(&full_path, settings.warn_on_crlf),
                        }
                    } else {
                        read_disk_file_safety(&full_path, settings.warn_on_crlf)
                    };

                if let Some(len) = file_size {
                    if settings.warn_on_large_files && len > max_size_bytes {
                        let formatted = if len < 1024 * 1024 {
                            format!("{:.1} KB", len as f64 / 1024.0)
                        } else {
                            format!("{:.1} MB", len as f64 / (1024.0 * 1024.0))
                        };
                        result.large_files.push(crate::models::LargeFileInfo {
                            path: rel_path.clone(),
                            size_bytes: len as f64,
                            size_formatted: formatted,
                        });
                    }

                    if settings.warn_on_crlf && has_crlf {
                        result.crlf_files.push(rel_path.clone());
                    }
                }
            }

            result.has_issues = !result.sensitive_files.is_empty()
                || !result.large_files.is_empty()
                || !result.invalid_file_names.is_empty()
                || !result.crlf_files.is_empty();

            json(result)
        }
        BridgeCommand::BatchCommit {
            workspace_id,
            targets,
            push,
        } => {
            let cached = state.cached_repositories(&workspace_id).await;
            let all_metas = if cached.is_empty() {
                if let Ok(descriptor) = state.workspace(&workspace_id).await {
                    let settings = state.app.read().await.settings.clone();
                    workspace::scan(&descriptor, &settings).unwrap_or_default()
                } else {
                    Vec::new()
                }
            } else {
                cached
            };

            // 深度倒序排序（子模块 depth 较大排在前面，父仓库排在后面）
            let mut targets = targets;
            targets.sort_by(|a, b| {
                let a_depth = all_metas
                    .iter()
                    .find(|m| m.id == a.repo_id)
                    .map(|m| m.depth)
                    .unwrap_or(0);
                let b_depth = all_metas
                    .iter()
                    .find(|m| m.id == b.repo_id)
                    .map(|m| m.depth)
                    .unwrap_or(0);
                b_depth.cmp(&a_depth)
            });

            let mut results = Vec::new();
            let total = targets.len() as u32;
            let mut failed_submodule_ids: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            let mut failed_push_submodule_ids: std::collections::HashSet<String> =
                std::collections::HashSet::new();

            for (index, target) in targets.into_iter().enumerate() {
                let repo_id = target.repo_id.clone();
                if let Some(failed_descendant) =
                    find_failed_submodule_descendant(&repo_id, &failed_submodule_ids, &all_metas)
                {
                    let is_submodule = all_metas
                        .iter()
                        .find(|m| m.id == repo_id)
                        .map(|m| m.is_submodule || m.depth > 0)
                        .unwrap_or(false);
                    if is_submodule {
                        failed_submodule_ids.insert(repo_id.clone());
                    }
                    let child_name = if failed_descendant.name.is_empty() {
                        failed_descendant.id.clone()
                    } else {
                        failed_descendant.name.clone()
                    };
                    let reason = if failed_push_submodule_ids.contains(&failed_descendant.id) {
                        format!(
                            "Skipped because child submodule \"{}\" failed to push.",
                            child_name
                        )
                    } else {
                        format!(
                            "Skipped because child submodule \"{}\" failed to commit.",
                            child_name
                        )
                    };
                    results.push(crate::models::RepositoryOperationResult {
                        repo_id,
                        commit_attempted: false,
                        committed: false,
                        revision: None,
                        push_attempted: false,
                        pushed: false,
                        failed_stage: Some("dependency".into()),
                        recovery_hint: Some("Fix child submodule issues and retry".into()),
                        error: Some(DesktopError::new(
                            "SUBMODULE_DEPENDENCY_FAILED",
                            reason,
                            false,
                        )),
                    });
                    continue;
                }
                let repo = match resolve_repo(state, &workspace_id, &repo_id).await {
                    Ok(repo) => repo,
                    Err(error) => {
                        let is_submodule = all_metas
                            .iter()
                            .find(|m| m.id == repo_id)
                            .map(|m| m.is_submodule || m.depth > 0)
                            .unwrap_or(false);
                        if is_submodule {
                            failed_submodule_ids.insert(repo_id.clone());
                        }
                        results.push(crate::models::RepositoryOperationResult {
                            repo_id,
                            commit_attempted: false,
                            committed: false,
                            revision: None,
                            push_attempted: false,
                            pushed: false,
                            failed_stage: Some("prepare".into()),
                            recovery_hint: Some(
                                "Reopen the workspace and verify that the repository is available"
                                    .into(),
                            ),
                            error: Some(error),
                        });
                        continue;
                    }
                };
                let identity = if repo.kind == VcsKind::Git {
                    match identity::state(&state.config_dir, &workspace_id, Some(&repo), token)
                        .await
                    {
                        Ok(identity) => Some(identity.effective),
                        Err(error) => {
                            let is_submodule = repo.is_submodule || repo.depth > 0;
                            if is_submodule {
                                failed_submodule_ids.insert(repo_id.clone());
                            }
                            results.push(crate::models::RepositoryOperationResult {
                                repo_id,
                                commit_attempted: false,
                                committed: false,
                                revision: None,
                                push_attempted: false,
                                pushed: false,
                                failed_stage: Some("identity".into()),
                                recovery_hint: Some(
                                    "Configure a valid Git identity and retry this repository"
                                        .into(),
                                ),
                                error: Some(error),
                            });
                            continue;
                        }
                    }
                } else {
                    None
                };
                let commit_result = with_write(state, &repo_id, token, async {
                    emit_operation_phase(
                        app,
                        operation_id,
                        request_context,
                        started_at,
                        "stagingAndCommitting",
                        "Preparing selected paths and creating commit",
                        Some(index as u32),
                        Some(total),
                    );
                    vcs::unstage_unexpected_cached(
                        &repo,
                        &target.paths,
                        &target.unstage_paths,
                        token,
                    )
                    .await?;
                    vcs::commit_with_identity(
                        &repo,
                        &target.message,
                        target.amend,
                        &target.paths,
                        identity.as_ref(),
                        target.no_verify,
                        target.staged_only,
                        token,
                    )
                    .await
                })
                .await;
                match commit_result {
                    Ok(revision) => {
                        let push_result = if push && repo.kind == VcsKind::Git {
                            with_write(state, &repo_id, token, async {
                                emit_operation_phase(
                                    app,
                                    operation_id,
                                    request_context,
                                    started_at,
                                    "pushRepository",
                                    "Pushing committed repository",
                                    Some(index as u32),
                                    Some(total),
                                );
                                let settings = state.app.read().await.settings.clone();
                                Box::pin(vcs::sync(
                                    &repo,
                                    crate::models::SyncAction::Push,
                                    None,
                                    None,
                                    false,
                                    &settings,
                                    token,
                                ))
                                .await
                            })
                            .await
                            .map(|_| true)
                        } else {
                            Ok(false)
                        };
                        match push_result {
                            Ok(pushed) => results.push(crate::models::RepositoryOperationResult {
                                repo_id,
                                commit_attempted: true,
                                committed: true,
                                revision: Some(revision),
                                push_attempted: push && repo.kind == VcsKind::Git,
                                pushed,
                                failed_stage: None,
                                recovery_hint: None,
                                error: None,
                            }),
                            Err(error) => {
                                let is_submodule = repo.is_submodule || repo.depth > 0;
                                if is_submodule {
                                    failed_submodule_ids.insert(repo_id.clone());
                                    failed_push_submodule_ids.insert(repo_id.clone());
                                }
                                results.push(crate::models::RepositoryOperationResult {
                                    repo_id,
                                    commit_attempted: true,
                                    committed: true,
                                    revision: Some(revision),
                                    push_attempted: true,
                                    pushed: false,
                                    failed_stage: Some("push".into()),
                                    recovery_hint: Some(
                                        "Retry the push after checking the remote and branch state"
                                            .into(),
                                    ),
                                    error: Some(error),
                                });
                            }
                        }
                    }
                    Err(error) => {
                        let is_submodule = repo.is_submodule || repo.depth > 0;
                        if is_submodule {
                            failed_submodule_ids.insert(repo_id.clone());
                        }
                        results.push(crate::models::RepositoryOperationResult {
                            repo_id,
                            commit_attempted: true,
                            committed: false,
                            revision: None,
                            push_attempted: false,
                            pushed: false,
                            failed_stage: Some("commit".into()),
                            recovery_hint: Some(
                                "Review repository changes and retry only this repository".into(),
                            ),
                            error: Some(error),
                        });
                    }
                }
            }
            emit_operation_phase(
                app,
                operation_id,
                request_context,
                started_at,
                "refresh",
                "Refreshing affected repositories",
                Some(total),
                Some(total),
            );
            json(results)
        }
        BridgeCommand::RecentCommitMessages {
            workspace_id,
            repo_ids,
            limit,
        } => {
            let mut messages = Vec::new();
            for repo_id in repo_ids {
                let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
                let _permit = state.acquire_read(token).await?;
                messages.extend(vcs::recent_commit_messages(&repo, token).await?);
            }
            messages.sort_by(|left, right| right.committed_at.cmp(&left.committed_at));
            let mut seen = HashSet::new();
            messages.retain(|item| seen.insert(item.message.clone()));
            messages.truncate(limit.clamp(1, 50) as usize);
            json(messages)
        }
        BridgeCommand::LastCommitMessage {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::last_commit_message(&repo, token).await?)
        }
        BridgeCommand::Sync {
            workspace_id,
            repo_id,
            action,
            remote,
            branch,
            force,
        } => {
            let (phase, message) = sync_phase(&action);
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let needs_worker = crate::update_worker::needs_worker(&repo, &action);
            let value = with_write_coordinated(state, &repo_id, token, !needs_worker, async {
                emit_operation_phase(
                    app,
                    operation_id,
                    request_context,
                    started_at,
                    phase,
                    message,
                    None,
                    None,
                );
                let settings = state.app.read().await.settings.clone();
                if needs_worker {
                    let request = crate::update_worker::UpdateRequest {
                        log_context: Some(crate::logger::LogContext {
                            workspace_id: Some(workspace_id.clone()),
                            repository_id: Some(repo.id.clone()),
                            operation_id: Some(operation_id.into()),
                            repository_name: Some(repo.name.clone()),
                            workspace_name: state
                                .workspace(&workspace_id)
                                .await
                                .ok()
                                .map(|workspace| workspace.name),
                        }),
                        config_dir: state.config_dir.clone(),
                        repo,
                        action,
                        remote,
                        branch,
                        force: force.unwrap_or(false),
                        settings,
                    };
                    let executable = std::env::current_exe().map_err(|error| {
                        DesktopError::new("UPDATE_WORKER_FAILED", error.to_string(), true)
                    })?;
                    let (child, directory) = tokio::task::spawn_blocking(move || {
                        crate::update_worker::launch(&executable, &request, &[])
                    })
                    .await
                    .map_err(|error| {
                        DesktopError::new("UPDATE_WORKER_FAILED", error.to_string(), true)
                    })??;
                    return crate::update_worker::wait(child, directory, token).await;
                }
                Box::pin(vcs::sync_with_worktree_backup(
                    &state.config_dir,
                    &repo,
                    action,
                    remote,
                    branch,
                    force.unwrap_or(false),
                    &settings,
                    token,
                ))
                .await
            })
            .await?;
            json(value)
        }
        BridgeCommand::History {
            workspace_id,
            repo_id,
            skip,
            limit,
            query,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            emit_operation_phase(
                app,
                operation_id,
                request_context,
                started_at,
                "loadCommits",
                "Loading repository commits",
                None,
                None,
            );
            let history = vcs::history(&repo, skip, limit, query, token).await?;
            emit_operation_phase(
                app,
                operation_id,
                request_context,
                started_at,
                "projectPage",
                "Projecting the visible history page",
                Some(history.commits.len() as u32),
                None,
            );
            json(history)
        }
        BridgeCommand::HistoryTopology {
            workspace_id,
            repo_id,
            svn_limit,
            limit,
            revision,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::history_topology(&repo, limit, svn_limit, revision, token).await?)
        }
        BridgeCommand::CommitDetail {
            workspace_id,
            repo_id,
            revision,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(Box::pin(vcs::commit_detail(&repo, &revision, token)).await?)
        }
        BridgeCommand::CommitMergeCommits {
            workspace_id,
            repo_id,
            revision,
            parents,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(Box::pin(vcs::merge_commits(&repo, &revision, &parents, token)).await?)
        }
        BridgeCommand::CommitMergeParentFiles {
            workspace_id,
            repo_id,
            revision,
            parent_hash,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::merge_parent_files(&repo, &revision, &parent_hash, token).await?)
        }
        BridgeCommand::UnpushedCommits {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::unpushed_commits(&repo, token).await?)
        }
        BridgeCommand::UnpushedChanges {
            workspace_id,
            repo_id,
            oldest_revision,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::unpushed_changes(&repo, oldest_revision, token).await?)
        }
        BridgeCommand::IncomingCommits {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::incoming_commits(&repo, token).await?)
        }
        BridgeCommand::IncomingChanges {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::incoming_changes(&repo, token).await?)
        }
        BridgeCommand::UnpushedOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
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
            let _permit = state.acquire_read(token).await?;
            json(vcs::create_patch(&repo, &revisions, token).await?)
        }
        BridgeCommand::SavePatch {
            workspace_id,
            repo_id,
            revisions,
            path,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            let patch = vcs::create_patch(&repo, &revisions, token).await?;
            tokio::fs::write(&path, patch.content.as_bytes())
                .await
                .map_err(|e| {
                    crate::models::DesktopError::new(
                        "SAVE_PATCH_FAILED",
                        format!("Failed to save patch to {}: {}", path, e),
                        false,
                    )
                })?;
            json(path)
        }
        BridgeCommand::HistoryOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let add_suffix = state.app.read().await.settings.cherry_pick_add_suffix;
            with_write(state, &repo_id, token, async {
                vcs::history_operation(&repo, operation, add_suffix, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Branches {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::branches(&repo, token).await?)
        }
        BridgeCommand::BranchOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let result = with_write(state, &repo_id, token, async {
                vcs::branch_operation(&repo, operation, token).await
            })
            .await?;
            if repo.kind == crate::models::VcsKind::Svn {
                vcs::invalidate_svn_ref_caches(&repo_id);
            }
            json(result)
        }
        BridgeCommand::BranchRecovery {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let result = with_write(state, &repo_id, token, async {
                vcs::branch_recovery(&repo, operation, token).await
            })
            .await?;
            json(result)
        }
        BridgeCommand::Tags {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::tags(&repo, token).await?)
        }
        BridgeCommand::TagOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
                vcs::tag_operation(&repo, operation, token).await
            })
            .await?;
            if repo.kind == crate::models::VcsKind::Svn {
                vcs::invalidate_svn_ref_caches(&repo_id);
            }
            json(true)
        }
        BridgeCommand::Stashes {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::stashes(&repo, token).await?)
        }
        BridgeCommand::StashOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
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
            emit_operation_phase(
                app,
                operation_id,
                request_context,
                started_at,
                "openingPath",
                "Opening repository path",
                None,
                None,
            );
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let target =
                crate::state::safe_relative(Path::new(&repo.root_path), &relative_path, true)?;
            if reveal {
                app.opener()
                    .reveal_items_in_dir([target.clone()])
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
            let _permit = state.acquire_read(token).await?;
            json(shelf::list(&state.config_dir, &repo).await?)
        }
        BridgeCommand::ShelfOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
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
            let _permit = state.acquire_read(token).await?;
            json(changelist::list(&state.config_dir, &workspace_id, &repo).await?)
        }
        BridgeCommand::ChangelistOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
                changelist::operate(&state.config_dir, &workspace_id, &repo, operation).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Worktrees {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::worktrees(&repo, token).await?)
        }
        BridgeCommand::WorktreeOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
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
            let _permit = state.acquire_read(token).await?;
            let target = vcs::managed_worktree_path(&state.config_dir, &repo, &path, token).await?;
            if reveal {
                app.opener()
                    .reveal_items_in_dir([target.clone()])
                    .map_err(|error| {
                        DesktopError::new("SYSTEM_REVEAL_FAILED", error.to_string(), true)
                    })?;
            }
            json(target.to_string_lossy().into_owned())
        }
        BridgeCommand::WorktreeDiff {
            workspace_id,
            repo_id,
            path,
            base_ref,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
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
            let _permit = state.acquire_read(token).await?;
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
            let _permit = state.acquire_read(token).await?;
            json(vcs::branch_working_diff(&repo, &base_ref, token).await?)
        }
        BridgeCommand::BranchWorkingFileDiff {
            workspace_id,
            repo_id,
            base_ref,
            relative_path,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::branch_working_file_diff(&repo, &base_ref, &relative_path, token).await?)
        }
        BridgeCommand::Subtrees {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::subtrees(&repo, token).await?)
        }
        BridgeCommand::SubtreeStatuses {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            json(
                with_write(state, &repo_id, token, async {
                    vcs::subtree_statuses(&repo, token).await
                })
                .await?,
            )
        }
        BridgeCommand::SubtreeOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let (phase, message) = subtree_phase(&operation);
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
                emit_operation_phase(
                    app,
                    operation_id,
                    request_context,
                    started_at,
                    phase,
                    message,
                    None,
                    None,
                );
                vcs::subtree_operation(&repo, operation, token).await
            })
            .await?;
            vcs::invalidate_subtree_status_cache(&repo_id);
            json(true)
        }
        BridgeCommand::Submodules {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::submodules(&repo, token).await?)
        }
        BridgeCommand::SubmoduleOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let (phase, message) = submodule_phase(&operation);
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
                emit_operation_phase(
                    app,
                    operation_id,
                    request_context,
                    started_at,
                    phase,
                    message,
                    None,
                    None,
                );
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
            let (phase, message) = svn_phase(&operation);
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
                emit_operation_phase(
                    app,
                    operation_id,
                    request_context,
                    started_at,
                    phase,
                    message,
                    None,
                    None,
                );
                vcs::svn_operation(&repo, operation, token).await
            })
            .await?;
            vcs::invalidate_svn_ref_caches(&repo_id);
            json(true)
        }
        BridgeCommand::BranchCompare {
            workspace_id,
            repo_id,
            base,
            target,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::branch_compare(&repo, &base, &target, token).await?)
        }
        BridgeCommand::BranchCompareCommits {
            workspace_id,
            repo_id,
            base,
            target,
            side,
            skip,
            limit,
            query,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(
                vcs::branch_compare_commits(
                    &repo, &base, &target, &side, skip, limit, &query, token,
                )
                .await?,
            )
        }
        BridgeCommand::Remotes {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::remotes(&repo, token).await?)
        }
        BridgeCommand::RemoteOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
                vcs::remote_operation(&repo, operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::Conflicts {
            workspace_id,
            repo_id,
        } => {
            let _permit = state.acquire_read(token).await?;
            let repositories = if let Some(repo_id) = repo_id {
                vec![resolve_repo(state, &workspace_id, &repo_id).await?]
            } else {
                let cached = state.cached_repositories(&workspace_id).await;
                if cached.is_empty() {
                    let descriptor = state.workspace(&workspace_id).await?;
                    let settings = state.app.read().await.settings.clone();
                    workspace::scan(&descriptor, &settings)?
                } else {
                    cached
                }
            };
            let mut statuses = Vec::with_capacity(repositories.len());
            for repository in repositories {
                let status = match repository.kind {
                    VcsKind::Git => workspace::git_status(repository, token).await?,
                    VcsKind::Svn => workspace::svn_status(repository, token).await?,
                };
                statuses.push(status);
            }
            let mut files = Vec::new();
            for repository in &statuses {
                for file in repository.files.iter().filter(|f| f.conflicted) {
                    let (current_status, incoming_status) = match repository.meta.kind {
                        VcsKind::Git => {
                            let code = file.conflict_status.as_deref().unwrap_or("UU");
                            let (ours_s, theirs_s) = vcs::map_git_conflict_side_statuses(code);
                            (ours_s.map(String::from), theirs_s.map(String::from))
                        }
                        VcsKind::Svn => {
                            let curr = match file.conflict_status.as_deref() {
                                Some("added") => "added",
                                Some("deleted") | Some("missing") => "deleted",
                                _ => "modified",
                            };
                            let incoming =
                                vcs::svn_incoming_status(&repository.meta, &file.path, token).await;
                            (Some(curr.to_string()), Some(incoming))
                        }
                    };
                    let binary = match repository.meta.kind {
                        VcsKind::Git => {
                            vcs::is_git_conflict_binary(&repository.meta, &file.path, token).await
                        }
                        VcsKind::Svn => {
                            vcs::is_svn_conflict_binary(&repository.meta, &file.path, token).await
                        }
                    };
                    let conflict_type = if file.submodule {
                        "submodule".into()
                    } else {
                        file.conflict_type.clone().unwrap_or_else(|| "text".into())
                    };
                    let conflict_types = if file.submodule {
                        Some(vec!["submodule".into()])
                    } else {
                        file.conflict_types.clone()
                    };
                    files.push(ConflictFile {
                        repo_id: repository.meta.id.clone(),
                        repo_name: repository.meta.name.clone(),
                        repo_color: repository.meta.color.clone(),
                        path: file.path.clone(),
                        kind: repository.meta.kind,
                        binary,
                        conflict_type,
                        conflict_types,
                        actions: vec!["mine".into(), "theirs".into(), "working".into()],
                        current_status,
                        incoming_status,
                    });
                }
            }
            json(files)
        }
        BridgeCommand::ConflictVersions {
            workspace_id,
            repo_id,
            relative_path,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::conflict_versions(&repo, &relative_path, token).await?)
        }
        BridgeCommand::ConflictSave {
            workspace_id,
            repo_id,
            relative_path,
            content,
            expected_fingerprint,
            delete_file,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let auto_commit = state.app.read().await.settings.auto_commit_resolved_merge;
            let should_delete = delete_file.unwrap_or(false);
            let output = with_write(state, &repo_id, token, async {
                vcs::conflict_save(
                    &repo,
                    &relative_path,
                    &content,
                    &expected_fingerprint,
                    should_delete,
                    auto_commit,
                    token,
                )
                .await
            })
            .await?;
            json(ConflictResolutionResult {
                resolved: true,
                auto_commit_error: output.auto_commit_error,
                auto_committed: output.auto_committed,
            })
        }
        BridgeCommand::ConflictAccept {
            workspace_id,
            repo_id,
            relative_path,
            choice,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let auto_commit = state.app.read().await.settings.auto_commit_resolved_merge;
            let output = with_write(state, &repo_id, token, async {
                vcs::conflict_accept(&repo, &relative_path, choice, auto_commit, token).await
            })
            .await?;
            json(ConflictResolutionResult {
                resolved: true,
                auto_commit_error: output.auto_commit_error,
                auto_committed: output.auto_committed,
            })
        }
        BridgeCommand::AbortRepositoryOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
                vcs::abort_operation(&repo, &operation, token).await
            })
            .await?;
            json(true)
        }
        BridgeCommand::ContinueRepositoryOperation {
            workspace_id,
            repo_id,
            operation,
            skip,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            with_write(state, &repo_id, token, async {
                if skip.unwrap_or(false) {
                    vcs::skip_operation(&repo, &operation, token).await
                } else {
                    vcs::continue_operation(&repo, &operation, token).await
                }
            })
            .await?;
            json(true)
        }
        BridgeCommand::GitUnlockIndex {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            if repo.kind != VcsKind::Git {
                return Err(DesktopError::new(
                    "UNSUPPORTED_OPERATION",
                    "Index unlock is only available for Git",
                    false,
                ));
            }
            with_write(state, &repo_id, token, async {
                cli::unlock_git_index(Path::new(&repo.root_path))
            })
            .await?;
            json(true)
        }
        BridgeCommand::RestoreConflicts {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let result = with_write(state, &repo_id, token, async {
                vcs::restore_conflicts(&repo, token).await
            })
            .await?;
            json(result)
        }
        BridgeCommand::GitIdentity {
            workspace_id,
            repo_id,
        } => {
            state.workspace(&workspace_id).await?;
            let repo = if repo_id.is_empty() {
                None
            } else {
                Some(resolve_repo(state, &workspace_id, &repo_id).await?)
            };
            let _permit = state.acquire_read(token).await?;
            if repo.as_ref().is_some_and(|repo| repo.kind != VcsKind::Git) {
                return Err(DesktopError::new(
                    "UNSUPPORTED_OPERATION",
                    "Git identity is only available for Git repositories",
                    false,
                ));
            }
            json(identity::state(&state.config_dir, &workspace_id, repo.as_ref(), token).await?)
        }
        BridgeCommand::GitProfileOperation {
            workspace_id,
            repo_id,
            operation,
        } => {
            state.workspace(&workspace_id).await?;
            let repo = if repo_id.is_empty() {
                None
            } else {
                Some(resolve_repo(state, &workspace_id, &repo_id).await?)
            };
            if repo.as_ref().is_some_and(|repo| repo.kind != VcsKind::Git) {
                return Err(DesktopError::new(
                    "UNSUPPORTED_OPERATION",
                    "Git identity is only available for Git repositories",
                    false,
                ));
            }
            json(
                with_write(state, &repo_id, token, async {
                    identity::operate(
                        &state.config_dir,
                        &workspace_id,
                        repo.as_ref(),
                        operation,
                        token,
                    )
                    .await
                })
                .await?,
            )
        }
        BridgeCommand::SvnAccount {
            workspace_id,
            repo_id,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
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
            json(
                with_write(state, &repo_id, token, async {
                    svn_account::operate(&state.config_dir, &repo, operation, token).await
                })
                .await?,
            )
        }
        BridgeCommand::FileHistory {
            workspace_id,
            repo_id,
            relative_path,
            cursor,
            limit,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(vcs::file_history(&repo, &relative_path, cursor.as_deref(), limit, token).await?)
        }
        BridgeCommand::DiffLineHistoryTarget {
            workspace_id,
            repo_id,
            relative_path,
            source_revision,
            line_range,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            json(
                vcs::diff_line_history_target(
                    &repo,
                    &relative_path,
                    &source_revision,
                    line_range,
                    token,
                )
                .await?,
            )
        }
        BridgeCommand::FileRevisionContent {
            workspace_id,
            repo_id,
            relative_path,
            revision,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit = state.acquire_read(token).await?;
            let filter_mode = state.app.read().await.settings.cat_file_filter_mode.clone();
            json(
                vcs::file_revision_content(&repo, &relative_path, &revision, filter_mode, token)
                    .await?,
            )
        }
        BridgeCommand::LogGet {
            channel,
            level,
            limit,
        } => {
            if let Some(logger) = crate::logger::get_logger() {
                let entries = logger.get_entries(channel, level, limit.map(|v| v as usize));
                json(entries)
            } else {
                json(Vec::<crate::logger::LogEntry>::new())
            }
        }
        BridgeCommand::LogClear => {
            if let Some(logger) = crate::logger::get_logger() {
                logger.clear();
            }
            json(true)
        }
        BridgeCommand::LogFormat { entries } => json(crate::logger::format_entries(&entries)),
        BridgeCommand::LogStorageStatus => {
            json(crate::logger::get_logger().and_then(|logger| logger.storage_error()))
        }
        BridgeCommand::LogOpenFolder => {
            if let Some(logger) = crate::logger::get_logger() {
                let path = logger.log_dir().to_path_buf();
                app.opener()
                    .open_path(path.to_string_lossy(), None::<&str>)
                    .map_err(|error| {
                        DesktopError::new("LOG_OPEN_FOLDER_FAILED", error.to_string(), true)
                    })?;
            }
            json(true)
        }
        BridgeCommand::LogExport {
            target_path,
            entries,
        } => {
            if let Some(entries) = entries {
                std::fs::write(
                    Path::new(&target_path),
                    crate::logger::format_entries(&entries),
                )
                .map_err(|error| DesktopError::new("LOG_EXPORT_FAILED", error.to_string(), true))?;
                return json(true);
            }
            if let Some(logger) = crate::logger::get_logger() {
                logger
                    .export_to_file(Path::new(&target_path))
                    .map_err(|err| DesktopError::new("LOG_EXPORT_FAILED", err.to_string(), true))?;
                json(true)
            } else {
                json(false)
            }
        }
        BridgeCommand::LogClientPush {
            level,
            channel,
            message,
            details,
        } => {
            crate::logger::log_entry(level, channel, message, details, None, None);
            json(true)
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
    let mut command = if cfg!(target_os = "macos") && executable.ends_with(".app") {
        let mut cmd = tokio::process::Command::new("open");
        cmd.arg("-a").arg(&executable).args(args);
        cmd
    } else {
        let mut cmd = tokio::process::Command::new(executable);
        cmd.args(args);
        cmd
    };
    command.current_dir(&repo.root_path);
    command.kill_on_drop(false);
    let mut child = command
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

fn read_disk_file_safety(path: &Path, check_crlf: bool) -> (Option<u64>, bool) {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.is_file() {
            let len = metadata.len();
            let mut has_crlf = false;
            if check_crlf && len > 0 && len < 5 * 1024 * 1024 {
                if let Ok(mut f) = std::fs::File::open(path) {
                    use std::io::Read;
                    let mut buffer = [0u8; 64 * 1024];
                    if let Ok(read_bytes) = f.read(&mut buffer) {
                        if buffer[..read_bytes].windows(2).any(|w| w == b"\r\n") {
                            has_crlf = true;
                        }
                    }
                }
            }
            return (Some(len), has_crlf);
        }
    }
    (None, false)
}

fn find_failed_submodule_descendant(
    repo_id: &str,
    failed_submodule_ids: &std::collections::HashSet<String>,
    all_metas: &[crate::models::RepositoryMeta],
) -> Option<crate::models::RepositoryMeta> {
    if failed_submodule_ids.is_empty() {
        return None;
    }
    for failed_id in failed_submodule_ids {
        let mut curr = all_metas.iter().find(|m| m.id == *failed_id);
        while let Some(c) = curr {
            if let Some(parent_id) = &c.parent_repo_id {
                if parent_id == repo_id {
                    return all_metas
                        .iter()
                        .find(|m| m.id == *failed_id)
                        .cloned()
                        .or_else(|| Some((*c).clone()));
                }
                curr = all_metas.iter().find(|m| m.id == *parent_id);
            } else {
                break;
            }
        }
    }
    None
}

pub(crate) async fn resolve_repo(
    state: &AppState,
    workspace_id: &str,
    repo_id: &str,
) -> Result<crate::models::RepositoryMeta, DesktopError> {
    let repo = if let Some(repository) = state.cached_repository(workspace_id, repo_id).await {
        repository
    } else {
        let descriptor = state.workspace(workspace_id).await?;
        let settings = state.app.read().await.settings.clone();
        let repository = workspace::scan(&descriptor, &settings)?
            .into_iter()
            .find(|repository| repository.id == repo_id)
            .ok_or_else(|| {
                DesktopError::new(
                    "REPOSITORY_NOT_FOUND",
                    "Repository is no longer part of the workspace",
                    true,
                )
            })?;
        state
            .cache_repository(workspace_id, repository.clone())
            .await;
        repository
    };
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

async fn with_write<T, F>(
    state: &AppState,
    repo_id: &str,
    token: &tokio_util::sync::CancellationToken,
    operation: F,
) -> Result<T, DesktopError>
where
    F: std::future::Future<Output = Result<T, DesktopError>>,
{
    with_write_coordinated(state, repo_id, token, true, operation).await
}

async fn with_write_coordinated<T, F>(
    state: &AppState,
    repo_id: &str,
    token: &tokio_util::sync::CancellationToken,
    lock_transaction: bool,
    operation: F,
) -> Result<T, DesktopError>
where
    F: std::future::Future<Output = Result<T, DesktopError>>,
{
    let lock = state.write_lock(repo_id).await;
    state::emit_current_operation(
        OperationStatus::Queued,
        "waitingForRepository",
        "Waiting for the repository write lock",
    );
    let _guard = tokio::select! {
        _ = token.cancelled() => return Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)),
        guard = lock.lock_owned() => guard,
    };
    let _permit = state.acquire_write(token).await?;
    // A source-watcher restart must not let the new UI write into a repository
    // whose detached update worker is still updating or restoring local changes.
    let _transaction = if lock_transaction {
        Some(crate::update_worker::repository_lock(&state.config_dir, repo_id, token).await?)
    } else {
        None
    };
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

pub(crate) fn point_in_tab_snap_zone(
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
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn notifications_are_in_app_only_on_every_platform() {
        let runtime = runtime_capabilities().await;
        assert!(!runtime.system_notifications.available);
        assert_eq!(
            runtime.system_notifications.reason_code.as_deref(),
            Some("SYSTEM_NOTIFICATIONS_DISABLED")
        );
        assert!(matches!(
            runtime.notification_permission,
            NotificationPermissionState::Unavailable
        ));
    }

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

    #[test]
    fn refresh_scopes_keep_extension_operations_repository_local() {
        let subtree = BridgeCommand::SubtreeOperation {
            workspace_id: "workspace".into(),
            repo_id: "repo".into(),
            operation: crate::models::SubtreeOperation::Pull {
                subtree_id: "subtree".into(),
            },
        };
        let scopes = command_refresh_scopes(&subtree);
        assert!(scopes.contains(&RefreshScope::Subtrees));
        assert!(scopes.contains(&RefreshScope::History));
        assert!(!scopes.contains(&RefreshScope::WorkspaceSnapshot));

        let update = BridgeCommand::SubmoduleOperation {
            workspace_id: "workspace".into(),
            repo_id: "repo".into(),
            operation: crate::models::SubmoduleOperation::Update {
                path: "module".into(),
                init: false,
                recursive: false,
                remote: false,
            },
        };
        let scopes = command_refresh_scopes(&update);
        assert!(scopes.contains(&RefreshScope::Submodules));
        assert!(!scopes.contains(&RefreshScope::WorkspaceSnapshot));

        let initialize = BridgeCommand::SubmoduleOperation {
            workspace_id: "workspace".into(),
            repo_id: "repo".into(),
            operation: crate::models::SubmoduleOperation::Init {
                path: "module".into(),
                recursive: false,
            },
        };
        assert!(command_refresh_scopes(&initialize).contains(&RefreshScope::WorkspaceSnapshot));
    }

    #[test]
    fn conflict_resolution_broadcasts_history_refs_and_unpushed_when_auto_committed() {
        let save_cmd = BridgeCommand::ConflictSave {
            workspace_id: "workspace".into(),
            repo_id: "repo".into(),
            relative_path: "conflict.txt".into(),
            content: "resolved".into(),
            expected_fingerprint: "abc".into(),
            delete_file: None,
        };
        let not_committed_res: Result<serde_json::Value, DesktopError> = Ok(serde_json::json!({
            "resolved": true,
            "autoCommitError": null,
            "autoCommitted": false,
        }));
        let scopes = command_resolved_refresh_scopes(&save_cmd, &not_committed_res);
        assert!(scopes.contains(&RefreshScope::Status));
        assert!(scopes.contains(&RefreshScope::Conflicts));
        assert!(!scopes.contains(&RefreshScope::History));
        assert!(!scopes.contains(&RefreshScope::Refs));
        assert!(!scopes.contains(&RefreshScope::Unpushed));

        let committed_res: Result<serde_json::Value, DesktopError> = Ok(serde_json::json!({
            "resolved": true,
            "autoCommitError": null,
            "autoCommitted": true,
        }));
        let scopes = command_resolved_refresh_scopes(&save_cmd, &committed_res);
        assert!(scopes.contains(&RefreshScope::Status));
        assert!(scopes.contains(&RefreshScope::Conflicts));
        assert!(scopes.contains(&RefreshScope::History));
        assert!(scopes.contains(&RefreshScope::Refs));
        assert!(scopes.contains(&RefreshScope::Unpushed));

        let accept_cmd = BridgeCommand::ConflictAccept {
            workspace_id: "workspace".into(),
            repo_id: "repo".into(),
            relative_path: "conflict.txt".into(),
            choice: crate::models::ConflictChoice::Theirs,
        };
        let scopes = command_resolved_refresh_scopes(&accept_cmd, &committed_res);
        assert!(scopes.contains(&RefreshScope::History));
        assert!(scopes.contains(&RefreshScope::Refs));
        assert!(scopes.contains(&RefreshScope::Unpushed));
    }

    #[tokio::test]
    async fn coordinator_serializes_same_repository_and_limits_cross_repository_writes() {
        let root = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::load(root.path().to_path_buf()));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for index in 0..4 {
            let state = state.clone();
            let active = active.clone();
            let maximum = maximum.clone();
            tasks.push(tokio::spawn(async move {
                let token = tokio_util::sync::CancellationToken::new();
                with_write(
                    &state,
                    if index < 2 { "same" } else { "other" },
                    &token,
                    async {
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(current, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok::<_, DesktopError>(())
                    },
                )
                .await
            }));
        }
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn coordinator_cancels_while_waiting_for_repository_lock() {
        let root = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::load(root.path().to_path_buf()));
        let held = state.write_lock("repo").await.lock_owned().await;
        let token = tokio_util::sync::CancellationToken::new();
        let cancel = token.clone();
        let waiting_state = state.clone();
        let waiting = tokio::spawn(async move {
            with_write(&waiting_state, "repo", &token, async {
                Ok::<_, DesktopError>(())
            })
            .await
        });
        cancel.cancel();
        let error = waiting.await.unwrap().unwrap_err();
        drop(held);
        assert_eq!(error.code, "REQUEST_CANCELLED");
    }

    #[test]
    fn find_failed_submodule_descendant_identifies_nested_submodule_failure() {
        let parent = crate::models::RepositoryMeta {
            id: "parent".into(),
            name: "Parent Repo".into(),
            root_path: "/tmp/parent".into(),
            color: "#000".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let sub_a = crate::models::RepositoryMeta {
            id: "sub_a".into(),
            name: "Sub A".into(),
            root_path: "/tmp/parent/sub_a".into(),
            color: "#000".into(),
            kind: VcsKind::Git,
            parent_repo_id: Some("parent".into()),
            depth: 1,
            is_submodule: true,
            is_worktree: false,
        };
        let sub_b = crate::models::RepositoryMeta {
            id: "sub_b".into(),
            name: "Sub B".into(),
            root_path: "/tmp/parent/sub_a/sub_b".into(),
            color: "#000".into(),
            kind: VcsKind::Git,
            parent_repo_id: Some("sub_a".into()),
            depth: 2,
            is_submodule: true,
            is_worktree: false,
        };
        let sibling = crate::models::RepositoryMeta {
            id: "sibling".into(),
            name: "Sibling Repo".into(),
            root_path: "/tmp/sibling".into(),
            color: "#000".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let metas = vec![
            parent.clone(),
            sub_a.clone(),
            sub_b.clone(),
            sibling.clone(),
        ];
        let mut failed = std::collections::HashSet::new();

        // 尚未失败时均返回 None
        assert!(find_failed_submodule_descendant("parent", &failed, &metas).is_none());

        // sub_b 失败
        failed.insert("sub_b".into());

        // parent 与 sub_a 都能检测到自身包含失败的子模块
        let found_for_parent = find_failed_submodule_descendant("parent", &failed, &metas);
        assert!(found_for_parent.is_some());
        assert_eq!(found_for_parent.unwrap().id, "sub_b");

        let found_for_sub_a = find_failed_submodule_descendant("sub_a", &failed, &metas);
        assert!(found_for_sub_a.is_some());
        assert_eq!(found_for_sub_a.unwrap().id, "sub_b");

        // 无关的 sibling 仓库不应被影响
        assert!(find_failed_submodule_descendant("sibling", &failed, &metas).is_none());
    }

    #[test]
    fn batch_commit_targets_sort_submodules_before_parents() {
        let parent = crate::models::RepositoryMeta {
            id: "parent".into(),
            name: "Parent Repo".into(),
            root_path: "/tmp/parent".into(),
            color: "#000".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let sub_a = crate::models::RepositoryMeta {
            id: "sub_a".into(),
            name: "Sub A".into(),
            root_path: "/tmp/parent/sub_a".into(),
            color: "#000".into(),
            kind: VcsKind::Git,
            parent_repo_id: Some("parent".into()),
            depth: 1,
            is_submodule: true,
            is_worktree: false,
        };
        let sub_b = crate::models::RepositoryMeta {
            id: "sub_b".into(),
            name: "Sub B".into(),
            root_path: "/tmp/parent/sub_a/sub_b".into(),
            color: "#000".into(),
            kind: VcsKind::Git,
            parent_repo_id: Some("sub_a".into()),
            depth: 2,
            is_submodule: true,
            is_worktree: false,
        };
        let all_metas = [parent, sub_a, sub_b];
        let mut targets = [
            crate::models::BatchCommitTarget {
                repo_id: "parent".into(),
                message: "parent msg".into(),
                paths: vec!["file.txt".into()],
                unstage_paths: vec![],
                amend: false,
                no_verify: false,
                staged_only: false,
            },
            crate::models::BatchCommitTarget {
                repo_id: "sub_a".into(),
                message: "sub_a msg".into(),
                paths: vec!["sub_a.txt".into()],
                unstage_paths: vec![],
                amend: false,
                no_verify: false,
                staged_only: false,
            },
            crate::models::BatchCommitTarget {
                repo_id: "sub_b".into(),
                message: "sub_b msg".into(),
                paths: vec!["sub_b.txt".into()],
                unstage_paths: vec![],
                amend: false,
                no_verify: false,
                staged_only: false,
            },
        ];

        targets.sort_by(|a, b| {
            let a_depth = all_metas
                .iter()
                .find(|m| m.id == a.repo_id)
                .map(|m| m.depth)
                .unwrap_or(0);
            let b_depth = all_metas
                .iter()
                .find(|m| m.id == b.repo_id)
                .map(|m| m.depth)
                .unwrap_or(0);
            b_depth.cmp(&a_depth)
        });

        assert_eq!(targets[0].repo_id, "sub_b");
        assert_eq!(targets[1].repo_id, "sub_a");
        assert_eq!(targets[2].repo_id, "parent");
    }
}
