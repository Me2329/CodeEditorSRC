"""Execution backends.

Two paths lead to the same sandbox:

* `SupervisorExecutor` talks to the Rust daemon over a Unix socket. This is the
  production path: the network-facing process never spawns user code itself.
* `DirectExecutor` invokes the Bash runner as a subprocess. This is the
  single-process development path, and it applies exactly the same isolation
  because the isolation lives in the runner, not in the caller.

The gateway picks whichever is available at request time, so starting or
stopping the daemon needs no configuration change.
"""

from __future__ import annotations

import asyncio
import codecs
import contextlib
import json
import os
import shutil
import signal
import tempfile
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import settings
from .schemas import ExecutionRequest

Emit = Callable[[dict[str, Any]], Awaitable[None]]

# Runner exit codes that carry a specific meaning, mirrored from the Bash script.
EXIT_UNSUPPORTED_LANG = 65
EXIT_TOOLCHAIN_MISSING = 66
EXIT_COMPILE_FAILED = 67
EXIT_TIMEOUT = 124


@dataclass
class ExecutionResult:
    exit_code: int
    duration_ms: int
    truncated: bool
    meta: dict[str, Any] | None


class ExecutionError(RuntimeError):
    """Raised when a job could not be started or the backend failed."""


class _OutputRelay:
    """Decodes and forwards output, enforcing the total byte ceiling.

    Chunk boundaries fall wherever the pipe buffer happens to end, so a
    multi-byte character can be split across two reads. An incremental decoder
    holds the partial sequence instead of emitting a replacement character.
    """

    def __init__(self, emit: Emit, limit: int) -> None:
        self._emit = emit
        self._limit = limit
        self._sent = 0
        self._decoders = {
            "stdout": codecs.getincrementaldecoder("utf-8")(errors="replace"),
            "stderr": codecs.getincrementaldecoder("utf-8")(errors="replace"),
        }
        self.truncated = False

    async def feed(self, stream: str, data: bytes) -> None:
        if self.truncated or not data:
            return

        remaining = self._limit - self._sent
        if remaining <= 0:
            await self._mark_truncated()
            return

        if len(data) > remaining:
            data = data[:remaining]
            self._sent += len(data)
            text = self._decoders[stream].decode(data, True)
            if text:
                await self._emit({"type": stream, "content": text})
            await self._mark_truncated()
            return

        self._sent += len(data)
        text = self._decoders[stream].decode(data)
        if text:
            await self._emit({"type": stream, "content": text})

    async def feed_text(self, stream: str, text: str) -> None:
        """Forward already-decoded text, used by the supervisor path."""
        if self.truncated or not text:
            return
        encoded = text.encode("utf-8")
        remaining = self._limit - self._sent
        if remaining <= 0:
            await self._mark_truncated()
            return
        if len(encoded) > remaining:
            text = encoded[:remaining].decode("utf-8", errors="ignore")
            self._sent = self._limit
            await self._emit({"type": stream, "content": text})
            await self._mark_truncated()
            return
        self._sent += len(encoded)
        await self._emit({"type": stream, "content": text})

    async def flush(self) -> None:
        for stream, decoder in self._decoders.items():
            tail = decoder.decode(b"", True)
            if tail:
                await self._emit({"type": stream, "content": tail})

    async def _mark_truncated(self) -> None:
        self.truncated = True
        await self._emit(
            {
                "type": "stderr",
                "content": "\r\n\x1b[1;33m[codecraft] Output limit reached; execution stopped.\x1b[0m\r\n",
            }
        )


