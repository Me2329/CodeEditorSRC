"""CodeCraft Studio orchestration gateway.

Wires the REST and WebSocket surfaces onto the execution service, the rate
limiter and the runtime catalogue, and reports on startup exactly which
isolation tier this node will enforce.
"""

from __future__ import annotations

import logging
import subprocess
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import VERSION, router as rest_router
from .api.ws import router as ws_router
from .config import settings
from .executor import ExecutionService
from .ratelimit import create_rate_limiter
from .runtimes import registry

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
)
logger = logging.getLogger("codecraft.gateway")


def detect_isolation_tier() -> str:
    """Ask the runner's own detection logic which tier is active.

    Reporting the tier the sandbox will really use, rather than the one we hope
    for, is what makes the warning below trustworthy.
    """
    library = settings.repo_root / "scripts" / "lib" / "isolation.sh"
    if not library.is_file():
        return "unknown"
    try:
        result = subprocess.run(
            ["bash", "-c", f"source '{library}' && cc_detect_tier"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    tier = result.stdout.strip()
    return tier or "unknown"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.isolation_tier = detect_isolation_tier()
    app.state.rate_limiter = await create_rate_limiter()
    app.state.executions = ExecutionService()

    catalogue = registry().all()
    installed = sum(1 for runtime in catalogue if runtime.installed)
    backend = app.state.executions.select().name

    logger.info(
        "gateway %s ready | isolation %s | execution backend %s | rate limiter %s | "
        "%d/%d runtimes installed",
        VERSION,
        app.state.isolation_tier,
        backend,
        app.state.rate_limiter.backend,
        installed,
        len(catalogue),
    )
    if app.state.isolation_tier == "rlimit":
        logger.warning(
            "No kernel isolation is available on this host: code runs with resource limits "
            "and a deadline only. Suitable for local development, not for untrusted code."
        )

    try:
        yield
    finally:
        await app.state.rate_limiter.close()


def create_app() -> FastAPI:
    app = FastAPI(
        title="CodeCraft Studio Orchestration API",
        version=VERSION,
        description=(
            "Gateway for the CodeCraft Studio execution sandbox. Compiles and runs "
            "code in ephemeral, isolated workspaces and streams the output live."
        ),
        lifespan=lifespan,
    )

    # Credentialed requests and a wildcard origin cannot be combined; browsers
    # reject the pair. Configure explicit origins in production.
    allow_credentials = "*" not in settings.cors_origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=allow_credentials,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    app.include_router(rest_router)
    app.include_router(ws_router)
    return app


app = create_app()
