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
        SvnAccountOperation, SvnAccountState, SvnCredentialSource, SvnNativeCredential,
    },
};

const SERVICE: &str = "com.versiondock.desktop.svn";
static SESSION_AUTH: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
static AUTH_ROOTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
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
    let version = cli::background_command(cli::resolve_executable("svn"))
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
    if let Ok(mut roots) = AUTH_ROOTS.get_or_init(Default::default).lock() {
        roots.insert(repo.root_path.clone(), root.clone());
    }
    let file = load(config_dir);
    let stored_username = file.usernames.get(&root).cloned();
    let password_stdin_supported = svn_password_stdin_supported(repo, token).await;
    let secure_storage_available = secure_store_capability().await.status.available;
    let password_stored = stored_username
        .as_ref()
        .is_some_and(|value| SYSTEM_STORE.get(&root, value).is_ok());
    let session = cached_auth(repo);
    let native_credentials = match native_credentials(repo, &root, token).await {
        Ok(credentials) => credentials,
        Err(error)
            if error.code != "REQUEST_CANCELLED"
                && (session.is_some() || stored_username.is_some()) =>
        {
            // An optional native-cache failure must not invalidate a known session account.
            crate::logger::log_entry(
                crate::logger::LogLevel::Warn,
                crate::logger::LogChannel::Svn,
                "Could not read the native SVN authentication cache",
                Some(format!("{}: {}", error.code, error.message)),
                None,
                None,
            );
            Vec::new()
        }
        Err(error) => return Err(error),
    };
    let source = if session.is_some() {
        SvnCredentialSource::Session
    } else if password_stored {
        SvnCredentialSource::VersionDockSecureStore
    } else if !native_credentials.is_empty() {
        SvnCredentialSource::NativeCache
    } else {
        SvnCredentialSource::None
    };
    let username = session
        .map(|(username, _)| username)
        .or(stored_username)
        .or_else(|| {
            native_credentials
                .iter()
                .find_map(|item| item.username.clone())
        });
    let repository_url = repository_url(repo, token).await?;
    Ok(SvnAccountState {
        repository_url,
        repository_root: root,
        username,
        password_stored,
        secure_storage_available,
        password_stdin_supported,
        connection_ok: None,
        source,
        native_credentials,
    })
}

pub async fn operate(
    config_dir: &Path,
    repo: &RepositoryMeta,
    operation: SvnAccountOperation,
    token: &CancellationToken,
) -> Result<SvnAccountState, DesktopError> {
    let root = repository_root(repo, token).await?;
    if let Ok(mut roots) = AUTH_ROOTS.get_or_init(Default::default).lock() {
        roots.insert(repo.root_path.clone(), root.clone());
    }
    static WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = WRITE_LOCK.lock().await;
    let mut file = load(config_dir);
    let testing = matches!(operation, SvnAccountOperation::Test);
    match operation {
        SvnAccountOperation::Switch {
            username,
            password,
            remember,
        } => {
            let username = username.trim().to_string();
            if username.is_empty()
                || username.chars().any(char::is_control)
                || password.is_empty()
                || password.contains(['\n', '\r'])
            {
                return Err(DesktopError::new(
                    "INVALID_SVN_USERNAME",
                    "SVN username and password must be valid",
                    true,
                ));
            }
            if !svn_password_stdin_supported(repo, token).await {
                return Err(DesktopError::new(
                    "SVN_PASSWORD_STDIN_UNAVAILABLE",
                    "This SVN client cannot receive passwords through stdin",
                    false,
                ));
            }
            let url = repository_url(repo, token).await?;
            verify_credentials(repo, &url, Some((&username, &password)), remember, token).await?;
            // Replace previous App credentials only after successful network authentication.
            if let Some(previous) = file.usernames.get(&root) {
                let _ = SYSTEM_STORE.delete(&root, previous);
            }
            file.usernames.remove(&root);
            save(config_dir, &file)?;
            if let Ok(mut cache) = SESSION_AUTH.get_or_init(Default::default).lock() {
                cache.insert(root.clone(), (username, password));
            }
        }
        SvnAccountOperation::Save { username, password } => {
            if let Ok(mut cache) = SESSION_AUTH.get_or_init(Default::default).lock() {
                cache.remove(&root);
            }
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
                cache.remove(&root);
            }
            save(config_dir, &file)?;
        }
        SvnAccountOperation::Test => {}
        SvnAccountOperation::ClearNative { credential_id } => {
            if let Ok(mut cache) = SESSION_AUTH.get_or_init(Default::default).lock() {
                cache.remove(&root);
            }
            let credentials = native_credentials(repo, &root, token).await?;
            let credential = credentials
                .into_iter()
                .find(|item| item.id == credential_id)
                .ok_or_else(|| {
                    DesktopError::new(
                        "SVN_NATIVE_CREDENTIAL_NOT_FOUND",
                        "SVN cached credential is no longer available",
                        true,
                    )
                })?;
            let mut args = vec!["auth".into(), "--remove".into(), credential.realm];
            if let Some(username) = credential.username {
                args.push(username);
            }
            cli::run(
                "svn",
                &args,
                Path::new(&repo.root_path),
                None,
                cli::DEFAULT_TIMEOUT,
                token,
            )
            .await?;
        }
    }
    let mut result = state(config_dir, repo, token).await?;
    if testing {
        result.connection_ok = Some(test_connection(config_dir, repo, &result, token).await?);
    }
    Ok(result)
}

