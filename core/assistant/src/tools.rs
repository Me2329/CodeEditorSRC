//! The agent's tools.
//!
//! Every tool acts on one ephemeral workspace directory and nothing else. The
//! agent cannot reach the host filesystem, cannot open a socket, and cannot run
//! a command of its own choosing: `run_code` goes through the same sandbox
//! runner the Run button uses, with the same isolation and the same limits.
//!
//! Tool schemas are declared `strict`, which guarantees the arguments validate
//! against the schema. That matters more than usual here, because forced tool
//! choice is rejected on this model class and `strict` is what replaces the
//! guarantee it used to give.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// How much of a tool's output is worth returning to the model. Beyond this the
/// result is truncated with a marker: a partial file is useful, a context window
/// full of one file is not.
const MAX_TOOL_OUTPUT_BYTES: usize = 60_000;
const MAX_FILE_BYTES: usize = 400_000;
const MAX_SEARCH_HITS: usize = 80;

/// What the agent is allowed to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Read-only. The agent can investigate and propose, but changes nothing
    /// and runs nothing.
    Plan,
    /// Full tool surface, still confined to the sandbox.
    Auto,
}

impl Mode {
    fn allows(self, tool: &str) -> bool {
        match self {
            Mode::Auto => true,
            Mode::Plan => matches!(tool, "read_file" | "list_files" | "search" | "analyze"),
        }
    }
}

/// Result of running one tool.
pub struct ToolOutcome {
    pub content: String,
    pub is_error: bool,
    /// Files this tool changed, so the editor can be updated live.
    pub changed_files: Vec<String>,
}

impl ToolOutcome {
    fn ok(content: impl Into<String>) -> Self {
        ToolOutcome { content: content.into(), is_error: false, changed_files: Vec::new() }
    }

    fn error(content: impl Into<String>) -> Self {
        ToolOutcome { content: content.into(), is_error: true, changed_files: Vec::new() }
    }

    fn changed(content: impl Into<String>, file: &str) -> Self {
        ToolOutcome {
            content: content.into(),
            is_error: false,
            changed_files: vec![file.to_string()],
        }
    }
}

/// The tool set offered to the model, as JSON schemas.
pub fn definitions(mode: Mode) -> Vec<Value> {
    let all = vec![
        json!({
            "name": "read_file",
            "description": "Read a file from the workspace. Returns the contents with line numbers so you can refer to specific lines.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative path, e.g. main.py or src/util.rs"}
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "list_files",
            "description": "List every file in the workspace with its size in bytes.",
            "strict": true,
            "input_schema": {"type": "object", "properties": {}, "required": [], "additionalProperties": false}
        }),
        json!({
            "name": "search",
            "description": "Find a literal string across every file in the workspace. Returns matching lines with their file and line number. Use this to locate a symbol before reading a whole file.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Literal text to find. Not a regular expression."}
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "analyze",
            "description": "Run the static analyzer on a file. Returns its declarations, size and complexity metrics, and any structural errors such as unbalanced delimiters.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "write_file",
            "description": "Create a file, or replace one entirely. Prefer edit_file when changing part of an existing file: a full rewrite loses anything you did not mean to touch.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string", "description": "The complete new contents of the file."}
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "edit_file",
            "description": "Replace an exact snippet in a file. old_text must appear exactly once; include enough surrounding context to make it unique. Fails without changing anything if the text is missing or appears more than once.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_text": {"type": "string", "description": "Exact text to replace, including indentation."},
                    "new_text": {"type": "string", "description": "Replacement text."}
                },
                "required": ["path", "old_text", "new_text"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "run_code",
            "description": "Compile and run the workspace in the isolated sandbox, returning stdout, stderr and the exit code. The sandbox has no network access. Use this to check that a change actually works before reporting it as done.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "stdin": {"type": "string", "description": "Text fed to the program's standard input. Empty for none."},
                    "args": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Command-line arguments. Empty for none."
                    }
                },
                "required": ["stdin", "args"],
                "additionalProperties": false
            }
        }),
    ];

    all.into_iter()
        .filter(|tool| mode.allows(tool["name"].as_str().unwrap_or("")))
        .collect()
}

