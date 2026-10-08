use super::models::{AiConfig, AiTask};
use crate::logger::LogLevel;
use crate::models::DesktopError;
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicU64, AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(super) fn error(code: &str, message: impl Into<String>) -> DesktopError {
    DesktopError::new(code, message.into(), true)
}

fn provider_error(value: &Value, key: &str, status: Option<u16>) -> DesktopError {
    let detail = value["response"]["error"]["message"]
        .as_str()
        .or(value["error"]["message"].as_str())
        .or(value["error"].as_str())
        .or(value["message"].as_str())
        .unwrap_or("");
    // Providers sometimes echo credentials. Redact before bounding the visible detail.
    let detail = if key.is_empty() {
        detail.to_string()
    } else {
        detail.replace(key, "<redacted>")
    };
    let detail: String = crate::cli::redact(&detail).chars().take(1024).collect();
    let hint = match status {
        Some(status) if detail.is_empty() => format!("HTTP {status}"),
        Some(status) => format!("HTTP {status}: {detail}"),
        None => detail,
    };
    let mut result = error(
        if status.is_some() {
            "AI_HTTP_REJECTED"
        } else {
            "AI_PROVIDER_ERROR"
        },
        "AI provider rejected the request. Check its endpoint, credentials and selected model.",
    );
    if !hint.is_empty() {
        result.hint = Some(hint);
    }
    result
}

