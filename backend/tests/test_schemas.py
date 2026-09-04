"""Validation of the request surface.

These are the checks that stand between a hostile payload and the filesystem, so
they are asserted directly rather than only through the API.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import ExecutionLimits, ExecutionRequest, SourceFile


@pytest.mark.parametrize(
    "name",
    [
        "../escape.py",
        "a/../../b.py",
        "/etc/passwd",
        "~/.ssh/authorized_keys",
        "dir//file.py",
        "..",
        "with\nnewline.py",
        "back\\slash.py",
        "",
    ],
)
def test_rejects_hostile_file_names(name: str) -> None:
    with pytest.raises(ValidationError):
        SourceFile(name=name, content="x")


@pytest.mark.parametrize("name", ["main.py", "src/lib.rs", "a/b/c/main.cpp", "Cargo.toml"])
def test_accepts_ordinary_file_names(name: str) -> None:
    assert SourceFile(name=name, content="x").name == name


def test_rejects_a_request_with_no_files() -> None:
    with pytest.raises(ValidationError):
        ExecutionRequest(language="python", files=[])


def test_rejects_duplicate_file_names() -> None:
    with pytest.raises(ValidationError):
        ExecutionRequest(
            language="python",
            files=[SourceFile(name="main.py", content="a"), SourceFile(name="main.py", content="b")],
        )


def test_rejects_a_shell_injection_in_the_language_field() -> None:
    with pytest.raises(ValidationError):
        ExecutionRequest(
            language="python; rm -rf /",
            files=[SourceFile(name="main.py", content="x")],
        )


def test_rejects_limits_beyond_the_ceiling() -> None:
    with pytest.raises(ValidationError):
        ExecutionLimits(wall_seconds=100_000)
    with pytest.raises(ValidationError):
        ExecutionLimits(memory_mb=1_000_000)


def test_networking_is_off_by_default() -> None:
    assert ExecutionLimits().allow_net is False


def test_rejects_an_oversized_workspace() -> None:
    from app.config import settings

    oversized = "x" * (settings.max_source_bytes + 1)
    with pytest.raises(ValidationError):
        ExecutionRequest(language="python", files=[SourceFile(name="main.py", content=oversized)])
