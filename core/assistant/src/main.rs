//! CodeCraft Studio assistant daemon.
//!
//! Two engines behind one socket:
//!
//!   * A local engine that answers from a workspace index in microseconds. It
//!     never touches the network, so completion, outline and go-to-definition
//!     are instant and work offline.
//!   * Claude Mythos 5.1 for everything that genuinely needs reasoning, streamed
//!     token by token so the first words appear immediately.
//!
//! The router picks between them per request. A question the index answers
//! exactly is answered locally; anything open-ended goes to the model.
//!
//! Usage:
//!   codecraft-assistant [--socket PATH] [--model ID]

use codecraft_assistant::{agent, index, local, protocol, remote, tools};

use index::Index;
use protocol::{AgentEvent, Frame, Request, Route};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_REQUEST_BYTES: u64 = 8 * 1024 * 1024;

/// Sent as the system prompt. It states what the model is working on and asks
/// for the output shape an editor panel can actually use.
const SYSTEM_PROMPT: &str = "\
You are the coding assistant inside CodeCraft Studio, an IDE that compiles and \
runs code in isolated sandboxes across more than 40 language runtimes.

The user's current workspace is given below. Ground every answer in it: refer to \
their actual file names, symbols and line numbers rather than inventing an \
example. When you supply code, put it in a fenced block tagged with the language \
so the panel can offer to apply it, and give the target file name on the line \
before the block when you mean an existing file.

Be direct. Lead with the answer, then the reasoning if it is needed. If the code \
has a bug, say what it is and what it does at runtime. If something in the \
workspace is missing and you cannot see it, say so rather than guessing.";

struct Config {
    socket: PathBuf,
    model: String,
}

impl Config {
    fn from_args() -> Result<Self, String> {
        let mut config = Config {
            socket: PathBuf::from(
                std::env::var("CODECRAFT_ASSISTANT_SOCKET")
                    .unwrap_or_else(|_| "/run/codecraft/assistant.sock".to_string()),
            ),
            model: std::env::var("CODECRAFT_ASSISTANT_MODEL")
                .unwrap_or_else(|_| remote::DEFAULT_MODEL.to_string()),
        };

        let args: Vec<String> = std::env::args().skip(1).collect();
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--socket" => {
                    config.socket = PathBuf::from(
                        args.get(i + 1).ok_or("--socket requires a value")?.clone(),
                    );
                    i += 2;
                }
                "--model" => {
                    config.model = args.get(i + 1).ok_or("--model requires a value")?.clone();
                    i += 2;
                }
                "--version" => {
                    println!("codecraft-assistant {VERSION}");
                    process::exit(0);
                }
                "--help" | "-h" => {
                    print_usage();
                    process::exit(0);
                }
                other => return Err(format!("unknown argument '{other}'")),
            }
        }
        Ok(config)
    }
}

fn print_usage() {
    println!(
        "CodeCraft Studio assistant {VERSION}\n\n\
         Usage: codecraft-assistant [options]\n\n\
         Options:\n  \
         --socket PATH   Unix socket to listen on\n  \
         --model ID      Model for remote requests (default: {})\n  \
         --version       Print the version and exit\n\n\
         The local engine needs no credentials and works offline. Remote requests \
         use ANTHROPIC_API_KEY, or an OAuth profile from `ant auth login`.\n",
        remote::DEFAULT_MODEL
    );
}

fn main() {
    let config = match Config::from_args() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("[assistant] {message}");
            print_usage();
            process::exit(64);
        }
    };

    if let Some(parent) = config.socket.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[assistant] cannot create {}: {e}", parent.display());
            process::exit(73);
        }
    }
    let _ = std::fs::remove_file(&config.socket);

    let listener = match UnixListener::bind(&config.socket) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[assistant] cannot bind {}: {e}", config.socket.display());
            process::exit(73);
        }
    };
    restrict_socket(&config.socket);

    let credential = remote::resolve_credential();
    eprintln!(
        "[assistant] listening on {} | model {} | remote {}",
        config.socket.display(),
        config.model,
        if credential.is_some() {
            "available"
        } else {
            "unavailable (local engine only)"
        }
    );

    let client = Arc::new(remote::Client::new(config.model.clone()));

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let client = Arc::clone(&client);
                thread::spawn(move || {
                    if let Err(e) = handle(stream, &client) {
                        eprintln!("[assistant] connection ended: {e}");
                    }
                });
            }
            Err(e) => eprintln!("[assistant] accept failed: {e}"),
        }
    }
}

