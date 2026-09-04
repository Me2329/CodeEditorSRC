//! Sandbox invocation and live output streaming.
//!
//! The supervisor never runs user code itself. It prepares a workspace, invokes
//! the Bash runner that owns the kernel isolation primitives, and relays the
//! child's output as it arrives so a long-running program shows progress in the
//! terminal instead of appearing frozen.

use crate::json::{self, Json};
use crate::protocol::Limits;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

/// Ceiling on how much output one job may stream back. A program that prints in
/// an unbounded loop is cut off here rather than exhausting gateway memory.
pub const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

pub struct Outcome {
    pub exit_code: i32,
    pub duration_ms: u128,
    pub meta: Option<Json>,
    pub truncated: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

impl Stream {
    pub fn as_str(self) -> &'static str {
        match self {
            Stream::Stdout => "stdout",
            Stream::Stderr => "stderr",
        }
    }
}

/// Run one job. `emit` is called for each chunk as it arrives; returning an
/// error from it aborts the relay and kills the child.
pub fn execute<F>(
    runner: &Path,
    workspace: &Path,
    language: &str,
    entry: Option<&str>,
    limits: &Limits,
    stdin_data: &str,
    mut emit: F,
) -> std::io::Result<Outcome>
where
    F: FnMut(Stream, &str) -> std::io::Result<()>,
{
    let meta_path = workspace.join(".codecraft_meta.json");
    let stdin_path = workspace.join(".codecraft_stdin");
    fs::write(&stdin_path, stdin_data)?;

    let mut command = Command::new(runner);
    command
        .arg("--lang").arg(language)
        .arg("--workspace").arg(workspace)
        .arg("--stdin-file").arg(&stdin_path)
        .arg("--meta-file").arg(&meta_path)
        .arg("--timeout").arg(limits.wall_seconds.to_string())
        .arg("--cpu-seconds").arg(limits.cpu_seconds.to_string())
        .arg("--memory-mb").arg(limits.memory_mb.to_string())
        .arg("--max-procs").arg(limits.max_procs.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(entry) = entry {
        command.arg("--entry").arg(entry);
    }
    if limits.allow_net {
        command.arg("--allow-net");
    }

    let started = Instant::now();
    let mut child = command.spawn()?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    // Both pipes are drained concurrently. Reading them in sequence would let a
    // full stderr pipe block a child that is still writing to stdout.
    let (sender, receiver) = mpsc::channel::<(Stream, Vec<u8>)>();
    let stdout_handle = spawn_reader(stdout, Stream::Stdout, sender.clone());
    let stderr_handle = spawn_reader(stderr, Stream::Stderr, sender);

    let mut emitted = 0usize;
    let mut truncated = false;

    for (stream, chunk) in receiver {
        if truncated {
            continue;
        }
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(emitted);
        if remaining == 0 {
            truncated = true;
            let _ = child.kill();
            let _ = emit(
                Stream::Stderr,
                "\r\n[codecraft] Output limit reached; execution stopped.\r\n",
            );
            continue;
        }
        let slice = if chunk.len() > remaining { &chunk[..remaining] } else { &chunk[..] };
        emitted += slice.len();
        // A failed relay means the gateway hung up. Stop the job rather than
        // letting it run on with nowhere to send its output.
        if let Err(error) = emit(stream, &String::from_utf8_lossy(slice)) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    }

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    let status = child.wait()?;
    let duration_ms = started.elapsed().as_millis();

    // 128 + signal number, matching how a shell reports a signalled child.
    let exit_code = status.code().unwrap_or_else(|| {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            status.signal().map(|s| 128 + s).unwrap_or(-1)
        }
        #[cfg(not(unix))]
        {
            -1
        }
    });

    let meta = fs::read_to_string(&meta_path).ok().and_then(|text| json::parse(&text).ok());
    let _ = fs::remove_file(&meta_path);
    let _ = fs::remove_file(&stdin_path);

    Ok(Outcome { exit_code, duration_ms, meta, truncated })
}

fn spawn_reader<R>(
    mut source: R,
    stream: Stream,
    sender: mpsc::Sender<(Stream, Vec<u8>)>,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match source.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if sender.send((stream, buffer[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(ref e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    })
}
