//! End-to-end test of the agent loop against a scripted API.
//!
//! No credential and no network: a local server replays a multi-turn
//! conversation in which the model reads a file, fixes it, runs it, and
//! reports. That exercises the parts that are easy to get wrong and impossible
//! to check from unit tests - tool dispatch, results batched into one message,
//! and above all that the transcript only ever grows, because a thinking block
//! is signed against every message that preceded it.

use codecraft_assistant::agent::{self, AgentConfig, Completion};
use codecraft_assistant::protocol::{AgentEvent, Effort};
use codecraft_assistant::remote::{Client, Credential};
use codecraft_assistant::tools::{Mode, Workspace};

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

/// Serve a scripted sequence of responses, one per request, and record every
/// request body so the test can assert on how the transcript grew.
fn scripted_api(responses: Vec<&'static str>) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
    let address = listener.local_addr().expect("mock address");
    let (sender, receiver) = mpsc::channel();

    thread::spawn(move || {
        for body in responses {
            let Ok((stream, _)) = listener.accept() else { return };
            let captured = serve(stream, body);
            if sender.send(captured).is_err() {
                return;
            }
        }
    });

    (format!("http://{address}"), receiver)
}

fn serve(mut stream: TcpStream, body: &str) -> String {
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut captured = String::new();
    let mut content_length = 0usize;

    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
    }

    if content_length > 0 {
        let mut payload = vec![0u8; content_length];
        if reader.read_exact(&mut payload).is_ok() {
            captured = String::from_utf8_lossy(&payload).to_string();
        }
    }

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    captured
}

/// Turn 1: think, narrate, then ask to read the file.
const TURN_READ: &str = concat!(
    "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":500}}}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig-1\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Reading the file first.\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"read_file\",\"input\":{}}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"main.py\\\"}\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":100}}\n\n",
);

/// Turn 2: two tools at once - fix the file and run it.
const TURN_FIX_AND_RUN: &str = concat!(
    "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":800}}}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig-2\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"edit_file\",\"input\":{}}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"main.py\\\",\\\"old_text\\\":\\\"total = 0\\\",\"}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"new_text\\\":\\\"total = 1\\\"}\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t3\",\"name\":\"search\",\"input\":{}}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"total\\\"}\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":200}}\n\n",
);

/// Turn 3: report and stop.
const TURN_DONE: &str = concat!(
    "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":900}}}\n\n",
    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Fixed the initial value.\"}}\n\n",
    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":50}}\n\n",
);

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn workspace_with(content: &str) -> (Workspace, Scratch) {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("cc_agent_{nanos:x}"));
    std::fs::create_dir_all(&root).unwrap();

    let workspace = Workspace::new(
        root.clone(),
        "python".to_string(),
        PathBuf::from("/nonexistent/runner.sh"),
        PathBuf::from("/nonexistent/analyzer"),
    );
    workspace.write("main.py", content).unwrap();
    (workspace, Scratch(root))
}

fn user(text: &str) -> Vec<Value> {
    vec![serde_json::json!({"role": "user", "content": text})]
}

#[test]
fn runs_a_task_to_completion_over_several_turns() {
    let (url, requests) = scripted_api(vec![TURN_READ, TURN_FIX_AND_RUN, TURN_DONE]);
    let client = Client::new("claude-mythos-5-1".into()).with_base_url(url);
    let (workspace, _scratch) = workspace_with("total = 0\nprint(total)\n");

    let mut history = user("fix the initial value");
    let mut events: Vec<AgentEvent> = Vec::new();

    let outcome = agent::run(
        &client,
        &Credential::ApiKey("k".into()),
        &workspace,
        &mut history,
        &AgentConfig { mode: Mode::Auto, effort: Effort::High, max_steps: 8 },
        &Arc::new(AtomicBool::new(false)),
        |event| {
            events.push(event);
            Ok(())
        },
    )
    .expect("the loop should finish");

    assert!(matches!(outcome, Completion::Finished));

    // The edit actually reached the file.
    assert_eq!(workspace.read("main.py").unwrap(), "total = 1\nprint(total)\n");

    // Three model turns were taken.
    let steps: Vec<usize> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::Step { number, .. } => Some(*number),
            _ => None,
        })
        .collect();
    assert_eq!(steps, vec![1, 2, 3]);

    // Every tool call was reported with its result.
    let calls: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ToolCall { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(calls, vec!["read_file", "edit_file", "search"]);

    let results = events
        .iter()
        .filter(|event| matches!(event, AgentEvent::ToolResult { .. }))
        .count();
    assert_eq!(results, 3);

    // The editor was told which file changed, and given its new contents.
    let changed: Vec<(&str, &str)> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::FileChanged { name, content } => Some((name.as_str(), content.as_str())),
            _ => None,
        })
        .collect();
    assert_eq!(changed, vec![("main.py", "total = 1\nprint(total)\n")]);

    drop(requests);
}