fn restrict_socket(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

fn handle(stream: UnixStream, client: &remote::Client) -> std::io::Result<()> {
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream).take(MAX_REQUEST_BYTES);

    let mut line = String::new();
    let read_result = reader.read_line(&mut line);

    let send = |writer: &mut UnixStream, frame: Frame| -> std::io::Result<()> {
        let encoded = serde_json::to_string(&frame).unwrap_or_else(|_| {
            r#"{"type":"error","message":"could not encode a response frame"}"#.to_string()
        });
        writer.write_all(encoded.as_bytes())?;
        writer.write_all(b"\n")?;
        writer.flush()
    };

    if read_result.is_err() {
        send(
            &mut writer,
            Frame::Error {
                message: "request is not valid UTF-8".to_string(),
            },
        )?;
        let _ = writer.shutdown(Shutdown::Both);
        return Ok(());
    }

    let request: Request = match serde_json::from_str(line.trim_end()) {
        Ok(request) => request,
        Err(e) => {
            send(
                &mut writer,
                Frame::Error {
                    message: format!("could not parse the request: {e}"),
                },
            )?;
            let _ = writer.shutdown(Shutdown::Both);
            return Ok(());
        }
    };

    let started = Instant::now();

    match request {
        Request::Health => {
            let credential = remote::resolve_credential();
            send(
                &mut writer,
                Frame::Health {
                    version: VERSION,
                    model: client.model().to_string(),
                    remote_available: credential.is_some(),
                    remote_reason: match credential {
                        Some(_) => "credential resolved".to_string(),
                        None => "no ANTHROPIC_API_KEY and no `ant auth login` profile"
                            .to_string(),
                    },
                },
            )?;
        }

        Request::Symbols { workspace } => {
            let index = Index::build(&workspace.language, &workspace.files);
            send(
                &mut writer,
                Frame::Symbols {
                    items: index.symbols,
                },
            )?;
            send(
                &mut writer,
                Frame::Done {
                    usage: None,
                    elapsed_ms: started.elapsed().as_millis(),
                },
            )?;
        }

        Request::Complete {
            workspace,
            prefix,
            limit,
        } => {
            let index = Index::build(&workspace.language, &workspace.files);
            let items = local::complete(&index, &prefix, limit.clamp(1, 200));
            send(&mut writer, Frame::Completions { items })?;
            send(
                &mut writer,
                Frame::Done {
                    usage: None,
                    elapsed_ms: started.elapsed().as_millis(),
                },
            )?;
        }

        Request::Explain { workspace, symbol } => {
            let index = Index::build(&workspace.language, &workspace.files);
            let text = local::explain(&index, &workspace, &symbol);
            send(
                &mut writer,
                Frame::Routed {
                    engine: "local",
                    model: "index".to_string(),
                },
            )?;
            send(&mut writer, Frame::Delta { text })?;
            send(
                &mut writer,
                Frame::Done {
                    usage: None,
                    elapsed_ms: started.elapsed().as_millis(),
                },
            )?;
        }

        Request::Agent {
            messages,
            workspace,
            mode,
            effort,
            max_steps,
        } => {
            let Some(credential) = remote::resolve_credential() else {
                send(
                    &mut writer,
                    Frame::Error {
                        message: "The agent needs a Claude credential. Set ANTHROPIC_API_KEY \
                                  or run `ant auth login`, then restart the assistant."
                            .to_string(),
                    },
                )?;
                let _ = writer.shutdown(Shutdown::Both);
                return Ok(());
            };

            let mode = match mode.as_str() {
                "plan" => tools::Mode::Plan,
                _ => tools::Mode::Auto,
            };

            // The agent works in its own directory, so a failed task cannot
            // leave the user's editor half-edited: changes reach the editor
            // only through the file events this loop emits.
            let scratch = match AgentWorkspace::create(&workspace) {
                Ok(scratch) => scratch,
                Err(e) => {
                    send(&mut writer, Frame::Error { message: e })?;
                    let _ = writer.shutdown(Shutdown::Both);
                    return Ok(());
                }
            };

            send(
                &mut writer,
                Frame::Routed {
                    engine: "agent",
                    model: client.model().to_string(),
                },
            )?;

            // A second reader watches for a cancel frame while the loop runs.
            let cancel = Arc::new(AtomicBool::new(false));
            let watcher = spawn_cancel_watcher(reader, Arc::clone(&cancel));

            let mut conversation: Vec<serde_json::Value> = messages
                .iter()
                .filter(|turn| turn.role == "user" || turn.role == "assistant")
                .map(|turn| serde_json::json!({"role": turn.role, "content": turn.content}))
                .collect();

            let config = agent::AgentConfig {
                mode,
                effort,
                max_steps: max_steps.clamp(1, 60),
            };

            let mut steps = 0usize;
            let mut total_cost = 0.0f64;

            let outcome = agent::run(
                client,
                &credential,
                scratch.workspace(),
                &mut conversation,
                &config,
                &cancel,
                |event| {
                    if let AgentEvent::Step { number, .. } = &event {
                        steps = *number;
                    }
                    if let AgentEvent::TurnUsage { usage } = &event {
                        total_cost += usage.cost_cents;
                    }
                    let encoded = serde_json::to_string(&event)
                        .map_err(|e| format!("could not encode an agent event: {e}"))?;
                    writer
                        .write_all(encoded.as_bytes())
                        .and_then(|_| writer.write_all(b"\n"))
                        .and_then(|_| writer.flush())
                        .map_err(|e| e.to_string())
                },
            );

            cancel.store(true, Ordering::Relaxed);
            drop(watcher);

            let final_event = match outcome {
                Ok(agent::Completion::Finished) => AgentEvent::Finished {
                    reason: "finished".to_string(),
                    steps,
                    elapsed_ms: started.elapsed().as_millis(),
                    total_cost_cents: total_cost,
                },
                Ok(agent::Completion::StepLimit) => AgentEvent::Finished {
                    reason: "step_limit".to_string(),
                    steps,
                    elapsed_ms: started.elapsed().as_millis(),
                    total_cost_cents: total_cost,
                },
                Ok(agent::Completion::Cancelled) => AgentEvent::Finished {
                    reason: "cancelled".to_string(),
                    steps,
                    elapsed_ms: started.elapsed().as_millis(),
                    total_cost_cents: total_cost,
                },
                Err(message) => AgentEvent::Failed { message },
            };

            if let Ok(encoded) = serde_json::to_string(&final_event) {
                let _ = writer.write_all(encoded.as_bytes());
                let _ = writer.write_all(b"\n");
                let _ = writer.flush();
            }
        }

        Request::Chat {
            messages,
            workspace,
            route,
            effort,
        } => {
            let last_user = messages
                .iter()
                .rev()
                .find(|turn| turn.role == "user")
                .map(|turn| turn.content.clone())
                .unwrap_or_default();

            let index = Index::build(&workspace.language, &workspace.files);

            // Route locally when the index answers the question exactly.
            let local_intent = match route {
                Route::Remote => None,
                Route::Local | Route::Auto => local::can_answer_locally(&last_user),
            };

            if let Some(intent) = local_intent {
                let text = match intent {
                    local::LocalIntent::Outline => local::explain(&index, &workspace, ""),
                    local::LocalIntent::Locate(name) => {
                        local::explain(&index, &workspace, &name)
                    }
                };
                send(
                    &mut writer,
                    Frame::Routed {
                        engine: "local",
                        model: "index".to_string(),
                    },
                )?;
                send(&mut writer, Frame::Delta { text })?;
                send(
                    &mut writer,
                    Frame::Done {
                        usage: None,
                        elapsed_ms: started.elapsed().as_millis(),
                    },
                )?;
                let _ = writer.shutdown(Shutdown::Both);
                return Ok(());
            }

            if route == Route::Local {
                send(
                    &mut writer,
                    Frame::Error {
                        message: "The local engine cannot answer that. It handles outlines, \
                                  symbol lookup and completion; switch the assistant to Auto \
                                  to let the model take it."
                            .to_string(),
                    },
                )?;
                let _ = writer.shutdown(Shutdown::Both);
                return Ok(());
            }

            let Some(credential) = remote::resolve_credential() else {
                send(
                    &mut writer,
                    Frame::Error {
                        message: "No Claude credential is available, so only the local engine \
                                  is running. Set ANTHROPIC_API_KEY or run `ant auth login`, \
                                  then restart the assistant."
                            .to_string(),
                    },
                )?;
                let _ = writer.shutdown(Shutdown::Both);
                return Ok(());
            };

            send(
                &mut writer,
                Frame::Routed {
                    engine: "model",
                    model: client.model().to_string(),
                },
            )?;

            let system = build_system_prompt(&workspace, &index);
            let outcome = client.stream_chat(
                &credential,
                &system,
                &messages,
                effort,
                |event| match event {
                    remote::Event::Text(text) => send(&mut writer, Frame::Delta { text })
                        .map_err(|e| e.to_string()),
                    remote::Event::Thinking(text) => {
                        send(&mut writer, Frame::Thinking { text }).map_err(|e| e.to_string())
                    }
                    // The plain chat path offers no tools, so a tool request
                    // here would be the model inventing one.
                    remote::Event::ToolStarted { .. } | remote::Event::ToolReady { .. } => Ok(()),
                    remote::Event::Done { usage, stop_reason } => {
                        // A turn cut short at the output ceiling looks identical
                        // to a finished one unless it is called out.
                        if stop_reason == "max_tokens" {
                            send(
                                &mut writer,
                                Frame::Delta {
                                    text: "\n\n_[reply reached the output limit and was cut short]_"
                                        .to_string(),
                                },
                            )
                            .map_err(|e| e.to_string())?;
                        }
                        send(
                            &mut writer,
                            Frame::Done {
                                usage: Some(usage),
                                elapsed_ms: started.elapsed().as_millis(),
                            },
                        )
                        .map_err(|e| e.to_string())
                    }
                },
            );

            if let Err(message) = outcome {
                let mut writer = stream_clone_fallback(&writer);
                let _ = writeln!(
                    writer,
                    "{}",
                    serde_json::to_string(&Frame::Error { message }).unwrap_or_default()
                );
            }
        }
    }

    let _ = writer.shutdown(Shutdown::Both);
    Ok(())
}

