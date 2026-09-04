"""Assistant surface: chat over WebSocket, completions and symbols over REST."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketState

from .. import assistant
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
