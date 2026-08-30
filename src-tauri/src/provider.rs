use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use reqwest::{Client, Method, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::models::{
    DesktopError, GithubDeviceFlow, RemoteNamespace, RemoteProviderAccount, RemoteProviderKind,
    RemoteRepository, RemoteRepositoryPage, RemoteVisibility,
};

const SERVICE: &str = "com.versiondock.desktop.remote-provider";
const GITHUB_HOST: &str = "https://github.com";
const GITHUB_API: &str = "https://api.github.com";

#[derive(Debug, Default, Serialize, Deserialize)]
struct AccountFile {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    accounts: Vec<RemoteProviderAccount>,
}

#[derive(Clone)]
struct PendingFlow {
    device_code: String,
    expires_at: chrono::DateTime<chrono::Utc>,
    interval: u64,
    account_id: Option<String>,
}
static FLOWS: OnceLock<Mutex<HashMap<String, PendingFlow>>> = OnceLock::new();

fn client() -> Result<Client, DesktopError> {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("VersionDock-Desktop/0.1")
        .build()
        .map_err(|error| DesktopError::new("PROVIDER_CLIENT_FAILED", error.to_string(), true))
}

fn accounts_path(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join("remote-providers.json")
}
fn load(config_dir: &Path) -> AccountFile {
    std::fs::read(accounts_path(config_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
fn save(config_dir: &Path, mut value: AccountFile) -> Result<(), DesktopError> {
    value.schema_version = 1;
    std::fs::create_dir_all(config_dir)
        .map_err(|e| DesktopError::new("PROVIDER_STATE_IO_FAILED", e.to_string(), true))?;
    let bytes = serde_json::to_vec_pretty(&value)
        .map_err(|e| DesktopError::new("PROVIDER_STATE_INVALID", e.to_string(), false))?;
    std::fs::write(accounts_path(config_dir), bytes)
        .map_err(|e| DesktopError::new("PROVIDER_STATE_IO_FAILED", e.to_string(), true))
}
fn entry(reference: &str) -> Result<keyring::Entry, DesktopError> {
    keyring::Entry::new(SERVICE, reference)
        .map_err(|e| DesktopError::new("SECURE_STORAGE_FAILED", e.to_string(), true))
}
fn token(account: &RemoteProviderAccount) -> Result<String, DesktopError> {
    entry(&account.secure_storage_ref)?
        .get_password()
        .map_err(|e| DesktopError::new("PROVIDER_AUTH_REQUIRED", e.to_string(), true))
}
fn account(config_dir: &Path, id: &str) -> Result<RemoteProviderAccount, DesktopError> {
    load(config_dir)
        .accounts
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| {
            DesktopError::new(
                "PROVIDER_ACCOUNT_NOT_FOUND",
                "Remote provider account is unavailable",
                true,
            )
        })
}

pub fn github_available() -> bool {
    option_env!("VERSIONDOCK_GITHUB_CLIENT_ID").is_some_and(|value| !value.trim().is_empty())
}
pub fn accounts(config_dir: &Path) -> Vec<RemoteProviderAccount> {
    load(config_dir).accounts
}

async fn checked(response: Response, scope: &str) -> Result<Value, DesktopError> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status.is_success() {
        return if body.trim().is_empty() {
            Ok(Value::Null)
        } else {
            serde_json::from_str(&body).map_err(|_| {
                DesktopError::new(
                    "PROVIDER_RESPONSE_INVALID",
                    format!("{scope} returned invalid JSON"),
                    true,
                )
            })
        };
    }
    let code = match status.as_u16() {
        401 => "PROVIDER_AUTH_REQUIRED",
        403 => "PROVIDER_FORBIDDEN",
        429 => "PROVIDER_RATE_LIMITED",
        _ => "PROVIDER_REQUEST_FAILED",
    };
    let detail = status.canonical_reason().unwrap_or("Request failed");
    Err(DesktopError::new(
        code,
        format!("{scope} request failed ({status}): {detail}"),
        true,
    ))
}

async fn send(
    builder: reqwest::RequestBuilder,
    scope: &str,
    cancel: &CancellationToken,
) -> Result<Value, DesktopError> {
    tokio::select! { _ = cancel.cancelled() => Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)), result = builder.send() => checked(result.map_err(|e| DesktopError::new(if e.is_timeout() { "PROVIDER_TIMEOUT" } else { "PROVIDER_NETWORK_ERROR" }, e.to_string(), true))?, scope).await }
}

