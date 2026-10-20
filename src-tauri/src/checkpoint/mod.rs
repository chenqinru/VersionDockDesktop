//! Local multi-repository checkpoints. The UI and headless Codex hook share this engine.
mod catalog;
mod cleanup;
mod connections;
mod history;
mod launch;
mod prompt;
mod reads;
mod redo;
mod restore;
mod snapshot;
mod storage;
#[cfg(test)]
mod tests;
pub mod types;

use crate::{
    models::{DesktopError, DiffDocument, RepositoryMeta, VcsKind, WorkspaceDescriptor},
    state::AppState,
};
use restore::*;
use snapshot::*;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use storage::*;
use tokio_util::sync::CancellationToken;
use types::*;

pub(crate) fn storage_directory(config: &Path) -> Result<PathBuf, DesktopError> {
    Ok(Storage::new(config)?.root)
}

pub(crate) async fn catalog(
    state: &AppState,
    token: &CancellationToken,
) -> Result<serde_json::Value, DesktopError> {
    catalog::read(state, token).await
}

pub(crate) async fn prepare_project(
    state: &AppState,
    workspace_id: Option<&str>,
    paths: Vec<String>,
    token: &CancellationToken,
) -> Result<serde_json::Value, DesktopError> {
    catalog::prepare(state, workspace_id, paths, token).await
}

