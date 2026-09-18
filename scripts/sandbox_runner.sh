#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CodeCraft Studio - hardened multi-language execution runner.
#
# Compiles and runs one ephemeral workspace under the strongest isolation tier
# the host supports, streaming stdout/stderr live on its own descriptors so the
# caller can relay bytes to a terminal without buffering an entire run.
#
# Usage:
#   sandbox_runner.sh --lang <id> [options]
#
#   --lang <id>           Runtime id from scripts/runtimes.json (required).
#   --workspace <dir>     Pre-populated workspace. Omit to read source on stdin.
#   --entry <file>        Override the runtime's default entry filename.
#   --stdin-file <file>   File piped to the program's stdin (default /dev/null).
#   --arg <value>         Argument passed to the program. Repeatable, ordered.
#   --meta-file <file>    Write a JSON run report to this path.
#   --timeout <sec>       Wall-clock limit for the run phase       (default 10).
#   --compile-timeout <s> Wall-clock limit for the compile phase   (default 30).
#   --cpu-seconds <sec>   RLIMIT_CPU for the run phase              (default 5).
#   --memory-mb <mb>      Memory ceiling                          (default 256).
#   --max-procs <n>       Process and thread ceiling                (default 64).
#   --max-file-mb <mb>    RLIMIT_FSIZE                             (default 32).
#   --tier <tier>         auto | nsjail | userns | rlimit         (default auto).
#   --allow-net           Keep networking. Off by default: runs are airgapped.
#   --keep-workspace      Skip teardown; for debugging only.
#
# Exit codes: the program's own exit code, 124 on timeout, or a CodeCraft
# harness code below.
# ---------------------------------------------------------------------------
set -uo pipefail

readonly EXIT_USAGE=64
readonly EXIT_UNSUPPORTED_LANG=65
readonly EXIT_TOOLCHAIN_MISSING=66
readonly EXIT_COMPILE_FAILED=67
readonly EXIT_TIMEOUT=124

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly RUNTIMES_JSON="${CC_RUNTIMES_JSON:-$SCRIPT_DIR/runtimes.json}"
readonly NS_BOOTSTRAP="$SCRIPT_DIR/lib/ns_bootstrap.sh"
readonly STAGE_HELPER="$SCRIPT_DIR/lib/stage_toolchains.sh"

# Workspaces deliberately live outside /tmp: the sandbox replaces /tmp with its
# own tmpfs, which would otherwise mask a workspace mounted underneath it.
readonly WORKSPACE_ROOT="${CC_WORKSPACE_ROOT:-/var/tmp/codecraft}"

# shellcheck source=scripts/lib/isolation.sh
source "$SCRIPT_DIR/lib/isolation.sh"

die() {
    local code="$1"; shift
    printf '\033[1;31m[codecraft] %s\033[0m\n' "$*" >&2
    exit "$code"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
LANGUAGE=""
WORKSPACE=""
ENTRY_OVERRIDE=""
STDIN_FILE="/dev/null"
META_FILE=""
declare -a PROGRAM_ARGS=()
WALL_TIMEOUT=10
COMPILE_TIMEOUT=30
CPU_SECONDS=5
MEMORY_MB=256
MAX_PROCS=64
MAX_FILE_MB=32
TIER_REQUEST="auto"
ALLOW_NET=0
KEEP_WORKSPACE=0
OWN_WORKSPACE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --lang)            LANGUAGE="${2:-}"; shift 2 ;;
        --workspace)       WORKSPACE="${2:-}"; shift 2 ;;
        --entry)           ENTRY_OVERRIDE="${2:-}"; shift 2 ;;
        --stdin-file)      STDIN_FILE="${2:-}"; shift 2 ;;
        # Repeatable, and never word-split: an argument containing spaces stays
        # one argument all the way to the program.
        --arg)             PROGRAM_ARGS+=("${2:-}"); shift 2 ;;
        --meta-file)       META_FILE="${2:-}"; shift 2 ;;
        --timeout)         WALL_TIMEOUT="${2:-}"; shift 2 ;;
        --compile-timeout) COMPILE_TIMEOUT="${2:-}"; shift 2 ;;
        --cpu-seconds)     CPU_SECONDS="${2:-}"; shift 2 ;;
        --memory-mb)       MEMORY_MB="${2:-}"; shift 2 ;;
        --max-procs)       MAX_PROCS="${2:-}"; shift 2 ;;
        --max-file-mb)     MAX_FILE_MB="${2:-}"; shift 2 ;;
        --tier)            TIER_REQUEST="${2:-}"; shift 2 ;;
        --allow-net)       ALLOW_NET=1; shift ;;
        --keep-workspace)  KEEP_WORKSPACE=1; shift ;;
        -h|--help)         sed -n '2,29p' "${BASH_SOURCE[0]}"; exit 0 ;;
        # Positional form, kept for the documented `sandbox_runner.sh <lang>` call.
        *)                 if [[ -z "$LANGUAGE" ]]; then LANGUAGE="$1"; shift
                           else die "$EXIT_USAGE" "Unknown argument: $1"; fi ;;
    esac
