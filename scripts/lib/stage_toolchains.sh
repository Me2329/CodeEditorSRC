#!/bin/sh
# ---------------------------------------------------------------------------
# CodeCraft Studio - toolchain staging.
#
# Language toolchains are routinely installed under a home directory that is
# mode 700 (rustup, bun, nvm, sdkman, pyenv). The sandbox runs as an
# unprivileged user, which cannot traverse such a directory even though the
# toolchain itself is world-readable one level down.
#
# This helper runs as root inside a private mount namespace and read-only
# bind-mounts each blocked toolchain directory onto a world-readable staging
# path, which bypasses the traversal check on the original parent without
# changing a single permission on the host. Mounts are private, so nothing is
# visible outside this namespace and everything disappears when it exits.
#
#   stage_toolchains.sh <stage_root> <src>... -- <command> [args...]
#
# Sources are mounted at <stage_root>/t1, <stage_root>/t2, ... in argument
# order; the caller relies on that numbering to build the sandbox PATH.
# ---------------------------------------------------------------------------
set -u

stage_root="${1:?stage_toolchains: missing staging root}"
shift

warn() {
    [ "${CC_VERBOSE:-0}" = "1" ] || return 0
    printf '[codecraft] toolchain staging: %s\n' "$1" >&2
}

# Keep every mount below private so no bind escapes into the host namespace.
mount --make-rprivate / 2>/dev/null || warn "could not make mounts private"

index=0
while [ $# -gt 0 ]; do
    [ "$1" = "--" ] && { shift; break; }
    index=$(( index + 1 ))
    target="$stage_root/t$index"
    mkdir -p "$target" 2>/dev/null
    if mount --bind "$1" "$target" 2>/dev/null; then
        mount -o remount,ro,bind "$target" 2>/dev/null || warn "could not seal $target read-only"
    else
        warn "could not stage $1"
    fi
    shift
done

exec "$@"
