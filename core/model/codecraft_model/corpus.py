"""Fetching a corpus far larger than the disk it is built on.

The arithmetic that makes a billion-token corpus practical: a token is two
bytes, so a billion of them is 2GB. The source they came from is about 3.5GB of
text, and the repositories holding that source are several times larger again
once non-source files are counted.

So the source is never kept. Each repository is cloned shallow, encoded to
tokens that are appended to the growing stream, and deleted before the next one
starts. Peak disk is therefore the token stream plus one repository, not the sum
of everything ever read, and the corpus can be far larger than the machine.

A shallow clone is the right depth here for two reasons: history is bandwidth
spent on text the model will never see, and a repository's past revisions are
near-duplicates of its present, which is training data that teaches nothing.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from .data import iter_sources


@dataclass(frozen=True)
class Repository:
    """A repository to read once and throw away."""

    url: str
    name: str

    @property
    def directory_name(self) -> str:
        return self.name.replace("/", "_")


def parse_repository(spec: str) -> Repository:
    """Accept `owner/name`, a full URL, or a URL with no scheme."""
    spec = spec.strip().rstrip("/")
    if not spec:
        raise ValueError("empty repository specification")

    if spec.startswith(("http://", "https://", "git://", "ssh://", "git@")):
        name = spec.rsplit("/", 2)[-2:] if "/" in spec else [spec]
        return Repository(spec, "/".join(name).removesuffix(".git"))

    if spec.count("/") == 1:
        return Repository(f"https://github.com/{spec}.git", spec)

    raise ValueError(
        f"cannot read '{spec}' as a repository: use owner/name or a full URL"
    )


def read_repository_list(path: Path) -> list[Repository]:
    """One repository per line. Blank lines and `#` comments are ignored."""
    repositories = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            repositories.append(parse_repository(line))
    return repositories


def clone(
    repository: Repository,
    into: Path,
    *,
    depth: int = 1,
    timeout: float = 1800.0,
) -> Path | None:
    """Shallow-clone `repository`, or return None if it cannot be fetched.

    A repository that fails is skipped rather than fatal: a corpus built from
    fifty of them should not be lost to one that has been renamed.
    """
    destination = into / repository.directory_name
    shutil.rmtree(destination, ignore_errors=True)

    try:
        result = subprocess.run(
            [
                "git", "clone",
                "--depth", str(depth),
                # No submodules and no LFS payloads: both are usually binaries,
                # and neither is worth the bandwidth for a text corpus.
                "--no-recurse-submodules",
                "--quiet",
                repository.url,
                str(destination),
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            env={"GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1", **_git_env()},
        )
    except subprocess.TimeoutExpired:
        shutil.rmtree(destination, ignore_errors=True)
        return None

    if result.returncode != 0:
        shutil.rmtree(destination, ignore_errors=True)
        return None

    # The pack files are a large fraction of a shallow clone and hold nothing
    # readable. Removing them now frees the space before the next clone starts.
    shutil.rmtree(destination / ".git", ignore_errors=True)
    return destination


def _git_env() -> dict[str, str]:
    """Keep the ambient environment, which carries proxy settings."""
    import os

    return dict(os.environ)


def directory_size(path: Path) -> int:
    total = 0
    for entry in path.rglob("*"):
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


def iter_repository_sources(
    repositories: list[Repository],
    workspace: Path,
    *,
    allow: frozenset[str] = frozenset(),
    depth: int = 1,
    progress: bool = True,
) -> Iterator[tuple[str, str]]:
    """Yield source files from each repository, deleting it once read.

    The delete is what keeps peak disk flat: at any moment there is one
    repository on disk, whatever the total size of the list.
    """
    workspace.mkdir(parents=True, exist_ok=True)

    for index, repository in enumerate(repositories, start=1):
        if progress:
            print(
                f"[{index}/{len(repositories)}] cloning {repository.name}",
                flush=True,
            )

        started = time.time()
        checkout = clone(repository, workspace, depth=depth)
        if checkout is None:
            if progress:
                print(f"  could not clone {repository.name}; skipping", flush=True)
            continue

        size = directory_size(checkout)
        if progress:
            print(
                f"  {size / 1e6:.0f}MB in {time.time() - started:.0f}s, reading",
                flush=True,
            )

        try:
            yield from iter_sources([checkout], allow=allow)
        finally:
            # Deleted even if encoding raises, so a failure does not leave the
            # disk full and block everything after it.
            shutil.rmtree(checkout, ignore_errors=True)


def estimate(target_tokens: int, characters_per_token: float = 3.5) -> dict:
    """The disk a corpus of `target_tokens` actually costs.

    Kept as a function rather than a paragraph in the documentation because the
    numbers are the whole question, and a reader should be able to ask for their
    own target rather than scale the one that happens to be written down.
    """
    source_bytes = target_tokens * characters_per_token
    token_bytes = target_tokens * 2  # uint16, for a vocabulary up to 65,536

    return {
        "tokens": target_tokens,
        "source_text_gb": source_bytes / 1e9,
        # Repositories carry tests, documentation, assets and generated files
        # alongside the source that survives filtering.
        "repositories_gb": source_bytes * 3.0 / 1e9,
        "token_stream_gb": token_bytes / 1e9,
        # Streaming keeps one repository at a time, so the source never
        # accumulates. This is the number that decides whether it is possible.
        "peak_disk_streaming_gb": (token_bytes + source_bytes * 3.0 * 0.05) / 1e9,
        "peak_disk_keeping_sources_gb": (token_bytes + source_bytes * 3.0) / 1e9,
    }
