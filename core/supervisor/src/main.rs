//! CodeCraft Studio process supervisor daemon.
//!
//! Listens on a Unix domain socket and turns execution requests from the
//! FastAPI gateway into sandboxed child processes. It sits between the gateway
//! and the kernel isolation primitives so that the network-facing service never
//! spawns user code directly, and so concurrency and resource ceilings are
//! enforced in one place.
//!
//! Usage:
//!   codecraft-supervisor [--socket PATH] [--runner PATH]
//!                        [--workspace-root PATH] [--max-jobs N]

#[macro_use]
mod json;
mod protocol;
mod sandbox;
mod workspace;

use json::Json;
use protocol::Request;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

const VERSION: &str = env!("CARGO_PKG_VERSION");

struct Config {
    socket: PathBuf,
    runner: PathBuf,
    workspace_root: PathBuf,
    max_jobs: usize,
}

impl Config {
    fn from_args() -> Result<Self, String> {
        let mut config = Config {
            socket: PathBuf::from(
                std::env::var("CODECRAFT_SOCKET")
                    .unwrap_or_else(|_| "/run/codecraft/supervisor.sock".to_string()),
            ),
            runner: PathBuf::from(
                std::env::var("CODECRAFT_RUNNER")
                    .unwrap_or_else(|_| "scripts/sandbox_runner.sh".to_string()),
            ),
            workspace_root: PathBuf::from(
                std::env::var("CODECRAFT_WORKSPACE_ROOT")
                    .unwrap_or_else(|_| "/var/tmp/codecraft".to_string()),
            ),
            max_jobs: std::env::var("CODECRAFT_MAX_JOBS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8),
        };

        let args: Vec<String> = std::env::args().skip(1).collect();
        let mut i = 0;
        while i < args.len() {
            let value = || -> Result<String, String> {
                args.get(i + 1)
                    .cloned()
                    .ok_or_else(|| format!("{} requires a value", args[i]))
            };
            match args[i].as_str() {
                "--socket" => { config.socket = PathBuf::from(value()?); i += 2 }
                "--runner" => { config.runner = PathBuf::from(value()?); i += 2 }
                "--workspace-root" => { config.workspace_root = PathBuf::from(value()?); i += 2 }
                "--max-jobs" => {
                    config.max_jobs = value()?.parse().map_err(|_| "--max-jobs expects a number".to_string())?;
                    i += 2
                }
                "--version" => { println!("codecraft-supervisor {VERSION}"); process::exit(0) }
                "--help" | "-h" => { print_usage(); process::exit(0) }
                other => return Err(format!("unknown argument '{other}'")),
            }
        }

        if config.max_jobs == 0 {
            return Err("--max-jobs must be at least 1".to_string());
        }
        Ok(config)
    }
}

fn print_usage() {
    println!(
        "CodeCraft Studio process supervisor {VERSION}\n\n\
         Usage: codecraft-supervisor [options]\n\n\
         Options:\n  \
         --socket PATH           Unix socket to listen on\n  \
         --runner PATH           Path to sandbox_runner.sh\n  \
         --workspace-root PATH   Directory holding ephemeral workspaces\n  \
         --max-jobs N            Maximum concurrent executions (default 8)\n  \
         --version               Print the version and exit\n"
    );
}

fn main() {
    let config = match Config::from_args() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("[supervisor] {message}");
            print_usage();
            process::exit(64);
        }
    };

    if !config.runner.exists() {
        eprintln!(
            "[supervisor] sandbox runner not found at {}. Set --runner or CODECRAFT_RUNNER.",
            config.runner.display()
        );
        process::exit(66);
    }

    if let Some(parent) = config.socket.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[supervisor] cannot create socket directory {}: {e}", parent.display());
            process::exit(73);
        }
    }
    // A socket left behind by a previous run would block bind().
    let _ = std::fs::remove_file(&config.socket);

    let listener = match UnixListener::bind(&config.socket) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[supervisor] cannot bind {}: {e}", config.socket.display());
            process::exit(73);
        }
    };
    set_socket_permissions(&config.socket);

    let tier = detect_tier(&config.runner);
    eprintln!(
        "[supervisor] listening on {} | runner {} | isolation {} | capacity {}",
        config.socket.display(),
        config.runner.display(),
        tier,
        config.max_jobs
    );

    let shared = Arc::new(Shared {
        runner: config.runner.clone(),
        workspace_root: config.workspace_root.clone(),
        max_jobs: config.max_jobs,
        active: AtomicUsize::new(0),
        tier,
    });

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let shared = Arc::clone(&shared);
                thread::spawn(move || {
                    if let Err(e) = handle_connection(stream, &shared) {
                        eprintln!("[supervisor] connection ended: {e}");
                    }
                });
            }
            Err(e) => eprintln!("[supervisor] accept failed: {e}"),
        }
    }
}

