use super::transport::error;
use crate::models::DesktopError;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

type KeyResult = Result<String, DesktopError>;
#[derive(Default)]
struct CredentialSlot {
    value: Arc<tokio::sync::Mutex<Option<KeyResult>>>,
    revision: AtomicU64,
}
type CachedKey = Arc<CredentialSlot>;

// Shared by all windows in this process. Secrets never leave the native backend.
#[derive(Default)]
pub(super) struct CredentialCache {
    entries: Mutex<HashMap<String, CachedKey>>,
}

impl CredentialCache {
    fn entry(&self, reference: &str) -> Result<CachedKey, DesktopError> {
        let mut entries = self.entries.lock().map_err(|_| storage_error())?;
        Ok(entries.entry(reference.into()).or_default().clone())
    }

    async fn read_with<F>(&self, reference: &str, refresh: bool, read: F) -> KeyResult
    where
        F: FnOnce() -> KeyResult + Send + 'static,
    {
        let entry = self.entry(reference)?;
        let observed = entry.revision.load(Ordering::Acquire);
        let mut cached = entry.value.clone().lock_owned().await;
        if !refresh || entry.revision.load(Ordering::Acquire) != observed {
            if let Some(result) = &*cached {
                return result.clone();
            }
        }
        // The blocking worker owns the lock, even if its caller is cancelled.
        // A queued refresh shares any read/write completed while it was waiting.
        tokio::task::spawn_blocking(move || {
            let result = read();
            *cached = Some(result.clone());
            entry.revision.fetch_add(1, Ordering::Release);
            result
        })
        .await
        .unwrap_or_else(|_| Err(storage_error()))
    }

    async fn write_with<F>(
        &self,
        reference: &str,
        value: String,
        write: F,
    ) -> Result<(), DesktopError>
    where
        F: FnOnce() -> Result<(), DesktopError> + Send + 'static,
    {
        let entry = self.entry(reference)?;
        let mut cached = entry.value.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            write()?;
            // Cache changes only after persistence succeeds, atomically with reads.
            *cached = Some(Ok(value));
            entry.revision.fetch_add(1, Ordering::Release);
            Ok(())
        })
        .await
        .map_err(|_| storage_error())?
    }
}

fn cache() -> &'static CredentialCache {
    static CACHE: OnceLock<CredentialCache> = OnceLock::new();
    CACHE.get_or_init(CredentialCache::default)
}

fn storage_error() -> DesktopError {
    error(
        "AI_KEY_ACCESS_FAILED",
        "Unable to read AI API key from system secure storage. Retry access in AI settings.",
    )
}

pub(super) async fn key(config: &super::models::AiConfig, refresh: bool) -> KeyResult {
    super::transport::endpoint(config)?;
    let reference = super::transport::secure_reference(config);
    let account = reference.clone();
    cache()
        .read_with(&reference, refresh, move || {
            let entry = keyring::Entry::new("com.versiondock.desktop.ai", &account)
                .map_err(|_| storage_error())?;
            match entry.get_password() {
                Ok(value) => Ok(value),
                Err(keyring::Error::NoEntry) => Ok(String::new()),
                Err(_) => Err(storage_error()),
            }
        })
        .await
}

pub(super) async fn save_key(
    provider: String,
    api_url: String,
    value: Option<String>,
) -> Result<(), DesktopError> {
    let config = super::models::AiConfig {
        provider,
        api_url,
        ..Default::default()
    }
    .normalize();
    super::transport::endpoint(&config)?;
    let reference = super::transport::secure_reference(&config);
    let account = reference.clone();
    let value = value.unwrap_or_default().trim().to_string();
    let secret = value.clone();
    cache()
        .write_with(&reference, value, move || {
            let entry = keyring::Entry::new("com.versiondock.desktop.ai", &account)
                .map_err(|_| storage_error())?;
            let result = if secret.is_empty() {
                entry.delete_credential()
            } else {
                entry.set_password(&secret)
            };
            match result {
                Ok(()) => Ok(()),
                Err(keyring::Error::NoEntry) if secret.is_empty() => Ok(()),
                Err(_) => Err(error(
                    "SECURE_STORAGE_FAILED",
                    "Unable to update AI API key in system secure storage",
                )),
            }
        })
        .await
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
