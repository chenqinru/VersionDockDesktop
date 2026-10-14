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
    #[serde(default)]
    migrated_sources: Vec<String>,
    #[serde(default)]
    deleted_ids: Vec<String>,
    #[serde(flatten)]
    extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShelfEntryInternal {
    id: String,
    #[serde(default)]
    changelist_assignments: Vec<crate::changelist::ShelfAssignment>,
    #[serde(default)]
    name: String,
    #[serde(rename = "date", alias = "createdAt", default)]
    created_at: String,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    patch_file: Option<String>,
    #[serde(default)]
    files: Vec<ShelfFileItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    binary_files: Vec<ShelfAttachment>,
    #[serde(flatten)]
    extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShelfAttachment {
    repo_rel_path: String,
    store_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<u32>,
    #[serde(default = "regular_file")]
    kind: String,
}

fn regular_file() -> String {
    "file".into()
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
            id: entry.id.clone(),
            changelist_assignments: Vec::new(),
            name: entry.name,
            created_at: entry.created_at,
            branch: entry.branch,
            patch_file: Some(format!("{}.patch", entry.id)),
            files: entry
                .files
                .into_iter()
                .map(ShelfFileItem::Detailed)
                .collect(),
            binary_files: Vec::new(),
            extra: Default::default(),
        }
    }
}

pub async fn list(
    config_dir: &Path,
    repo: &RepositoryMeta,
) -> Result<Vec<ShelfEntry>, DesktopError> {
    ensure_git(repo)?;
    let _guard = lock_storage(config_dir, repo).await?;
    let mut index = read_index(config_dir, repo).await?;
    let directory = shelf_dir(config_dir, repo).await?;
    index
        .shelves
        .retain(|entry| get_patch_path(&directory, entry).is_ok_and(|path| path.is_file()));
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
            apply(config_dir, repo, &shelf_id, paths.as_deref(), true, token).await
        }
        ShelfOperation::Drop { shelf_id } => drop_shelf(config_dir, repo, &shelf_id).await,
    }
}

