"""Client for the assistant daemon.

The daemon owns both engines: an instant local index and the Claude model. The
gateway only relays frames, so the routing decision stays in one place rather
than being duplicated here.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from .config import settings

CONNECT_TIMEOUT_SECONDS = 5.0
LOCAL_TIMEOUT_SECONDS = 15.0
# A long-horizon model turn can legitimately run for minutes.
CHAT_TIMEOUT_SECONDS = 600.0
# One frame per line; a model answer can carry a long line of code.
MAX_FRAME_BYTES = 4 * 1024 * 1024


class AssistantUnavailable(RuntimeError):
    """The assistant daemon is not running."""


def available() -> bool:
    return settings.assistant_socket.exists()


async def _connect() -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    if not available():
        raise AssistantUnavailable(
            f"The assistant daemon is not running at {settings.assistant_socket}. "
            "Start it with 'make assistant-daemon'."
        )
    try:
        return await asyncio.wait_for(
            asyncio.open_unix_connection(
                str(settings.assistant_socket), limit=MAX_FRAME_BYTES
            ),
            timeout=CONNECT_TIMEOUT_SECONDS,
        )
    except (OSError, asyncio.TimeoutError) as exc:
        raise AssistantUnavailable(f"assistant daemon is unreachable: {exc}") from exc


async def stream(request: dict[str, Any], timeout: float) -> AsyncIterator[dict[str, Any]]:
    """Send one request and yield the frames it produces."""
    reader, writer = await _connect()
    try:
        writer.write((json.dumps(request) + "\n").encode("utf-8"))
        await writer.drain()
        writer.write_eof()

        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                yield {"type": "error", "message": "The assistant timed out."}
                return
            try:
                line = await asyncio.wait_for(reader.readline(), timeout=remaining)
            except asyncio.TimeoutError:
                yield {"type": "error", "message": "The assistant timed out."}
                return
            except ValueError:
                # A single frame exceeded the reader's buffer.
                yield {"type": "error", "message": "The assistant sent an oversized frame."}
                return

            if not line:
                return
            try:
                yield json.loads(line.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass


async def collect(request: dict[str, Any], timeout: float = LOCAL_TIMEOUT_SECONDS) -> list[dict]:
    """Run a request to completion and return every frame."""
    return [frame async for frame in stream(request, timeout)]


async def health() -> dict[str, Any] | None:
    if not available():
        return None
    try:
        frames = await collect({"op": "health"}, timeout=CONNECT_TIMEOUT_SECONDS)
    except AssistantUnavailable:
        return None
    return next((f for f in frames if f.get("type") == "health"), None)


def workspace_payload(
    language: str,
    files: list[dict[str, str]],
    *,
    active_file: str = "",
    line: int = 0,
    column: int = 0,
    selection: str = "",
) -> dict[str, Any]:
    """Shape a workspace the way the daemon expects it."""
    return {
        "language": language,
        "files": [{"name": f["name"], "content": f.get("content", "")} for f in files],
        "active_file": active_file,
        "line": line,
        "column": column,
        "selection": selection,
    }
