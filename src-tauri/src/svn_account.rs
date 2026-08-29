use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    cli,
    models::{
        CapabilityStatus, DesktopError, RepositoryMeta, SecureCredentialCapability,
        SvnAccountOperation, SvnAccountState,
    },
};

const SERVICE: &str = "com.versiondock.desktop.svn";
static SESSION_AUTH: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
static SECURE_CAPABILITY: OnceLock<SecureCredentialCapability> = OnceLock::new();

trait CredentialStore: Send + Sync {
    fn get(&self, root: &str, username: &str) -> Result<String, String>;
    fn set(&self, root: &str, username: &str, password: &str) -> Result<(), String>;
    fn delete(&self, root: &str, username: &str) -> Result<(), String>;
}

struct SystemCredentialStore;

impl CredentialStore for SystemCredentialStore {
    fn get(&self, root: &str, username: &str) -> Result<String, String> {
        entry(root, username)
            .and_then(|item| item.get_password())
            .map_err(|error| error.to_string())
    }

    fn set(&self, root: &str, username: &str, password: &str) -> Result<(), String> {
        entry(root, username)
            .and_then(|item| item.set_password(password))
            .map_err(|error| error.to_string())
    }

    fn delete(&self, root: &str, username: &str) -> Result<(), String> {
        entry(root, username)
            .and_then(|item| item.delete_credential())
            .map_err(|error| error.to_string())
    }
}

static SYSTEM_STORE: SystemCredentialStore = SystemCredentialStore;

pub async fn secure_store_capability() -> SecureCredentialCapability {
    if let Some(capability) = SECURE_CAPABILITY.get() {
        return capability.clone();
    }
    let probe_account = format!("capability-probe-{}", uuid::Uuid::new_v4());
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(SERVICE, &probe_account)?;
            entry.set_password("versiondock-capability-probe")?;
            let value = entry.get_password()?;
            entry.delete_credential()?;
            if value != "versiondock-capability-probe" {
                return Err(keyring::Error::NoEntry);
            }
            Ok::<(), keyring::Error>(())
        }),
    )
    .await;
    let backend = if cfg!(target_os = "macos") {
        "macos-keychain"
    } else if cfg!(target_os = "windows") {
        "windows-credential-manager"
    } else {
        "linux-secret-service"
    };
    let capability = match result {
        Ok(Ok(Ok(()))) => SecureCredentialCapability {
            status: CapabilityStatus::available(),
            backend: Some(backend.into()),
            password_stdin_supported: svn_password_stdin_available(),
        },
        Ok(Ok(Err(error))) => SecureCredentialCapability {
            status: CapabilityStatus::unavailable("SECURE_STORAGE_UNAVAILABLE", error.to_string()),
            backend: Some(backend.into()),
            password_stdin_supported: svn_password_stdin_available(),
        },
        Ok(Err(error)) => SecureCredentialCapability {
            status: CapabilityStatus::unavailable("SECURE_STORAGE_PROBE_FAILED", error.to_string()),
            backend: Some(backend.into()),
            password_stdin_supported: svn_password_stdin_available(),
        },
        Err(_) => SecureCredentialCapability {
            status: CapabilityStatus::unavailable(
                "SECURE_STORAGE_PROBE_TIMEOUT",
                "Secure storage capability probe timed out",
            ),
            backend: Some(backend.into()),
            password_stdin_supported: svn_password_stdin_available(),
        },
    };
    let _ = SECURE_CAPABILITY.set(capability.clone());
    capability
}

