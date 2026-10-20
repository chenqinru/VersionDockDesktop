//! Paged history and on-demand storage accounting. Background polling does neither.
use super::{activity, belongs, cleanup, connections, io, reads, redo, storage::*, types::*};
use crate::models::{DesktopError, WorkspaceDescriptor};
use std::collections::BTreeMap;

pub(super) fn overview(
    store: &Storage,
    db: &Database,
    workspace: &WorkspaceDescriptor,
) -> Result<CheckpointListing, DesktopError> {
    let mut output = activity(db, workspace);
    // Preserve the newest undoable checkpoint even when the newest interval was abandoned.
    for task in &mut output.tasks {
        let original = db.tasks.iter().find(|t| t.id == task.id).unwrap();
        if let Some(point) = original
            .checkpoints
            .iter()
            .rev()
            .find(|p| p.status == "completed")
        {
            if !task.checkpoints.iter().any(|p| p.id == point.id) {
                task.checkpoints.push(point.clone());
            }
        }
        for point in &mut task.checkpoints {
            super::prompt::display_name(store, db, point);
        }
    }
    Ok(CheckpointListing {
        tasks: output.tasks,
        recovery: output.recovery,
        storage_bytes: 0,
        hooks_installed: super::hooks_installed(store.root.parent().unwrap()).unwrap_or(false),
        connections: Some(connections::all(
            db,
            workspace,
            store.root.parent().unwrap(),
        )),
        history_counts: Some(
            db.tasks
                .iter()
                .filter(|task| belongs(task, workspace))
                .map(|t| (t.id.clone(), t.checkpoints.len() as u32))
                .collect::<BTreeMap<_, _>>(),
        ),
        history_revisions: Some(
            db.tasks
                .iter()
                .filter(|task| belongs(task, workspace))
                .map(|task| Ok((task.id.clone(), history_revision(db, task)?)))
                .collect::<Result<_, DesktopError>>()?,
        ),
        redo_tasks: Some(
            db.tasks
                .iter()
                .filter(|task| belongs(task, workspace) && redo::candidate(db, task).is_some())
                .map(|t| t.id.clone())
                .collect(),
        ),
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn page(
    store: &Storage,
    db: &Database,
    task_id: &str,
    query: &str,
    repository: Option<&str>,
    only_changes: bool,
    offset: u32,
    revision: Option<&str>,
) -> Result<CheckpointPage, DesktopError> {
    let task = db
        .tasks
        .iter()
        .find(|t| t.id == task_id)
        .ok_or_else(|| failure("Task not found"))?;
    if repository.is_some_and(|repo| !task.repositories.iter().any(|r| r.task_path == repo)) {
        return Err(failure("Repository does not belong to this task"));
    }
    let current_revision = history_revision(db, task)?;
    let offset = if revision.is_some_and(|r| r != current_revision) {
        0
    } else {
        offset
    };
    let query = query.trim().to_lowercase();
    let mut matching = Vec::new();
    for original in task.checkpoints.iter().rev() {
        let mut point = original.clone();
        // Search reads message text only on an explicit nonempty query.
        if !query.is_empty() {
            super::prompt::display_name(store, db, &mut point);
            if !point.name.to_lowercase().contains(&query)
                && !super::prompt::messages(store, db, task_id, &point.id)?
                    .iter()
                    .any(|message| {
                        super::prompt::search_text(message)
                            .to_lowercase()
                            .contains(&query)
                    })
            {
                continue;
            }
        }
        if point.summary.is_none()
            && point.after.is_some()
            && (only_changes || repository.is_some())
        {
            point.summary = reads::summary(store, &point).ok();
        }
        if only_changes
            && point.after.is_some()
            && point.summary.as_ref().is_some_and(|s| s.files == 0)
            && matches!(
                point.status.as_str(),
                "completed" | "undone" | "applied" | "abandoned"
            )
            && point.error.is_none()
        {
            continue;
        }
        if let (Some(repo), Some(after)) = (repository, &point.after) {
            let before = store.snapshot(&point.before)?;
            let after = store.snapshot(after)?;
            if !before
                .repositories
                .iter()
                .zip(&after.repositories)
                .any(|(b, a)| b.path == repo && (b.working != a.working || b.index != a.index))
            {
                continue;
            }
        }
        matching.push(point);
    }
    let count = matching.len() as u32;
    let offset = if offset >= count { 0 } else { offset };
    let mut points = matching
        .into_iter()
        .skip(offset as usize)
        .take(50)
        .collect::<Vec<_>>();
    for point in &mut points {
        super::prompt::display_name(store, db, point);
        if point.summary.is_none() && point.after.is_some() {
            point.summary = reads::summary(store, point).ok();
        }
    }
    let following_turns = points
        .iter()
        .map(|point| {
            let index = task
                .checkpoints
                .iter()
                .position(|p| p.id == point.id)
                .unwrap();
            (
                point.id.clone(),
                task.checkpoints[index + 1..]
                    .iter()
                    .filter(|p| p.status == "completed")
                    .count() as u32,
            )
        })
        .collect();
    Ok(CheckpointPage {
        task_id: task_id.into(),
        points,
        total: task.checkpoints.len() as u32,
        matching: count,
        offset,
        revision: current_revision,
        following_turns,
    })
}

pub(super) fn storage_usage(
    store: &Storage,
    db: &Database,
    task_id: Option<&str>,
) -> Result<CheckpointStorageUsage, DesktopError> {
    let total = store.size()?;
    let (task_bytes, reclaimable_bytes) = if let Some(id) = task_id {
        if !db.tasks.iter().any(|task| task.id == id) {
            return Err(failure("Task not found"));
        }
        let mut subset = db.clone();
        subset.tasks.retain(|t| t.id == id);
        subset.previews.retain(|p| p.preview.task_id == id);
        subset.transactions.retain(|tx| tx.report.task_id == id);
        let unreferenced = store
            .unreferenced(&subset)?
            .iter()
            .map(|(_, bytes)| *bytes)
            .sum::<u64>();
        (
            total.saturating_sub(unreferenced),
            cleanup::preview(store, db, id, 0)
                .ok()
                .map(|p| p.preview.reclaimable_bytes),
        )
    } else {
        (0, None)
    };
    Ok(CheckpointStorageUsage {
        path: store.root.to_string_lossy().into_owned(),
        total_bytes: total as f64,
        task_bytes: task_bytes as f64,
        reclaimable_bytes,
        warning: total >= 1024 * 1024 * 1024,
    })
}

fn history_revision(db: &Database, task: &TaskWorkspace) -> Result<String, DesktopError> {
    let messages = task
        .checkpoints
        .iter()
        .filter_map(|point| {
            db.additional_messages
                .get(&point.id)
                .map(|messages| (&point.id, messages))
        })
        .collect::<BTreeMap<_, _>>();
    let custom_names = task
        .checkpoints
        .iter()
        .filter(|point| db.custom_checkpoint_names.contains(&point.id))
        .map(|point| &point.id)
        .collect::<Vec<_>>();
    Ok(digest(
        &serde_json::to_vec(&(task, messages, custom_names)).map_err(io)?,
    ))
}
