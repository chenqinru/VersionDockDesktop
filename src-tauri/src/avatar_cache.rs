use crate::models::{AvatarAuthor, DesktopError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tokio_util::sync::CancellationToken;

const POSITIVE_TTL: i64 = 7 * 24 * 60 * 60;
const NEGATIVE_TTL: i64 = 10 * 60;
const MAX_ENTRIES: usize = 2000;
const MAX_ENTRY_BYTES: u64 = 1_500_000;

#[derive(Serialize, Deserialize)]
struct Entry {
    value: Option<String>,
    timestamp: i64,
}

pub struct AvatarCache {
    directory: PathBuf,
    // Protect clear/write with one revision so late network results cannot
    // repopulate a cache the user has just cleared.
    revision: Mutex<u64>,
    requests: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

pub fn cache(config_dir: &Path) -> Arc<AvatarCache> {
    static CACHES: OnceLock<Mutex<HashMap<PathBuf, Arc<AvatarCache>>>> = OnceLock::new();
    let mut caches = CACHES.get_or_init(Default::default).lock().unwrap();
    caches
        .entry(config_dir.into())
        .or_insert_with(|| Arc::new(AvatarCache::new(config_dir)))
        .clone()
}

pub fn identity(email: &str, name: &str) -> String {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        format!("name:{}", name.trim().to_lowercase())
    } else {
        format!("email:{email}")
    }
}

impl AvatarCache {
    fn new(config_dir: &Path) -> Self {
        Self {
            directory: config_dir.join("author-avatars-v1"),
            revision: Mutex::new(0),
            requests: Mutex::new(HashMap::new()),
        }
    }
    fn path(&self, key: &str) -> PathBuf {
        self.directory.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(key.as_bytes()))
        ))
    }
    pub fn has_entries(&self) -> bool {
        std::fs::read_dir(&self.directory).is_ok_and(|mut entries| entries.next().is_some())
    }
    fn get(&self, key: &str) -> Option<Option<String>> {
        let path = self.path(key);
        if std::fs::metadata(&path).ok()?.len() > MAX_ENTRY_BYTES {
            return None;
        }
        let entry: Entry = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
        let age = chrono::Utc::now().timestamp() - entry.timestamp;
        let ttl = if entry.value.is_some() {
            POSITIVE_TTL
        } else {
            NEGATIVE_TTL
        };
        (age >= 0 && age < ttl).then_some(entry.value)
    }
    fn put(&self, key: &str, value: Option<String>, revision: u64) {
        let current = self.revision.lock().unwrap();
        if *current != revision {
            return;
        }
        let Ok(bytes) = serde_json::to_vec(&Entry {
            value,
            timestamp: chrono::Utc::now().timestamp(),
        }) else {
            return;
        };
        if bytes.len() as u64 > MAX_ENTRY_BYTES || std::fs::create_dir_all(&self.directory).is_err()
        {
            return;
        }
        let Ok(mut file) = tempfile::NamedTempFile::new_in(&self.directory) else {
            return;
        };
        use std::io::Write;
        if file.write_all(&bytes).is_err() {
            return;
        }
        let _ = file.persist(self.path(key));
        let mut files = std::fs::read_dir(&self.directory)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .filter_map(|entry| {
                entry
                    .metadata()
                    .ok()?
                    .modified()
                    .ok()
                    .map(|time| (time, entry.path()))
            })
            .collect::<Vec<_>>();
        if files.len() > MAX_ENTRIES {
            files.sort_by_key(|(time, _)| *time);
            for (_, path) in &files[..files.len() - MAX_ENTRIES] {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    pub fn clear(&self) -> Result<(), DesktopError> {
        let mut revision = self.revision.lock().unwrap();
        *revision += 1;
        match std::fs::remove_dir_all(&self.directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(DesktopError::new(
                "AVATAR_CACHE_CLEAR_FAILED",
                "Unable to clear avatar cache",
                true,
            )),
        }
    }
    fn request_lock(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut requests = self.requests.lock().unwrap();
        requests.retain(|_, value| value.strong_count() > 0);
        if let Some(lock) = requests.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(AsyncMutex::new(()));
        requests.insert(key.into(), Arc::downgrade(&lock));
        lock
    }
    pub fn cached(&self, scope: &str, authors: &[AvatarAuthor]) -> HashMap<String, String> {
        let mut seen = std::collections::HashSet::new();
        authors
            .iter()
            .filter_map(|author| {
                let identity = identity(&author.email, &author.name);
                if !seen.insert(identity.clone()) {
                    return None;
                }
                self.get(&format!("{scope}\0{identity}"))
                    .flatten()
                    .map(|avatar| (identity, avatar))
            })
            .collect()
    }
}

fn cancelled() -> DesktopError {
    DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)
}

// A batch returns only after every author has settled. The semaphore is shared
// across windows/repositories, while per-identity locks deduplicate lookups.
pub async fn resolve_batch<F, Fut>(
    cache: Arc<AvatarCache>,
    scope: String,
    authors: Vec<AvatarAuthor>,
    cancel: &CancellationToken,
    resolver: F,
) -> Result<HashMap<String, Option<String>>, DesktopError>
where
    F: Fn(String, String) -> Fut + Clone + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Option<String>, DesktopError>> + Send + 'static,
{
    static PERMITS: OnceLock<Semaphore> = OnceLock::new();
    let mut groups: Vec<(String, String, Vec<String>)> = Vec::new();
    for author in authors {
        if author.email.trim().is_empty() && author.name.trim().is_empty() {
            continue;
        }
        let id = identity(&author.email, &author.name);
        if let Some((_, _, names)) = groups.iter_mut().find(|(key, _, _)| key == &id) {
            if !names.contains(&author.name) {
                names.push(author.name);
            }
        } else {
            groups.push((id, author.email, vec![author.name]));
        }
    }
    let revision = *cache.revision.lock().unwrap();
    let mut result = HashMap::new();
    // Bound spawned work as well as active provider calls.
    for chunk in groups.chunks(4) {
        let mut tasks = tokio::task::JoinSet::new();
        for (id, email, names) in chunk {
            let (id, email, names) = (id.clone(), email.clone(), names.clone());
            let (cache, scope, cancel, resolver) = (
                cache.clone(),
                scope.clone(),
                cancel.clone(),
                resolver.clone(),
            );
            tasks.spawn(async move {
                let key = format!("{scope}\0{id}");
                let lock = cache.request_lock(&key);
                let _guard = tokio::select! { _ = cancel.cancelled() => return Err(cancelled()), lock = lock.lock() => lock };
                if cancel.is_cancelled() { return Err(cancelled()); }
                if let Some(Some(avatar)) = cache.get(&key) { return Ok((id, Some(avatar))); }
                let _permit = tokio::select! { _ = cancel.cancelled() => return Err(cancelled()), permit = PERMITS.get_or_init(|| Semaphore::new(4)).acquire() => permit.unwrap() };
                for name in names {
                    let attempt = format!("{key}\0name:{}", name.trim().to_lowercase());
                    if cache.get(&attempt).is_some() { continue; }
                    let resolved = tokio::select! { _ = cancel.cancelled() => return Err(cancelled()), result = resolver(email.clone(), name) => result };
                    let value = match resolved {
                        Ok(value) => value,
                        Err(error) if error.code == "REQUEST_CANCELLED" => return Err(error),
                        // Like the plugin, a failed author must not discard the
                        // successful results for other authors in this batch.
                        Err(_) => None,
                    };
                    if cancel.is_cancelled() { return Err(cancelled()); }
                    if value.is_some() {
                        cache.put(&key, value.clone(), revision);
                        return Ok((id, value));
                    }
                    cache.put(&attempt, None, revision);
                }
                Ok((id, None))
            });
        }
        while let Some(task) = tasks.join_next().await {
            let (id, value) = task.map_err(|_| {
                DesktopError::new("AVATAR_RESOLUTION_FAILED", "Avatar lookup failed", true)
            })??;
            result.insert(id, value);
        }
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
    }
    if *cache.revision.lock().unwrap() != revision {
        return Ok(HashMap::new());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn author(name: &str) -> AvatarAuthor {
        AvatarAuthor {
            email: "915860729@qq.com".into(),
            name: name.into(),
        }
    }
    #[tokio::test]
    async fn aliases_restart_scope_and_clear_preserve_cache_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AvatarCache::new(dir.path()));
        let result = resolve_batch(
            cache.clone(),
            "private-host".into(),
            vec![author("huguoliang"), author("胡国梁")],
            &CancellationToken::new(),
            |_, name| async move {
                Ok((name == "胡国梁").then(|| "data:image/png;base64,real-avatar".into()))
            },
        )
        .await
        .unwrap();
        assert!(result["email:915860729@qq.com"].is_some());
        let restarted = Arc::new(AvatarCache::new(dir.path()));
        assert_eq!(
            restarted
                .cached("private-host", &[author("huguoliang")])
                .len(),
            1
        );
        assert!(restarted
            .cached("other-host", &[author("胡国梁")])
            .is_empty());
        let result = resolve_batch(
            restarted.clone(),
            "private-host".into(),
            vec![author("huguoliang")],
            &CancellationToken::new(),
            |_, _| async {
                Err(DesktopError::new(
                    "UNEXPECTED_REQUEST",
                    "Cached avatar must avoid provider access",
                    false,
                ))
            },
        )
        .await
        .unwrap();
        assert!(result["email:915860729@qq.com"].is_some());
        restarted.clear().unwrap();
        assert!(cache.cached("private-host", &[author("胡国梁")]).is_empty());
    }
    #[tokio::test]
    async fn batches_limit_concurrency_and_do_not_repopulate_after_clear() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AvatarCache::new(dir.path()));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(tokio::sync::Notify::new());
        let authors = (0..9)
            .map(|n| AvatarAuthor {
                email: format!("user{n}@test"),
                name: "User".into(),
            })
            .collect();
        let task_cache = cache.clone();
        let resolver = {
            let (active, peak, start) = (active.clone(), peak.clone(), start.clone());
            move |_, _| {
                let (active, peak, start) = (active.clone(), peak.clone(), start.clone());
                async move {
                    let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(count, Ordering::SeqCst);
                    start.notify_one();
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(Some("https://example.test/avatar.png".into()))
                }
            }
        };
        let task = tokio::spawn(async move {
            resolve_batch(
                task_cache,
                "scope".into(),
                authors,
                &CancellationToken::new(),
                resolver,
            )
            .await
        });
        start.notified().await;
        cache.clear().unwrap();
        assert!(task.await.unwrap().unwrap().is_empty());
        assert!(peak.load(Ordering::SeqCst) <= 4);
        assert!(!cache.has_entries());
    }
    #[test]
    fn expired_and_oversized_entries_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AvatarCache::new(dir.path());
        std::fs::create_dir_all(&cache.directory).unwrap();
        std::fs::write(
            cache.path("expired"),
            serde_json::to_vec(&Entry {
                value: Some("url".into()),
                timestamp: chrono::Utc::now().timestamp() - POSITIVE_TTL,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(cache.get("expired").is_none());
        std::fs::write(
            cache.path("oversize"),
            vec![0; MAX_ENTRY_BYTES as usize + 1],
        )
        .unwrap();
        assert!(cache.get("oversize").is_none());
    }

    #[tokio::test]
    async fn overlapping_window_batches_share_provider_work() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AvatarCache::new(dir.path()));
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver = {
            let calls = calls.clone();
            move |_, _| {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    Ok(Some("data:image/png;base64,avatar".into()))
                }
            }
        };
        let token = CancellationToken::new();
        let (first, second) = tokio::join!(
            resolve_batch(
                cache.clone(),
                "scope".into(),
                vec![author("胡国梁")],
                &token,
                resolver.clone()
            ),
            resolve_batch(
                cache,
                "scope".into(),
                vec![author("huguoliang")],
                &token,
                resolver
            ),
        );
        assert_eq!(first.unwrap(), second.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_stops_a_batch_without_caching_a_miss() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AvatarCache::new(dir.path()));
        let token = CancellationToken::new();
        let result = resolve_batch(
            cache.clone(),
            "scope".into(),
            vec![author("胡国梁")],
            &token,
            {
                let token = token.clone();
                move |_, _| {
                    let token = token.clone();
                    async move {
                        token.cancel();
                        std::future::pending::<Result<Option<String>, DesktopError>>().await
                    }
                }
            },
        )
        .await;
        assert_eq!(result.unwrap_err().code, "REQUEST_CANCELLED");
        assert!(!cache.has_entries());
    }

    #[tokio::test]
    async fn provider_failure_does_not_discard_other_authors_in_a_batch() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AvatarCache::new(dir.path()));
        let authors = vec![
            AvatarAuthor {
                email: "broken@example.test".into(),
                name: "Broken".into(),
            },
            AvatarAuthor {
                email: "found@example.test".into(),
                name: "Found".into(),
            },
        ];
        let result = resolve_batch(
            cache,
            "scope".into(),
            authors,
            &CancellationToken::new(),
            |email, _| async move {
                if email.starts_with("broken") {
                    Err(DesktopError::new(
                        "PROVIDER_NETWORK_ERROR",
                        "Provider unavailable",
                        true,
                    ))
                } else {
                    Ok(Some("https://example.test/avatar.png".into()))
                }
            },
        )
        .await
        .unwrap();
        assert!(result["email:broken@example.test"].is_none());
        assert!(result["email:found@example.test"].is_some());
    }
}