/// Watch the connection for a cancel frame while the agent runs.
///
/// The reader is moved into the thread: once the agent has started, the only
/// thing the client can send is a control frame.
fn spawn_cancel_watcher(
    reader: impl BufRead + Send + 'static,
    cancel: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                if value.get("op").and_then(|v| v.as_str()) == Some("cancel") {
                    cancel.store(true, Ordering::Relaxed);
                    return;
                }
            }
        }
    })
}

/// An agent's scratch workspace, removed when the task ends.
struct AgentWorkspace {
    workspace: tools::Workspace,
}

impl AgentWorkspace {
    fn create(source: &protocol::Workspace) -> Result<Self, String> {
        // Workspaces live outside /tmp: the sandbox replaces /tmp with its own
        // tmpfs, which would shadow a workspace mounted underneath it.
        let root = PathBuf::from(
            std::env::var("CODECRAFT_WORKSPACE_ROOT")
                .unwrap_or_else(|_| "/var/tmp/codecraft".to_string()),
        )
        .join(format!(
            "agent_{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));

        std::fs::create_dir_all(&root)
            .map_err(|e| format!("cannot create the agent workspace: {e}"))?;

        let workspace = tools::Workspace::new(
            root,
            if source.language.is_empty() {
                "python".to_string()
            } else {
                source.language.clone()
            },
            PathBuf::from(
                std::env::var("CODECRAFT_RUNNER")
                    .unwrap_or_else(|_| "scripts/sandbox_runner.sh".to_string()),
            ),
            PathBuf::from(std::env::var("CODECRAFT_ANALYZER").unwrap_or_else(|_| {
                "core/analyzer/build/codecraft-analyzer".to_string()
            })),
        );

        for file in &source.files {
            workspace.write(&file.name, &file.content)?;
        }
        Ok(AgentWorkspace { workspace })
    }

    fn workspace(&self) -> &tools::Workspace {
        &self.workspace
    }
}

impl Drop for AgentWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.workspace.root());
    }
}