pub async fn github_begin(
    account_id: Option<String>,
    cancel: &CancellationToken,
) -> Result<GithubDeviceFlow, DesktopError> {
    let client_id = option_env!("VERSIONDOCK_GITHUB_CLIENT_ID")
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            DesktopError::new(
                "GITHUB_CLIENT_ID_MISSING",
                "GitHub OAuth client ID is not configured",
                false,
            )
        })?;
    let value = send(
        client()?
            .post("https://github.com/login/device/code")
            .header("Accept", "application/json")
            .form(&[("client_id", client_id), ("scope", "repo read:org")]),
        "GitHub",
        cancel,
    )
    .await?;
    let device_code = value["device_code"]
        .as_str()
        .ok_or_else(|| {
            DesktopError::new(
                "PROVIDER_RESPONSE_INVALID",
                "GitHub device code is missing",
                true,
            )
        })?
        .to_string();
    let expires = value["expires_in"].as_u64().unwrap_or(900);
    let interval = value["interval"].as_u64().unwrap_or(5).max(1);
    let flow_id = uuid::Uuid::new_v4().to_string();
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires as i64);
    FLOWS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| {
            DesktopError::new(
                "PROVIDER_STATE_LOCK_FAILED",
                "Unable to start OAuth flow",
                true,
            )
        })?
        .insert(
            flow_id.clone(),
            PendingFlow {
                device_code,
                expires_at,
                interval,
                account_id,
            },
        );
    Ok(GithubDeviceFlow {
        flow_id,
        user_code: value["user_code"].as_str().unwrap_or("").into(),
        verification_uri: value["verification_uri"]
            .as_str()
            .unwrap_or(GITHUB_HOST)
            .into(),
        expires_at: expires_at.to_rfc3339(),
        interval: interval as u32,
    })
}

pub async fn github_complete(
    config_dir: &Path,
    flow_id: &str,
    cancel: &CancellationToken,
) -> Result<RemoteProviderAccount, DesktopError> {
    let client_id = option_env!("VERSIONDOCK_GITHUB_CLIENT_ID").unwrap_or("");
    let mut pending = FLOWS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| {
            DesktopError::new(
                "PROVIDER_STATE_LOCK_FAILED",
                "Unable to continue OAuth flow",
                true,
            )
        })?
        .get(flow_id)
        .cloned()
        .ok_or_else(|| {
            DesktopError::new(
                "GITHUB_DEVICE_FLOW_EXPIRED",
                "GitHub device flow is unavailable",
                true,
            )
        })?;
    loop {
        if chrono::Utc::now() >= pending.expires_at {
            return Err(DesktopError::new(
                "GITHUB_DEVICE_FLOW_EXPIRED",
                "GitHub device flow expired",
                true,
            ));
        }
        tokio::select! { _ = cancel.cancelled() => return Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)), _ = tokio::time::sleep(Duration::from_secs(pending.interval)) => {} }
        let value = send(
            client()?
                .post("https://github.com/login/oauth/access_token")
                .header("Accept", "application/json")
                .form(&[
                    ("client_id", client_id),
                    ("device_code", pending.device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ]),
            "GitHub",
            cancel,
        )
        .await?;
        if let Some(access) = value["access_token"].as_str() {
            let user = send(
                client()?
                    .get(format!("{GITHUB_API}/user"))
                    .bearer_auth(access),
                "GitHub",
                cancel,
            )
            .await?;
            let result = persist_account(
                config_dir,
                pending.account_id.clone(),
                RemoteProviderKind::Github,
                GITHUB_HOST.into(),
                user["login"].as_str().unwrap_or("github").into(),
                user["name"].as_str().map(String::from),
                access,
            )?;
            FLOWS
                .get_or_init(Default::default)
                .lock()
                .ok()
                .map(|mut values| values.remove(flow_id));
            return Ok(result);
        }
        match value["error"].as_str().unwrap_or("") {
            "authorization_pending" => {}
            "slow_down" => pending.interval += 5,
            "access_denied" => {
                return Err(DesktopError::new(
                    "GITHUB_DEVICE_FLOW_DENIED",
                    "GitHub authorization was denied",
                    true,
                ))
            }
            "expired_token" => {
                return Err(DesktopError::new(
                    "GITHUB_DEVICE_FLOW_EXPIRED",
                    "GitHub device flow expired",
                    true,
                ))
            }
            other => {
                return Err(DesktopError::new(
                    "GITHUB_DEVICE_FLOW_FAILED",
                    format!("GitHub authorization failed: {other}"),
                    true,
                ))
            }
        }
    }
}

