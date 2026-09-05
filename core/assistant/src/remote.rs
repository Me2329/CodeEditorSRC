//! Claude Messages API client with server-sent-event streaming.
//!
//! Rust has no official Anthropic SDK, so this speaks the HTTP API directly.
//! The default model is Claude Mythos 5.1, whose API surface differs from the
//! Opus family in ways that are easy to get wrong:
//!
//!   * Thinking is always on. Sending `{"type": "disabled"}` or a
//!     `budget_tokens` value is rejected with a 400; depth is controlled by
//!     `output_config.effort` instead.
//!   * The raw chain of thought is never returned, and the default display is
//!     `omitted`, which looks like a long stall in a chat UI. This client asks
//!     for `summarized` so the panel can show progress.
//!   * A request may be declined with HTTP 200 and `stop_reason: "refusal"`,
//!     so the stop reason is checked before the content is trusted.
//!   * Server-side fallbacks are enabled, so a refusal is rerouted by category
//!     rather than surfacing to the user as a dead end.
//!   * Assistant prefill is not supported and is never sent.

use crate::protocol::{ChatTurn, Effort, Usage};
use std::io::{BufRead, BufReader};
use std::time::Duration;

pub const DEFAULT_MODEL: &str = "claude-mythos-5-1";
const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const CONTEXT_EDITING_BETA: &str = "context-management-2025-06-27";

/// Published rates in US dollars per million tokens, used to report what a
/// conversation cost. Unknown models report zero rather than a wrong number.
fn rates_for(model: &str) -> (f64, f64) {
    match model {
        "claude-mythos-5-1" | "claude-fable-5-1" | "claude-fable-5" => (10.0, 50.0),
        "claude-opus-5" | "claude-opus-4-8" | "claude-opus-4-7" | "claude-opus-4-6" => (5.0, 25.0),
        "claude-sonnet-5" => (2.0, 10.0),
        "claude-sonnet-4-6" => (3.0, 15.0),
        "claude-haiku-4-5" => (1.0, 5.0),
        _ => (0.0, 0.0),
    }
}

#[derive(Debug, Clone)]
pub enum Credential {
    ApiKey(String),
    OAuth(String),
}

/// Resolve a credential without prompting.
///
/// An unset `ANTHROPIC_API_KEY` does not mean there are no credentials: the
/// `ant` CLI stores OAuth profiles that the SDKs pick up automatically. Since
/// this client speaks raw HTTP it has to ask the CLI for a short-lived token
/// itself.
pub fn resolve_credential() -> Option<Credential> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.trim().is_empty() {
            return Some(Credential::ApiKey(key.trim().to_string()));
        }
    }
    if let Ok(token) = std::env::var("ANTHROPIC_AUTH_TOKEN") {
        if !token.trim().is_empty() {
            return Some(Credential::OAuth(token.trim().to_string()));
        }
    }

    let output = std::process::Command::new("ant")
        .args(["auth", "print-credentials", "--access-token"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(Credential::OAuth(token))
    }
}

pub struct Client {
    agent: ureq::Agent,
    model: String,
    /// Overridable so the client can be pointed at a test double, and so a
    /// gateway or proxy deployment can route through its own endpoint.
    base_url: String,
}

