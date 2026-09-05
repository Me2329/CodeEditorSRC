# Architecture

Five layers on the execution path, each in the language that suits its job,
plus two that sit beside it: the analyzer and the assistant with its model. This
document explains what each one owns and why the seams fall where they do.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ CLIENT                          React 19 + TypeScript                    │
│   Monaco editor · xterm.js console · live preview · analysis panel       │
│   In-memory virtual file system, persisted to local storage              │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │  WebSocket (JSON frames) / REST
┌──────────────────────────────────┴───────────────────────────────────────┐
│ GATEWAY                         Python 3.11+ · FastAPI                   │
│   Request validation · rate limiting · concurrency cap · output relay    │
│   Runtime catalogue · static analysis proxy · health reporting           │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │  Unix socket (newline-delimited JSON)
┌──────────────────────────────────┴───────────────────────────────────────┐
│ SUPERVISOR                      Rust · no third-party crates             │
│   Ephemeral workspaces · path validation · limit clamping                │
│   Concurrency slots · live stdout/stderr relay · output ceiling          │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │  subprocess
┌──────────────────────────────────┴───────────────────────────────────────┐
│ RUNNER                          Bash · the isolation boundary            │
│   Tier detection · privilege drop · namespaces · mount sealing           │
│   rlimits and cgroups · toolchain staging · compile and run phases       │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │  syscalls
┌──────────────────────────────────┴───────────────────────────────────────┐
│ KERNEL              nsjail · user namespaces · cgroups v2 · seccomp-bpf  │
└──────────────────────────────────────────────────────────────────────────┘

         ┌───────────────────────────────────────────────────────┐
         │ ANALYZER   C++17 · no dependencies · pure analysis     │
         │   Lexer → scope tree → metrics → diagnostics → JSON    │
         └───────────────────────────────────────────────────────┘

         ┌───────────────────────────────────────────────────────┐
         │ ASSISTANT  Rust · workspace index + model client       │
         │   0.19ms local answers · agent loop · seven tools      │
         └───────────────────────┬───────────────────────────────┘
                                 │  HTTP, Messages format
         ┌───────────────────────┴───────────────────────────────┐
         │ MODEL      Python · CodeCraft LM, trained here         │
         │   Byte-level BPE · transformer · trainer · sampler     │
         └───────────────────────────────────────────────────────┘
```

## Where the seams are, and why

**The isolation lives in one place.** Everything about namespaces, privileges
and resource limits is in `scripts/sandbox_runner.sh` and `scripts/lib/`. The
gateway and the supervisor both invoke that same script, which is what makes the
single-process development path and the daemon production path equally safe. A
security change is reviewed in one file, not three.

**The runtime registry is shared, not restated.** `scripts/runtimes.json` holds
the entry filename, compile and run argument vectors, toolchain probe, starter
template and address-space policy for all 41 runtimes. Bash reads it with `jq`,
the gateway loads it at import, the frontend receives it over the API. Adding a
language is one entry, not three edits that can drift.

**The gateway can run without the supervisor.** When the supervisor socket
exists the gateway delegates to it, so the network-facing process never spawns
user code itself. When it does not, the gateway invokes the runner directly.
Both paths apply identical isolation because the isolation is in the runner.
Starting or stopping the daemon needs no configuration change.

**Optional dependencies stay optional.** Redis backs rate limiting when
reachable and an in-process limiter takes over when it is not. Falling back
protects a single node; failing open would not.

**The model is a separate layer, reachable over HTTP.** `core/model` trains and
serves CodeCraft LM, our own transformer, in Python. It is not linked into the
assistant daemon and the daemon knows nothing about it: the daemon speaks the
Messages wire format, and the model server answers it. Pointing
`ANTHROPIC_BASE_URL` at the model server substitutes one for the other without
either side changing. Keeping the seam at HTTP is what lets the training stack
live in Python, where the tooling is, while the serving path the editor uses
stays in Rust.

## Execution flow

```
Run pressed
   │
   ├─ client bundles the whole workspace into one JSON frame
   ▼
Gateway
   ├─ validate: filenames, language against the registry, limits, total size
   ├─ rate limit for this client
   ├─ reject a runtime whose toolchain this node lacks
   └─ acquire a concurrency slot
   ▼