async fn native_credentials(
    repo: &RepositoryMeta,
    root: &str,
    token: &CancellationToken,
) -> Result<Vec<SvnNativeCredential>, DesktopError> {
    let output = cli::run_with_env(
        "svn",
        &["auth".into()],
        Path::new(&repo.root_path),
        None,
        cli::DEFAULT_TIMEOUT,
        token,
        &[
            ("LANGUAGE".into(), "en".into()),
            ("LC_MESSAGES".into(), "C".into()),
        ],
    )
    .await?
    .stdout_text();
    parse_auth_cache_output(&output, root)
}

fn parse_auth_cache_output(
    output: &str,
    root: &str,
) -> Result<Vec<SvnNativeCredential>, DesktopError> {
    let text = output.trim();
    if !text.is_empty()
        && !output.contains("Authentication realm:")
        && !(text.starts_with("Credentials cache") && text.ends_with("is empty"))
    {
        return Err(DesktopError::new(
            "SVN_AUTH_CACHE_OUTPUT_INVALID",
            "Could not parse SVN authentication cache",
            true,
        ));
    }
    Ok(parse_native_credentials(output, root))
}

fn parse_native_credentials(output: &str, root: &str) -> Vec<SvnNativeCredential> {
    let root_url = url::Url::parse(root).ok();
    let root_port = root_url.as_ref().and_then(url::Url::port_or_known_default);
    let host = url::Url::parse(root)
        .ok()
        .and_then(|url| url.host_str().map(String::from))
        .unwrap_or_default();
    let mut values = Vec::new();
    let normalized = output.replace("\r\n", "\n");
    for record in normalized.split("\n\n") {
        let field = |name: &str| {
            record
                .lines()
                .find_map(|line| line.trim().strip_prefix(name).map(str::trim))
        };
        let Some(realm) = field("Authentication realm:") else {
            continue;
        };
        let realm_url = realm
            .strip_prefix('<')
            .and_then(|value| value.split('>').next())
            .and_then(|value| url::Url::parse(value).ok());
        let realm_host = realm_url.as_ref().and_then(|value| value.host_str());
        let realm_port = realm_url.as_ref().and_then(url::Url::port_or_known_default);
        if host.is_empty() || realm_host != Some(host.as_str()) || realm_port != root_port {
            continue;
        }
        let username = field("Username:")
            .filter(|value| !value.is_empty())
            .map(String::from);
        let hash =
            Sha256::digest(format!("{realm}\0{}", username.as_deref().unwrap_or("")).as_bytes());
        values.push(SvnNativeCredential {
            id: hex::encode(&hash[..12]),
            realm: realm.into(),
            username,
        });
    }
    values
}

