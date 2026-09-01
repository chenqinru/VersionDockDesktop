use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use crate::{
    models::{ChangelistEntry, ChangelistOperation, DesktopError, RepositoryMeta},
    state::safe_relative,
};

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
struct WorkspaceChangelistIndex {
    #[serde(default)]
    active_id: Option<String>,
    #[serde(default)]
    changelists: Vec<StoredChangelist>,
    #[serde(default)]
    migrated_repo_ids: Vec<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct StoredChangelist {
    id: String,
    name: String,
    #[serde(default)]
    file_assignments: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
struct LegacyChangelistIndex {
    #[serde(default)]
    active_id: Option<String>,
    #[serde(default)]
    changelists: Vec<ChangelistEntry>,
}

static STORAGE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn storage_lock() -> &'static tokio::sync::Mutex<()> {
    STORAGE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub async fn list(
    config_dir: &Path,
    workspace_id: &str,
    repo: &RepositoryMeta,
) -> Result<Vec<ChangelistEntry>, DesktopError> {
    let _guard = storage_lock().lock().await;
    let mut index = read_index(config_dir, workspace_id).await?;
    if migrate_legacy_repo(config_dir, repo, &mut index).await? {
        write_index(config_dir, workspace_id, &index).await?;
    }
    let active_id = index.active_id.as_deref();
    Ok(index
        .changelists
        .into_iter()
        .map(|entry| ChangelistEntry {
            is_active: active_id == Some(entry.id.as_str()),
            files: entry
                .file_assignments
                .get(&repo.id)
                .cloned()
                .unwrap_or_default(),
            id: entry.id,
            name: entry.name,
            is_default: false,
        })
        .collect())
}

pub async fn operate(
    config_dir: &Path,
    workspace_id: &str,
    repo: &RepositoryMeta,
    operation: ChangelistOperation,
) -> Result<(), DesktopError> {
    let _guard = storage_lock().lock().await;
    let mut index = read_index(config_dir, workspace_id).await?;
    migrate_legacy_repo(config_dir, repo, &mut index).await?;
    match operation {
        ChangelistOperation::Create { name } => index.changelists.push(StoredChangelist {
            id: format!("cl-{}", uuid::Uuid::new_v4().simple()),
            name: valid_name(&name)?,
            file_assignments: BTreeMap::new(),
        }),
        ChangelistOperation::Rename {
            changelist_id,
            name,
        } => {
            validate_id(&changelist_id)?;
            index
                .changelists
                .iter_mut()
                .find(|entry| entry.id == changelist_id)
                .ok_or_else(not_found)?
                .name = valid_name(&name)?;
        }
        ChangelistOperation::Delete { changelist_id } => {
            validate_id(&changelist_id)?;
            let before = index.changelists.len();
            index.changelists.retain(|entry| entry.id != changelist_id);
            if index.changelists.len() == before {
                return Err(not_found());
            }
            if index.active_id.as_deref() == Some(&changelist_id) {
                index.active_id = None;
            }
        }
        ChangelistOperation::Assign {
            changelist_id,
            paths,
        } => {
            for path in &paths {
                safe_relative(Path::new(&repo.root_path), path, true)?;
            }
            for entry in &mut index.changelists {
                if let Some(files) = entry.file_assignments.get_mut(&repo.id) {
                    files.retain(|path| !paths.contains(path));
                    if files.is_empty() {
                        entry.file_assignments.remove(&repo.id);
                    }
                }
            }
            if let Some(id) = changelist_id {
                validate_id(&id)?;
                let entry = index
                    .changelists
                    .iter_mut()
                    .find(|entry| entry.id == id)
                    .ok_or_else(not_found)?;
                let files = entry.file_assignments.entry(repo.id.clone()).or_default();
                for path in paths {
                    if !files.contains(&path) {
                        files.push(path);
                    }
                }
                files.sort();
            }
        }
        ChangelistOperation::SetActive { changelist_id } => {
            if changelist_id == "default"
                || changelist_id == "unassigned"
                || changelist_id.is_empty()
            {
                index.active_id = None;
            } else {
                validate_id(&changelist_id)?;
                if !index
                    .changelists
                    .iter()
                    .any(|entry| entry.id == changelist_id)
                {
                    return Err(not_found());
                }
                index.active_id = Some(changelist_id);
            }
        }
    }
    write_index(config_dir, workspace_id, &index).await
}

async fn migrate_legacy_repo(
    config_dir: &Path,
    repo: &RepositoryMeta,
    index: &mut WorkspaceChangelistIndex,
) -> Result<bool, DesktopError> {
    if index.migrated_repo_ids.contains(&repo.id) {
        return Ok(false);
    }
    let legacy = match tokio::fs::read(legacy_index_path(config_dir, repo)).await {
        Ok(bytes) => serde_json::from_slice::<LegacyChangelistIndex>(&bytes).map_err(|error| {
            DesktopError::new("CHANGELIST_INDEX_INVALID", error.to_string(), true)
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            LegacyChangelistIndex::default()
        }
        Err(error) => return Err(storage_error(error)),
    };
    let legacy_active_id = legacy.active_id;
    let mut name_occurrences = BTreeMap::<String, usize>::new();
    for legacy_entry in legacy.changelists {
        let was_active = legacy_active_id.as_deref() == Some(legacy_entry.id.as_str());
        let occurrence = name_occurrences
            .entry(legacy_entry.name.clone())
            .or_default();
        let target_index = index
            .changelists
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.name == legacy_entry.name)
            .nth(*occurrence)
            .map(|(position, _)| position)
            .unwrap_or_else(|| {
                index.changelists.push(StoredChangelist {
                    id: if validate_id(&legacy_entry.id).is_ok() {
                        legacy_entry.id.clone()
                    } else {
                        format!("cl-{}", uuid::Uuid::new_v4().simple())
                    },
                    name: legacy_entry.name.clone(),
                    file_assignments: BTreeMap::new(),
                });
                index.changelists.len() - 1
            });
        *occurrence += 1;
        let files = index.changelists[target_index]
            .file_assignments
            .entry(repo.id.clone())
            .or_default();
        files.extend(legacy_entry.files);
        files.sort();
        files.dedup();
        if was_active && index.active_id.is_none() {
            index.active_id = Some(index.changelists[target_index].id.clone());
        }
    }
    index.migrated_repo_ids.push(repo.id.clone());
    index.migrated_repo_ids.sort();
    index.migrated_repo_ids.dedup();
    Ok(true)
}

async fn read_index(
    config_dir: &Path,
    workspace_id: &str,
) -> Result<WorkspaceChangelistIndex, DesktopError> {
    match tokio::fs::read(index_path(config_dir, workspace_id)?).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            DesktopError::new("CHANGELIST_INDEX_INVALID", error.to_string(), true)
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(WorkspaceChangelistIndex::default())
        }
        Err(error) => Err(storage_error(error)),
    }
}