done

[[ -n "$LANGUAGE" ]] || die "$EXIT_USAGE" "Missing required --lang <runtime id>."
[[ -f "$RUNTIMES_JSON" ]] || die "$EXIT_USAGE" "Runtime registry not found: $RUNTIMES_JSON"
cc_have jq || die "$EXIT_TOOLCHAIN_MISSING" "jq is required by the sandbox runner."

# ---------------------------------------------------------------------------
# Runtime descriptor lookup
# ---------------------------------------------------------------------------
rt_field() { jq -r --arg id "$LANGUAGE" ".runtimes[\$id].$1 // empty" "$RUNTIMES_JSON"; }
rt_argv()  { jq -r --arg id "$LANGUAGE" ".runtimes[\$id].$1 // [] | .[]" "$RUNTIMES_JSON"; }

if [[ "$(jq -r --arg id "$LANGUAGE" 'if .runtimes | has($id) then "yes" else "no" end' "$RUNTIMES_JSON")" != "yes" ]]; then
    die "$EXIT_UNSUPPORTED_LANG" "Unsupported target runtime language: $LANGUAGE"
fi

ENTRY="${ENTRY_OVERRIDE:-$(rt_field entry)}"
AS_POLICY="$(rt_field as_limit)"
LABEL="$(rt_field label)"

# ---------------------------------------------------------------------------
# Toolchain resolution.
#
# A runtime lists its toolchains in preference order. Distributions disagree
# about names (luajit vs lua5.4, mcs vs csc, deno vs bun vs tsx), so pick the
# first candidate whose probe binary is actually present instead of failing
# because the canonical name is missing.
# ---------------------------------------------------------------------------
CANDIDATE_COUNT="$(jq -r --arg id "$LANGUAGE" '.runtimes[$id].candidates // [] | length' "$RUNTIMES_JSON")"

PROBE=""
CANDIDATE_INDEX=-1
declare -a COMPILE_ARGV=()
declare -a RUN_ARGV=()
declare -a MISSING_PROBES=()

for (( i = 0; i < CANDIDATE_COUNT; i++ )); do
    candidate_probe="$(jq -r --arg id "$LANGUAGE" --argjson i "$i" \
        '.runtimes[$id].candidates[$i].probe // empty' "$RUNTIMES_JSON")"
    if [[ -n "$candidate_probe" ]] && ! cc_have "$candidate_probe"; then
        MISSING_PROBES+=("$candidate_probe")
        continue
    fi
    PROBE="$candidate_probe"
    CANDIDATE_INDEX="$i"
    mapfile -t COMPILE_ARGV < <(jq -r --arg id "$LANGUAGE" --argjson i "$i" \
        '.runtimes[$id].candidates[$i].compile // [] | .[]' "$RUNTIMES_JSON")
    mapfile -t RUN_ARGV < <(jq -r --arg id "$LANGUAGE" --argjson i "$i" \
        '.runtimes[$id].candidates[$i].run // [] | .[]' "$RUNTIMES_JSON")
    break
done

