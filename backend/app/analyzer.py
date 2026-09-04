"""Client for the C++ static analyzer.

The analyzer is a short-lived process reading source on stdin and writing JSON
on stdout. It is pure analysis with no execution, so it needs no sandbox, but it
is still given a deadline and a size cap.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from .config import settings

ANALYSIS_TIMEOUT_SECONDS = 10.0


class AnalyzerUnavailable(RuntimeError):
    """The analyzer binary has not been built on this host."""


def available() -> bool:
    path = settings.analyzer_path
    return path.is_file()


async def analyze(source: str, language: str) -> dict[str, Any]:
    if not available():
        raise AnalyzerUnavailable(
            f"analyzer binary not found at {settings.analyzer_path}; "
            "build it with 'make analyzer'"
        )

    process = await asyncio.create_subprocess_exec(
        str(settings.analyzer_path),
        "--language",
        language,
        "--format",
        "json",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(source.encode("utf-8")), timeout=ANALYSIS_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError as exc:
        process.kill()
        await process.wait()
        raise RuntimeError("static analysis timed out") from exc

    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or f"analyzer exited with code {process.returncode}")

    try:
        return json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError("analyzer returned malformed JSON") from exc