/// The streaming closure borrows the writer mutably, so reporting a late error
/// needs a second handle to the same socket.
fn stream_clone_fallback(writer: &UnixStream) -> UnixStream {
    writer.try_clone().unwrap_or_else(|_| writer.try_clone().expect("socket handle"))
}

/// Give the model the workspace it is being asked about.
///
/// Files are included whole up to a budget and truncated after it: a partial
/// file with a marker is far more useful than a silently dropped one.
fn build_system_prompt(workspace: &protocol::Workspace, index: &Index) -> String {
    const FILE_BUDGET: usize = 24_000;

    let mut prompt = String::with_capacity(FILE_BUDGET + 2048);
    prompt.push_str(SYSTEM_PROMPT);
    prompt.push_str("\n\n--- workspace ---\n");

    if !workspace.language.is_empty() {
        prompt.push_str(&format!("Runtime: {}\n", workspace.language));
    }
    if !workspace.active_file.is_empty() {
        prompt.push_str(&format!(
            "Caret: {} line {} column {}\n",
            workspace.active_file, workspace.line, workspace.column
        ));
    }
    if !index.symbols.is_empty() {
        prompt.push_str("\nDeclarations:\n");
        for symbol in index.symbols.iter().take(80) {
            prompt.push_str(&format!(
                "  {} {} ({}:{})\n",
                symbol.kind, symbol.name, symbol.file, symbol.line
            ));
        }
    }
    if !workspace.selection.is_empty() {
        prompt.push_str("\nThe user has selected:\n```\n");
        prompt.push_str(&truncate(&workspace.selection, 4000));
        prompt.push_str("\n```\n");
    }

    let mut remaining = FILE_BUDGET;
    for file in &workspace.files {
        prompt.push_str(&format!("\n--- {} ---\n", file.name));
        if file.content.len() > remaining {
            prompt.push_str(&truncate(&file.content, remaining));
            prompt.push_str("\n… file truncated to fit the context budget …\n");
            remaining = 0;
        } else {
            prompt.push_str(&file.content);
            remaining -= file.content.len();
        }
        if remaining == 0 {
            prompt.push_str("\n… remaining files omitted …\n");
            break;
        }
    }

    prompt
}

