use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};
fn server(body: String, sse: bool, delay_ms: u64) -> (String, std::thread::JoinHandle<Value>) {
    fixture_server(
        body,
        Fixture {
            content_type: if sse {
                "text/event-stream"
            } else {
                "application/json"
            },
            delay_ms,
            ..Default::default()
        },
    )
}

struct Fixture {
    content_type: &'static str,
    status: &'static str,
    delay_ms: u64,
    keep_open_ms: u64,
    require_responses: bool,
}

impl Default for Fixture {
    fn default() -> Self {
        Self {
            content_type: "text/event-stream",
            status: "200 OK",
            delay_ms: 0,
            keep_open_ms: 0,
            require_responses: false,
        }
    }
}

fn fixture_server(body: String, fixture: Fixture) -> (String, std::thread::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = std::thread::spawn(move || serve(&listener, body, fixture));
    (url, task)
}

fn serve(listener: &TcpListener, mut body: String, fixture: Fixture) -> Value {
    let (mut stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut raw = Vec::new();
    let mut bytes = [0u8; 1024];
    let end = loop {
        let size = stream.read(&mut bytes).unwrap();
        assert!(size > 0);
        raw.extend_from_slice(&bytes[..size]);
        if let Some(p) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
    };
    let headers = String::from_utf8_lossy(&raw[..end]).into_owned();
    let length: usize = headers
        .lines()
        .find_map(|l| {
            l.to_lowercase()
                .strip_prefix("content-length:")
                .map(str::trim)
                .and_then(|v| v.parse().ok())
        })
        .unwrap();
    while raw.len() < end + length {
        let size = stream.read(&mut bytes).unwrap();
        assert!(size > 0);
        raw.extend_from_slice(&bytes[..size]);
    }
    let request: Value = serde_json::from_slice(&raw[end..end + length]).unwrap();
    let mut status = fixture.status;
    if fixture.require_responses
        && (!headers.starts_with("POST /v1/responses ")
            || !headers
                .to_ascii_lowercase()
                .contains("accept: text/event-stream")
            || !request["input"].is_array()
            || request["input"][0]["role"] != "user"
            || request["input"][0]["content"][0]["type"] != "input_text")
    {
        status = "400 Bad Request";
        body =
            json!({"error":{"message":"Expected Responses message array and SSE Accept header"}})
                .to_string();
    }
    let framing = if fixture.keep_open_ms > 0 {
        "Transfer-Encoding: chunked\r\n".to_string()
    } else {
        format!("Content-Length: {}\r\nConnection: close\r\n", body.len())
    };
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\n{framing}\r\n",
        fixture.content_type
    );
    stream.write_all(header.as_bytes()).unwrap();
    std::thread::sleep(Duration::from_millis(fixture.delay_ms));
    if fixture.keep_open_ms > 0 {
        write!(stream, "{:x}\r\n", body.len()).unwrap();
    }
    // Intentionally split UTF-8 characters and SSE delimiters across network frames.
    for piece in body.as_bytes().chunks(2) {
        if stream.write_all(piece).is_err() {
            break;
        }
        let _ = stream.flush();
    }
    if fixture.keep_open_ms > 0 {
        let _ = stream.write_all(b"\r\n");
        let _ = stream.flush();
        std::thread::sleep(Duration::from_millis(fixture.keep_open_ms));
        let _ = stream.write_all(b"0\r\n\r\n");
    }
    request
}
#[tokio::test]
async fn all_api_protocols_handle_fragmented_unicode_and_budgets() {
    for (provider,protocol,body) in [
        ("openai","chat-completions","data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"),
        ("custom","responses","event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n"),
        ("claude","chat-completions","data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"你好\"}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n"),
        ("gemini","chat-completions","data: {\"choices\":[{\"delta\":{\"content\":\"你好\"},\"finish_reason\":\"stop\"}]}\n\n"),
    ] {
        let (url,task)=server(body.into(),true,0);let config=AiConfig{provider:provider.into(),api_protocol:protocol.into(),api_url:url,model:"fixture-model".into(),..Default::default()};
        let seen=Arc::new(Mutex::new(String::new()));let target=seen.clone();
        assert_eq!(generate(&config,"synthetic-key","system","input",&[],None,4096,&CancellationToken::new(),&move |t|target.lock().unwrap().push_str(t)).await.unwrap(),"你好");assert_eq!(*seen.lock().unwrap(),"你好");
        let request=task.join().unwrap();assert_eq!(request["model"],"fixture-model");assert!(request.to_string().find("synthetic-key").is_none());
        if protocol=="responses"{assert_eq!(request["store"],false);assert_eq!(request["max_output_tokens"],4096);assert_eq!(request["input"],json!([{"role":"user","content":[{"type":"input_text","text":"input"}]}]));}else if provider=="openai"{assert_eq!(request["max_completion_tokens"],4096);}else{assert_eq!(request["max_tokens"],4096);}
}
}

