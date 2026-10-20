use super::{snapshot::*, storage::*, types::*};
use crate::{cli, models::DesktopError};
use std::{collections::BTreeSet, fs, path::Path};
use tokio_util::sync::CancellationToken;

async fn merge_entry(
    store: &Storage,
    base: Option<&Entry>,
    desired: Option<&Entry>,
    current: Option<&Entry>,
    token: &CancellationToken,
) -> Result<Option<Entry>, DesktopError> {
    if base == desired || desired == current {
        return Ok(current.cloned());
    }
    if base == current {
        return Ok(desired.cloned());
    }
    let (Some(base), Some(desired), Some(current)) = (base, desired, current) else {
        return Err(failure(
            "File creation or deletion conflicts with later changes",
        ));
    };
    if [&base.kind, &desired.kind, &current.kind]
        .iter()
        .any(|kind| kind.as_str() != "file")
    {
        return Err(failure("Link or file type changed"));
    }
    let mode = if base.mode == current.mode {
        desired.mode
    } else if base.mode == desired.mode || desired.mode == current.mode {
        current.mode
    } else {
        return Err(failure("File permissions conflict"));
    };
    if base.hash == desired.hash {
        return Ok(Some(Entry {
            mode,
            ..current.clone()
        }));
    }
    if base.hash == current.hash {
        return Ok(Some(Entry {
            mode,
            ..desired.clone()
        }));
    }
    let temp = tempfile::tempdir().map_err(io)?;
    for (name, entry) in [("base", base), ("desired", desired), ("current", current)] {
        let bytes = store.get(&entry.hash)?;
        if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
            return Err(failure("Binary file changed after recording"));
        }
        fs::write(temp.path().join(name), bytes).map_err(io)?;
    }
    let result = cli::run_with_isolated_git_index(
        &[
            "merge-file".into(),
            "-p".into(),
            "--".into(),
            "current".into(),
            "base".into(),
            "desired".into(),
        ],
        temp.path(),
        None,
        std::time::Duration::from_secs(120),
        token,
        &[],
    )
    .await?;

    Ok(Some(Entry {
        hash: store.put(&result.stdout)?,
        mode,
        kind: "file".into(),
    }))
}

