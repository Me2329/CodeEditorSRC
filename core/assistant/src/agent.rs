//! The agent loop.
//!
//! One task, many turns: the model reads, edits and runs code in a sandboxed
//! workspace until it is done, and every step is reported as it happens.
//!
//! The loop is strictly append-only. A thinking block on this model class is
//! signed against the exact conversation prefix that produced it - the system
//! prompt, the tool set, and every earlier message - so rewriting or trimming
//! history from the middle invalidates every later block. Turns are therefore
//! appended verbatim, tool results are appended after them, and nothing already
//! sent is ever touched. Trimming, when it is needed, is left to server-side
//! context editing, which the client requests rather than performs.

use crate::protocol::{AgentEvent, Effort};
use crate::remote::{Client, Credential, Event, Turn};
use crate::tools::{self, Mode, Workspace};

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Stop after this many model turns. An agent that has not finished by then is
/// looping, and burning a budget silently is worse than stopping and saying so.
pub const DEFAULT_MAX_STEPS: usize = 24;

const SYSTEM_PROMPT: &str = "\
You are the coding agent inside CodeCraft Studio, working directly in the user's \
workspace through tools.

How to work:

- Investigate before you change anything. Read the files you are about to touch; \
  use search to find a symbol rather than reading everything.
- Prefer edit_file over write_file. A full rewrite loses code you did not mean \
  to touch. Include enough surrounding context in old_text to make it unique.
- After changing code, run it. A change you have not run is a guess. Read the \
  output, and if it failed, fix it and run again.
- Work in small steps and say what you are doing as you go, briefly.
- When you are done, state what you changed and what the run showed. If you \
  could not finish, say exactly what is blocking you rather than implying \
  success.

Constraints you should know about:

- The sandbox has no network access, so you cannot install packages. Use the \
  standard library, or tell the user what is missing.
- Every path is workspace-relative. There is no filesystem outside the workspace.
- run_code executes the whole workspace through the runtime the user selected, \
  with a 20 second limit.

Be accurate over agreeable. If the user's request rests on a mistaken \
assumption, say so and explain what is actually true.";

pub struct AgentConfig {
    pub mode: Mode,
    pub effort: Effort,
    pub max_steps: usize,
}

impl Default for AgentConfig {
    fn default() -> Self {
        AgentConfig { mode: Mode::Auto, effort: Effort::High, max_steps: DEFAULT_MAX_STEPS }
    }
}

/// Why the loop stopped.
pub enum Completion {
    /// The model finished the task.
    Finished,
    /// The step budget ran out.
    StepLimit,
    /// The caller cancelled.
    Cancelled,
}

/// Run a task to completion, reporting every step through `emit`.
///
/// `history` carries earlier turns of the conversation so a follow-up
/// instruction keeps its context. It is extended in place and never rewritten.
pub fn run<F>(
    client: &Client,
    credential: &Credential,
    workspace: &Workspace,
    history: &mut Vec<Value>,
    config: &AgentConfig,
    cancel: &Arc<AtomicBool>,
    mut emit: F,
) -> Result<Completion, String>
where
    F: FnMut(AgentEvent) -> Result<(), String>,
{
    let tools = tools::definitions(config.mode);
    let system = build_system_prompt(workspace, config.mode);

    for step in 1..=config.max_steps {
        if cancel.load(Ordering::Relaxed) {
            return Ok(Completion::Cancelled);
        }

        emit(AgentEvent::Step { number: step, of: config.max_steps })?;

        let turn: Turn = client.stream_turn(
            credential,
            &system,
            history,
            &tools,
            config.effort,
            |event| match event {
                Event::Text(text) => emit(AgentEvent::Text { text }),
                Event::Thinking(text) => emit(AgentEvent::Thinking { text }),
                Event::ToolStarted { id, name } => emit(AgentEvent::ToolStarted { id, name }),
                Event::ToolReady { id, name, input } => emit(AgentEvent::ToolCall {
                    id,
                    name,
                    input: summarise_input(&input),
                }),
                Event::Done { usage, .. } => emit(AgentEvent::TurnUsage { usage }),
            },
        )?;

        // Append the turn exactly as it arrived. Its thinking blocks are signed
        // against everything before them, so they travel unmodified.
        history.push(json!({"role": "assistant", "content": turn.content}));

        if turn.tool_calls.is_empty() {
            return Ok(Completion::Finished);
        }

        // Every tool result for a turn goes back in one user message. Splitting
        // them teaches the model to stop asking for tools in parallel.
        let mut results = Vec::with_capacity(turn.tool_calls.len());
        for call in &turn.tool_calls {
            if cancel.load(Ordering::Relaxed) {
                // A cancelled call still needs a result, or the conversation is
                // left with an unanswered tool_use and cannot be resumed.
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": call.id,
                    "content": "The user cancelled this task.",
                    "is_error": true,
                }));
                continue;
            }

            let outcome = tools::execute(workspace, config.mode, &call.name, &call.input);

            emit(AgentEvent::ToolResult {
                id: call.id.clone(),
                name: call.name.clone(),
                is_error: outcome.is_error,
                summary: first_lines(&outcome.content, 6),
            })?;

            for file in &outcome.changed_files {
                if let Ok(content) = workspace.read(file) {
                    emit(AgentEvent::FileChanged { name: file.clone(), content })?;
                }
            }

            results.push(json!({
                "type": "tool_result",
                "tool_use_id": call.id,
                "content": outcome.content,
                "is_error": outcome.is_error,
            }));
        }

        history.push(json!({"role": "user", "content": results}));

        if cancel.load(Ordering::Relaxed) {
            return Ok(Completion::Cancelled);
        }
    }

    Ok(Completion::StepLimit)
}

