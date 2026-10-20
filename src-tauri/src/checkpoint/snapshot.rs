use super::storage::*;
use crate::{cli, models::DesktopError, state::safe_relative};
use sha2::Digest;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub(super) async fn git(
    root: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    token: &CancellationToken,
) -> Result<Vec<u8>, DesktopError> {
    let args = args.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    Ok(
        cli::run("git", &args, root, input, Duration::from_secs(120), token)
            .await?
            .stdout,
    )
}
pub(super) fn text(bytes: &[u8]) -> Result<String, DesktopError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| failure("Checkpoint paths must be valid UTF-8"))
}
pub(super) fn location(root: &Path, relative: &str) -> Result<PathBuf, DesktopError> {
    if relative
        .split(['/', '\\'])
        .any(|p| p.eq_ignore_ascii_case(".git"))
    {
        return Err(failure(
            "Git administrative files are outside checkpoint scope",
        ));
    }
    safe_relative(root, relative, false)
}
pub(super) fn read_entry(
    store: &Storage,
    root: &Path,
    path: &str,
) -> Result<Option<Entry>, DesktopError> {
    let target = location(root, path)?;
    let metadata = match fs::symlink_metadata(&target) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(e)),
    };
    let (bytes, mode, kind) = if metadata.file_type().is_symlink() {
        let link = fs::read_link(&target).map_err(io)?;
        #[cfg(unix)]
        let bytes = {
            use std::os::unix::ffi::OsStrExt;
            link.as_os_str().as_bytes().to_vec()
        };
        #[cfg(not(unix))]
        let bytes = link
            .to_str()
            .ok_or_else(|| failure("Unsupported link encoding"))?
            .as_bytes()
            .to_vec();
        (bytes, 0o120000, "symlink")
    } else if metadata.is_file() {
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o777
        };
        #[cfg(not(unix))]
        let mode = 0o644;
        (fs::read(target).map_err(io)?, mode, "file")
    } else {
        return Err(failure(format!("Unsupported checkpoint file: {path}")));
    };
    Ok(Some(Entry {
        hash: store.put(&bytes)?,
        mode,
        kind: kind.into(),
    }))
}
fn blob_oid(bytes: &[u8], size: usize) -> String {
    let mut body = format!("blob {}\0", bytes.len()).into_bytes();
    body.extend_from_slice(bytes);
    if size == 64 {
        hex::encode(sha2::Sha256::digest(&body))
    } else {
        hex::encode(sha1::Sha1::digest(&body))
    }
}
async fn capture_repo(
    store: &Storage,
    root: &Path,
    token: &CancellationToken,
) -> Result<RepoSnapshot, DesktopError> {
    if token.is_cancelled() {
        return Err(failure("Checkpoint capture cancelled"));
    }
    let head = text(&git(root, &["rev-parse", "--verify", "HEAD"], None, token).await?)?
        .trim()
        .to_owned();
    let branch = text(
        &git(
            root,
            &["rev-parse", "--symbolic-full-name", "HEAD"],
            None,
            token,
        )
        .await?,
    )?
    .trim()
    .to_owned();
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "BISECT_START",
    ] {
        let path = text(&git(root, &["rev-parse", "--git-path", marker], None, token).await?)?;
        if root.join(path.trim()).exists() {
            return Err(failure(
                "Finish the current Git operation before recording checkpoints",
            ));
        }
    }
    let flags = git(root, &["ls-files", "-v", "-z"], None, token).await?;
    if flags
        .split(|b| *b == 0)
        .filter(|v| !v.is_empty())
        .any(|v| v[0] == b'S' || v[0].is_ascii_lowercase())
    {
        return Err(failure(
            "Sparse or assume-unchanged indexes are not supported by checkpoints",
        ));
    }
    let raw = git(root, &["ls-files", "--stage", "-z"], None, token).await?;
    let mut entries = BTreeMap::new();
    for part in raw.split(|b| *b == 0).filter(|v| !v.is_empty()) {
        let tab = part
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| failure("Invalid Git index entry"))?;
        let header = text(&part[..tab])?;
        let fields = header.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3
            || fields[2] != "0"
            || !matches!(fields[0], "100644" | "100755" | "120000")
        {
            return Err(failure(
                "Unmerged indexes and submodules are not supported by checkpoints",
            ));
        }
        entries.insert(
            text(&part[tab + 1..])?,
            (
                u32::from_str_radix(fields[0], 8).map_err(io)?,
                fields[1].to_owned(),
            ),
        );
    }
    let other = git(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        None,
        token,
    )
    .await?;
    let mut names: BTreeSet<String> = entries.keys().cloned().collect();
    for name in other.split(|b| *b == 0).filter(|v| !v.is_empty()) {
        names.insert(text(name)?);
    }
    let mut working = BTreeMap::new();
    for name in names {
        if let Some(entry) = read_entry(store, root, &name)? {
            working.insert(name, entry);
        }
    }
    let mut index = BTreeMap::new();
    for (name, (mode, oid)) in entries {
        let hash = match working.get(&name) {
            Some(entry) if blob_oid(&store.get(&entry.hash)?, oid.len()) == oid => {
                entry.hash.clone()
            }
            _ => store.put(&git(root, &["cat-file", "blob", &oid], None, token).await?)?,
        };
        index.insert(
            name,
            Entry {
                hash,
                mode,
                kind: if mode == 0o120000 { "symlink" } else { "file" }.into(),
            },
        );
    }
    Ok(RepoSnapshot {
        path: root.to_string_lossy().into_owned(),
        head,
        branch,
        working,
        index,
    })
}
pub(super) async fn capture(
    store: &Storage,
    paths: &[String],
    token: &CancellationToken,
) -> Result<Snapshot, DesktopError> {
    let mut repos = Vec::new();
    for path in paths {
        repos.push(capture_repo(store, Path::new(path), token).await?);
    }
    let mut verify = Vec::new();
    for path in paths {
        verify.push(capture_repo(store, Path::new(path), token).await?);
    }
    if repos != verify {
        return Err(failure(
            "Files or index changed during checkpoint capture; retry after writes stop",
        ));
    }
    Ok(Snapshot {
        repositories: repos,
    })
}

