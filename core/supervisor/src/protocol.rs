//! Wire protocol between the FastAPI gateway and the supervisor daemon.
//!
//! One job per connection, newline-delimited JSON in both directions. The
//! gateway sends a single request frame; the supervisor answers with an
//! `accepted` frame, then a live stream of `stdout`/`stderr` frames, then
//! exactly one terminal frame (`exit` or `error`).

use crate::json::{self, Json};
use std::collections::BTreeMap;

/// Ceilings applied to every job. Values arriving from the gateway are clamped
/// into these ranges, so a compromised or buggy caller cannot lift them.
pub const MAX_WALL_SECONDS: u64 = 120;
pub const MAX_CPU_SECONDS: u64 = 60;
pub const MAX_MEMORY_MB: u64 = 2048;
pub const MAX_PROCS: u64 = 512;
pub const MAX_FILES: usize = 64;
pub const MAX_ARGS: usize = 64;
pub const MAX_ARG_LENGTH: usize = 4096;
pub const MAX_TOTAL_SOURCE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Limits {
    pub wall_seconds: u64,
    pub cpu_seconds: u64,
    pub memory_mb: u64,
    pub max_procs: u64,
    pub allow_net: bool,
}

impl Default for Limits {
    fn default() -> Self {
        Self { wall_seconds: 10, cpu_seconds: 5, memory_mb: 256, max_procs: 64, allow_net: false }
    }
}

impl Limits {
    fn from_json(value: Option<&Json>) -> Self {
        let defaults = Limits::default();
        let Some(value) = value else { return defaults };

        let clamp = |key: &str, fallback: u64, ceiling: u64| -> u64 {
            value
                .get(key)
                .and_then(Json::as_u64)
                .map(|n| n.clamp(1, ceiling))
                .unwrap_or(fallback)
        };

        Self {
            wall_seconds: clamp("wall_seconds", defaults.wall_seconds, MAX_WALL_SECONDS),
            cpu_seconds: clamp("cpu_seconds", defaults.cpu_seconds, MAX_CPU_SECONDS),
            memory_mb: clamp("memory_mb", defaults.memory_mb, MAX_MEMORY_MB),
            max_procs: clamp("max_procs", defaults.max_procs, MAX_PROCS),
            // Networking stays off unless the caller asks for it explicitly.
            allow_net: value.get("allow_net").and_then(Json::as_bool).unwrap_or(false),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SourceFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub enum Request {
    /// Compile and run a workspace.
    Execute {
        id: String,
        language: String,
        entry: Option<String>,
        files: Vec<SourceFile>,
        stdin: String,
        /// Passed to the program verbatim, never through a shell.
        args: Vec<String>,
        limits: Limits,
    },
    /// Liveness and capacity probe used by the gateway's health endpoint.
    Health,
}

/// Reject anything that is not a plain relative path inside the workspace.
/// This is the only defence between a hostile filename and the host filesystem,
/// so it rejects by default and allows a narrow, explicit shape.
pub fn validate_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("file name is empty".to_string());
    }
    if name.len() > 255 {
        return Err(format!("file name is longer than 255 characters: {name}"));
    }
    if name.starts_with('/') || name.starts_with('~') {
        return Err(format!("file name must be relative: {name}"));
    }
    if name.contains('\0') || name.contains('\n') || name.contains('\r') {
        return Err(format!("file name contains a control character: {name}"));
    }
    if name.contains('\\') {
        return Err(format!("file name contains a backslash: {name}"));
    }
    for component in name.split('/') {
        if component.is_empty() {
            return Err(format!("file name has an empty path component: {name}"));
        }
        if component == "." || component == ".." {
            return Err(format!("file name escapes the workspace: {name}"));
        }
    }
    Ok(())
}

pub fn parse_request(line: &str) -> Result<Request, String> {
    let value = json::parse(line)?;

    let op = value.get("op").and_then(Json::as_str).unwrap_or("execute");
    if op == "health" {
        return Ok(Request::Health);
    }
    if op != "execute" {
        return Err(format!("unknown operation '{op}'"));
    }

    let language = value
        .get("language")
        .and_then(Json::as_str)
        .ok_or_else(|| "request is missing 'language'".to_string())?
        .to_string();

    if language.is_empty()
        || !language.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("invalid language identifier '{language}'"));
    }

    let id = value
        .get("id")
        .and_then(Json::as_str)
        .unwrap_or("anonymous")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect::<String>();

    let entry = match value.get("entry").and_then(Json::as_str) {
        Some(name) => {
            validate_file_name(name)?;
            Some(name.to_string())
        }
        None => None,
    };

    let mut files = Vec::new();
    let mut total_bytes = 0usize;
    if let Some(items) = value.get("files").and_then(Json::as_array) {
        if items.len() > MAX_FILES {
            return Err(format!("request carries more than {MAX_FILES} files"));
        }
        for item in items {
            let name = item
                .get("name")
                .and_then(Json::as_str)
                .ok_or_else(|| "file entry is missing 'name'".to_string())?;
            validate_file_name(name)?;
            let content = item.get("content").and_then(Json::as_str).unwrap_or("");
            total_bytes += content.len();
            if total_bytes > MAX_TOTAL_SOURCE_BYTES {
                return Err(format!(
                    "workspace exceeds the {MAX_TOTAL_SOURCE_BYTES} byte source limit"
                ));
            }
            files.push(SourceFile { name: name.to_string(), content: content.to_string() });
        }
    }
    if files.is_empty() {
        return Err("request carries no source files".to_string());
    }

    let mut args = Vec::new();
    if let Some(items) = value.get("args").and_then(Json::as_array) {
        if items.len() > MAX_ARGS {
            return Err(format!("request carries more than {MAX_ARGS} arguments"));
        }
        for item in items {
            let argument = item
                .as_str()
                .ok_or_else(|| "every argument must be a string".to_string())?;
            if argument.len() > MAX_ARG_LENGTH {
                return Err(format!("an argument exceeds {MAX_ARG_LENGTH} characters"));
            }
            if argument.contains('\0') {
                return Err("an argument contains a null byte".to_string());
            }
            args.push(argument.to_string());
        }
    }

    Ok(Request::Execute {
        id,
        language,
        entry,
        files,
        stdin: value.get("stdin").and_then(Json::as_str).unwrap_or("").to_string(),
        args,
        limits: Limits::from_json(value.get("limits")),
    })
}

