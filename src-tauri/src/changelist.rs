use std::path::{Path, PathBuf};

use crate::{
    models::{ChangelistEntry, ChangelistOperation, DesktopError, RepositoryMeta},
    state::safe_relative,
};

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
struct ChangelistIndex {
    #[serde(default)]
    active_id: Option<String>,
    changelists: Vec<ChangelistEntry>,
}

pub async fn list(
    config_dir: &Path,
    repo: &RepositoryMeta,
) -> Result<Vec<ChangelistEntry>, DesktopError> {
    let index = read_index(config_dir, repo).await?;
    let active_id = index.active_id.as_deref();
    let mut changelists = index.changelists;
    for entry in &mut changelists {
        entry.is_active = active_id == Some(&entry.id);
    }
    Ok(changelists)
}

pub async fn operate(
    config_dir: &Path,
    repo: &RepositoryMeta,
    operation: ChangelistOperation,
) -> Result<(), DesktopError> {
    let mut index = read_index(config_dir, repo).await?;
    match operation {
        ChangelistOperation::Create { name } => index.changelists.push(ChangelistEntry {
            id: format!("cl-{}", uuid::Uuid::new_v4().simple()),
            name: valid_name(&name)?,
            files: vec![],
            is_default: false,
            is_active: false,
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
                entry.files.retain(|path| !paths.contains(path));
            }
            if let Some(id) = changelist_id {
                validate_id(&id)?;
                let entry = index
                    .changelists
                    .iter_mut()
                    .find(|entry| entry.id == id)
                    .ok_or_else(not_found)?;
                for path in paths {
                    if !entry.files.contains(&path) {
                        entry.files.push(path);
                    }
                }
                entry.files.sort();
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
    write_index(config_dir, repo, &index).await
}

async fn read_index(
    config_dir: &Path,
    repo: &RepositoryMeta,
) -> Result<ChangelistIndex, DesktopError> {
    match tokio::fs::read(index_path(config_dir, repo)).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            DesktopError::new("CHANGELIST_INDEX_INVALID", error.to_string(), true)
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(ChangelistIndex::default())
        }
        Err(error) => Err(storage_error(error)),
    }
}

async fn write_index(
    config_dir: &Path,
    repo: &RepositoryMeta,
    index: &ChangelistIndex,
) -> Result<(), DesktopError> {
    let target = index_path(config_dir, repo);
    let parent = target.parent().expect("changelist parent");
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(storage_error)?;
    let temporary = parent.join("index.json.tmp");
    let bytes = serde_json::to_vec_pretty(index)
        .map_err(|error| DesktopError::new("CHANGELIST_INDEX_INVALID", error.to_string(), true))?;
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(storage_error)?;
    tokio::fs::rename(temporary, target)
        .await
        .map_err(storage_error)
}

fn index_path(config_dir: &Path, repo: &RepositoryMeta) -> PathBuf {
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

    #[tokio::test]
    async fn persists_assignments_and_rejects_escaping_paths() {
        let storage = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("file.txt"), "x").unwrap();
        let repo = RepositoryMeta {
            id: "repo".into(),
            name: "repo".into(),
            root_path: root.path().to_string_lossy().into_owned(),
            color: "#fff".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        operate(
            storage.path(),
            &repo,
            ChangelistOperation::Create {
                name: "Work".into(),
            },
        )
        .await
        .unwrap();
        let id = list(storage.path(), &repo).await.unwrap()[0].id.clone();
        operate(
            storage.path(),
            &repo,
            ChangelistOperation::Assign {
                changelist_id: Some(id),
                paths: vec!["file.txt".into()],
            },
        )
        .await
        .unwrap();
        assert_eq!(
            list(storage.path(), &repo).await.unwrap()[0].files,
            ["file.txt"]
        );
        assert!(operate(
            storage.path(),
            &repo,
            ChangelistOperation::Assign {
                changelist_id: None,
                paths: vec!["../escape".into()]
            }
        )
        .await
        .is_err());
    }
}
