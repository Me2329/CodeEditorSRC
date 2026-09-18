"""Execution service behaviour: aborts, truncation and the supervisor path."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from app.config import settings
from app.executor import DirectExecutor, ExecutionService, SupervisorExecutor
from app.schemas import ExecutionRequest, ExecutionLimits, SourceFile
from tests.conftest import installed

pytestmark = pytest.mark.skipif(
    not installed("python"), reason="python3 toolchain is not installed"
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SUPERVISOR_BINARY = REPO_ROOT / "core" / "supervisor" / "target" / "release" / "codecraft-supervisor"


def request_for(source: str, **limits) -> ExecutionRequest:
    return ExecutionRequest(
        language="python",
        files=[SourceFile(name="main.py", content=source)],
        limits=ExecutionLimits(**limits),
    )


async def collect(executor, request, cancel=None):
    frames: list[dict] = []

    async def emit(frame: dict) -> None:
        frames.append(frame)

    result = await executor.execute(request, emit, cancel or asyncio.Event())
    return result, frames


async def test_direct_executor_streams_output() -> None:
    result, frames = await collect(DirectExecutor(), request_for("print('direct backend')"))

    assert result.exit_code == 0
    assert "direct backend" in "".join(f["content"] for f in frames if f["type"] == "stdout")
    assert result.meta["isolation"]["tier"] in {"nsjail", "userns", "rlimit"}


async def test_abort_stops_a_running_job_promptly() -> None:
    """A client that hits Abort must not wait out the program's own deadline."""
    cancel = asyncio.Event()
    request = request_for(
        "import time\nprint('working', flush=True)\ntime.sleep(60)\n", wall_seconds=60
    )

    async def trigger() -> None:
        await asyncio.sleep(1.5)
        cancel.set()

    started = time.monotonic()
    _, task = await asyncio.gather(
        collect(DirectExecutor(), request, cancel),
        trigger(),
    )
    elapsed = time.monotonic() - started

    assert elapsed < 15, f"abort took {elapsed:.1f}s; the job outlived the cancel signal"


async def test_output_is_truncated_at_the_ceiling(monkeypatch) -> None:
    """A runaway printer is cut off instead of exhausting gateway memory."""
    import dataclasses

    import app.executor as executor_module

    monkeypatch.setattr(
        executor_module,
        "settings",
        dataclasses.replace(settings, max_output_bytes=32 * 1024),
    )

    source = "for _ in range(200000):\n    print('x' * 200)\n"
    result, frames = await collect(DirectExecutor(), request_for(source, wall_seconds=30))

    emitted = sum(len(f["content"].encode()) for f in frames if f["type"] == "stdout")
    assert result.truncated is True
    assert emitted <= 64 * 1024, f"emitted {emitted} bytes past a 32 KiB ceiling"


async def test_multibyte_characters_survive_chunk_boundaries() -> None:
    """A UTF-8 sequence split across two pipe reads must not become garbage."""
    source = "print('你好世界 ' * 5000)"
    _, frames = await collect(DirectExecutor(), request_for(source, wall_seconds=30))

    text = "".join(f["content"] for f in frames if f["type"] == "stdout")
    assert "�" not in text, "output contains a Unicode replacement character"
    assert text.count("你好世界") == 5000


async def test_concurrency_is_capped(monkeypatch) -> None:
    service = ExecutionService()
    monkeypatch.setattr(service, "_semaphore", asyncio.Semaphore(2), raising=False)

    peak = 0
    current = 0
    lock = asyncio.Lock()

    original = DirectExecutor.execute

    async def tracked(self, request, emit, cancel):
        nonlocal peak, current
        async with lock:
            current += 1
            peak = max(peak, current)
        try:
            return await original(self, request, emit, cancel)
        finally:
            async with lock:
                current -= 1

    monkeypatch.setattr(DirectExecutor, "execute", tracked)

    async def noop_emit(_frame: dict) -> None:
        return None

    await asyncio.gather(
        *(
            service.run(request_for("print(1)"), noop_emit, asyncio.Event())
            for _ in range(6)
        )
    )

    assert peak <= 2, f"ran {peak} jobs concurrently against a cap of 2"


@pytest.mark.skipif(not SUPERVISOR_BINARY.is_file(), reason="supervisor binary is not built")
async def test_supervisor_backend_executes_a_job(tmp_path) -> None:
    """The production path produces the same result as the development path."""
    # Workspaces are kept out of /tmp: the sandbox replaces /tmp with its own
    # tmpfs, which would shadow a workspace mounted underneath it.
    workspace_root = Path("/var/tmp/codecraft/pytest") / tmp_path.name
    workspace_root.mkdir(parents=True, exist_ok=True)
    socket_path = tmp_path / "supervisor.sock"
    process = subprocess.Popen(
        [
            str(SUPERVISOR_BINARY),
            "--socket", str(socket_path),
            "--runner", str(settings.runner_path),
            "--workspace-root", str(workspace_root),
            "--max-jobs", "2",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(50):
            if socket_path.exists():
                break
            await asyncio.sleep(0.1)
        assert socket_path.exists(), "supervisor did not create its socket"

        executor = SupervisorExecutor()
        executor._socket = socket_path  # noqa: SLF001 - test seam

        assert executor.available() is True
        health = await executor.health()
        assert health is not None and health["capacity"] == 2

        result, frames = await collect(executor, request_for("print('supervisor backend')"))

        assert result.exit_code == 0
        output = "".join(f["content"] for f in frames if f["type"] == "stdout")
        assert "supervisor backend" in output
        assert result.meta["isolation"]["tier"] in {"nsjail", "userns", "rlimit"}
    finally:
        process.terminate()
        process.wait(timeout=10)
        shutil.rmtree(workspace_root, ignore_errors=True)


async def test_service_prefers_the_supervisor_when_its_socket_exists(monkeypatch, tmp_path) -> None:
    service = ExecutionService()
    assert service.select().name == "direct"

    socket_path = tmp_path / "present.sock"
    socket_path.touch()
    monkeypatch.setattr(service._supervisor, "_socket", socket_path, raising=False)

    assert service.select().name == "supervisor"