async fn write_index(
    config_dir: &Path,
    workspace_id: &str,
    index: &WorkspaceChangelistIndex,
) -> Result<(), DesktopError> {
    let target = index_path(config_dir, workspace_id)?;
    let parent = target.parent().expect("changelist parent");
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(storage_error)?;
    let temporary = parent.join(format!("index-{}.json.tmp", uuid::Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(index)
        .map_err(|error| DesktopError::new("CHANGELIST_INDEX_INVALID", error.to_string(), true))?;
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(storage_error)?;
    tokio::fs::rename(temporary, target)
        .await
        .map_err(storage_error)
}

fn index_path(config_dir: &Path, workspace_id: &str) -> Result<PathBuf, DesktopError> {
    if !workspace_id.starts_with("ws-")
        || !workspace_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(DesktopError::new(
            "INVALID_WORKSPACE_ID",
            "Workspace identifier is invalid",
            false,
        ));
    }
    Ok(config_dir
        .join("changelists")
        .join("workspaces")
        .join(workspace_id)
        .join("index.json"))
}

fn legacy_index_path(config_dir: &Path, repo: &RepositoryMeta) -> PathBuf {
    config_dir
        .join("changelists")
        .join(&repo.id)
        .join("index.json")
}

fn valid_name(value: &str) -> Result<String, DesktopError> {
    let name = value.trim();
    if name.is_empty() || name.len() > 120 || name.contains('\0') {
        Err(DesktopError::new(
            "INVALID_CHANGELIST_NAME",
            "Changelist name is invalid",
            true,
        ))
    } else {
        Ok(name.into())
    }
}

fn validate_id(value: &str) -> Result<(), DesktopError> {
    if value.strip_prefix("cl-").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        Ok(())
    } else {
        Err(DesktopError::new(
            "INVALID_CHANGELIST_ID",
            "Changelist id is invalid",
            false,
        ))
    }
}