#[tokio::test]
async fn chat_budget_parameter_matches_provider_without_model_name_guessing() {
    for (provider, model, parameter) in [
        ("custom", "gpt-5.6-luna", "max_tokens"),
        ("custom", "o3", "max_tokens"),
        ("openai", "gpt-4o", "max_completion_tokens"),
        ("openai", "private-model-alias", "max_completion_tokens"),
        ("gemini", "gpt-compatible-alias", "max_tokens"),
    ] {
        let (url, task) = server("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".into(), true, 0);
        let config = AiConfig {
            provider: provider.into(),
            model: model.into(),
            api_url: url,
            ..Default::default()
        };
        assert_eq!(
            generate(
                &config,
                "key",
                "s",
                "i",
                &[],
                None,
                4096,
                &CancellationToken::new(),
                &|_| {}
            )
            .await
            .unwrap(),
            "ok"
        );
        let request = task.join().unwrap();
        assert_eq!(request[parameter], 4096);
        assert!(request[if parameter == "max_tokens" {
            "max_completion_tokens"
        } else {
            "max_tokens"
        }]
        .is_null());
        assert_eq!(
            request["stream_options"]["include_usage"],
            if provider == "openai" {
                json!(true)
            } else {
                Value::Null
            }
        );
    }
}

#[tokio::test]
async fn provider_content_arrays_and_vendor_keepalive_events_preserve_assistant_text() {
    for (body, sse) in [
        ("data: keepalive\n\ndata: {\"choices\":[{\"delta\":{\"content\":[\"你\",{\"type\":\"text\",\"text\":\"好\"}]}}]}\n\ndata: [DONE]\n\n",true),
        ("data: {\"choices\":[{\"message\":{\"content\":[{\"text\":\"你好\"}]},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",true),
        (r#"{"choices":[{"message":{"content":[{"type":"text","text":"你好"}]},"finish_reason":"stop"}]}"#,false),
        (r#"{"choices":[{"message":{"content":[{"type":"text","text":"你好"}]},"finish_reason":"stop"}]}"#,true),
        (r#"{"status":"completed","output":[{"type":"reasoning","content":[{"type":"output_text","text":"hidden reasoning"}]},{"type":"message","content":[{"type":"output_text","text":"你好"},{"type":"refusal","text":"not assistant text"}]}]}"#,false),
    ] {
        let (url,task)=server(body.into(),sse,0);
        let config=AiConfig {api_url:url,model:"fixture".into(),..Default::default()};
        let seen=Arc::new(Mutex::new(String::new()));let target=seen.clone();
        assert_eq!(generate(&config,"key","s","i",&[],None,4096,&CancellationToken::new(),&move |s|target.lock().unwrap().push_str(s)).await.unwrap(),"你好");
        assert_eq!(*seen.lock().unwrap(),"你好");
        task.join().unwrap();
    }
}
#[tokio::test]
async fn rejects_truncation_disconnect_and_redacts_stream_error() {
    for (body,code) in [
        ("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}\n\n","AI_OUTPUT_TRUNCATED"),
        ("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n","AI_STREAM_INTERRUPTED"),
        ("data: {\"error\":{\"message\":\"synthetic-secret\"}}\n\n","AI_PROVIDER_ERROR"),
    ] {let(url,task)=server(body.into(),true,0);let config=AiConfig{api_url:url,model:"fixture".into(),..Default::default()};let e=generate(&config,"synthetic-secret","s","i",&[],None,1024,&CancellationToken::new(),&|_|{}).await.unwrap_err();assert_eq!(e.code,code);assert!(!e.message.contains("synthetic-secret"));assert!(!e.hint.unwrap_or_default().contains("synthetic-secret"));task.join().unwrap();}
}

#[tokio::test]
async fn responses_proxy_accepts_plugin_request_and_finishes_without_eof() {
    let body = concat!(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\",\"error\":null}\n\n",
        "data: {\"type\":\"response.output_text.done\",\"text\":\"你好\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"error\":null}}\n\n"
    );
    let (url, task) = fixture_server(
        body.into(),
        Fixture {
            require_responses: true,
            keep_open_ms: 700,
            ..Default::default()
        },
    );
    let config = AiConfig {
        provider: "custom".into(),
        api_protocol: "responses".into(),
        api_url: url,
        model: "gpt-5.6-luna".into(),
        ..Default::default()
    };
    let seen = Arc::new(Mutex::new(String::new()));
    let target = seen.clone();
    let result = tokio::time::timeout(
        Duration::from_millis(300),
        generate(
            &config,
            "synthetic-key",
            "system",
            "input",
            &[],
            None,
            4096,
            &CancellationToken::new(),
            &move |text| target.lock().unwrap().push_str(text),
        ),
    )
    .await;
    assert_eq!(
        result
            .expect("Do not wait for EOF after response.completed")
            .unwrap(),
        "你好"
    );
    assert_eq!(*seen.lock().unwrap(), "你好");
    let request = task.join().unwrap();
    assert_eq!(request["model"], "gpt-5.6-luna");
    assert_eq!(request["instructions"], "system");
}

#[tokio::test]
async fn responses_final_text_and_mislabeled_sse_work_without_duplicate_deltas() {
    for content_type in [
        "text/event-stream",
        "application/json",
        "application/octet-stream",
    ] {
        for body in [
            "event: response.output_text.done\ndata: {\"type\":\"response.output_text.done\",\"text\":\"你好\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n",
            ": keepalive\n\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"你好\"}]}]}}",
        ] {
            let (url, task) = fixture_server(body.into(), Fixture { content_type, ..Default::default() });
            let config = AiConfig { provider: "custom".into(), api_protocol: "responses".into(), api_url: url, model: "fixture".into(), ..Default::default() };
            let seen = Arc::new(Mutex::new(String::new()));
            let target = seen.clone();
            assert_eq!(generate(&config, "key", "s", "i", &[], None, 4096, &CancellationToken::new(), &move |text| target.lock().unwrap().push_str(text)).await.unwrap(), "你好");
            assert_eq!(*seen.lock().unwrap(), "你好");
            task.join().unwrap();
        }
    }
}

#[tokio::test]
async fn responses_errors_preserve_safe_details_and_reject_incomplete_output() {
    for (body, content_type, status, code, hint) in [
        (r#"{"error":{"message":"input must be an array; credential synthetic-secret"}}"#, "application/json", "400 Bad Request", "AI_HTTP_REJECTED", "HTTP 400: input must be an array; credential <redacted>"),
        ("<html>proxy failed</html>", "text/html", "502 Bad Gateway", "AI_HTTP_REJECTED", "HTTP 502"),
        ("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"model is unavailable\"}}}\n\n", "text/event-stream", "200 OK", "AI_PROVIDER_ERROR", "model is unavailable"),
        (r#"{"status":"failed","error":{"message":"model is unavailable"}}"#, "application/json", "200 OK", "AI_PROVIDER_ERROR", "model is unavailable"),
        ("data: {\"type\":\"response.incomplete\",\"response\":{\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n", "text/event-stream", "200 OK", "AI_OUTPUT_TRUNCATED", "max_output_tokens"),
        (r#"{"status":"incomplete","output_text":"partial"}"#, "application/json", "200 OK", "AI_OUTPUT_TRUNCATED", ""),
        ("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"output_text\":\"partial\"}}\n\n", "text/event-stream", "200 OK", "AI_OUTPUT_TRUNCATED", "max_output_tokens"),
        ("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"model is unavailable\"},\"output_text\":\"partial\"}}\n\n", "text/event-stream", "200 OK", "AI_PROVIDER_ERROR", "model is unavailable"),
    ] {
        let (url, task) = fixture_server(body.into(), Fixture { content_type, status, ..Default::default() });
        let config = AiConfig { provider: "custom".into(), api_protocol: "responses".into(), api_url: url, model: "fixture".into(), ..Default::default() };
        let error = generate(&config, "synthetic-secret", "s", "i", &[], None, 4096, &CancellationToken::new(), &|_| {}).await.unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.hint.as_deref().unwrap_or(""), hint);
        assert!(!error.message.contains("synthetic-secret"));
        task.join().unwrap();
    }
}

#[tokio::test]
async fn composer_retries_output_limit_once_and_respects_ceiling_and_failure_reason() {
    let incomplete = "data: {\"type\":\"response.incomplete\",\"response\":{\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n";
    let complete = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"complete plan\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n";
    let filtered = "data: {\"type\":\"response.incomplete\",\"response\":{\"incomplete_details\":{\"reason\":\"content_filter\"}}}\n\n";
    for (task_kind, ceiling, first, second, expected) in [
        (AiTask::CommitComposer, 128000, incomplete, Some(complete), "complete plan"),
        (AiTask::CommitComposer, 128000, incomplete, Some(incomplete), "AI_OUTPUT_TRUNCATED"),
        (AiTask::CommitComposer, 8192, incomplete, None, "AI_OUTPUT_TRUNCATED"),
        (AiTask::CodeReview, 128000, incomplete, None, "AI_OUTPUT_TRUNCATED"),
        (AiTask::CommitComposer, 128000, filtered, None, "AI_OUTPUT_TRUNCATED"),
        (AiTask::CommitComposer, 128000, "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"rejected\"}}}\n\n", None, "AI_PROVIDER_ERROR"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = vec![serve(&listener, first.into(), Fixture::default())];
            if let Some(body) = second { requests.push(serve(&listener, body.into(), Fixture::default())); }
            requests
        });
        let config = AiConfig {provider:"custom".into(),api_protocol:"responses".into(),api_url:url,model:"fixture".into(),max_output_tokens:ceiling,..Default::default()};
        let result = generate_for_task(&config,"key","s","i",&[],None,8192,task_kind,&CancellationToken::new(),&|_|{}).await;
        assert_eq!(match result {Ok(text)=>text,Err(err)=>err.code},expected);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(),if second.is_some(){2}else{1});
        assert_eq!(requests[0]["max_output_tokens"],8192);
        if second.is_some() {
            assert_eq!(requests[1]["max_output_tokens"],12288);
            assert_eq!(requests[0]["input"],requests[1]["input"]);
        }
    }
}

#[tokio::test]
async fn ai_transport_logs_real_success_rejection_and_cancellation_without_payloads_or_keys() {
    use super::super::models::AiRequest;
    use crate::logger::{with_test_logger, LogChannel, LogManager};
    let directory = tempfile::tempdir().unwrap();
    let logger = Arc::new(LogManager::new(directory.path().into()));
    for case in ["success", "rejected", "cancelled"] {
        let request:AiRequest=serde_json::from_value(json!({"requestId":case,"workspaceId":"workspace","task":"commit-message","repoId":"repository"})).unwrap();
        let body = if case == "rejected" {
            r#"{"error":{"message":"input must be an array: synthetic-secret"}}"#
        } else {
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"private-result\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"output_tokens\":20,\"output_tokens_details\":{\"reasoning_tokens\":10}}}}\n\n"
        };
        let (url, server) = fixture_server(
            body.into(),
            Fixture {
                status: if case == "rejected" {
                    "400 Bad Request"
                } else {
                    "200 OK"
                },
                content_type: if case == "rejected" {
                    "application/json"
                } else {
                    "text/event-stream"
                },
                delay_ms: if case == "cancelled" { 100 } else { 0 },
                ..Default::default()
            },
        );
        let config = AiConfig {
            provider: "custom".into(),
            api_protocol: "responses".into(),
            api_url: format!("{url}?access_token=synthetic-secret"),
            model: "fixture".into(),
            ..Default::default()
        };
        let token = CancellationToken::new();
        if case == "cancelled" {
            let cancel = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                cancel.cancel();
            });
        }
        let result = with_test_logger(
            logger.clone(),
            super::super::logging::with_request(
                &request,
                generate(
                    &config,
                    "synthetic-secret",
                    "private-system",
                    "private-input",
                    &[],
                    None,
                    4096,
                    &token,
                    &|_| {},
                ),
            ),
        )
        .await;
        let expected = match case {
            "success" => "private-result",
            "rejected" => "AI_HTTP_REJECTED",
            _ => "CANCELLED",
        };
        assert_eq!(
            match result {
                Ok(text) => text,
                Err(err) => err.code,
            },
            expected
        );
        server.join().unwrap();
    }
    logger.flush().unwrap();
    let logs = logger.get_entries(Some(LogChannel::Ai), None, None);
    for (request, message) in [
        ("success", "AI request completed"),
        ("rejected", "AI request failed"),
        ("cancelled", "AI request cancelled"),
    ] {
        let entry = logs.iter().find(|entry| entry.message == message).unwrap();
        assert!(entry.duration_ms.is_some());
        assert_eq!(
            entry.context.as_ref().unwrap().workspace_id.as_deref(),
            Some("workspace")
        );
        let detail: Value = serde_json::from_str(entry.details.as_deref().unwrap()).unwrap();
        assert_eq!(detail["requestId"], request);
        assert_eq!(detail["protocol"], "responses");
    }
    assert!(logs
        .iter()
        .any(|entry| entry.message == "AI response metadata"
            && entry
                .details
                .as_ref()
                .unwrap()
                .contains("reasoningTokenCount")));
    assert!(logs.iter().any(|entry| entry
        .details
        .as_deref()
        .unwrap_or("")
        .contains("HTTP 400: input must be an array")));
    let exported = directory.path().join("ai.log");
    logger.export_to_file(&exported).unwrap();
    let text = std::fs::read_to_string(exported).unwrap();
    for secret in [
        "synthetic-secret",
        "private-system",
        "private-input",
        "private-result",
        "access_token",
    ] {
        assert!(
            !text.contains(secret),
            "Unexpected secret or payload: {secret}"
        );
    }
}

#[tokio::test]
async fn responses_json_fallback_accepts_null_error_and_message_output() {
    let body = json!({"status":"completed","error":null,"output":[{"type":"message","content":[{"type":"output_text","text":"你好"}]}]});
    let (url, task) = server(body.to_string(), false, 0);
    let config = AiConfig {
        provider: "custom".into(),
        api_protocol: "responses".into(),
        api_url: url,
        model: "gpt-5.6-luna".into(),
        ..Default::default()
    };
    assert_eq!(
        generate(
            &config,
            "key",
            "s",
            "i",
            &[],
            None,
            4096,
            &CancellationToken::new(),
            &|_| {}
        )
        .await
        .unwrap(),
        "你好"
    );
    task.join().unwrap();
}
#[tokio::test]
async fn request_cancellation_interrupts_body_and_json_fallback_works() {
    let (url, task) = server(
        "{\"choices\":[{\"message\":{\"content\":\"fallback\"},\"finish_reason\":\"stop\"}]}"
            .into(),
        false,
        0,
    );
    let config = AiConfig {
        api_url: url,
        model: "fixture".into(),
        ..Default::default()
    };
    assert_eq!(
        generate(
            &config,
            "key",
            "s",
            "i",
            &[],
            None,
            1024,
            &CancellationToken::new(),
            &|_| {}
        )
        .await
        .unwrap(),
        "fallback"
    );
    task.join().unwrap();
    let (url, task) = server("data: [DONE]\n\n".into(), true, 150);
    let config = AiConfig {
        api_url: url,
        model: "fixture".into(),
        ..Default::default()
    };
    let token = CancellationToken::new();
    let cancel = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancel.cancel();
    });
    assert_eq!(
        generate(&config, "key", "s", "i", &[], None, 1024, &token, &|_| {})
            .await
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    task.join().unwrap();
}
