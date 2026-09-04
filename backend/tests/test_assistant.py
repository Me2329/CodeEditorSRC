"""Assistant surface tests, run against the real daemon when it is available."""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import pytest

from app import assistant
from app.config import settings

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSISTANT_BINARY = REPO_ROOT / "core" / "assistant" / "target" / "release" / "codecraft-assistant"

WORKSPACE = {
    "language": "rust",
    "files": [
        {
            "name": "main.rs",
            "content": (
                "pub struct Connection { addr: String }\n\n"
                "pub fn connect(addr: &str) -> Connection {\n"
                "    Connection { addr: addr.to_string() }\n"
                "}\n\n"
                "fn main() { let c = connect(\"x\"); println!(\"{}\", c.addr); }\n"
            ),
        }
    ],
    "active_file": "main.rs",
}


@pytest.fixture(scope="module")
def daemon(tmp_path_factory):
    """Start a real assistant daemon on a private socket."""
    if not ASSISTANT_BINARY.is_file():
        pytest.skip("assistant binary is not built")

    socket_path = tmp_path_factory.mktemp("assistant") / "assistant.sock"
    process = subprocess.Popen(
        [str(ASSISTANT_BINARY), "--socket", str(socket_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        if socket_path.exists():
            break
        time.sleep(0.1)
    if not socket_path.exists():
        process.terminate()
        pytest.skip("assistant daemon did not start")

    original = settings.assistant_socket
    object.__setattr__(settings, "assistant_socket", socket_path)
    try:
        yield socket_path
    finally:
        object.__setattr__(settings, "assistant_socket", original)
        process.terminate()
        process.wait(timeout=10)


async def test_health_reports_the_configured_model(daemon) -> None:
    health = await assistant.health()
    assert health is not None
    assert health["model"]
    # Whether a credential exists depends on the host; the field must be present.
    assert "remote_available" in health


async def test_completions_rank_workspace_symbols_first(daemon) -> None:
    frames = await assistant.collect(
        {"op": "complete", "workspace": WORKSPACE, "prefix": "conn", "limit": 10}
    )
    items = next(f["items"] for f in frames if f["type"] == "completions")

    labels = [item["label"] for item in items]
    assert "connect" in labels
    assert "Connection" in labels
    # A declared symbol must outrank a plain identifier or keyword.
    assert items[0]["kind"] in {"function", "struct"}


async def test_symbols_lists_every_declaration(daemon) -> None:
    frames = await assistant.collect({"op": "symbols", "workspace": WORKSPACE})
    items = next(f["items"] for f in frames if f["type"] == "symbols")

    by_name = {item["name"]: item for item in items}
    assert by_name["Connection"]["kind"] == "struct"
    assert by_name["connect"]["kind"] == "function"
    assert by_name["connect"]["line"] == 3


async def test_a_lookup_question_is_answered_locally(daemon) -> None:
    frames = await assistant.collect(
        {
            "op": "chat",
            "messages": [{"role": "user", "content": "where is connect"}],
            "workspace": WORKSPACE,
            "route": "auto",
        }
    )
    routed = next(f for f in frames if f["type"] == "routed")
    assert routed["engine"] == "local"

    answer = "".join(f["text"] for f in frames if f["type"] == "delta")
    assert "main.rs" in answer
    assert "line 3" in answer


async def test_an_open_ended_question_is_not_answered_locally(daemon) -> None:
    """Without a credential this must fail honestly rather than invent an answer."""
    frames = await assistant.collect(
        {
            "op": "chat",
            "messages": [
                {"role": "user", "content": "rewrite this to use a connection pool"}
            ],
            "workspace": WORKSPACE,
            "route": "auto",
        },
        timeout=30.0,
    )

    kinds = {frame["type"] for frame in frames}
    if "error" in kinds:
        message = next(f["message"] for f in frames if f["type"] == "error")
        assert "credential" in message.lower() or "claude" in message.lower()
    else:
        routed = next(f for f in frames if f["type"] == "routed")
        assert routed["engine"] == "model"


async def test_local_route_refuses_rather_than_guessing(daemon) -> None:
    frames = await assistant.collect(
        {
            "op": "chat",
            "messages": [{"role": "user", "content": "why does this deadlock?"}],
            "workspace": WORKSPACE,
            "route": "local",
        }
    )
    error = next(f for f in frames if f["type"] == "error")
    assert "local engine" in error["message"]


async def test_completions_are_fast_enough_to_type_against(daemon) -> None:
    """The local path must stay well under a keystroke interval."""
    import statistics

    timings = []
    for _ in range(20):
        start = time.perf_counter()
        await assistant.collect(
            {"op": "complete", "workspace": WORKSPACE, "prefix": "co", "limit": 10}
        )
        timings.append((time.perf_counter() - start) * 1000)

    median = statistics.median(timings)
    assert median < 20, f"local completion median was {median:.1f}ms"


def test_gateway_reports_the_assistant_in_health(client) -> None:
    payload = client.get("/api/v1/health").json()
    assert "assistant" in payload


def test_completion_endpoint_reports_a_missing_daemon_clearly(client, tmp_path) -> None:
    """With no daemon the endpoint must say so, not return empty results.

    Points the setting at a socket that certainly does not exist rather than
    depending on whether one happens to be running on this machine.
    """
    original = settings.assistant_socket
    object.__setattr__(settings, "assistant_socket", tmp_path / "absent.sock")
    try:
        response = client.post(
            "/api/v1/assistant/complete",
            json={"workspace": WORKSPACE, "prefix": "co"},
        )
    finally:
        object.__setattr__(settings, "assistant_socket", original)

    assert response.status_code == 503
    assert "not running" in response.json()["detail"]