pub(crate) async fn settings(
    state: &AppState,
    action: CheckpointSettingsAction,
    token: &CancellationToken,
) -> Result<serde_json::Value, DesktopError> {
    let _writer = if matches!(action, CheckpointSettingsAction::InstallHooks) {
        Some(
            crate::update_worker::repository_lock(
                &state.config_dir,
                "checkpoint-storage-v1",
                token,
            )
            .await?,
        )
    } else {
        None
    };
    let _objects =
        crate::update_worker::repository_read_lock(&state.config_dir, reads::OBJECT_LOCK, token)
            .await?;
    let store = Storage::new(&state.config_dir)?;
    if matches!(action, CheckpointSettingsAction::InstallHooks) {
        install_hooks(&state.config_dir)?;
        let mut db = store.read()?;
        db.verified_hooks.clear();
        store.save(&db)?;
    }
    value(CheckpointSettings {
        hooks_installed: hooks_installed(&state.config_dir)?,
        storage: history::storage_usage(&store, &store.read_cached()?, None)?,
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn active(task: &TaskWorkspace) -> bool {
    task.checkpoints.iter().any(|p| {
        matches!(
            p.status.as_str(),
            "recording" | "interrupted" | "incomplete"
        )
    })
}
fn task_mut<'a>(db: &'a mut Database, id: &str) -> Result<&'a mut TaskWorkspace, DesktopError> {
    db.tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| failure("Task not found"))
}
fn pending(store: &Storage, db: &Database, target_paths: &[String]) -> Result<bool, DesktopError> {
    for tx in db
        .transactions
        .iter()
        .filter(|tx| matches!(tx.report.status.as_str(), "pending" | "failed"))
    {
        let snapshot = store.snapshot(&tx.prepared.current)?;
        if snapshot
            .repositories
            .iter()
            .any(|r| target_paths.contains(&r.path))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn paths(task: &TaskWorkspace) -> Vec<String> {
    task.repositories
        .iter()
        .map(|r| r.task_path.clone())
        .collect()
}
fn value<T: serde::Serialize>(v: T) -> Result<serde_json::Value, DesktopError> {
    serde_json::to_value(v).map_err(io)
}

pub(crate) async fn handle(
    state: &AppState,
    workspace_id: &str,
    action: CheckpointAction,
    token: &CancellationToken,
) -> Result<serde_json::Value, DesktopError> {
    let mut timing = reads::ReadTiming::new(&action);
    let workspace = catalog::resolve_workspace(state, workspace_id).await?;
    let settings = state.app.read().await.settings.clone();
    let repos = if matches!(
        action,
        CheckpointAction::Create { .. } | CheckpointAction::Repositories
    ) {
        crate::workspace::scan(&workspace, &settings)?
    } else {
        Vec::new()
    };
    let reading = matches!(
        action,
        CheckpointAction::List
            | CheckpointAction::Repositories
            | CheckpointAction::Overview
            | CheckpointAction::History { .. }
            | CheckpointAction::StorageUsage { .. }
            | CheckpointAction::ProjectStorageUsage
            | CheckpointAction::PreviewProjectCleanup { .. }
            | CheckpointAction::Activity
            | CheckpointAction::Detail { .. }
            | CheckpointAction::Diff { .. }
            | CheckpointAction::Prompt { .. }
            | CheckpointAction::Messages { .. }
            | CheckpointAction::OpenInCodex { .. }
    );
    // Atomically published metadata and immutable objects can be read during capture.
    // Only deletion needs to exclude readers, using a separate object-lifetime lock.
    let _global = if reading {
        None
    } else {
        Some(
            crate::update_worker::repository_lock(
                &state.config_dir,
                "checkpoint-storage-v1",
                token,
            )
            .await?,
        )
    };
    let store = Storage::new(&state.config_dir)?;
    let _objects = if reading
        && !matches!(
            action,
            CheckpointAction::Activity
                | CheckpointAction::Overview
                | CheckpointAction::OpenInCodex { .. }
        ) {
        Some(
            crate::update_worker::repository_read_lock(
                &state.config_dir,
                reads::OBJECT_LOCK,
                token,
            )
            .await?,
        )
    } else if matches!(
        action,
        CheckpointAction::Cleanup { .. }
            | CheckpointAction::ProjectCleanup { .. }
            | CheckpointAction::Remove { .. }
    ) {
        Some(
            crate::update_worker::repository_lock(&state.config_dir, reads::OBJECT_LOCK, token)
                .await?,
        )
    } else {
        None
    };
    timing.locked();
    let mut db = if reading {
        store.read_cached()?
    } else {
        store.read()?
    };
    timing.loaded();
    if matches!(action, CheckpointAction::Repositories) {
        return value(repos);
    }
    if matches!(action, CheckpointAction::Activity) {
        let mut output = activity(&db, &workspace);
        for task in &mut output.tasks {
            for point in &mut task.checkpoints {
                prompt::display_name(&store, &db, point);
            }
        }
        output.connections = Some(connections::all(&db, &workspace, &state.config_dir));
        return value(output);
    }
    if matches!(action, CheckpointAction::Overview) {
        return value(history::overview(&store, &db, &workspace)?);
    }
    if matches!(action, CheckpointAction::List) {
        return listing(&store, &db, &workspace);
    }
    if matches!(action, CheckpointAction::InstallHooks) {
        install_hooks(&state.config_dir)?;
        db.verified_hooks.clear();
        store.save(&db)?;
        return value(true);
    }
    let allowed = db
        .tasks
        .iter()
        .filter(|t| belongs(t, &workspace))
        .map(|t| t.id.clone())
        .collect::<BTreeSet<_>>();
    let target = match &action {
        CheckpointAction::Create { .. } => None,
        CheckpointAction::Diff { source, .. } => Some(diff_task_id(&db, source)?),
        CheckpointAction::Execute { preview_id } => Some(
            db.previews
                .iter()
                .find(|p| &p.preview.id == preview_id)
                .ok_or_else(|| failure("Preview not found"))?
                .preview
                .task_id
                .clone(),
        ),
        CheckpointAction::Recover { transaction_id } => Some(
            db.transactions
                .iter()
                .find(|t| &t.report.id == transaction_id)
                .ok_or_else(|| failure("Recovery not found"))?
                .report
                .task_id
                .clone(),
        ),
        CheckpointAction::History { task_id, .. }
        | CheckpointAction::StorageUsage {
            task_id: Some(task_id),
        }
        | CheckpointAction::PreviewRedo { task_id }
        | CheckpointAction::OpenInCodex { task_id }
        | CheckpointAction::SetMode { task_id, .. }
        | CheckpointAction::Begin { task_id, .. }
        | CheckpointAction::Finish { task_id }
        | CheckpointAction::Abandon { task_id }
        | CheckpointAction::Preview { task_id, .. }
        | CheckpointAction::Remove { task_id }
        | CheckpointAction::PreviewCleanup { task_id, .. }
        | CheckpointAction::Cleanup { task_id, .. }
        | CheckpointAction::RenameTask { task_id, .. }
        | CheckpointAction::Rename { task_id, .. }
        | CheckpointAction::Prompt { task_id, .. }
        | CheckpointAction::Messages { task_id, .. }
        | CheckpointAction::Detail { task_id, .. } => Some(task_id.clone()),
        _ => None,
    };
    if target.as_ref().is_some_and(|id| !allowed.contains(id)) {
        return Err(failure("Task does not belong to this workspace"));
    }
    if let CheckpointAction::History {
        task_id,
        query,
        repository,
        only_changes,
        offset,
        revision,
    } = &action
    {
        return value(history::page(
            &store,
            &db,
            task_id,
            query,
            repository.as_deref(),
            *only_changes,
            *offset,
            revision.as_deref(),
        )?);
    }
    if let CheckpointAction::StorageUsage { task_id } = &action {
        return value(history::storage_usage(&store, &db, task_id.as_deref())?);
    }
    if matches!(action, CheckpointAction::ProjectStorageUsage) {
        return value(history::project_storage_usage(&store, &db, &workspace)?);
    }
    if let CheckpointAction::PreviewProjectCleanup { keep_recent } = &action {
        return value(cleanup::project_preview(&store, &db, &workspace, *keep_recent)?.0);
    }
    if let CheckpointAction::ProjectCleanup {
        keep_recent,
        fingerprint,
    } = &action
    {
        return value(cleanup::project_execute(
            &store,
            &mut db,
            &workspace,
            *keep_recent,
            fingerprint,
            token,
        )?);
    }
    // Display metadata is serialized with captures, but needs no Git write lock.
    if let CheckpointAction::RenameTask { task_id, name } = &action {
        rename_task(&store, &mut db, task_id, name)?;
        return value(true);
    }
    if let CheckpointAction::Messages {
        task_id,
        checkpoint_id,
    } = &action
    {
        return value(prompt::messages(&store, &db, task_id, checkpoint_id)?);
    }
    if let CheckpointAction::Prompt {
        task_id,
        checkpoint_id,
    } = &action
    {
        return value(checkpoint_prompt(&store, &db, task_id, checkpoint_id)?);
    }
    // Stored snapshots are immutable. Viewing a diff does not need repository write locks
    // and remains available while a failed restore is awaiting recovery.
    if let CheckpointAction::Diff {
        source,
        repository,
        path,
        layer,
    } = &action
    {
        return value(file_diff(&store, &db, source, repository, path, layer, token).await?);
    }
    if let CheckpointAction::Detail {
        task_id,
        checkpoint_id,
    } = &action
    {
        let point = db
            .tasks
            .iter()
            .find(|t| &t.id == task_id)
            .and_then(|t| t.checkpoints.iter().find(|p| &p.id == checkpoint_id))
            .ok_or_else(|| failure("Checkpoint not found"))?;
        return value(details(&store, point)?);
    }
    if let CheckpointAction::OpenInCodex { task_id } = &action {
        let task = db
            .tasks
            .iter()
            .find(|task| &task.id == task_id)
            .ok_or_else(|| failure("Task not found"))?;
        launch::open(&task.path, token).await?;
        return value(true);
    }
    let mut lock_paths = repos
        .iter()
        .map(|r| r.root_path.clone())
        .collect::<Vec<_>>();
    for task in db.tasks.iter().filter(|t| target.as_ref() == Some(&t.id)) {
        lock_paths.extend(paths(task));
        lock_paths.extend(task.repositories.iter().map(|r| r.source_path.clone()));
    }
    if pending(&store, &db, &lock_paths)?
        && !matches!(
            action,
            CheckpointAction::Recover { .. } | CheckpointAction::Detail { .. }
        )
    {
        return Err(failure(
            "Recover the interrupted restore before making further changes",
        ));
    }
    let (_in_process, _cross_process) =
        lock_repositories(&state.config_dir, Some(state), &lock_paths, token).await?;
    match action {
        CheckpointAction::Rename {
            task_id,
            checkpoint_id,
            name,
        } => {
            rename(&store, &mut db, &task_id, &checkpoint_id, &name)?;
            value(true)
        }
        CheckpointAction::PreviewCleanup {
            task_id,
            keep_recent,
        } => value(cleanup::preview(&store, &db, &task_id, keep_recent)?.preview),
        CheckpointAction::Cleanup {
            task_id,
            keep_recent,
            fingerprint,
        } => value(cleanup::execute(
            &store,
            &mut db,
            &task_id,
            keep_recent,
            &fingerprint,
            token,
        )?),
        CheckpointAction::Create {
            name,
            repo_ids,
            mode,
            isolation,
            include_ignored,
        } => {
            let task = create(
                &store,
                &mut db,
                &workspace,
                &repos,
                &repo_ids,
                &name,
                mode,
                isolation,
                &include_ignored,
                token,
            )
            .await?;
            value(task)
        }
        CheckpointAction::SetMode { task_id, mode } => {
            let task = task_mut(&mut db, &task_id)?;
            if active(task) {
                return Err(failure(
                    "Finish the active recording before switching modes",
                ));
            }
            task.mode = mode;
            store.save(&db)?;
            value(true)
        }
        CheckpointAction::Begin { task_id, name } => {
            begin(&store, &mut db, &task_id, &name, None, None, token).await?;
            value(true)
        }
        CheckpointAction::Abandon { task_id } => {
            let task = task_mut(&mut db, &task_id)?;
            for point in &mut task.checkpoints {
                if matches!(
                    point.status.as_str(),
                    "recording" | "incomplete" | "interrupted"
                ) {
                    point.status = "abandoned".into();
                }
            }
            task.hook_error = None;
            store.save(&db)?;
            value(true)
        }
        CheckpointAction::Finish { task_id } => {
            finish(&store, &mut db, &task_id, token).await?;
            value(true)
        }
        CheckpointAction::PreviewRedo { task_id } => {
            let task = task_mut(&mut db, &task_id)?.clone();
            let prepared = redo::prepare_redo(&store, &db, &task, token).await?;
            let preview = prepared.preview.clone();
            db.previews.retain(|p| p.preview.task_id != task_id);
            db.previews.push(prepared);
            store.save(&db)?;
            value(preview)
        }
        CheckpointAction::Preview {
            task_id,
            checkpoint_id,
            bring_back,
        } => {
            let task = task_mut(&mut db, &task_id)?.clone();
            if bring_back && task.isolation == TaskIsolation::Original {
                return Err(failure(
                    "Original-directory tasks already modify the source workspace",
                ));
            }
            let prepared =
                prepare(&store, &task, checkpoint_id.as_deref(), bring_back, token).await?;
            let preview = prepared.preview.clone();
            db.previews.retain(|p| p.preview.task_id != task_id);
            db.previews.push(prepared);
            store.save(&db)?;
            value(preview)
        }
        CheckpointAction::Execute { preview_id } => {
            let prepared = db
                .previews
                .iter()
                .find(|p| p.preview.id == preview_id)
                .cloned()
                .ok_or_else(|| failure("Preview not found"))?;
            let task = task_mut(&mut db, &prepared.preview.task_id)?;
            if digest(&serde_json::to_vec(task).map_err(io)?) != prepared.task_state {
                return Err(failure("Task changed after preview; preview again"));
            }
            if !prepared.preview.conflicts.is_empty() {
                return Err(failure("Resolve all preview conflicts before restoring"));
            }
            let expected = store.snapshot(&prepared.current)?;
            let expected_paths = expected
                .repositories
                .iter()
                .map(|r| r.path.clone())
                .collect::<Vec<_>>();
            if capture(&store, &expected_paths, token).await? != expected {
                return Err(failure("Preview is stale; preview the changes again"));
            }
            if let Some(fingerprint) = &prepared.source_task_fingerprint {
                if store
                    .save_snapshot(&capture(&store, &paths(&prepared.task_before), token).await?)?
                    != *fingerprint
                {
                    return Err(failure(
                        "Task files changed after bring-back preview; preview again",
                    ));
                }
            }
            let report = RestoreReport {
                id: uuid::Uuid::new_v4().to_string(),
                task_id: prepared.preview.task_id.clone(),
                status: "pending".into(),
                completed: 0,
                total: prepared.preview.files.len() as u32,
                error: None,
            };
            db.transactions.push(Transaction {
                report,
                prepared,
                recovery_before: None,
                recovery_expected: None,
            });
            let index = db.transactions.len() - 1;
            // Persist the intent before applying even the first repository.
            store.save(&db)?;
            let result = apply(&store, &mut db, index, false, token).await;
            if let Err(ref e) = result {
                db.transactions[index].report.status = "failed".into();
                db.transactions[index].report.error = Some(e.message.clone());
                store.save(&db)?;
            }
            db.previews.retain(|p| p.preview.id != preview_id);
            store.save(&db)?;
            value(result?)
        }
        CheckpointAction::Recover { transaction_id } => {
            let index = db
                .transactions
                .iter()
                .position(|t| t.report.id == transaction_id)
                .ok_or_else(|| failure("Recovery not found"))?;
            if db.transactions[index].report.status == "recovered" {
                return value(report(&db.transactions[index]));
            }
            let result = apply(&store, &mut db, index, true, token).await?;
            value(result)
        }
        CheckpointAction::Remove { task_id } => {
            let task = task_mut(&mut db, &task_id)?.clone();
            if active(&task) {
                return Err(failure(
                    "Finish the active recording before removing the task",
                ));
            }
            if task.isolation == TaskIsolation::Original || task.seed.is_empty() {
                db.custom_checkpoint_names
                    .retain(|id| !task.checkpoints.iter().any(|point| &point.id == id));
                db.tasks.retain(|t| t.id != task_id);
                db.previews.retain(|p| p.preview.task_id != task_id);
                db.transactions.retain(|t| t.report.task_id != task_id);
                store.save(&db)?;
                store.collect(&db)?;
                return value(true);
            }
            let current = capture(&store, &paths(&task), token).await?;
            let hash = store.save_snapshot(&current)?;
            if hash != task.seed && task.last_applied.as_ref() != Some(&hash) {
                return Err(failure(
                    "Bring back the task results before removing the task",
                ));
            }
            // Ignored configuration files may contain user data; keep them until explicitly removed.
            for repo in &task.repositories {
                let ignored = git(
                    Path::new(&repo.task_path),
                    &[
                        "ls-files",
                        "--others",
                        "--ignored",
                        "--exclude-standard",
                        "-z",
                    ],
                    None,
                    token,
                )
                .await?;
                if !ignored.is_empty() {
                    return Err(failure(
                        "Remove or move ignored files before removing this task",
                    ));
                }
            }
            for repo in task.repositories.iter().rev() {
                git(
                    Path::new(&repo.source_path),
                    &["worktree", "remove", "--force", &repo.task_path],
                    None,
                    token,
                )
                .await?;
            }
            // Keep auxiliary files and task branches: cleanup never silently deletes unmanaged files.
            db.custom_checkpoint_names
                .retain(|id| !task.checkpoints.iter().any(|point| &point.id == id));
            db.tasks.retain(|t| t.id != task_id);
            db.previews.retain(|p| p.preview.task_id != task_id);
            db.transactions.retain(|t| t.report.task_id != task_id);
            store.save(&db)?;
            store.collect(&db)?;
            value(true)
        }
        _ => Err(failure("Unsupported checkpoint action")),
    }
}
fn belongs(task: &TaskWorkspace, workspace: &WorkspaceDescriptor) -> bool {
    task.workspace_id == workspace.id
        || workspace
            .paths
            .iter()
            .any(|p| task.roots.contains(p) || *p == task.path)
}
fn listing(
    store: &Storage,
    db: &Database,
    workspace: &WorkspaceDescriptor,
) -> Result<serde_json::Value, DesktopError> {
    let mut tasks = db
        .tasks
        .iter()
        .filter(|t| belongs(t, workspace))
        .cloned()
        .collect::<Vec<_>>();
    // Older records get the same file summary without rewriting their names or
    // reading source contents. A missing summary never prevents viewing history.
    for task in &mut tasks {
        for point in &mut task.checkpoints {
            prompt::display_name(store, db, point);
            if point.summary.is_none() && point.after.is_some() {
                point.summary = reads::summary(store, point).ok();
            }
        }
    }
    let recovery = db
        .transactions
        .iter()
        .filter(|t| tasks.iter().any(|task| task.id == t.report.task_id))
        .map(report)
        .collect();
    let redo_checkpoints = redo::checkpoints(db, workspace);
    value(CheckpointListing {
        tasks,
        recovery,
        storage_bytes: store.size()?,
        hooks_installed: hooks_installed(store.root.parent().unwrap()).unwrap_or(false),
        connections: Some(connections::all(
            db,
            workspace,
            store.root.parent().unwrap(),
        )),
        history_counts: None,
        history_revisions: None,
        redo_tasks: Some(redo_checkpoints.keys().cloned().collect()),
        redo_checkpoints: Some(redo_checkpoints),
    })
}

fn activity(db: &Database, workspace: &WorkspaceDescriptor) -> CheckpointActivity {
    let tasks = db
        .tasks
        .iter()
        .filter(|task| belongs(task, workspace))
        .map(|task| {
            let mut status = task.clone();
            // Do not read snapshots, compute summaries, or scan the object store.
            let latest = task.checkpoints.last().map(|point| &point.id);
            status.checkpoints.retain(|point| {
                Some(&point.id) == latest
                    || matches!(
                        point.status.as_str(),
                        "recording" | "interrupted" | "incomplete"
                    )
            });
            status
        })
        .collect::<Vec<_>>();
    let recovery = db
        .transactions
        .iter()
        .filter(|tx| {
            matches!(tx.report.status.as_str(), "pending" | "failed")
                && tasks.iter().any(|task| task.id == tx.report.task_id)
        })
        .map(report)
        .collect();
    CheckpointActivity {
        tasks,
        recovery,
        connections: None,
    }
}

async fn lock_repositories(
    config: &Path,
    state: Option<&AppState>,
    roots: &[String],
    token: &CancellationToken,
) -> Result<(Vec<tokio::sync::OwnedMutexGuard<()>>, Vec<fs::File>), DesktopError> {
    let mut common = BTreeSet::new();
    let mut repositories = BTreeSet::new();
    for root in roots.iter().filter(|p| Path::new(p).join(".git").exists()) {
        let dir = git(
            Path::new(root),
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            None,
            token,
        )
        .await?;
        let dir = dunce::canonicalize(text(&dir)?.trim()).map_err(io)?;
        common.insert(format!("worktrees:{}", dir.display()));
        repositories.insert(crate::workspace::repo_id(Path::new(root), VcsKind::Git));
    }
    let mut local = Vec::new();
    let mut external = Vec::new();
    for key in common.into_iter().chain(repositories) {
        if let Some(state) = state {
            let lock: Arc<tokio::sync::Mutex<()>> = state.write_lock(&key).await;
            let guard = tokio::select! { _ = token.cancelled() => return Err(failure("Checkpoint operation cancelled")), guard = lock.lock_owned() => guard };
            local.push(guard);
        }
        external.push(crate::update_worker::repository_lock(config, &key, token).await?);
    }
    Ok((local, external))
}

async fn create(
    store: &Storage,
    db: &mut Database,
    workspace: &WorkspaceDescriptor,
    repos: &[RepositoryMeta],
    repo_ids: &[String],
    name: &str,
    mode: RecordingMode,
    isolation: TaskIsolation,
    include_ignored: &[String],
    token: &CancellationToken,
) -> Result<TaskWorkspace, DesktopError> {
    if name.trim().is_empty() || repo_ids.is_empty() {
        return Err(failure(
            "Enter a task name and select at least one Git repository",
        ));
    }
    if repo_ids.iter().collect::<BTreeSet<_>>().len() != repo_ids.len() {
        return Err(failure("Duplicate repository selection"));
    }
    let selected = repo_ids
        .iter()
        .map(|id| {
            repos
                .iter()
                .find(|r| &r.id == id)
                .ok_or_else(|| failure("Selected repository was not found"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if selected
        .iter()
        .any(|r| r.kind != VcsKind::Git || r.is_submodule)
    {
        return Err(failure(
            "SVN and submodules are not supported by task checkpoints",
        ));
    }
    for a in &selected {
        for b in &selected {
            if a.id != b.id && Path::new(&a.root_path).starts_with(&b.root_path) {
                return Err(failure("Select independent repository roots; nested repositories are not supported yet"));
            }
        }
    }
    let source_paths = selected
        .iter()
        .map(|r| r.root_path.clone())
        .collect::<Vec<_>>();
    let source = capture(store, &source_paths, token).await?;
    if isolation == TaskIsolation::Original {
        if db.tasks.iter().any(|t| {
            t.isolation == TaskIsolation::Original
                && (t.workspace_id == workspace.id
                    || t.repositories
                        .iter()
                        .any(|r| source_paths.contains(&r.task_path)))
        }) {
            return Err(failure("An original-directory task already protects these repositories; use that task or create an isolated task"));
        }
        let seed = store.save_snapshot(&source)?;
        let task = TaskWorkspace {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace.id.clone(),
            name: name.trim().into(),
            path: workspace.paths[0].clone(),
            roots: workspace.paths.clone(),
            repositories: selected
                .iter()
                .enumerate()
                .map(|(i, r)| TaskRepository {
                    source_id: r.id.clone(),
                    source_path: r.root_path.clone(),
                    task_path: r.root_path.clone(),
                    branch: source.repositories[i].branch.clone(),
                })
                .collect(),
            mode,
            isolation,
            created_at: now(),
            seed: seed.clone(),
            source_seed: seed,
            last_applied: None,
            checkpoints: Vec::new(),
            hook_events: Vec::new(),
            last_hook_at: None,
            hook_error: None,
            error: None,
        };
        db.projects.insert(workspace.id.clone(), workspace.clone());
        db.tasks.push(task.clone());
        store.save(db)?;
        return Ok(task);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let directory = store.root.join("tasks").join(&id);
    fs::create_dir_all(&directory).map_err(io)?;
    let mut roots = Vec::new();
    let mut mapping = Vec::new();
    for (i, source_root) in workspace.paths.iter().enumerate() {
        let source_root = dunce::canonicalize(source_root).map_err(io)?;
        let target = if workspace.paths.len() == 1 {
            directory.clone()
        } else {
            directory.join(format!("root-{}", i + 1))
        };
        roots.push(target.to_string_lossy().into_owned());
        mapping.push((source_root, target));
    }
    let mut task = TaskWorkspace {
        id: id.clone(),
        workspace_id: workspace.id.clone(),
        name: name.trim().into(),
        path: directory.to_string_lossy().into_owned(),
        roots,
        repositories: Vec::new(),
        mode,
        isolation,
        created_at: now(),
        seed: String::new(),
        source_seed: store.save_snapshot(&source)?,
        last_applied: None,
        checkpoints: Vec::new(),
        hook_events: Vec::new(),
        last_hook_at: None,
        hook_error: None,
        error: None,
    };
    // Persist creation intent so a crash never loses ownership of created worktrees.
    db.projects.insert(workspace.id.clone(), workspace.clone());
    task.error = Some("Task creation is incomplete".into());
    db.tasks.push(task.clone());
    store.save(db)?;
    let result = async {
        for (i, repo) in selected.iter().enumerate() {
            let original = Path::new(&repo.root_path);
            let (root, dest) = mapping
                .iter()
                .filter(|(r, _)| original.starts_with(r))
                .max_by_key(|(r, _)| r.components().count())
                .ok_or_else(|| failure("Repository is outside the selected project roots"))?;
            let target = dest.join(original.strip_prefix(root).map_err(io)?);
            // A root repository needs an absent/empty worktree target.
            let branch = format!(
                "codex/task-{}-{}",
                &id[..12],
                &repo.id[..repo.id.len().min(6)]
            );
            let item = TaskRepository {
                source_id: repo.id.clone(),
                source_path: repo.root_path.clone(),
                task_path: target.to_string_lossy().into_owned(),
                branch: branch.clone(),
            };
            task.repositories.push(item.clone());
            *task_mut(db, &id)? = task.clone();
            store.save(db)?;
            git(
                original,
                &[
                    "worktree",
                    "add",
                    "--no-track",
                    "-b",
                    &branch,
                    &item.task_path,
                    &source.repositories[i].head,
                ],
                None,
                token,
            )
            .await?;
            let mut clean = capture(store, std::slice::from_ref(&item.task_path), token)
                .await?
                .repositories
                .remove(0);
            let before = &source.repositories[i];
            for path in clean
                .working
                .keys()
                .chain(before.working.keys())
                .collect::<BTreeSet<_>>()
            {
                write_entry(store, &target, path, before.working.get(path))?;
            }
            let reservation = index_lock(&target, token).await?;
            write_index(
                store,
                &target,
                &clean.index,
                &before.index,
                &reservation,
                token,
            )
            .await?;
            clean.working = before.working.clone();
            drop(reservation);
        }
        // Copy auxiliary root files, excluding every Git/SVN administration directory and repository.
        for (from, to) in &mapping {
            copy_auxiliary(from, to, &source_paths, token)?;
        }
        for value in include_ignored {
            let original = dunce::canonicalize(value).map_err(io)?;
            let (root, target) = mapping
                .iter()
                .filter(|(root, _)| original.starts_with(root))
                .max_by_key(|(root, _)| root.components().count())
                .ok_or_else(|| failure("Local configuration is outside project roots"))?;
            let relative = original
                .strip_prefix(root)
                .map_err(io)?
                .to_str()
                .ok_or_else(|| failure("Unsupported local configuration path"))?;
            let entry = read_entry(store, root, relative)?
                .ok_or_else(|| failure("Local configuration was not found"))?;
            write_entry(store, target, relative, Some(&entry))?;
        }
        if capture(store, &source_paths, token).await? != source {
            return Err(failure("Source workspace changed while creating the task"));
        }
        task.seed = store.save_snapshot(&capture(store, &paths(&task), token).await?)?;
        task.error = None;
        Ok::<_, DesktopError>(())
    }
    .await;
    if let Err(error) = result {
        task.error = Some(error.message.clone());
        *task_mut(db, &id)? = task;
        store.save(db)?;
        return Err(error);
    }
    *task_mut(db, &id)? = task.clone();
    store.save(db)?;
    Ok(task)
}
fn copy_auxiliary(
    from: &Path,
    to: &Path,
    repositories: &[String],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if repositories.iter().any(|r| from == Path::new(r)) {
        return Ok(());
    }
    fs::create_dir_all(to).map_err(io)?;
    let repository_paths = repositories.iter().map(PathBuf::from).collect::<Vec<_>>();
    let walker = ignore::WalkBuilder::new(from)
        .hidden(false)
        .parents(false)
        .git_global(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            let name = entry.file_name();
            ![
                ".git",
                ".svn",
                "node_modules",
                "target",
                "dist",
                ".env",
                ".codex",
            ]
            .iter()
            .any(|v| name == *v)
                && !repository_paths.iter().any(|p| entry.path() == p)
                && (entry.depth() == 0
                    || !(entry.path().join(".git").exists() || entry.path().join(".svn").exists()))
        })
        .build();
    for entry in walker {
        if token.is_cancelled() {
            return Err(failure("Task creation cancelled"));
        }
        let entry = entry.map_err(io)?;
        if entry.depth() == 0 || entry.path_is_symlink() {
            continue;
        }
        let target = to.join(entry.path().strip_prefix(from).map_err(io)?);
        if entry.file_type().is_some_and(|t| t.is_dir()) {
            fs::create_dir_all(target).map_err(io)?;
        } else if entry.file_type().is_some_and(|t| t.is_file()) {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(io)?;
            }
            fs::copy(entry.path(), target).map_err(io)?;
        }
    }
    Ok(())
}

async fn begin(
    store: &Storage,
    db: &mut Database,
    task_id: &str,
    name: &str,
    hook: Option<(&str, &str)>,
    prompt: Option<&str>,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let task_paths = paths(task_mut(db, task_id)?);
    if db
        .tasks
        .iter()
        .any(|t| t.id != task_id && active(t) && paths(t).iter().any(|p| task_paths.contains(p)))
    {
        return Err(failure(
            "Another task is recording these repository directories",
        ));
    }
    let task = task_mut(db, task_id)?;
    if let Some((session, turn)) = hook {
        if let Some(point) = task.checkpoints.iter().find(|p| {
            p.session_id.as_deref() == Some(session) && p.turn_id.as_deref() == Some(turn)
        }) {
            if point.status == "incomplete" {
                return Err(failure("The previous checkpoint is incomplete. Stop file writes and finish or abandon it in VersionDock before resending."));
            }
            return Ok(());
        }
    }
    let interrupted = if let Some(index) = task.checkpoints.iter().rposition(|point| {
        matches!(
            point.status.as_str(),
            "recording" | "interrupted" | "incomplete"
        )
    }) {
        let point = &task.checkpoints[index];
        match hook {
            Some((session, _)) if point.session_id.as_deref() == Some(session) => {
                if point.status == "interrupted" && !point.before.is_empty() {
                    Some(index)
                } else if point.status == "incomplete" || point.before.is_empty() {
                    return Err(failure("The previous checkpoint is incomplete. Stop file writes and finish or abandon it in VersionDock before resending."));
                } else {
                    return Err(failure("The previous turn in this chat has not ended and no interruption was recorded. Stop the previous turn, then finish its recording in VersionDock before resending."));
                }
            }
            Some(_) if point.session_id.is_some() => return Err(failure("Another chat has an unfinished recording in this task. Finish that recording first, or use an isolated task workspace for parallel chats.")),
            _ => return Err(failure("This task has an unfinished manual recording. Stop file writes and finish or abandon it in VersionDock before continuing.")),
        }
    } else {
        None
    };
    if task.error.is_some() || task.seed.is_empty() {
        return Err(failure(
            "Task creation is incomplete; inspect its worktrees before continuing",
        ));
    }
    let prompt = hook.and(prompt).filter(|prompt| !prompt.trim().is_empty());
    let mut checkpoint = Checkpoint {
        id: uuid::Uuid::new_v4().to_string(),
        name: if let Some(prompt) = prompt {
            prompt_title(prompt)
        } else if name.trim().is_empty() {
            "Checkpoint".into()
        } else {
            name.trim().into()
        },
        created_at: now(),
        status: "incomplete".into(),
        session_id: hook.map(|(s, _)| s.into()),
        turn_id: hook.map(|(_, t)| t.into()),
        before: String::new(),
        after: None,
        error: None,
        summary: None,
        prompt_hash: prompt
            .map(|prompt| store.put(prompt.as_bytes()))
            .transpose()?,
    };
    if let Some(index) = interrupted {
        // Interrupt itself has a short timeout. The next synchronous start from the
        // same chat captures one stable boundary, shared by the old end and new start.
        // Until that succeeds, leave the interrupted checkpoint intact on disk.
        let snapshot = capture(store, &task_paths, token).await?;
        let boundary = store.save_snapshot(&snapshot)?;
        checkpoint.before = boundary.clone();
        checkpoint.status = "recording".into();
        let task = task_mut(db, task_id)?;
        let original = task.clone();
        let previous = &mut task.checkpoints[index];
        previous.after = Some(boundary);
        previous.status = "completed".into();
        previous.error = None;
        previous.summary = summarize(store, previous).ok();
        task.checkpoints.push(checkpoint);
        task.hook_error = None;
        if let Err(error) = store.save(db) {
            *task_mut(db, task_id)? = original;
            return Err(error);
        }
        return Ok(());
    }
    task.checkpoints.push(checkpoint);
    store.save(db)?;
    let captured = capture(store, &paths(task_mut(db, task_id)?), token).await;
    let point = task_mut(db, task_id)?
        .checkpoints
        .last_mut()
        .ok_or_else(|| failure("Checkpoint not found"))?;
    match captured {
        Ok(snapshot) => {
            point.before = store.save_snapshot(&snapshot)?;
            point.status = "recording".into();
        }
        Err(error) => {
            point.error = Some(error.message.clone());
            store.save(db)?;
            return Err(error);
        }
    }
    store.save(db)
}
async fn finish(
    store: &Storage,
    db: &mut Database,
    task_id: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let task = task_mut(db, task_id)?.clone();
    let index = task
        .checkpoints
        .iter()
        .rposition(|p| {
            matches!(
                p.status.as_str(),
                "recording" | "interrupted" | "incomplete"
            )
        })
        .ok_or_else(|| failure("No active recording"))?;
    if task.checkpoints[index].before.is_empty() {
        return Err(failure(
            "The initial capture failed; this interval cannot be restored",
        ));
    }
    let result = capture(store, &paths(&task), token).await;
    let point = &mut task_mut(db, task_id)?.checkpoints[index];
    match result {
        Ok(snapshot) => {
            point.after = Some(store.save_snapshot(&snapshot)?);
            point.status = "completed".into();
            point.error = None;
            point.summary = reads::summary(store, point).ok();
            task_mut(db, task_id)?.hook_error = None;
        }
        Err(error) => {
            point.status = "incomplete".into();
            point.error = Some(error.message.clone());
            store.save(db)?;
            return Err(error);
        }
    }
    store.save(db)
}
fn rename_task(
    store: &Storage,
    db: &mut Database,
    task_id: &str,
    name: &str,
) -> Result<(), DesktopError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(failure(
            "Enter a single-line task name of 1 to 100 characters",
        ));
    }
    if db.transactions.iter().any(|tx| {
        tx.report.task_id == task_id && matches!(tx.report.status.as_str(), "pending" | "failed")
    }) {
        return Err(failure(
            "Recover the interrupted restore before making further changes",
        ));
    }
    task_mut(db, task_id)?.name = name.into();
    store.save(db)
}

fn rename(
    store: &Storage,
    db: &mut Database,
    task_id: &str,
    checkpoint_id: &str,
    name: &str,
) -> Result<(), DesktopError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(failure(
            "Enter a single-line checkpoint name of 1 to 100 characters",
        ));
    }
    let point = task_mut(db, task_id)?
        .checkpoints
        .iter_mut()
        .find(|point| point.id == checkpoint_id)
        .ok_or_else(|| failure("Checkpoint not found"))?;
    point.name = name.into();
    db.custom_checkpoint_names.insert(checkpoint_id.into());
    store.save(db)
}

fn summarize(store: &Storage, point: &Checkpoint) -> Result<CheckpointSummary, DesktopError> {
    let before = store.snapshot(&point.before)?;
    let after = store.snapshot(
        point
            .after
            .as_deref()
            .ok_or_else(|| failure("Recording is incomplete"))?,
    )?;
    let mut paths = BTreeSet::new();
    for (before, after) in before.repositories.iter().zip(&after.repositories) {
        let repository = after.path.clone();
        for (before, after) in [
            (&before.working, &after.working),
            (&before.index, &after.index),
        ] {
            for path in before.keys().chain(after.keys()) {
                if before.get(path) != after.get(path) {
                    paths.insert((repository.clone(), path.clone()));
                }
            }
        }
    }
    Ok(CheckpointSummary {
        files: paths.len() as u32,
        paths: paths
            .into_iter()
            .take(2)
            .map(|(repository, path)| {
                let name = Path::new(&repository)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();
                format!("{name}/{path}")
            })
            .collect(),
    })
}

fn prompt_title(prompt: &str) -> String {
    prompt::title(prompt)
}

fn checkpoint_prompt(
    store: &Storage,
    db: &Database,
    task_id: &str,
    checkpoint_id: &str,
) -> Result<Option<String>, DesktopError> {
    let point = db
        .tasks
        .iter()
        .find(|task| task.id == task_id)
        .and_then(|task| {
            task.checkpoints
                .iter()
                .find(|point| point.id == checkpoint_id)
        })
        .ok_or_else(|| failure("Checkpoint not found"))?;
    let hashes = point
        .prompt_hash
        .iter()
        .chain(db.additional_messages.get(&point.id).into_iter().flatten());
    let messages = hashes
        .map(|hash| String::from_utf8(store.get(hash)?).map_err(io))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((!messages.is_empty()).then(|| messages.join("\n\n---\n\n")))
}

fn diff_task_id(db: &Database, source: &CheckpointDiffSource) -> Result<String, DesktopError> {
    match source {
        CheckpointDiffSource::Checkpoint { task_id, .. } => Ok(task_id.clone()),
        CheckpointDiffSource::Preview { preview_id } => db
            .previews
            .iter()
            .find(|p| &p.preview.id == preview_id)
            .map(|p| p.preview.task_id.clone())
            .ok_or_else(|| failure("Preview not found")),
    }
}

async fn file_diff(
    store: &Storage,
    db: &Database,
    source: &CheckpointDiffSource,
    repository: &str,
    path: &str,
    layer: &str,
    token: &CancellationToken,
) -> Result<DiffDocument, DesktopError> {
    let (before, after) = match source {
        CheckpointDiffSource::Checkpoint {
            task_id,
            checkpoint_id,
        } => {
            let point = db
                .tasks
                .iter()
                .find(|t| &t.id == task_id)
                .and_then(|t| t.checkpoints.iter().find(|p| &p.id == checkpoint_id))
                .ok_or_else(|| failure("Checkpoint not found"))?;
            (
                &point.before,
                point
                    .after
                    .as_ref()
                    .ok_or_else(|| failure("Recording is incomplete"))?,
            )
        }
        CheckpointDiffSource::Preview { preview_id } => {
            let prepared = db
                .previews
                .iter()
                .find(|p| &p.preview.id == preview_id)
                .ok_or_else(|| failure("Preview not found"))?;
            (&prepared.current, &prepared.desired)
        }
    };
    let before = store.snapshot(before)?;
    let after = store.snapshot(after)?;
    let entries = |snapshot: Snapshot| -> Result<_, DesktopError> {
        let repo = snapshot
            .repositories
            .into_iter()
            .find(|r| r.path == repository)
            .ok_or_else(|| failure("Repository not found"))?;
        match layer {
            "working" => Ok(repo.working),
            "index" => Ok(repo.index),
            _ => Err(failure("Invalid checkpoint layer")),
        }
    };
    let before = entries(before)?;
    let after = entries(after)?;
    if !before.contains_key(path) && !after.contains_key(path) {
        return Err(failure("File not found in checkpoint"));
    }
    let bytes = |entry: Option<&Entry>| -> Result<Vec<u8>, DesktopError> {
        entry
            .map(|entry| store.get(&entry.hash))
            .transpose()
            .map(Option::unwrap_or_default)
    };
    crate::diff_content::compare(
        path,
        &bytes(before.get(path))?,
        &bytes(after.get(path))?,
        token,
    )
    .await
}

fn details(store: &Storage, point: &Checkpoint) -> Result<Vec<RestoreFile>, DesktopError> {
    let before = store.snapshot(&point.before)?;
    let after = store.snapshot(
        point
            .after
            .as_deref()
            .ok_or_else(|| failure("Recording is incomplete"))?,
    )?;
    let mut result = Vec::new();
    for (b, a) in before.repositories.iter().zip(after.repositories) {
        let repository = a.path.clone();
        for (layer, b, a) in [
            ("working", &b.working, &a.working),
            ("index", &b.index, &a.index),
        ] {
            for name in b.keys().chain(a.keys()).collect::<BTreeSet<_>>() {
                if b.get(name) == a.get(name) {
                    continue;
                }
                result.push(RestoreFile {
                    repository: repository.clone(),
                    path: name.clone(),
                    layer: layer.into(),
                    status: if !a.contains_key(name) {
                        "deleted"
                    } else if !b.contains_key(name) {
                        "added"
                    } else {
                        "modified"
                    }
                    .into(),
                    // This response is navigation metadata. The Diff action loads
                    // and validates bytes only for the file the user opens.
                    before: None,
                    after: None,
                });
            }
        }
    }
    Ok(result)
}
fn codex_home() -> Result<PathBuf, DesktopError> {
    if let Some(path) = std::env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(path));
    }
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(|home| PathBuf::from(home).join(".codex"))
        .ok_or_else(|| failure("Codex home directory was not found"))
}
fn hook_command(config: &Path, executable: &Path) -> Result<String, DesktopError> {
    Ok(format!(
        "{} --versiondock-checkpoint-hook {}",
        quote_command(&executable.to_string_lossy())?,
        quote_command(&config.to_string_lossy())?
    ))
}
fn hooks_installed(config: &Path) -> Result<bool, DesktopError> {
    hooks_installed_at(
        &codex_home()?.join("hooks.json"),
        config,
        &std::env::current_exe().map_err(io)?,
    )
}
fn hooks_installed_at(
    target: &Path,
    config: &Path,
    executable: &Path,
) -> Result<bool, DesktopError> {
    if !executable.is_file() {
        return Ok(false);
    }
    let bytes = match fs::read(target) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io(error)),
    };
    let data: serde_json::Value = serde_json::from_slice(&bytes).map_err(io)?;
    let expected = hook_command(config, executable)?;
    Ok(["UserPromptSubmit", "Stop", "Interrupt"]
        .iter()
        .all(|event| {
            data["hooks"][event].as_array().is_some_and(|groups| {
                groups.iter().any(|group| {
                    group
                        .get("matcher")
                        .is_none_or(|m| m.as_str().is_none_or(str::is_empty))
                        && group["hooks"].as_array().is_some_and(|handlers| {
                            handlers.iter().any(|handler| {
                                handler["type"] == "command"
                                    && handler["command"].as_str() == Some(&expected)
                                    && !handler["async"].as_bool().unwrap_or(false)
                            })
                        })
                })
            })
        }))
}
fn quote_command(value: &str) -> Result<String, DesktopError> {
    if cfg!(windows) {
        if value.contains(['"', '%', '\n', '\r']) {
            return Err(failure("Unsupported character in hook executable path"));
        }
        Ok(format!("\"{value}\""))
    } else {
        Ok(format!("'{}'", value.replace('\'', "'\\''")))
    }
}
fn install_hooks(config: &Path) -> Result<(), DesktopError> {
    install_hooks_at(
        config,
        &codex_home()?.join("hooks.json"),
        &std::env::current_exe().map_err(io)?,
    )
}
fn install_hooks_at(config: &Path, target: &Path, executable: &Path) -> Result<(), DesktopError> {
    let original = match fs::read(target) {
        Ok(v) => Some(v),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(io(e)),
    };
    let mut data: serde_json::Value = match &original {
        Some(v) => serde_json::from_slice(v).map_err(io)?,
        None => serde_json::json!({}),
    };
    let hooks = data
        .as_object_mut()
        .ok_or_else(|| failure("Invalid Codex hook configuration"))?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| failure("Invalid Codex hook configuration"))?;
    let command = hook_command(config, executable)?;
    for event in ["UserPromptSubmit", "Stop", "Interrupt"] {
        let groups = hooks
            .entry(event)
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or_else(|| failure("Invalid Codex hook event configuration"))?;
        // Remove only our handlers, retaining unrelated handlers in shared matcher groups.
        for group in groups.iter_mut() {
            if let Some(handlers) = group["hooks"].as_array_mut() {
                handlers.retain(|h| {
                    !h["command"]
                        .as_str()
                        .is_some_and(|c| c.contains("--versiondock-checkpoint-hook"))
                });
            }
        }
        groups.retain(|g| !g["hooks"].as_array().is_some_and(Vec::is_empty));
        groups.push(serde_json::json!({"hooks": [{"type": "command", "command": command, "timeout": if event == "Interrupt" { 3 } else { 600 }}]}));
    }
    let latest = match fs::read(target) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(io(e)),
    };
    if latest != original {
        return Err(failure(
            "Codex hook configuration changed; retry installation",
        ));
    }
    if let Some(bytes) = original {
        atomic(
            &target.with_file_name(format!(
                "hooks.versiondock-backup-{}.json",
                uuid::Uuid::new_v4()
            )),
            &bytes,
        )?;
    }
    atomic(target, &serde_json::to_vec_pretty(&data).map_err(io)?)
}

