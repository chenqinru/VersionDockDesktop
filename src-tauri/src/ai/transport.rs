use super::models::AiConfig;
use crate::models::DesktopError;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(super) fn error(code: &str, message: impl Into<String>) -> DesktopError {
    DesktopError::new(code, message.into(), true)
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
}
impl StreamState {
    pub fn consume(
        &mut self,
        data: &str,
        delta: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<(), DesktopError> {
        if data.trim() == "[DONE]" {
            self.complete = true;
            return Ok(());
        }
        if data.trim().is_empty() {
            return Ok(());
        }
        let v: Value = serde_json::from_str(data)
            .map_err(|_| error("AI_STREAM_INVALID", "Invalid AI stream event"))?;
        if v.get("error").is_some()
            || ["error", "response.failed"].contains(&v["type"].as_str().unwrap_or(""))
        {
            return Err(error(
                "AI_PROVIDER_ERROR",
                "AI provider rejected the request. Check its endpoint, credentials and selected model.",
            ));
        }
        if let Some(reason) = v["choices"][0]["finish_reason"]
            .as_str()
            .or(v["delta"]["stop_reason"].as_str())
            .or(v["stop_reason"].as_str())
        {
            self.complete = true;
            self.truncated |= ["length", "max_tokens", "content_filter"].contains(&reason);
        }
        let kind = v["type"].as_str().unwrap_or("");
        if kind == "response.incomplete" {
            self.complete = true;
            self.truncated = true;
        }
        if ["response.completed", "message_stop"].contains(&kind) {
            self.complete = true;
        }
        let chunk = if kind == "response.output_text.delta" {
            v["delta"].as_str()
        } else {
            v["choices"][0]["delta"]["content"]
                .as_str()
                .or(v["delta"]["text"].as_str())
        };
        if let Some(chunk) = chunk {
            self.text.push_str(chunk);
            delta(chunk);
        }
        if self.text.is_empty() && kind == "response.completed" {
            let full = extract_text(&v["response"]);
            if !full.is_empty() {
                delta(&full);
                self.text = full;
            }
        }
        Ok(())
    }
}
pub fn extract_text(v: &Value) -> String {
    if let Some(text) = v["choices"][0]["message"]["content"]
        .as_str()
        .or(v["output_text"].as_str())
    {
        return text.into();
    }
    if let Some(content) = v["content"].as_array() {
        return content.iter().filter_map(|p| p["text"].as_str()).collect();
    }
    v["output"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter_map(|part| part["text"].as_str())
        .collect()
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
    if super::context::tokens(system) + super::context::tokens(input)
        > config.max_input_tokens as usize
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
    let responses = config.provider != "claude"
        && config.api_protocol == "responses"
        && ["openai", "custom"].contains(&config.provider.as_str());
    let body = if config.provider == "claude" {
        json!({"model":config.model,"system":system,"messages":[{"role":"user","content":input}],"max_tokens":max_output,"stream":true})
    } else if responses {
        json!({"model":config.model,"instructions":system,"input":input,"max_output_tokens":max_output,"stream":true,"store":false})
    } else {
        let mut v = json!({"model":config.model,"messages":[{"role":"system","content":system},{"role":"user","content":input}],"stream":true});
        let modern = config.model.starts_with("gpt-5")
            || config.model.starts_with("gpt-6")
            || config.model.starts_with("o1")
            || config.model.starts_with("o3")
            || config.model.starts_with("o4");
        v[if modern {
            "max_completion_tokens"
        } else {
            "max_tokens"
        }] = json!(max_output);
        v
    };
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| error("AI_HTTP_FAILED", e.to_string()))?;
    let mut request = client.post(url).json(&body);
    if config.provider == "claude" {
        request = request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01");
    } else {
        request = request.bearer_auth(key);
    }
    let mut response = tokio::select! { _ = token.cancelled() => return Err(error("CANCELLED", "AI request cancelled")), r=request.send()=>r.map_err(|e| error("AI_HTTP_FAILED", e.without_url().to_string()))? };
    if !response.status().is_success() {
        return Err(error(
            "AI_HTTP_REJECTED",
            format!(
                "AI provider returned HTTP {}. Check the model, endpoint and credentials.",
                response.status()
            ),
        ));
    }
    let sse = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/event-stream"));
    let mut state = StreamState::default();
    let mut buffer = Vec::<u8>::new();
    let mut event_data = String::new();
    let mut size = 0usize;
    loop {
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
        if sse {
            while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                let line = String::from_utf8(buffer.drain(..=end).collect())
                    .map_err(|_| error("AI_STREAM_INVALID", "Invalid UTF-8 in AI stream"))?;
                let line = line.trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    state.consume(&event_data, delta)?;
                    event_data.clear();
                } else if let Some(data) = line.strip_prefix("data:") {
                    if !event_data.is_empty() {
                        event_data.push('\n');
                    }
                    event_data.push_str(data.trim_start());
                }
            }
        }
    }
    if sse {
        if let Ok(line) = std::str::from_utf8(&buffer) {
            if let Some(data) = line.trim().strip_prefix("data:") {
                event_data.push_str(data.trim_start());
            }
        }
        if !event_data.is_empty() {
            state.consume(&event_data, delta)?;
        }
        if !state.complete {
            return Err(error(
                "AI_STREAM_INTERRUPTED",
                "AI stream ended before completion",
            ));
        }
        if state.truncated {
            return Err(error(
                "AI_OUTPUT_TRUNCATED",
                "AI output was truncated. Increase the output budget or reduce the selection.",
            ));
        }
        if state.text.trim().is_empty() {
            return Err(error("AI_EMPTY_RESPONSE", "AI provider returned no text"));
        }
        Ok(state.text)
    } else {
        let value: Value = serde_json::from_slice(&buffer)
            .map_err(|_| error("AI_RESPONSE_INVALID", "Invalid AI response"))?;
        if ["length", "max_tokens"].contains(
            &value["choices"][0]["finish_reason"]
                .as_str()
                .or(value["stop_reason"].as_str())
                .unwrap_or(""),
        ) || value["status"] == "incomplete"
        {
            return Err(error("AI_OUTPUT_TRUNCATED", "AI output was truncated"));
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
            &|_| {},
        )
        .unwrap();
        s.consume(r#"{"type":"response.completed","response":{}}"#, &|_| {})
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
