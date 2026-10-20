//! Disposable, process-local caches for immutable checkpoint metadata.
use super::{storage::*, summarize, types::*};
use crate::models::DesktopError;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

pub(super) const OBJECT_LOCK: &str = "checkpoint-object-readers-v1";
const MAX_SUMMARIES: usize = 256;
type Key = (PathBuf, String, String);
static SUMMARIES: OnceLock<Mutex<HashMap<Key, CheckpointSummary>>> = OnceLock::new();

pub(super) fn summary(
    store: &Storage,
    point: &Checkpoint,
) -> Result<CheckpointSummary, DesktopError> {
    let key = (
        store.root.clone(),
        point.before.clone(),
        point
            .after
            .clone()
            .ok_or_else(|| failure("Recording is incomplete"))?,
    );
    let cache = SUMMARIES.get_or_init(Default::default);
    if let Some(value) = cache.lock().map_err(io)?.get(&key).cloned() {
        return Ok(value);
    }
    // Never keep the cache mutex while reading large manifests. The source
    // snapshot pair, rather than the record name/status, determines validity.
    let value = summarize(store, point)?;
    let mut cache = cache.lock().map_err(io)?;
    // Keep the bound without flushing already-warm entries during a large listing.
    if cache.len() < MAX_SUMMARIES {
        cache.insert(key, value.clone());
    }
    Ok(value)
}

/// Debug diagnostics contain timings only, never file contents or user messages.
pub(super) struct ReadTiming {
    action: Option<&'static str>,
    start: std::time::Instant,
    locked: Option<std::time::Instant>,
    loaded: Option<std::time::Instant>,
}
impl ReadTiming {
    pub fn new(action: &CheckpointAction) -> Self {
        Self {
            action: match action {
                CheckpointAction::List => Some("list"),
                CheckpointAction::Overview => Some("overview"),
                CheckpointAction::History { .. } => Some("history"),
                CheckpointAction::StorageUsage { .. } => Some("storage"),
                CheckpointAction::Activity => Some("activity"),
                CheckpointAction::Detail { .. } => Some("detail"),
                CheckpointAction::Diff { .. } => Some("diff"),
                CheckpointAction::Prompt { .. } => Some("prompt"),
                CheckpointAction::Messages { .. } => Some("messages"),
                _ => None,
            },
            start: std::time::Instant::now(),
            locked: None,
            loaded: None,
        }
    }
    pub fn locked(&mut self) {
        self.locked = Some(std::time::Instant::now());
    }
    pub fn loaded(&mut self) {
        self.loaded = Some(std::time::Instant::now());
    }
}
impl Drop for ReadTiming {
    fn drop(&mut self) {
        let Some(action) = self.action else {
            return;
        };
        let end = std::time::Instant::now();
        let locked = self.locked.unwrap_or(end);
        let loaded = self.loaded.unwrap_or(end);
        crate::logger::log_entry(
            crate::logger::LogLevel::Debug,
            crate::logger::LogChannel::Core,
            "Checkpoint history read",
            Some(format!(
                "action={action} object_lock_ms={} metadata_ms={} work_ms={}",
                locked.duration_since(self.start).as_millis(),
                loaded.duration_since(locked).as_millis(),
                end.duration_since(loaded).as_millis()
            )),
            Some(
                end.duration_since(self.start)
                    .as_millis()
                    .min(u32::MAX as u128) as u32,
            ),
            None,
        );
    }
}