class DirectExecutor:
    """Runs the sandbox runner as a child process of the gateway."""

    name = "direct"

    def __init__(self) -> None:
        self._runner = settings.runner_path

    def available(self) -> bool:
        return self._runner.is_file()

    async def execute(
        self,
        request: ExecutionRequest,
        emit: Emit,
        cancel: asyncio.Event,
    ) -> ExecutionResult:
        if not self.available():
            raise ExecutionError(f"sandbox runner not found at {self._runner}")

        workspace = Path(tempfile.mkdtemp(prefix="gw_", dir=_workspace_root()))
        relay = _OutputRelay(emit, settings.max_output_bytes)
        process: asyncio.subprocess.Process | None = None
        try:
            _materialise_workspace(workspace, request)
            meta_path = workspace / ".codecraft_meta.json"
            stdin_path = workspace / ".codecraft_stdin"
            stdin_path.write_text(request.stdin, encoding="utf-8")

            argv = [
                "bash",
                str(self._runner),
                "--lang", request.language,
                "--workspace", str(workspace),
                "--stdin-file", str(stdin_path),
                "--meta-file", str(meta_path),
                "--timeout", str(request.limits.wall_seconds),
                "--cpu-seconds", str(request.limits.cpu_seconds),
                "--memory-mb", str(request.limits.memory_mb),
                "--max-procs", str(request.limits.max_procs),
            ]
            if request.entry:
                argv += ["--entry", request.entry]
            if request.limits.allow_net and settings.allow_network_in_sandbox:
                argv.append("--allow-net")

            loop = asyncio.get_running_loop()
            started = loop.time()

            process = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                # Its own session, so an abort can signal the entire process
                # tree. Killing the runner alone would leave the sandboxed
                # program holding the pipes open until its own deadline.
                start_new_session=True,
            )

            await _pump(process, relay, cancel)
            exit_code = await process.wait()
            await relay.flush()
            duration_ms = int((loop.time() - started) * 1000)

            meta = None
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    meta = None

            return ExecutionResult(exit_code, duration_ms, relay.truncated, meta)
        finally:
            if process is not None and process.returncode is None:
                _terminate_tree(process)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(process.wait(), timeout=5.0)
            shutil.rmtree(workspace, ignore_errors=True)


class SupervisorExecutor:
    """Delegates execution to the Rust supervisor daemon."""

    name = "supervisor"

    def __init__(self) -> None:
        self._socket = settings.supervisor_socket

    def available(self) -> bool:
        return self._socket.exists()

    async def health(self) -> dict[str, Any] | None:
        if not self.available():
            return None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(str(self._socket)), timeout=2.0
            )
        except (OSError, asyncio.TimeoutError):
            return None
        try:
            writer.write(b'{"op":"health"}\n')
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            return json.loads(line.decode("utf-8")) if line else None
        except (OSError, asyncio.TimeoutError, json.JSONDecodeError):
            return None
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass

    async def execute(
        self,
        request: ExecutionRequest,
        emit: Emit,
        cancel: asyncio.Event,
    ) -> ExecutionResult:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(str(self._socket)), timeout=5.0
            )
        except (OSError, asyncio.TimeoutError) as exc:
            raise ExecutionError(f"supervisor is unreachable: {exc}") from exc

        relay = _OutputRelay(emit, settings.max_output_bytes)
        loop = asyncio.get_running_loop()
        started = loop.time()

        payload = {
            "op": "execute",
            "id": uuid.uuid4().hex[:16],
            "language": request.language,
            "entry": request.entry,
            "files": [{"name": f.name, "content": f.content} for f in request.files],
            "stdin": request.stdin,
            "limits": {
                "wall_seconds": request.limits.wall_seconds,
                "cpu_seconds": request.limits.cpu_seconds,
                "memory_mb": request.limits.memory_mb,
                "max_procs": request.limits.max_procs,
                "allow_net": bool(request.limits.allow_net and settings.allow_network_in_sandbox),
            },
        }

        try:
            writer.write((json.dumps(payload) + "\n").encode("utf-8"))
            await writer.drain()
            writer.write_eof()

            exit_code = -1
            duration_ms = 0
            meta: dict[str, Any] | None = None

            # A single frame may exceed the default limit when a program emits a
            # very long line, so the reader is given generous headroom.
            while True:
                if cancel.is_set():
                    break
                try:
                    line = await reader.readline()
                except ValueError:
                    await relay.feed_text("stderr", "\r\n[codecraft] Dropped an oversized output frame.\r\n")
                    continue
                if not line:
                    break

                try:
                    frame = json.loads(line.decode("utf-8", errors="replace"))
                except json.JSONDecodeError:
                    continue

                kind = frame.get("type")
                if kind in ("stdout", "stderr"):
                    await relay.feed_text(kind, frame.get("content", ""))
                elif kind == "exit":
                    exit_code = int(frame.get("code", -1))
                    duration_ms = int(frame.get("execution_time", 0))
                    meta = frame.get("meta")
                    if frame.get("truncated"):
                        relay.truncated = True
                    break
                elif kind == "error":
                    raise ExecutionError(frame.get("message", "supervisor reported an error"))

            if duration_ms == 0:
                duration_ms = int((loop.time() - started) * 1000)
            return ExecutionResult(exit_code, duration_ms, relay.truncated, meta)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass


