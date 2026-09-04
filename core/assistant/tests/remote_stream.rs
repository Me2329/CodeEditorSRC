//! Integration tests for the Claude client against a mock API.
//!
//! No credential is needed and no request leaves the machine: a local server
//! replays the exact server-sent-event shapes the Messages API produces. That
//! covers what the client actually has to get right - the request body, the
//! headers, incremental text and thinking deltas, usage accounting, refusal
//! detection and HTTP error reporting.

use codecraft_assistant::protocol::{ChatTurn, Effort};
use codecraft_assistant::remote::{Client, Credential, Event};

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;

/// A one-shot HTTP server. Returns its address and a channel carrying the
/// request it received, so a test can assert on what the client sent.
fn mock_api(status: u16, body: &'static str) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
    let address = listener.local_addr().expect("mock address");
    let (sender, receiver) = mpsc::channel();

    thread::spawn(move || {
        let Ok((stream, _)) = listener.accept() else {
            return;
        };
        let captured = serve(stream, status, body);
        let _ = sender.send(captured);
    });

    (format!("http://{address}"), receiver)
}

fn serve(mut stream: TcpStream, status: u16, body: &str) -> String {
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut captured = String::new();
    let mut content_length = 0usize;

    // Headers, up to the blank line.
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
        captured.push_str(&line);
    }

    if content_length > 0 {
        let mut payload = vec![0u8; content_length];
        if reader.read_exact(&mut payload).is_ok() {
            captured.push_str("\r\n");
            captured.push_str(&String::from_utf8_lossy(&payload));
        }
    }

    let reason = if status == 200 { "OK" } else { "Error" };
    let content_type = if status == 200 {
        "text/event-stream"
    } else {
        "application/json"
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    captured
}

/// A successful turn: thinking summary, two text chunks, usage and a clean stop.
const SUCCESS_STREAM: &str = concat!(
    "event: message_start\n",
    r#"data: {"type":"message_start","message":{"usage":{"input_tokens":1200}}}"#,
    "\n\n",
    "event: content_block_delta\n",
    r#"data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Checking the loop bounds."}}"#,
    "\n\n",
    "event: content_block_delta\n",
    r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The loop "}}"#,
    "\n\n",
    "event: content_block_delta\n",
    r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"is off by one."}}"#,
    "\n\n",
    "event: ping\n",
    r#"data: {"type":"ping"}"#,
    "\n\n",
    "event: message_delta\n",
    r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":340}}"#,
    "\n\n",
    "event: message_stop\n",
    r#"data: {"type":"message_stop"}"#,
    "\n\n",
);

/// A refusal: HTTP 200, with the reason carried in stop_details.
const REFUSAL_STREAM: &str = concat!(
    "event: message_start\n",
    r#"data: {"type":"message_start","message":{"usage":{"input_tokens":50}}}"#,
    "\n\n",
    "event: message_delta\n",
    r#"data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"Declined."}},"usage":{"output_tokens":0}}"#,
    "\n\n",
);

const MID_STREAM_ERROR: &str = concat!(
    "event: error\n",
    r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
    "\n\n",
);

fn user_turn(text: &str) -> Vec<ChatTurn> {
    vec![ChatTurn {
        role: "user".to_string(),
        content: text.to_string(),
    }]
}

fn client_for(url: String) -> Client {
    Client::new("claude-mythos-5-1".into()).with_base_url(url)
}

#[test]
fn streams_text_and_thinking_then_reports_usage_and_cost() {
    let (url, requests) = mock_api(200, SUCCESS_STREAM);
    let client = client_for(url);

    let mut text = String::new();
    let mut thinking = String::new();
    let mut usage = None;

    client
        .stream_chat(
            &Credential::ApiKey("test-key".into()),
            "system prompt",
            &user_turn("why is this wrong?"),
            Effort::High,
            |event| {
                match event {
                    Event::Text(chunk) => text.push_str(&chunk),
                    Event::Thinking(chunk) => thinking.push_str(&chunk),
                    Event::Done { usage: u, .. } => usage = Some(u),
                }
                Ok(())
            },
        )
        .expect("stream should succeed");

    assert_eq!(text, "The loop is off by one.");
    assert_eq!(thinking, "Checking the loop bounds.");

    let usage = usage.expect("a done frame carries usage");
    assert_eq!(usage.input_tokens, 1200);
    assert_eq!(usage.output_tokens, 340);
    // 1200 in at $10/MTok plus 340 out at $50/MTok, expressed in cents.
    let expected = (1200.0 * 10.0 + 340.0 * 50.0) / 1_000_000.0 * 100.0;
    assert!((usage.cost_cents - expected).abs() < 1e-9);

    let request = requests.recv().expect("captured request");
    assert!(request.contains("x-api-key: test-key"));
    assert!(request.contains("anthropic-version: 2023-06-01"));
    assert!(request.contains("server-side-fallback-2026-07-01"));
}

