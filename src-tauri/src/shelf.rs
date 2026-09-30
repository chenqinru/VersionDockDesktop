use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};
use tokio_util::sync::CancellationToken;

use crate::{
    cli,
    models::{
        DesktopError, DiffDocument, RepositoryMeta, ShelfEntry, ShelfFileEntry, ShelfOperation,
        VcsKind,
    },
    state::safe_relative,
};

#[derive(Debug, serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct ShelfIndex {
    shelves: Vec<ShelfEntryInternal>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShelfEntryInternal {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(alias = "date", default)]
    created_at: String,
    #[serde(default)]
    branch: Option<String>,
    #[serde(alias = "patchFile", default)]
    patch_file: Option<String>,
    #[serde(default)]
    files: Vec<ShelfFileItem>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(untagged)]
enum ShelfFileItem {
    Detailed(ShelfFileEntry),
    Simple(String),
}

impl From<ShelfEntryInternal> for ShelfEntry {
    fn from(internal: ShelfEntryInternal) -> Self {
        let files = internal
            .files
            .into_iter()
            .map(|item| match item {
                ShelfFileItem::Detailed(entry) => entry,
                ShelfFileItem::Simple(path) => ShelfFileEntry {
                    path,
                    status: "modified".to_string(),
                },
            })
            .collect();
        ShelfEntry {
            id: internal.id,
            name: internal.name,
            created_at: internal.created_at,
            branch: internal.branch,
            files,
        }
    }
}

impl From<ShelfEntry> for ShelfEntryInternal {
    fn from(entry: ShelfEntry) -> Self {
        ShelfEntryInternal {
            id: entry.id,
            name: entry.name,
            created_at: entry.created_at,
            branch: entry.branch,
            patch_file: None,
            files: entry
                .files
                .into_iter()
                .map(ShelfFileItem::Detailed)
                .collect(),
        }
    }
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
        .retain(|entry| get_patch_path(&directory, entry).is_file());
    Ok(index.shelves.into_iter().map(Into::into).collect())
}

pub async fn operate(
    config_dir: &Path,
    repo: &RepositoryMeta,
    operation: ShelfOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    match operation {
        ShelfOperation::Create { name, paths } => create(config_dir, repo, &name, &paths, token)
            .await
            .map(|_| ()),
        ShelfOperation::Apply { shelf_id, paths } => {
            apply(config_dir, repo, &shelf_id, paths.as_deref(), false, token).await
        }
        ShelfOperation::Drop { shelf_id } => drop_shelf(config_dir, repo, &shelf_id).await,
    }
}

pub async fn file_diff(
    config_dir: &Path,
    repo: &RepositoryMeta,
    shelf_id: &str,
    relative_path: &str,
) -> Result<DiffDocument, DesktopError> {
    ensure_git(repo)?;
    validate_id(shelf_id)?;
    safe_relative(Path::new(&repo.root_path), relative_path, false)?;
    let index = read_index(config_dir, repo).await?;
    let entry = index
        .shelves
        .iter()
        .find(|entry| entry.id == shelf_id)
        .ok_or_else(|| DesktopError::new("SHELF_NOT_FOUND", "Shelf not found", true))?;
    if !entry.files.iter().any(|item| match item {
        ShelfFileItem::Detailed(file) => file.path == relative_path,
        ShelfFileItem::Simple(path) => path == relative_path,
    }) {
        return Err(DesktopError::new(
            "SHELF_FILE_NOT_FOUND",
            "Shelf file not found",
            true,
        ));
    }
    let bytes = tokio::fs::read(get_patch_path(&shelf_dir(config_dir, repo), entry))
        .await
        .map_err(storage_error)?;
    let patch = String::from_utf8_lossy(&bytes);
    let header_a = format!("diff --git a/{relative_path} b/{relative_path}");
    let header_b = format!("diff --git \"a/{relative_path}\" \"b/{relative_path}\"");
    let start = patch
        .find(&header_a)
        .or_else(|| patch.find(&header_b))
        .ok_or_else(|| {
            DesktopError::new("SHELF_DIFF_NOT_FOUND", "Shelf diff section not found", true)
        })?;
    let remainder = &patch[start..];
    let end = remainder[1..]
        .find("\ndiff --git ")
        .map(|index| index + 1)
        .unwrap_or(remainder.len());
    let content = remainder[..end].to_string();
    let line_count = content.lines().count();
    let truncated = content.len() > 5 * 1024 * 1024 || line_count > 50_000;
    Ok(DiffDocument {
        path: relative_path.into(),
        content: if truncated { String::new() } else { content },
        language: crate::vcs::language_for(relative_path),
        binary: remainder[..end].contains("GIT binary patch")
            || remainder[..end].contains("Binary files"),
        truncated,
        line_count: line_count.min(u32::MAX as usize) as u32,
    })
}