fn normalize_gitlab_host(value: &str) -> Result<String, DesktopError> {
    let raw = value.trim();
    let raw = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let mut url = url::Url::parse(&raw)
        .map_err(|_| DesktopError::new("INVALID_PROVIDER_HOST", "GitLab host is invalid", false))?;
    let insecure = cfg!(debug_assertions)
        && option_env!("VERSIONDOCK_ALLOW_INSECURE_PROVIDER_HOSTS") == Some("1");
    if url.scheme() != "https" && !(insecure && url.scheme() == "http") {
        return Err(DesktopError::new(
            "INSECURE_PROVIDER_HOST",
            "GitLab host must use HTTPS",
            false,
        ));
    }
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DesktopError::new(
            "INVALID_PROVIDER_HOST",
            "GitLab host cannot contain credentials, query, or fragment",
            false,
        ));
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').into())
}

pub async fn gitlab_save(
    config_dir: &Path,
    account_id: Option<String>,
    host: &str,
    secret: &str,
    cancel: &CancellationToken,
) -> Result<RemoteProviderAccount, DesktopError> {
    if secret.trim().is_empty() {
        return Err(DesktopError::new(
            "PROVIDER_TOKEN_REQUIRED",
            "GitLab token is required",
            false,
        ));
    }
    let host = normalize_gitlab_host(host)?;
    let user = send(
        client()?
            .get(format!("{host}/api/v4/user"))
            .header("PRIVATE-TOKEN", secret.trim()),
        "GitLab",
        cancel,
    )
    .await?;
    persist_account(
        config_dir,
        account_id,
        RemoteProviderKind::Gitlab,
        host,
        user["username"].as_str().unwrap_or("gitlab").into(),
        user["name"].as_str().map(String::from),
        secret.trim(),
    )
}