pub async fn operate_in_workspace(
    config_dir: &Path,
    workspace_id: &str,
    repo: &RepositoryMeta,
    operation: ShelfOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    match operation {
        ShelfOperation::Create { name, paths } => {
            let assignments =
                crate::changelist::capture_assignments(config_dir, workspace_id, repo, &paths)
                    .await?;
            create_with_assignments(config_dir, repo, &name, &paths, assignments, token).await?;
            Ok(())
        }
        ShelfOperation::Apply { shelf_id, paths } => {
            let index = {
                let _guard = lock_storage(config_dir, repo).await?;
                read_index(config_dir, repo).await?
            };
            let entry = index
                .shelves
                .iter()
                .find(|entry| entry.id == shelf_id)
                .ok_or_else(|| DesktopError::new("SHELF_NOT_FOUND", "Shelf not found", true))?;
            let assignments = entry
                .changelist_assignments
                .iter()
                .filter(|assignment| {
                    paths
                        .as_ref()
                        .is_none_or(|paths| paths.is_empty() || paths.contains(&assignment.path))
                })
                .cloned()
                .collect::<Vec<_>>();
            apply(config_dir, repo, &shelf_id, paths.as_deref(), true, token).await?;
            crate::changelist::restore_assignments(config_dir, workspace_id, repo, &assignments)
                .await
        }
        operation => operate(config_dir, repo, operation, token).await,
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
    let _guard = lock_storage(config_dir, repo).await?;
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
    if entry
        .binary_files
        .iter()
        .any(|file| file.repo_rel_path == relative_path)
    {
        return crate::vcs::make_diff(
            relative_path,
            format!("Binary files /dev/null and b/{relative_path} differ\n").into_bytes(),
        );
    }
    let bytes = tokio::fs::read(get_patch_path(&shelf_dir(config_dir, repo).await?, entry)?)
        .await
        .map_err(storage_error)?;
    let patch = String::from_utf8_lossy(&bytes);
    let boundaries: Vec<_> = patch
        .match_indices("diff --git ")
        .filter(|(offset, _)| *offset == 0 || patch.as_bytes()[offset - 1] == b'\n')
        .map(|(offset, _)| offset)
        .collect();
    let content = boundaries
        .iter()
        .enumerate()
        .find_map(|(index, start)| {
            let section = &patch[*start..boundaries.get(index + 1).copied().unwrap_or(patch.len())];
            section_touches_path(section, relative_path).then(|| section.to_string())
        })
        .ok_or_else(|| {
            DesktopError::new("SHELF_DIFF_NOT_FOUND", "Shelf diff section not found", true)
        })?;
    crate::vcs::make_diff(relative_path, content.into_bytes())
}

fn quote_patch_path(path: &str) -> String {
    let mut result = String::from("\"");
    for byte in path.bytes() {
        match byte {
            b'\\' => result.push_str("\\\\"),
            b'"' => result.push_str("\\\""),
            b'\t' => result.push_str("\\t"),
            b'\n' => result.push_str("\\n"),
            b'\r' => result.push_str("\\r"),
            32..=126 => result.push(byte as char),
            byte => result.push_str(&format!("\\{byte:03o}")),
        }
    }
    result.push('"');
    result
}

pub(crate) async fn create(
    config_dir: &Path,
    repo: &RepositoryMeta,
    name: &str,
    paths: &[String],
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    create_with_assignments(config_dir, repo, name, paths, Vec::new(), token).await
}

async fn create_with_assignments(
    config_dir: &Path,
    repo: &RepositoryMeta,
    name: &str,
    paths: &[String],
    assignments: Vec<crate::changelist::ShelfAssignment>,
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
    ensure_git(repo)?;
    let _guard = lock_storage(config_dir, repo).await?;
    // Migrate before capturing the worktree so storage errors cannot strand a stash.
    read_index(config_dir, repo).await?;
    let root = Path::new(&repo.root_path);
    let safe_paths = paths
        .iter()
        .map(|path| {
            safe_relative(root, path, false)?;
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
    // Match the plugin's HEAD-to-worktree patch, not Git stash's index-based
    // handling of newly staged files subsequently deleted from the worktree.
    // Those files must stay absent when the shelf is restored.
    let mut diff_args = vec![
        "diff".into(),
        "HEAD".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--binary".into(),
        "--".into(),
    ];
    diff_args.extend(safe_paths.clone());
    let tracked_patch = git(repo, diff_args, token).await?.stdout;
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
    let untracked_patch = match git(
        repo,
        vec![
            "stash".into(),
            "show".into(),
            "--patch".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "--binary".into(),
            "--only-untracked".into(),
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
    let mut patch = tracked_patch;
    patch.extend(untracked_patch);
    if patch.is_empty() {
        restore_captured(repo, &hash, stash_ref, token).await?;
        return Err(DesktopError::new("SHELF_EMPTY", "Nothing to shelve", true));
    }

    let id = format!("shelf-{}", uuid::Uuid::new_v4().simple());
    let directory = shelf_dir(config_dir, repo).await?;
    let patch_path = directory.join(format!("{id}.patch"));
    let temporary = directory.join(format!("{id}.patch.tmp"));
    if let Err(error) = async {
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(storage_error)?;
        tokio::fs::write(&temporary, &patch)
            .await
            .map_err(storage_error)?;
        tokio::fs::rename(&temporary, &patch_path)
            .await
            .map_err(storage_error)?;
        let mut index = read_index(config_dir, repo).await?;
        let mut entry: ShelfEntryInternal = ShelfEntry {
            id: id.clone(),
            name: name.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            branch,
            files,
        }
        .into();
        entry.changelist_assignments = assignments;
        index.shelves.insert(0, entry);
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
    let _guard = lock_storage(config_dir, repo).await?;
    let index = read_index(config_dir, repo).await?;
    let entry = index
        .shelves
        .iter()
        .find(|entry| entry.id == shelf_id)
        .ok_or_else(|| DesktopError::new("SHELF_NOT_FOUND", "Shelf not found", true))?;
    let directory = shelf_dir(config_dir, repo).await?;
    let patch = get_patch_path(&directory, entry)?;
    if !patch.is_file() {
        return Err(DesktopError::new(
            "SHELF_PATCH_NOT_FOUND",
            "Shelf patch file not found",
            true,
        ));
    }
    let paths = paths.filter(|paths| !paths.is_empty());
    if let Some(paths) = paths {
        for path in paths {
            safe_relative(Path::new(&repo.root_path), path, false)?;
        }
    }
    let attachments = prepare_attachments(&directory, repo, entry, paths)?;
    let full_patch = tokio::fs::read(&patch).await.map_err(storage_error)?;
    // git apply --include interprets glob patterns. Extract sections instead so
    // filenames containing brackets, * or ? remain literal on both clients.
    let selected_patch = paths.map(|paths| select_patch(&full_patch, paths));
    let mut temporary = None;
    let apply_path = if let Some(ref bytes) = selected_patch {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(storage_error)?;
        file.write_all(bytes).map_err(storage_error)?;
        let path = file.path().to_path_buf();
        temporary = Some(file);
        path
    } else {
        patch
    };
    let has_patch = selected_patch
        .as_ref()
        .unwrap_or(&full_patch)
        .iter()
        .any(|byte| !byte.is_ascii_whitespace());
    let mut args = vec![
        "apply".into(),
        "--binary".into(),
        "--whitespace=nowarn".into(),
    ];
    if three_way {
        args.push("--3way".into());
    }
    args.push(apply_path.to_string_lossy().into_owned());
    if has_patch {
        if let Err(error) = git(repo, args.clone(), token).await {
            if !three_way || token.is_cancelled() {
                return Err(error);
            }
            let conflicts = git(
                repo,
                vec![
                    "diff".into(),
                    "--name-only".into(),
                    "--diff-filter=U".into(),
                    "-z".into(),
                ],
                token,
            )
            .await?;
            if !conflicts.stdout.is_empty() {
                return Err(error);
            }
            args.retain(|argument| argument != "--3way");
            git(repo, args, token).await?;
        }
    }
    restore_attachments(repo, attachments)?;
    drop(temporary);
    Ok(())
}

async fn drop_shelf(
    config_dir: &Path,
    repo: &RepositoryMeta,
    shelf_id: &str,
) -> Result<(), DesktopError> {
    validate_id(shelf_id)?;
    let _guard = lock_storage(config_dir, repo).await?;
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
    let directory = shelf_dir(config_dir, repo).await?;
    let mut files_to_remove = Vec::new();
    if let Some(entry) = entry_to_remove {
        files_to_remove.push(get_patch_path(&directory, &entry)?);
        for attachment in entry.binary_files {
            files_to_remove.push(safe_relative(&directory, &attachment.store_name, true)?);
        }
    }
    index.deleted_ids.push(shelf_id.to_string());
    write_index(config_dir, repo, &index).await?;
    for file in files_to_remove {
        // Missing content must not make an already committed deletion appear to fail.
        let _ = tokio::fs::remove_file(file).await;
    }
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

// Storage protocol shared with VersionDock: worktree Git dir/versiondock/shelves,
// shelves.json with plugin fields, atomic replacement and an atomic mkdir .lock.
struct ShelfStorageGuard {
    path: PathBuf,
    owned: std::fs::Metadata,
}

impl Drop for ShelfStorageGuard {
    fn drop(&mut self) {
        let Ok(current) = std::fs::symlink_metadata(&self.path) else {
            return;
        };
        #[cfg(unix)]
        let same = {
            use std::os::unix::fs::MetadataExt;
            current.dev() == self.owned.dev() && current.ino() == self.owned.ino()
        };
        #[cfg(not(unix))]
        let same = current
            .created()
            .ok()
            .zip(self.owned.created().ok())
            .is_some_and(|(current, owned)| current == owned);
        // Git removal can delete storage; never remove a new writer's replacement lock.
        if same && current.is_dir() {
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

pub(crate) async fn worktree_shelf_count(git_dir: &Path) -> Result<usize, DesktopError> {
    let directory = safe_relative(git_dir, "versiondock/shelves", true)?;
    if directory.join(".lock").exists() {
        return Err(DesktopError::new(
            "SHELF_STORAGE_BUSY",
            "Shelf storage is busy",
            true,
        ));
    }
    stored_shelf_count(&directory).await
}

async fn stored_shelf_count(directory: &Path) -> Result<usize, DesktopError> {
    let path = safe_relative(directory, "shelves.json", true)?;
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let value: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|e| DesktopError::new("SHELF_INDEX_INVALID", e.to_string(), true))?;
            value
                .get("shelves")
                .and_then(|v| v.as_array())
                .map(|v| v.len())
                .ok_or_else(|| {
                    DesktopError::new("SHELF_INDEX_INVALID", "Cannot read worktree shelves", true)
                })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(storage_error(e)),
    }
}

pub(crate) async fn guard_worktree_removal(git_dir: &Path) -> Result<impl Drop, DesktopError> {
    let directory = safe_relative(git_dir, "versiondock/shelves", true)?;
    let guard = lock_directory(&directory).await?;
    if stored_shelf_count(&directory).await? > 0 {
        return Err(DesktopError::new(
            "WORKTREE_SHELVES",
            "Restore or move worktree shelves before removing it",
            true,
        ));
    }
    Ok(guard)
}

async fn lock_storage(
    config_dir: &Path,
    repo: &RepositoryMeta,
) -> Result<ShelfStorageGuard, DesktopError> {
    let directory = shelf_dir(config_dir, repo).await?;
    lock_directory(&directory).await
}

async fn lock_directory(directory: &Path) -> Result<ShelfStorageGuard, DesktopError> {
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(storage_error)?;
    let lock = directory.join(".lock");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match tokio::fs::create_dir(&lock).await {
            Ok(()) => {
                let owned = std::fs::symlink_metadata(&lock).map_err(storage_error)?;
                return Ok(ShelfStorageGuard { path: lock, owned });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(DesktopError::new(
                        "SHELF_STORAGE_BUSY",
                        format!("Shelf storage is busy: {}", lock.display()),
                        true,
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(error) => return Err(storage_error(error)),
        }
    }
}

async fn load_index(path: &Path) -> Result<ShelfIndex, DesktopError> {
    if path.exists() {
        safe_relative(
            path.parent().unwrap(),
            path.file_name().unwrap().to_str().unwrap(),
            true,
        )?;
    }
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| DesktopError::new("SHELF_INDEX_INVALID", error.to_string(), true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ShelfIndex::default()),
        Err(error) => Err(storage_error(error)),
    }
}

async fn read_index(config_dir: &Path, repo: &RepositoryMeta) -> Result<ShelfIndex, DesktopError> {
    let directory = shelf_dir(config_dir, repo).await?;
    let mut index = load_index(&directory.join("shelves.json")).await?;
    let mut changed = false;
    // Prefer original plugin entries over incomplete copies made by older Desktop versions.
    let sources = find_external_shelf_dirs(repo)
        .into_iter()
        .chain(std::iter::once(config_dir.join("shelves").join(&repo.id)));
    for source in sources {
        let source_key = source.to_string_lossy().into_owned();
        if index.migrated_sources.contains(&source_key) {
            continue;
        }
        let meta = if source.join("index.json").is_file() {
            source.join("index.json")
        } else if source.join("shelves.json").is_file() {
            source.join("shelves.json")
        } else {
            continue;
        };
        let legacy = load_index(&meta).await?;
        for mut entry in legacy.shelves {
            validate_id(&entry.id)?;
            if index.deleted_ids.contains(&entry.id) {
                continue;
            }
            let existing = index.shelves.iter().position(|value| value.id == entry.id);
            if let Some(position) = existing {
                if !index.shelves[position].binary_files.is_empty() || entry.binary_files.is_empty()
                {
                    continue;
                }
            }
            let patch = get_patch_path(&source, &entry)?;
            if !patch.is_file() {
                return Err(DesktopError::new(
                    "SHELF_PATCH_NOT_FOUND",
                    format!("Shelf patch file not found: {}", patch.display()),
                    true,
                ));
            }
            for attachment in &mut entry.binary_files {
                attachment.store_name =
                    copy_legacy_file(&source, &directory, &entry.id, &attachment.store_name)
                        .await?;
            }
            if let Some(position) = existing {
                index.shelves[position].binary_files = entry.binary_files;
            } else {
                let name = patch
                    .strip_prefix(&source)
                    .map_err(|error| {
                        DesktopError::new("SHELF_STORAGE_FAILED", error.to_string(), true)
                    })?
                    .to_string_lossy();
                entry.patch_file =
                    Some(copy_legacy_file(&source, &directory, &entry.id, &name).await?);
                index.shelves.push(entry);
            }
        }
        index.migrated_sources.push(source_key);
        changed = true;
    }
    // Shared metadata uses detailed file objects, including when migrating old string lists.
    for entry in &mut index.shelves {
        for file in &mut entry.files {
            if let ShelfFileItem::Simple(path) = file {
                *file = ShelfFileItem::Detailed(ShelfFileEntry {
                    path: path.clone(),
                    status: "modified".into(),
                });
                changed = true;
            }
        }
    }
    if changed {
        write_index(config_dir, repo, &index).await?;
    }
    Ok(index)
}

async fn copy_legacy_file(
    source: &Path,
    directory: &Path,
    id: &str,
    name: &str,
) -> Result<String, DesktopError> {
    let from = stored_file(source, name)?;
    let target_name = format!("{id}-{}.data", hex::encode(Sha1::digest(name.as_bytes())));
    let target = safe_relative(directory, &target_name, true)?;
    let bytes = tokio::fs::read(&from).await.map_err(storage_error)?;
    if target.exists() {
        let existing = tokio::fs::read(stored_file(directory, &target_name)?)
            .await
            .map_err(storage_error)?;
        if existing != bytes {
            return Err(DesktopError::new(
                "SHELF_STORAGE_FAILED",
                "Shelf content collision",
                true,
            ));
        }
    } else {
        let temporary = directory.join(format!("{target_name}.{}.tmp", uuid::Uuid::new_v4()));
        let result = async {
            tokio::fs::write(&temporary, &bytes)
                .await
                .map_err(storage_error)?;
            tokio::fs::rename(&temporary, &target)
                .await
                .map_err(storage_error)
        }
        .await;
        let _ = tokio::fs::remove_file(temporary).await;
        result?;
    }
    Ok(target_name)
}

async fn write_index(
    config_dir: &Path,
    repo: &RepositoryMeta,
    index: &ShelfIndex,
) -> Result<(), DesktopError> {
    let directory = shelf_dir(config_dir, repo).await?;
    let target = directory.join("shelves.json");
    let temporary = directory.join(format!("shelves.json.{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(index)
        .map_err(|error| DesktopError::new("SHELF_INDEX_INVALID", error.to_string(), true))?;
    let result = async {
        tokio::fs::write(&temporary, bytes)
            .await
            .map_err(storage_error)?;
        tokio::fs::rename(&temporary, &target)
            .await
            .map_err(storage_error)
    }
    .await;
    let _ = tokio::fs::remove_file(temporary).await;
    result
}

async fn shelf_dir(_config_dir: &Path, repo: &RepositoryMeta) -> Result<PathBuf, DesktopError> {
    let output = git(
        repo,
        vec!["rev-parse".into(), "--absolute-git-dir".into()],
        &CancellationToken::new(),
    )
    .await?;
    let git_dir = PathBuf::from(output.stdout_text().trim());
    safe_relative(&git_dir, "versiondock/shelves", true)
}

fn stored_file(directory: &Path, name: &str) -> Result<PathBuf, DesktopError> {
    let file = safe_relative(directory, name, true)?;
    if file == directory
        || !std::fs::symlink_metadata(&file)
            .map_err(storage_error)?
            .is_file()
    {
        return Err(DesktopError::new(
            "SHELF_STORAGE_FAILED",
            "Stored content is not a regular file",
            true,
        ));
    }
    Ok(file)
}

fn get_patch_path(directory: &Path, entry: &ShelfEntryInternal) -> Result<PathBuf, DesktopError> {
    validate_id(&entry.id)?;
    if let Some(ref name) = entry.patch_file {
        let candidate = safe_relative(directory, name, true)?;
        if candidate.is_file() {
            return stored_file(directory, name);
        }
    }
    safe_relative(directory, &format!("{}.patch", entry.id), true)
}

fn select_patch(bytes: &[u8], paths: &[String]) -> Vec<u8> {
    // Decode only for path matching. Patch bodies may contain non-UTF-8 text or
    // raw symlink target bytes; copy the original sections without re-encoding.
    let marker = b"diff --git ";
    let boundaries: Vec<_> = bytes
        .windows(marker.len())
        .enumerate()
        .filter(|(offset, value)| *value == marker && (*offset == 0 || bytes[offset - 1] == b'\n'))
        .map(|(offset, _)| offset)
        .collect();
    let mut result = Vec::new();
    for (index, start) in boundaries.iter().enumerate() {
        let section = &bytes[*start..boundaries.get(index + 1).copied().unwrap_or(bytes.len())];
        if paths
            .iter()
            .any(|path| section_touches_path(&String::from_utf8_lossy(section), path))
        {
            result.extend_from_slice(section);
        }
    }
    result
}

fn section_touches_path(section: &str, path: &str) -> bool {
    let plain = format!("diff --git a/{path} b/{path}\n");
    let quoted = format!(
        "diff --git {} {}\n",
        quote_patch_path(&format!("a/{path}")),
        quote_patch_path(&format!("b/{path}"))
    );
    section.starts_with(&plain)
        || section.starts_with(&quoted)
        || section.lines().any(|line| {
            if let Some(value) = line
                .strip_prefix("rename from ")
                .or_else(|| line.strip_prefix("rename to "))
            {
                return crate::diff_content::decode_git_path(value) == path;
            }
            if let Some(value) = line
                .strip_prefix("--- ")
                .or_else(|| line.strip_prefix("+++ "))
            {
                let value = crate::diff_content::decode_git_path(value.trim_end_matches('\t'));
                return value
                    .strip_prefix("a/")
                    .or_else(|| value.strip_prefix("b/"))
                    == Some(path);
            }
            false
        })
}

struct AttachmentRestore {
    attachment: ShelfAttachment,
    source: std::fs::File,
    destination: PathBuf,
}

fn prepare_attachments(
    directory: &Path,
    repo: &RepositoryMeta,
    entry: &ShelfEntryInternal,
    paths: Option<&[String]>,
) -> Result<Vec<AttachmentRestore>, DesktopError> {
    entry
        .binary_files
        .iter()
        .filter(|attachment| {
            paths.is_none_or(|paths| paths.is_empty() || paths.contains(&attachment.repo_rel_path))
        })
        .map(|attachment| {
            let source = stored_file(directory, &attachment.store_name)?;
            let destination =
                safe_relative(Path::new(&repo.root_path), &attachment.repo_rel_path, true)?;
            match std::fs::symlink_metadata(&destination) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(storage_error(error)),
                Ok(_) => {
                    return Err(DesktopError::new(
                        "SHELF_RESTORE_FAILED",
                        format!("Destination already exists: {}", attachment.repo_rel_path),
                        true,
                    ))
                }
            }
            if attachment.kind != "file" && attachment.kind != "symlink" {
                return Err(DesktopError::new(
                    "SHELF_RESTORE_FAILED",
                    "Unsupported shelf attachment kind",
                    true,
                ));
            }
            Ok(AttachmentRestore {
                attachment: attachment.clone(),
                source: std::fs::File::open(source).map_err(storage_error)?,
                destination,
            })
        })
        .collect()
}

fn restore_attachments(
    repo: &RepositoryMeta,
    attachments: Vec<AttachmentRestore>,
) -> Result<(), DesktopError> {
    use std::io::Read;
    for mut restore in attachments {
        let root = Path::new(&repo.root_path);
        safe_relative(root, &restore.attachment.repo_rel_path, true)?;
        if let Some(parent) = restore.destination.parent() {
            std::fs::create_dir_all(parent).map_err(storage_error)?;
        }
        safe_relative(root, &restore.attachment.repo_rel_path, true)?;
        if restore.attachment.kind == "symlink" {
            let mut bytes = Vec::new();
            restore
                .source
                .read_to_end(&mut bytes)
                .map_err(storage_error)?;
            restore_symlink(&bytes, &restore.destination)?;
        } else {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&restore.destination)
                .map_err(storage_error)?;
            std::io::copy(&mut restore.source, &mut file).map_err(storage_error)?;
            #[cfg(unix)]
            if let Some(mode) = restore.attachment.mode {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(std::fs::Permissions::from_mode(mode & 0o777))
                    .map_err(storage_error)?;
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn restore_symlink(bytes: &[u8], destination: &Path) -> Result<(), DesktopError> {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    symlink(std::ffi::OsStr::from_bytes(bytes), destination).map_err(storage_error)
}

#[cfg(windows)]
fn restore_symlink(bytes: &[u8], destination: &Path) -> Result<(), DesktopError> {
    let target = std::str::from_utf8(bytes)
        .map_err(|error| DesktopError::new("SHELF_RESTORE_FAILED", error.to_string(), true))?;
    std::os::windows::fs::symlink_file(target, destination).map_err(storage_error)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shelf_partial_patch_preserves_non_utf8_bytes_and_literal_paths() {
        let patch = b"diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+x\xff\n\\ No newline at end of file\ndiff --git a/other b/other\nnew file mode 100644\n";
        let selected = select_patch(patch, &["link".into()]);
        assert_eq!(
            selected,
            &patch[..patch
                .windows(b"diff --git a/other".len())
                .position(|value| value == b"diff --git a/other")
                .unwrap()]
        );
        assert!(selected.contains(&0xff));
    }

    async fn fixture() -> (tempfile::TempDir, RepositoryMeta, PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let repo = RepositoryMeta {
            id: "git-test".into(),
            name: "test".into(),
            root_path: root.to_string_lossy().into_owned(),
            color: "#888888".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let token = CancellationToken::new();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.test"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git(&repo, args.into_iter().map(String::from).collect(), &token)
                .await
                .unwrap();
        }
        std::fs::write(root.join("file.txt"), "original\n").unwrap();
        git(&repo, vec!["add".into(), ".".into()], &token)
            .await
            .unwrap();
        git(
            &repo,
            vec!["commit".into(), "-m".into(), "initial".into()],
            &token,
        )
        .await
        .unwrap();
        let config = temporary.path().join("config");
        (temporary, repo, config)
    }

    fn legacy_attachment(config: &Path, repo: &RepositoryMeta, patch: &str) -> PathBuf {
        let legacy = config.join("shelves").join(&repo.id);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("shelf-legacy.patch"), patch).unwrap();
        std::fs::write(legacy.join("blob"), [0, 255, 128, 9]).unwrap();
        let metadata = serde_json::json!({"shelves": [{
            "id": "shelf-legacy", "name": "legacy", "date": "2026-10-09T00:00:00Z",
            "files": [{"path": "blob.bin", "status": "untracked"}], "patchFile": "shelf-legacy.patch",
            "binaryFiles": [{"repoRelPath": "blob.bin", "storeName": "blob", "mode": 493}],
            "futureField": {"value": true}
        }], "futureIndexField": "preserve"});
        std::fs::write(
            legacy.join("shelves.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        legacy
    }

    #[tokio::test]
    async fn shelf_legacy_attachment_only_restore_and_drop_never_reimports() {
        let (_temporary, repo, config) = fixture().await;
        let legacy = legacy_attachment(&config, &repo, "");
        assert_eq!(list(&config, &repo).await.unwrap().len(), 1);
        let directory = shelf_dir(&config, &repo).await.unwrap();
        let index = load_index(&directory.join("shelves.json")).await.unwrap();
        assert_eq!(index.shelves[0].extra["futureField"]["value"], true);
        apply(
            &config,
            &repo,
            "shelf-legacy",
            None,
            true,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let restored = Path::new(&repo.root_path).join("blob.bin");
        assert_eq!(std::fs::read(&restored).unwrap(), [0, 255, 128, 9]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(restored).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        drop_shelf(&config, &repo, "shelf-legacy").await.unwrap();
        assert!(list(&config, &repo).await.unwrap().is_empty());
        assert!(legacy.join("shelves.json").is_file());
        assert_eq!(std::fs::read_dir(directory).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shelf_symlink_targets_restore_as_raw_bytes() {
        use std::os::unix::ffi::OsStrExt;
        let (_temporary, repo, config) = fixture().await;
        let legacy = legacy_attachment(&config, &repo, "");
        let target = [b'x', b'\n', 0xff];
        std::fs::write(legacy.join("link-target"), target).unwrap();
        let metadata = serde_json::json!({"shelves": [{"id": "shelf-link", "patchFile": "shelf-legacy.patch",
            "files": ["link"], "binaryFiles": [{"repoRelPath": "link", "storeName": "link-target", "kind": "symlink"}]}]});
        std::fs::write(
            legacy.join("shelves.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        apply(
            &config,
            &repo,
            "shelf-link",
            None,
            true,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let path = Path::new(&repo.root_path).join("link");
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_link(path).unwrap().as_os_str().as_bytes(),
            target
        );
    }

    #[tokio::test]
    async fn shelf_attachment_preflight_preserves_existing_worktree_and_corrupt_index() {
        let (_temporary, repo, config) = fixture().await;
        legacy_attachment(&config, &repo, "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-original\n+changed\n");
        let root = Path::new(&repo.root_path);
        std::fs::write(root.join("blob.bin"), "keep").unwrap();
        assert!(apply(
            &config,
            &repo,
            "shelf-legacy",
            None,
            true,
            &CancellationToken::new()
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("file.txt")).unwrap(),
            "original\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("blob.bin")).unwrap(),
            "keep"
        );
        let directory = shelf_dir(&config, &repo).await.unwrap();
        std::fs::write(directory.join("shelves.json"), "invalid JSON").unwrap();
        assert_eq!(
            list(&config, &repo).await.unwrap_err().code,
            "SHELF_INDEX_INVALID"
        );
        assert_eq!(
            std::fs::read_to_string(directory.join("shelves.json")).unwrap(),
            "invalid JSON"
        );
    }

    #[tokio::test]
    async fn shelf_independent_app_configs_share_records_and_serialize_deletion() {
        let (_temporary, repo, config) = fixture().await;
        legacy_attachment(&config, &repo, "");
        let other = config.with_file_name("other-config");
        assert_eq!(list(&config, &repo).await.unwrap().len(), 1);
        assert_eq!(list(&other, &repo).await.unwrap().len(), 1);
        let (first, second) = tokio::join!(
            drop_shelf(&config, &repo, "shelf-legacy"),
            drop_shelf(&other, &repo, "shelf-legacy")
        );
        assert_ne!(first.is_ok(), second.is_ok());
        assert_eq!(
            first.err().or(second.err()).unwrap().code,
            "SHELF_NOT_FOUND"
        );
        assert!(list(&config, &repo).await.unwrap().is_empty());
    }
}
