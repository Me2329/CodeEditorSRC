"""Assistant surface: chat over WebSocket, completions and symbols over REST."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketState

from .. import assistant, modelclient
from ..schemas import SourceFile

logger = logging.getLogger("codecraft.assistant")

router = APIRouter(tags=["assistant"])

MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_HISTORY_TURNS = 40


class WorkspaceContext(BaseModel):
    language: str = ""
    files: list[SourceFile] = Field(default_factory=list)
    active_file: str = ""
    line: int = Field(default=0, ge=0)
    column: int = Field(default=0, ge=0)
    selection: str = ""

    def payload(self) -> dict:
        return assistant.workspace_payload(
            self.language,
            [{"name": f.name, "content": f.content} for f in self.files],
            active_file=self.active_file,
            line=self.line,
            column=self.column,
            selection=self.selection,
        )


class CompletionRequest(BaseModel):
    workspace: WorkspaceContext
    prefix: str = ""
    limit: int = Field(default=25, ge=1, le=200)


class SymbolsRequest(BaseModel):
    workspace: WorkspaceContext


class InfillRequest(BaseModel):
    """A caret, with the code on both sides of it."""

    prefix: str = ""
    suffix: str = ""
    # Small on purpose: an inline suggestion should be a line or two, not an
    # essay the user has to read before deciding.
    max_tokens: int = Field(default=64, ge=1, le=512)
    # Low on purpose: a suggestion should be the likely continuation rather
    # than an interesting one.
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    # Identifies the editor asking, so the model server can abandon this
    # client's previous request when a newer one arrives. Two editors are two
    # sources and neither supersedes the other. Bounded because it is used as a
    # dictionary key on the model server.
    source: str = Field(default="", max_length=64)
    # Sample several completions and keep the one the model rates highest. Each
    # is a whole generation, so this multiplies the wait: it is for a request
    # someone is waiting on, not for one issued per keystroke.
    candidates: int = Field(default=1, ge=1, le=8)


@router.post("/api/v1/assistant/complete")
async def complete(payload: CompletionRequest) -> dict:
    """Completion candidates at the caret. Answered by the local engine."""
    try:
        frames = await assistant.collect(
            {
                "op": "complete",
                "workspace": payload.workspace.payload(),
                "prefix": payload.prefix,
                "limit": payload.limit,
            }
        )
    except assistant.AssistantUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc

    for frame in frames:
        if frame.get("type") == "completions":
            return {"items": frame.get("items", [])}
        if frame.get("type") == "error":
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, frame["message"])
    return {"items": []}


@router.post("/api/v1/assistant/symbols")
async def symbols(payload: SymbolsRequest) -> dict:
    """Every declaration in the workspace, for outline and go-to-symbol."""
    try:
        frames = await assistant.collect(
            {"op": "symbols", "workspace": payload.workspace.payload()}
        )
    except assistant.AssistantUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc

    for frame in frames:
        if frame.get("type") == "symbols":
            return {"items": frame.get("items", [])}
    return {"items": []}


@router.websocket("/api/v1/ws/assistant")
async def assistant_socket(websocket: WebSocket) -> None:
    """Streaming chat.

    Client sends {action: "chat", messages, workspace, route, effort}.
    Server replies with routed, thinking, delta and one terminal done or error.
    """
    await websocket.accept()

    daemon = await assistant.health()
    await websocket.send_json(
        {
            "type": "ready",
            "available": daemon is not None,
            "model": (daemon or {}).get("model", ""),
            "remote_available": (daemon or {}).get("remote_available", False),
            "reason": (daemon or {}).get(
                "reason",
                (daemon or {}).get(
                    "remote_reason",
                    "" if daemon else "The assistant daemon is not running.",
                ),
            ),
        }
    )

    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_FRAME_BYTES:
                await websocket.send_json(
                    {"type": "error", "message": "Request frame is too large."}
                )
                continue

            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json(
                    {"type": "error", "message": "Request is not valid JSON."}
                )
                continue

            if not isinstance(message, dict) or message.get("action") != "chat":
                await websocket.send_json(
                    {"type": "error", "message": "Expected an action of 'chat'."}
                )
                continue

            try:
                context = WorkspaceContext.model_validate(message.get("workspace", {}))
            except Exception as exc:  # pydantic validation
                await websocket.send_json(
                    {"type": "error", "message": f"Invalid workspace: {exc}"}
                )
                continue

            history = message.get("messages", [])
            if not isinstance(history, list) or not history:
                await websocket.send_json(
                    {"type": "error", "message": "Send at least one message."}
                )
                continue

            # Trim old turns rather than refusing: a long conversation should
            # keep working, and the recent turns are what matter.
            turns = [
                {"role": str(turn.get("role", "user")), "content": str(turn.get("content", ""))}
                for turn in history[-MAX_HISTORY_TURNS:]
                if isinstance(turn, dict)
            ]

            request = {
                "op": "chat",
                "messages": turns,
                "workspace": context.payload(),
                "route": message.get("route", "auto"),
                "effort": message.get("effort", "high"),
            }

            try:
                async for frame in assistant.stream(
                    request, timeout=assistant.CHAT_TIMEOUT_SECONDS
                ):
                    if websocket.client_state is not WebSocketState.CONNECTED:
                        break
                    await websocket.send_json(frame)
            except assistant.AssistantUnavailable as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})
            except Exception:
                logger.exception("Assistant stream failed")
                await websocket.send_json(
                    {"type": "error", "message": "The assistant backend failed."}
                )

    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover - defensive
        logger.exception("Assistant socket handler failed")
    finally:
        if websocket.client_state is WebSocketState.CONNECTED:
            await websocket.close()


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


@router.websocket("/api/v1/ws/agent")
async def agent_socket(websocket: WebSocket) -> None:
    """Run an agent task, streaming every step.

    Client sends {action: "run", messages, workspace, mode, effort, max_steps},
    and may send {action: "cancel"} at any time while a task is running.

    The server relays the daemon's own event stream: step, text, thinking,
    tool_started, tool_call, tool_result, file_changed, turn_usage, and one
    terminal finished or failed.
    """
    await websocket.accept()

    daemon = await assistant.health()
    await websocket.send_json(
        {
            "type": "ready",
            "available": daemon is not None,
            "model": (daemon or {}).get("model", ""),
            "remote_available": (daemon or {}).get("remote_available", False),
            "reason": (daemon or {}).get(
                "remote_reason", "" if daemon else "The assistant daemon is not running."
            ),
        }
    )

    session: assistant.AgentSession | None = None
    task: asyncio.Task | None = None

    async def pump(active: assistant.AgentSession) -> None:
        """Relay the daemon's events until the run ends."""
        try:
            async for frame in active.events(assistant.AGENT_TIMEOUT_SECONDS):
                if websocket.client_state is not WebSocketState.CONNECTED:
                    break
                await websocket.send_json(frame)
        except Exception:
            logger.exception("Agent stream failed")
            if websocket.client_state is WebSocketState.CONNECTED:
                await websocket.send_json(
                    {"type": "failed", "message": "The agent backend failed."}
                )
        finally:
            await active.close()

    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_FRAME_BYTES:
                await websocket.send_json(
                    {"type": "failed", "message": "Request frame is too large."}
                )
                continue

            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json(
                    {"type": "failed", "message": "Request is not valid JSON."}
                )
                continue
            if not isinstance(message, dict):
                await websocket.send_json(
                    {"type": "failed", "message": "Request must be a JSON object."}
                )
                continue

            action = message.get("action", "run")

            if action == "cancel":
                if session is not None and task is not None and not task.done():
                    await session.cancel()
                    await websocket.send_json({"type": "cancelling"})
                else:
                    await websocket.send_json({"type": "idle"})
                continue

            if action != "run":
                await websocket.send_json(
                    {"type": "failed", "message": f"Unknown action '{action}'."}
                )
                continue

            if task is not None and not task.done():
                await websocket.send_json(
                    {"type": "failed", "message": "A task is already running."}
                )
                continue

            try:
                context = WorkspaceContext.model_validate(message.get("workspace", {}))
            except Exception as exc:
                await websocket.send_json(
                    {"type": "failed", "message": f"Invalid workspace: {exc}"}
                )
                continue

            history = message.get("messages", [])
            if not isinstance(history, list) or not history:
                await websocket.send_json(
                    {"type": "failed", "message": "Describe the task first."}
                )
                continue

            request = {
                "op": "agent",
                "messages": [
                    {
                        "role": str(turn.get("role", "user")),
                        "content": str(turn.get("content", "")),
                    }
                    for turn in history[-MAX_HISTORY_TURNS:]
                    if isinstance(turn, dict)
                ],
                "workspace": context.payload(),
                "mode": message.get("mode", "auto"),
                "effort": message.get("effort", "high"),
                "max_steps": int(message.get("max_steps", 24)),
            }

            try:
                session = await assistant.start_agent(request)
            except assistant.AssistantUnavailable as exc:
                await websocket.send_json({"type": "failed", "message": str(exc)})
                continue

            task = asyncio.create_task(pump(session))

    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover - defensive
        logger.exception("Agent socket handler failed")
    finally:
        # A closed tab must not leave an agent editing files forever.
        if session is not None:
            await session.cancel()
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(task, timeout=15.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                task.cancel()
        if websocket.client_state is WebSocketState.CONNECTED:
            await websocket.close()


@router.post("/api/v1/assistant/infill")
async def infill(payload: InfillRequest) -> dict:
    """Complete at the caret, using the code after it as well as before it.

    Served by the local model rather than the index engine: this is the one
    request that genuinely needs a language model, because it has to invent
    text rather than look one up.
    """
    if not payload.prefix and not payload.suffix:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "one of prefix or suffix must be non-empty"
        )

    try:
        result = await modelclient.infill(
            payload.prefix,
            payload.suffix,
            max_tokens=payload.max_tokens,
            temperature=payload.temperature,
            source=payload.source,
            candidates=payload.candidates,
        )
    except modelclient.ModelUnavailable as exc:
        # 503 rather than 500: the editor treats this as "no suggestion" and
        # carries on, which is the right behaviour when the model is simply not
        # running.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc

    return {
        "completion": result.completion,
        "tokens": result.tokens,
        "model": result.model,
        "seconds": result.seconds,
        # True when a newer request from the same editor arrived first. The
        # completion is empty, and the editor should show nothing rather than
        # treating it as "the model had no suggestion".
        "superseded": result.superseded,
        # Mean log-probability under the model's own distribution. Reported
        # rather than acted on: measured on the checkpoint here it does not
        # separate a good completion from a bad one, so filtering on it would
        # be a threshold that does nothing.
        "confidence": result.confidence,
    }


class TokenizeRequest(BaseModel):
    """Text to measure against the model's tokenizer."""

    # Bounded well above a source file and well below anything that would make
    # the model server spend real time on it.
    text: str = Field(default="", max_length=1_000_000)


@router.post("/api/v1/assistant/tokenize")
async def tokenize(payload: TokenizeRequest) -> dict:
    """How many tokens a piece of text is, by the model's own tokenizer."""
    try:
        split = await modelclient.tokenize(payload.text)
    except modelclient.ModelUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc

    return {
        "tokens": split.tokens,
        "characters": split.characters,
        "context": split.context,
    }


@router.get("/api/v1/assistant/model")
async def model_health() -> dict:
    """Whether the local model is running, and what it is."""
    try:
        return {"available": True, **await modelclient.health()}
    except modelclient.ModelUnavailable as exc:
        return {"available": False, "reason": str(exc)}