pub async fn auth(
    config_dir: &Path,
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Option<(String, String)>, DesktopError> {
    if let Some(credentials) = cached_auth(repo) {
        return Ok(Some(credentials));
    }
    // Repository operations let SVN use its native cache directly. Inspecting
    // that cache is only needed for the account UI, not for authentication.
    let root = repository_root(repo, token).await?;
    if let Ok(mut roots) = AUTH_ROOTS.get_or_init(Default::default).lock() {
        roots.insert(repo.root_path.clone(), root.clone());
    }
    let Some(username) = load(config_dir).usernames.remove(&root) else {
        return Ok(None);
    };
    if !svn_password_stdin_supported(repo, token).await {
        return Ok(None);
    }
    let Ok(password) = SYSTEM_STORE.get(&root, &username) else {
        return Ok(None);
    };
    Ok(Some((username, password)))
}

pub async fn hydrate(config_dir: &Path, repo: &RepositoryMeta, token: &CancellationToken) {
    if let Ok(Some(credentials)) = auth(config_dir, repo, token).await {
        if let Ok(mut cache) = SESSION_AUTH.get_or_init(Default::default).lock() {
            let root = AUTH_ROOTS
                .get_or_init(Default::default)
                .lock()
                .ok()
                .and_then(|roots| roots.get(&repo.root_path).cloned())
                .unwrap_or_else(|| repo.root_path.clone());
            cache.entry(root).or_insert(credentials);
        }
    }
}

static PROMPT_LOCKS: OnceLock<Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();
static PROMPT_FAILURES: OnceLock<Mutex<HashMap<String, std::time::Instant>>> = OnceLock::new();
fn auth_root(repo: &RepositoryMeta) -> String {
    AUTH_ROOTS
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|roots| roots.get(&repo.root_path).cloned())
        .unwrap_or_else(|| repo.root_path.clone())
}

pub(crate) async fn authentication_retry(
    repo: &RepositoryMeta,
    previous: Option<(String, String)>,
    error: &DesktopError,
    token: &CancellationToken,
) -> Result<Option<(String, String)>, DesktopError> {
    if !crate::interactions::available() {
        return Ok(None);
    }
    let root = auth_root(repo);
    let lock = PROMPT_LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| {
            DesktopError::new("SVN_AUTH_FAILED", "Authentication state unavailable", true)
        })?
        .entry(root.clone())
        .or_default()
        .clone();
    crate::state::emit_current_operation(
        crate::models::OperationStatus::Running,
        "awaitingAuthentication",
        "Waiting for SVN authentication",
    );
    let _guard = tokio::select! { _ = token.cancelled() => return Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)), guard = lock.lock() => guard };
    let cached = cached_auth(repo);
    if cached.is_some() && cached != previous {
        crate::state::emit_current_operation(
            crate::models::OperationStatus::Running,
            "retryingAuthentication",
            "Retrying after SVN authentication",
        );
        return Ok(cached);
    }
    if PROMPT_FAILURES
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|times| times.get(&root).copied())
        .is_some_and(|time| time.elapsed().as_secs() < 30)
    {
        return Ok(None);
    }
    let response = crate::interactions::ask(
        repo,
        crate::interactions::InteractionKind::SvnAuthentication,
        &root,
        None,
        None,
        false,
        token,
    )
    .await?;
    let Some(response) = response else {
        return Err(error.clone());
    };
    if response.choice != "authenticate" {
        return Err(DesktopError::new(
            "REQUEST_CANCELLED",
            "SVN authentication cancelled",
            true,
        ));
    }
    let (Some(username), Some(password)) = (response.username, response.password) else {
        return Err(error.clone());
    };
    if username.trim().is_empty()
        || username.contains(['\n', '\r', '\0'])
        || password.contains(['\n', '\r', '\0'])
    {
        return Err(DesktopError::new(
            "SVN_AUTH_FAILED",
            "Invalid SVN credentials",
            true,
        ));
    }
    if !svn_password_stdin_available() {
        return Err(DesktopError::new(
            "SVN_PASSWORD_STDIN_UNAVAILABLE",
            "This SVN client does not support secure password input",
            false,
        ));
    }
    AUTH_ROOTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| error.clone())?
        .insert(repo.root_path.clone(), root.clone());
    let credentials = (username.trim().to_owned(), password);
    SESSION_AUTH
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| error.clone())?
        .insert(root, credentials.clone());
    crate::state::emit_current_operation(
        crate::models::OperationStatus::Running,
        "retryingAuthentication",
        "Retrying after SVN authentication",
    );
    Ok(Some(credentials))
}

pub(crate) fn remember_auth_failure(repo: &RepositoryMeta) {
    if let Ok(mut times) = PROMPT_FAILURES.get_or_init(Default::default).lock() {
        times.insert(auth_root(repo), std::time::Instant::now());
    }
}

