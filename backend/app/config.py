"""Gateway configuration.

Every setting is environment-driven so the same image runs unchanged in
development and production. Defaults describe a single-node development box:
no Redis, no supervisor daemon, sandboxing still fully enforced.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(name: str, default: list[str]) -> list[str]:
    raw = os.getenv(name)
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


def _repository_root() -> Path:
    # backend/app/config.py -> backend/app -> backend -> repository root
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    """Immutable runtime settings resolved once at import time."""

    # --- paths -------------------------------------------------------------
    repo_root: Path = field(default_factory=_repository_root)
    runtimes_path: Path = field(default_factory=lambda: _repository_root() / "scripts" / "runtimes.json")
    runner_path: Path = field(default_factory=lambda: _repository_root() / "scripts" / "sandbox_runner.sh")
    analyzer_path: Path = field(
        default_factory=lambda: Path(
            os.getenv(
                "CODECRAFT_ANALYZER",
                str(_repository_root() / "core" / "analyzer" / "build" / "codecraft-analyzer"),
            )
        )
    )

    # --- execution ---------------------------------------------------------
    # When the supervisor socket exists the gateway delegates to it. Otherwise it
    # invokes the sandbox runner directly, which is the single-process
    # development path and applies exactly the same isolation.
    supervisor_socket: Path = field(
        default_factory=lambda: Path(os.getenv("CODECRAFT_SOCKET", "/run/codecraft/supervisor.sock"))
    )
    max_concurrent_executions: int = field(default_factory=lambda: _env_int("CODECRAFT_MAX_JOBS", 8))

    # --- limits ------------------------------------------------------------
    default_wall_seconds: int = field(default_factory=lambda: _env_int("CODECRAFT_WALL_SECONDS", 10))
    default_cpu_seconds: int = field(default_factory=lambda: _env_int("CODECRAFT_CPU_SECONDS", 5))
    default_memory_mb: int = field(default_factory=lambda: _env_int("CODECRAFT_MEMORY_MB", 256))
    default_max_procs: int = field(default_factory=lambda: _env_int("CODECRAFT_MAX_PROCS", 64))
    max_source_bytes: int = field(default_factory=lambda: _env_int("CODECRAFT_MAX_SOURCE_BYTES", 4 * 1024 * 1024))
    max_files: int = field(default_factory=lambda: _env_int("CODECRAFT_MAX_FILES", 64))
    max_output_bytes: int = field(default_factory=lambda: _env_int("CODECRAFT_MAX_OUTPUT_BYTES", 2 * 1024 * 1024))

    # --- rate limiting -----------------------------------------------------
    redis_url: str = field(default_factory=lambda: os.getenv("CODECRAFT_REDIS_URL", "redis://localhost:6379/0"))
    rate_limit_requests: int = field(default_factory=lambda: _env_int("CODECRAFT_RATE_LIMIT", 40))
    rate_limit_window_seconds: int = field(default_factory=lambda: _env_int("CODECRAFT_RATE_WINDOW", 60))

    # --- http --------------------------------------------------------------
    # Defaults cover the Vite dev server. Production deployments must set an
    # explicit origin list; "*" is never combined with credentials.
    cors_origins: list[str] = field(
        default_factory=lambda: _env_list(
            "CODECRAFT_CORS_ORIGINS",
            ["http://localhost:5173", "http://127.0.0.1:5173"],
        )
    )
    allow_network_in_sandbox: bool = field(
        default_factory=lambda: _env_bool("CODECRAFT_ALLOW_SANDBOX_NETWORK", False)
    )


settings = Settings()
