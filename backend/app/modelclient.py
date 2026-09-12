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
    superseded: bool = False
    confidence: float | None = None
    # Why the completion ended when the model did not choose to: "dedent" or
    # "bracket" when it stopped belonging to the caret, otherwise None.
    trimmed: str | None = None


def _post(path: str, payload: dict, timeout: float, headers: dict | None = None) -> dict:
    request = urllib.request.Request(
        f"{settings.model_url.rstrip('/')}{path}",
        json.dumps(payload).encode("utf-8"),
        {"Content-Type": "application/json", **(headers or {})},
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


async def infill(
    prefix: str,
    suffix: str,
    *,
    max_tokens: int,
    temperature: float,
    source: str = "",
    candidates: int = 1,
    line_comment: str | None = None,
) -> Infill:
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
    # Sent only when asked for, so a model server old enough not to know the
    # field never sees it.
    if candidates > 1:
        payload["candidates"] = candidates
    # What a comment looks like in this file. Only the editor knows, and
    # without it the server counts brackets inside comments.
    if line_comment:
        payload["line_comment"] = line_comment
    # Passed as a header rather than in the body: it says who is asking, not
    # what is being asked, and the model server reads it before parsing.
    headers = {"X-Request-Source": source} if source else None
    body = await asyncio.to_thread(
        _post, "/infill", payload, settings.model_timeout_seconds, headers
    )

    return Infill(
        completion=str(body.get("completion", "")),
        tokens=int(body.get("tokens", 0)),
        model=str(body.get("model", "unknown")),
        seconds=float(body.get("seconds", 0.0)),
        superseded=bool(body.get("superseded", False)),
        confidence=(
            float(body["confidence"]) if isinstance(body.get("confidence"), (int, float)) else None
        ),
        trimmed=(str(body["trimmed"]) if isinstance(body.get("trimmed"), str) else None),
    )


@dataclass
class Split:
    """How the model's tokenizer divides a piece of text."""

    tokens: int
    characters: int
    context: int


async def tokenize(text: str) -> Split:
    """How many tokens a piece of text is, and how much context there is.

    An editor sizing a prompt has been guessing at this: characters per token
    varies by a factor of three depending on what the code looks like, so a
    character budget is either wasteful or short and there is no way to tell
    which from the client side.
    """
    body = await asyncio.to_thread(
        _post, "/tokenize", {"text": text}, settings.model_timeout_seconds, None
    )
    return Split(
        tokens=int(body.get("tokens", 0)),
        characters=int(body.get("characters", len(text))),
        context=int(body.get("context", 0)),
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