Supervisor (or the gateway directly)
   ├─ create the ephemeral workspace and write the files
   ├─ clamp the requested limits to fixed ceilings
   └─ invoke the runner
   ▼
Runner
   ├─ detect the strongest isolation tier this host supports
   ├─ stage toolchains that the sandbox user cannot otherwise reach
   ├─ drop privileges, then unshare namespaces
   ├─ seal the filesystem: read-only root, ephemeral /tmp, writable workspace
   ├─ compile phase, with its own deadline and a relaxed address space
   └─ run phase, under the full resource envelope
   ▼
Output streams back through every layer as it is produced
   ▼
Workspace destroyed · exit code, duration and isolation metadata returned
```

Compilation gets its own deadline and a relaxed address-space limit because
compilers legitimately need far more memory than the programs they emit.

## Design decisions worth the words

**Two memory-limit policies.** `RLIMIT_AS` caps virtual address space, which
several runtimes reserve enormously at startup: the JVM, Go, V8, BEAM and
CoreCLR would all be killed before running a line. Each registry entry declares
whether it tolerates a strict address-space limit; those that do not are capped
by cgroups and the wall clock instead. Applying one policy to everything would
either break those runtimes or leave the rest under-constrained.

**The runner waits on each phase in the background.** Bash defers a trap until
the running foreground command finishes, so a runner blocked on a foreground
child would ignore SIGTERM until the job ended on its own. Backgrounding the
phase and waiting on it makes `wait` interruptible, which is what turns abort
from a 60-second wait into a sub-second one.

**Timeout exit codes are normalised.** GNU `timeout` reports 124 when SIGTERM
ends a run, but a process that ignores SIGTERM is killed by the follow-up
SIGKILL and surfaces as 137. Both mean the deadline expired, so the runner
normalises them once rather than leaving every caller to handle the pair. It
also runs `timeout --foreground`, because in its default mode `timeout` signals
its own process group and kills itself before it can report anything.

**Output is decoded incrementally.** Pipe chunks break wherever the buffer ends,
which can split a multi-byte UTF-8 sequence across two reads. Decoding each
chunk independently turns those into replacement characters, so both relays hold
the partial sequence until the next chunk completes it.

**The core services carry no dependencies.** The supervisor and the analyzer sit
closest to untrusted code. Each ships a small amount of JSON handling rather than
pulling in a crate or a library, which keeps their supply chain empty and lets
both build offline.

**Monaco is bundled, not fetched.** `@monaco-editor/react` loads the editor from
a CDN by default. A platform meant for airgapped and self-hosted networks cannot
have its editor disappear when a third party is unreachable, so Monaco is part
of the bundle and its language workers are wired up explicitly. The same
reasoning removed the web-font CDN link.

## Wire protocols

**Client to gateway**, JSON over WebSocket. The client sends
`{action, language, files, entry, stdin, limits}` or `{action: "abort"}`. The
gateway replies with `ready`, then `accepted`, then a stream of `stdout` and
`stderr` frames, then exactly one `exit` or `error`. The socket stays open
across runs, so a run starts without a handshake, and one job at a time per
connection: a terminal can only show one stream.

**Gateway to supervisor**, newline-delimited JSON over a Unix socket, one job
per connection. `{op: "health"}` reports capacity; `{op: "execute", …}` runs a
job. The supervisor answers with `accepted`, output frames, and a terminal
`exit` or `error` frame carrying the isolation metadata for that run.

**Assistant daemon to model server**, the Messages request and its
server-sent-event stream. `message_start`, `content_block_start`, a run of
`content_block_delta` frames carrying `text_delta`, then `content_block_stop`,
`message_delta` with the stop reason and usage, and `message_stop`. The local
model server in `core/model` implements exactly this sequence, which is why the
client works against either endpoint unchanged.

## Adding a runtime

Add an entry to `scripts/gen_runtimes.py`, regenerate the registry, and run the
conformance suite:

```bash
python3 scripts/gen_runtimes.py > scripts/runtimes.json
./scripts/selftest.sh
```

The entry needs an id, label, category, Monaco language, entry filename, a probe
binary, compile and run argument vectors, a starter template, and whether the
runtime tolerates a strict address-space limit. Nothing else changes: the
gateway and the frontend pick it up from the registry.