pub(crate) async fn create(
    config_dir: &Path,
    repo: &RepositoryMeta,
    name: &str,
    paths: &[String],
    token: &CancellationToken,
) -> Result<String, DesktopError> {
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
            .filter(|file| paths.iter().any(|selected| selected == &file.path))
            .collect()
    };
    if files.is_empty() {
        return Err(DesktopError::new(
            "SHELF_EMPTY",
            "No changes to shelve",
            true,
        ));
    }

    let branch = match git(
        repo,
        vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
        token,
    )
    .await
    {
        Ok(output) => {
            let b = output.stdout_text().trim().to_string();
            if b.is_empty() || b == "HEAD" {
                None
            } else {
                Some(b)
            }
        }
        Err(_) => None,
    };

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
                branch,
                files,
            }
            .into(),
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
    drop_captured(repo, &hash, stash_ref, token).await?;
    Ok(id)
}

pub(crate) async fn restore_after_update(
    config_dir: &Path,
    repo: &RepositoryMeta,
    shelf_id: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    apply(config_dir, repo, shelf_id, None, true, token).await
}

async fn apply(
    config_dir: &Path,
    repo: &RepositoryMeta,
    shelf_id: &str,
    paths: Option<&[String]>,
    three_way: bool,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    validate_id(shelf_id)?;
    let index = read_index(config_dir, repo).await?;
    let entry = index
        .shelves
        .iter()
        .find(|entry| entry.id == shelf_id)
        .ok_or_else(|| DesktopError::new("SHELF_NOT_FOUND", "Shelf not found", true))?;
    let directory = shelf_dir(config_dir, repo);
    let patch = get_patch_path(&directory, entry);
    if !patch.is_file() {
        return Err(DesktopError::new(
            "SHELF_PATCH_NOT_FOUND",
            "Shelf patch file not found",
            true,
        ));
    }
    let mut args = vec![
        "apply".into(),
        "--binary".into(),
        "--whitespace=nowarn".into(),
    ];
    if three_way {
        args.push("--3way".into());
    }
    if let Some(paths) = paths {
        let root = Path::new(&repo.root_path);
        for path in paths {
            safe_relative(root, path, true)?;
            args.push(format!("--include={path}"));
        }
    }
    args.push(patch.to_string_lossy().into_owned());
    git(repo, args, token).await?;
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
    let entry_to_remove = index.shelves.iter().find(|e| e.id == shelf_id).cloned();
    index.shelves.retain(|entry| entry.id != shelf_id);
    if index.shelves.len() == before {
        return Err(DesktopError::new(
            "SHELF_NOT_FOUND",
            "Shelf not found",
            true,
        ));
    }
    write_index(config_dir, repo, &index).await?;
    let directory = shelf_dir(config_dir, repo);
    if let Some(entry) = entry_to_remove {
        let patch = get_patch_path(&directory, &entry);
        let _ = tokio::fs::remove_file(patch).await;
    }
    let _ = tokio::fs::remove_file(directory.join(format!("{shelf_id}.patch"))).await;
    Ok(())
}

