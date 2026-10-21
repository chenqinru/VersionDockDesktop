use super::storage::*;
use crate::{cli, models::DesktopError, state::safe_relative};
use sha2::Digest;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader, Read},
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
    read_content(root, path, None)?
        .map(|content| {
            Ok(Entry {
                hash: store.put(&content.bytes)?,
                mode: content.mode,
                kind: content.kind,
            })
        })
        .transpose()
}

struct FileContent {
    bytes: Vec<u8>,
    mode: u32,
    kind: String,
}

fn read_content(
    root: &Path,
    path: &str,
    token: Option<&CancellationToken>,
) -> Result<Option<FileContent>, DesktopError> {
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
        let mut file = fs::File::open(target).map_err(io)?;
        let mut bytes = Vec::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            if let Some(token) = token {
                check_capture(token)?;
            }
            let length = file.read(&mut buffer).map_err(io)?;
            if length == 0 {
                break;
            }
            bytes.try_reserve(length).map_err(io)?;
            bytes.extend_from_slice(&buffer[..length]);
        }
        (bytes, mode, "file")
    } else {
        return Err(failure(format!("Unsupported checkpoint file: {path}")));
    };
    Ok(Some(FileContent {
        bytes,
        mode,
        kind: kind.into(),
    }))
}
fn blob_oid(bytes: &[u8], size: usize) -> String {
    let header = format!("blob {}\0", bytes.len());
    if size == 64 {
        let mut hash = sha2::Sha256::new();
        hash.update(header.as_bytes());
        hash.update(bytes);
        hex::encode(hash.finalize())
    } else {
        let mut hash = sha1::Sha1::new();
        hash.update(header.as_bytes());
        hash.update(bytes);
        hex::encode(hash.finalize())
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    #[tokio::test]
    async fn crlf_capture_batches_duplicate_objects_once_across_both_passes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repository");
        fs::create_dir(&root).unwrap();
        let token = CancellationToken::new();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Checkpoint QA"],
            vec!["config", "user.email", "checkpoint@example.test"],
            vec!["config", "core.autocrlf", "true"],
        ] {
            git(&root, &args, None, &token).await.unwrap();
        }
        fs::write(root.join(".gitattributes"), b"*.txt text eol=crlf\n").unwrap();
        for index in 0..64 {
            fs::write(root.join(format!("file-{index}.txt")), b"same content\r\n").unwrap();
        }
        git(&root, &["add", "."], None, &token).await.unwrap();
        git(&root, &["commit", "-m", "baseline"], None, &token)
            .await
            .unwrap();
        assert!(git(&root, &["status", "--porcelain"], None, &token)
            .await
            .unwrap()
            .is_empty());
        let store = Storage::new(&temp.path().join("config")).unwrap();
        let mut objects = CaptureObjects::default();
        let captured = capture_stable(
            &store,
            &[root.to_string_lossy().into_owned()],
            &token,
            &mut objects,
        )
        .await
        .unwrap();
        // All 64 CRLF files share one LF index blob. Neither repeated paths nor
        // the second stability pass may launch another Git object reader.
        assert_eq!(objects.batches, 1);
        assert_eq!(objects.index.len(), 2);
        assert_eq!(objects.file_reads, 2 * 65);
        let repo = &captured.repositories[0];
        assert_eq!(repo.index.len(), 65);
        assert_eq!(
            store.get(&repo.working["file-0.txt"].hash).unwrap(),
            b"same content\r\n"
        );
        assert_eq!(
            store.get(&repo.index["file-0.txt"].hash).unwrap(),
            b"same content\n"
        );
    }
}

pub(super) fn check_capture(token: &CancellationToken) -> Result<(), DesktopError> {
    if token.is_cancelled() {
        Err(DesktopError::new(
            "REQUEST_CANCELLED",
            "Checkpoint capture cancelled",
            true,
        ))
    } else {
        Ok(())
    }
}

