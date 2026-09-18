#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CodeCraft Studio - toolchain provisioning.
#
# Installs language toolchains and the isolation primitives the sandbox relies
# on. Groups let an operator install only what a node needs rather than every
# compiler in the registry.
#
#   sudo ./scripts/provision_toolchains.sh --group core
#   sudo ./scripts/provision_toolchains.sh --group all --yes
#   ./scripts/provision_toolchains.sh --list
#
# Toolchains are installed system-wide on purpose. The sandbox runs as an
# unprivileged user, and a toolchain under a mode-700 home would be unreachable
# from inside it. The runner can bind-mount around that, but a system-wide
# install keeps the setup simple and inspectable.
# ---------------------------------------------------------------------------
set -euo pipefail

GROUP="core"
ASSUME_YES=0
LIST_ONLY=0

# --- package groups --------------------------------------------------------
# Isolation primitives. Without these the sandbox degrades to the rlimit tier.
PKGS_ISOLATION=(util-linux libseccomp2 jq)

PKGS_CORE=(build-essential gcc g++ python3 nodejs npm bash)

PKGS_SCRIPTING=(ruby-full php-cli perl luajit r-base-core awk gawk sqlite3 zsh)

PKGS_JVM=(default-jdk kotlin scala groovy)

PKGS_FUNCTIONAL=(ghc erlang elixir racket clojure)

PKGS_SYSTEMS=(gfortran nasm ldc golang-go)

usage() {
    sed -n '2,20p' "${BASH_SOURCE[0]}"
    cat <<'USAGE'
Groups:
  isolation   nsjail dependencies, util-linux, jq   (always installed)
  core        C, C++, Python, Node.js, Bash
  scripting   Ruby, PHP, Perl, Lua, R, AWK, SQLite, Zsh
  jvm         Java, Kotlin, Scala, Groovy
  functional  Haskell, Erlang, Elixir, Racket, Clojure
  systems     Fortran, NASM, D, Go
  all         every group above

Options:
  --group <name>   Group to install (default: core)
  --yes            Do not prompt before installing
  --list           Print what would be installed and exit
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --group) GROUP="${2:-core}"; shift 2 ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --list) LIST_ONLY=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; usage; exit 64 ;;
    esac
done

select_packages() {
    local -n out="$1"
    out=("${PKGS_ISOLATION[@]}")
    case "$GROUP" in
        isolation)  ;;
        core)       out+=("${PKGS_CORE[@]}") ;;
        scripting)  out+=("${PKGS_SCRIPTING[@]}") ;;
        jvm)        out+=("${PKGS_JVM[@]}") ;;
        functional) out+=("${PKGS_FUNCTIONAL[@]}") ;;
        systems)    out+=("${PKGS_SYSTEMS[@]}") ;;
        all)        out+=("${PKGS_CORE[@]}" "${PKGS_SCRIPTING[@]}" "${PKGS_JVM[@]}"
                          "${PKGS_FUNCTIONAL[@]}" "${PKGS_SYSTEMS[@]}") ;;
        *) echo "Unknown group '$GROUP'. Use --help to see the list." >&2; exit 64 ;;
    esac
}

declare -a PACKAGES
select_packages PACKAGES

if [[ "$LIST_ONLY" == "1" ]]; then
    printf 'Group "%s" installs:\n' "$GROUP"
    printf '  %s\n' "${PACKAGES[@]}"
    exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
    cat >&2 <<'ERROR'
This script targets Debian and Ubuntu. On another distribution, install the
equivalents of the packages listed by --list, then run ./scripts/doctor.sh to
confirm which runtimes the node can execute.
ERROR
    exit 69
fi

if [[ "$(id -u)" -ne 0 ]]; then
    echo "Package installation needs root. Re-run with sudo." >&2
    exit 77
fi

printf 'Installing group "%s" (%d packages).\n' "$GROUP" "${#PACKAGES[@]}"
if [[ "$ASSUME_YES" != "1" ]]; then
    read -r -p "Continue? [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# Install one at a time: a package missing from this release should not abort
# the whole run, and the summary below tells the operator exactly what failed.
FAILED=()
for package in "${PACKAGES[@]}"; do
    if apt-get install -y -qq --no-install-recommends "$package" >/dev/null 2>&1; then
        printf '  installed  %s\n' "$package"
    else
        printf '  skipped    %s (not available on this release)\n' "$package"
        FAILED+=("$package")
    fi
done

# --- nsjail ----------------------------------------------------------------
# nsjail is not packaged on most releases. It is the strongest isolation tier,
# so building it is worth the extra step on a node that will face untrusted code.
if ! command -v nsjail >/dev/null 2>&1; then
    cat <<'NSJAIL'

nsjail is not installed. It provides the strongest isolation tier (chroot,
full namespaces and a seccomp-bpf policy). To build it from source:

  apt-get install -y autoconf bison flex gcc g++ git libprotobuf-dev \
      libnl-route-3-dev libtool make pkg-config protobuf-compiler
  git clone --depth 1 https://github.com/google/nsjail /tmp/nsjail
  make -C /tmp/nsjail && install -m 755 /tmp/nsjail/nsjail /usr/local/bin/nsjail

Without it the sandbox uses the userns tier, which is still isolated but has a
smaller syscall barrier.
NSJAIL
fi

printf '\nDone. %d package(s) unavailable on this release.\n' "${#FAILED[@]}"
printf 'Run ./scripts/doctor.sh to see which runtimes this node can now execute.\n'
