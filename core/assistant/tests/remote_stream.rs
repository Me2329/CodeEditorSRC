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

/// A successful turn: a signed thinking block then text, with the block
/// lifecycle the real API sends.
const SUCCESS_STREAM: &str = concat!(
    "event: message_start\n",
    r#"data: {"type":"message_start","message":{"usage":{"input_tokens":1200}}}"#,
    "\n\n",
    "event: content_block_start\n",
    r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
    "\n\n",
    "event: content_block_delta\n",
    r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Checking the loop bounds."}}"#,
    "\n\n",
    "event: content_block_delta\n",
    r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}"#,
    "\n\n",
    "event: content_block_stop\n",
    r#"data: {"type":"content_block_stop","index":0}"#,
    "\n\n",
    "event: content_block_start\n",
    r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
    "\n\n",
    "event: content_block_delta\n",
    r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The loop "}}"#,
    "\n\n",
    "event: content_block_delta\n",
    r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"is off by one."}}"#,
    "\n\n",
    "event: content_block_stop\n",
    r#"data: {"type":"content_block_stop","index":1}"#,
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

/// A turn that requests two tools at once, one with streamed JSON arguments and
/// one with none at all.
const TOOL_STREAM: &str = concat!(
    "event: message_start\n",
    r#"data: {"type":"message_start","message":{"usage":{"input_tokens":900}}}"#,
    "\n\n",
    "event: content_block_start\n",
    r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
    "\n\n",
    "event: content_block_delta\n",
    r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-xyz"}}"#,
    "\n\n",
    "event: content_block_stop\n",
    r#"data: {"type":"content_block_stop","index":0}"#,
    "\n\n",
    "event: content_block_start\n",
    r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}"#,
    "\n\n",
    "event: content_block_delta\n",
    r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
    "\n\n",
    "event: content_block_delta\n",
    r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"main.py\"}"}}"#,
    "\n\n",
    "event: content_block_stop\n",
    r#"data: {"type":"content_block_stop","index":1}"#,
    "\n\n",
    "event: content_block_start\n",
    r#"data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_2","name":"list_files","input":{}}}"#,
    "\n\n",
    "event: content_block_stop\n",
    r#"data: {"type":"content_block_stop","index":2}"#,
    "\n\n",
    "event: message_delta\n",
    r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":120}}"#,
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
                    _ => {}
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


// ---------------------------------------------------------------------------
// Tool use
// ---------------------------------------------------------------------------

fn tool_schema(name: &str) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "description": "test tool",
        "strict": true,
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

#[test]
fn assembles_streamed_tool_calls_including_one_with_no_arguments() {
    let (url, _requests) = mock_api(200, TOOL_STREAM);
    let client = client_for(url);

    let mut started = Vec::new();
    let mut ready = Vec::new();

    let turn = client
        .stream_turn(
            &Credential::ApiKey("k".into()),
            "sys",
            &[serde_json::json!({"role": "user", "content": "read main.py"})],
            &[tool_schema("read_file"), tool_schema("list_files")],
            Effort::High,
            |event| {
                match event {
                    Event::ToolStarted { name, .. } => started.push(name),
                    Event::ToolReady { name, input, .. } => ready.push((name, input)),
                    _ => {}
                }
                Ok(())
            },
        )
        .expect("stream should succeed");

    assert_eq!(started, vec!["read_file", "list_files"]);
    assert_eq!(turn.stop_reason, "tool_use");
    assert_eq!(turn.tool_calls.len(), 2);

    // Arguments streamed as JSON fragments must reassemble exactly.
    assert_eq!(turn.tool_calls[0].name, "read_file");
    assert_eq!(turn.tool_calls[0].input["path"], "main.py");
    assert_eq!(turn.tool_calls[0].id, "toolu_1");

    // A tool with no arguments is an empty object, not a parse failure.
    assert_eq!(turn.tool_calls[1].name, "list_files");
    assert_eq!(turn.tool_calls[1].input, serde_json::json!({}));

    assert_eq!(ready.len(), 2);
}

#[test]
fn thinking_blocks_come_back_whole_for_replay() {
    // A thinking block's signature binds it to the conversation prefix, so the
    // turn must be replayable byte for byte in the next request.
    let (url, _requests) = mock_api(200, TOOL_STREAM);
    let client = client_for(url);

    let turn = client
        .stream_turn(
            &Credential::ApiKey("k".into()),
            "sys",
            &[serde_json::json!({"role": "user", "content": "go"})],
            &[tool_schema("read_file")],
            Effort::High,
            |_| Ok(()),
        )
        .expect("stream should succeed");

    let thinking = turn
        .content
        .iter()
        .find(|block| block["type"] == "thinking")
        .expect("the turn carries a thinking block");
    assert_eq!(thinking["signature"], "sig-xyz");

    // Blocks stay in the order the model produced them.
    let kinds: Vec<&str> = turn
        .content
        .iter()
        .map(|block| block["type"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(kinds, vec!["thinking", "tool_use", "tool_use"]);
}

#[test]
fn a_tool_request_never_forces_tool_choice() {
    // Forced tool choice is rejected on this model class, so the request must
    // offer the tools and leave the decision to the model.
    let (url, requests) = mock_api(200, TOOL_STREAM);
    let client = client_for(url);

    client
        .stream_turn(
            &Credential::ApiKey("k".into()),
            "sys",
            &[serde_json::json!({"role": "user", "content": "go"})],
            &[tool_schema("read_file")],
            Effort::High,
            |_| Ok(()),
        )
        .expect("stream should succeed");

    let request = requests.recv().expect("captured request");
    let body: serde_json::Value =
        serde_json::from_str(&request[request.find("{\"").expect("json body")..])
            .expect("valid json body");

    assert_eq!(body["tool_choice"]["type"], "auto");
    assert_eq!(body["tools"][0]["strict"], true);
    assert_eq!(body["tools"][0]["input_schema"]["additionalProperties"], false);
    // Stale tool output is cleared rather than the transcript being edited.
    assert_eq!(
        body["context_management"]["edits"][0]["type"],
        "clear_tool_uses_20250919"
    );
    assert!(request.contains("context-management-2025-06-27"));
}

#[test]
fn a_plain_chat_request_offers_no_tools() {
    let (url, requests) = mock_api(200, SUCCESS_STREAM);
    let client = client_for(url);

    client
        .stream_chat(
            &Credential::ApiKey("k".into()),
            "sys",
            &user_turn("hello"),
            Effort::High,
            |_| Ok(()),
        )
        .expect("stream should succeed");

    let request = requests.recv().expect("captured request");
    let body: serde_json::Value =
        serde_json::from_str(&request[request.find("{\"").expect("json body")..])
            .expect("valid json body");

    assert!(body.get("tools").is_none());
    assert!(body.get("tool_choice").is_none());
}
