#!/usr/bin/env python3
"""Check that the container's Rust is new enough for the committed lockfiles.

This exists because it wasn't, for 117 commits, and nothing noticed until
someone ran `docker compose up --build` and watched it fail.

The coupling is invisible from either end. The Dockerfile pins a Rust image;
the lockfiles pin dependency versions; and a dependency's *edition* decides
which compilers can even parse its manifest. When they drift apart the build
fails inside a transitive crate nobody chose, saying "failed to parse manifest"
about a package the reader has never heard of.

So this reads both ends and compares them. It takes about a second and needs
no network, no Docker and no Rust — which is the point, because the check that
only runs during a twenty-minute image build is the check nobody runs.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: The Rust release that stabilised each edition. A crate whose manifest
#: declares an edition needs at least this to be parsed at all.
EDITION_FLOOR = {
    "2015": (1, 0),
    "2018": (1, 31),
    "2021": (1, 56),
    "2024": (1, 85),
}

LOCKFILES = ("core/supervisor/Cargo.lock", "core/assistant/Cargo.lock")
MANIFESTS = ("core/supervisor/Cargo.toml", "core/assistant/Cargo.toml")


def parse_version(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", text)[:3])


def format_version(version: tuple[int, ...]) -> str:
    return ".".join(str(part) for part in version)


def dockerfile_rust() -> tuple[tuple[int, ...], str] | None:
    """The Rust version the image is pinned to, and the line it came from."""
    for line in (ROOT / "Dockerfile").read_text().splitlines():
        found = re.match(r"^FROM\s+(?:[\w./-]+/)?rust:([\d.]+)", line.strip())
        if found:
            return parse_version(found.group(1)), line.strip()
    return None


def locked_packages() -> list[tuple[str, str]]:
    """Every (name, version) the lockfiles pin, across both crates."""
    packages: list[tuple[str, str]] = []
    for lockfile in LOCKFILES:
        text = (ROOT / lockfile).read_text()
        packages.extend(re.findall(r'name = "([^"]+)"\nversion = "([^"]+)"', text))
    return packages


def from_cargo_metadata() -> tuple[tuple[int, ...], list[str]] | None:
    """Ask cargo what the locked tree needs, which is the exact answer.

    `cargo metadata` reports every package's edition and declared rust-version
    without compiling anything, and works on a machine that has never built the
    project. It needs cargo on the path; when there is none, the caller falls
    back to reading whatever the registry happens to have unpacked.
    """
    import json
    import shutil
    import subprocess

    if shutil.which("cargo") is None:
        return None

    worst: tuple[int, ...] = (0,)
    blame: list[str] = []

    for manifest in MANIFESTS:
        try:
            result = subprocess.run(
                ["cargo", "metadata", "--format-version", "1", "--locked",
                 "--manifest-path", str(ROOT / manifest)],
                capture_output=True, text=True, timeout=120, check=True,
            )
        except (subprocess.SubprocessError, OSError):
            return None

        for package in json.loads(result.stdout).get("packages", []):
            needs: tuple[int, ...] = (0,)
            edition = str(package.get("edition", ""))
            if edition in EDITION_FLOOR:
                needs = max(needs, EDITION_FLOOR[edition])
            declared = package.get("rust_version")
            if declared:
                needs = max(needs, parse_version(str(declared)))
            if needs == (0,):
                continue
            label = f"{package.get('name')} {package.get('version')}"
            if needs > worst:
                worst, blame = needs, [label]
            elif needs == worst and len(blame) < 4 and label not in blame:
                blame.append(label)

    return (worst, blame) if worst > (0,) else None


def registry_roots() -> list[Path]:
    """Where cargo unpacks crate sources, if it has."""
    import os

    home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    source = home / "registry" / "src"
    return sorted(source.glob("*")) if source.is_dir() else []


def required_by_dependencies() -> tuple[tuple[int, ...], list[str]]:
    """The highest Rust the locked tree needs, and which crates ask for it.

    Cargo is asked first, because it knows. Failing that, the crates already
    unpacked in the registry are read, which is a lower bound on a machine that
    has not built the project.
    """
    exact = from_cargo_metadata()
    if exact is not None:
        return exact

    roots = registry_roots()
    worst: tuple[int, ...] = (0,)
    blame: list[str] = []

    for name, version in locked_packages():
        for root in roots:
            manifest = root / f"{name}-{version}" / "Cargo.toml"
            if not manifest.is_file():
                continue
            body = manifest.read_text(errors="replace")
            needs: tuple[int, ...] = (0,)
            edition = re.search(r'^\s*edition\s*=\s*"(\d+)"', body, re.M)
            if edition and edition.group(1) in EDITION_FLOOR:
                needs = max(needs, EDITION_FLOOR[edition.group(1)])
            declared = re.search(r'^\s*rust-version\s*=\s*"([\d.]+)"', body, re.M)
            if declared:
                needs = max(needs, parse_version(declared.group(1)))
            if needs > worst:
                worst, blame = needs, [f"{name} {version}"]
            elif needs == worst and needs > (0,) and len(blame) < 4:
                blame.append(f"{name} {version}")
            break

    return worst, blame


def declared_msrv() -> list[tuple[str, tuple[int, ...]]]:
    """What each of our own crates claims to need."""
    found = []
    for manifest in MANIFESTS:
        body = (ROOT / manifest).read_text()
        declared = re.search(r'^\s*rust-version\s*=\s*"([\d.]+)"', body, re.M)
        if declared:
            found.append((manifest, parse_version(declared.group(1))))
    return found


def main() -> int:
    pinned = dockerfile_rust()
    if pinned is None:
        print("no `FROM rust:<version>` in the Dockerfile to check", file=sys.stderr)
        return 1
    image, line = pinned

    needed, blame = required_by_dependencies()
    problems: list[str] = []

    if needed == (0,):
        print(
            "could not read what the lockfiles need: no cargo on the path, and none\n"
            "of the locked crates are unpacked in the registry. Install Rust or build\n"
            "the crates once, and this becomes exact.",
            file=sys.stderr,
        )
        return 0

    if image < needed:
        problems.append(
            f"the Dockerfile pins Rust {format_version(image)} but the lockfiles need "
            f"{format_version(needed)}\n"
            f"    {line}\n"
            f"    required by: {', '.join(blame)}\n"
            f"  A build will fail inside one of those crates with a message about\n"
            f"  parsing its manifest, which does not name this as the cause."
        )

    for manifest, claimed in declared_msrv():
        if claimed < needed:
            problems.append(
                f"{manifest} declares rust-version {format_version(claimed)}, below the "
                f"{format_version(needed)} its own lockfile needs.\n"
                f"  A floor below the real one neither guides cargo's resolver nor\n"
                f"  produces a useful error when it is crossed."
            )

    if problems:
        for problem in problems:
            print(f"error: {problem}\n", file=sys.stderr)
        return 1

    print(
        f"rust pin ok: image {format_version(image)} >= {format_version(needed)} "
        f"required by {blame[0] if blame else 'the lockfiles'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