struct Shared {
    runner: PathBuf,
    workspace_root: PathBuf,
    max_jobs: usize,
    active: AtomicUsize,
    tier: String,
}

/// Reserves one execution slot and releases it when dropped, so a panic or an
/// early return cannot leak capacity.
struct Slot<'a>(&'a AtomicUsize);

impl<'a> Slot<'a> {
    fn acquire(counter: &'a AtomicUsize, max: usize) -> Option<Self> {
        let mut current = counter.load(Ordering::Acquire);
        loop {
            if current >= max {
                return None;
            }
            match counter.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Slot(counter)),
                Err(observed) => current = observed,
            }
        }
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn handle_connection(stream: UnixStream, shared: &Shared) -> std::io::Result<()> {
    let mut writer = stream.try_clone()?;
    // Cap the request before parsing: an unbounded read is a denial-of-service
    // vector even behind a trusted gateway.
    let mut reader = BufReader::new(stream).take(protocol::MAX_REQUEST_BYTES as u64);

    let mut line = String::new();
    let read_result = reader.read_line(&mut line);

    let send = |writer: &mut UnixStream, frame: Json| -> std::io::Result<()> {
        writer.write_all(frame.to_string().as_bytes())?;
        writer.write_all(b"\n")?;
        writer.flush()
    };

    if let Err(e) = read_result {
        // Invalid UTF-8 on the wire is a client error, not a fatal one.
        let message = if e.kind() == std::io::ErrorKind::InvalidData {
            "request is not valid UTF-8".to_string()
        } else {
            format!("could not read request: {e}")
        };
        send(&mut writer, protocol::frame_error("unknown", &message))?;
        let _ = writer.shutdown(Shutdown::Both);
        return Ok(());
    }

    let request = match protocol::parse_request(line.trim_end()) {
        Ok(request) => request,
        Err(message) => {
            send(&mut writer, protocol::frame_error("unknown", &message))?;
            let _ = writer.shutdown(Shutdown::Both);
            return Ok(());
        }
    };

    match request {
        Request::Health => {
            let active = shared.active.load(Ordering::Acquire);
            send(
                &mut writer,
                protocol::frame_health(active, shared.max_jobs, &shared.tier, VERSION),
            )?;
        }
        Request::Execute { id, language, entry, files, stdin, limits } => {
            let Some(_slot) = Slot::acquire(&shared.active, shared.max_jobs) else {
                send(
                    &mut writer,
                    protocol::frame_error(
                        &id,
                        "Supervisor is at capacity; retry once a running job finishes.",
                    ),
                )?;
                let _ = writer.shutdown(Shutdown::Both);
                return Ok(());
            };

            let mut workspace =
                match workspace::Workspace::create(&shared.workspace_root, &id, &files) {
                    Ok(workspace) => workspace,
                    Err(e) => {
                        send(
                            &mut writer,
                            protocol::frame_error(&id, &format!("cannot prepare workspace: {e}")),
                        )?;
                        return Ok(());
                    }
                };

            // Debug switch: leave the workspace on disk for post-mortem inspection.
            if std::env::var("CODECRAFT_KEEP_WORKSPACE").is_ok() {
                workspace.keep();
            }

            send(
                &mut writer,
                protocol::frame_accepted(&id, &shared.tier, &workspace.path().to_string_lossy()),
            )?;

            let outcome = sandbox::execute(
                &shared.runner,
                workspace.path(),
                &language,
                entry.as_deref(),
                &limits,
                &stdin,
                |stream, chunk| {
                    let frame = protocol::frame_output(stream.as_str(), chunk);
                    writer.write_all(frame.to_string().as_bytes())?;
                    writer.write_all(b"\n")?;
                    writer.flush()
                },
            );

            match outcome {
                Ok(outcome) => {
                    let frame = protocol::frame_exit(
                        &id,
                        outcome.exit_code,
                        outcome.duration_ms,
                        outcome.truncated,
                        outcome.meta,
                    );
                    send(&mut writer, frame)?;
                }
                Err(e) => {
                    send(&mut writer, protocol::frame_error(&id, &format!("execution failed: {e}")))?;
                }
            }
        }
    }

    let _ = writer.shutdown(Shutdown::Both);
    Ok(())
}

/// Restrict the socket to its owner. The gateway runs as the same user; nothing
/// else on the host should be able to queue work.
fn set_socket_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

/// Ask the runner's own detection logic which isolation tier is active, so the
/// supervisor reports the same answer the sandbox will actually use.
fn detect_tier(runner: &Path) -> String {
    let library = runner
        .parent()
        .map(|dir| dir.join("lib/isolation.sh"))
        .unwrap_or_else(|| PathBuf::from("lib/isolation.sh"));
    if !library.exists() {
        return "unknown".to_string();
    }
    process::Command::new("bash")
        .arg("-c")
        .arg(format!("source '{}' && cc_detect_tier", library.display()))
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|tier| !tier.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}