pub(super) fn write_entry(
    store: &Storage,
    root: &Path,
    path: &str,
    entry: Option<&Entry>,
) -> Result<(), DesktopError> {
    let target = location(root, path)?;
    if let Some(entry) = entry {
        let bytes = store.get(&entry.hash)?;
        let parent = target
            .parent()
            .ok_or_else(|| failure("Missing file parent"))?;
        fs::create_dir_all(parent).map_err(io)?;
        // Recheck after creating directories, and never follow an existing leaf link.
        location(root, path)?;
        if entry.kind == "symlink" {
            if fs::symlink_metadata(&target).is_ok() {
                fs::remove_file(&target).map_err(io)?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStringExt;
                std::os::unix::fs::symlink(std::ffi::OsString::from_vec(bytes), &target)
                    .map_err(io)?;
            }
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_file(text(&bytes)?, &target).map_err(io)?;
            }
        } else {
            if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
                fs::remove_file(&target).map_err(io)?;
            }
            atomic(&target, &bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(entry.mode & 0o777))
                    .map_err(io)?;
            }
        }
    } else if fs::symlink_metadata(&target).is_ok() {
        fs::remove_file(target).map_err(io)?;
    }
    Ok(())
}

/// Reserve the real index before editing it; plumbing works on an isolated copy.
/// The caller retains the reservation until its transaction has finished.
pub(super) struct IndexLock {
    pub index: PathBuf,
    pub lock: PathBuf,
    pub file: fs::File,
    pub owner: Vec<u8>,
}
impl Drop for IndexLock {
    fn drop(&mut self) {
        if fs::read(&self.lock).is_ok_and(|bytes| bytes == self.owner) {
            let _ = fs::remove_file(&self.lock);
        }
    }
}
pub(super) async fn index_lock(
    root: &Path,
    token: &CancellationToken,
) -> Result<IndexLock, DesktopError> {
    let relative = text(&git(root, &["rev-parse", "--git-path", "index"], None, token).await?)?;
    let index = root.join(relative.trim());
    let lock = index.with_file_name("index.lock");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|_| failure("Git index is busy; retry after the other Git operation finishes"))?;
    use std::io::Write;
    let owner = uuid::Uuid::new_v4().to_string().into_bytes();
    file.write_all(&owner).map_err(io)?;
    file.sync_all().map_err(io)?;
    Ok(IndexLock {
        index,
        lock,
        file,
        owner,
    })
}
pub(super) async fn write_index(
    store: &Storage,
    root: &Path,
    from: &BTreeMap<String, Entry>,
    to: &BTreeMap<String, Entry>,
    reservation: &IndexLock,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if from == to {
        return Ok(());
    }
    let temp = tempfile::NamedTempFile::new_in(
        reservation
            .index
            .parent()
            .ok_or_else(|| failure("Missing index directory"))?,
    )
    .map_err(io)?;
    fs::copy(&reservation.index, temp.path()).map_err(io)?;
    let env = vec![(
        "GIT_INDEX_FILE".into(),
        temp.path().to_string_lossy().into_owned(),
    )];
    let names = from.keys().chain(to.keys()).collect::<BTreeSet<_>>();
    let oid_length = text(&git(root, &["rev-parse", "HEAD"], None, token).await?)?
        .trim()
        .len();
    let mut input = Vec::new();
    for name in names {
        if from.get(name) == to.get(name) {
            continue;
        }
        if let Some(entry) = to.get(name) {
            let output = cli::run_with_isolated_git_index(
                &["hash-object".into(), "-w".into(), "--stdin".into()],
                root,
                Some(&store.get(&entry.hash)?),
                Duration::from_secs(120),
                token,
                &env,
            )
            .await?;
            input.extend_from_slice(
                format!("{:o} {}\t", entry.mode, output.stdout_text().trim()).as_bytes(),
            );
        } else {
            input.extend_from_slice(format!("0 {}\t", "0".repeat(oid_length)).as_bytes());
        }
        input.extend_from_slice(name.as_bytes());
        input.push(0);
    }
    cli::run_with_isolated_git_index(
        &["update-index".into(), "-z".into(), "--index-info".into()],
        root,
        Some(&input),
        Duration::from_secs(120),
        token,
        &env,
    )
    .await?;
    // Do not remove an index lock that belongs to another process.
    if reservation.file.metadata().map_err(io)?.len() != reservation.owner.len() as u64
        || fs::read(&reservation.lock).map_err(io)? != reservation.owner
    {
        return Err(failure("Git index reservation changed"));
    }
    atomic(&reservation.index, &fs::read(temp.path()).map_err(io)?)
}