/// Scoped to one stable capture. Never trust stat/mtime across recording rounds:
/// every working file is still read and hashed in both passes.
#[derive(Default)]
struct CaptureObjects {
    saved: BTreeSet<String>,
    index: BTreeMap<String, String>,
    file_reads: usize,
    bytes_read: u64,
    batches: usize,
    pending: Vec<Vec<u8>>,
    pending_bytes: usize,
}
impl CaptureObjects {
    async fn put(
        &mut self,
        store: &Storage,
        bytes: Vec<u8>,
        token: &CancellationToken,
        verify: bool,
    ) -> Result<String, DesktopError> {
        check_capture(token)?;
        let hash = digest(&bytes);
        if !verify && self.saved.insert(hash.clone()) {
            self.pending_bytes += bytes.len();
            self.pending.push(bytes);
            if self.pending.len() == 4 || self.pending_bytes >= 16 * 1024 * 1024 {
                self.flush(store, token).await?;
            }
        }
        Ok(hash)
    }

    async fn flush(
        &mut self,
        store: &Storage,
        token: &CancellationToken,
    ) -> Result<(), DesktopError> {
        // A small group overlaps durable file syncs without changing the object
        // format or publishing a manifest before every object is on disk.
        let mut writes = tokio::task::JoinSet::new();
        for bytes in std::mem::take(&mut self.pending) {
            let store = Storage {
                root: store.root.clone(),
            };
            let token = token.clone();
            writes.spawn_blocking(move || {
                check_capture(&token)?;
                // Existing objects are read and verified once per capture.
                store.put(&bytes)?;
                check_capture(&token)
            });
        }
        self.pending_bytes = 0;
        let mut failure = None;
        // Even on error/cancel, join every started writer before releasing the
        // capture lock. Object cleanup must never race a detached writer.
        while let Some(result) = writes.join_next().await {
            if let Err(error) = result.map_err(io).and_then(|result| result) {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    async fn load_index(
        &mut self,
        store: &Storage,
        root: &Path,
        oids: &BTreeSet<String>,
        token: &CancellationToken,
        verify: bool,
    ) -> Result<(), DesktopError> {
        if oids.is_empty() {
            return Ok(());
        }
        check_capture(token)?;
        let input = oids
            .iter()
            .map(|oid| format!("{oid}\n"))
            .collect::<String>();
        let output = tempfile::NamedTempFile::new().map_err(io)?;
        self.batches += 1;
        cli::git_to_file(
            &["cat-file".into(), "--batch".into()],
            root,
            input.as_bytes(),
            output.path(),
            Duration::from_secs(600),
            token,
        )
        .await?;
        let mut reader = BufReader::new(fs::File::open(output.path()).map_err(io)?);
        for oid in oids {
            check_capture(token)?;
            let mut header = Vec::new();
            reader
                .by_ref()
                .take(256)
                .read_until(b'\n', &mut header)
                .map_err(io)?;
            let header = text(&header)?;
            let fields = header.split_whitespace().collect::<Vec<_>>();
            if fields.len() != 3 || fields[0] != oid || fields[1] != "blob" {
                return Err(failure("Invalid checkpoint Git object response"));
            }
            let size = fields[2].parse::<usize>().map_err(io)?;
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(size).map_err(io)?;
            bytes.resize(size, 0);
            for chunk in bytes.chunks_mut(64 * 1024) {
                check_capture(token)?;
                reader.read_exact(chunk).map_err(io)?;
            }
            let mut separator = [0];
            reader.read_exact(&mut separator).map_err(io)?;
            if separator != *b"\n" || blob_oid(&bytes, oid.len()) != *oid {
                return Err(failure("Invalid checkpoint Git object contents"));
            }
            check_capture(token)?;
            let hash = self.put(store, bytes, token, verify).await?;
            self.index.insert(oid.clone(), hash);
            tokio::task::yield_now().await;
        }
        if !reader.fill_buf().map_err(io)?.is_empty() {
            return Err(failure("Unexpected checkpoint Git object output"));
        }
        self.flush(store, token).await?;
        Ok(())
    }
}

async fn capture_repo(
    store: &Storage,
    root: &Path,
    token: &CancellationToken,
    objects: &mut CaptureObjects,
    verify: bool,
) -> Result<RepoSnapshot, DesktopError> {
    check_capture(token)?;
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
    let git_dir = text(&git(root, &["rev-parse", "--absolute-git-dir"], None, token).await?)?;
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "BISECT_START",
    ] {
        if Path::new(git_dir.trim()).join(marker).exists() {
            return Err(failure(
                "Finish the current Git operation before recording checkpoints",
            ));
        }
    }
    let raw = git(root, &["ls-files", "--stage", "-v", "-z"], None, token).await?;
    let mut entries = BTreeMap::new();
    for part in raw.split(|b| *b == 0).filter(|v| !v.is_empty()) {
        if part[0] == b'S' || part[0].is_ascii_lowercase() {
            return Err(failure(
                "Sparse or assume-unchanged indexes are not supported by checkpoints",
            ));
        }
        let tab = part
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| failure("Invalid Git index entry"))?;
        let header = text(&part[..tab])?;
        let fields = header.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 4
            || fields[3] != "0"
            || !matches!(fields[1], "100644" | "100755" | "120000")
        {
            return Err(failure(
                "Unmerged indexes and submodules are not supported by checkpoints",
            ));
        }
        entries.insert(
            text(&part[tab + 1..])?,
            (
                u32::from_str_radix(fields[1], 8).map_err(io)?,
                fields[2].to_owned(),
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
        check_capture(token)?;
        if let Some(FileContent { bytes, mode, kind }) = read_content(root, &name, Some(token))? {
            check_capture(token)?;
            objects.file_reads += 1;
            objects.bytes_read += bytes.len() as u64;
            let matching_oid = entries
                .get(&name)
                .map(|(_, oid)| oid)
                .filter(|oid| {
                    !objects.index.contains_key(*oid) && blob_oid(&bytes, oid.len()) == **oid
                })
                .cloned();
            let hash = objects.put(store, bytes, token, verify).await?;
            if let Some(oid) = matching_oid {
                objects.index.insert(oid, hash.clone());
            }
            working.insert(name, Entry { hash, mode, kind });
        }
        tokio::task::yield_now().await;
    }
    objects.flush(store, token).await?;
    let missing = entries
        .values()
        .map(|(_, oid)| oid)
        .filter(|oid| !objects.index.contains_key(*oid))
        .cloned()
        .collect();
    objects
        .load_index(store, root, &missing, token, verify)
        .await?;
    let mut index = BTreeMap::new();
    for (name, (mode, oid)) in entries {
        check_capture(token)?;
        let hash = objects
            .index
            .get(&oid)
            .ok_or_else(|| failure("Missing checkpoint Git object"))?
            .clone();
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
    let start = std::time::Instant::now();
    let mut objects = CaptureObjects::default();
    let result = capture_stable(store, paths, token, &mut objects).await;
    crate::logger::log_entry(
        crate::logger::LogLevel::Debug, crate::logger::LogChannel::Core,
        "Checkpoint capture",
        Some(format!("repositories={} file_reads={} bytes_read={} objects_saved={} git_batches={} completed={}", paths.len(), objects.file_reads, objects.bytes_read, objects.saved.len(), objects.batches, result.is_ok())),
        Some(start.elapsed().as_millis().min(u32::MAX as u128) as u32), None,
    );
    result
}

async fn capture_stable(
    store: &Storage,
    paths: &[String],
    token: &CancellationToken,
    objects: &mut CaptureObjects,
) -> Result<Snapshot, DesktopError> {
    let mut repos = Vec::new();
    for path in paths {
        repos.push(capture_repo(store, Path::new(path), token, objects, false).await?);
    }
    let mut verify = Vec::new();
    for path in paths {
        verify.push(capture_repo(store, Path::new(path), token, objects, true).await?);
    }
    check_capture(token)?;
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