pub fn cached_auth(repo: &RepositoryMeta) -> Option<(String, String)> {
    let root = AUTH_ROOTS
        .get_or_init(Default::default)
        .lock()
        .ok()?
        .get(&repo.root_path)
        .cloned()?;
    SESSION_AUTH
        .get_or_init(Default::default)
        .lock()
        .ok()?
        .get(&root)
        .cloned()
}

async fn test_connection(
    config_dir: &Path,
    repo: &RepositoryMeta,
    account: &SvnAccountState,
    token: &CancellationToken,
) -> Result<bool, DesktopError> {
    let credentials = auth(config_dir, repo, token).await?;
    verify_credentials(
        repo,
        &account.repository_url,
        credentials.as_ref().map(|(u, p)| (u.as_str(), p.as_str())),
        false,
        token,
    )
    .await?;
    Ok(true)
}

async fn verify_credentials(
    repo: &RepositoryMeta,
    url: &str,
    credentials: Option<(&str, &str)>,
    remember: bool,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    // Query the URL: working-copy `svn info` does not authenticate remotely.
    let mut args = vec!["info".into(), "--non-interactive".into()];
    if !remember {
        args.push("--no-auth-cache".into());
    }
    let input = credentials.map(|(username, password)| {
        args.extend([
            "--username".into(),
            username.into(),
            "--password-from-stdin".into(),
        ]);
        // SVN reads through its native EOL or EOF. An LF alone on Windows is
        // retained as part of the password; close stdin with the exact bytes.
        password.as_bytes()
    });
    args.push(url.into());
    cli::run(
        "svn",
        &args,
        Path::new(&repo.root_path),
        input,
        cli::NETWORK_TIMEOUT,
        token,
    )
    .await?;
    Ok(())
}

