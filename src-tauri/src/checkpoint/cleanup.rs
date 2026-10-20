//! Explicit checkpoint retention. Persist references first, then reclaim unreachable objects.
use super::{active, storage::*, types::*};
use crate::models::{DesktopError, WorkspaceDescriptor};
use std::{collections::BTreeSet, fs, path::PathBuf};
use tokio_util::sync::CancellationToken;

pub(super) struct Plan {
    pub preview: CheckpointCleanupPreview,
    database: Database,
    garbage: Vec<(PathBuf, u64)>,
}

pub(super) fn preview(
    store: &Storage,
    db: &Database,
    task_id: &str,
    keep_recent: u32,
) -> Result<Plan, DesktopError> {
    let (database, remove_count, protected_count) = prune_task(db, task_id, keep_recent)?;
    let garbage = store.unreferenced(&database)?;
    let fingerprint =
        digest(&serde_json::to_vec(&(task_id, keep_recent, db, &garbage)).map_err(io)?);
    Ok(Plan {
        preview: CheckpointCleanupPreview {
            task_id: task_id.into(),
            keep_recent,
            remove_count,
            protected_count,
            reclaimable_bytes: garbage.iter().map(|(_, bytes)| *bytes as f64).sum(),
            fingerprint,
        },
        database,
        garbage,
    })
}

pub(super) fn check_task(db: &Database, task: &TaskWorkspace) -> Result<(), DesktopError> {
    if active(task) {
        return Err(failure(
            "Finish the active recording before cleaning checkpoints",
        ));
    }
    if db.transactions.iter().any(|tx| {
        tx.report.task_id == task.id && matches!(tx.report.status.as_str(), "pending" | "failed")
    }) {
        return Err(failure(
            "Recover the interrupted restore before cleaning checkpoints",
        ));
    }
    Ok(())
}

fn prune_task(
    db: &Database,
    task_id: &str,
    keep_recent: u32,
) -> Result<(Database, u32, u32), DesktopError> {
    let task = db
        .tasks
        .iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| failure("Task not found"))?;
    check_task(db, task)?;
    let mut protected = BTreeSet::new();
    let redo = super::redo::candidate(db, task);
    if let Some(tx) = redo {
        protected.extend(tx.prepared.checkpoint_ids.iter().cloned());
    }
    // A successful bring-back remains undoable. Its saved bookkeeping and snapshots
    // must survive cleanup until the user undoes that operation.
    for tx in db.transactions.iter().filter(|tx| {
        tx.report.task_id == task_id
            && tx.report.status == "succeeded"
            && tx.prepared.preview.bring_back
    }) {
        protected.insert(tx.report.id.clone());
        protected.extend(
            tx.prepared
                .task_before
                .checkpoints
                .iter()
                .map(|point| point.id.clone()),
        );
    }
    let last_applied = task
        .checkpoints
        .iter()
        .rposition(|point| point.status == "applied");
    for (index, point) in task.checkpoints.iter().enumerate() {
        if point.status == "applied"
            || !matches!(point.status.as_str(), "completed" | "undone" | "abandoned")
            || (task.isolation == TaskIsolation::Worktree
                && point.status == "completed"
                && last_applied.is_none_or(|applied| index > applied))
        {
            protected.insert(point.id.clone());
        }
    }
    let cutoff = task.checkpoints.len().saturating_sub(keep_recent as usize);
    let remove = task
        .checkpoints
        .iter()
        .take(cutoff)
        .filter(|point| !protected.contains(&point.id))
        .map(|point| point.id.clone())
        .collect::<BTreeSet<_>>();
    let mut database = db.clone();
    database
        .tasks
        .iter_mut()
        .find(|task| task.id == task_id)
        .unwrap()
        .checkpoints
        .retain(|point| !remove.contains(&point.id));
    database
        .custom_checkpoint_names
        .retain(|id| !remove.contains(id));
    // Any outstanding preview for this task becomes stale when history is removed.
    database
        .previews
        .retain(|preview| preview.preview.task_id != task_id);
    database.transactions.retain(|tx| {
        tx.report.task_id != task_id
            || redo.is_some_and(|redo| redo.report.id == tx.report.id)
            || (tx.report.status == "succeeded" && tx.prepared.preview.bring_back)
            || !matches!(tx.report.status.as_str(), "succeeded" | "recovered")
    });
    let protected_count = task
        .checkpoints
        .iter()
        .filter(|point| protected.contains(&point.id))
        .count() as u32;
    Ok((database, remove.len() as u32, protected_count))
}