pub(super) async fn prepare(
    store: &Storage,
    task: &TaskWorkspace,
    checkpoint_id: Option<&str>,
    bring_back: bool,
    token: &CancellationToken,
) -> Result<Prepared, DesktopError> {
    if task.checkpoints.iter().any(|p| {
        matches!(
            p.status.as_str(),
            "recording" | "incomplete" | "interrupted"
        )
    }) {
        return Err(failure(
            "Finish the active or incomplete recording before restoring",
        ));
    }
    let ids = if bring_back {
        Vec::new()
    } else {
        let completed = task
            .checkpoints
            .iter()
            .filter(|p| p.status == "completed")
            .collect::<Vec<_>>();
        let selected = match checkpoint_id {
            Some(id) => completed.iter().position(|p| p.id == id),
            None => completed.len().checked_sub(1),
        }
        .ok_or_else(|| failure("No completed checkpoint to undo"))?;
        completed[selected..]
            .iter()
            .map(|p| p.id.clone())
            .collect::<Vec<_>>()
    };
    let (base, desired) = if bring_back {
        let desired = capture(
            store,
            &task
                .repositories
                .iter()
                .map(|r| r.task_path.clone())
                .collect::<Vec<_>>(),
            token,
        )
        .await?;
        let seed = store.snapshot(&task.seed)?;
        for (repo, initial) in desired.repositories.iter().zip(&seed.repositories) {
            if repo.head != initial.head || repo.branch != initial.branch {
                return Err(failure(
                    "Task HEAD or branch changed; history rollback is not supported",
                ));
            }
        }
        (
            store.snapshot(task.last_applied.as_deref().unwrap_or(&task.source_seed))?,
            desired,
        )
    } else {
        let first = task
            .checkpoints
            .iter()
            .find(|p| p.id == ids[0])
            .ok_or_else(|| failure("Checkpoint not found"))?;
        let last = task
            .checkpoints
            .iter()
            .find(|p| Some(&p.id) == ids.last())
            .ok_or_else(|| failure("Checkpoint not found"))?;
        for point in task.checkpoints.iter().filter(|p| ids.contains(&p.id)) {
            let before = store.snapshot(&point.before)?;
            let after = store.snapshot(
                point
                    .after
                    .as_deref()
                    .ok_or_else(|| failure("Incomplete checkpoint"))?,
            )?;
            for (b, a) in before.repositories.iter().zip(after.repositories) {
                if b.head != a.head || b.branch != a.branch {
                    return Err(failure(
                        "Recorded turn changed HEAD or branch; history rollback is not supported",
                    ));
                }
            }
        }
        (
            store.snapshot(
                last.after
                    .as_deref()
                    .ok_or_else(|| failure("Incomplete checkpoint"))?,
            )?,
            store.snapshot(&first.before)?,
        )
    };
    let paths = task
        .repositories
        .iter()
        .map(|r| {
            if bring_back {
                r.source_path.clone()
            } else {
                r.task_path.clone()
            }
        })
        .collect::<Vec<_>>();
    let current = capture(store, &paths, token).await?;
    let mut steps = if bring_back {
        vec![(base, desired)]
    } else {
        let mut steps = Vec::new();
        for id in ids.iter().rev() {
            let point = task
                .checkpoints
                .iter()
                .find(|p| &p.id == id)
                .ok_or_else(|| failure("Checkpoint not found"))?;
            steps.push((
                store.snapshot(
                    point
                        .after
                        .as_deref()
                        .ok_or_else(|| failure("Incomplete checkpoint"))?,
                )?,
                store.snapshot(&point.before)?,
            ));
        }
        steps
    };
    let source_task_fingerprint = if bring_back {
        Some(store.save_snapshot(&steps[0].1)?)
    } else {
        None
    };
    let mut target = current.clone();
    let mut files = Vec::new();
    let mut conflicts = Vec::new();
    for (base, desired) in steps.drain(..) {
        let step_current = target.clone();
        for (i, ((base, desired), current)) in base
            .repositories
            .iter()
            .zip(&desired.repositories)
            .zip(&step_current.repositories)
            .enumerate()
        {
            if current.head != base.head || (!bring_back && current.branch != base.branch) {
                conflicts.push(format!("{}: HEAD or branch changed", current.path));
                continue;
            }
            if bring_back {
                let source = store.snapshot(&task.source_seed)?;
                if current.branch != source.repositories[i].branch {
                    conflicts.push(format!("{}: source branch changed", current.path));
                    continue;
                }
            }
            for (layer, b, d, c) in [
                ("working", &base.working, &desired.working, &current.working),
                ("index", &base.index, &desired.index, &current.index),
            ] {
                if bring_back && layer == "index" {
                    continue;
                }
                let output = if layer == "index" {
                    &mut target.repositories[i].index
                } else {
                    &mut target.repositories[i].working
                };
                for name in b.keys().chain(d.keys()).collect::<BTreeSet<_>>() {
                    if b.get(name) == d.get(name) {
                        continue;
                    }
                    match merge_entry(store, b.get(name), d.get(name), c.get(name), token).await {
                        Ok(merged) => {
                            if merged.as_ref() != c.get(name) {
                                let before =
                                    c.get(name).map(|e| display_content(store, e)).transpose()?;
                                let after = merged
                                    .as_ref()
                                    .map(|e| display_content(store, e))
                                    .transpose()?;
                                files.push(RestoreFile {
                                    repository: current.path.clone(),
                                    path: name.clone(),
                                    layer: layer.into(),
                                    status: if merged.is_none() {
                                        "deleted"
                                    } else if c.contains_key(name) {
                                        "modified"
                                    } else {
                                        "added"
                                    }
                                    .into(),
                                    before,
                                    after,
                                });
                            }
                            match merged {
                                Some(entry) => {
                                    output.insert(name.clone(), entry);
                                }
                                None => {
                                    output.remove(name);
                                }
                            }
                        }
                        Err(e) if token.is_cancelled() => return Err(e),
                        Err(_) => conflicts.push(format!("{} / {} ({layer})", current.path, name)),
                    }
                }
            }
        }
    }
    // Describe the final net result, not the intermediate reverse-merge steps.
    files.clear();
    for (from, to) in current.repositories.iter().zip(&target.repositories) {
        for (layer, from_entries, to_entries) in [
            ("working", &from.working, &to.working),
            ("index", &from.index, &to.index),
        ] {
            for name in from_entries
                .keys()
                .chain(to_entries.keys())
                .collect::<BTreeSet<_>>()
            {
                if from_entries.get(name) == to_entries.get(name) {
                    continue;
                }
                files.push(RestoreFile {
                    repository: from.path.clone(),
                    path: name.clone(),
                    layer: layer.into(),
                    status: if !to_entries.contains_key(name) {
                        "deleted"
                    } else if from_entries.contains_key(name) {
                        "modified"
                    } else {
                        "added"
                    }
                    .into(),
                    before: from_entries
                        .get(name)
                        .map(|e| display_content(store, e))
                        .transpose()?,
                    after: to_entries
                        .get(name)
                        .map(|e| display_content(store, e))
                        .transpose()?,
                });
            }
        }
    }
    let current_hash = store.save_snapshot(&current)?;
    Ok(Prepared {
        preview: RestorePreview {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task.id.clone(),
            bring_back,
            files,
            conflicts,
            fingerprint: current_hash.clone(),
            redo_of: None,
        },
        current: current_hash,
        desired: store.save_snapshot(&target)?,
        checkpoint_ids: ids,
        task_state: digest(&serde_json::to_vec(task).map_err(io)?),
        task_before: task.clone(),
        source_task_fingerprint,
    })
}
fn display_content(store: &Storage, entry: &Entry) -> Result<String, DesktopError> {
    let bytes = store.get(&entry.hash)?;
    if bytes.len() > 128 * 1024 || bytes.contains(&0) {
        return Ok(format!("[binary or large content: {} bytes]", bytes.len()));
    }
    Ok(String::from_utf8(bytes).unwrap_or_else(|_| "[binary content]".into()))
}
pub(super) fn report(tx: &Transaction) -> RestoreReport {
    tx.report.clone()
}

