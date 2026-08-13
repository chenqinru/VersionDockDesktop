use std::path::Path;

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

use crate::{
    changelist,
    models::{
        BootstrapData, BridgeCommand, ConflictFile, DesktopCapabilities, DesktopError,
        ProgressEvent, RequestEnvelope, ResponseEnvelope, VcsKind,
    },
    shelf,
    state::AppState,
    vcs, workspace,
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
    let token = state.register_request(&request_id).await;
    let _ = app.emit(
        "versiondock://event",
        ProgressEvent {
            request_id: request_id.clone(),
            phase: "started".into(),
            message: "Operation started".into(),
            completed: None,
            total: None,
        },
    );
    let result = dispatch(envelope.command, &app, &state, &token).await;
    state.finish_request(&request_id).await;
    let _ = app.emit(
        "versiondock://event",
        ProgressEvent {
            request_id: request_id.clone(),
            phase: "finished".into(),
            message: "Operation finished".into(),
            completed: Some(1),
            total: Some(1),
        },
    );
    Ok(match result {
        Ok(value) => ResponseEnvelope::success(request_id, value),
        Err(error) => ResponseEnvelope::failure(request_id, error),
    })
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
                    compare: true,
                    remote_management: true,
                    ..DesktopCapabilities::default()
                },
            })
        }
        BridgeCommand::SaveAppState { state: snapshot } => {
            state.save_app_state(snapshot).await?;
            json(true)
        }
        BridgeCommand::WorkspaceOpen { paths } => {
            let descriptor = workspace::descriptor(paths)?;
            state.upsert_workspace(descriptor.clone()).await?;
            let generation = state.next_generation();
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            let snapshot = workspace::snapshot(descriptor.clone(), generation, token).await?;
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
            let snapshot = workspace::snapshot(descriptor.clone(), generation, token).await?;
            state.watch_workspace(&descriptor, app.clone())?;
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
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::diff(&repo, &relative_path, staged, revision, token).await?)
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
        BridgeCommand::Commit {
            workspace_id,
            repo_id,
            message,
            amend,
            paths,
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let value = with_write(state, &repo_id, async {
                vcs::commit(&repo, &message, amend, &paths, token).await
            })
            .await?;
            json(value)
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
        } => {
            let repo = resolve_repo(state, &workspace_id, &repo_id).await?;
            let _permit =
                state.read_limit.acquire().await.map_err(|_| {
                    DesktopError::new("APP_CLOSING", "Application is closing", true)
                })?;
            json(vcs::history(&repo, skip, limit, filter, token).await?)
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
            let snapshot = workspace::snapshot(descriptor, state.next_generation(), token).await?;
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
                            binary: false,
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
    workspace::repository(&descriptor, repo_id)
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