pub(super) fn project_preview(
    store: &Storage,
    db: &Database,
    workspace: &WorkspaceDescriptor,
    keep_recent: u32,
) -> Result<(ProjectCleanupPreview, Database), DesktopError> {
    let ids = db
        .tasks
        .iter()
        .filter(|task| task.workspace_id == workspace.id)
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Err(failure("No checkpoint tasks yet"));
    }
    let mut database = db.clone();
    let mut remove_count = 0;
    let mut protected_count = 0;
    for id in ids {
        let (next, removed, protected) = prune_task(&database, &id, keep_recent)?;
        database = next;
        remove_count += removed;
        protected_count += protected;
    }
    let garbage = store.unreferenced(&database)?;
    let fingerprint =
        digest(&serde_json::to_vec(&(&workspace.id, keep_recent, db, &garbage)).map_err(io)?);
    Ok((
        ProjectCleanupPreview {
            project_id: workspace.id.clone(),
            keep_recent,
            remove_count,
            protected_count,
            reclaimable_bytes: garbage.iter().map(|(_, bytes)| *bytes as f64).sum(),
            fingerprint,
        },
        database,
    ))
}

pub(super) fn project_execute(
    store: &Storage,
    db: &mut Database,
    workspace: &WorkspaceDescriptor,
    keep_recent: u32,
    fingerprint: &str,
    token: &CancellationToken,
) -> Result<CheckpointCleanupReport, DesktopError> {
    let (preview, database) = project_preview(store, db, workspace, keep_recent)?;
    if preview.fingerprint != fingerprint {
        return Err(failure(
            "Checkpoint cleanup preview is stale; preview again",
        ));
    }
    if token.is_cancelled() {
        return Err(failure("Checkpoint cleanup cancelled"));
    }
    let garbage = store.unreferenced(&database)?;
    store.save(&database)?;
    *db = database;
    Ok(reclaim(preview.remove_count, garbage, token))
}

pub(super) fn execute(
    store: &Storage,
    db: &mut Database,
    task_id: &str,
    keep_recent: u32,
    fingerprint: &str,
    token: &CancellationToken,
) -> Result<CheckpointCleanupReport, DesktopError> {
    let plan = preview(store, db, task_id, keep_recent)?;
    if plan.preview.fingerprint != fingerprint {
        return Err(failure(
            "Checkpoint cleanup preview is stale; preview again",
        ));
    }
    if token.is_cancelled() {
        return Err(failure("Checkpoint cleanup cancelled"));
    }
    // After a crash here, unused objects may remain but every surviving reference
    // is valid. A subsequent cleanup can retry garbage collection safely.
    store.save(&plan.database)?;
    *db = plan.database;
    Ok(reclaim(plan.preview.remove_count, plan.garbage, token))
}

fn reclaim(
    removed_count: u32,
    garbage: Vec<(PathBuf, u64)>,
    token: &CancellationToken,
) -> CheckpointCleanupReport {
    let mut report = CheckpointCleanupReport {
        status: "succeeded".into(),
        removed_count,
        freed_bytes: 0.0,
        error: None,
    };
    for (path, bytes) in garbage {
        let result = if token.is_cancelled() {
            Err(failure("Checkpoint cleanup cancelled"))
        } else {
            fs::remove_file(path).map_err(io)
        };
        if let Err(error) = result {
            report.status = "partialFailure".into();
            report.error = Some(error.message);
            break;
        }
        report.freed_bytes += bytes as f64;
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_reclamation_reports_real_bytes_and_can_be_retried() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let blocked = temp.path().join("blocked");
        fs::write(&first, b"123").unwrap();
        fs::create_dir(&blocked).unwrap();
        let token = CancellationToken::new();
        let report = reclaim(2, vec![(first.clone(), 3), (blocked.clone(), 4)], &token);
        assert_eq!(report.status, "partialFailure");
        assert_eq!(report.removed_count, 2);
        assert_eq!(report.freed_bytes, 3.0);
        assert!(report.error.is_some());
        assert!(!first.exists());
        assert!(blocked.exists());
        fs::remove_dir(&blocked).unwrap();
        fs::write(&blocked, b"1234").unwrap();
        let report = reclaim(0, vec![(blocked, 4)], &token);
        assert_eq!(report.status, "succeeded");
        assert_eq!(report.freed_bytes, 4.0);
    }
}
