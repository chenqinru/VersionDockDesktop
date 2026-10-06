use super::{
    models::{AiConfig, AiRuntime},
    transport::error,
};
use crate::{cli, models::DesktopError};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
use tokio_util::sync::CancellationToken;
static SESSION_DIRECTORY: OnceLock<std::path::PathBuf> = OnceLock::new();
static CONVERSATION_LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct PendingSession {
    executable: String,
    cwd: String,
    id: String,
}
static PENDING_SESSIONS: OnceLock<Mutex<Vec<PendingSession>>> = OnceLock::new();
pub fn initialize(config_dir: &Path) {
    let _ = SESSION_DIRECTORY.set(config_dir.join("ai-sessions"));
}
fn load_session_data<T: serde::de::DeserializeOwned + Default>(name: &str) -> T {
    SESSION_DIRECTORY
        .get()
        .and_then(|dir| std::fs::read(dir.join(name)).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
fn persist<T: serde::Serialize>(name: &str, value: &T) {
    if let Some(dir) = SESSION_DIRECTORY.get() {
        if std::fs::create_dir_all(dir).is_ok() {
            if let Ok(bytes) = serde_json::to_vec(value) {
                let temporary = dir.join(format!("{name}.tmp"));
                if std::fs::write(&temporary, bytes).is_ok() {
                    let _ = std::fs::rename(temporary, dir.join(name));
                }
            }
        }
    }
}
fn pending_sessions() -> &'static Mutex<Vec<PendingSession>> {
    PENDING_SESSIONS.get_or_init(|| Mutex::new(load_session_data("opencode-pending.json")))
}
async fn cleanup_pending() {
    let pending = pending_sessions()
        .lock()
        .ok()
        .map(|v| v.clone())
        .unwrap_or_default();
    for item in pending {
        if cli::run_with_env(
            &item.executable,
            &["session".into(), "delete".into(), item.id.clone()],
            Path::new(&item.cwd),
            None,
            Duration::from_secs(10),
            &CancellationToken::new(),
            &[(
                "PATH".into(),
                cli_path(&item.executable).to_string_lossy().into_owned(),
            )],
        )
        .await
        .is_ok()
        {
            if let Ok(mut values) = pending_sessions().lock() {
                values.retain(|v| v.id != item.id);
                persist("opencode-pending.json", &*values);
            }
        }
    }
}
static CONVERSATIONS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
fn conversations() -> &'static Mutex<HashMap<String, String>> {
    CONVERSATIONS.get_or_init(|| Mutex::new(load_session_data("antigravity.json")))
}
pub fn reset_sessions() {
    if let Ok(mut values) = conversations().lock() {
        values.clear();
        persist("antigravity.json", &*values);
    }
}
fn executable(config: &AiConfig) -> String {
    config
        .cli_executable_paths
        .get(&config.cli_provider)
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| {
            if config.cli_provider == "antigravity" {
                "agy".into()
            } else {
                config.cli_provider.clone()
            }
        })
}
pub async fn runtime(config: &AiConfig) -> AiRuntime {
    if config.cli_provider == "opencode" {
        cleanup_pending().await;
    }
    let executable = resolved_executable(config);
    let token = CancellationToken::new();
    let args: Vec<String> = match config.cli_provider.as_str() {
        "codex" => vec!["exec".into(), "--help".into()],
        "opencode" => vec!["run".into(), "--help".into()],
        _ => vec!["--help".into()],
    };
    let help = cli::run_with_env(
        &executable,
        &args,
        Path::new("."),
        None,
        Duration::from_secs(10),
        &token,
        &[(
            "PATH".into(),
            cli_path(&executable).to_string_lossy().into_owned(),
        )],
    )
    .await;
    let required: &[&str] = match config.cli_provider.as_str() {
        "claude" => &[
            "--print",
            "--no-session-persistence",
            "--permission-mode",
            "--tools",
            "--output-format",
            "--json-schema",
            "--include-partial-messages",
            "--add-dir",
        ],
        "codex" => &["--ephemeral", "--json", "--sandbox", "--output-schema"],
        "antigravity" => &[
            "--input-format",
            "--output-format",
            "--mode",
            "--sandbox",
            "--json-schema",
            "--conversation",
            "--add-dir",
        ],
        "opencode" => &["--format", "--dir", "--agent", "--title"],
        _ => &["unsupported-cli"],
    };
    let found = help.is_ok();
    let mut supported = help.as_ref().is_ok_and(|v| {
        required.iter().all(|option| {
            v.stdout_text().contains(option) || String::from_utf8_lossy(&v.stderr).contains(option)
        })
    });
    if supported && config.cli_provider == "opencode" {
        for (args, required) in [
            (
                vec!["session".into(), "list".into(), "--help".into()],
                vec!["--format", "--max-count"],
            ),
            (vec!["session".into(), "--help".into()], vec!["delete"]),
        ] {
            supported &= cli::run_with_env(
                &executable,
                &args,
                Path::new("."),
                None,
                Duration::from_secs(10),
                &token,
                &[(
                    "PATH".into(),
                    cli_path(&executable).to_string_lossy().into_owned(),
                )],
            )
            .await
            .is_ok_and(|v| {
                required.iter().all(|term| {
                    v.stdout_text().contains(term)
                        || String::from_utf8_lossy(&v.stderr).contains(term)
                })
            });
        }
    }
    let version = if supported && config.cli_provider != "antigravity" {
        cli::run(
            &executable,
            &["--version".into()],
            Path::new("."),
            None,
            Duration::from_secs(10),
            &token,
        )
        .await
        .ok()
        .map(|v| v.stdout_text().trim().to_owned())
    } else {
        None
    };
    AiRuntime {
        configured: supported,
        key_saved: false,
        provider: format!("{}-cli", config.cli_provider),
        available: supported,
        message: if supported {
            "Agent CLI detected. Its own account must be signed in."
        } else if found {
            "Agent CLI lacks required read-only or structured-output options. Update the CLI."
        } else {
            "Agent CLI was not found. Configure its executable path and sign in."
        }
        .into(),
        version,
    }
}
fn resolved_executable(config: &AiConfig) -> String {
    let executable = executable(config);
    if Path::new(&executable).is_absolute() || Path::new(&executable).components().count() > 1 {
        return executable;
    }
    if std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(&executable).is_file()))
    {
        return executable;
    }
    let mut paths: Vec<std::path::PathBuf> =
        vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()];
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        paths.extend([
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".opencode/bin"),
            home.join(".npm-global/bin"),
        ]);
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut nodes: Vec<_> = entries.flatten().map(|e| e.path().join("bin")).collect();
            nodes.sort();
            nodes.reverse();
            paths.extend(nodes);
        }
    }
    paths
        .into_iter()
        .map(|p| p.join(&executable))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(executable)
}
#[cfg(unix)]
struct GroupGuard(i32);
#[cfg(unix)]
impl Drop for GroupGuard {
    fn drop(&mut self) {
        if self.0 > 0 {
            unsafe {
                libc::kill(-self.0, libc::SIGKILL);
            }
        }
    }
}
fn event_text(provider: &str, v: &Value) -> Option<String> {
    let kind = v["type"].as_str().unwrap_or("");
    if kind == "stream_event" {
        return v["event"]["delta"]["text"].as_str().map(str::to_owned);
    }
    if kind == "content_block_delta" {
        return v["delta"]["text"].as_str().map(str::to_owned);
    }
    if provider == "codex" && kind == "item.completed" && v["item"]["type"] == "agent_message" {
        return v["item"]["text"].as_str().map(str::to_owned);
    }
    if provider == "opencode" && kind == "text" {
        return v["part"]["text"].as_str().map(str::to_owned);
    }
    if kind == "assistant" {
        return v["message"]["content"]
            .as_array()
            .map(|p| p.iter().filter_map(|p| p["text"].as_str()).collect());
    }
    None
}
fn final_text(v: &Value) -> Option<String> {
    if v["type"] == "item.completed" && v["item"]["type"] == "agent_message" {
        return v["item"]["text"].as_str().map(str::to_owned);
    }
    let result = if v["event"] == "result" {
        &v["result"]
    } else {
        v
    };
    if let Some(value) = result.get("structured_output").filter(|v| v.is_object()) {
        return Some(value.to_string());
    }
    result["result"]
        .as_str()
        .or(result["response"].as_str())
        .map(str::to_owned)
}
pub async fn generate(
    config: &AiConfig,
    system: &str,
    input: &str,
    roots: &[String],
    schema: Option<&Value>,
    token: &CancellationToken,
    delta: &(dyn Fn(&str) + Send + Sync),
) -> Result<String, DesktopError> {
    let cwd = roots.first().ok_or_else(|| {
        error(
            "AI_CONTEXT_EMPTY",
            "Open a repository before using Agent CLI",
        )
    })?;
    let conversation_lock = if config.cli_provider == "antigravity" {
        let mut locks = CONVERSATION_LOCKS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| error("AI_CLI_FAILED", "Unable to lock CLI conversation"))?;
        Some(
            locks
                .entry(cwd.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone(),
        )
    } else {
        None
    };
    let _conversation_guard = if let Some(lock) = &conversation_lock {
        Some(
            tokio::select! {_ = token.cancelled() => return Err(error("CANCELLED","AI request cancelled")),guard=lock.lock()=>guard},
        )
    } else {
        None
    };
    let runtime = tokio::select! { _ = token.cancelled() => return Err(error("CANCELLED","AI request cancelled")), result = runtime(config) => result };
    if !runtime.available {
        return Err(error("AI_CLI_UNAVAILABLE", runtime.message));
    }
    let executable = resolved_executable(config);
    let provider = config.cli_provider.as_str();
    let resumed_conversation = provider == "antigravity"
        && conversations()
            .lock()
            .ok()
            .is_some_and(|v| v.contains_key(cwd));
    let mut args: Vec<String> = Vec::new();
    let mut env: Vec<(String, String)> = Vec::new();
    let schema_dir = tempfile::tempdir().map_err(|e| error("AI_CLI_TEMP_FAILED", e.to_string()))?;
    let full=format!("{system}\n\nYou are analyzing the supplied evidence only. Do not edit files, run commands, browse, delegate, schedule tasks, or call write tools. Return the requested output and finish.\n\n{input}");
    let session_title = format!("VersionDock:{}", uuid::Uuid::new_v4());
    let stdin = match provider {
        "claude" => {
            args.extend(
                [
                    "--print",
                    "--verbose",
                    "--no-session-persistence",
                    "--permission-mode",
                    "plan",
                    "--tools",
                    "Read,Glob,Grep",
                    "--output-format",
                    "stream-json",
                    "--include-partial-messages",
                ]
                .map(str::to_owned),
            );
            if let Some(schema) = schema {
                args.extend(["--json-schema".into(), schema.to_string()]);
            }
            for root in roots.iter().skip(1) {
                args.extend(["--add-dir".into(), root.clone()]);
            }
            full.clone()
        }
        "codex" => {
            args.extend(
                [
                    "exec",
                    "--ephemeral",
                    "--json",
                    "--sandbox",
                    "read-only",
                    "--skip-git-repo-check",
                    "--cd",
                    cwd,
                ]
                .map(str::to_owned),
            );
            if let Some(schema) = schema {
                let path = schema_dir.path().join("schema.json");
                std::fs::write(&path, schema.to_string())
                    .map_err(|e| error("AI_CLI_TEMP_FAILED", e.to_string()))?;
                args.extend([
                    "--output-schema".into(),
                    path.to_string_lossy().into_owned(),
                ]);
            }
            full.clone()
        }
        "antigravity" => {
            args.extend(
                [
                    "--input-format",
                    "stream-json",
                    "--output-format",
                    "stream-json",
                    "--mode",
                    "plan",
                    "--sandbox",
                ]
                .map(str::to_owned),
            );
            if let Some(schema) = schema {
                args.extend(["--json-schema".into(), schema.to_string()]);
            }
            for root in roots.iter().skip(1) {
                args.extend(["--add-dir".into(), root.clone()]);
            }
            if let Some(id) = conversations()
                .lock()
                .ok()
                .and_then(|v| v.get(cwd).cloned())
            {
                args.extend(["--conversation".into(), id]);
            }
            format!(
                "{}\n",
                json!({"event":"user","message":{"role":"user","content":[{"type":"text","text":full}]}})
            )
        }
        "opencode" => {
            args.extend(
                [
                    "run",
                    "--print-logs",
                    "--log-level",
                    "ERROR",
                    "--format",
                    "json",
                    "--dir",
                    cwd,
                    "--title",
                ]
                .map(str::to_owned),
            );
            args.push(session_title.clone());
            args.extend(["--agent".into(), "versiondock-readonly".into()]);
            let mut existing: Value = std::env::var("OPENCODE_CONFIG_CONTENT")
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| json!({}));
            if !existing.is_object() {
                return Err(error(
                    "AI_CLI_CONFIG_INVALID",
                    "OPENCODE_CONFIG_CONTENT must be an object",
                ));
            }
            if !existing["agent"].is_object() {
                existing["agent"] = json!({});
            }
            existing["agent"]["versiondock-readonly"] = json!({"mode":"primary","permission":{"*":"deny","read":{"*":"allow","*.env":"deny","*.env.*":"deny","*.pem":"deny","*.key":"deny"},"glob":"allow","grep":"allow","list":"allow"}});
            env.push(("OPENCODE_CONFIG_CONTENT".into(), existing.to_string()));
            String::new()
        }
        _ => return Err(error("AI_CLI_INVALID", "Unknown Agent CLI")),
    };
    if !config.cli_model.is_empty() {
        let model = if provider == "opencode" && !config.cli_model.contains('/') {
            format!("opencode/{}", config.cli_model)
        } else {
            config.cli_model.clone()
        };
        args.extend(["--model".into(), model]);
    }
    if provider == "codex" {
        args.push("-".into());
    } else if provider == "opencode" {
        args.push(full);
    }
    let mut command = Command::new(cli::resolve_executable(&executable));
    command
        .args(&args)
        .current_dir(cwd)
        .envs(env)
        .env("PATH", cli_path(&executable))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|_| error("AI_CLI_START_FAILED", "Unable to start Agent CLI"))?;
    #[cfg(unix)]
    let _group = GroupGuard(child.id().unwrap_or_default() as i32);
    if let Some(mut pipe) = child.stdin.take() {
        let data = stdin.into_bytes();
        tokio::spawn(async move {
            let _ = pipe.write_all(&data).await;
        });
    }
    let stderr = child.stderr.take().unwrap();
    let mut stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stderr.take(1024 * 1024).read_to_end(&mut bytes).await;
        bytes
    });
    let mut lines = BufReader::new(child.stdout.take().unwrap());
    let deadline = tokio::time::sleep(Duration::from_secs(config.cli_timeout_seconds as u64));
    tokio::pin!(deadline);
    let mut text = String::new();
    let mut final_result = None;
    let mut failed = false;
    let mut truncated = false;
    let mut retry_conversation = false;
    let mut session_id = None;
    let mut bytes = Vec::new();
    let mut total = 0usize;
    let result = async {
    loop {
        bytes.clear();
        let size = tokio::select! { _=token.cancelled()=>{let _=child.kill().await;return Err(error("CANCELLED","AI request cancelled"));},_=&mut deadline=>{let _=child.kill().await;return Err(error("AI_CLI_TIMEOUT","Agent CLI timed out"));},r=lines.read_until(b'\n',&mut bytes)=>r.map_err(|_|error("AI_CLI_STREAM_FAILED","Unable to read Agent CLI output"))? };
        if size == 0 {
            break;
        }
        total += size;
        if total > 16 * 1024 * 1024 {
            let _ = child.kill().await;
            return Err(error(
                "AI_OUTPUT_TOO_LARGE",
                "Agent CLI output exceeds the limit",
            ));
        }
        let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if resumed_conversation {
            let diagnostic = v.to_string().to_lowercase();
            retry_conversation |= (v["type"] == "error" || v["is_error"] == true || v["result"]["status"] == "error") && diagnostic.contains("conversation") && ["not found","missing","invalid"].iter().any(|term|diagnostic.contains(term));
        }
        failed |= v["type"] == "error" || v["is_error"] == true || v["type"] == "turn.failed" || v["subtype"].as_str().is_some_and(|s|s.starts_with("error")) || v["result"]["status"] == "error";
        truncated |= v["stop_reason"] == "max_tokens" || v["message"]["stop_reason"] == "max_tokens" || v["status"] == "incomplete";
        session_id = v["sessionID"]
            .as_str()
            .or(v["session_id"].as_str())
            .map(str::to_owned)
            .or_else(|| session_id.clone());
        if provider == "opencode" {
            if let Some(id)=&session_id { if let Ok(mut values)=pending_sessions().lock(){if !values.iter().any(|v|v.id==*id){values.push(PendingSession{executable:executable.clone(),cwd:cwd.clone(),id:id.clone()});persist("opencode-pending.json",&*values);}} }
        }
        if provider == "antigravity" {
            if let Some(id) = v["conversationId"]
                .as_str()
                .or(v["conversationID"].as_str())
                .or(v["conversation_id"].as_str())
                .or(v["result"]["conversation_id"].as_str())
            {
                if let Ok(mut values) = conversations().lock() {
                    values.insert(cwd.clone(), id.into());
                    persist("antigravity.json", &*values);
                }
            }
        }
        if let Some(chunk) = event_text(provider, &v) {
            if v["type"] == "assistant" && !text.is_empty() {
                continue;
            }
            text.push_str(&chunk);
            delta(&chunk);
        }
        if let Some(result) = final_text(&v) {
            final_result = Some(result);
        }
    }
    let status = tokio::select! {_=token.cancelled()=>return Err(error("CANCELLED","AI request cancelled")),_=&mut deadline=>return Err(error("AI_CLI_TIMEOUT","Agent CLI timed out")),r=child.wait()=>r.map_err(|_|error("AI_CLI_FAILED","Unable to finish Agent CLI"))?};
    let stderr_bytes = (&mut stderr_task).await.unwrap_or_default();
    let diagnostic = String::from_utf8_lossy(&stderr_bytes).to_lowercase();
    retry_conversation |= resumed_conversation && !status.success() && diagnostic.contains("conversation") && ["not found","missing","invalid"].iter().any(|term|diagnostic.contains(term));
    if truncated { return Err(error("AI_OUTPUT_TRUNCATED", "Agent CLI output was truncated")); }
    if !status.success() || failed {
        return Err(error(
            "AI_CLI_FAILED",
            "Agent CLI failed. Check its login, selected model and output log.",
        ));
    }
    if let Some(result) = final_result {
        if text.is_empty() {
            delta(&result);
        }
        text = result;
    }
    if text.trim().is_empty() {
        return Err(error(
            "AI_EMPTY_RESPONSE",
            "Agent CLI returned no assistant message",
        ));
    }
    Ok(text)
    }.await;
    let _ = child.kill().await;
    stderr_task.abort();
    if provider == "opencode" {
        if session_id.is_none() {
            if let Ok(list) = cli::run_with_env(
                &executable,
                &[
                    "session".into(),
                    "list".into(),
                    "--format".into(),
                    "json".into(),
                    "--max-count".into(),
                    "50".into(),
                ],
                Path::new(cwd),
                None,
                Duration::from_secs(10),
                &CancellationToken::new(),
                &[(
                    "PATH".into(),
                    cli_path(&executable).to_string_lossy().into_owned(),
                )],
            )
            .await
            {
                if let Ok(Value::Array(values)) = serde_json::from_str(&list.stdout_text()) {
                    session_id = values
                        .iter()
                        .find(|v| v["title"] == session_title)
                        .and_then(|v| v["id"].as_str())
                        .map(str::to_owned);
                }
            }
        }
        if let Some(id) = session_id {
            if let Ok(mut values) = pending_sessions().lock() {
                if !values.iter().any(|v| v.id == id) {
                    values.push(PendingSession {
                        executable: executable.clone(),
                        cwd: cwd.clone(),
                        id,
                    });
                    persist("opencode-pending.json", &*values);
                }
            }
            cleanup_pending().await;
        } else if result.is_ok() {
            return Err(error("AI_CLI_SESSION_MISSING","OpenCode did not expose a session ID. Its temporary session could not be cleaned up."));
        }
    }
    if retry_conversation && !token.is_cancelled() {
        if let Ok(mut values) = conversations().lock() {
            values.remove(cwd);
            persist("antigravity.json", &*values);
        }
        drop(_conversation_guard);
        return Box::pin(generate(config, system, input, roots, schema, token, delta)).await;
    }
    result
}