#[derive(serde::Deserialize)]
struct HookInput {
    session_id: String,
    turn_id: Option<String>,
    cwd: String,
    hook_event_name: String,
    #[serde(default)]
    prompt: Option<String>,
}
async fn hook(
    config: &Path,
    input: HookInput,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let _guard =
        crate::update_worker::repository_lock(config, "checkpoint-storage-v1", token).await?;
    let store = Storage::new(config)?;
    let mut db = store.read()?;
    let cwd = dunce::canonicalize(&input.cwd).map_err(io)?;
    let Some(index) = db
        .tasks
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            t.mode == RecordingMode::Automatic && t.roots.iter().any(|r| cwd.starts_with(r))
        })
        .max_by_key(|(_, t)| {
            t.roots
                .iter()
                .filter(|r| cwd.starts_with(r))
                .map(|r| Path::new(r).components().count())
                .max()
                .unwrap_or(0)
        })
        .map(|(i, _)| i)
    else {
        return Ok(());
    };
    let task_id = db.tasks[index].id.clone();
    if input.hook_event_name == "UserPromptSubmit" {
        if let Some(point) = db.tasks[index].checkpoints.iter().find(|point| {
            point.session_id.as_deref() == Some(&input.session_id)
                && point.turn_id.as_deref() == input.turn_id.as_deref()
                && point.status == "recording"
        }) {
            let id = point.id.clone();
            let original = point.prompt_hash.clone();
            if let Some(prompt) = input.prompt.as_deref().filter(|p| !p.trim().is_empty()) {
                let hash = digest(prompt.as_bytes());
                let additions = db.additional_messages.entry(id.clone()).or_default();
                if original.as_deref() != Some(&hash) && !additions.contains(&hash) {
                    let hash = store.put(prompt.as_bytes())?;
                    if original.is_none() {
                        let point = db.tasks[index]
                            .checkpoints
                            .iter_mut()
                            .find(|p| p.id == id)
                            .unwrap();
                        point.prompt_hash = Some(hash);
                        if !db.custom_checkpoint_names.contains(&point.id)
                            && (point.name == "Codex turn" || point.name == "Checkpoint")
                        {
                            point.name = prompt_title(prompt);
                        }
                    } else {
                        additions.push(hash);
                    }
                }
            }
            db.tasks[index].last_hook_at = Some(now());
            db.tasks[index].hook_error = None;
            return store.save(&db);
        }
    }

    if !db.tasks[index].hook_events.contains(&input.hook_event_name) {
        db.tasks[index]
            .hook_events
            .push(input.hook_event_name.clone());
    }
    db.tasks[index].last_hook_at = Some(now());
    store.save(&db)?;
    let turn = match input.turn_id.as_deref() {
        Some(turn) => turn,
        None => {
            db.tasks[index].hook_error = Some(
                "Codex hook did not provide a turn_id; automatic recording is incompatible".into(),
            );
            store.save(&db)?;
            return Err(failure(
                "Codex hook did not provide a turn_id; automatic recording is incompatible",
            ));
        }
    };
    if pending(&store, &db, &paths(&db.tasks[index]))? {
        return Err(failure("Recover the interrupted restore before recording"));
    }
    if input.hook_event_name == "Interrupt" {
        if let Some(point) = db.tasks[index].checkpoints.iter_mut().find(|p| {
            p.session_id.as_deref() == Some(&input.session_id)
                && p.turn_id.as_deref() == Some(turn)
                && p.status == "recording"
        }) {
            point.status = "interrupted".into();
        }
        return store.save(&db);
    }
    let (_local, _external) =
        lock_repositories(config, None, &paths(&db.tasks[index]), token).await?;
    let result = match input.hook_event_name.as_str() {
        "UserPromptSubmit" => {
            begin(
                &store,
                &mut db,
                &task_id,
                "Codex turn",
                Some((&input.session_id, turn)),
                input.prompt.as_deref(),
                token,
            )
            .await
        }
        "Stop" => {
            if let Some(point) = db.tasks[index].checkpoints.iter().find(|p| {
                p.session_id.as_deref() == Some(&input.session_id)
                    && p.turn_id.as_deref() == Some(turn)
            }) {
                if matches!(point.status.as_str(), "completed" | "undone" | "abandoned") {
                    return Ok(());
                }
                if point.status == "interrupted" {
                    return Ok(());
                }
                finish(&store, &mut db, &task_id, token).await
            } else {
                Err(failure(
                    "Codex Stop arrived without a matching start; this turn is not protected",
                ))
            }
        }
        _ => Ok(()),
    };
    if input.hook_event_name == "Stop" && result.is_ok() {
        let executable = std::env::current_exe().map_err(io)?;
        db.verified_hooks.insert(
            task_id.clone(),
            HookVerification {
                completed_at: now(),
                command_fingerprint: digest(hook_command(config, &executable)?.as_bytes()),
            },
        );
    }
    db.tasks[index].hook_error = result.as_ref().err().map(|e| e.message.clone());
    store.save(&db)?;
    result
}
/// Called before Tauri initializes, including when no application window is running.
pub(crate) fn run_if_hook() -> bool {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--versiondock-checkpoint-hook")) {
        return false;
    }
    let config = arguments.next().map(PathBuf::from);
    let mut event_name = String::new();
    let result = (|| -> Result<(), DesktopError> {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(4 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(io)?;
        let input: HookInput = serde_json::from_slice(&bytes).map_err(io)?;
        event_name = input.hook_event_name.clone();
        let interrupted = input.hook_event_name == "Interrupt";
        let config = config
            .as_deref()
            .ok_or_else(|| failure("Missing VersionDock data directory"))?;
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(io)?
            .block_on(async {
                let token = CancellationToken::new();
                tokio::time::timeout(
                    std::time::Duration::from_secs(if interrupted { 2 } else { 570 }),
                    hook(config, input, &token),
                )
                .await
                .map_err(|_| {
                    failure("Checkpoint hook timed out; inspect the incomplete recording")
                })?
            })
    })();
    match result {
        Ok(()) => {
            println!("{{}}");
            std::process::exit(0);
        }
        Err(error) => {
            let message = hook_error_message(config.as_deref(), &error.message);
            if event_name == "Stop" || event_name == "Interrupt" {
                // Exit 2 on Stop would tell Codex to start another turn. Recording failures
                // must report lost protection, never create an automatic continuation loop.
                println!(
                    "{}",
                    serde_json::json!({"systemMessage": format!("VersionDock: {message}")})
                );
                std::process::exit(0);
            }
            eprintln!("VersionDock: {message}");
            std::process::exit(2);
        }
    }
}

