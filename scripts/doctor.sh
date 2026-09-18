#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CodeCraft Studio - host capability report.
#
# Answers the question an operator actually has: what will this machine do if I
# point untrusted code at it right now?
# ---------------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly RUNTIMES_JSON="$SCRIPT_DIR/runtimes.json"

# shellcheck source=scripts/lib/isolation.sh
source "$SCRIPT_DIR/lib/isolation.sh"

bold()  { printf '\033[1m%s\033[0m' "$1"; }
green() { printf '\033[1;32m%s\033[0m' "$1"; }
amber() { printf '\033[1;33m%s\033[0m' "$1"; }
red()   { printf '\033[1;31m%s\033[0m' "$1"; }
dim()   { printf '\033[38;5;244m%s\033[0m' "$1"; }

row() { printf '  %-26s %s\n' "$1" "$2"; }

yes_no() { [[ "$1" == "0" ]] && green "yes" || red "no"; }

printf '\n%s\n\n' "$(bold 'CodeCraft Studio - host report')"

# ---------------------------------------------------------------------------
printf '%s\n' "$(bold 'Isolation')"
# ---------------------------------------------------------------------------
TIER="$(cc_detect_tier)"
case "$TIER" in
    nsjail) TIER_NOTE="$(green 'nsjail') $(dim '- chroot, namespaces and a seccomp policy')" ;;
    userns) TIER_NOTE="$(green 'userns') $(dim '- namespaces, mount sealing and rlimits')" ;;
    rlimit) TIER_NOTE="$(red 'rlimit') $(dim '- resource limits only, NO kernel isolation')" ;;
    *)      TIER_NOTE="$(amber "$TIER")" ;;
esac
row "Active tier" "$TIER_NOTE"
row "nsjail installed" "$(cc_have nsjail && green yes || dim no)"
row "User namespaces" "$(cc_userns_supported && green yes || red no)"
row "unshare(1)" "$(cc_have unshare && green yes || red no)"
row "setpriv(1)" "$(cc_have setpriv && green yes || amber no)"
row "prlimit(1)" "$(cc_have prlimit && green yes || red no)"

CGROUP="$(cc_cgroup_root)"
row "cgroup v2 (writable)" "$([[ -n "$CGROUP" ]] && green "yes  $CGROUP" || dim 'no  (limits fall back to rlimits)')"
row "Running as" "$([[ "$(id -u)" -eq 0 ]] && printf 'root %s' "$(dim '(privileges are dropped per run)')" || id -un)"

if [[ "$TIER" == "rlimit" ]]; then
    printf '\n  %s Untrusted code would run with no kernel isolation on this host.\n' "$(red 'WARNING:')"
    printf '  %s\n' "$(dim 'Install nsjail, or enable unprivileged user namespaces, before exposing this node.')"
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "$(bold 'Services')"
# ---------------------------------------------------------------------------
SUPERVISOR_BIN="$SCRIPT_DIR/../core/supervisor/target/release/codecraft-supervisor"
ANALYZER_BIN="$SCRIPT_DIR/../core/analyzer/build/codecraft-analyzer"
SOCKET="${CODECRAFT_SOCKET:-/run/codecraft/supervisor.sock}"

row "Supervisor binary" "$([[ -x "$SUPERVISOR_BIN" ]] && green built || dim "not built  (make supervisor)")"
row "Supervisor socket" "$([[ -S "$SOCKET" ]] && green "listening  $SOCKET" || dim 'not running  (gateway uses the in-process runner)')"
row "Analyzer binary" "$([[ -x "$ANALYZER_BIN" ]] && green built || dim 'not built  (make analyzer)')"
row "jq" "$(cc_have jq && green yes || red 'no  (required by the runner)')"

# ---------------------------------------------------------------------------
printf '\n%s\n' "$(bold 'Runtimes')"
# ---------------------------------------------------------------------------
if ! cc_have jq; then
    printf '  %s\n' "$(red 'jq is required to read the runtime registry.')"
    exit 1
fi

TOTAL=0
INSTALLED=0
MISSING=()

while IFS=$'\t' read -r id label probe runnable; do
    TOTAL=$(( TOTAL + 1 ))
    if [[ "$runnable" != "true" ]]; then
        continue
    fi
    if [[ -n "$probe" ]] && cc_have "$probe"; then
        INSTALLED=$(( INSTALLED + 1 ))
    else
        MISSING+=("$label ($probe)")
    fi
done < <(jq -r '.runtimes | to_entries[] |
    [.key, .value.label, (.value.probe // ""), (if .value.run then "true" else "false" end)] | @tsv' \
    "$RUNTIMES_JSON")

row "Registered" "$TOTAL"
row "Executable here" "$(green "$INSTALLED")"
row "Toolchains missing" "$(dim "${#MISSING[@]}")"

if [[ "${1:-}" == "--verbose" && ${#MISSING[@]} -gt 0 ]]; then
    printf '\n  %s\n' "$(dim 'Not installed on this host:')"
    printf '    %s\n' "${MISSING[@]}"
    printf '\n  %s\n' "$(dim 'Install a subset with: sudo ./scripts/provision_toolchains.sh --group core')"
fi

printf '\n'
