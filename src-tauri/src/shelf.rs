use std::path::{Path, PathBuf};

use tokio_util::sync::CancellationToken;

use crate::{
    cli,
    models::{DesktopError, RepositoryMeta, ShelfEntry, ShelfOperation, VcsKind},
    state::safe_relative,
};

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ShelfIndex {
    shelves: Vec<ShelfEntry>,
}

pub async fn list(
    config_dir: &Path,
    repo: &RepositoryMeta,
) -> Result<Vec<ShelfEntry>, DesktopError> {
    ensure_git(repo)?;
    let mut index = read_index(config_dir, repo).await?;
    let directory = shelf_dir(config_dir, repo);
    index
        .shelves
        .retain(|entry| directory.join(format!("{}.patch", entry.id)).is_file());
    Ok(index.shelves)
}

pub async fn operate(
    config_dir: &Path,
    repo: &RepositoryMeta,
    operation: ShelfOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    match operation {
        ShelfOperation::Create { name, paths } => {
            create(config_dir, repo, &name, &paths, token).await
        }
        ShelfOperation::Apply { shelf_id } => apply(config_dir, repo, &shelf_id, token).await,
        ShelfOperation::Drop { shelf_id } => drop_shelf(config_dir, repo, &shelf_id).await,
    }
}

async fn create(
    config_dir: &Path,
    repo: &RepositoryMeta,
    name: &str,
    paths: &[String],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let name = name.trim();
    if name.is_empty() || name.len() > 200 || name.contains('\0') {
        return Err(DesktopError::new(
            "INVALID_SHELF_NAME",
            "Shelf name is invalid",
            true,
        ));
    }
    let root = Path::new(&repo.root_path);
    let safe_paths = paths
        .iter()
        .map(|path| {
            safe_relative(root, path, true)?;
            Ok(format!(":(literal){path}"))
        })
        .collect::<Result<Vec<_>, DesktopError>>()?;
    let files = changed_files(repo, token).await?;
    let files = if paths.is_empty() {
        files
    } else {
        files
            .into_iter()
            .filter(|file| paths.iter().any(|selected| selected == file))
            .collect()
    };
    if files.is_empty() {
        return Err(DesktopError::new(
            "SHELF_EMPTY",
            "No changes to shelve",
            true,
        ));
    }

    let marker = format!("versiondock-shelf-{}", uuid::Uuid::new_v4());
    let mut stash_args = vec![
        "stash".into(),
        "push".into(),
        "--include-untracked".into(),
        "--message".into(),
        marker.clone(),
    ];
    if !safe_paths.is_empty() {
        stash_args.push("--".into());
        stash_args.extend(safe_paths);
    }
    git(repo, stash_args, token).await?;
    let stash_ref = "stash@{0}";
    let hash = match git(repo, vec!["rev-parse".into(), stash_ref.into()], token).await {
        Ok(output) => output.stdout_text().trim().to_string(),
        Err(error) => {
            let _ = restore_latest(repo, stash_ref, token).await;
            return Err(error);
        }
    };
    let identity = match git(
        repo,
        vec![
            "stash".into(),
            "list".into(),
            "-1".into(),
            "--format=%H%x1f%gs".into(),
        ],
        token,
    )
    .await
    {
        Ok(output) => output.stdout_text(),
        Err(error) => {
            restore_captured(repo, &hash, stash_ref, token).await?;
            return Err(error);
        }
    };
    let (listed_hash, subject) = identity.trim().split_once('\u{1f}').unwrap_or(("", ""));
    if listed_hash != hash || !subject.contains(&marker) {
        restore_captured(repo, &hash, stash_ref, token).await?;
        return Err(DesktopError::new(
            "SHELF_CAPTURE_FAILED",
            "Unable to identify the captured shelf",
            false,
        ));
    }
    let patch = match git(
        repo,
        vec![
            "stash".into(),
            "show".into(),
            "--patch".into(),
            "--binary".into(),
            "--include-untracked".into(),
            hash.clone(),
        ],
        token,
    )
    .await
    {
        Ok(output) => output.stdout,
        Err(error) => {
            restore_captured(repo, &hash, stash_ref, token).await?;
            return Err(error);
        }
    };
    if patch.is_empty() {
        restore_captured(repo, &hash, stash_ref, token).await?;
        return Err(DesktopError::new("SHELF_EMPTY", "Nothing to shelve", true));
    }

    let id = format!("shelf-{}", uuid::Uuid::new_v4().simple());
    let directory = shelf_dir(config_dir, repo);
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(storage_error)?;
    let patch_path = directory.join(format!("{id}.patch"));
    let temporary = directory.join(format!("{id}.patch.tmp"));
    if let Err(error) = async {
        tokio::fs::write(&temporary, &patch)
            .await
            .map_err(storage_error)?;
        tokio::fs::rename(&temporary, &patch_path)
            .await
            .map_err(storage_error)?;
        let mut index = read_index(config_dir, repo).await?;
        index.shelves.insert(
            0,
            ShelfEntry {
                id: id.clone(),
                name: name.to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
                files,
            },
        );
        write_index(config_dir, repo, &index).await
    }
    .await
    {
        let _ = tokio::fs::remove_file(&temporary).await;
        let _ = tokio::fs::remove_file(&patch_path).await;
        restore_captured(repo, &hash, stash_ref, token).await?;
        return Err(error);
    }
    drop_captured(repo, &hash, stash_ref, token).await
}

