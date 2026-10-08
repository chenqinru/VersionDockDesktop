use crate::models::DesktopError;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

type KeyResult = Result<String, DesktopError>;
#[derive(Default)]
struct CredentialSlot {
    value: Arc<tokio::sync::Mutex<Option<KeyResult>>>,
    revision: AtomicU64,
}

// A process-local cache shared by all windows. Callers keep separate instances
// for each secure-storage service; secrets never leave the native backend.
pub(crate) struct CredentialCache {
    entries: Mutex<HashMap<String, Arc<CredentialSlot>>>,
    storage_error: fn() -> DesktopError,
}

impl CredentialCache {
    pub(crate) fn new(storage_error: fn() -> DesktopError) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            storage_error,
        }
    }

    fn entry(&self, reference: &str) -> Result<Arc<CredentialSlot>, DesktopError> {
        let mut entries = self.entries.lock().map_err(|_| (self.storage_error)())?;
        Ok(entries.entry(reference.into()).or_default().clone())
    }

    pub(crate) async fn read_with<F>(&self, reference: &str, refresh: bool, read: F) -> KeyResult
    where
        F: FnOnce() -> KeyResult + Send + 'static,
    {
        self.read(reference, refresh, false, read).await
    }

    // Explicitly retry a denied/missing credential without reauthorizing a key
    // that another window has already read or saved successfully.
    pub(crate) async fn retry_failed_with<F>(&self, reference: &str, read: F) -> KeyResult
    where
        F: FnOnce() -> KeyResult + Send + 'static,
    {
        self.read(reference, true, true, read).await
    }

    async fn read<F>(&self, reference: &str, refresh: bool, only_failed: bool, read: F) -> KeyResult
    where
        F: FnOnce() -> KeyResult + Send + 'static,
    {
        let entry = self.entry(reference)?;
        let observed = entry.revision.load(Ordering::Acquire);
        let mut cached = entry.value.clone().lock_owned().await;
        if let Some(result) = &*cached {
            if !refresh
                || (only_failed && result.is_ok())
                || entry.revision.load(Ordering::Acquire) != observed
            {
                return result.clone();
            }
        }
        // The blocking worker owns the lock even if its caller is cancelled.
        // Queued retries share the authorization that completes while waiting.
        tokio::task::spawn_blocking(move || {
            let result = read();
            *cached = Some(result.clone());
            entry.revision.fetch_add(1, Ordering::Release);
            result
        })
        .await
        .unwrap_or_else(|_| Err((self.storage_error)()))
    }

    pub(crate) async fn write_with<F>(
        &self,
        reference: &str,
        value: String,
        write: F,
    ) -> Result<(), DesktopError>
    where
        F: FnOnce() -> Result<(), DesktopError> + Send + 'static,
    {
        self.update_with(reference, Ok(value), write).await
    }

    pub(crate) async fn remove_with<F>(
        &self,
        reference: &str,
        missing: DesktopError,
        remove: F,
    ) -> Result<(), DesktopError>
    where
        F: FnOnce() -> Result<(), DesktopError> + Send + 'static,
    {
        // Keep a tombstone so queued reads cannot reload a deleted credential.
        self.update_with(reference, Err(missing), remove).await
    }

    async fn update_with<F>(
        &self,
        reference: &str,
        value: KeyResult,
        write: F,
    ) -> Result<(), DesktopError>
    where
        F: FnOnce() -> Result<(), DesktopError> + Send + 'static,
    {
        let entry = self.entry(reference)?;
        let mut cached = entry.value.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            write()?;
            // Publish only after persistence succeeds, atomically with reads.
            *cached = Some(value);
            entry.revision.fetch_add(1, Ordering::Release);
            Ok(())
        })
        .await
        .map_err(|_| (self.storage_error)())?
    }
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