#[test]
fn request_body_matches_the_models_requirements() {
    let (url, requests) = mock_api(200, SUCCESS_STREAM);
    let client = client_for(url);

    client
        .stream_chat(
            &Credential::ApiKey("k".into()),
            "sys",
            &user_turn("hello"),
            Effort::Xhigh,
            |_| Ok(()),
        )
        .expect("stream should succeed");

    let request = requests.recv().expect("captured request");
    let body_start = request.find("{\"").expect("json body");
    let body: serde_json::Value =
        serde_json::from_str(&request[body_start..]).expect("valid json body");

    assert_eq!(body["model"], "claude-mythos-5-1");
    assert_eq!(body["stream"], true);
    // Thinking is always on for this model: adaptive, never a token budget.
    assert_eq!(body["thinking"]["type"], "adaptive");
    assert_eq!(body["thinking"]["display"], "summarized");
    assert!(body["thinking"].get("budget_tokens").is_none());
    // Depth is controlled by effort instead.
    assert_eq!(body["output_config"]["effort"], "xhigh");
    // Refusals are rerouted rather than surfacing as a dead end.
    assert_eq!(body["fallbacks"], "default");
    // No assistant prefill: the last turn must be the user's.
    let messages = body["messages"].as_array().expect("messages array");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "user");
}

#[test]
fn oauth_credentials_use_a_bearer_header_and_the_oauth_beta() {
    let (url, requests) = mock_api(200, SUCCESS_STREAM);
    let client = client_for(url);

    client
        .stream_chat(
            &Credential::OAuth("token-123".into()),
            "sys",
            &user_turn("hi"),
            Effort::Low,
            |_| Ok(()),
        )
        .expect("stream should succeed");

    let request = requests.recv().expect("captured request");
    assert!(request.contains("authorization: Bearer token-123"));
    assert!(request.contains("oauth-2025-04-20"));
    assert!(!request.contains("x-api-key"));
}

#[test]
fn a_refusal_is_reported_rather_than_returned_as_an_empty_answer() {
    let (url, _requests) = mock_api(200, REFUSAL_STREAM);
    let client = client_for(url);

    let error = client
        .stream_chat(
            &Credential::ApiKey("k".into()),
            "sys",
            &user_turn("something declined"),
            Effort::High,
            |_| Ok(()),
        )
        .expect_err("a refusal must surface as an error");

    assert!(error.contains("declined"), "got: {error}");
    assert!(error.contains("cyber"), "got: {error}");
}

#[test]
fn a_mid_stream_error_stops_the_turn() {
    let (url, _requests) = mock_api(200, MID_STREAM_ERROR);
    let client = client_for(url);

    let error = client
        .stream_chat(
            &Credential::ApiKey("k".into()),
            "sys",
            &user_turn("hi"),
            Effort::High,
            |_| Ok(()),
        )
        .expect_err("a mid-stream error must surface");

    assert!(error.contains("Overloaded"), "got: {error}");
}

#[test]
fn an_http_error_explains_what_to_do_about_it() {
    let (url, _requests) = mock_api(
        404,
        r#"{"error":{"message":"model not found for this account"}}"#,
    );
    let client = client_for(url);

    let error = client
        .stream_chat(
            &Credential::ApiKey("k".into()),
            "sys",
            &user_turn("hi"),
            Effort::High,
            |_| Ok(()),
        )
        .expect_err("a 404 must surface");

    assert!(error.contains("Project Glasswing"), "got: {error}");
    assert!(error.contains("claude-opus-5"), "got: {error}");
}

#[test]
fn a_conversation_with_no_user_turn_is_rejected_before_any_request() {
    // Port 1 is unreachable; the request must be refused before it is attempted.
    let client = client_for("http://127.0.0.1:1".to_string());

    let error = client
        .stream_chat(
            &Credential::ApiKey("k".into()),
            "sys",
            &[],
            Effort::High,
            |_| Ok(()),
        )
        .expect_err("an empty conversation must be rejected");

    assert!(error.contains("no user message"), "got: {error}");
}