/// An ephemeral workspace the agent operates on.
pub struct Workspace {
    root: PathBuf,
    language: String,
    runner: PathBuf,
    analyzer: PathBuf,
}

impl Workspace {
    pub fn new(root: PathBuf, language: String, runner: PathBuf, analyzer: PathBuf) -> Self {
        Workspace { root, language, runner, analyzer }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a workspace-relative path, refusing anything that escapes.
    ///
    /// The same rule the gateway and supervisor apply, enforced again here
    /// because this is the layer a model's output reaches directly.
    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        if path.is_empty() {
            return Err("path is empty".to_string());
        }
        if path.starts_with('/') || path.starts_with('~') || path.contains('\\') {
            return Err(format!("'{path}' must be a workspace-relative path"));
        }
        for component in path.split('/') {
            if component.is_empty() || component == "." || component == ".." {
                return Err(format!("'{path}' must not escape the workspace"));
            }
        }
        Ok(self.root.join(path))
    }

    pub fn read(&self, path: &str) -> Result<String, String> {
        let target = self.resolve(path)?;
        fs::read_to_string(&target).map_err(|e| format!("cannot read '{path}': {e}"))
    }

    pub fn write(&self, path: &str, content: &str) -> Result<(), String> {
        if content.len() > MAX_FILE_BYTES {
            return Err(format!("refusing to write more than {MAX_FILE_BYTES} bytes"));
        }
        let target = self.resolve(path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("cannot create directory: {e}"))?;
        }
        fs::write(&target, content).map_err(|e| format!("cannot write '{path}': {e}"))
    }

    /// Every file in the workspace, excluding the scratch directories the
    /// sandbox creates.
    pub fn files(&self) -> Vec<(String, usize)> {
        let mut found = BTreeMap::new();
        collect(&self.root, &self.root, &mut found);
        found.into_iter().collect()
    }

    /// Current contents of every file, for handing back to the editor.
    pub fn snapshot(&self) -> Vec<(String, String)> {
        self.files()
            .into_iter()
            .filter_map(|(name, _)| self.read(&name).ok().map(|content| (name, content)))
            .collect()
    }
}

fn collect(root: &Path, directory: &Path, found: &mut BTreeMap<String, usize>) {
    let Ok(entries) = fs::read_dir(directory) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();

        // Sandbox scratch, caches and the runner's own scaffolding are not the
        // user's files and would only distract the model.
        if name.starts_with('.') || name == "tmp" || name == "main_bin" {
            continue;
        }
        if path.is_dir() {
            collect(root, &path, found);
        } else if let Ok(metadata) = entry.metadata() {
            if let Ok(relative) = path.strip_prefix(root) {
                found.insert(relative.to_string_lossy().to_string(), metadata.len() as usize);
            }
        }
    }
}