fn not_found() -> DesktopError {
    DesktopError::new("CHANGELIST_NOT_FOUND", "Changelist not found", true)
}

fn storage_error(error: std::io::Error) -> DesktopError {
    DesktopError::new("CHANGELIST_STORAGE_FAILED", error.to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::VcsKind;

    fn repo(root: &Path, id: &str, kind: VcsKind) -> RepositoryMeta {
        RepositoryMeta {
            id: id.into(),
            name: id.into(),
            root_path: root.to_string_lossy().into_owned(),
            color: "#fff".into(),
            kind,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        }
    }

    #[tokio::test]
    async fn shares_one_changelist_across_git_and_svn_repositories() {
        let storage = tempfile::tempdir().unwrap();
        let git_root = tempfile::tempdir().unwrap();
        let svn_root = tempfile::tempdir().unwrap();
        std::fs::write(git_root.path().join("git.txt"), "x").unwrap();
        std::fs::write(svn_root.path().join("svn.txt"), "x").unwrap();
        let git_repo = repo(git_root.path(), "git", VcsKind::Git);
        let svn_repo = repo(svn_root.path(), "svn", VcsKind::Svn);
        operate(
            storage.path(),
            "ws-0123456789abcdef",
            &git_repo,
            ChangelistOperation::Create {
                name: "Work".into(),
            },
        )
        .await
        .unwrap();
        let id = list(storage.path(), "ws-0123456789abcdef", &git_repo)
            .await
            .unwrap()[0]
            .id
            .clone();
        operate(
            storage.path(),
            "ws-0123456789abcdef",
            &git_repo,
            ChangelistOperation::Assign {
                changelist_id: Some(id.clone()),
                paths: vec!["git.txt".into()],
            },
        )
        .await
        .unwrap();
        operate(
            storage.path(),
            "ws-0123456789abcdef",
            &svn_repo,
            ChangelistOperation::Assign {
                changelist_id: Some(id.clone()),
                paths: vec!["svn.txt".into()],
            },
        )
        .await
        .unwrap();
        let git_list = list(storage.path(), "ws-0123456789abcdef", &git_repo)
            .await
            .unwrap();
        let svn_list = list(storage.path(), "ws-0123456789abcdef", &svn_repo)
            .await
            .unwrap();
        assert_eq!(git_list[0].id, id);
        assert_eq!(svn_list[0].id, id);
        assert_eq!(git_list[0].files, ["git.txt"]);
        assert_eq!(svn_list[0].files, ["svn.txt"]);
        assert!(operate(
            storage.path(),
            "ws-0123456789abcdef",
            &git_repo,
            ChangelistOperation::Assign {
                changelist_id: None,
                paths: vec!["../escape".into()],
            },
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn migrates_per_repository_indexes_into_one_workspace_list() {
        let storage = tempfile::tempdir().unwrap();
        let first_root = tempfile::tempdir().unwrap();
        let second_root = tempfile::tempdir().unwrap();
        std::fs::write(first_root.path().join("first.txt"), "x").unwrap();
        std::fs::write(second_root.path().join("second.txt"), "x").unwrap();
        let first = repo(first_root.path(), "first", VcsKind::Git);
        let second = repo(second_root.path(), "second", VcsKind::Svn);
        for (repository, id, file) in [
            (&first, "cl-00000000000000000000000000000001", "first.txt"),
            (&second, "cl-00000000000000000000000000000002", "second.txt"),
        ] {
            let target = legacy_index_path(storage.path(), repository);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(
                target,
                serde_json::to_vec(&LegacyChangelistIndex {
                    active_id: None,
                    changelists: vec![ChangelistEntry {
                        id: id.into(),
                        name: "Shared".into(),
                        files: vec![file.into()],
                        is_default: false,
                        is_active: false,
                    }],
                })
                .unwrap(),
            )
            .unwrap();
        }
        let first_list = list(storage.path(), "ws-0123456789abcdef", &first)
            .await
            .unwrap();
        let second_list = list(storage.path(), "ws-0123456789abcdef", &second)
            .await
            .unwrap();
        assert_eq!(first_list.len(), 1);
        assert_eq!(second_list.len(), 1);
        assert_eq!(first_list[0].id, second_list[0].id);
        assert_eq!(first_list[0].files, ["first.txt"]);
        assert_eq!(second_list[0].files, ["second.txt"]);
    }
}
