#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CodeCraft Studio - sandbox conformance suite.
#
# Asserts the guarantees the platform advertises rather than merely checking
# that programs run. Every containment test is written so that a sandbox escape
# makes the test fail loudly instead of passing quietly.
#
#   ./scripts/selftest.sh            # containment suite + installed runtimes
#   ./scripts/selftest.sh --quick    # containment suite only
# ---------------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly RUNNER="$SCRIPT_DIR/sandbox_runner.sh"
readonly RUNTIMES_JSON="$SCRIPT_DIR/runtimes.json"

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

PASS=0; FAIL=0; SKIP=0

green() { printf '\033[1;32m%s\033[0m' "$1"; }
red()   { printf '\033[1;31m%s\033[0m' "$1"; }
dim()   { printf '\033[38;5;244m%s\033[0m' "$1"; }

ok()   { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; [[ -n "${2:-}" ]] && printf '       %s\n' "$(dim "$2")"; }
skip() { SKIP=$((SKIP+1)); printf '  %s %s\n' "$(dim SKIP)" "$(dim "$1")"; }

# run_code <lang> <source> [extra runner args...]
# Sets OUT to the combined output and RC to the runner's exit status. Results
# travel in globals rather than on stdout: a command substitution would run this
# in a subshell and the exit status would be lost.
OUT_FILE="$(mktemp)"; trap 'rm -f "$OUT_FILE"' EXIT
OUT=""; RC=0
run_code() {
    local lang="$1" source="$2"; shift 2
    printf '%s' "$source" | "$RUNNER" --lang "$lang" "$@" > "$OUT_FILE" 2>&1
    RC=$?
    OUT="$(cat "$OUT_FILE")"
}

# expect_contains <name> <needle> <output>
expect_contains() {
    local name="$1" needle="$2" output="$3"
    if [[ "$output" == *"$needle"* ]]; then
        ok "$name"
    else
        bad "$name" "expected to find '$needle' in: ${output:0:200}"
    fi
}

printf '\n\033[1;35m CodeCraft Studio - sandbox conformance suite\033[0m\n'

# ---------------------------------------------------------------------------
printf '\n\033[1m Isolation environment\033[0m\n'
# ---------------------------------------------------------------------------
source "$SCRIPT_DIR/lib/isolation.sh"
TIER="$(cc_detect_tier)"
printf '  %s\n' "$(dim "isolation tier: $TIER   cgroup v2: $([[ -n "$(cc_cgroup_root)" ]] && echo yes || echo no)   euid: $(id -u)")"
if [[ "$TIER" == "rlimit" ]]; then
    printf '  %s\n' "$(red 'WARNING'): no kernel isolation available. Development only - do not expose this host to untrusted code."
fi

# ---------------------------------------------------------------------------
printf '\n\033[1m Containment guarantees\033[0m\n'
# ---------------------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
    skip "containment suite (requires python3 on the host)"
else
    # 1. Network egress must be unreachable by default.
    run_code python 'import socket
try:
    socket.create_connection(("1.1.1.1", 53), timeout=3)
    print("VERDICT: REACHABLE")
except Exception:
    print("VERDICT: BLOCKED")
'
    out="$OUT"
    if [[ "$TIER" == "rlimit" ]]; then
        skip "network egress is airgapped (no network namespace in the rlimit tier)"
    else
        expect_contains "network egress is airgapped" "VERDICT: BLOCKED" "$out"
    fi

    # 2. Wall-clock deadline must terminate a sleeping process.
    start=$(date +%s)
    run_code python 'import time
print("started", flush=True)
time.sleep(60)
print("VERDICT: SURVIVED")
' --timeout 3
    out="$OUT"
    elapsed=$(( $(date +%s) - start ))
    if [[ "$out" == *"VERDICT: SURVIVED"* ]]; then
        bad "wall-clock deadline kills a hung process" "process outlived its deadline"
    elif [[ "$RC" -ne 124 ]]; then
        bad "wall-clock deadline reports exit 124" "got exit $RC after ${elapsed}s"
    elif [[ "$elapsed" -gt 12 ]]; then
        bad "wall-clock deadline is enforced promptly" "took ${elapsed}s for a 3s limit"
    else
        ok "wall-clock deadline kills a hung process (exit 124 after ${elapsed}s)"
    fi

    # 3. Memory ceiling must stop a large allocation.
    run_code python 'try:
    buf = bytearray(400 * 1024 * 1024)
    print("VERDICT: ALLOCATED")
except MemoryError:
    print("VERDICT: DENIED")
' --memory-mb 64
    out="$OUT"
    expect_contains "memory ceiling denies an oversized allocation" "VERDICT: DENIED" "$out"

    # 4. Host secrets must not be readable.
    run_code python 'import os