/// Events surfaced to the caller as the response streams in.
pub enum Event {
    /// A chunk of the visible answer.
    Text(String),
    /// A summarised reasoning step.
    Thinking(String),
    /// The model has started requesting a tool; its arguments are still
    /// streaming. Emitted early so the interface can show the call at once.
    ToolStarted { id: String, name: String },
    /// A tool request whose arguments are complete and parsed.
    ToolReady {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// The turn finished.
    Done { usage: Usage, stop_reason: String },
}

/// Everything one assistant turn produced.
pub struct Turn {
    /// The assistant's content blocks exactly as the server sent them.
    ///
    /// Replayed verbatim in the next request. Thinking blocks carry a signature
    /// binding them to the conversation prefix that produced them, so stripping
    /// or rewriting any of this invalidates every later thinking block.
    pub content: Vec<serde_json::Value>,
    pub stop_reason: String,
    pub usage: Usage,
    /// Tool requests from this turn, in the order the model made them.
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// Hostname of a URL, lowercased and without port or credentials.
fn host_of(url: &str) -> String {
    let without_scheme = url.split("://").nth(1).unwrap_or(url);
    let authority = without_scheme.split('/').next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    // Strip the port, taking care not to cut an IPv6 literal in half.
    let host = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else {
        host.split(':').next().unwrap_or(host)
    };
    host.to_ascii_lowercase()
}

/// Whether a request to `host` should bypass the proxy, given a NO_PROXY list.
///
/// Loopback is always direct: a proxy that is not told to allow it will refuse
/// the request, which would make a local endpoint unreachable. Beyond that the
/// NO_PROXY list is honoured with the usual suffix matching.
///
/// The list is a parameter rather than an environment read so the rule can be
/// tested without depending on the machine the tests run on.
fn bypasses_proxy(host: &str, no_proxy: &str) -> bool {
    if host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host.starts_with("127.")
        || host.ends_with(".localhost")
    {
        return true;
    }

    for entry in no_proxy.split(',') {
        let entry = entry.trim().trim_start_matches('.').to_ascii_lowercase();
        if entry.is_empty() {
            continue;
        }
        if entry == "*" || host == entry || host.ends_with(&format!(".{entry}")) {
            return true;
        }
    }
    false
}

fn build_agent(base_url: &str) -> ureq::Agent {
    let mut config = ureq::Agent::config_builder()
        // Long-horizon requests on this model class can run for minutes, so the
        // timeout covers a slow answer rather than cutting it off.
        .timeout_global(Some(Duration::from_secs(600)))
        // Errors are read from the body, not raised as transport failures.
        .http_status_as_error(false);

    let no_proxy = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();

    if !bypasses_proxy(&host_of(base_url), &no_proxy) {
        if let Some(proxy) = std::env::var("HTTPS_PROXY")
            .or_else(|_| std::env::var("https_proxy"))
            .ok()
            .and_then(|url| ureq::Proxy::new(&url).ok())
        {
            config = config.proxy(Some(proxy));
        }
    }

    config.build().into()
}

impl Client {
    pub fn new(model: String) -> Self {
        let base_url = std::env::var("ANTHROPIC_BASE_URL")
            .unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
            .trim_end_matches('/')
            .to_string();

        Client {
            agent: build_agent(&base_url),
            model,
            base_url,
        }
    }

    /// Point the client at a different endpoint, rebuilding the transport so
    /// proxy rules are re-evaluated for the new host.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into().trim_end_matches('/').to_string();
        self.agent = build_agent(&self.base_url);
        self
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Send one turn and stream the reply. `on_event` is called as data
    /// arrives; returning an error from it aborts the stream.
    ///
    /// This is the plain conversational path. The agent uses `stream_turn`,
    /// which takes pre-built messages and a tool set.
    pub fn stream_chat<F>(
        &self,
        credential: &Credential,
        system: &str,
        history: &[ChatTurn],
        effort: Effort,
        on_event: F,
    ) -> Result<(), String>
    where
        F: FnMut(Event) -> Result<(), String>,
    {
        let messages: Vec<serde_json::Value> = history
            .iter()
            // Only user and assistant turns belong in the array; the system
            // prompt is a separate top-level field.
            .filter(|turn| turn.role == "user" || turn.role == "assistant")
            .map(|turn| serde_json::json!({"role": turn.role, "content": turn.content}))
            .collect();

        self.stream_turn(credential, system, &messages, &[], effort, on_event)
            .map(|_| ())
    }

    /// Run one assistant turn against a prepared message array and tool set.
    ///
    /// Returns the turn's content blocks so the caller can append them to the
    /// conversation unchanged, which is what keeps an agent loop append-only.
    pub fn stream_turn<F>(
        &self,
        credential: &Credential,
        system: &str,
        messages: &[serde_json::Value],
        tools: &[serde_json::Value],
        effort: Effort,
        mut on_event: F,
    ) -> Result<Turn, String>
    where
        F: FnMut(Event) -> Result<(), String>,
    {
        if messages.is_empty() {
            return Err("conversation contains no user message".to_string());
        }

        let mut body = serde_json::json!({
            "model": self.model,
            // Streaming is required at this output size, and it is what lets the
            // panel show the first tokens immediately.
            "max_tokens": 32000,
            "stream": true,
            "system": system,
            "messages": messages,
            // Thinking is always on for this model class. Asking for a summary
            // avoids a silent pause before the first visible token.
            "thinking": {"type": "adaptive", "display": "summarized"},
            "output_config": {"effort": effort.as_str()},
            // Reroute a refusal by category instead of failing the request.
            "fallbacks": "default",
        });

        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(tools.to_vec());
            // Forced tool choice is rejected on this model class, so the tool
            // set is offered and the system prompt states the expectation.
            // `strict` on each tool keeps the schema-valid-arguments guarantee.
            body["tool_choice"] = serde_json::json!({"type": "auto"});
        }