fn svn_password_stdin_available() -> bool {
    let version = std::process::Command::new("svn")
        .args(["--version", "--quiet"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    let mut parts = version
        .trim()
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    matches!((parts.next(), parts.next()), (Some(major), Some(minor)) if major > 1 || (major == 1 && minor >= 10))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AccountFile {
    #[serde(default)]
    usernames: BTreeMap<String, String>,
}

pub async fn state(
    config_dir: &Path,
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<SvnAccountState, DesktopError> {
    let root = repository_root(repo, token).await?;
    let file = load(config_dir);
    let username = file.usernames.get(&root).cloned();
    let password_stdin_supported = svn_password_stdin_supported(repo, token).await;
    let secure_storage_available = secure_store_capability().await.status.available;
    let password_stored = username
        .as_ref()
        .is_some_and(|value| SYSTEM_STORE.get(&root, value).is_ok());
    Ok(SvnAccountState {
        repository_root: root,
        username,
        password_stored,
        secure_storage_available,
        password_stdin_supported,
        connection_ok: None,
    })
}

pub async fn operate(
    config_dir: &Path,
    repo: &RepositoryMeta,
    operation: SvnAccountOperation,
    token: &CancellationToken,
) -> Result<SvnAccountState, DesktopError> {
    let root = repository_root(repo, token).await?;
    let mut file = load(config_dir);
    let testing = matches!(operation, SvnAccountOperation::Test);
    match operation {
        SvnAccountOperation::Save { username, password } => {
            let username = username.trim().to_string();
            if username.is_empty() || username.chars().any(char::is_control) {
                return Err(DesktopError::new(
                    "INVALID_SVN_USERNAME",
                    "SVN username is invalid",
                    true,
                ));
            }
            if let Some(password) = password {
                if !svn_password_stdin_supported(repo, token).await {
                    return Err(DesktopError::new(
                        "SVN_PASSWORD_STDIN_UNAVAILABLE",
                        "This SVN client cannot receive passwords through stdin",
                        false,
                    )
                    .hint("Use the system SVN credential cache instead"));
                }
                SYSTEM_STORE
                    .set(&root, &username, &password)
                    .map_err(|error| DesktopError::new("SECURE_STORAGE_FAILED", error, true))?;
            }
            file.usernames.insert(root.clone(), username);
            save(config_dir, &file)?;
        }
        SvnAccountOperation::Delete => {
            if let Some(username) = file.usernames.remove(&root) {
                let _ = SYSTEM_STORE.delete(&root, &username);
            }
            if let Ok(mut cache) = SESSION_AUTH.get_or_init(Default::default).lock() {
                cache.remove(&repo.root_path);
            }
            save(config_dir, &file)?;
        }
        SvnAccountOperation::Test => {}
    }
    let mut result = state(config_dir, repo, token).await?;
    if testing {
        result.connection_ok = Some(test_connection(config_dir, repo, &result, token).await?);
    }
    Ok(result)
}

pub async fn auth(
    config_dir: &Path,
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Option<(String, String)>, DesktopError> {
    let value = state(config_dir, repo, token).await?;
    let (Some(username), true) = (value.username, value.password_stdin_supported) else {
        return Ok(None);
    };
    let password = SYSTEM_STORE
        .get(&value.repository_root, &username)
        .map_err(|error| DesktopError::new("SECURE_STORAGE_FAILED", error, true))?;
    Ok(Some((username, password)))
}

pub async fn hydrate(config_dir: &Path, repo: &RepositoryMeta, token: &CancellationToken) {
    if let Ok(Some(credentials)) = auth(config_dir, repo, token).await {
        if let Ok(mut cache) = SESSION_AUTH.get_or_init(Default::default).lock() {
            cache.insert(repo.root_path.clone(), credentials);
        }
    }
}

pub fn cached_auth(repo: &RepositoryMeta) -> Option<(String, String)> {
    SESSION_AUTH
        .get_or_init(Default::default)
        .lock()
        .ok()?
        .get(&repo.root_path)
        .cloned()
}

async fn test_connection(
    config_dir: &Path,
    repo: &RepositoryMeta,
    account: &SvnAccountState,
    token: &CancellationToken,
) -> Result<bool, DesktopError> {
    let Some(username) = &account.username else {
        return Ok(cli::run(
            "svn",
            &["info".into(), "--non-interactive".into()],
            Path::new(&repo.root_path),
            None,
            cli::NETWORK_TIMEOUT,
            token,
        )
        .await
        .is_ok());
    };
    if let Some((_, password)) = auth(config_dir, repo, token).await? {
        cli::run(
            "svn",
            &[
                "--username".into(),
                username.clone(),
                "--password-from-stdin".into(),
                "--no-auth-cache".into(),
                "--non-interactive".into(),
                "info".into(),
            ],
            Path::new(&repo.root_path),
            Some(format!("{password}\n").as_bytes()),
            cli::NETWORK_TIMEOUT,
            token,
        )
        .await?;
        Ok(true)
    } else {
        Ok(cli::run(
            "svn",
            &[
                "--username".into(),
                username.clone(),
                "--non-interactive".into(),
                "info".into(),
            ],
            Path::new(&repo.root_path),
            None,
            cli::NETWORK_TIMEOUT,
            token,
        )
        .await
        .is_ok())
    }
}

async fn repository_root(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    Ok(cli::run(
        "svn",
        &["info".into(), "--show-item".into(), "repos-root-url".into()],
        Path::new(&repo.root_path),
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await?
    .stdout_text()
    .trim()
    .trim_end_matches('/')
    .to_string())
}

async fn svn_password_stdin_supported(repo: &RepositoryMeta, token: &CancellationToken) -> bool {
    let version = cli::run(
        "svn",
        &["--version".into(), "--quiet".into()],
        Path::new(&repo.root_path),
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
    .ok()
    .map(|value| value.stdout_text())
    .unwrap_or_default();
    let mut parts = version
        .trim()
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    matches!((parts.next(), parts.next()), (Some(major), Some(minor)) if major > 1 || (major == 1 && minor >= 10))
}

fn account_key(root: &str, username: &str) -> String {
    hex::encode(Sha256::digest(format!("{root}\0{username}").as_bytes()))
}

fn entry(root: &str, username: &str) -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(SERVICE, &account_key(root, username))
}

fn load(config_dir: &Path) -> AccountFile {
    std::fs::read(config_dir.join("svn-accounts.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(config_dir: &Path, value: &AccountFile) -> Result<(), DesktopError> {
    std::fs::create_dir_all(config_dir)
        .map_err(|error| DesktopError::new("SVN_ACCOUNT_IO_FAILED", error.to_string(), true))?;
    let target = config_dir.join("svn-accounts.json");
    let temporary = config_dir.join("svn-accounts.json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        DesktopError::new("SVN_ACCOUNT_SERIALIZE_FAILED", error.to_string(), true)
    })?;
    std::fs::write(&temporary, bytes)
        .map_err(|error| DesktopError::new("SVN_ACCOUNT_IO_FAILED", error.to_string(), true))?;
    std::fs::rename(temporary, target)
        .map_err(|error| DesktopError::new("SVN_ACCOUNT_IO_FAILED", error.to_string(), true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MemoryCredentialStore(Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryCredentialStore {
        fn get(&self, root: &str, username: &str) -> Result<String, String> {
            self.0
                .lock()
                .map_err(|_| "credential store lock failed".to_string())?
                .get(&account_key(root, username))
                .cloned()
                .ok_or_else(|| "credential not found".to_string())
        }

        fn set(&self, root: &str, username: &str, password: &str) -> Result<(), String> {
            self.0
                .lock()
                .map_err(|_| "credential store lock failed".to_string())?
                .insert(account_key(root, username), password.to_string());
            Ok(())
        }

        fn delete(&self, root: &str, username: &str) -> Result<(), String> {
            self.0
                .lock()
                .map_err(|_| "credential store lock failed".to_string())?
                .remove(&account_key(root, username));
            Ok(())
        }
    }

    #[test]
    fn memory_store_supports_write_read_and_delete_without_system_credentials() {
        let store = MemoryCredentialStore::default();
        store
            .set("https://svn.example.test/repo", "alice", "secret")
            .unwrap();
        assert_eq!(
            store.get("https://svn.example.test/repo", "alice").unwrap(),
            "secret"
        );
        store
            .delete("https://svn.example.test/repo", "alice")
            .unwrap();
        assert!(store.get("https://svn.example.test/repo", "alice").is_err());
    }
}