/// Execute one tool call.
pub fn execute(workspace: &Workspace, mode: Mode, name: &str, input: &Value) -> ToolOutcome {
    if !mode.allows(name) {
        return ToolOutcome::error(format!(
            "'{name}' is not available in plan mode. You can read, list, search and analyze; \
             ask the user to switch the agent to Auto if a change is needed."
        ));
    }

    let text = |key: &str| input.get(key).and_then(|v| v.as_str()).unwrap_or("");

    match name {
        "read_file" => match workspace.read(text("path")) {
            Ok(content) => ToolOutcome::ok(number_lines(&truncate(&content))),
            Err(message) => ToolOutcome::error(message),
        },

        "list_files" => {
            let files = workspace.files();
            if files.is_empty() {
                return ToolOutcome::ok("The workspace is empty.");
            }
            let mut out = String::new();
            for (name, size) in files {
                out.push_str(&format!("{name}  ({size} bytes)\n"));
            }
            ToolOutcome::ok(out)
        }

        "search" => {
            let query = text("query");
            if query.is_empty() {
                return ToolOutcome::error("query is empty");
            }
            let mut hits = Vec::new();
            for (file, _) in workspace.files() {
                let Ok(content) = workspace.read(&file) else { continue };
                for (offset, line) in content.lines().enumerate() {
                    if line.contains(query) {
                        hits.push(format!("{}:{}: {}", file, offset + 1, line.trim()));
                        if hits.len() >= MAX_SEARCH_HITS {
                            break;
                        }
                    }
                }
                if hits.len() >= MAX_SEARCH_HITS {
                    break;
                }
            }
            if hits.is_empty() {
                ToolOutcome::ok(format!("No file contains '{query}'."))
            } else {
                ToolOutcome::ok(hits.join("\n"))
            }
        }

        "analyze" => {
            let path = text("path");
            match workspace.read(path) {
                Err(message) => ToolOutcome::error(message),
                Ok(source) => match run_analyzer(workspace, &source) {
                    Ok(report) => ToolOutcome::ok(truncate(&report)),
                    Err(message) => ToolOutcome::error(message),
                },
            }
        }

        "write_file" => {
            let path = text("path");
            match workspace.write(path, text("content")) {
                Ok(()) => ToolOutcome::changed(format!("Wrote {path}."), path),
                Err(message) => ToolOutcome::error(message),
            }
        }

        "edit_file" => {
            let path = text("path");
            let old = text("old_text");
            let new = text("new_text");

            if old.is_empty() {
                return ToolOutcome::error("old_text is empty; use write_file to create a file");
            }
            let content = match workspace.read(path) {
                Ok(content) => content,
                Err(message) => return ToolOutcome::error(message),
            };

            // An ambiguous edit is refused rather than applied to the first
            // match: guessing which occurrence was meant silently corrupts code.
            let occurrences = content.matches(old).count();
            if occurrences == 0 {
                return ToolOutcome::error(format!(
                    "That exact text is not in {path}. Read the file again and copy the snippet \
                     precisely, including indentation."
                ));
            }
            if occurrences > 1 {
                return ToolOutcome::error(format!(
                    "That text appears {occurrences} times in {path}. Include more surrounding \
                     context so the snippet is unique."
                ));
            }

            match workspace.write(path, &content.replacen(old, new, 1)) {
                Ok(()) => ToolOutcome::changed(format!("Edited {path}."), path),
                Err(message) => ToolOutcome::error(message),
            }
        }

        "run_code" => {
            let args: Vec<String> = input
                .get("args")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            run_in_sandbox(workspace, text("stdin"), &args)
        }

        other => ToolOutcome::error(format!("unknown tool '{other}'")),
    }
}

/// Run the workspace through the sandbox runner and report what happened.
fn run_in_sandbox(workspace: &Workspace, stdin: &str, args: &[String]) -> ToolOutcome {
    if !workspace.runner.is_file() {
        return ToolOutcome::error(format!(
            "the sandbox runner is not available at {}",
            workspace.runner.display()
        ));
    }

    let stdin_path = workspace.root.join(".agent_stdin");
    if let Err(e) = fs::write(&stdin_path, stdin) {
        return ToolOutcome::error(format!("cannot stage standard input: {e}"));
    }

    let mut command = Command::new("bash");
    command
        .arg(&workspace.runner)
        .arg("--lang").arg(&workspace.language)
        .arg("--workspace").arg(&workspace.root)
        .arg("--stdin-file").arg(&stdin_path)
        .arg("--timeout").arg("20")
        .arg("--compile-timeout").arg("60")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for argument in args {
        command.arg("--arg").arg(argument);
    }

    let output = match command.output() {
        Ok(output) => output,
        Err(e) => return ToolOutcome::error(format!("could not start the sandbox: {e}")),
    };
    let _ = fs::remove_file(&stdin_path);

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let mut report = format!("exit code: {code}\n");
    if code == 124 {
        report.push_str("(the run hit its 20 second time limit)\n");
    }
    report.push_str("\n--- stdout ---\n");
    report.push_str(if stdout.trim().is_empty() { "(empty)\n" } else { &stdout });
    report.push_str("\n--- stderr ---\n");
    report.push_str(if stderr.trim().is_empty() { "(empty)\n" } else { &stderr });

    // A non-zero exit is information, not a tool failure: the model should read
    // the output and react, not be told the tool broke.
    ToolOutcome::ok(truncate(&report))
}

