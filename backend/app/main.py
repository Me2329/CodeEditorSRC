"""CodeCraft Studio orchestration gateway.

Wires the REST and WebSocket surfaces onto the execution service, the rate
limiter and the runtime catalogue, and reports on startup exactly which
isolation tier this node will enforce.
"""

from __future__ import annotations

import logging
import subprocess
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api.assistant_routes import router as assistant_router
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


def mount_frontend(app: FastAPI) -> None:
    """Serve the built bundle, when one was built.

    The container carries a bundle and had nowhere to serve it from: the image
    copied `frontend/dist` in, the compose file said the gateway served it, and
    the gateway had no static mount at all, so `/` answered 404. Anyone
    following the documented `docker compose up` got a running API and a blank
    page, which is how the project describes itself working.

    Mounted last, after the routers, so the API keeps every path it claims and
    the bundle only sees what is left. Conditional on the directory existing,
    because a development machine runs Vite on its own port and has no `dist`
    to serve — and mounting a missing directory raises at import.
    """
    directory = settings.frontend_dist
    if not directory.is_dir() or not (directory / "index.html").is_file():
        return

    index = directory / "index.html"

    # Anything under /assets is a hashed build artefact and can be cached hard;
    # index.html cannot, or a deploy leaves browsers on the previous bundle.
    app.mount(
        "/assets",
        StaticFiles(directory=directory / "assets", check_dir=False),
        name="assets",
    )

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        """Every other path is the application, which routes itself.

        A file that exists is served; anything else gets index.html, because
        the router in the page owns those paths and a reload on one of them
        must not 404.

        Except under the API, where a path nobody registered is a mistake and
        has to say so. A catch-all that answers every URL turns a typo in an
        endpoint into a page of HTML and a parse error somewhere else entirely.
        """
        # Every route this gateway serves, websockets included, lives under
        # /api/, so that one prefix is the whole of the API surface.
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail=f"no such endpoint: /{path}")
        candidate = (directory / path).resolve()
        # Resolved and checked against the root, so `..` in a request cannot
        # reach a file outside the bundle.
        if path and candidate.is_file() and candidate.is_relative_to(directory.resolve()):
            return FileResponse(candidate)
        return FileResponse(index)


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
    app.include_router(assistant_router)
    mount_frontend(app)
    return app


app = create_app()
