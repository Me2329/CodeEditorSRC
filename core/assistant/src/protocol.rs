//! Wire protocol for the assistant daemon.
//!
//! Newline-delimited JSON over a Unix socket, matching the supervisor so both
//! daemons are driven the same way. One request per connection; the reply is a
//! stream of frames terminated by exactly one `done` or `error`.

use serde::{Deserialize, Serialize};

/// Where a request should be answered from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    /// Answer from the local engine only. Never touches the network.
    Local,
    /// Always ask the language model.
    Remote,
    /// Let the router decide: local when it can answer well, remote otherwise.
    Auto,
}

impl Default for Route {
    fn default() -> Self {
        Route::Auto
    }
}

/// How much effort the remote model should spend. Mirrors the API's
/// `output_config.effort` levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Xhigh => "xhigh",
            Effort::Max => "max",
        }
    }
}

impl Default for Effort {
    fn default() -> Self {
        // High is the API default and the right balance for code work.
        Effort::High
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SourceFile {
    pub name: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Workspace {
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub files: Vec<SourceFile>,
    /// Name of the file the caret is in.
    #[serde(default)]
    pub active_file: String,
    /// 1-based caret position.
    #[serde(default)]
    pub line: usize,
    #[serde(default)]
    pub column: usize,
    /// Text the user has selected, when any.
    #[serde(default)]
    pub selection: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// Liveness and capability probe.
    Health,
    /// Conversational request, optionally grounded in the workspace.
    Chat {
        #[serde(default)]
        messages: Vec<ChatTurn>,
        #[serde(default)]
        workspace: Workspace,
        #[serde(default)]
        route: Route,
        #[serde(default)]
        effort: Effort,
    },
    /// Completion candidates at the caret. Always answered locally.
    Complete {
        #[serde(default)]
        workspace: Workspace,
        #[serde(default)]
        prefix: String,
        #[serde(default = "default_limit")]
        limit: usize,
    },
    /// Structural summary of a symbol or the file. Always answered locally.
    Explain {
        #[serde(default)]
        workspace: Workspace,
        #[serde(default)]
        symbol: String,
    },
    /// Every symbol in the workspace, for outline and go-to-symbol.
    Symbols {
        #[serde(default)]
        workspace: Workspace,
    },
    /// Run an agent task against the workspace.
    Agent {
        /// The instruction, plus any earlier turns of this conversation.
        #[serde(default)]
        messages: Vec<ChatTurn>,
        #[serde(default)]
        workspace: Workspace,
        /// "plan" for read-only, "auto" for the full tool surface.
        #[serde(default = "default_agent_mode")]
        mode: String,
        #[serde(default)]
        effort: Effort,
        #[serde(default = "default_max_steps")]
        max_steps: usize,
    },
}

fn default_agent_mode() -> String {
    "auto".to_string()
}

fn default_max_steps() -> usize {
    24
}

fn default_limit() -> usize {
    25
}

/// Events the agent loop reports as it works.
///
/// Separate from `Frame` because an agent turn is a sequence of steps rather
/// than a single answer, and the interface renders them differently.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// A new model turn is starting.
    Step { number: usize, of: usize },
    /// A chunk of the agent's visible narration.
    Text { text: String },
    /// A summarised reasoning step.
    Thinking { text: String },
    /// The agent has begun requesting a tool; arguments are still streaming.
    ToolStarted { id: String, name: String },
    /// A tool request with its arguments, shortened for display.
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// What the tool returned.
    ToolResult {
        id: String,
        name: String,
        is_error: bool,
        summary: String,
    },
    /// A file the agent changed, so the editor can update live.
    FileChanged { name: String, content: String },
    /// Token usage and cost for one model turn.
    TurnUsage { usage: Usage },
    /// The task ended.
    Finished {
        reason: String,
        steps: usize,
        elapsed_ms: u128,
        total_cost_cents: f64,
    },
    /// The task failed.
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
    /// Capability report.
    Health {
        version: &'static str,
        model: String,
        remote_available: bool,
        remote_reason: String,
    },
    /// Which engine answered, sent before any content.
    Routed { engine: &'static str, model: String },
    /// A chunk of the answer.
    Delta { text: String },
    /// A summarised reasoning step, when the model returns one.
    Thinking { text: String },
    /// Completion candidates.
    Completions { items: Vec<Completion> },
    /// Symbols found in the workspace.
    Symbols { items: Vec<Symbol> },
    /// Terminal success frame.
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        elapsed_ms: u128,
    },
    /// Terminal failure frame.
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Completion {
    pub label: String,
    pub kind: String,
    pub detail: String,
    /// Higher sorts first.
    pub score: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: usize,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Cost in US cents, computed from the model's published rates.
    pub cost_cents: f64,
}