fn persist_account(
    config_dir: &Path,
    id: Option<String>,
    provider: RemoteProviderKind,
    host: String,
    login: String,
    display_name: Option<String>,
    secret: &str,
) -> Result<RemoteProviderAccount, DesktopError> {
    let mut file = load(config_dir);
    let existing = id
        .as_deref()
        .and_then(|id| file.accounts.iter().find(|a| a.id == id))
        .cloned();
    let account = RemoteProviderAccount {
        id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        provider,
        host,
        login,
        display_name,
        secure_storage_ref: existing
            .as_ref()
            .map(|a| a.secure_storage_ref.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
    };
    entry(&account.secure_storage_ref)?
        .set_password(secret)
        .map_err(|e| DesktopError::new("SECURE_STORAGE_FAILED", e.to_string(), true))?;
    file.accounts.retain(|a| a.id != account.id);
    file.accounts.push(account.clone());
    save(config_dir, file)?;
    Ok(account)
}

pub fn remove(config_dir: &Path, id: &str) -> Result<bool, DesktopError> {
    let mut file = load(config_dir);
    let Some(account) = file.accounts.iter().find(|a| a.id == id).cloned() else {
        return Ok(false);
    };
    let _ = entry(&account.secure_storage_ref)?.delete_credential();
    file.accounts.retain(|a| a.id != id);
    save(config_dir, file)?;
    if let Ok(mut flows) = FLOWS.get_or_init(Default::default).lock() {
        flows.retain(|_, flow| flow.account_id.as_deref() != Some(id));
    }
    Ok(true)
}

fn authenticated(
    builder: reqwest::RequestBuilder,
    account: &RemoteProviderAccount,
    secret: &str,
) -> reqwest::RequestBuilder {
    match account.provider {
        RemoteProviderKind::Github => builder
            .bearer_auth(secret)
            .header("Accept", "application/vnd.github+json"),
        RemoteProviderKind::Gitlab => builder.header("PRIVATE-TOKEN", secret),
    }
}

pub async fn repositories(
    config_dir: &Path,
    id: &str,
    query: Option<String>,
    page: u32,
    per_page: u32,
    cancel: &CancellationToken,
) -> Result<RemoteRepositoryPage, DesktopError> {
    let account = account(config_dir, id)?;
    let secret = token(&account)?;
    let page = page.max(1);
    let per_page = per_page.clamp(1, 100);
    let url = match account.provider { RemoteProviderKind::Github => format!("{GITHUB_API}/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=updated&per_page={per_page}&page={page}"), RemoteProviderKind::Gitlab => format!("{}/api/v4/projects?membership=true&order_by=last_activity_at&sort=desc&per_page={per_page}&page={page}&search={}", account.host, url::form_urlencoded::byte_serialize(query.as_deref().unwrap_or("").as_bytes()).collect::<String>()) };
    let value = send(
        authenticated(client()?.request(Method::GET, url), &account, &secret),
        if account.provider == RemoteProviderKind::Github {
            "GitHub"
        } else {
            "GitLab"
        },
        cancel,
    )
    .await?;
    let needle = query.unwrap_or_default().to_lowercase();
    let values = value.as_array().cloned().unwrap_or_default();
    let items = values
        .iter()
        .filter_map(|item| map_repository(&account, item))
        .filter(|item| {
            needle.is_empty()
                || item.name.to_lowercase().contains(&needle)
                || item.full_name.to_lowercase().contains(&needle)
        })
        .collect::<Vec<_>>();
    Ok(RemoteRepositoryPage {
        items,
        page,
        has_more: values.len() == per_page as usize,
    })
}

fn map_repository(account: &RemoteProviderAccount, item: &Value) -> Option<RemoteRepository> {
    match account.provider {
        RemoteProviderKind::Github => Some(RemoteRepository {
            id: item["id"].as_u64()?.to_string(),
            provider: RemoteProviderKind::Github,
            host: account.host.clone(),
            name: item["name"].as_str()?.into(),
            full_name: item["full_name"].as_str()?.into(),
            clone_url: item["clone_url"].as_str()?.into(),
            web_url: item["html_url"].as_str().map(String::from),
            default_branch: item["default_branch"].as_str().map(String::from),
            namespace: item["owner"]["login"]
                .as_str()
                .map(|login| RemoteNamespace {
                    id: item["owner"]["id"].as_u64().unwrap_or_default().to_string(),
                    name: login.into(),
                    full_path: login.into(),
                    kind: if item["owner"]["type"].as_str() == Some("Organization") {
                        "organization".into()
                    } else {
                        "user".into()
                    },
                    host: account.host.clone(),
                }),
            private: item["private"].as_bool().unwrap_or(false),
        }),
        RemoteProviderKind::Gitlab => Some(RemoteRepository {
            id: item["id"].as_u64()?.to_string(),
            provider: RemoteProviderKind::Gitlab,
            host: account.host.clone(),
            name: item["name"].as_str()?.into(),
            full_name: item["path_with_namespace"].as_str()?.into(),
            clone_url: item["http_url_to_repo"].as_str()?.into(),
            web_url: item["web_url"].as_str().map(String::from),
            default_branch: item["default_branch"].as_str().map(String::from),
            namespace: item.get("namespace").and_then(|ns| {
                Some(RemoteNamespace {
                    id: ns["id"].as_u64()?.to_string(),
                    name: ns["name"].as_str()?.into(),
                    full_path: ns["full_path"].as_str()?.into(),
                    kind: ns["kind"].as_str().unwrap_or("user").into(),
                    host: account.host.clone(),
                })
            }),
            private: item["visibility"].as_str() == Some("private"),
        }),
    }
}

pub async fn namespaces(
    config_dir: &Path,
    id: &str,
    cancel: &CancellationToken,
) -> Result<Vec<RemoteNamespace>, DesktopError> {
    let account = account(config_dir, id)?;
    let secret = token(&account)?;
    let url = if account.provider == RemoteProviderKind::Github {
        format!("{GITHUB_API}/user")
    } else {
        format!("{}/api/v4/namespaces?per_page=100", account.host)
    };
    let value = send(
        authenticated(client()?.get(url), &account, &secret),
        "Provider",
        cancel,
    )
    .await?;
    if account.provider == RemoteProviderKind::Github {
        let mut result = vec![RemoteNamespace {
            id: value["id"].as_u64().unwrap_or_default().to_string(),
            name: value["login"].as_str().unwrap_or("").into(),
            full_path: value["login"].as_str().unwrap_or("").into(),
            kind: "user".into(),
            host: account.host.clone(),
        }];
        let orgs = send(
            authenticated(
                client()?.get(format!("{GITHUB_API}/user/orgs?per_page=100")),
                &account,
                &secret,
            ),
            "GitHub",
            cancel,
        )
        .await?;
        result.extend(orgs.as_array().into_iter().flatten().filter_map(|v| {
            Some(RemoteNamespace {
                id: v["id"].as_u64()?.to_string(),
                name: v["login"].as_str()?.into(),
                full_path: v["login"].as_str()?.into(),
                kind: "organization".into(),
                host: account.host.clone(),
            })
        }));
        Ok(result)
    } else {
        Ok(value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| {
                Some(RemoteNamespace {
                    id: v["id"].as_u64()?.to_string(),
                    name: v["name"].as_str()?.into(),
                    full_path: v["full_path"].as_str()?.into(),
                    kind: v["kind"].as_str().unwrap_or("user").into(),
                    host: account.host.clone(),
                })
            })
            .collect())
    }
}

