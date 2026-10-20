use super::types::*;
use crate::models::DesktopError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

#[derive(PartialEq, Eq)]
struct FileStamp {
    length: u64,
    modified: SystemTime,
    #[cfg(unix)]
    inode: u64,
}
fn file_stamp(path: &Path) -> Result<FileStamp, std::io::Error> {
    let metadata = fs::metadata(path)?;
    Ok(FileStamp {
        length: metadata.len(),
        modified: metadata.modified()?,
        #[cfg(unix)]
        inode: {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        },
    })
}
type MetadataCache = Option<(PathBuf, FileStamp, Database)>;
static METADATA_CACHE: OnceLock<Mutex<MetadataCache>> = OnceLock::new();

pub(super) fn failure(message: impl Into<String>) -> DesktopError {
    DesktopError::new("CHECKPOINT_FAILED", message.into(), true)
}
pub(super) fn io(error: impl std::fmt::Display) -> DesktopError {
    failure(error.to_string())
}
pub(super) fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Entry {
    pub hash: String,
    pub mode: u32,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct RepoSnapshot {
    pub path: String,
    pub head: String,
    pub branch: String,
    pub working: BTreeMap<String, Entry>,
    pub index: BTreeMap<String, Entry>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub repositories: Vec<RepoSnapshot>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Prepared {
    pub preview: RestorePreview,
    pub current: String,
    pub desired: String,
    pub checkpoint_ids: Vec<String>,
    pub task_state: String,
    pub task_before: TaskWorkspace,
    pub source_task_fingerprint: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Transaction {
    pub report: RestoreReport,
    pub prepared: Prepared,
    pub recovery_before: Option<String>,
    pub recovery_expected: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct Database {
    pub tasks: Vec<TaskWorkspace>,
    pub previews: Vec<Prepared>,
    pub transactions: Vec<Transaction>,
    #[serde(default)]
    pub verified_hooks: BTreeMap<String, HookVerification>,
    #[serde(default)]
    pub additional_messages: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub custom_checkpoint_names: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct HookVerification {
    pub completed_at: String,
    pub command_fingerprint: String,
}

pub(super) struct Storage {
    pub root: PathBuf,
}
impl Storage {
    pub fn new(config: &Path) -> Result<Self, DesktopError> {
        let root = config.join("checkpoints");
        fs::create_dir_all(root.join("objects")).map_err(io)?;
        Ok(Self { root })
    }
    pub fn read(&self) -> Result<Database, DesktopError> {
        match fs::read(self.root.join("state.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(io),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Database::default()),
            Err(error) => Err(io(error)),
        }
    }
    /// Cache only display reads; writers always reload durable state under their write lock.
    pub fn read_cached(&self) -> Result<Database, DesktopError> {
        let path = self.root.join("state.json");
        let stamp = match file_stamp(&path) {
            Ok(stamp) => stamp,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Database::default()),
            Err(e) => return Err(io(e)),
        };
        let cache = METADATA_CACHE.get_or_init(Default::default);
        if let Some((cached_path, cached_stamp, db)) = cache.lock().map_err(io)?.as_ref() {
            if cached_path == &path && cached_stamp == &stamp {
                return Ok(db.clone());
            }
        }
        let db: Database = serde_json::from_slice(&fs::read(&path).map_err(io)?).map_err(io)?;
        if file_stamp(&path).is_ok_and(|after| after == stamp) {
            *cache.lock().map_err(io)? = Some((path, stamp, db.clone()));
        }
        Ok(db)
    }
    pub fn save(&self, database: &Database) -> Result<(), DesktopError> {
        atomic(
            &self.root.join("state.json"),
            &serde_json::to_vec(database).map_err(io)?,
        )
    }
    pub fn put(&self, bytes: &[u8]) -> Result<String, DesktopError> {
        let hash = digest(bytes);
        let target = self.root.join("objects").join(&hash);
        if !target.exists() {
            atomic(&target, bytes)?;
        } else {
            self.get(&hash)?;
        }
        Ok(hash)
    }
    pub fn get(&self, hash: &str) -> Result<Vec<u8>, DesktopError> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(failure("Invalid checkpoint object"));
        }
        let data = fs::read(self.root.join("objects").join(hash)).map_err(io)?;
        if digest(&data) != hash {
            return Err(failure("Checkpoint object is damaged"));
        }
        Ok(data)
    }
    pub fn snapshot(&self, hash: &str) -> Result<Snapshot, DesktopError> {
        serde_json::from_slice(&self.get(hash)?).map_err(io)
    }
    pub fn save_snapshot(&self, value: &Snapshot) -> Result<String, DesktopError> {
        self.put(&serde_json::to_vec(value).map_err(io)?)
    }
    pub fn size(&self) -> Result<u64, DesktopError> {
        fs::read_dir(self.root.join("objects"))
            .map_err(io)?
            .try_fold(0, |size, entry| {
                let entry = entry.map_err(io)?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                // A concurrent capture publishes temporary objects by rename.
                // Count only stable content objects, never disappearing temp files.
                if name.len() != 64 || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Ok(size);
                }
                match entry.metadata() {
                    Ok(metadata) => Ok(size + metadata.len()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(size),
                    Err(e) => Err(io(e)),
                }
            })
    }
    pub fn collect(&self, db: &Database) -> Result<(), DesktopError> {
        for (path, _) in self.unreferenced(db)? {
            fs::remove_file(path).map_err(io)?;
        }
        Ok(())
    }
    /// Trace all durable recovery references before deleting shared content objects.
    pub fn unreferenced(&self, db: &Database) -> Result<Vec<(PathBuf, u64)>, DesktopError> {
        let mut roots = Vec::new();
        let mut keep = HashSet::new();
        for task in &db.tasks {
            task_roots(task, &mut roots, &mut keep);
        }
        for preview in &db.previews {
            prepared_roots(preview, &mut roots, &mut keep);
        }
        for tx in &db.transactions {
            prepared_roots(&tx.prepared, &mut roots, &mut keep);
            roots.extend(tx.recovery_before.iter().cloned());
            roots.extend(tx.recovery_expected.iter().cloned());
        }
        let retained = db
            .tasks
            .iter()
            .chain(db.previews.iter().map(|p| &p.task_before))
            .chain(db.transactions.iter().map(|tx| &tx.prepared.task_before))
            .flat_map(|task| task.checkpoints.iter().map(|point| &point.id))
            .collect::<HashSet<_>>();
        for (id, messages) in &db.additional_messages {
            if retained.contains(id) {
                keep.extend(messages.iter().cloned());
            }
        }
        let mut snapshots = HashSet::new();
        for hash in roots {
            if hash.is_empty() || !snapshots.insert(hash.clone()) {
                continue;
            }
            keep.insert(hash.clone());
            for repo in self.snapshot(&hash)?.repositories {
                keep.extend(
                    repo.working
                        .values()
                        .chain(repo.index.values())
                        .map(|entry| entry.hash.clone()),
                );
            }
        }
        let mut garbage = Vec::new();
        for file in fs::read_dir(self.root.join("objects")).map_err(io)? {
            let file = file.map_err(io)?;
            let hash = file.file_name().to_string_lossy().into_owned();
            if hash.len() == 64
                && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                && file.file_type().map_err(io)?.is_file()
                && !keep.contains(&hash)
            {
                garbage.push((file.path(), file.metadata().map_err(io)?.len()));
            }
        }
        garbage.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(garbage)
    }
}

fn task_roots(task: &TaskWorkspace, roots: &mut Vec<String>, blobs: &mut HashSet<String>) {
    roots.extend([task.seed.clone(), task.source_seed.clone()]);
    roots.extend(task.last_applied.iter().cloned());
    for point in &task.checkpoints {
        roots.push(point.before.clone());
        roots.extend(point.after.iter().cloned());
        blobs.extend(point.prompt_hash.iter().cloned());
    }
}

fn prepared_roots(prepared: &Prepared, roots: &mut Vec<String>, blobs: &mut HashSet<String>) {
    roots.extend([prepared.current.clone(), prepared.desired.clone()]);
    roots.extend(prepared.source_task_fingerprint.iter().cloned());
    task_roots(&prepared.task_before, roots, blobs);
}

pub(super) fn atomic(path: &Path, bytes: &[u8]) -> Result<(), DesktopError> {
    let parent = path
        .parent()
        .ok_or_else(|| failure("Missing storage directory"))?;
    fs::create_dir_all(parent).map_err(io)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(io)?;
    file.write_all(bytes).map_err(io)?;
    file.as_file().sync_all().map_err(io)?;
    file.persist(path).map_err(io)?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(io)?;
    Ok(())
}
