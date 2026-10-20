//! Global navigation only. Every operation still uses a concrete owning workspace.
use super::*;

pub(super) async fn prepare(
    state: &AppState,
    workspace_id: Option<&str>,
    paths: Vec<String>,
    token: &CancellationToken,
) -> Result<serde_json::Value, DesktopError> {
    let workspace = match workspace_id {
        Some(id) if paths.is_empty() => resolve_workspace(state, id).await?,
        None if !paths.is_empty() => crate::workspace::descriptor(paths)?,
        _ => return Err(failure("Choose one checkpoint project")),
    };
    let settings = state.app.read().await.settings.clone();
    let repositories = crate::workspace::scan(&workspace, &settings)?;
    if token.is_cancelled() {
        return Err(DesktopError::new(
            "REQUEST_CANCELLED",
            "Operation cancelled",
            true,
        ));
    }
    let _writer =
        crate::update_worker::repository_lock(&state.config_dir, "checkpoint-storage-v1", token)
            .await?;
    let store = Storage::new(&state.config_dir)?;
    let mut db = store.read()?;
    let tasks = activity(&db, &workspace).tasks;
    // Register only checkpoint ownership. Do not open a workspace or change app tabs/recents.
    db.projects.insert(workspace.id.clone(), workspace.clone());
    store.save(&db)?;
    value(CheckpointProject {
        workspace,
        repositories,
        tasks,
    })
}

fn project(db: &Database, recent: &[WorkspaceDescriptor], id: &str) -> Option<WorkspaceDescriptor> {
    recent
        .iter()
        .find(|workspace| workspace.id == id)
        .cloned()
        .or_else(|| db.projects.get(id).cloned())
        .or_else(|| {
            let task = db.tasks.iter().find(|task| task.workspace_id == id)?;
            let roots = if task.isolation == TaskIsolation::Original {
                task.roots.clone()
            } else if task.repositories.is_empty() {
                // Incomplete legacy creation must remain visible and removable.
                Vec::new()
            } else {
                // Legacy isolated tasks did not store the original project descriptor.
                // Derive a display location from their source repositories, never task worktrees.
                let mut root = Path::new(&task.repositories.first()?.source_path)
                    .parent()?
                    .to_path_buf();
                for repo in &task.repositories {
                    while !Path::new(&repo.source_path).starts_with(&root) {
                        if !root.pop() {
                            return None;
                        }
                    }
                }
                vec![root.to_string_lossy().into_owned()]
            };
            Some(WorkspaceDescriptor {
                id: id.into(),
                name: roots
                    .first()
                    .and_then(|root| Path::new(root).file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| id.to_owned()),
                paths: roots,
                last_opened_at: task.created_at.clone(),
                available: true,
                custom_name: None,
                workspace_file: None,
            })
        })
}

pub(super) async fn resolve_workspace(
    state: &AppState,
    id: &str,
) -> Result<WorkspaceDescriptor, DesktopError> {
    if let Ok(workspace) = state.workspace(id).await {
        return Ok(workspace);
    }
    let store = Storage::new(&state.config_dir)?;
    let db = store.read_cached()?;
    project(&db, &[], id).ok_or_else(|| failure("The workspace is no longer available"))
}

pub(super) async fn read(
    state: &AppState,
    token: &CancellationToken,
) -> Result<serde_json::Value, DesktopError> {
    let _reader =
        crate::update_worker::repository_read_lock(&state.config_dir, reads::OBJECT_LOCK, token)
            .await?;
    let store = Storage::new(&state.config_dir)?;
    let db = store.read_cached()?;
    let recent = state.app.read().await.recent_workspaces.clone();
    let ids = db
        .tasks
        .iter()
        .map(|task| task.workspace_id.clone())
        .collect::<BTreeSet<_>>();
    let projects = ids
        .iter()
        .filter_map(|id| project(&db, &recent, id))
        .collect();
    let tasks = db
        .tasks
        .iter()
        .map(|task| {
            let mut task = task.clone();
            let latest = task.checkpoints.last().map(|point| point.id.clone());
            task.checkpoints.retain(|point| {
                Some(&point.id) == latest.as_ref()
                    || matches!(
                        point.status.as_str(),
                        "recording" | "interrupted" | "incomplete"
                    )
            });
            for point in &mut task.checkpoints {
                prompt::display_name(&store, &db, point);
            }
            task
        })
        .collect();
    value(CheckpointCatalog { projects, tasks })
}
