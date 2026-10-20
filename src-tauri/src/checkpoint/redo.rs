//! A redo is a new protected restore transaction reversing the most recent successful undo.
use super::{active, now, restore::prepare, storage::*, types::*};
use crate::models::{DesktopError, WorkspaceDescriptor};
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;

pub(super) fn candidate<'a>(db: &'a Database, task: &TaskWorkspace) -> Option<&'a Transaction> {
    if active(task) {
        return None;
    }
    let tx = db
        .transactions
        .iter()
        .rev()
        .find(|tx| tx.report.task_id == task.id && tx.report.status != "recovered")?;
    if tx.report.status != "succeeded"
        || tx.prepared.preview.bring_back
        || tx.prepared.preview.redo_of.is_some()
        || task.last_applied != tx.prepared.task_before.last_applied
        || task.checkpoints.last().map(|p| &p.id)
            != tx.prepared.task_before.checkpoints.last().map(|p| &p.id)
        || tx.prepared.checkpoint_ids.is_empty()
        || !tx.prepared.checkpoint_ids.iter().all(|id| {
            task.checkpoints
                .iter()
                .any(|p| &p.id == id && p.status == "undone")
        })
    {
        return None;
    }
    Some(tx)
}

pub(super) fn checkpoints(
    db: &Database,
    workspace: &WorkspaceDescriptor,
) -> BTreeMap<String, Vec<String>> {
    db.tasks
        .iter()
        .filter(|task| super::belongs(task, workspace))
        .filter_map(|task| {
            candidate(db, task).map(|tx| (task.id.clone(), tx.prepared.checkpoint_ids.clone()))
        })
        .collect()
}

pub(super) async fn prepare_redo(
    store: &Storage,
    db: &Database,
    task: &TaskWorkspace,
    token: &CancellationToken,
) -> Result<Prepared, DesktopError> {
    let tx =
        candidate(db, task).ok_or_else(|| failure("There is no recent undo available to redo"))?;
    let mut synthetic = task.clone();
    synthetic.checkpoints = vec![Checkpoint {
        id: "redo-delta".into(),
        name: "Redo last undo".into(),
        created_at: now(),
        status: "completed".into(),
        session_id: None,
        turn_id: None,
        before: tx.prepared.current.clone(),
        after: Some(tx.prepared.desired.clone()),
        error: None,
        summary: None,
        prompt_hash: None,
    }];
    // Reuse all file/type/index checks, reverse three-way merge, and batch preflight.
    let mut prepared = prepare(store, &synthetic, None, false, token).await?;
    prepared.preview.redo_of = Some(tx.report.id.clone());
    prepared.checkpoint_ids = tx.prepared.checkpoint_ids.clone();
    prepared.task_state = digest(&serde_json::to_vec(task).map_err(io)?);
    prepared.task_before = task.clone();
    Ok(prepared)
}