        let mut betas = vec![FALLBACK_BETA.to_string()];
        if !tools.is_empty() {
            // Long agent runs accumulate stale tool output; clearing it keeps
            // the transcript lean without editing history, which would
            // invalidate the thinking blocks.
            body["context_management"] =
                serde_json::json!({"edits": [{"type": "clear_tool_uses_20250919"}]});
            betas.push(CONTEXT_EDITING_BETA.to_string());
        }

        let mut request = self
            .agent
            .post(format!("{}/v1/messages", self.base_url))
            .header("content-type", "application/json")
            .header("anthropic-version", API_VERSION)
            .header("accept", "text/event-stream");

        request = match credential {
            Credential::ApiKey(key) => request
                .header("x-api-key", key.as_str())
                .header("anthropic-beta", &betas.join(",")),
            // OAuth tokens go on Authorization, and need their own beta flag.
            Credential::OAuth(token) => {
                betas.insert(0, OAUTH_BETA.to_string());
                request
                    .header("authorization", &format!("Bearer {token}"))
                    .header("anthropic-beta", &betas.join(","))
            }
        };

        let response = request
            .send(serde_json::to_string(&body).map_err(|e| e.to_string())?)
            .map_err(|e| format!("could not reach the Claude API: {e}"))?;

        let status = response.status().as_u16();
        if status != 200 {
            let detail = response
                .into_body()
                .read_to_string()
                .unwrap_or_else(|_| String::new());
            return Err(describe_http_error(status, &detail, &self.model));
        }

        self.consume_stream(response, &mut on_event)
    }

