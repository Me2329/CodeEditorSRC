"""Request and response models for the gateway's public surface."""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from .config import settings

# Mirrors the supervisor's own ceilings. Values above these are rejected rather
# than silently clamped, so a caller always knows what it got.
MAX_WALL_SECONDS = 120
MAX_CPU_SECONDS = 60
MAX_MEMORY_MB = 2048
MAX_PROCS = 512


def validate_workspace_path(name: str) -> str:
    """Reject anything that is not a plain relative path inside the workspace.

    The supervisor performs the same check; doing it here too means a hostile
    filename is refused at the edge with a readable error instead of reaching
    the execution layer at all.
    """
    if not name or not name.strip():
        raise ValueError("file name must not be empty")
    if len(name) > 255:
        raise ValueError("file name must be 255 characters or fewer")
    if name.startswith(("/", "~")):
        raise ValueError("file name must be relative to the workspace")
    if "\\" in name:
        raise ValueError("file name must not contain a backslash")
    if any(ch in name for ch in ("\0", "\n", "\r")):
        raise ValueError("file name must not contain control characters")
    for component in name.split("/"):
        if not component:
            raise ValueError("file name must not contain an empty path component")
        if component in (".", ".."):
            raise ValueError("file name must not escape the workspace")
    return name


class SourceFile(BaseModel):
    name: str
    content: str = ""

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        return validate_workspace_path(value)


class ExecutionLimits(BaseModel):
    wall_seconds: int = Field(default=settings.default_wall_seconds, ge=1, le=MAX_WALL_SECONDS)
    cpu_seconds: int = Field(default=settings.default_cpu_seconds, ge=1, le=MAX_CPU_SECONDS)
    memory_mb: int = Field(default=settings.default_memory_mb, ge=16, le=MAX_MEMORY_MB)
    max_procs: int = Field(default=settings.default_max_procs, ge=1, le=MAX_PROCS)
    allow_net: bool = Field(default=False)


class ExecutionRequest(BaseModel):
    language: str
    files: list[SourceFile] = Field(default_factory=list, max_length=settings.max_files)
    entry: str | None = None
    stdin: str = ""
    limits: ExecutionLimits = Field(default_factory=ExecutionLimits)

    @field_validator("language")
    @classmethod
    def _check_language(cls, value: str) -> str:
        if not value or not all(c.isalnum() or c in "_-" for c in value):
            raise ValueError("language must be an alphanumeric runtime id")
        return value

    @field_validator("entry")
    @classmethod
    def _check_entry(cls, value: str | None) -> str | None:
        return None if value is None else validate_workspace_path(value)

    @field_validator("files")
    @classmethod
    def _check_total_size(cls, value: list[SourceFile]) -> list[SourceFile]:
        if not value:
            raise ValueError("at least one source file is required")
        total = sum(len(f.content.encode("utf-8")) for f in value)
        if total > settings.max_source_bytes:
            raise ValueError(f"workspace exceeds the {settings.max_source_bytes} byte source limit")
        names = [f.name for f in value]
        if len(names) != len(set(names)):
            raise ValueError("file names must be unique")
        return value


class RuntimeInfo(BaseModel):
    id: str
    label: str
    category: str
    monaco: str
    extension: str
    entry: str
    installed: bool
    executable: bool
    notes: str = ""
    # The toolchain binary this host would actually use, e.g. "lua5.4" where the
    # preferred "luajit" is absent. None when nothing suitable is installed.
    toolchain: str | None = None


class TemplateResponse(BaseModel):
    language: str
    entry: str
    template: str


class AnalyzeRequest(BaseModel):
    language: str
    source: str

    @field_validator("source")
    @classmethod
    def _check_size(cls, value: str) -> str:
        if len(value.encode("utf-8")) > settings.max_source_bytes:
            raise ValueError("source exceeds the analysis size limit")
        return value


class HealthResponse(BaseModel):
    status: str
    version: str
    isolation_tier: str
    supervisor: str
    rate_limiter: str
    analyzer: bool
    runtimes_total: int
    runtimes_installed: int
    assistant: str
    assistant_model: str = ""
