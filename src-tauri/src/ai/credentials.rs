use super::transport::error;
use crate::credentials::CredentialCache;
use crate::models::DesktopError;
use std::sync::OnceLock;

type KeyResult = Result<String, DesktopError>;

fn cache() -> &'static CredentialCache {
    static CACHE: OnceLock<CredentialCache> = OnceLock::new();
    CACHE.get_or_init(|| CredentialCache::new(storage_error))
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
