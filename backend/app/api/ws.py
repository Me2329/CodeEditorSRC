"""Interactive execution over WebSockets.

Protocol, all frames JSON:

  client -> server   {"action": "execute", ...ExecutionRequest fields}
                     {"action": "abort"}
  server -> client   {"type": "ready"}      handshake, carries node capabilities
                     {"type": "accepted"}   the job passed validation
                     {"type": "stdout"|"stderr", "content": "..."}
                     {"type": "exit", "code": n, "execution_time": ms, ...}
                     {"type": "error", "message": "..."}

The socket stays open after a run so the next execution reuses it. One job at a
time per connection; a second request while one is running is refused rather
than queued, because the terminal it feeds can only show one stream.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from starlette.websockets import WebSocketState

from ..executor import ExecutionError
from ..runtimes import registry
from ..schemas import ExecutionRequest

logger = logging.getLogger("codecraft.ws")

router = APIRouter()

# Guard against a client streaming an unbounded frame at the gateway.
MAX_FRAME_BYTES = 8 * 1024 * 1024


class _Connection:
    """Owns one WebSocket and serialises writes to it."""

    def __init__(self, socket: WebSocket) -> None:
        self._socket = socket
        self._lock = asyncio.Lock()

    async def send(self, frame: dict) -> None:
        if self._socket.client_state is not WebSocketState.CONNECTED:
            return
        async with self._lock:
            try:
                await self._socket.send_json(frame)
            except (WebSocketDisconnect, RuntimeError):
                # The client vanished mid-write; the read loop will notice.
                pass

    async def error(self, message: str) -> None:
        await self.send({"type": "error", "message": message})


@router.websocket("/api/v1/ws/execute")
async def execute_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    connection = _Connection(websocket)
    app = websocket.app

    await connection.send(
        {
            "type": "ready",
            "isolation_tier": app.state.isolation_tier,
            "backend": app.state.executions.select().name,
        }
    )

    running: asyncio.Task | None = None
    cancel = asyncio.Event()

    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_FRAME_BYTES:
                await connection.error("Request frame is too large.")
                continue

            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await connection.error("Request is not valid JSON.")
                continue
            if not isinstance(message, dict):
                await connection.error("Request must be a JSON object.")
                continue

            action = message.get("action", "execute")

            if action == "abort":
                if running is not None and not running.done():
                    cancel.set()
                    await connection.send({"type": "aborting"})
                else:
                    await connection.send({"type": "idle"})
                continue

            if action != "execute":
                await connection.error(f"Unknown action '{action}'.")
                continue

            if running is not None and not running.done():
                await connection.error("A job is already running on this connection.")
                continue

            cancel = asyncio.Event()
            running = asyncio.create_task(_run_job(connection, app, message, cancel))

    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover - defensive
        logger.exception("WebSocket handler failed")
    finally:
        # A client that closes the tab must not leave a job running.
        cancel.set()
        if running is not None and not running.done():
            try:
                await asyncio.wait_for(running, timeout=10.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                running.cancel()
        if websocket.client_state is WebSocketState.CONNECTED:
            await websocket.close()


async def _run_job(
    connection: _Connection,
    app,
    message: dict,
    cancel: asyncio.Event,
) -> None:
    """Validate and execute one request, reporting every outcome to the client."""
    payload = dict(message)
    payload.pop("action", None)

    # The original single-file shape stays supported: {"language":..,"code":".."}
    if "files" not in payload and "code" in payload:
        language = payload.get("language", "")
        runtime = registry().get(language)
        entry = payload.get("entry") or (runtime.entry if runtime else "main.txt")
        payload["files"] = [{"name": entry, "content": payload.pop("code")}]

    try:
        request = ExecutionRequest.model_validate(payload)
    except ValidationError as exc:
        first = exc.errors()[0]
        location = ".".join(str(part) for part in first.get("loc", ()))
        await connection.error(f"Invalid request at '{location}': {first.get('msg')}")
        return

    runtime = registry().get(request.language)
    if runtime is None:
        await connection.error(f"Unknown runtime '{request.language}'.")
        return
    if not runtime.executable:
        await connection.error(
            f"{runtime.label} is rendered in the browser and has no server execution path."
        )
        return
    if not runtime.installed:
        await connection.error(
            f"The toolchain for {runtime.label} is not installed on this node."
        )
        return

    client_key = _client_key(connection)
    verdict = await app.state.rate_limiter.check(client_key)
    if not verdict.allowed:
        await connection.error(
            f"Rate limit exceeded. Retry in {verdict.retry_after}s."
        )
        return

    await connection.send(
        {
            "type": "accepted",
            "language": request.language,
            "label": runtime.label,
            "remaining_quota": verdict.remaining,
        }
    )

    try:
        result = await app.state.executions.run(request, connection.send, cancel)
    except ExecutionError as exc:
        await connection.error(str(exc))
        return
    except asyncio.CancelledError:
        await connection.send({"type": "exit", "code": -1, "execution_time": 0, "aborted": True})
        raise
    except Exception:
        logger.exception("Execution failed for runtime %s", request.language)
        await connection.error("The execution backend failed. The incident has been logged.")
        return

    await connection.send(
        {
            "type": "exit",
            "code": result.exit_code,
            "execution_time": result.duration_ms,
            "truncated": result.truncated,
            "aborted": cancel.is_set(),
            "meta": result.meta,
        }
    )


def _client_key(connection: _Connection) -> str:
    socket = connection._socket  # noqa: SLF001 - internal by design
    return socket.client.host if socket.client else "unknown"