pub(super) async fn apply(
    store: &Storage,
    db: &mut Database,
    position: usize,
    recovering: bool,
    token: &CancellationToken,
) -> Result<RestoreReport, DesktopError> {
    let tx = db.transactions[position].clone();
    let before = store.snapshot(&tx.prepared.current)?;
    let after = store.snapshot(&tx.prepared.desired)?;
    if recovering && tx.report.status == "succeeded" {
        if !tx.prepared.preview.bring_back {
            return Err(failure("Completed undo transactions do not need recovery"));
        }
        let task = db
            .tasks
            .iter()
            .find(|t| t.id == tx.report.task_id)
            .ok_or_else(|| failure("Task not found"))?;
        if super::active(task) || task.last_applied != tx.prepared.source_task_fingerprint {
            return Err(failure(
                "A later recording or bring-back operation prevents this recovery",
            ));
        }
    }
    let paths = before
        .repositories
        .iter()
        .map(|r| r.path.clone())
        .collect::<Vec<_>>();
    if !recovering {
        if let Some(expected) = &tx.prepared.source_task_fingerprint {
            let task_snapshot =
                capture(store, &super::paths(&tx.prepared.task_before), token).await?;
            if store.save_snapshot(&task_snapshot)? != *expected {
                return Err(failure(
                    "Task files changed after bring-back preview; preview again",
                ));
            }
        }
    }
    let current = capture(store, &paths, token).await?;
    let mut target = after.clone();
    if recovering {
        target = current.clone();
        for (i, (b, a)) in before
            .repositories
            .iter()
            .zip(&after.repositories)
            .enumerate()
        {
            let c = &current.repositories[i];
            if b.head != c.head || b.branch != c.branch {
                return Err(failure("Cannot recover after HEAD or branch changed"));
            }
            let output_repo = &mut target.repositories[i];
            for (b, a, c, output) in [
                (&b.working, &a.working, &c.working, &mut output_repo.working),
                (&b.index, &a.index, &c.index, &mut output_repo.index),
            ] {
                for name in b.keys().chain(a.keys()).collect::<BTreeSet<_>>() {
                    if b.get(name) == a.get(name) {
                        continue;
                    }
                    if c.get(name) != b.get(name) && c.get(name) != a.get(name) {
                        return Err(failure(format!(
                            "Recovery conflicts with a later edit: {name}"
                        )));
                    }
                    match b.get(name) {
                        Some(e) => {
                            output.insert(name.clone(), e.clone());
                        }
                        None => {
                            output.remove(name);
                        }
                    }
                }
            }
        }
        db.transactions[position].recovery_before = Some(store.save_snapshot(&current)?);
        db.transactions[position].recovery_expected = Some(store.save_snapshot(&target)?);
    } else if store.save_snapshot(&current)? != tx.prepared.current {
        return Err(failure("Preview is stale; preview the changes again"));
    }
    // Reserve every index before any file is changed.
    let mut reservations = Vec::new();
    for path in &paths {
        reservations.push(index_lock(Path::new(path), token).await?);
    }
    if capture(store, &paths, token).await? != current {
        return Err(failure("Files changed while acquiring restore locks"));
    }
    db.transactions[position].report.status = "pending".into();
    db.transactions[position].report.completed = 0;
    store.save(db)?;
    let result = apply_files(store, db, position, &current, &target, &reservations, token).await;
    match result {
        Ok(()) => {
            db.transactions[position].report.status =
                if recovering { "recovered" } else { "succeeded" }.into();
            db.transactions[position].report.error = None;
            if recovering {
                if let Some(task) = db
                    .tasks
                    .iter_mut()
                    .find(|t| t.id == tx.prepared.preview.task_id)
                {
                    // Restore checkpoint bookkeeping together with the files.
                    if tx.report.status == "succeeded" {
                        task.last_applied = tx.prepared.task_before.last_applied.clone();
                        for point in &mut task.checkpoints {
                            if point.id == tx.report.id {
                                point.status = "undone".into();
                            }
                        }
                    } else {
                        *task = tx.prepared.task_before.clone();
                    }
                }
            }
            if !recovering {
                let task = db
                    .tasks
                    .iter_mut()
                    .find(|t| t.id == tx.prepared.preview.task_id)
                    .ok_or_else(|| failure("Task not found"))?;
                if tx.prepared.preview.bring_back {
                    task.last_applied = tx.prepared.source_task_fingerprint.clone();
                    task.checkpoints.push(Checkpoint {
                        id: tx.report.id.clone(),
                        name: "Bring back result".into(),
                        created_at: chrono::Utc::now().to_rfc3339(),
                        status: "applied".into(),
                        session_id: None,
                        turn_id: None,
                        before: tx.prepared.current.clone(),
                        after: Some(tx.prepared.desired.clone()),
                        error: None,
                        summary: None,
                        prompt_hash: None,
                    });
                } else {
                    for point in &mut task.checkpoints {
                        if tx.prepared.checkpoint_ids.contains(&point.id) {
                            point.status = if tx.prepared.preview.redo_of.is_some() {
                                "completed"
                            } else {
                                "undone"
                            }
                            .into();
                        }
                    }
                }
            }
        }
        Err(error) => {
            db.transactions[position].report.status = "failed".into();
            db.transactions[position].report.error = Some(error.message);
        }
    }
    store.save(db)?;
    Ok(report(&db.transactions[position]))
}
async fn apply_files(
    store: &Storage,
    db: &mut Database,
    pos: usize,
    current: &Snapshot,
    target: &Snapshot,
    reservations: &[IndexLock],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    for (i, (from, to)) in current
        .repositories
        .iter()
        .zip(&target.repositories)
        .enumerate()
    {
        let root = Path::new(&from.path);
        for name in from
            .working
            .keys()
            .chain(to.working.keys())
            .collect::<BTreeSet<_>>()
        {
            if from.working.get(name) == to.working.get(name) {
                continue;
            }
            if token.is_cancelled() {
                return Err(failure("Restore cancelled; recovery is available"));
            }
            if read_entry(store, root, name)?.as_ref() != from.working.get(name) {
                return Err(failure(format!("File changed during restore: {name}")));
            }
            write_entry(store, root, name, to.working.get(name))?;
            db.transactions[pos].report.completed += 1;
            store.save(db)?;
            crate::state::emit_current_operation_progress(
                crate::models::OperationStatus::Running,
                "checkpointRestore",
                "Restoring task files",
                Some(db.transactions[pos].report.completed),
                Some(db.transactions[pos].report.total),
            );
            #[cfg(test)]
            if store.root.join("test-fail-after-write").is_file() {
                return Err(failure("Injected filesystem write failure"));
            }
        }
        let check = capture(store, std::slice::from_ref(&from.path), token).await?;
        if check.repositories[0].index != from.index
            || check.repositories[0].head != from.head
            || check.repositories[0].branch != from.branch
        {
            return Err(failure("Git index or HEAD changed during restore"));
        }
        write_index(store, root, &from.index, &to.index, &reservations[i], token).await?;
        db.transactions[pos].report.completed += from
            .index
            .keys()
            .chain(to.index.keys())
            .collect::<BTreeSet<_>>()
            .iter()
            .filter(|name| from.index.get(**name) != to.index.get(**name))
            .count() as u32;
        store.save(db)?;
    }
    if capture(
        store,
        &current
            .repositories
            .iter()
            .map(|r| r.path.clone())
            .collect::<Vec<_>>(),
        token,
    )
    .await?
        != *target
    {
        return Err(failure(
            "Files changed before restore verification completed",
        ));
    }
    Ok(())
}
