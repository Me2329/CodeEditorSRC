#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CodeCraft Studio - Isolation primitive detection and wrapper construction.
#
# Three isolation tiers, strongest first. The runner selects the strongest tier
# the host actually supports, so a hardened production box and a laptop both
# work without configuration changes.
#
#   nsjail : full chroot + user/pid/net/ipc/uts namespaces + seccomp-bpf
#   userns : unshare(1) user/pid/net/mount/ipc/uts namespaces + rlimits
#   rlimit : POSIX rlimits + wall-clock timeout only (NO kernel isolation)
#
# Source this file; it defines cc_* helpers and sets no global side effects.
# ---------------------------------------------------------------------------

# Emit a diagnostic line on stderr only when CC_VERBOSE=1.
cc_log() {
    [[ "${CC_VERBOSE:-0}" == "1" ]] || return 0
    printf '\033[38;5;244m[codecraft] %s\033[0m\n' "$*" >&2
}

cc_have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# cc_userns_supported - probe whether unprivileged user namespaces actually work.
# Distributions ship several kill switches for this, so probe rather than assume.
# ---------------------------------------------------------------------------
cc_userns_supported() {
    cc_have unshare || return 1
    local sysctl_path=/proc/sys/kernel/unprivileged_userns_clone
    if [[ -r "$sysctl_path" && "$(cat "$sysctl_path" 2>/dev/null)" == "0" ]]; then
        return 1
    fi
    unshare --user --map-root-user --pid --fork --mount-proc \
        true >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# cc_detect_tier - echo the strongest available isolation tier.
# Honours CC_FORCE_TIER for testing and for operators who want to pin a tier.
# ---------------------------------------------------------------------------
cc_detect_tier() {
    local forced="${CC_FORCE_TIER:-auto}"
    if [[ "$forced" != "auto" ]]; then
        echo "$forced"
        return 0
    fi
    if cc_have nsjail; then
        echo "nsjail"
    elif cc_userns_supported; then
        echo "userns"
    else
        echo "rlimit"
    fi
}

# ---------------------------------------------------------------------------
# cc_cgroup_root - echo a writable cgroup v2 directory, or empty when the host
# offers no delegated cgroup tree (unprivileged container, cgroup v1, macOS).
# ---------------------------------------------------------------------------
cc_cgroup_root() {
    local root=/sys/fs/cgroup
    [[ -f "$root/cgroup.controllers" ]] || return 0
    grep -qw memory "$root/cgroup.controllers" 2>/dev/null || return 0
    [[ -w "$root/cgroup.procs" ]] || return 0
    echo "$root"
}

# ---------------------------------------------------------------------------
# cc_cgroup_create <name> <memory_mb> <max_pids>
# Create a leaf cgroup with hard memory and PID ceilings. Echoes the cgroup path
# on success, nothing on failure. Never fatal: the caller degrades to rlimits.
# ---------------------------------------------------------------------------
cc_cgroup_create() {
    local name="$1" memory_mb="$2" max_pids="$3"
    local root; root="$(cc_cgroup_root)"
    [[ -n "$root" ]] || return 0

    local leaf="$root/codecraft/$name"
    mkdir -p "$leaf" 2>/dev/null || return 0

    # Delegate the controllers we need down to the leaf's parent.
    echo "+memory +pids" > "$root/codecraft/cgroup.subtree_control" 2>/dev/null || true

    echo $(( memory_mb * 1024 * 1024 )) > "$leaf/memory.max" 2>/dev/null || true
    echo 0                              > "$leaf/memory.swap.max" 2>/dev/null || true
    echo "$max_pids"                    > "$leaf/pids.max" 2>/dev/null || true

    echo "$leaf"
}

cc_cgroup_destroy() {
    local leaf="${1:-}"
    [[ -n "$leaf" && -d "$leaf" ]] || return 0
    rmdir "$leaf" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# cc_rlimit_args <memory_mb> <cpu_seconds> <max_procs> <max_file_mb> <as_policy>
# Print prlimit(1) arguments enforcing the resource envelope on the target
# process. A "relaxed" address-space policy omits RLIMIT_AS for runtimes whose
# VM reserves terabytes of virtual address space at startup.
# ---------------------------------------------------------------------------
cc_rlimit_args() {
    local memory_mb="$1" cpu_seconds="$2" max_procs="$3" max_file_mb="$4" as_policy="$5"

    printf '%s\n' \
        "--cpu=$cpu_seconds" \
        "--nproc=$max_procs" \
        "--fsize=$(( max_file_mb * 1024 * 1024 ))" \
        "--core=0" \
        "--nofile=512"

    if [[ "$as_policy" != "relaxed" ]]; then
        printf '%s\n' "--as=$(( memory_mb * 1024 * 1024 ))"
    fi
}

# ---------------------------------------------------------------------------
# cc_nsjail_args <workspace> <memory_mb> <cpu_seconds> <wall_seconds> <max_procs>
#                <allow_net> <uid> <gid>
# Print the nsjail argument vector for one ephemeral execution.
# ---------------------------------------------------------------------------
cc_nsjail_args() {
    local workspace="$1" memory_mb="$2" cpu_seconds="$3" wall_seconds="$4"
    local max_procs="$5" allow_net="$6" uid="${7:-65534}" gid="${8:-65534}"

    printf '%s\n' \
        "--quiet" \
        "--mode" "o" \
        "--chroot" "/" \
        "--cwd" "$workspace" \
        "--user" "$uid" \
        "--group" "$gid" \
        "--bindmount" "$workspace:$workspace" \
        "--tmpfsmount" "/tmp" \
        "--tmpfs_size" "67108864" \
        "--rlimit_cpu" "$cpu_seconds" \
        "--rlimit_nproc" "$max_procs" \
        "--rlimit_fsize" "64" \
        "--rlimit_core" "0" \
        "--time_limit" "$wall_seconds" \
        "--max_cpus" "1" \
        "--cgroup_mem_max" "$(( memory_mb * 1024 * 1024 ))" \
        "--cgroup_pids_max" "$max_procs" \
        "--disable_proc" \
        "--hostname" "codecraft" \
        "--env" "CODECRAFT_SANDBOX=nsjail"

    if [[ "$allow_net" == "1" ]]; then
        printf '%s\n' "--disable_clone_newnet"
    else
        printf '%s\n' "--iface_no_lo"
    fi

    local seccomp_policy="${CC_SECCOMP_POLICY:-}"
    if [[ -n "$seccomp_policy" && -f "$seccomp_policy" ]]; then
        printf '%s\n' "--seccomp_policy" "$seccomp_policy"
    fi

    printf '%s\n' "--"
}

# ---------------------------------------------------------------------------
# cc_userns_args <allow_net>
# Print the unshare(1) argument vector. New user, PID, mount, IPC and UTS
# namespaces always; the network namespace is dropped only when net is allowed.
# ---------------------------------------------------------------------------
cc_userns_args() {
    local allow_net="$1"
    printf '%s\n' "--user" "--map-root-user" "--pid" "--fork" "--mount-proc" "--ipc" "--uts"
    [[ "$allow_net" == "1" ]] || printf '%s\n' "--net"
    printf '%s\n' "--"
}

# ---------------------------------------------------------------------------
# cc_sandbox_env <workspace>
# Print KEY=VALUE lines forming a scrubbed environment. The caller feeds these
# to env -i so nothing from the host environment leaks into user code.
# ---------------------------------------------------------------------------
cc_sandbox_env() {
    local workspace="$1"
    printf '%s\n' \
        "PATH=${CC_SANDBOX_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" \
        "HOME=$workspace" \
        "TMPDIR=$workspace/tmp" \
        "PWD=$workspace" \
        "LANG=C.UTF-8" \
        "LC_ALL=C.UTF-8" \
        "TERM=xterm-256color" \
        "USER=sandbox" \
        "CODECRAFT_SANDBOX=1" \
        "GOCACHE=$workspace/.cache/go-build" \
        "GOPATH=$workspace/.cache/go" \
        "GOMODCACHE=$workspace/.cache/go/pkg/mod" \
        "GOFLAGS=-mod=mod" \
        "GOTOOLCHAIN=local" \
        "CARGO_HOME=$workspace/.cache/cargo" \
        "npm_config_cache=$workspace/.cache/npm" \
        "XDG_CACHE_HOME=$workspace/.cache" \
        "DOTNET_CLI_TELEMETRY_OPTOUT=1" \
        "DOTNET_NOLOGO=1" \
        "PYTHONDONTWRITEBYTECODE=1" \
        "PYTHONUNBUFFERED=1"

    return 0
}

# Environment variables that point at a toolchain's installation root. When the
# sandbox user cannot reach the host location, the runner stages the directory
# and rewrites the variable to the staged path.
readonly CC_TOOLCHAIN_HOME_VARS=(
    RUSTUP_HOME CARGO_HOME GOROOT JAVA_HOME DOTNET_ROOT BUN_INSTALL
    NVM_DIR SDKMAN_DIR PYENV_ROOT GHCUP_INSTALL_BASE_PREFIX
)

# ---------------------------------------------------------------------------
# cc_path_reachable <uid> <gid> <path>
# Succeed when the given unprivileged user can traverse into <path>. Used to
# decide whether a toolchain directory needs staging.
# ---------------------------------------------------------------------------
cc_path_reachable() {
    local uid="$1" gid="$2" path="$3"
    [[ -e "$path" ]] || return 1
    cc_have setpriv || return 0
    setpriv --reuid="$uid" --regid="$gid" --clear-groups \
        test -x "$path" >/dev/null 2>&1
}
