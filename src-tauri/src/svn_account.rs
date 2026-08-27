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
    models::{DesktopError, RepositoryMeta, SvnAccountOperation, SvnAccountState},
};

const SERVICE: &str = "com.versiondock.desktop.svn";
static SESSION_AUTH: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();

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
    let secure_storage_available =
        entry(&root, username.as_deref().unwrap_or("capability-probe")).is_ok();
    let password_stored = username.as_ref().is_some_and(|value| {
        entry(&root, value)
            .and_then(|item| item.get_password())
            .is_ok()
    });
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
                entry(&root, &username)
                    .and_then(|item| item.set_password(&password))
                    .map_err(|error| {
                        DesktopError::new("SECURE_STORAGE_FAILED", error.to_string(), true)
                    })?;
            }
            file.usernames.insert(root.clone(), username);
            save(config_dir, &file)?;
        }
        SvnAccountOperation::Delete => {
            if let Some(username) = file.usernames.remove(&root) {
                if let Ok(item) = entry(&root, &username) {
                    let _ = item.delete_credential();
                }
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
    let password = entry(&value.repository_root, &username)
        .and_then(|item| item.get_password())
        .map_err(|error| DesktopError::new("SECURE_STORAGE_FAILED", error.to_string(), true))?;
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