fn run_analyzer(workspace: &Workspace, source: &str) -> Result<String, String> {
    if !workspace.analyzer.is_file() {
        return Err(format!(
            "the analyzer is not built at {}",
            workspace.analyzer.display()
        ));
    }

    use std::io::Write;
    let mut child = Command::new(&workspace.analyzer)
        .arg("--language").arg(&workspace.language)
        .arg("--format").arg("tree")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the analyzer: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(source.as_bytes());
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("the analyzer failed: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Prefix each line with its number, so the model can cite exact locations.
fn number_lines(content: &str) -> String {
    let mut out = String::with_capacity(content.len() + content.len() / 8);
    for (offset, line) in content.lines().enumerate() {
        out.push_str(&format!("{:>5} | {}\n", offset + 1, line));
    }
    if out.is_empty() {
        out.push_str("(the file is empty)\n");
    }
    out
}

fn truncate(text: &str) -> String {
    if text.len() <= MAX_TOOL_OUTPUT_BYTES {
        return text.to_string();
    }
    let mut end = MAX_TOOL_OUTPUT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… output truncated at {MAX_TOOL_OUTPUT_BYTES} bytes …", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace() -> Workspace {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("cc_tools_{nanos:x}"));
        fs::create_dir_all(&root).unwrap();
        Workspace::new(
            root,
            "python".to_string(),
            PathBuf::from("/nonexistent/runner.sh"),
            PathBuf::from("/nonexistent/analyzer"),
        )
    }

    #[test]
    fn plan_mode_offers_only_read_only_tools() {
        let names: Vec<String> = definitions(Mode::Plan)
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"read_file".to_string()));
        assert!(!names.contains(&"write_file".to_string()));
        assert!(!names.contains(&"run_code".to_string()));

        assert_eq!(definitions(Mode::Auto).len(), 7);
    }

    #[test]
    fn every_tool_is_strict_and_closed() {
        // strict replaces the guarantee forced tool choice used to give, and it
        // requires a closed schema with an explicit required list.
        for tool in definitions(Mode::Auto) {
            let name = tool["name"].as_str().unwrap();
            assert_eq!(tool["strict"], true, "{name} must be strict");
            assert_eq!(
                tool["input_schema"]["additionalProperties"], false,
                "{name} must close its schema"
            );
            assert!(
                tool["input_schema"].get("required").is_some(),
                "{name} must list required properties"
            );
        }
    }

    #[test]
    fn a_write_is_refused_in_plan_mode() {
        let workspace = temp_workspace();
        let outcome = execute(
            &workspace,
            Mode::Plan,
            "write_file",
            &json!({"path": "x.py", "content": "1"}),
        );
        assert!(outcome.is_error);
        assert!(outcome.content.contains("plan mode"));
        assert!(!workspace.root().join("x.py").exists());
        let _ = fs::remove_dir_all(workspace.root());
    }

    #[test]
    fn paths_cannot_escape_the_workspace() {
        let workspace = temp_workspace();
        for path in ["../escape.py", "a/../../b.py", "/etc/passwd", "~/x.py", "a\\\\b.py"] {
            let outcome = execute(&workspace, Mode::Auto, "read_file", &json!({"path": path}));
            assert!(outcome.is_error, "should refuse {path}");
        }
        let _ = fs::remove_dir_all(workspace.root());
    }

    #[test]
    fn read_returns_numbered_lines() {
        let workspace = temp_workspace();
        workspace.write("main.py", "first\nsecond\n").unwrap();
        let outcome = execute(&workspace, Mode::Auto, "read_file", &json!({"path": "main.py"}));
        assert!(outcome.content.contains("1 | first"));
        assert!(outcome.content.contains("2 | second"));
        let _ = fs::remove_dir_all(workspace.root());
    }

    #[test]
    fn edit_replaces_a_unique_snippet_and_reports_the_change() {
        let workspace = temp_workspace();
        workspace.write("main.py", "x = 1\ny = 2\n").unwrap();

        let outcome = execute(
            &workspace,
            Mode::Auto,
            "edit_file",
            &json!({"path": "main.py", "old_text": "y = 2", "new_text": "y = 99"}),
        );
        assert!(!outcome.is_error);
        assert_eq!(outcome.changed_files, vec!["main.py"]);
        assert_eq!(workspace.read("main.py").unwrap(), "x = 1\ny = 99\n");
        let _ = fs::remove_dir_all(workspace.root());
    }

    #[test]
    fn an_ambiguous_edit_changes_nothing() {
        let workspace = temp_workspace();
        workspace.write("main.py", "value = 1\nvalue = 1\n").unwrap();

        let outcome = execute(
            &workspace,
            Mode::Auto,
            "edit_file",
            &json!({"path": "main.py", "old_text": "value = 1", "new_text": "value = 2"}),
        );
        assert!(outcome.is_error);
        assert!(outcome.content.contains("appears 2 times"));
        // The file must be untouched.
        assert_eq!(workspace.read("main.py").unwrap(), "value = 1\nvalue = 1\n");
        let _ = fs::remove_dir_all(workspace.root());
    }

    #[test]
    fn a_missing_snippet_is_reported_not_guessed() {
        let workspace = temp_workspace();
        workspace.write("main.py", "x = 1\n").unwrap();

        let outcome = execute(
            &workspace,
            Mode::Auto,
            "edit_file",
            &json!({"path": "main.py", "old_text": "nope", "new_text": "y"}),
        );
        assert!(outcome.is_error);
        assert_eq!(workspace.read("main.py").unwrap(), "x = 1\n");
        let _ = fs::remove_dir_all(workspace.root());
    }

    #[test]
    fn search_reports_file_and_line() {
        let workspace = temp_workspace();
        workspace.write("a.py", "alpha\nbeta\n").unwrap();
        workspace.write("b.py", "gamma\nbeta\n").unwrap();

        let outcome = execute(&workspace, Mode::Auto, "search", &json!({"query": "beta"}));
        assert!(outcome.content.contains("a.py:2"));
        assert!(outcome.content.contains("b.py:2"));
        let _ = fs::remove_dir_all(workspace.root());
    }

    #[test]
    fn search_says_so_when_nothing_matches() {
        let workspace = temp_workspace();
        workspace.write("a.py", "alpha\n").unwrap();
        let outcome = execute(&workspace, Mode::Auto, "search", &json!({"query": "zzz"}));
        assert!(!outcome.is_error);
        assert!(outcome.content.contains("No file contains"));
        let _ = fs::remove_dir_all(workspace.root());
    }

    #[test]
    fn listing_hides_sandbox_scratch() {
        let workspace = temp_workspace();
        workspace.write("main.py", "x").unwrap();
        fs::create_dir_all(workspace.root().join("tmp")).unwrap();
        fs::write(workspace.root().join("tmp/junk"), "x").unwrap();
        fs::write(workspace.root().join(".cache_marker"), "x").unwrap();

        let names: Vec<String> = workspace.files().into_iter().map(|(name, _)| name).collect();
        assert_eq!(names, vec!["main.py"]);
        let _ = fs::remove_dir_all(workspace.root());
    }

    #[test]
    fn an_unknown_tool_is_reported_rather_than_ignored() {
        let workspace = temp_workspace();
        let outcome = execute(&workspace, Mode::Auto, "rm_rf", &json!({}));
        assert!(outcome.is_error);
        let _ = fs::remove_dir_all(workspace.root());
    }
}
