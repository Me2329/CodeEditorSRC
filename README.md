# CodeCraft Studio

A browser IDE that compiles and runs code in isolated, ephemeral sandboxes.

Five layers, each in the language that suits it: a React 19 client, a Python
FastAPI gateway, a Rust process supervisor, a C++ static analyzer, and a Bash
isolation runner that owns the kernel primitives.

```
Browser          React 19 + Monaco + xterm.js
   │  WebSocket
Gateway          FastAPI - validation, rate limiting, streaming
   │  Unix socket
Supervisor       Rust - workspaces, concurrency, output relay
   │  subprocess
Runner           Bash - namespaces, rlimits, mount sealing
   │
Kernel           nsjail / user namespaces / cgroups v2
```

## Quick start

```bash
make setup     # dependencies, then build the Rust and C++ services
make doctor    # what can this host actually do?
make dev       # gateway on :8000, frontend on :5173
```

Open <http://localhost:5173>. Press **Run**, or Ctrl+Enter.

`make setup` needs Python 3.11+, Node 20+, a Rust toolchain, a C++17 compiler
and `jq`. Language toolchains are separate: `make provision` installs a core set,
and `./scripts/provision_toolchains.sh --help` lists the rest.

## What it does

**41 runtimes** across four paradigms: natively compiled (C, C++, Rust, Go, Zig,
Haskell, D, Fortran, Nim, NASM), interpreted (Python, PyPy, Ruby, PHP, Perl, Lua,
R, Julia, Racket, Erlang, AWK), managed VM (Java, C#, F#, Kotlin, Scala, Swift,
Dart, Elixir, Clojure, Groovy) and web or scripting (Node, Deno, Bun, Bash, Zsh,
PowerShell, SQL, jq, WebAssembly, HTML). The registry in
`scripts/runtimes.json` is the single source of truth shared by all three
layers, so they cannot drift apart. A runtime whose toolchain is missing is
marked as such in the picker rather than failing when you press Run.

**Multi-file workspaces.** Files are created, deleted and switched in the
explorer; all of them travel with the request, so imports across files work. The
workspace survives a page refresh.

**Live output.** stdout and stderr stream to the terminal as they are produced,
not after the process exits. Abort stops a running job in under two seconds.

**Static analysis** as you type: a scope tree, size and complexity metrics, and
diagnostics for unbalanced delimiters and unterminated literals, mirrored into
Monaco as inline markers.

**HTML preview** renders client-side in a sandboxed iframe and never reaches the
execution backend.

## Security model

Untrusted code is the entire point, so isolation is the product, not a feature.

The runner probes the host and selects the strongest of three tiers:

| Tier | Provides | Use |
| --- | --- | --- |
| `nsjail` | chroot, all namespaces, seccomp-bpf policy | production |
| `userns` | user, PID, net, mount, IPC, UTS namespaces, mount sealing, rlimits | production |
| `rlimit` | resource limits and a deadline only | development only |

Every run, on any tier above `rlimit`:

- **Privileges are dropped before the namespace is created.** A user namespace
  does not shed credentials a process already holds, so unsharing as root would
  leave the whole host filesystem readable from inside the sandbox.
- **The root filesystem is remounted read-only** inside the namespace, `/tmp`
  is replaced with a small tmpfs, and only the workspace stays writable.
- **Networking is a new, empty namespace.** Runs are airgapped unless an
  operator explicitly enables egress.
- **Memory, CPU, process count, file size and wall-clock time are capped**, by
  cgroups v2 where available and rlimits otherwise.
- **The workspace is destroyed** when the run ends, including on panic or abort.

Filenames are rejected unless they are plain relative paths, and that check runs
independently in the frontend, the gateway and the supervisor.

`docs/SECURITY.md` covers the threat model and the reasoning behind each choice.
`make doctor` reports which tier a host will actually use, and the gateway logs
a warning at startup when it can offer no kernel isolation rather than implying
protection it does not have.

## Testing

```bash
make test   # every suite
```

| Suite | Covers |
| --- | --- |
| `make test-sandbox` | containment: egress, deadlines, memory, credentials, rootfs writes, fork bombs, teardown |
| `make test-supervisor` | protocol parsing, path traversal, limit clamping, workspace lifecycle |
| `make test-analyzer` | lexing, scope trees, diagnostics, JSON well-formedness |
| `make test-backend` | REST and WebSocket surfaces against the real sandbox |
| `make test-frontend` | typecheck plus virtual file system unit tests |

The sandbox suite asserts containment rather than mere execution: each test is
written so an escape fails loudly instead of passing quietly. It skips checks a
tier genuinely cannot make rather than reporting a pass it did not earn.

## Deployment

```bash
docker compose up --build     # gateway on :8000, Redis optional
```

The container needs `SYS_ADMIN` to create namespaces. Without it the stack still
runs, but the isolation tier degrades to `rlimit` and the health endpoint says
so.

Redis is optional everywhere. When it is unreachable the gateway falls back to
an in-process rate limiter, which protects a single node rather than failing
open. Run the Rust supervisor when you want the network-facing process to never
spawn user code itself; the gateway detects its socket and switches
automatically, with no configuration change.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/health` | isolation tier, backends, installed runtime count |
| `GET /api/v1/runtimes` | the catalogue with per-host availability |
| `GET /api/v1/runtimes/{id}/template` | starter source for a runtime |
| `POST /api/v1/analyze` | scope tree, metrics and diagnostics |
| `POST /api/v1/execute` | run a workspace, one response |
| `WS /api/v1/ws/execute` | run a workspace, streamed |

```bash
curl -s localhost:8000/api/v1/execute -H 'content-type: application/json' -d '{
  "language": "python",
  "files": [{"name": "main.py", "content": "print(sum(range(100)))"}]
}' | jq '{exit_code, stdout, tier: .meta.isolation.tier}'
```

Interactive documentation is at `/docs`.

## Configuration

Every setting is an environment variable; the defaults describe a single-node
development box.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODECRAFT_SOCKET` | `/run/codecraft/supervisor.sock` | supervisor socket the gateway looks for |
| `CODECRAFT_WORKSPACE_ROOT` | `/var/tmp/codecraft` | where ephemeral workspaces live |
| `CODECRAFT_MAX_JOBS` | `8` | concurrent executions |
| `CODECRAFT_WALL_SECONDS` | `10` | default wall-clock limit |
| `CODECRAFT_MEMORY_MB` | `256` | default memory ceiling |
| `CODECRAFT_RATE_LIMIT` | `40` | executions per client per window |
| `CODECRAFT_REDIS_URL` | `redis://localhost:6379/0` | shared rate limiter |
| `CODECRAFT_CORS_ORIGINS` | `http://localhost:5173,…` | allowed browser origins |
| `CC_FORCE_TIER` | `auto` | pin an isolation tier, for testing |

Workspaces belong outside `/tmp`: the sandbox replaces `/tmp` with its own
tmpfs, which would otherwise shadow a workspace mounted underneath it.

## Layout

```
frontend/          React 19, Monaco, xterm.js, Tailwind
backend/           FastAPI gateway, REST and WebSocket
core/supervisor/   Rust daemon, no third-party crates
core/analyzer/     C++17 lexer and analyzer, no dependencies
scripts/           the isolation runner, registry, profiles, tests
docs/              architecture and security notes
```

Both core services are dependency-free on purpose: they sit closest to
untrusted code, so the small amount of JSON handling each one ships is worth an
empty dependency surface, and both build offline.

## Licence

MIT. See `LICENSE`.