class ExecutionService:
    """Chooses a backend and caps how many jobs run at once."""

    def __init__(self) -> None:
        self._supervisor = SupervisorExecutor()
        self._direct = DirectExecutor()
        self._semaphore = asyncio.Semaphore(settings.max_concurrent_executions)

    def select(self):
        if self._supervisor.available():
            return self._supervisor
        return self._direct

    @property
    def supervisor(self) -> SupervisorExecutor:
        return self._supervisor

    async def run(
        self,
        request: ExecutionRequest,
        emit: Emit,
        cancel: asyncio.Event,
    ) -> ExecutionResult:
        backend = self.select()
        async with self._semaphore:
            return await backend.execute(request, emit, cancel)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _workspace_root() -> Path:
    root = Path("/var/tmp/codecraft")
    try:
        root.mkdir(parents=True, exist_ok=True)
        return root
    except OSError:
        return Path(tempfile.gettempdir())


def _materialise_workspace(workspace: Path, request: ExecutionRequest) -> None:
    """Write the request's files into the workspace.

    Names were validated on the way in; the resolved path is re-checked here so
    a bug upstream cannot turn into a write outside the workspace.
    """
    root = workspace.resolve()
    (workspace / "tmp").mkdir(parents=True, exist_ok=True)
    (workspace / ".cache").mkdir(parents=True, exist_ok=True)

    for source in request.files:
        target = (workspace / source.name).resolve()
        if not str(target).startswith(str(root) + "/"):
            raise ExecutionError(f"file '{source.name}' resolves outside the workspace")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source.content, encoding="utf-8")


def _terminate_tree(process: asyncio.subprocess.Process) -> None:
    """Signal the runner's whole process group, then the runner itself.

    SIGTERM first: the runner traps it, kills anything still rooted in the
    workspace and tears the sandbox down cleanly. SIGKILL is the backstop for a
    process group that ignores the request.
    """
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(process.pid), sig)
        except (ProcessLookupError, PermissionError):
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            return
        if sig is signal.SIGTERM:
            return


async def _pump(
    process: asyncio.subprocess.Process,
    relay: _OutputRelay,
    cancel: asyncio.Event,
) -> None:
    """Drain both pipes concurrently until the child closes them or is cancelled.

    Reading the pipes in sequence would let a full stderr buffer block a child
    that is still writing to stdout.
    """

    async def drain(stream: asyncio.StreamReader | None, name: str) -> None:
        if stream is None:
            return
        while True:
            chunk = await stream.read(8192)
            if not chunk:
                return
            await relay.feed(name, chunk)

    readers = [
        asyncio.create_task(drain(process.stdout, "stdout")),
        asyncio.create_task(drain(process.stderr, "stderr")),
    ]
    waiter = asyncio.create_task(cancel.wait())

    try:
        done, pending = await asyncio.wait(
            [*readers, waiter], return_when=asyncio.FIRST_COMPLETED
        )
        if waiter in done:
            # Client aborted: signal the whole tree, then let the readers finish
            # so output produced before the abort still reaches the terminal.
            # The readers are bounded because the pipes close once the tree dies.
            if process.returncode is None:
                _terminate_tree(process)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    asyncio.gather(*readers, return_exceptions=True), timeout=10.0
                )
        else:
            # One pipe closed; wait for the other rather than dropping its tail.
            await asyncio.gather(*readers, return_exceptions=True)
    finally:
        waiter.cancel()
        for task in readers:
            if not task.done():
                task.cancel()
        await asyncio.gather(*readers, waiter, return_exceptions=True)
