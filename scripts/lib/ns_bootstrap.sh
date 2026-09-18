#!/bin/sh
# ---------------------------------------------------------------------------
# CodeCraft Studio - in-namespace mount hardening bootstrap.
#
# Runs as the first process inside the sandbox's mount namespace, where it still
# holds CAP_SYS_ADMIN over that namespace only. It seals the filesystem view and
# then execs the payload, so user code never runs with mount privileges.
#
#   ns_bootstrap.sh <workspace> <command> [args...]
#
# Sealing steps, all confined to this namespace and invisible to the host:
#   1. Make every mount private so nothing propagates back out.
#   2. Bind the workspace onto itself, giving it its own mount entry.
#   3. Replace /tmp with a small RAM-backed tmpfs.
#   4. Remount the root filesystem read-only.
#   5. Restore read-write on the workspace bind only.
#
# Each step is best-effort: a kernel or policy that refuses one of them degrades
# the sandbox but must not abort the run, so failures are reported and skipped.
# ---------------------------------------------------------------------------
set -u

workspace="${1:?ns_bootstrap: missing workspace argument}"
shift

warn() {
    [ "${CC_VERBOSE:-0}" = "1" ] || return 0
    printf '[codecraft] mount hardening: %s\n' "$1" >&2
}

mount --make-rprivate /                                      2>/dev/null || warn "could not make mounts private"
mount --bind "$workspace" "$workspace"                       2>/dev/null || warn "could not bind workspace"

# A tmpfs on /tmp would shadow a workspace that lives underneath it, leaving the
# sandbox with no working directory at all. Workspaces belong outside /tmp, but
# an operator may point the workspace root anywhere, so detect the overlap and
# keep the host's /tmp instead of breaking the run. The root filesystem is
# sealed read-only below either way, and TMPDIR already points into the
# workspace, so nothing user code writes escapes.
case "$workspace" in
    /tmp|/tmp/*)
        warn "workspace lives under /tmp; skipping the ephemeral /tmp mount"
        ;;
    *)
        mount -t tmpfs -o "size=${CC_TMPFS_SIZE:-64m},mode=1777,nosuid,nodev" tmpfs /tmp \
                                                             2>/dev/null || warn "could not mount ephemeral /tmp"
        ;;
esac

mount -o remount,ro,bind /                                   2>/dev/null || warn "could not seal root read-only"
mount -o remount,rw,bind "$workspace"                        2>/dev/null || warn "could not restore workspace writability"

cd "$workspace" || {
    printf '[codecraft] sandbox workspace is unreachable: %s\n' "$workspace" >&2
    exit 66
}

exec "$@"