fn cli_path(executable: &str) -> std::ffi::OsString {
    let mut paths: Vec<std::path::PathBuf> = Path::new(executable)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| vec![p.to_owned()])
        .unwrap_or_default();
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    paths.extend([
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
    ]);
    std::env::join_paths(paths).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_cli_stream_variants_and_final_structured_result() {
        assert_eq!(
            event_text(
                "codex",
                &json!({"type":"item.completed","item":{"type":"agent_message","text":"commit"}})
            )
            .as_deref(),
            Some("commit")
        );
        assert_eq!(
            event_text(
                "claude",
                &json!({"type":"stream_event","event":{"delta":{"text":"stream"}}})
            )
            .as_deref(),
            Some("stream")
        );
        assert_eq!(
            event_text("opencode", &json!({"type":"text","part":{"text":"chunk"}})).as_deref(),
            Some("chunk")
        );
        assert_eq!(
            final_text(&json!({"event":"result","result":{"structured_output":{"groups":[]}}}))
                .unwrap(),
            "{\"groups\":[]}"
        );
    }
    #[tokio::test]
    #[ignore = "Calls installed authenticated Codex with synthetic evidence only"]
    async fn real_codex_synthetic_commit_message() {
        let dir = tempfile::tempdir().unwrap();
        let config = AiConfig {
            execution_mode: "agent-cli".into(),
            cli_provider: "codex".into(),
            cli_timeout_seconds: 180,
            ..Default::default()
        };
        let result=generate(&config,"Return exactly one Conventional Commit in Chinese. Do not use tools.","Synthetic diff only:\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const retries = 0;\n+export const retries = 3;",&[dir.path().to_string_lossy().into()],None,&CancellationToken::new(),&|_|{}).await.unwrap();
        assert!(result.contains(':'));
        assert!(!result.trim().is_empty());
        println!("Synthetic Codex output: {result}");
    }
}