fn detect_sse(buffer: &[u8]) -> Option<bool> {
    let start = buffer.iter().position(|b| !b.is_ascii_whitespace())?;
    let buffer = &buffer[start..];
    if buffer.starts_with(b"{") || buffer.starts_with(b"[") {
        return Some(false);
    }
    if [b"data:".as_slice(), b"event:", b":", b"id:", b"retry:"]
        .iter()
        .any(|prefix| buffer.starts_with(prefix))
    {
        return Some(true);
    }
    buffer.contains(&b'\n').then_some(false)
}
pub fn endpoint(config: &AiConfig) -> Result<String, DesktopError> {
    let default = match config.provider.as_str() {
        "claude" => "https://api.anthropic.com/v1/messages",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        _ => "https://api.openai.com/v1/chat/completions",
    };
    let raw = if config.api_url.trim().is_empty() {
        default
    } else {
        config.api_url.trim()
    };
    if config.provider == "custom" && config.api_url.trim().is_empty() {
        return Err(error("AI_URL_REQUIRED", "Set the custom API URL"));
    }
    let mut url =
        url::Url::parse(raw).map_err(|_| error("AI_URL_INVALID", "Invalid AI API URL"))?;
    if !["https", "http"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(error(
            "AI_URL_INVALID",
            "Use an HTTP(S) API URL without embedded credentials",
        ));
    }
    let path = url.path().trim_end_matches('/').to_string();
    let responses = config.api_protocol == "responses"
        && ["openai", "custom"].contains(&config.provider.as_str());
    if path.is_empty()
        || path == "/v1"
        || (responses && path == "/v1/chat/completions")
        || (!responses && path == "/v1/responses")
    {
        url.set_path(if responses {
            "/v1/responses"
        } else if config.provider == "claude" {
            "/v1/messages"
        } else if config.provider == "gemini" {
            "/v1beta/openai/chat/completions"
        } else {
            "/v1/chat/completions"
        });
    } else if config.provider == "gemini" && ["/v1beta", "/v1beta/openai"].contains(&path.as_str())
    {
        url.set_path("/v1beta/openai/chat/completions");
    }
    Ok(url.to_string())
}
#[derive(Default, Debug)]
pub struct StreamState {
    pub text: String,
    pub complete: bool,
    pub truncated: bool,
    output_limited: bool,
}
impl StreamState {
    pub fn consume(
        &mut self,
        data: &str,
        key: &str,
        delta: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<bool, DesktopError> {
        if data.trim() == "[DONE]" {
            self.complete = true;
            return Ok(true);
        }
        if data.trim().is_empty() {
            return Ok(false);
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            // Match the plugin's tolerance for non-JSON keep-alive/vendor events.
            // A stream without a valid completion still fails at EOF.
            return Ok(false);
        };
        let response = v.get("response").unwrap_or(&v);
        super::logging::response(&v, key);
        if v.get("error").is_some_and(|error| !error.is_null())
            || response.get("error").is_some_and(|error| !error.is_null())
            || response["status"] == "failed"
            || ["error", "response.failed"].contains(&v["type"].as_str().unwrap_or(""))
        {
            return Err(provider_error(&v, key, None));
        }
        if let Some(reason) = v["choices"][0]["finish_reason"]
            .as_str()
            .or(v["delta"]["stop_reason"].as_str())
            .or(v["stop_reason"].as_str())
        {
            self.complete = true;
            self.truncated |= [
                "length",
                "max_tokens",
                "max_output_tokens",
                "content_filter",
            ]
            .contains(&reason);
            self.output_limited |= ["length", "max_tokens", "max_output_tokens"].contains(&reason);
        }
        let kind = v["type"].as_str().unwrap_or("");
        if kind == "response.incomplete" || response["status"] == "incomplete" {
            self.complete = true;
            self.truncated = true;
            self.output_limited |= ["max_tokens", "max_output_tokens"].contains(
                &response["incomplete_details"]["reason"]
                    .as_str()
                    .unwrap_or(""),
            );
        }
        if ["response.completed", "message_stop"].contains(&kind) {
            self.complete = true;
        }
        let chunk = if kind == "response.output_text.delta" {
            v["delta"].as_str().unwrap_or("").to_string()
        } else {
            let content = content_text(&v["choices"][0]["delta"]["content"]);
            if content.is_empty() {
                v["delta"]["text"].as_str().unwrap_or("").to_string()
            } else {
                content
            }
        };
        if !chunk.is_empty() {
            self.text.push_str(&chunk);
            delta(&chunk);
        }
        if self.text.is_empty() {
            let full = extract_text(&v);
            if !full.is_empty() {
                delta(&full);
                self.text = full;
            }
        }
        if self.text.is_empty()
            && ["response.completed", "response.output_text.done"].contains(&kind)
        {
            let full = if kind == "response.output_text.done" {
                v["text"].as_str().unwrap_or("").to_string()
            } else {
                extract_text(&v["response"])
            };
            if !full.is_empty() {
                delta(&full);
                self.text = full;
            }
        }
        // A finish reason validates EOF; only a terminal event stops a live stream.
        Ok(["response.completed", "response.incomplete", "message_stop"].contains(&kind))
    }
}
fn content_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part.as_str().or(part["text"].as_str()))
        .collect()
}
pub fn extract_text(v: &Value) -> String {
    let v = v.get("response").unwrap_or(v);
    let text = content_text(&v["choices"][0]["message"]["content"]);
    if !text.is_empty() {
        return text;
    }
    if let Some(content) = v["content"].as_array() {
        return content.iter().filter_map(|p| p["text"].as_str()).collect();
    }
    let text = v["output"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "message")
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter(|part| part["type"] == "output_text")
        .filter_map(|part| part["text"].as_str())
        .collect::<String>();
    if text.is_empty() {
        v["output_text"].as_str().unwrap_or("").to_string()
    } else {
        text
    }
}
pub async fn generate_for_task(
    config: &AiConfig,
    key: &str,
    system: &str,
    input: &str,
    roots: &[String],
    schema: Option<&Value>,
    max_output: u32,
    task: AiTask,
    token: &CancellationToken,
    delta: &(dyn Fn(&str) + Send + Sync),
) -> Result<String, DesktopError> {
    let result = generate(
        config, key, system, input, roots, schema, max_output, token, delta,
    )
    .await;
    let expanded = super::budget::expanded(max_output, config.max_output_tokens);
    match result {
        Err(err)
            if task == AiTask::CommitComposer
                && config.execution_mode == "provider"
                && err.code == "AI_OUTPUT_TRUNCATED"
                && err.hint.as_deref() == Some("max_output_tokens")
                && expanded > max_output
                && !token.is_cancelled() =>
        {
            super::logging::record(
                LogLevel::Warn,
                "AI output limit reached; retrying generation",
                json!({"previousMaxOutputTokens":max_output,"retryMaxOutputTokens":expanded}),
                None,
            );
            generate(
                config, key, system, input, roots, schema, expanded, token, delta,
            )
            .await
        }
        result => result,
    }
}