pub async fn create_repository(
    config_dir: &Path,
    id: &str,
    namespace_id: Option<&str>,
    name: &str,
    description: &str,
    visibility: RemoteVisibility,
    cancel: &CancellationToken,
) -> Result<RemoteRepository, DesktopError> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(DesktopError::new(
            "INVALID_REPOSITORY_NAME",
            "Repository name is invalid",
            false,
        ));
    }
    let account = account(config_dir, id)?;
    let secret = token(&account)?;
    let (url, body) = match account.provider {
        RemoteProviderKind::Github => {
            let private = visibility == RemoteVisibility::Private;
            let endpoint = namespace_id
                .filter(|value| **value != account.login)
                .map(|org| {
                    format!(
                        "{GITHUB_API}/orgs/{}/repos",
                        url::form_urlencoded::byte_serialize(org.as_bytes()).collect::<String>()
                    )
                })
                .unwrap_or_else(|| format!("{GITHUB_API}/user/repos"));
            (
                endpoint,
                json!({"name":name,"description":description,"private":private}),
            )
        }
        RemoteProviderKind::Gitlab => (
            format!("{}/api/v4/projects", account.host),
            json!({"name":name,"description":description,"visibility":match visibility { RemoteVisibility::Private=>"private", RemoteVisibility::Internal=>"internal", RemoteVisibility::Public=>"public" },"namespace_id":namespace_id.and_then(|v| v.parse::<u64>().ok())}),
        ),
    };
    let value = send(
        authenticated(client()?.post(url).json(&body), &account, &secret),
        "Provider",
        cancel,
    )
    .await?;
    map_repository(&account, &value).ok_or_else(|| {
        DesktopError::new(
            "PROVIDER_RESPONSE_INVALID",
            "Created repository response is invalid",
            true,
        )
    })
}

pub fn credentials_for_url(
    config_dir: &Path,
    id: &str,
    url_value: &str,
) -> Result<(String, String), DesktopError> {
    let account = account(config_dir, id)?;
    let parsed = url::Url::parse(url_value)
        .map_err(|_| DesktopError::new("INVALID_CLONE_URL", "Invalid provider clone URL", false))?;
    let host = url::Url::parse(&account.host).map_err(|_| {
        DesktopError::new("INVALID_PROVIDER_HOST", "Provider host is invalid", false)
    })?;
    let base_path = host.path().trim_end_matches('/');
    if parsed.host_str() != host.host_str()
        || (!base_path.is_empty() && !parsed.path().starts_with(&format!("{base_path}/")))
    {
        return Err(DesktopError::new(
            "PROVIDER_HOST_MISMATCH",
            "Clone URL does not match the provider account",
            false,
        ));
    }
    Ok((
        if account.provider == RemoteProviderKind::Github {
            "x-access-token".into()
        } else {
            "oauth2".into()
        },
        token(&account)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn error_for(status: u16) -> DesktopError {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0_u8; 1024];
            let _ = socket.read(&mut bytes).await;
            let reason = if status == 401 {
                "Unauthorized"
            } else {
                "Too Many Requests"
            };
            let body = r#"{"message":"secret-token-value"}"#;
            let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        send(
            client().unwrap().get(format!("http://{address}/test")),
            "Mock",
            &CancellationToken::new(),
        )
        .await
        .unwrap_err()
    }

    #[tokio::test]
    async fn provider_errors_are_stable_and_never_surface_response_secrets() {
        let unauthorized = error_for(401).await;
        assert_eq!(unauthorized.code, "PROVIDER_AUTH_REQUIRED");
        assert!(!unauthorized.message.contains("secret-token-value"));
        assert_eq!(error_for(429).await.code, "PROVIDER_RATE_LIMITED");
    }

    #[test]
    fn provider_host_validation_rejects_credentials_and_insecure_hosts() {
        assert!(normalize_gitlab_host("https://gitlab.example.test/base").is_ok());
        assert!(normalize_gitlab_host("https://user:secret@gitlab.example.test").is_err());
        if option_env!("VERSIONDOCK_ALLOW_INSECURE_PROVIDER_HOSTS") != Some("1") {
            assert!(normalize_gitlab_host("http://gitlab.example.test").is_err());
        }
    }
}