async fn repository_url(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    Ok(cli::run(
        "svn",
        &["info".into(), "--show-item".into(), "url".into()],
        Path::new(&repo.root_path),
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await?
    .stdout_text()
    .trim()
    .to_string())
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

    #[test]
    fn native_cache_parser_scopes_realms_without_reading_passwords() {
        let output = "Credential kind: svn.simple\nAuthentication realm: <https://svn.example.test:443> Project\nUsername: alice\nPassword: secret\n\nCredential kind: svn.simple\nAuthentication realm: <https://other.test> Other\nUsername: bob\n";
        let values = parse_native_credentials(output, "https://svn.example.test/repo");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].username.as_deref(), Some("alice"));
        assert!(!format!("{values:?}").contains("secret"));
    }

    #[test]
    fn native_cache_parser_handles_windows_line_endings_and_multiple_realms() {
        let output = "Authentication realm: <https://other.test> Other\r\nUsername: wrong\r\n\r\nAuthentication realm: <https://svn.example.test:443> Project\r\nUsername: alice\r\nPassword: secret\r\n\r\nAuthentication realm: <https://svn.example.test:8443> Other port\r\nUsername: bob\r\n";
        let values = parse_native_credentials(output, "https://svn.example.test/repo");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].username.as_deref(), Some("alice"));
        assert!(!format!("{values:?}").contains("secret"));
        let lf = parse_native_credentials(
            &output.replace("\r\n", "\n"),
            "https://svn.example.test/repo",
        );
        assert_eq!(lf[0].id, values[0].id);
    }

    #[test]
    fn native_cache_read_distinguishes_empty_cache_from_unrecognized_output() {
        assert!(parse_auth_cache_output(
            "Credentials cache in 'C:\\Users\\Test\\AppData\\Roaming\\Subversion' is empty\r\n",
            "https://svn.example.test/repo"
        )
        .unwrap()
        .is_empty());
        assert!(parse_auth_cache_output("", "https://svn.example.test/repo")
            .unwrap()
            .is_empty());
        assert_eq!(
            parse_auth_cache_output(
                "认证域: <https://svn.example.test>\r\n用户名: alice",
                "https://svn.example.test/repo"
            )
            .unwrap_err()
            .code,
            "SVN_AUTH_CACHE_OUTPUT_INVALID"
        );
    }
    #[tokio::test]
    async fn session_switch_verifies_remote_authentication_and_preserves_working_copy() {
        use crate::models::VcsKind;
        use std::process::{Child, Command, Stdio};
        use tempfile::tempdir;
        if Command::new("svnserve").arg("--version").output().is_err() {
            return;
        }
        struct Server(Child);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let directory = tempdir().unwrap();
        let config = tempdir().unwrap();
        let repository = directory.path().join("repository");
        assert!(Command::new("svnadmin")
            .args(["create"])
            .arg(&repository)
            .status()
            .unwrap()
            .success());
        let realm = format!("VersionDock-Identity-QA-{}", uuid::Uuid::new_v4());
        std::fs::write(repository.join("conf/svnserve.conf"), format!("[general]\nanon-access = read\nauth-access = write\npassword-db = passwd\nrealm = {realm}\n")).unwrap();
        std::fs::write(
            repository.join("conf/passwd"),
            "[users]\nalice = qa-alice\nbob = qa-bob\n",
        )
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let _server = Server(
            Command::new("svnserve")
                .args([
                    "--daemon",
                    "--foreground",
                    "--listen-host",
                    "127.0.0.1",
                    "--listen-port",
                    &port.to_string(),
                    "--root",
                ])
                .arg(directory.path())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        for _ in 0..50 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let url = format!("svn://127.0.0.1:{port}/repository");
        let wc = directory.path().join("wc");
        assert!(Command::new("svn")
            .args(["checkout", "--non-interactive", "--no-auth-cache", &url])
            .arg(&wc)
            .output()
            .unwrap()
            .status
            .success());
        // Disable anonymous access after obtaining the working copy; local info still succeeds.
        std::fs::write(repository.join("conf/svnserve.conf"), format!("[general]\nanon-access = none\nauth-access = write\npassword-db = passwd\nrealm = {realm}\n")).unwrap();
        std::fs::write(wc.join("keep.txt"), "local change\n").unwrap();
        let repo = RepositoryMeta {
            id: "svn-qa".into(),
            name: "svn-qa".into(),
            root_path: wc.to_string_lossy().into_owned(),
            kind: VcsKind::Svn,
            color: "#888".into(),
            depth: 0,
            parent_repo_id: None,
            is_submodule: false,
            is_worktree: false,
        };
        let token = CancellationToken::new();
        assert!(
            operate(config.path(), &repo, SvnAccountOperation::Test, &token)
                .await
                .is_err()
        );
        assert!(operate(
            config.path(),
            &repo,
            SvnAccountOperation::Switch {
                username: "alice".into(),
                password: "wrong".into(),
                remember: false
            },
            &token
        )
        .await
        .is_err());
        assert!(!config.path().join("svn-accounts.json").exists());
        let value = operate(
            config.path(),
            &repo,
            SvnAccountOperation::Switch {
                username: "alice".into(),
                password: "qa-alice".into(),
                remember: false,
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(value.username.as_deref(), Some("alice"));
        assert_eq!(value.source, SvnCredentialSource::Session);
        assert_eq!(cached_auth(&repo).unwrap().0, "alice");
        assert!(
            operate(config.path(), &repo, SvnAccountOperation::Test, &token)
                .await
                .unwrap()
                .connection_ok
                .unwrap()
        );
        // A failed switch leaves the working session intact.
        assert!(operate(
            config.path(),
            &repo,
            SvnAccountOperation::Switch {
                username: "bob".into(),
                password: "wrong".into(),
                remember: false
            },
            &token
        )
        .await
        .is_err());
        assert_eq!(cached_auth(&repo).unwrap().0, "alice");
        let file = std::fs::read_to_string(config.path().join("svn-accounts.json")).unwrap();
        assert!(!file.contains("alice"));
        assert!(!file.contains("qa-alice"));
        assert!(!file.contains("qa-bob"));
        operate(config.path(), &repo, SvnAccountOperation::Delete, &token)
            .await
            .unwrap();
        assert!(cached_auth(&repo).is_none());
        assert!(
            operate(config.path(), &repo, SvnAccountOperation::Test, &token)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(wc.join("keep.txt")).unwrap(),
            "local change\n"
        );
        AUTH_ROOTS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .remove(&repo.root_path);
    }

    #[test]
    fn native_cache_matching_rejects_host_substrings_and_other_ports() {
        let output = "Authentication realm: <https://svn.example.test.attacker.test:443> Wrong\nUsername: eve\n\nAuthentication realm: <https://svn.example.test:8443> Other\nUsername: bob\n\nAuthentication realm: <https://svn.example.test:443> Right\nUsername: alice\n";
        let values = parse_native_credentials(output, "https://svn.example.test/repo");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].username.as_deref(), Some("alice"));
        assert!(parse_native_credentials(output, "file:///tmp/repo").is_empty());
    }
}