/// Truncate on a character boundary; slicing raw bytes would panic mid-glyph.
fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{SourceFile, Workspace};

    #[test]
    fn truncation_respects_character_boundaries() {
        let text = "ăîșț".repeat(50);
        let cut = truncate(&text, 11);
        assert!(cut.len() <= 11);
        assert!(text.starts_with(&cut));
    }

    #[test]
    fn system_prompt_carries_the_workspace() {
        let workspace = Workspace {
            language: "rust".into(),
            files: vec![SourceFile {
                name: "main.rs".into(),
                content: "fn helper() {}\n".into(),
            }],
            active_file: "main.rs".into(),
            line: 1,
            column: 4,
            ..Default::default()
        };
        let index = Index::build("rust", &workspace.files);
        let prompt = build_system_prompt(&workspace, &index);

        assert!(prompt.contains("Runtime: rust"));
        assert!(prompt.contains("main.rs line 1"));
        assert!(prompt.contains("function helper"));
        assert!(prompt.contains("fn helper() {}"));
    }

    #[test]
    fn oversized_workspaces_are_marked_truncated_not_dropped() {
        let workspace = Workspace {
            language: "python".into(),
            files: vec![SourceFile {
                name: "big.py".into(),
                content: "x = 1\n".repeat(20_000),
            }],
            ..Default::default()
        };
        let index = Index::build("python", &workspace.files);
        let prompt = build_system_prompt(&workspace, &index);

        assert!(prompt.contains("--- big.py ---"));
        assert!(prompt.contains("file truncated"));
    }
}
