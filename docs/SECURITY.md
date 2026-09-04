# Security model

CodeCraft Studio runs code written by people it does not trust. Isolation is the
product; everything else is a user interface on top of it. This document states
what the platform defends against, how, and where the limits are.

## Threat model

The adversary is a user who can submit arbitrary source in any supported
language, control the filenames in a workspace, and choose the resource limits
requested. They can open many connections and run many jobs.

The platform defends the **host** and **other users** against:

| Threat | Defence |
| --- | --- |
| Reading host secrets | privilege drop to an unprivileged uid before the namespace is created |
| Writing to the host filesystem | root filesystem remounted read-only inside the mount namespace |
| Reaching internal networks | a new, empty network namespace; no route out |
| Exhausting memory | cgroups v2 `memory.max`, or `RLIMIT_AS` where cgroups are unavailable |
| Exhausting CPU | `RLIMIT_CPU` plus a wall-clock deadline |
| Fork bombs | `pids.max` and `RLIMIT_NPROC`, inside a PID namespace |
| Filling the disk | `RLIMIT_FSIZE` and a RAM-backed ephemeral `/tmp` |
| Escaping the workspace via a filename | relative-path validation in three independent layers |
| Persisting between runs | the workspace is destroyed on every exit path |
| Flooding the gateway with output | a byte ceiling per run, after which the job is stopped |
| Monopolising the service | per-client rate limiting and a global concurrency cap |
| Injecting a command through the language field | the runtime id is matched against the registry, never interpolated into a shell |

Out of scope: kernel zero-days, hardware side channels, and denial of service
against the host's own network. A node facing genuinely hostile traffic should
also run behind per-tenant resource isolation at the orchestrator level.

## Isolation tiers

The runner probes the host and picks the strongest tier available rather than
assuming one. `./scripts/doctor.sh` reports which one a host will use.

### `nsjail` — production

chroot, all namespaces, a seccomp-bpf syscall policy, and cgroup limits enforced
by nsjail itself. The policy in `scripts/profiles/seccomp-default.policy` is
allow-by-default with an explicit deny list. That is the right trade-off here:
the sandbox runs forty-odd toolchains whose syscall use varies widely and
changes between releases, so a strict allow-list would break compilers as they
gain features. Confinement rests on the namespaces, the read-only root, the
dropped privileges and the resource ceilings. The policy removes the syscalls
that have no legitimate use inside a code sandbox and carry real escape value:
module loading, `ptrace`, `bpf`, `perf_event_open`, `setns`, `unshare`, mount
management, keyring access and `userfaultfd`.

### `userns` — production

`unshare` creates user, PID, network, mount, IPC and UTS namespaces. Inside,
`scripts/lib/ns_bootstrap.sh` seals the filesystem view before any user code
runs, then execs the payload so user code never holds mount privileges.

### `rlimit` — development only

Resource limits and a wall-clock deadline, no kernel isolation. The gateway logs
a warning at startup, the health endpoint reports it, the header shows it, and
the conformance suite skips the containment checks this tier cannot make. The
platform never implies protection it does not have.

## Why privileges are dropped before unsharing

This is the subtlest part of the design and it was a real bug during
development.

A user namespace does not remove credentials a process already holds. Running
`unshare --user --map-root-user` as root maps root to root: the process is root
inside the namespace *and* still root on the host, so every host file remains
readable. A sandbox built that way looks isolated and reads `/etc/shadow`.

The order that works is: drop to an unprivileged uid with `setpriv`, **then**
unshare. In-namespace root now maps onto a harmless host uid, so the kernel's
file permission checks use that uid while the process still has the capabilities
it needs to arrange mounts inside its own namespace.

`scripts/selftest.sh` asserts this directly: it reads `/etc/shadow` from inside
the sandbox and fails if it succeeds.

## Filesystem sealing

Inside the mount namespace, in order:

1. Every mount is made private, so nothing propagates back to the host.
2. The workspace is bind-mounted onto itself, giving it its own mount entry.
3. `/tmp` is replaced with a small tmpfs.
4. The root filesystem is remounted read-only.
5. Read-write is restored on the workspace bind alone.

Each step is best-effort and reports rather than aborting: a kernel or policy
that refuses one degrades the sandbox but must not take the service down. In
`nsjail`, all of this is expressed declaratively in the jail configuration
instead.

Workspaces live outside `/tmp` because step 3 would otherwise shadow a workspace
mounted underneath it, leaving the run with no working directory. When an
operator points the workspace root at `/tmp` anyway, the bootstrap detects the
overlap and keeps the host's `/tmp` rather than breaking the run.

## Toolchain staging

Language toolchains are routinely installed under a mode-700 home directory:
rustup, bun, nvm, sdkman and pyenv all do this. After the privilege drop the
sandbox user cannot traverse such a directory, even though the toolchain itself
is world-readable one level down.

Rather than relaxing permissions on the host, the runner read-only bind-mounts
each blocked directory onto a reachable staging path inside a private mount
namespace. A bind mount bypasses the traversal check on the original parent, the
mounts are invisible outside the namespace, and no host permission changes.

## Defence in depth on filenames

A hostile filename is the shortest path from a workspace to the host filesystem,
so the same rule is enforced three times independently:

- the frontend, so the editor refuses a bad name before a round trip;
- the gateway, so the request is rejected at the edge with a readable error;
- the supervisor, which re-checks the resolved path against the workspace root
  before writing, because a bug upstream should not become a write outside it.

Accepted: plain relative paths, with subdirectories. Rejected: absolute paths,
`~`, `..` in any component, empty components, backslashes, control characters
and names over 255 characters.

## Limits are clamped, never trusted

A client may request limits, but the supervisor clamps every value into a fixed
range before use. The ceilings are 120s wall clock, 60s CPU, 2 GiB memory, 512
processes, 64 files and 4 MiB of source. Networking stays off unless the request
asks for it *and* the operator has enabled it for the node; the client alone
cannot turn it on.

## Reporting a vulnerability

Open an issue describing the impact and the conditions needed to reproduce it.
Do not include working exploit code for a live deployment.