/// The system prompt, plus what the agent needs to know about this workspace.
fn build_system_prompt(workspace: &Workspace, mode: Mode) -> String {
    let mut prompt = String::from(SYSTEM_PROMPT);

    if mode == Mode::Plan {
        prompt.push_str(
            "\n\nYou are in plan mode: you can read, search and analyze, but you cannot \
             change files or run code. Investigate, then set out what you would do and \
             why. Do not describe changes as though you have made them.",
        );
    }

    prompt.push_str("\n\n--- workspace ---\n");
    let files = workspace.files();
    if files.is_empty() {
        prompt.push_str("(empty)\n");
    } else {
        for (name, size) in &files {
            prompt.push_str(&format!("{name}  ({size} bytes)\n"));
        }
    }
    prompt
}

/// Tool arguments are echoed to the interface, and a whole file body would
/// swamp it. Long string values are shortened; structure is kept.
fn summarise_input(input: &Value) -> Value {
    const MAX_VALUE: usize = 240;

    match input {
        Value::String(text) if text.len() > MAX_VALUE => {
            let mut end = MAX_VALUE;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            Value::String(format!("{}… ({} characters)", &text[..end], text.len()))
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), summarise_input(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(summarise_input).collect()),
        other => other.clone(),
    }
}

fn first_lines(text: &str, count: usize) -> String {
    let mut out: Vec<&str> = text.lines().take(count).collect();
    if text.lines().count() > count {
        out.push("…");
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_mode_tells_the_model_it_cannot_change_anything() {
        let workspace = Workspace::new(
            std::env::temp_dir().join("cc_agent_prompt_test"),
            "python".into(),
            "/nonexistent".into(),
            "/nonexistent".into(),
        );
        let prompt = build_system_prompt(&workspace, Mode::Plan);
        assert!(prompt.contains("plan mode"));
        assert!(prompt.contains("cannot"));

        let auto = build_system_prompt(&workspace, Mode::Auto);
        assert!(!auto.contains("plan mode"));
    }

    #[test]
    fn the_prompt_tells_the_model_it_has_no_network() {
        let workspace = Workspace::new(
            std::env::temp_dir().join("cc_agent_prompt_test2"),
            "python".into(),
            "/nonexistent".into(),
            "/nonexistent".into(),
        );
        let prompt = build_system_prompt(&workspace, Mode::Auto);
        assert!(prompt.contains("no network access"));
        assert!(prompt.contains("run it"));
    }

    #[test]
    fn long_tool_arguments_are_shortened_for_display() {
        let long = "x".repeat(1000);
        let summarised = summarise_input(&json!({"path": "main.py", "content": long}));

        assert_eq!(summarised["path"], "main.py");
        let content = summarised["content"].as_str().unwrap();
        assert!(content.len() < 400);
        assert!(content.contains("1000 characters"));
    }

    #[test]
    fn short_arguments_pass_through_untouched() {
        let input = json!({"path": "main.py", "args": ["--fast", "2"]});
        assert_eq!(summarise_input(&input), input);
    }

    #[test]
    fn summarising_never_splits_a_multibyte_character() {
        let text = "ăîșț".repeat(200);
        let summarised = summarise_input(&Value::String(text));
        // Would have panicked on a bad boundary before reaching here.
        assert!(summarised.as_str().unwrap().contains("characters"));
    }

    #[test]
    fn a_tool_summary_is_capped_and_marked() {
        let text = (1..=20).map(|n| n.to_string()).collect::<Vec<_>>().join("\n");
        let summary = first_lines(&text, 6);
        assert_eq!(summary.lines().count(), 7); // six lines plus the marker
        assert!(summary.ends_with('…'));
    }
}
