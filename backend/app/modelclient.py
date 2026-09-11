"""Client for the local model server.

The model runs as its own process, in Python, on its own port. The gateway
reaches it over HTTP rather than importing it, for the reason the seam exists at
all: the training stack pulls in PyTorch and several gigabytes of CUDA
libraries, and a deployment that only compiles and runs code should not carry
any of that.

Written against the standard library rather than an HTTP client dependency. The
gateway's dependency list is short on purpose, and one POST does not justify
lengthening it.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from dataclasses import dataclass

from .config import settings


class ModelUnavailable(RuntimeError):
    """The model server is not running, or did not answer in time."""


@dataclass(frozen=True)
class Infill:
    completion: str
    tokens: int
    model: str
    seconds: float


def _post(path: str, payload: dict, timeout: float) -> dict:
    request = urllib.request.Request(
        f"{settings.model_url.rstrip('/')}{path}",
        json.dumps(payload).encode("utf-8"),
        {"Content-Type": "application/json"},
    )
    # The model server is on loopback. Going through an ambient proxy would
    # either fail or, worse, send the user's source code somewhere else.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    try:
        with opener.open(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:400]
        raise ModelUnavailable(f"the model server returned {error.code}: {detail}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ModelUnavailable(
            f"could not reach the model server at {settings.model_url}: {error}"
        ) from error
    except json.JSONDecodeError as error:
        raise ModelUnavailable(f"the model server sent malformed JSON: {error}") from error


async def infill(prefix: str, suffix: str, *, max_tokens: int, temperature: float) -> Infill:
    """Ask for the text that belongs between `prefix` and `suffix`.

    Run on a worker thread: the call is blocking, and an inline completion must
    never stall the event loop that is also streaming a program's output.
    """
    payload = {
        "prefix": prefix,
        "suffix": suffix,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    body = await asyncio.to_thread(_post, "/infill", payload, settings.model_timeout_seconds)

    return Infill(
        completion=str(body.get("completion", "")),
        tokens=int(body.get("tokens", 0)),
        model=str(body.get("model", "unknown")),
        seconds=float(body.get("seconds", 0.0)),
    )


def _get(path: str, timeout: float) -> dict:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"{settings.model_url.rstrip('/')}{path}", timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as error:  # noqa: BLE001 - any failure means unavailable
        raise ModelUnavailable(str(error)) from error


async def health() -> dict:
    """What the model server is serving, or raise if it is not there."""
    return await asyncio.to_thread(_get, "/health", settings.model_probe_seconds)


async def available() -> bool:
    """Whether the model server is reachable, without raising.

    Used by the capability report, where an absent model is a normal state to
    describe rather than an error to propagate.
    """
    try:
        await health()
        return True
    except ModelUnavailable:
        return False