    /// Reassemble the turn from its server-sent events.
    ///
    /// Each content block is rebuilt from the object the server opened it with,
    /// then filled in from its deltas. Starting from the server's own object
    /// rather than constructing one means a block keeps every field it arrived
    /// with, including a thinking block's signature, which the next request has
    /// to echo back unchanged.
    fn consume_stream<F>(
        &self,
        response: ureq::http::Response<ureq::Body>,
        on_event: &mut F,
    ) -> Result<Turn, String>
    where
        F: FnMut(Event) -> Result<(), String>,
    {
        let reader = BufReader::new(response.into_body().into_reader());
        let mut usage = Usage::default();
        let mut stop_reason = String::new();
        let mut refusal_detail: Option<String> = None;

        // Blocks under construction, keyed by their index in the response.
        let mut blocks: Vec<(usize, serde_json::Value, String)> = Vec::new();

        for line in reader.lines() {
            let line = line.map_err(|e| format!("stream ended unexpectedly: {e}"))?;

            // Server-sent events: only the data lines carry payload. Event-type
            // lines, comments and blank separators are skipped.
            let Some(payload) = line.strip_prefix("data: ") else {
                continue;
            };
            let Ok(event) = serde_json::from_str::<serde_json::Value>(payload) else {
                continue;
            };

            let index = event.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

            match event.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "content_block_start" => {
                    let Some(block) = event.get("content_block") else { continue };
                    let kind = block.get("type").and_then(|v| v.as_str()).unwrap_or("");

                    if kind == "tool_use" {
                        let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        on_event(Event::ToolStarted {
                            id: id.to_string(),
                            name: name.to_string(),
                        })?;
                    }

                    blocks.push((index, block.clone(), String::new()));
                }

                "content_block_delta" => {
                    let Some(delta) = event.get("delta") else { continue };
                    let kind = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");

                    // A delta should always follow a content_block_start. If one
                    // goes missing, open the block from the delta's own type
                    // rather than dropping the content on the floor.
                    if !blocks.iter().any(|(i, _, _)| *i == index) {
                        let inferred = match kind {
                            "thinking_delta" | "signature_delta" => "thinking",
                            "input_json_delta" => "tool_use",
                            _ => "text",
                        };
                        blocks.push((index, serde_json::json!({"type": inferred}), String::new()));
                    }

                    let Some(slot) = blocks.iter_mut().find(|(i, _, _)| *i == index) else {
                        continue;
                    };

                    match kind {
                        "text_delta" => {
                            if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                                append_field(&mut slot.1, "text", text);
                                on_event(Event::Text(text.to_string()))?;
                            }
                        }
                        "thinking_delta" => {
                            if let Some(text) = delta.get("thinking").and_then(|v| v.as_str()) {
                                append_field(&mut slot.1, "thinking", text);
                                if !text.is_empty() {
                                    on_event(Event::Thinking(text.to_string()))?;
                                }
                            }
                        }
                        "signature_delta" => {
                            // The signature binds the block to this conversation
                            // and must survive into the replayed history.
                            if let Some(text) = delta.get("signature").and_then(|v| v.as_str()) {
                                append_field(&mut slot.1, "signature", text);
                            }
                        }
                        "input_json_delta" => {
                            // Tool arguments arrive as JSON fragments and are
                            // only valid once the block closes.
                            if let Some(fragment) =
                                delta.get("partial_json").and_then(|v| v.as_str())
                            {
                                slot.2.push_str(fragment);
                            }
                        }
                        _ => {}
                    }
                }

                "content_block_stop" => {
                    let Some(slot) = blocks.iter_mut().find(|(i, _, _)| *i == index) else {
                        continue;
                    };
                    if slot.1.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        // An empty argument stream means a tool with no
                        // parameters, which is an empty object, not a parse error.
                        let parsed: serde_json::Value = if slot.2.trim().is_empty() {
                            serde_json::json!({})
                        } else {
                            serde_json::from_str(&slot.2).map_err(|e| {
                                format!("the model sent malformed tool arguments: {e}")
                            })?
                        };
                        slot.1["input"] = parsed.clone();

                        on_event(Event::ToolReady {
                            id: slot.1["id"].as_str().unwrap_or("").to_string(),
                            name: slot.1["name"].as_str().unwrap_or("").to_string(),
                            input: parsed,
                        })?;
                    }
                }

                "message_start" => {
                    if let Some(input) = event
                        .pointer("/message/usage/input_tokens")
                        .and_then(|v| v.as_u64())
                    {
                        usage.input_tokens = input;
                    }
                }

                "message_delta" => {
                    if let Some(output) = event
                        .pointer("/usage/output_tokens")
                        .and_then(|v| v.as_u64())
                    {
                        usage.output_tokens = output;
                    }
                    if let Some(reason) = event.pointer("/delta/stop_reason").and_then(|v| v.as_str())
                    {
                        stop_reason = reason.to_string();
                    }
                    // A refusal arrives with HTTP 200, so it has to be detected
                    // here rather than from the status code.
                    if let Some(details) = event.pointer("/delta/stop_details") {
                        let category = details
                            .get("category")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unspecified");
                        let explanation = details
                            .get("explanation")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        refusal_detail = Some(if explanation.is_empty() {
                            format!("category: {category}")
                        } else {
                            format!("category: {category}. {explanation}")
                        });
                    }
                }

                "error" => {
                    let message = event
                        .pointer("/error/message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("the API reported an error mid-stream");
                    return Err(message.to_string());
                }

                _ => {}
            }
        }

        if stop_reason == "refusal" {
            let detail = refusal_detail.unwrap_or_else(|| "no category given".to_string());
            return Err(format!(
                "The model declined this request ({detail}). Server-side fallbacks were \
                 enabled, so this was not reroutable. Try rephrasing."
            ));
        }

        let (input_rate, output_rate) = rates_for(&self.model);
        usage.cost_cents = (usage.input_tokens as f64 * input_rate
            + usage.output_tokens as f64 * output_rate)
            / 1_000_000.0
            * 100.0;

        blocks.sort_by_key(|(index, _, _)| *index);
        let content: Vec<serde_json::Value> =
            blocks.iter().map(|(_, block, _)| block.clone()).collect();

