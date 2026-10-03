use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};
fn server(body: String, sse: bool, delay_ms: u64) -> (String, std::thread::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = std::thread::spawn(move || {
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
        let headers = String::from_utf8_lossy(&raw[..end]);
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
        let request = serde_json::from_slice(&raw[end..end + length]).unwrap();
        let header=format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",if sse{"text/event-stream"}else{"application/json"},body.len());
        stream.write_all(header.as_bytes()).unwrap();
        std::thread::sleep(Duration::from_millis(delay_ms));
        // Intentionally split UTF-8 characters and SSE delimiters across network frames.
        for piece in body.as_bytes().chunks(2) {
            if stream.write_all(piece).is_err() {
                break;
            }
            let _ = stream.flush();
        }
        request
    });
    (url, task)
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
        if protocol=="responses"{assert_eq!(request["store"],false);assert_eq!(request["max_output_tokens"],4096);}else{assert_eq!(request["max_tokens"],4096);}
    }
}
#[tokio::test]
async fn rejects_truncation_disconnect_and_redacts_stream_error() {
    for (body,code) in [
        ("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}\n\n","AI_OUTPUT_TRUNCATED"),
        ("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n","AI_STREAM_INTERRUPTED"),
        ("data: {\"error\":{\"message\":\"synthetic-secret\"}}\n\n","AI_PROVIDER_ERROR"),
    ] {let(url,task)=server(body.into(),true,0);let config=AiConfig{api_url:url,model:"fixture".into(),..Default::default()};let e=generate(&config,"synthetic-secret","s","i",&[],None,1024,&CancellationToken::new(),&|_|{}).await.unwrap_err();assert_eq!(e.code,code);assert!(!e.message.contains("synthetic-secret"));task.join().unwrap();}
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