#[cfg(all(test, unix))]
mod invocation_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[tokio::test]
    async fn four_cli_adapters_use_readonly_options_and_clean_opencode_session() {
        for provider in ["claude", "codex", "antigravity", "opencode"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("agent");
            let args = dir.path().join("args.txt");
            let input = dir.path().join("input.txt");
            let removed = dir.path().join("removed.txt");
            let response = match provider {
                "codex" => {
                    json!({"type":"item.completed","item":{"type":"agent_message","text":"fix(qa): 合成提交"}})
                }
                "antigravity" => {
                    json!({"event":"result","conversationID":format!("qa-{}",uuid::Uuid::new_v4()),"result":{"response":"fix(qa): 合成提交"}})
                }
                "opencode" => {
                    json!({"type":"text","sessionID":format!("qa-{}",uuid::Uuid::new_v4()),"part":{"text":"fix(qa): 合成提交"}})
                }
                _ => json!({"type":"result","result":"fix(qa): 合成提交"}),
            };
            let script=format!("#!/bin/sh\ncase \"$*\" in\n*--help*) echo '--print --no-session-persistence --permission-mode --tools --output-format --json-schema --include-partial-messages --ephemeral --json --sandbox --output-schema --input-format --mode --conversation --format --dir --agent --title --add-dir --max-count delete'; exit 0;;\n*--version*) echo fixture; exit 0;;\nsession\\ delete*) printf '%s' \"$*\" > '{}'; exit 0;;\nesac\nprintf '%s\\n' \"$@\" > '{}'\ncat > '{}'\nprintf '%s\\n' '{}'\n",removed.display(),args.display(),input.display(),response);
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            let mut config = AiConfig {
                execution_mode: "agent-cli".into(),
                cli_provider: provider.into(),
                ..Default::default()
            };
            config
                .cli_executable_paths
                .insert(provider.into(), path.to_string_lossy().into());
            let text = generate(
                &config,
                "System",
                "Synthetic evidence",
                &[dir.path().to_string_lossy().into()],
                None,
                &CancellationToken::new(),
                &|_| {},
            )
            .await
            .unwrap();
            assert_eq!(text, "fix(qa): 合成提交");
            let actual = std::fs::read_to_string(args).unwrap();
            match provider {
                "claude" => assert!(
                    actual.contains("--permission-mode\nplan") && actual.contains("Read,Glob,Grep")
                ),
                "codex" => assert!(
                    actual.contains("--sandbox\nread-only") && actual.contains("--ephemeral")
                ),
                "antigravity" => {
                    assert!(actual.contains("--mode\nplan") && actual.contains("--sandbox"))
                }
                "opencode" => {
                    assert!(actual.contains("versiondock-readonly"));
                    assert!(std::fs::read_to_string(removed)
                        .unwrap()
                        .starts_with("session delete qa-"));
                }
                _ => unreachable!(),
            }
            if provider != "opencode" {
                assert!(std::fs::read_to_string(input)
                    .unwrap()
                    .contains("Synthetic evidence"));
            }
        }
    }
    #[tokio::test]
    async fn cancellation_kills_cli_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent");
        std::fs::write(&path,"#!/bin/sh\ncase \"$*\" in\n*--help*) echo '--ephemeral --json --sandbox --output-schema';exit 0;;\n*--version*) echo fixture;exit 0;;\nesac\ncat >/dev/null\nsleep 30\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut config = AiConfig {
            execution_mode: "agent-cli".into(),
            cli_provider: "codex".into(),
            ..Default::default()
        };
        config
            .cli_executable_paths
            .insert("codex".into(), path.to_string_lossy().into());
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            cancel.cancel();
        });
        let begin = std::time::Instant::now();
        assert_eq!(
            generate(
                &config,
                "s",
                "i",
                &[dir.path().to_string_lossy().into()],
                None,
                &token,
                &|_| {}
            )
            .await
            .unwrap_err()
            .code,
            "CANCELLED"
        );
        assert!(begin.elapsed() < Duration::from_secs(2));
    }
}