        let tool_calls = content
            .iter()
            .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
            .map(|block| ToolCall {
                id: block["id"].as_str().unwrap_or("").to_string(),
                name: block["name"].as_str().unwrap_or("").to_string(),
                input: block.get("input").cloned().unwrap_or(serde_json::json!({})),
            })
            .collect();

        on_event(Event::Done {
            usage: usage.clone(),
            stop_reason: stop_reason.clone(),
        })?;

        Ok(Turn {
            content,
            stop_reason,
            usage,
            tool_calls,
        })
    }
}

/// Append streamed text onto a string field, creating it when absent.
fn append_field(block: &mut serde_json::Value, field: &str, text: &str) {
    match block.get_mut(field).and_then(|v| v.as_str()).map(str::to_string) {
        Some(existing) => block[field] = serde_json::Value::String(existing + text),
        None => block[field] = serde_json::Value::String(text.to_string()),
    }
}

/// Turn an HTTP failure into something an operator can act on.
fn describe_http_error(status: u16, body: &str, model: &str) -> String {
    let api_message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());

    match status {
        401 | 403 => format!(
            "The Claude API rejected the credential ({status}). Run `ant auth login`, \
             or set ANTHROPIC_API_KEY. Detail: {api_message}"
        ),
        404 => format!(
            "The model '{model}' is not available to this account. Claude Mythos 5.1 \
             requires Project Glasswing access; set CODECRAFT_ASSISTANT_MODEL to a model \
             you can reach, such as claude-opus-5. Detail: {api_message}"
        ),
        429 => format!("Rate limited by the Claude API. Detail: {api_message}"),
        400 => format!("The Claude API rejected the request. Detail: {api_message}"),
        500..=599 => format!("The Claude API is unavailable ({status}). Detail: {api_message}"),
        _ => format!("The Claude API returned {status}. Detail: {api_message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_the_mythos_family_correctly() {
        assert_eq!(rates_for("claude-mythos-5-1"), (10.0, 50.0));
        assert_eq!(rates_for("claude-opus-5"), (5.0, 25.0));
        assert_eq!(rates_for("claude-haiku-4-5"), (1.0, 5.0));
    }

    #[test]
    fn reports_zero_rather_than_a_wrong_price_for_an_unknown_model() {
        assert_eq!(rates_for("some-future-model"), (0.0, 0.0));
    }

    #[test]
    fn explains_a_missing_model_entitlement() {
        let message = describe_http_error(404, "{}", "claude-mythos-5-1");
        assert!(message.contains("Project Glasswing"));
        assert!(message.contains("CODECRAFT_ASSISTANT_MODEL"));
    }

    #[test]
    fn surfaces_the_api_message_on_a_bad_request() {
        let body = r#"{"error":{"message":"thinking.budget_tokens is not supported"}}"#;
        let message = describe_http_error(400, body, "claude-mythos-5-1");
        assert!(message.contains("budget_tokens is not supported"));
    }

    #[test]
    fn loopback_never_goes_through_a_proxy() {
        for host in ["localhost", "127.0.0.1", "127.0.1.5", "::1"] {
            assert!(bypasses_proxy(host, ""), "{host} should bypass the proxy");
        }
        assert!(!bypasses_proxy("api.anthropic.com", ""));
    }

    #[test]
    fn extracts_the_host_from_a_url() {
        assert_eq!(host_of("https://api.anthropic.com/v1/messages"), "api.anthropic.com");
        assert_eq!(host_of("http://127.0.0.1:8080"), "127.0.0.1");
        assert_eq!(host_of("http://[::1]:9000/path"), "::1");
    }

    #[test]
    fn honours_no_proxy_suffix_matching() {
        let list = "internal.example.com,.corp";
        assert!(bypasses_proxy("api.internal.example.com", list));
        assert!(bypasses_proxy("internal.example.com", list));
        assert!(bypasses_proxy("host.corp", list));
        assert!(!bypasses_proxy("api.anthropic.com", list));
        assert!(bypasses_proxy("anything.at.all", "*"));
    }

    #[test]
    fn points_at_the_login_command_when_unauthorised() {
        let message = describe_http_error(401, "{}", "claude-mythos-5-1");
        assert!(message.contains("ant auth login"));
    }
}