async fn apply(
    config_dir: &Path,
    repo: &RepositoryMeta,
    shelf_id: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    validate_id(shelf_id)?;
    let index = read_index(config_dir, repo).await?;
    if !index.shelves.iter().any(|entry| entry.id == shelf_id) {
        return Err(DesktopError::new(
            "SHELF_NOT_FOUND",
            "Shelf not found",
            true,
        ));
    }
    let patch = shelf_dir(config_dir, repo).join(format!("{shelf_id}.patch"));
    git(
        repo,
        vec![
            "apply".into(),
            "--binary".into(),
            "--whitespace=nowarn".into(),
            patch.to_string_lossy().into_owned(),
        ],
        token,
    )
    .await?;
    Ok(())
}

async fn drop_shelf(
    config_dir: &Path,
    repo: &RepositoryMeta,
    shelf_id: &str,
) -> Result<(), DesktopError> {
    validate_id(shelf_id)?;
    let mut index = read_index(config_dir, repo).await?;
    let before = index.shelves.len();
    index.shelves.retain(|entry| entry.id != shelf_id);
    if index.shelves.len() == before {
        return Err(DesktopError::new(
            "SHELF_NOT_FOUND",
            "Shelf not found",
            true,
        ));
    }
    write_index(config_dir, repo, &index).await?;
    tokio::fs::remove_file(shelf_dir(config_dir, repo).join(format!("{shelf_id}.patch")))
        .await
        .map_err(storage_error)
}

async fn changed_files(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<String>, DesktopError> {
    let raw = git(
        repo,
        vec![
            "status".into(),
            "--porcelain=v1".into(),
            "-z".into(),
            "--untracked-files=all".into(),
        ],
        token,
    )
    .await?
    .stdout_text();
    let mut fields = raw.split('\0').filter(|value| !value.is_empty());
    let mut files = Vec::new();
    while let Some(record) = fields.next() {
        if record.len() < 4 {
            continue;
        }
        files.push(record[3..].to_string());
        if record.as_bytes()[0] == b'R' || record.as_bytes()[0] == b'C' {
            let _ = fields.next();
        }
    }
    Ok(files)
}

async fn restore_captured(
    repo: &RepositoryMeta,
    hash: &str,
    reference: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    git(
        repo,
        vec![
            "stash".into(),
            "apply".into(),
            "--index".into(),
            hash.into(),
        ],
        token,
    )
    .await?;
    drop_captured(repo, hash, reference, token).await
}

async fn restore_latest(
    repo: &RepositoryMeta,
    reference: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    git(
        repo,
        vec![
            "stash".into(),
            "pop".into(),
            "--index".into(),
            reference.into(),
        ],
        token,
    )
    .await?;
    Ok(())
}

async fn drop_captured(
    repo: &RepositoryMeta,
    hash: &str,
    reference: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let current = git(repo, vec!["rev-parse".into(), reference.into()], token)
        .await?
        .stdout_text()
        .trim()
        .to_string();
    if current != hash {
        return Err(DesktopError::new(
            "SHELF_STASH_CHANGED",
            "The temporary stash changed before cleanup",
            false,
        ));
    }
    git(
        repo,
        vec!["stash".into(), "drop".into(), reference.into()],
        token,
    )
    .await?;
    Ok(())
}

async fn git(
    repo: &RepositoryMeta,
    args: Vec<String>,
    token: &CancellationToken,
) -> Result<cli::CommandOutput, DesktopError> {
    let mut safe = vec!["-c".into(), "core.quotepath=false".into()];
    safe.extend(args);
    cli::run(
        "git",
        &safe,
        Path::new(&repo.root_path),
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
}

async fn read_index(config_dir: &Path, repo: &RepositoryMeta) -> Result<ShelfIndex, DesktopError> {
    let path = shelf_dir(config_dir, repo).join("index.json");
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| DesktopError::new("SHELF_INDEX_INVALID", error.to_string(), true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ShelfIndex::default()),
        Err(error) => Err(storage_error(error)),
    }
}

async fn write_index(
    config_dir: &Path,
    repo: &RepositoryMeta,
    index: &ShelfIndex,
) -> Result<(), DesktopError> {
    let directory = shelf_dir(config_dir, repo);
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(storage_error)?;
    let target = directory.join("index.json");
    let temporary = directory.join("index.json.tmp");
    let bytes = serde_json::to_vec_pretty(index)
        .map_err(|error| DesktopError::new("SHELF_INDEX_INVALID", error.to_string(), true))?;
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(storage_error)?;
    tokio::fs::rename(temporary, target)
        .await
        .map_err(storage_error)
}

fn shelf_dir(config_dir: &Path, repo: &RepositoryMeta) -> PathBuf {
    config_dir.join("shelves").join(&repo.id)
}

fn validate_id(value: &str) -> Result<(), DesktopError> {
    if value.strip_prefix("shelf-").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        Ok(())
    } else {
        Err(DesktopError::new(
            "INVALID_SHELF_ID",
            "Shelf id is invalid",
            false,
        ))
    }
}

fn ensure_git(repo: &RepositoryMeta) -> Result<(), DesktopError> {
    if repo.kind == VcsKind::Git {
        Ok(())
    } else {
        Err(DesktopError::new(
            "UNSUPPORTED_OPERATION",
            "Shelf requires Git",
            false,
        ))
    }
}

fn storage_error(error: std::io::Error) -> DesktopError {
    DesktopError::new("SHELF_STORAGE_FAILED", error.to_string(), true)
}