print("VERDICT:", "READABLE" if os.access("/etc/shadow", os.R_OK) else "PROTECTED")
'
    out="$OUT"
    if [[ "$(id -u)" -ne 0 ]]; then
        skip "host credential files are unreadable (already running unprivileged)"
    elif [[ "$TIER" == "rlimit" ]]; then
        skip "host credential files are unreadable (rlimit tier offers no protection)"
    else
        expect_contains "host credential files are unreadable" "VERDICT: PROTECTED" "$out"
    fi

    # 5. The root filesystem must reject writes.
    run_code python 'try:
    open("/etc/codecraft_escape_probe", "w").write("x")
    print("VERDICT: WRITABLE")
except OSError:
    print("VERDICT: READONLY")
'
    out="$OUT"
    if [[ "$TIER" == "rlimit" ]]; then
        skip "root filesystem rejects writes (no mount namespace in the rlimit tier)"
    else
        expect_contains "root filesystem rejects writes" "VERDICT: READONLY" "$out"
        if [[ -e /etc/codecraft_escape_probe ]]; then
            bad "sandbox write did not reach the host filesystem" "/etc/codecraft_escape_probe exists on the host"
            rm -f /etc/codecraft_escape_probe
        else
            ok "sandbox write did not reach the host filesystem"
        fi
    fi

    # 6. The workspace itself must stay writable, or nothing compiles.
    run_code python 'open("scratch.txt", "w").write("ok")
print("VERDICT:", open("scratch.txt").read())
'
    out="$OUT"
    expect_contains "workspace remains writable inside the sandbox" "VERDICT: ok" "$out"

    # 7. A fork bomb must be contained and must not outlive the run.
    before=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)
    run_code bash ':(){ :|:& };:' --timeout 5 --max-procs 24
    sleep 1
    after=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)
    if [[ $(( after - before )) -gt 50 ]]; then
        bad "fork bomb leaves no surviving processes" "host process count grew by $(( after - before ))"
    else
        ok "fork bomb is contained and leaves no survivors"
    fi

    # 8. A non-zero exit code must be reported faithfully.
    run_code python 'import sys
sys.exit(42)'
    if [[ "$RC" -eq 42 ]]; then
        ok "program exit codes are reported faithfully"
    else
        bad "program exit codes are reported faithfully" "expected 42, got $RC"
    fi

    # 9. Workspaces must be destroyed after the run.
    leftovers=$(find "${CC_WORKSPACE_ROOT:-/var/tmp/codecraft}" -maxdepth 1 -name 'run_*' 2>/dev/null | wc -l)
    if [[ "$leftovers" -eq 0 ]]; then
        ok "ephemeral workspaces are destroyed after each run"
    else
        bad "ephemeral workspaces are destroyed after each run" "$leftovers workspace(s) left behind"
    fi

    # 10. An unknown runtime must be rejected, not guessed at.
    run_code definitely-not-a-language 'print(1)'
    if [[ "$RC" -eq 65 ]]; then
        ok "unknown runtimes are rejected with exit 65"
    else
        bad "unknown runtimes are rejected with exit 65" "got exit $RC"
    fi
fi

# ---------------------------------------------------------------------------
if [[ "$QUICK" -eq 0 ]]; then
printf '\n\033[1m Installed runtimes\033[0m\n'
    while read -r lang; do
        probe="$(jq -r --arg l "$lang" '.runtimes[$l].probe // empty' "$RUNTIMES_JSON")"
        if [[ -z "$probe" ]] || ! command -v "$probe" >/dev/null 2>&1; then
            skip "$lang (toolchain '$probe' not installed)"
            continue
        fi
        template="$(jq -r --arg l "$lang" '.runtimes[$l].template' "$RUNTIMES_JSON")"
        run_code "$lang" "$template" --timeout 30 --compile-timeout 90
    out="$OUT"
        if [[ "$RC" -eq 0 && "$out" == *"Hello from"* ]]; then
            ok "$lang"
        elif [[ "$RC" -eq 0 && "$lang" == "sql" ]]; then
            ok "$lang"
        else
            bad "$lang" "exit $RC: ${out:0:160}"
        fi
    done < <(jq -r '.runtimes | to_entries[] | select(.value.run != null) | .key' "$RUNTIMES_JSON")
fi

# ---------------------------------------------------------------------------
printf '\n\033[1m Summary\033[0m\n'
printf '  %s passed, %s failed, %s skipped\n\n' "$(green "$PASS")" "$( [[ "$FAIL" -gt 0 ]] && red "$FAIL" || echo "$FAIL")" "$SKIP"
[[ "$FAIL" -eq 0 ]]