pub async fn generate(
    config: &AiConfig,
    key: &str,
    system: &str,
    input: &str,
    roots: &[String],
    schema: Option<&Value>,
    max_output: u32,
    token: &CancellationToken,
    delta: &(dyn Fn(&str) + Send + Sync),
) -> Result<String, DesktopError> {
    let start = Instant::now();
    let mut fields = super::logging::config(config);
    fields["inputTokenCount"] =
        json!(super::context::tokens(system) + super::context::tokens(input));
    fields["maxOutputTokens"] = json!(max_output);
    fields["repositoryCount"] = json!(roots.len());
    fields["structuredOutput"] = json!(schema.is_some());
    super::logging::record_protected(
        LogLevel::Info,
        if config.execution_mode == "agent-cli" {
            "AI CLI request started"
        } else {
            "AI API request started"
        },
        fields.clone(),
        None,
        key,
    );
    let chunks = AtomicUsize::new(0);
    let characters = AtomicUsize::new(0);
    let first_token = AtomicU64::new(u64::MAX);
    let track = |text: &str| {
        if !text.is_empty() {
            chunks.fetch_add(1, Ordering::Relaxed);
            characters.fetch_add(text.chars().count(), Ordering::Relaxed);
            let _ = first_token.compare_exchange(
                u64::MAX,
                super::logging::elapsed(start) as u64,
                Ordering::Relaxed,
                Ordering::Relaxed,
            );
        }
        delta(text);
    };
    let result = generate_inner(
        config, key, system, input, roots, schema, max_output, token, &track,
    )
    .await;
    fields["streamChunkCount"] = json!(chunks.load(Ordering::Relaxed));
    fields["streamCharCount"] = json!(characters.load(Ordering::Relaxed));
    let latency = first_token.load(Ordering::Relaxed);
    fields["firstTokenLatencyMs"] = if latency == u64::MAX {
        Value::Null
    } else {
        json!(latency)
    };
    let (level, message) = match &result {
        Ok(text) => {
            fields["outputCharCount"] = json!(text.chars().count());
            (LogLevel::Info, "AI request completed")
        }
        Err(err) => {
            fields["errorCode"] = json!(err.code);
            fields["providerDetails"] = json!(err.hint);
            if err.code == "CANCELLED" {
                (LogLevel::Info, "AI request cancelled")
            } else {
                (LogLevel::Error, "AI request failed")
            }
        }
    };
    super::logging::record_protected(
        level,
        message,
        fields,
        Some(super::logging::elapsed(start)),
        key,
    );
    result
}