// ---------------------------------------------------------------------------
// Response frames
// ---------------------------------------------------------------------------

pub fn frame_accepted(id: &str, tier: &str, workspace: &str) -> Json {
    json_object! {
        "type" => json::string("accepted"),
        "id" => json::string(id),
        "tier" => json::string(tier),
        "workspace" => json::string(workspace),
    }
}

pub fn frame_output(stream: &str, content: &str) -> Json {
    json_object! {
        "type" => json::string(stream),
        "content" => json::string(content),
    }
}

pub fn frame_exit(
    id: &str,
    code: i32,
    duration_ms: u128,
    truncated: bool,
    meta: Option<Json>,
) -> Json {
    let mut map = BTreeMap::new();
    map.insert("type".to_string(), json::string("exit"));
    map.insert("id".to_string(), json::string(id));
    map.insert("code".to_string(), json::number(code as f64));
    map.insert("execution_time".to_string(), json::number(duration_ms as f64));
    map.insert("truncated".to_string(), json::bool(truncated));
    if let Some(meta) = meta {
        map.insert("meta".to_string(), meta);
    }
    Json::Object(map)
}

pub fn frame_error(id: &str, message: &str) -> Json {
    json_object! {
        "type" => json::string("error"),
        "id" => json::string(id),
        "message" => json::string(message),
    }
}

pub fn frame_health(active: usize, capacity: usize, tier: &str, version: &str) -> Json {
    json_object! {
        "type" => json::string("health"),
        "active_jobs" => json::number(active as f64),
        "capacity" => json::number(capacity as f64),
        "tier" => json::string(tier),
        "version" => json::string(version),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_in_file_names() {
        for name in ["../escape.py", "a/../../b.py", "/etc/passwd", "~/x.py", "..", "dir//x"] {
            assert!(validate_file_name(name).is_err(), "should reject {name}");
        }
    }

    #[test]
    fn accepts_ordinary_relative_paths() {
        for name in ["main.py", "src/lib.rs", "a/b/c/main.cpp", "Cargo.toml"] {
            assert!(validate_file_name(name).is_ok(), "should accept {name}");
        }
    }

    #[test]
    fn clamps_limits_to_the_ceiling() {
        let request = parse_request(
            r#"{"language":"python","files":[{"name":"main.py","content":"x"}],
                "limits":{"wall_seconds":99999,"memory_mb":99999,"cpu_seconds":0}}"#,
        )
        .unwrap();
        let Request::Execute { limits, .. } = request else { panic!("expected execute") };
        assert_eq!(limits.wall_seconds, MAX_WALL_SECONDS);
        assert_eq!(limits.memory_mb, MAX_MEMORY_MB);
        assert_eq!(limits.cpu_seconds, 1);
    }

    #[test]
    fn networking_is_off_unless_requested() {
        let request = parse_request(
            r#"{"language":"python","files":[{"name":"main.py","content":"x"}]}"#,
        )
        .unwrap();
        let Request::Execute { limits, .. } = request else { panic!("expected execute") };
        assert!(!limits.allow_net);
    }

    #[test]
    fn rejects_a_hostile_language_identifier() {
        let request = parse_request(
            r#"{"language":"python; rm -rf /","files":[{"name":"m.py","content":"x"}]}"#,
        );
        assert!(request.is_err());
    }

    #[test]
    fn carries_program_arguments_through_verbatim() {
        let request = parse_request(
            r#"{"language":"python","files":[{"name":"m.py","content":"x"}],
                "args":["--flag","a value","-n"]}"#,
        )
        .unwrap();
        let Request::Execute { args, .. } = request else { panic!("expected execute") };
        assert_eq!(args, vec!["--flag", "a value", "-n"]);
    }

    #[test]
    fn rejects_too_many_arguments() {
        let many: Vec<String> = (0..MAX_ARGS + 1).map(|i| format!("\"a{i}\"")).collect();
        let payload = format!(
            r#"{{"language":"python","files":[{{"name":"m.py","content":"x"}}],"args":[{}]}}"#,
            many.join(",")
        );
        assert!(parse_request(&payload).is_err());
    }

    #[test]
    fn rejects_a_workspace_with_no_files() {
        assert!(parse_request(r#"{"language":"python","files":[]}"#).is_err());
    }
}