if [[ "$CANDIDATE_COUNT" -eq 0 || ${#RUN_ARGV[@]} -eq 0 ]] && [[ "$CANDIDATE_INDEX" -lt 0 ]]; then
    if [[ ${#MISSING_PROBES[@]} -gt 0 ]]; then
        die "$EXIT_TOOLCHAIN_MISSING" \
            "No toolchain for $LABEL on this host. Tried: ${MISSING_PROBES[*]}."
    fi
    die "$EXIT_UNSUPPORTED_LANG" \
        "Runtime '$LANGUAGE' ($LABEL) is client-side only and has no server execution path."
fi
if [[ ${#RUN_ARGV[@]} -eq 0 ]]; then
    die "$EXIT_UNSUPPORTED_LANG" \
        "Runtime '$LANGUAGE' ($LABEL) is client-side only and has no server execution path."
fi

# ---------------------------------------------------------------------------
# Ephemeral workspace
# ---------------------------------------------------------------------------
if [[ -z "$WORKSPACE" ]]; then
    mkdir -p "$WORKSPACE_ROOT" || die "$EXIT_USAGE" "Cannot create workspace root: $WORKSPACE_ROOT"
    WORKSPACE="$(mktemp -d "$WORKSPACE_ROOT/run_XXXXXXXX")"
    OWN_WORKSPACE=1
    # Documented contract: with no --workspace, the source arrives on stdin.
    cat > "$WORKSPACE/$ENTRY"
fi
[[ -d "$WORKSPACE" ]] || die "$EXIT_USAGE" "Workspace directory does not exist: $WORKSPACE"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/.cache"

# ---------------------------------------------------------------------------
# Privilege drop. A user namespace does not shed the host credentials the
# process already holds, so running as root would leave the whole host
# filesystem readable. Drop to an unprivileged uid *before* unsharing, then the
# in-namespace root maps onto that harmless uid.
# ---------------------------------------------------------------------------
SANDBOX_UID="${CC_SANDBOX_UID:-65534}"
SANDBOX_GID="${CC_SANDBOX_GID:-65534}"
DROP_PRIVILEGES=0
if [[ "$(id -u)" -eq 0 ]] && cc_have setpriv; then
    DROP_PRIVILEGES=1
    chown -R "$SANDBOX_UID:$SANDBOX_GID" "$WORKSPACE" 2>/dev/null || DROP_PRIVILEGES=0
fi

CGROUP_LEAF=""
STAGE_ROOT=""

# Kill anything still rooted in the workspace. A no-op under the PID-namespace
# tiers; this is the safety net for the degraded rlimit tier.
kill_workspace_orphans() {
    local ws="$1" entry pid cwd
    for entry in /proc/[0-9]*; do
        pid="${entry#/proc/}"
        [[ "$pid" == "$$" ]] && continue
        cwd="$(readlink "$entry/cwd" 2>/dev/null)" || continue
        [[ "$cwd" == "$ws"* ]] && kill -9 "$pid" 2>/dev/null
    done
    return 0
}

# PID of the sandbox process currently being waited on, so a signal handler can
# reach it. Empty between phases.
CURRENT_CHILD=""

# A caller that aborts sends SIGTERM. Bash defers a trap until the running
# foreground command finishes, so each phase is started in the background and
# waited on: that makes `wait` interruptible and the abort immediate.
on_terminate() {
    [[ -n "$CURRENT_CHILD" ]] && kill -TERM "$CURRENT_CHILD" 2>/dev/null
    kill_workspace_orphans "$WORKSPACE"
    cleanup
    exit 143
}

cleanup() {
    kill_workspace_orphans "$WORKSPACE"
    cc_cgroup_destroy "$CGROUP_LEAF"
    if [[ "$KEEP_WORKSPACE" != "1" ]]; then
        # Staging mounts live in a namespace that is already gone; only the
        # empty mountpoint directories remain on the host.
        [[ -n "${STAGE_ROOT:-}" ]] && rm -rf "$STAGE_ROOT" 2>/dev/null
        [[ "$OWN_WORKSPACE" == "1" ]] && rm -rf "$WORKSPACE"
    fi
}
trap cleanup EXIT
trap on_terminate INT TERM

# ---------------------------------------------------------------------------
# Isolation tier selection
# ---------------------------------------------------------------------------
export CC_FORCE_TIER="$TIER_REQUEST"
TIER="$(cc_detect_tier)"
case "$TIER" in
    nsjail) cc_have nsjail || TIER="$(CC_FORCE_TIER=auto cc_detect_tier)" ;;
    userns) { cc_userns_supported && [[ -x "$NS_BOOTSTRAP" ]]; } || TIER="rlimit" ;;
    rlimit) ;;
    *) die "$EXIT_USAGE" "Unknown isolation tier: $TIER" ;;
esac

CGROUP_LEAF="$(cc_cgroup_create "run_$(basename "$WORKSPACE")" "$MEMORY_MB" "$MAX_PROCS")"
cc_log "tier=$TIER lang=$LANGUAGE toolchain=${PROBE:-builtin} entry=$ENTRY drop_privileges=$DROP_PRIVILEGES cgroup=${CGROUP_LEAF:-none}"

# Toolchains routinely live outside the standard system directories
# (/usr/local/go/bin, ~/.cargo/bin, ~/.bun/bin). The sandbox environment is
# scrubbed, so resolve the host directory of every binary this run needs and
# prepend those directories to the sandbox PATH.
build_sandbox_path() {
    local -a candidates=("$PROBE" "${COMPILE_ARGV[0]:-}" "${RUN_ARGV[0]:-}")
    local base="${CC_SANDBOX_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
    local prefix="" binary resolved dir
    for binary in "${candidates[@]}"; do
        [[ -n "$binary" ]] || continue
        resolved="$(command -v "$binary" 2>/dev/null)" || continue
        dir="$(dirname "$resolved")"
        case ":$prefix:$base:" in *":$dir:"*) continue ;; esac
        prefix="${prefix:+$prefix:}$dir"
    done
    [[ -n "${CC_EXTRA_PATH:-}" ]] && prefix="${prefix:+$prefix:}$CC_EXTRA_PATH"
    echo "${prefix:+$prefix:}$base"
}
# ---------------------------------------------------------------------------
# Toolchain staging plan.
#
# After the privilege drop the sandbox user may be unable to traverse a home
# directory holding a toolchain (rustup and bun both install under a mode-700
# home). Collect every such directory so the staging helper can bind-mount it
# somewhere reachable, and record where each one will land.
# ---------------------------------------------------------------------------
STAGE_ROOT=""
STAGE_SRCS=()
STAGE_ENV=()

plan_toolchain_staging() {
    [[ "$DROP_PRIVILEGES" == "1" ]] || return 0

    local -a wanted=()
    local binary resolved dir var value

    # Directories holding the binaries this run executes.
    for binary in "$PROBE" "${COMPILE_ARGV[0]:-}" "${RUN_ARGV[0]:-}"; do
        [[ -n "$binary" ]] || continue
        resolved="$(command -v "$binary" 2>/dev/null)" || continue
        dir="$(dirname "$resolved")"
        cc_path_reachable "$SANDBOX_UID" "$SANDBOX_GID" "$dir" && continue
        wanted+=("$dir")
    done

    # Installation roots a toolchain reads at runtime (rustup toolchains, JDKs).
    for var in "${CC_TOOLCHAIN_HOME_VARS[@]}"; do
        value="${!var:-}"
        [[ -n "$value" && -d "$value" ]] || continue
        cc_path_reachable "$SANDBOX_UID" "$SANDBOX_GID" "$value" && continue
        wanted+=("$value:$var")
    done

    [[ ${#wanted[@]} -gt 0 ]] || return 0

    STAGE_ROOT="$WORKSPACE_ROOT/.stage/$(basename "$WORKSPACE")"
    mkdir -p "$STAGE_ROOT" && chmod 755 "$WORKSPACE_ROOT/.stage" "$STAGE_ROOT" || {
        STAGE_ROOT=""
        return 0
    }

    local entry src index=0 seen=""
    for entry in "${wanted[@]}"; do
        src="${entry%%:*}"
        var="${entry#"$src"}"; var="${var#:}"
        case ":$seen:" in *":$src:"*) continue ;; esac
        seen="${seen:+$seen:}$src"
        index=$(( index + 1 ))
        STAGE_SRCS+=("$src")
        # Rewrite PATH entries and toolchain-home variables to the staged path.
        if [[ -n "$var" ]]; then
            STAGE_ENV+=("$var=$STAGE_ROOT/t$index")
        else
            CC_STAGED_PATH="${CC_STAGED_PATH:+$CC_STAGED_PATH:}$STAGE_ROOT/t$index"
        fi
    done
    cc_log "staging ${#STAGE_SRCS[@]} toolchain director(y|ies) under $STAGE_ROOT"
}

CC_STAGED_PATH=""
plan_toolchain_staging

# Staged directories take precedence: the original host paths stay unreachable
# to the sandbox user even though they still resolve on the host.
export CC_EXTRA_PATH="${CC_EXTRA_PATH:-}"
export CC_SANDBOX_PATH="${CC_STAGED_PATH:+$CC_STAGED_PATH:}$(build_sandbox_path)"

mapfile -t SANDBOX_ENV < <(cc_sandbox_env "$WORKSPACE")
[[ ${#STAGE_ENV[@]} -gt 0 ]] && SANDBOX_ENV+=("${STAGE_ENV[@]}")

# Pass through toolchain roots that are already reachable unchanged.
for _var in "${CC_TOOLCHAIN_HOME_VARS[@]}"; do
    _value="${!_var:-}"
    [[ -n "$_value" && -d "$_value" ]] || continue
    [[ " ${STAGE_ENV[*]:-} " == *" $_var="* ]] && continue
    SANDBOX_ENV+=("$_var=$_value")
done

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

# ---------------------------------------------------------------------------
# run_phase <wall_seconds> <cpu_seconds> <as_policy> <command...>
#
# Layers the sandbox from the outside in:
#   timeout -> setpriv -> prlimit -> unshare -> mount seal -> scrubbed env -> cmd
# Descriptors are inherited throughout, so output streams live.
# ---------------------------------------------------------------------------
run_phase() {
    local wall="$1" cpu="$2" as_policy="$3"; shift 3

    # --foreground keeps timeout from signalling its own process group, which
    # would kill timeout itself before it could report the deadline.
    local -a wrapper=(timeout --foreground --kill-after=3s --signal=TERM "${wall}s")

    # Staging needs root and a private mount namespace, so it wraps everything
    # below it and hands control on before privileges are dropped.
    if [[ -n "$STAGE_ROOT" && ${#STAGE_SRCS[@]} -gt 0 ]]; then
        wrapper+=(unshare --mount --propagation private
                  "$STAGE_HELPER" "$STAGE_ROOT" "${STAGE_SRCS[@]}" --)
    fi

    if [[ "$DROP_PRIVILEGES" == "1" ]]; then
        wrapper+=(setpriv --reuid="$SANDBOX_UID" --regid="$SANDBOX_GID"
                          --clear-groups --no-new-privs)
    fi

    # nsjail enforces its own rlimits; the other tiers need prlimit.
    if [[ "$TIER" != "nsjail" ]]; then
        local -a limit_args
        mapfile -t limit_args < <(cc_rlimit_args "$MEMORY_MB" "$cpu" "$MAX_PROCS" "$MAX_FILE_MB" "$as_policy")
        wrapper+=(prlimit "${limit_args[@]}" --)
    fi

    case "$TIER" in
        nsjail)
            local -a nsjail_args
            mapfile -t nsjail_args < <(cc_nsjail_args "$WORKSPACE" "$MEMORY_MB" "$cpu" "$wall" "$MAX_PROCS" "$ALLOW_NET" "$SANDBOX_UID" "$SANDBOX_GID")
            wrapper+=(nsjail "${nsjail_args[@]}")
            ;;
        userns)
            local -a userns_args
            mapfile -t userns_args < <(cc_userns_args "$ALLOW_NET")
            wrapper+=(unshare "${userns_args[@]}" "$NS_BOOTSTRAP" "$WORKSPACE")
            ;;
        rlimit) ;;
    esac

    wrapper+=(env -i "${SANDBOX_ENV[@]}")

    if [[ -n "$CGROUP_LEAF" && -w "$CGROUP_LEAF/cgroup.procs" ]]; then
        # Join the cgroup in the child, immediately before exec.
        ( echo $$ > "$CGROUP_LEAF/cgroup.procs" 2>/dev/null
          cd "$WORKSPACE" || exit 1
          exec "${wrapper[@]}" "$@" ) < "$STDIN_FILE" &
    else
        ( cd "$WORKSPACE" || exit 1
          exec "${wrapper[@]}" "$@" ) < "$STDIN_FILE" &
    fi

    CURRENT_CHILD=$!
    wait "$CURRENT_CHILD"
    local status=$?
    CURRENT_CHILD=""
    return "$status"
}

# GNU timeout reports 124 when SIGTERM ends the run, but a process that ignores
# SIGTERM is killed by the follow-up SIGKILL and surfaces as 137. Both mean the
# deadline expired, so normalise them once instead of at every call site.
normalise_timeout_exit() {
    local status="$1" elapsed_ms="$2" wall_seconds="$3"
    if [[ "$status" -eq 124 ]]; then echo 124; return; fi
    if [[ "$status" -eq 137 || "$status" -eq 143 ]] \
       && [[ "$elapsed_ms" -ge $(( wall_seconds * 1000 - 500 )) ]]; then
        echo 124; return
    fi
    echo "$status"
}

COMPILE_MS=0
COMPILE_EXIT=0
RUN_MS=0

write_meta() {
    local run_exit="$1" status="$2"
    [[ -n "$META_FILE" ]] || return 0
    jq -n \
        --arg language "$LANGUAGE" --arg label "$LABEL" --arg tier "$TIER" \
        --arg entry "$ENTRY" --arg status "$status" --arg toolchain "${PROBE:-builtin}" \
        --argjson compiled "$([[ ${#COMPILE_ARGV[@]} -gt 0 ]] && echo true || echo false)" \
        --argjson compile_ms "$COMPILE_MS" --argjson compile_exit "$COMPILE_EXIT" \
        --argjson run_ms "$RUN_MS" --argjson exit_code "$run_exit" \
        --argjson cgroup "$([[ -n "$CGROUP_LEAF" ]] && echo true || echo false)" \
        --argjson dropped "$([[ "$DROP_PRIVILEGES" == "1" ]] && echo true || echo false)" \
        --argjson network "$([[ "$ALLOW_NET" == "1" ]] && echo true || echo false)" \
        --argjson memory_mb "$MEMORY_MB" --argjson cpu_seconds "$CPU_SECONDS" \
        --argjson wall_seconds "$WALL_TIMEOUT" --argjson max_procs "$MAX_PROCS" \
        '{language: $language, label: $label, entry: $entry, status: $status,
          toolchain: $toolchain,
          isolation: {tier: $tier, cgroup_v2: $cgroup, privileges_dropped: $dropped,
                      network: $network},
          limits: {memory_mb: $memory_mb, cpu_seconds: $cpu_seconds,
                   wall_seconds: $wall_seconds, max_procs: $max_procs},
          compile: {ran: $compiled, exit_code: $compile_exit, duration_ms: $compile_ms},
          run: {exit_code: $exit_code, duration_ms: $run_ms}}' \
        > "$META_FILE" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Compile phase - compilers get a relaxed address space and their own deadline.
# ---------------------------------------------------------------------------
if [[ ${#COMPILE_ARGV[@]} -gt 0 ]]; then
    compile_start="$(now_ms)"
    run_phase "$COMPILE_TIMEOUT" "$COMPILE_TIMEOUT" "relaxed" "${COMPILE_ARGV[@]}"
    COMPILE_EXIT=$?
    COMPILE_MS=$(( $(now_ms) - compile_start ))
    COMPILE_EXIT="$(normalise_timeout_exit "$COMPILE_EXIT" "$COMPILE_MS" "$COMPILE_TIMEOUT")"

    if [[ "$COMPILE_EXIT" -ne 0 ]]; then
        if [[ "$COMPILE_EXIT" -eq "$EXIT_TIMEOUT" ]]; then
            printf '\033[1;31m[codecraft] Compilation exceeded %ss and was terminated.\033[0m\n' "$COMPILE_TIMEOUT" >&2
            write_meta "$EXIT_TIMEOUT" "compile_timeout"
            exit "$EXIT_TIMEOUT"
        fi
        printf '\033[1;31m[codecraft] Compilation failed with exit code %s.\033[0m\n' "$COMPILE_EXIT" >&2
        write_meta "$COMPILE_EXIT" "compile_failed"
        exit "$EXIT_COMPILE_FAILED"
    fi
fi

# ---------------------------------------------------------------------------
# Run phase
# ---------------------------------------------------------------------------
run_start="$(now_ms)"
run_phase "$WALL_TIMEOUT" "$CPU_SECONDS" "$AS_POLICY" "${RUN_ARGV[@]}" "${PROGRAM_ARGS[@]}"
RUN_EXIT=$?
RUN_MS=$(( $(now_ms) - run_start ))
RUN_EXIT="$(normalise_timeout_exit "$RUN_EXIT" "$RUN_MS" "$WALL_TIMEOUT")"

if [[ "$RUN_EXIT" -eq "$EXIT_TIMEOUT" ]]; then
    printf '\n\033[1;31m[codecraft] Execution exceeded the %ss wall-clock limit and was killed.\033[0m\n' "$WALL_TIMEOUT" >&2
    write_meta "$EXIT_TIMEOUT" "timeout"
    exit "$EXIT_TIMEOUT"
fi

write_meta "$RUN_EXIT" "completed"
exit "$RUN_EXIT"
