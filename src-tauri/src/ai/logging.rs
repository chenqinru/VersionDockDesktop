use super::models::{AiConfig, AiRequest};
use crate::logger::{self, LogChannel, LogLevel};
use serde_json::{json, Value};
use std::{collections::HashSet, future::Future, time::Instant};

tokio::task_local! { static REQUEST: Value; }

pub async fn with_request<F: Future>(request: &AiRequest, future: F) -> F::Output {
    let mut context = logger::current_log_context().unwrap_or_default();
    if context.workspace_id.as_deref() != Some(request.workspace_id.as_str()) {
        context.workspace_name = None;
    }
    context.workspace_id = Some(request.workspace_id.clone());
    let repositories: HashSet<_> = request
        .candidates
        .iter()
        .map(|candidate| &candidate.repo_id)
        .chain(request.commits.iter().map(|commit| &commit.repo_id))
        .chain(request.repo_id.iter())
        .collect();
    let repository =
        (repositories.len() == 1).then(|| (*repositories.iter().next().unwrap()).clone());
    if context.repository_id != repository {
        context.repository_name = None;
    }
    context.repository_id = repository;
    context
        .operation_id
        .get_or_insert_with(|| request.request_id.clone());
    logger::with_log_context(
        context,
        REQUEST.scope(
            json!({"requestId":request.request_id,"task":request.task.name()}),
            future,
        ),
    )
    .await
}

pub fn elapsed(start: Instant) -> u32 {
    start.elapsed().as_millis().min(u32::MAX as u128) as u32
}

pub fn config(config: &AiConfig) -> Value {
    json!({
        "executionMode":config.execution_mode,
        "provider":if config.execution_mode == "agent-cli" {config.cli_provider.as_str()} else {config.provider.as_str()},
        "model":if config.execution_mode == "agent-cli" {config.cli_model.as_str()} else {config.model.as_str()},
        "protocol":if config.execution_mode == "agent-cli" {"agent-cli"} else if config.provider == "claude" {"messages"} else if ["openai","custom"].contains(&config.provider.as_str()) {config.api_protocol.as_str()} else {"chat-completions"},
        "maxInputTokens":config.max_input_tokens,"maxOutputTokens":config.max_output_tokens,
    })
}

fn details(mut fields: Value, key: &str) -> String {
    if let Some(object) = fields.as_object_mut() {
        if let Ok(Value::Object(request)) = REQUEST.try_with(Clone::clone) {
            object.extend(request);
        }
    }
    let text = serde_json::to_string_pretty(&fields).unwrap_or_default();
    let text = if key.is_empty() {
        text
    } else {
        text.replace(key, "<redacted>")
    };
    crate::cli::redact(&text)
}

pub fn record(level: LogLevel, message: &str, fields: Value, duration: Option<u32>) {
    record_protected(level, message, fields, duration, "");
}

pub fn record_protected(
    level: LogLevel,
    message: &str,
    fields: Value,
    duration: Option<u32>,
    key: &str,
) {
    logger::log_entry(
        level,
        LogChannel::Ai,
        message,
        Some(details(fields, key)),
        duration,
        None,
    );
}

pub fn endpoint(url: &str) -> String {
    url::Url::parse(url)
        .map(|mut url| {
            url.set_query(None);
            url.set_fragment(None);
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.to_string()
        })
        .unwrap_or_else(|_| "<invalid endpoint>".into())
}

pub fn response(value: &Value, key: &str) {
    let response = value.get("response").unwrap_or(value);
    let reason = response["choices"][0]["finish_reason"]
        .as_str()
        .or(response["delta"]["stop_reason"].as_str())
        .or(response["stop_reason"].as_str())
        .or(response["incomplete_details"]["reason"].as_str())
        .or(response["status"].as_str());
    let usage = response.get("usage").or(response["message"].get("usage"));
    if reason.is_some() || usage.is_some() {
        let usage = usage.unwrap_or(&Value::Null);
        record_protected(
            LogLevel::Info,
            "AI response metadata",
            json!({
                "finishReason":reason,"inputTokenCount":usage["prompt_tokens"].as_u64().or(usage["input_tokens"].as_u64()),
                "outputTokenCount":usage["completion_tokens"].as_u64().or(usage["output_tokens"].as_u64()),
                "reasoningTokenCount":usage["completion_tokens_details"]["reasoning_tokens"].as_u64().or(usage["output_tokens_details"]["reasoning_tokens"].as_u64()),
            }),
            None,
            key,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logger::{LogContext, LogEntry, LogManager};

    #[tokio::test]
    async fn ai_logs_keep_request_context_and_persist_safe_provider_diagnostics() {
        let request: AiRequest = serde_json::from_value(json!({"requestId":"ai-request","task":"commit-message","workspaceId":"workspace","candidates":[{"repoId":"repository","paths":["private-path"],"stagedOnly":false}],"commits":[],"userPrompt":"private prompt","repoId":null,"path":null,"conflictIndexes":[],"sessionId":null,"unitIds":[]})).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let manager = LogManager::new(directory.path().into());
        logger::with_log_context(LogContext {operation_id:Some("bridge-request".into()),..Default::default()}, with_request(&request, async {
            let fields = details(json!({"status":400,"providerError":"input must be an array; synthetic-secret","endpoint":endpoint("https://user:pass@example.test/v1/responses?access_token=synthetic-secret#secret")}),"synthetic-secret");
            let context = logger::current_log_context().unwrap();
            assert_eq!(context.workspace_id.as_deref(),Some("workspace"));
            assert_eq!(context.repository_id.as_deref(),Some("repository"));
            assert_eq!(context.operation_id.as_deref(),Some("bridge-request"));
            assert!(fields.contains("ai-request") && fields.contains("commit-message") && fields.contains("input must be an array"));
            assert!(!fields.contains("synthetic-secret") && !fields.contains("private prompt") && !fields.contains("private-path") && !fields.contains("access_token") && !fields.contains("user:pass"));
            manager.push(LogEntry {id:"ai-entry".into(),timestamp:chrono::Utc::now().to_rfc3339(),level:LogLevel::Error,channel:LogChannel::Ai,message:"AI API request failed".into(),details:Some(fields),duration_ms:Some(50),exit_code:None,cwd:None,context:Some(context)});
        })).await;
        manager.flush().unwrap();
        let entries = manager.get_entries(Some(LogChannel::Ai), None, None);
        assert_eq!(entries.len(), 1);
        let exported = directory.path().join("export.log");
        manager.export_to_file(&exported).unwrap();
        let text = std::fs::read_to_string(exported).unwrap();
        assert!(
            text.contains("[AI]")
                && text.contains("ai-request")
                && text.contains("input must be an array")
        );
        assert!(!text.contains("synthetic-secret"));
    }
}