fn hook_error_message(config: Option<&Path>, message: &str) -> String {
    let preference = config
        .and_then(|config| fs::read(config.join("state.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|state| {
            state["settings"]
                .get("language")
                .or_else(|| state.get("language"))
                .cloned()
        })
        .and_then(|value| serde_json::from_value::<crate::models::LanguagePreference>(value).ok())
        .unwrap_or_default();
    if !crate::language::is_chinese(&preference) {
        return message.into();
    }
    match message {
        "Another chat has an unfinished recording in this task. Finish that recording first, or use an isolated task workspace for parallel chats." => "另一个聊天在此任务中有未结束的记录。请先结束该记录；多个聊天并行开发时，请使用隔离任务工作区。",
        "The previous turn in this chat has not ended and no interruption was recorded. Stop the previous turn, then finish its recording in VersionDock before resending." => "当前聊天的上一轮尚未结束，也未收到中断事件。请先停止上一轮，在 VersionDock 中结束记录后重新发送。",
        "The previous checkpoint is incomplete. Stop file writes and finish or abandon it in VersionDock before resending." => "上一条检查点记录不完整。请先停止文件写入，在 VersionDock 中结束或放弃该记录后重新发送。",
        "This task has an unfinished manual recording. Stop file writes and finish or abandon it in VersionDock before continuing." => "此任务有未结束的手动记录。请先停止文件写入，在 VersionDock 中结束或放弃该记录后继续。",
        "Files or index changed during checkpoint capture; retry after writes stop" => "拍摄检查点时文件或暂存区仍在变化，原记录已保留。请停止后台写入后重新发送，或在 VersionDock 中手动结束记录。",
        _ => message,
    }.into()
}