async fn generate_inner(
    config: &AiConfig,
    key: &str,
    system: &str,
    input: &str,
    roots: &[String],
    schema: Option<&Value>,
    max_output: u32,
    token: &CancellationToken,
    delta: &(dyn Fn(&str) + Send + Sync),
) -> Result<String, DesktopError> {
    if super::context::tokens(system) + super::context::tokens(input)
        > super::budget::input(config.max_input_tokens)
    {
        return Err(error(
            "AI_CONTEXT_TOO_LARGE",
            "AI request exceeds the configured input budget",
        ));
    }
    if config.execution_mode == "agent-cli" {
        return super::agent_cli::generate(config, system, input, roots, schema, token, delta)
            .await;
    }
    if key.trim().is_empty() {
        return Err(error(
            "AI_KEY_REQUIRED",
            "Configure an AI API key in Settings",
        ));
    }
    if config.model.is_empty() {
        return Err(error(
            "AI_MODEL_REQUIRED",
            "Configure an AI model in Settings",
        ));
    }
    let url = endpoint(config)?;
    super::logging::record_protected(
        LogLevel::Info,
        "AI HTTP endpoint resolved",
        json!({"endpoint":super::logging::endpoint(&url)}),
        None,
        key,
    );
    let responses = config.provider != "claude"
        && config.api_protocol == "responses"
        && ["openai", "custom"].contains(&config.provider.as_str());
    let body = if config.provider == "claude" {
        json!({"model":config.model,"system":system,"messages":[{"role":"user","content":input}],"max_tokens":max_output,"stream":true})
    } else if responses {
        json!({"model":config.model,"instructions":system,"input":[{"role":"user","content":[{"type":"input_text","text":input}]}],"max_output_tokens":max_output,"stream":true,"store":false})
    } else {
        let mut v = json!({"model":config.model,"messages":[{"role":"system","content":system},{"role":"user","content":input}],"stream":true});
        v[if config.provider == "openai" {
            "max_completion_tokens"
        } else {
            "max_tokens"
        }] = json!(max_output);
        if config.provider == "openai" {
            v["stream_options"] = json!({"include_usage":true});
        }
        v
    };
    let client = crate::http_client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| error("AI_HTTP_FAILED", e.to_string()))?;
    let mut request = client
        .post(url)
        .header("Accept", "text/event-stream")
        .json(&body);
    if config.provider == "claude" {
        request = request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01");
    } else {
        request = request.bearer_auth(key);
    }
    let mut response = tokio::select! { _ = token.cancelled() => return Err(error("CANCELLED", "AI request cancelled")), r=request.send()=>r.map_err(|e| error("AI_HTTP_FAILED", e.without_url().to_string()))? };
    super::logging::record(
        LogLevel::Info,
        "AI HTTP response received",
        json!({"httpStatus":response.status().as_u16()}),
        None,
    );
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut body = Vec::new();
        // Keep diagnostic reads bounded and cancellable, including non-JSON proxy errors.
        while body.len() < 64 * 1024 {
            let chunk = tokio::select! {
                _ = token.cancelled() => return Err(error("CANCELLED", "AI request cancelled")),
                chunk = response.chunk() => chunk,
            };
            let Ok(Some(chunk)) = chunk else { break };
            let remaining = 64 * 1024 - body.len();
            body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        }
        let value = serde_json::from_slice(&body).unwrap_or_else(|_| {
            let text = String::from_utf8_lossy(&body);
            if text.trim_start().starts_with('<') {
                Value::Null
            } else {
                json!({"message": text})
            }
        });
        return Err(provider_error(&value, key, Some(status)));
    }
    // Detect framing from the body: proxies can mislabel either SSE or JSON fallback.
    let mut sse = None;
    let mut state = StreamState::default();
    let mut buffer = Vec::<u8>::new();
    let mut event_data = String::new();
    let mut size = 0usize;
    let mut terminal = false;
    'stream: loop {
        let chunk = tokio::select! { _=token.cancelled()=>return Err(error("CANCELLED", "AI request cancelled")), r=response.chunk()=>r.map_err(|e| error("AI_STREAM_FAILED", e.without_url().to_string()))? };
        let Some(chunk) = chunk else { break };
        size += chunk.len();
        if size > 16 * 1024 * 1024 {
            return Err(error(
                "AI_OUTPUT_TOO_LARGE",
                "AI response exceeds the output size limit",
            ));
        }
        buffer.extend_from_slice(&chunk);
        if sse.is_none() {
            sse = detect_sse(&buffer);
        }
        if sse == Some(true) {
            while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                let line = String::from_utf8(buffer.drain(..=end).collect())
                    .map_err(|_| error("AI_STREAM_INVALID", "Invalid UTF-8 in AI stream"))?;
                let line = line.trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    terminal = state.consume(&event_data, key, delta)?;
                    event_data.clear();
                    if terminal {
                        break 'stream;
                    }
                } else if let Some(data) = line.strip_prefix("data:") {
                    if !event_data.is_empty() {
                        event_data.push('\n');
                    }
                    event_data.push_str(data.trim_start());
                }
            }
        }
    }
    if sse == Some(true) {
        if !terminal {
            if let Ok(line) = std::str::from_utf8(&buffer) {
                if let Some(data) = line.trim().strip_prefix("data:") {
                    event_data.push_str(data.trim_start());
                }
            }
            if !event_data.is_empty() {
                state.consume(&event_data, key, delta)?;
            }
        }
        if !state.complete {
            return Err(error(
                "AI_STREAM_INTERRUPTED",
                "AI stream ended before completion",
            ));
        }
        if state.truncated {
            let mut err = error(
                "AI_OUTPUT_TRUNCATED",
                "AI output was truncated. Increase the output budget or reduce the selection.",
            );
            if state.output_limited {
                err.hint = Some("max_output_tokens".into());
            }
            return Err(err);
        }
        if state.text.trim().is_empty() {
            return Err(error("AI_EMPTY_RESPONSE", "AI provider returned no text"));
        }
        Ok(state.text)
    } else {
        let value: Value = serde_json::from_slice(&buffer)
            .map_err(|_| error("AI_RESPONSE_INVALID", "Invalid AI response"))?;
        super::logging::response(&value, key);
        if value.get("error").is_some_and(|error| !error.is_null()) || value["status"] == "failed" {
            return Err(provider_error(&value, key, None));
        }
        if [
            "length",
            "max_tokens",
            "max_output_tokens",
            "content_filter",
        ]
        .contains(
            &value["choices"][0]["finish_reason"]
                .as_str()
                .or(value["stop_reason"].as_str())
                .unwrap_or(""),
        ) || value["status"] == "incomplete"
        {
            let reason = value["choices"][0]["finish_reason"]
                .as_str()
                .or(value["stop_reason"].as_str())
                .or(value["incomplete_details"]["reason"].as_str())
                .unwrap_or("");
            let mut err = error("AI_OUTPUT_TRUNCATED", "AI output was truncated");
            if ["length", "max_tokens", "max_output_tokens"].contains(&reason) {
                err.hint = Some("max_output_tokens".into());
            }
            return Err(err);
        }
        let text = extract_text(&value);
        if text.trim().is_empty() {
            return Err(error("AI_EMPTY_RESPONSE", "AI provider returned no text"));
        }
        delta(&text);
        Ok(text)
    }
}

pub fn secure_reference(config: &AiConfig) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(format!(
        "{}\n{}",
        config.provider,
        endpoint(config)
            .ok()
            .and_then(|v| url::Url::parse(&v).ok())
            .map(|v| v.origin().ascii_serialization())
            .unwrap_or_default()
    )))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_api_shapes_and_stream_completion() {
        let mut s = StreamState::default();
        let mut seen = String::new();
        s.consume(
            r#"{"type":"response.output_text.delta","delta":"你好"}"#,
            "",
            &|_| {},
        )
        .unwrap();
        s.consume(
            r#"{"type":"response.completed","response":{}}"#,
            "",
            &|_| {},
        )
        .unwrap();
        assert!(s.complete);
        assert_eq!(s.text, "你好");
        seen.push_str(&extract_text(
            &json!({"content":[{"type":"text","text":"Claude"}]}),
        ));
        assert_eq!(seen, "Claude");
        let c = AiConfig {
            provider: "custom".into(),
            api_url: "http://localhost:9000/v1".into(),
            api_protocol: "responses".into(),
            ..Default::default()
        };
        assert_eq!(endpoint(&c).unwrap(), "http://localhost:9000/v1/responses");
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod protocol_tests;
