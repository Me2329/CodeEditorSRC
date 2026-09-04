"""REST surface: runtime catalogue, templates, static analysis and health."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request, status

from .. import analyzer
from ..config import settings
from ..executor import ExecutionError
from ..runtimes import registry
from ..schemas import (
    AnalyzeRequest,
    ExecutionRequest,
    HealthResponse,
    RuntimeInfo,
    TemplateResponse,
)

router = APIRouter(prefix="/api/v1", tags=["codecraft"])

VERSION = "2.5.0"


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    """Report what this node can actually do right now."""
    service = request.app.state.executions
    limiter = request.app.state.rate_limiter

    supervisor_health = await service.supervisor.health()
    catalogue = registry().all()

    return HealthResponse(
        status="ok",
        version=VERSION,
        isolation_tier=request.app.state.isolation_tier,
        supervisor=(
            f"connected ({supervisor_health.get('active_jobs', 0)}"
            f"/{supervisor_health.get('capacity', 0)} jobs)"
            if supervisor_health
            else "not running (using the in-process runner)"
        ),
        rate_limiter=limiter.backend,
        analyzer=analyzer.available(),
        runtimes_total=len(catalogue),
        runtimes_installed=sum(1 for r in catalogue if r.installed),
    )


@router.get("/runtimes", response_model=list[RuntimeInfo])
async def list_runtimes() -> list[RuntimeInfo]:
    """The runtime catalogue, with per-host availability."""
    return [
        RuntimeInfo(
            id=runtime.id,
            label=runtime.label,
            category=runtime.category,
            monaco=runtime.monaco,
            extension=runtime.extension,
            entry=runtime.entry,
            installed=runtime.installed,
            executable=runtime.executable,
            notes=runtime.notes,
            toolchain=runtime.resolved_toolchain,
        )
        for runtime in registry().all()
    ]


@router.get("/runtimes/{language}/template", response_model=TemplateResponse)
async def runtime_template(language: str) -> TemplateResponse:
    runtime = registry().get(language)
    if runtime is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown runtime '{language}'.")
    return TemplateResponse(language=runtime.id, entry=runtime.entry, template=runtime.template)


@router.post("/analyze")
async def analyze_source(payload: AnalyzeRequest) -> dict:
    """Parse source into a scope tree with metrics and diagnostics."""
    try:
        return await analyzer.analyze(payload.source, payload.language)
    except analyzer.AnalyzerUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc


@router.post("/execute")
async def execute_once(payload: ExecutionRequest, request: Request) -> dict:
    """Run a workspace and return the whole result in one response.

    The WebSocket endpoint is the interactive path; this exists for scripting and
    for clients that cannot hold a socket open.
    """
    runtime = registry().get(payload.language)
    if runtime is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown runtime '{payload.language}'.")
    if not runtime.executable:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{runtime.label} is rendered in the browser and has no server execution path.",
        )
    if not runtime.installed:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"The toolchain for {runtime.label} is not installed on this node.",
        )

    client_key = request.client.host if request.client else "unknown"
    verdict = await request.app.state.rate_limiter.check(client_key)
    if not verdict.allowed:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Rate limit exceeded. Retry in {verdict.retry_after}s.",
            headers={"Retry-After": str(verdict.retry_after)},
        )

    chunks: list[dict] = []

    async def collect(frame: dict) -> None:
        chunks.append(frame)

    cancel = asyncio.Event()
    try:
        result = await request.app.state.executions.run(payload, collect, cancel)
    except ExecutionError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    return {
        "language": payload.language,
        "exit_code": result.exit_code,
        "execution_time": result.duration_ms,
        "truncated": result.truncated,
        "stdout": "".join(c["content"] for c in chunks if c["type"] == "stdout"),
        "stderr": "".join(c["content"] for c in chunks if c["type"] == "stderr"),
        "meta": result.meta,
    }