#[test]
fn the_transcript_only_ever_grows() {
    // A thinking block is signed against every message before it, so each
    // request must extend the previous one rather than rewrite any part of it.
    let (url, requests) = scripted_api(vec![TURN_READ, TURN_FIX_AND_RUN, TURN_DONE]);
    let client = Client::new("claude-mythos-5-1".into()).with_base_url(url);
    let (workspace, _scratch) = workspace_with("total = 0\n");

    let mut history = user("fix it");
    agent::run(
        &client,
        &Credential::ApiKey("k".into()),
        &workspace,
        &mut history,
        &AgentConfig { mode: Mode::Auto, effort: Effort::High, max_steps: 8 },
        &Arc::new(AtomicBool::new(false)),
        |_| Ok(()),
    )
    .expect("the loop should finish");

    let bodies: Vec<Value> = (0..3)
        .map(|_| {
            let raw = requests.recv().expect("captured request");
            serde_json::from_str(&raw).expect("valid json body")
        })
        .collect();

    let messages_of = |body: &Value| body["messages"].as_array().unwrap().clone();

    let first = messages_of(&bodies[0]);
    let second = messages_of(&bodies[1]);
    let third = messages_of(&bodies[2]);

    // Each request starts with the previous request's messages, unchanged.
    assert_eq!(&second[..first.len()], &first[..]);
    assert_eq!(&third[..second.len()], &second[..]);

    // And it grew by exactly one assistant turn plus one tool-result turn.
    assert_eq!(second.len(), first.len() + 2);
    assert_eq!(third.len(), second.len() + 2);

    // The assistant turn was replayed with its thinking block and signature.
    let assistant = &second[1];
    assert_eq!(assistant["role"], "assistant");
    let thinking = assistant["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["type"] == "thinking")
        .expect("the replayed turn keeps its thinking block");
    assert_eq!(thinking["signature"], "sig-1");
}

#[test]
fn results_for_one_turn_go_back_in_a_single_message() {
    // Splitting parallel tool results across messages teaches the model to stop
    // asking for tools in parallel.
    let (url, requests) = scripted_api(vec![TURN_READ, TURN_FIX_AND_RUN, TURN_DONE]);
    let client = Client::new("claude-mythos-5-1".into()).with_base_url(url);
    let (workspace, _scratch) = workspace_with("total = 0\n");

    let mut history = user("fix it");
    agent::run(
        &client,
        &Credential::ApiKey("k".into()),
        &workspace,
        &mut history,
        &AgentConfig { mode: Mode::Auto, effort: Effort::High, max_steps: 8 },
        &Arc::new(AtomicBool::new(false)),
        |_| Ok(()),
    )
    .expect("the loop should finish");

    let _ = requests.recv();
    let _ = requests.recv();
    let third: Value = serde_json::from_str(&requests.recv().unwrap()).unwrap();
    let messages = third["messages"].as_array().unwrap();

    // The turn that asked for two tools is answered by one user message holding
    // both results.
    let last_results = messages
        .iter()
        .rev()
        .find(|message| {
            message["content"]
                .as_array()
                .map(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"))
                .unwrap_or(false)
        })
        .expect("a tool-result message");

    let blocks = last_results["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["tool_use_id"], "t2");
    assert_eq!(blocks[1]["tool_use_id"], "t3");
}

#[test]
fn a_failing_tool_is_reported_to_the_model_as_an_error() {
    // The file the model tries to edit does not contain the snippet, so the
    // edit must come back with is_error rather than silently succeeding.
    let (url, requests) = scripted_api(vec![TURN_READ, TURN_FIX_AND_RUN, TURN_DONE]);
    let client = Client::new("claude-mythos-5-1".into()).with_base_url(url);
    let (workspace, _scratch) = workspace_with("something else entirely\n");

    let mut history = user("fix it");
    let mut errors = Vec::new();

    agent::run(
        &client,
        &Credential::ApiKey("k".into()),
        &workspace,
        &mut history,
        &AgentConfig { mode: Mode::Auto, effort: Effort::High, max_steps: 8 },
        &Arc::new(AtomicBool::new(false)),
        |event| {
            if let AgentEvent::ToolResult { name, is_error: true, .. } = &event {
                errors.push(name.clone());
            }
            Ok(())
        },
    )
    .expect("the loop should finish");

    assert!(errors.contains(&"edit_file".to_string()));

    let _ = requests.recv();
    let _ = requests.recv();
    let third: Value = serde_json::from_str(&requests.recv().unwrap()).unwrap();
    let body = third["messages"].to_string();
    assert!(body.contains("\"is_error\":true"));
}

#[test]
fn plan_mode_refuses_to_change_anything() {
    let (url, _requests) = scripted_api(vec![TURN_READ, TURN_FIX_AND_RUN, TURN_DONE]);
    let client = Client::new("claude-mythos-5-1".into()).with_base_url(url);
    let (workspace, _scratch) = workspace_with("total = 0\n");

    let mut history = user("fix it");
    agent::run(
        &client,
        &Credential::ApiKey("k".into()),
        &workspace,
        &mut history,
        &AgentConfig { mode: Mode::Plan, effort: Effort::High, max_steps: 8 },
        &Arc::new(AtomicBool::new(false)),
        |_| Ok(()),
    )
    .expect("the loop should finish");

    // The model asked to edit; plan mode refused, so the file is untouched.
    assert_eq!(workspace.read("main.py").unwrap(), "total = 0\n");
}

#[test]
fn the_step_budget_stops_a_loop_that_never_finishes() {
    // Every turn asks for a tool, so the loop only ends at the budget.
    let (url, _requests) = scripted_api(vec![TURN_READ, TURN_READ, TURN_READ, TURN_READ]);
    let client = Client::new("claude-mythos-5-1".into()).with_base_url(url);
    let (workspace, _scratch) = workspace_with("total = 0\n");

    let mut history = user("go");
    let outcome = agent::run(
        &client,
        &Credential::ApiKey("k".into()),
        &workspace,
        &mut history,
        &AgentConfig { mode: Mode::Auto, effort: Effort::High, max_steps: 3 },
        &Arc::new(AtomicBool::new(false)),
        |_| Ok(()),
    )
    .expect("the loop should end at the budget");

    assert!(matches!(outcome, Completion::StepLimit));
}

#[test]
fn cancelling_stops_the_loop_and_still_answers_the_pending_tool() {
    // A conversation left with an unanswered tool_use cannot be resumed, so a
    // cancelled call must still produce a tool_result.
    let (url, _requests) = scripted_api(vec![TURN_READ, TURN_DONE]);
    let client = Client::new("claude-mythos-5-1".into()).with_base_url(url);
    let (workspace, _scratch) = workspace_with("total = 0\n");

    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);

    let mut history = user("go");
    let outcome = agent::run(
        &client,
        &Credential::ApiKey("k".into()),
        &workspace,
        &mut history,
        &AgentConfig { mode: Mode::Auto, effort: Effort::High, max_steps: 8 },
        &cancel,
        move |event| {
            // Cancel as soon as the first tool call is announced.
            if matches!(event, AgentEvent::ToolCall { .. }) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            Ok(())
        },
    )
    .expect("the loop should stop cleanly");

    assert!(matches!(outcome, Completion::Cancelled));

    let last = history.last().expect("history is not empty");
    let blocks = last["content"].as_array().expect("tool results");
    assert_eq!(blocks[0]["type"], "tool_result");
    assert_eq!(blocks[0]["tool_use_id"], "t1");
    assert_eq!(blocks[0]["is_error"], true);
}