async fn changed_files(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<ShelfFileEntry>, DesktopError> {
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
        let code = &record[..2];
        let status = if code.contains('?') {
            "untracked"
        } else if code.contains('U') || code == "DD" || code == "AA" {
            "conflicted"
        } else if code.contains('A') {
            "added"
        } else if code.contains('D') {
            "deleted"
        } else if code.contains('R') {
            "renamed"
        } else {
            "modified"
        };
        let path = record[3..].to_string();
        files.push(ShelfFileEntry {
            path,
            status: status.to_string(),
        });
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
    let local_dir = shelf_dir(config_dir, repo);
    let local_index_path = local_dir.join("index.json");
    let local_shelves_path = local_dir.join("shelves.json");

    if local_index_path.is_file() {
        if let Ok(bytes) = tokio::fs::read(&local_index_path).await {
            if let Ok(index) = serde_json::from_slice::<ShelfIndex>(&bytes) {
                if !index.shelves.is_empty() {
                    return Ok(index);
                }
            }
        }
    } else if local_shelves_path.is_file() {
        if let Ok(bytes) = tokio::fs::read(&local_shelves_path).await {
            if let Ok(index) = serde_json::from_slice::<ShelfIndex>(&bytes) {
                if !index.shelves.is_empty() {
                    return Ok(index);
                }
            }
        }
    }

    // Check external IDE storage directories (VS Code / Cursor / Trae)
    for ext_dir in find_external_shelf_dirs(repo) {
        let ext_shelves_json = ext_dir.join("shelves.json");
        let ext_index_json = ext_dir.join("index.json");
        let candidate_file = if ext_shelves_json.is_file() {
            Some(ext_shelves_json)
        } else if ext_index_json.is_file() {
            Some(ext_index_json)
        } else {
            None
        };

        if let Some(meta_path) = candidate_file {
            if let Ok(bytes) = tokio::fs::read(&meta_path).await {
                if let Ok(mut ext_index) = serde_json::from_slice::<ShelfIndex>(&bytes) {
                    if !ext_index.shelves.is_empty() {
                        let _ = tokio::fs::create_dir_all(&local_dir).await;
                        for entry in &mut ext_index.shelves {
                            let src_patch = get_patch_path(&ext_dir, entry);
                            let dst_patch = local_dir.join(format!("{}.patch", entry.id));
                            if src_patch.is_file() && !dst_patch.is_file() {
                                let _ = tokio::fs::copy(&src_patch, &dst_patch).await;
                            }
                        }
                        let _ = write_index(config_dir, repo, &ext_index).await;
                        return Ok(ext_index);
                    }
                }
            }
        }
    }

    if local_index_path.is_file() {
        match tokio::fs::read(&local_index_path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| DesktopError::new("SHELF_INDEX_INVALID", error.to_string(), true)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ShelfIndex::default()),
            Err(error) => Err(storage_error(error)),
        }
    } else {
        Ok(ShelfIndex::default())
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

fn get_patch_path(directory: &Path, entry: &ShelfEntryInternal) -> PathBuf {
    if let Some(ref pf) = entry.patch_file {
        let p = directory.join(pf);
        if p.is_file() {
            return p;
        }
    }
    directory.join(format!("{}.patch", entry.id))
}

fn repo_hash(root_path: &str) -> String {
    let digest = Sha1::digest(root_path.as_bytes());
    hex::encode(&digest[..8])
}

fn find_external_shelf_dirs(repo: &RepositoryMeta) -> Vec<PathBuf> {
    let hash = repo_hash(&repo.root_path);
    let mut candidates = Vec::new();

    if let Ok(home) = std::env::var("HOME") {
        let home_path = PathBuf::from(home);
        candidates.push(
            home_path
                .join("Library/Application Support/Code/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
        candidates.push(
            home_path
                .join("Library/Application Support/Cursor/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
        candidates.push(
            home_path
                .join("Library/Application Support/Trae/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
        candidates.push(
            home_path
                .join("Library/Application Support/Code - Insiders/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
        candidates.push(
            home_path
                .join("Library/Application Support/VSCodium/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
        candidates.push(
            home_path
                .join(".config/Code/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
        candidates.push(
            home_path
                .join(".config/Cursor/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
        candidates.push(
            home_path
                .join(".config/Trae/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let appdata_path = PathBuf::from(appdata);
        candidates.push(
            appdata_path
                .join("Code/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
        candidates.push(
            appdata_path
                .join("Cursor/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
        candidates.push(
            appdata_path
                .join("Trae/User/globalStorage/chenqinru.versiondock/shelves")
                .join(&hash),
        );
    }

    candidates.push(
        PathBuf::from(
            "/Volumes/WorkSSD/VSCode/Code/User/globalStorage/chenqinru.versiondock/shelves",
        )
        .join(&hash),
    );

    candidates.retain(|dir| dir.is_dir());
    candidates
}

fn validate_id(value: &str) -> Result<(), DesktopError> {
    if value.starts_with("shelf-")
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains("..")
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
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
