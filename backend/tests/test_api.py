"""End-to-end tests against the real gateway and the real sandbox."""

from __future__ import annotations

import json

import pytest

from tests.conftest import requires_python


def test_health_reports_node_capabilities(client) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200

    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["isolation_tier"] in {"nsjail", "userns", "rlimit", "unknown"}
    assert payload["rate_limiter"] in {"redis", "in-memory"}
    assert payload["runtimes_total"] >= 30
    assert payload["runtimes_installed"] >= 1


def test_runtime_catalogue_is_complete(client) -> None:
    response = client.get("/api/v1/runtimes")
    assert response.status_code == 200

    runtimes = response.json()
    assert len(runtimes) >= 30

    by_id = {r["id"]: r for r in runtimes}
    assert "python" in by_id
    assert by_id["python"]["monaco"] == "python"

    # HTML is rendered in the browser and must never be marked executable.
    assert by_id["html"]["executable"] is False

    categories = {r["category"] for r in runtimes}
    assert {"native", "interpreted", "managed", "web"} <= categories


def test_template_endpoint_returns_runnable_source(client) -> None:
    response = client.get("/api/v1/runtimes/rust/template")
    assert response.status_code == 200

    payload = response.json()
    assert payload["entry"] == "main.rs"
    assert "fn main" in payload["template"]


def test_unknown_runtime_template_is_a_404(client) -> None:
    assert client.get("/api/v1/runtimes/klingon/template").status_code == 404


@requires_python
def test_execute_returns_output_and_exit_code(client) -> None:
    response = client.post(
        "/api/v1/execute",
        json={
            "language": "python",
            "files": [{"name": "main.py", "content": "print('gateway path works')"}],
        },
    )
    assert response.status_code == 200

    payload = response.json()
    assert payload["exit_code"] == 0
    assert "gateway path works" in payload["stdout"]
    assert payload["meta"]["isolation"]["tier"] in {"nsjail", "userns", "rlimit"}


@requires_python
def test_execute_reports_a_failing_program_faithfully(client) -> None:
    response = client.post(
        "/api/v1/execute",
        json={
            "language": "python",
            "files": [{"name": "main.py", "content": "import sys\nsys.exit(3)"}],
        },
    )
    assert response.status_code == 200
    assert response.json()["exit_code"] == 3


@requires_python
def test_execute_enforces_the_wall_clock_deadline(client) -> None:
    response = client.post(
        "/api/v1/execute",
        json={
            "language": "python",
            "files": [{"name": "main.py", "content": "import time\ntime.sleep(60)"}],
            "limits": {"wall_seconds": 2},
        },
    )
    assert response.status_code == 200
    assert response.json()["exit_code"] == 124


def test_execute_rejects_an_unknown_runtime(client) -> None:
    response = client.post(
        "/api/v1/execute",
        json={"language": "klingon", "files": [{"name": "main.kl", "content": "x"}]},
    )
    assert response.status_code == 400


def test_execute_refuses_a_browser_only_runtime(client) -> None:
    response = client.post(
        "/api/v1/execute",
        json={"language": "html", "files": [{"name": "index.html", "content": "<p>hi</p>"}]},
    )
    assert response.status_code == 400
    assert "browser" in response.json()["detail"]


def test_execute_rejects_path_traversal(client) -> None:
    response = client.post(
        "/api/v1/execute",
        json={
            "language": "python",
            "files": [{"name": "../../../etc/cron.d/pwn", "content": "x"}],
        },
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# WebSocket surface
# ---------------------------------------------------------------------------


def _drain(socket, *, until: str = "exit") -> list[dict]:
    frames = []
    while True:
        frame = socket.receive_json()
        frames.append(frame)
        if frame["type"] in (until, "error"):
            return frames


@requires_python
def test_websocket_streams_output_then_exits(client) -> None:
    with client.websocket_connect("/api/v1/ws/execute") as socket:
        ready = socket.receive_json()
        assert ready["type"] == "ready"
        assert ready["backend"] in {"direct", "supervisor"}

        socket.send_json(
            {
                "action": "execute",
                "language": "python",
                "files": [{"name": "main.py", "content": "print('streamed')"}],
            }
        )
        frames = _drain(socket)

    kinds = [f["type"] for f in frames]
    assert kinds[0] == "accepted"
    assert "stdout" in kinds
    assert frames[-1]["type"] == "exit"
    assert frames[-1]["code"] == 0
    assert "".join(f["content"] for f in frames if f["type"] == "stdout").strip() == "streamed"


@requires_python
def test_websocket_supports_the_single_file_shape(client) -> None:
    """The documented {"language","code"} payload keeps working."""
    with client.websocket_connect("/api/v1/ws/execute") as socket:
        socket.receive_json()
        socket.send_json({"language": "python", "code": "print('legacy shape')"})
        frames = _drain(socket)

    assert frames[-1]["code"] == 0
    assert "legacy shape" in "".join(f.get("content", "") for f in frames)


@requires_python
def test_websocket_is_reusable_across_runs(client) -> None:
    with client.websocket_connect("/api/v1/ws/execute") as socket:
        socket.receive_json()
        for expected in ("first", "second"):
            socket.send_json(
                {
                    "language": "python",
                    "files": [{"name": "main.py", "content": f"print('{expected}')"}],
                }
            )
            frames = _drain(socket)
            assert frames[-1]["code"] == 0
            assert expected in "".join(f.get("content", "") for f in frames)


def test_websocket_rejects_malformed_json(client) -> None:
    with client.websocket_connect("/api/v1/ws/execute") as socket:
        socket.receive_json()
        socket.send_text("{not json")
        frame = socket.receive_json()

    assert frame["type"] == "error"
    assert "valid JSON" in frame["message"]


def test_websocket_rejects_an_unknown_runtime(client) -> None:
    with client.websocket_connect("/api/v1/ws/execute") as socket:
        socket.receive_json()
        socket.send_json(
            {"language": "klingon", "files": [{"name": "a.kl", "content": "x"}]}
        )
        frame = socket.receive_json()

    assert frame["type"] == "error"
    assert "Unknown runtime" in frame["message"]


def test_websocket_reports_a_validation_error_readably(client) -> None:
    with client.websocket_connect("/api/v1/ws/execute") as socket:
        socket.receive_json()
        socket.send_json(
            {"language": "python", "files": [{"name": "../evil.py", "content": "x"}]}
        )
        frame = socket.receive_json()

    assert frame["type"] == "error"
    assert "escape the workspace" in frame["message"]


def test_websocket_abort_on_an_idle_connection_is_harmless(client) -> None:
    with client.websocket_connect("/api/v1/ws/execute") as socket:
        socket.receive_json()
        socket.send_json({"action": "abort"})
        assert socket.receive_json()["type"] == "idle"


# ---------------------------------------------------------------------------
# Static analysis
# ---------------------------------------------------------------------------


def test_analyze_returns_a_scope_tree_with_metrics(client) -> None:
    from app import analyzer

    if not analyzer.available():
        pytest.skip("analyzer binary is not built")

    response = client.post(
        "/api/v1/analyze",
        json={
            "language": "python",
            "source": "class Engine:\n    def start(self):\n        return 1\n",
        },
    )
    assert response.status_code == 200

    payload = response.json()
    assert payload["metrics"]["declarations"] == 2
    assert payload["ast"]["kind"] == "ProgramRoot"
    assert payload["ast"]["children"][0]["name"] == "Engine"


def test_analyze_reports_structural_errors(client) -> None:
    from app import analyzer

    if not analyzer.available():
        pytest.skip("analyzer binary is not built")

    response = client.post(
        "/api/v1/analyze",
        json={"language": "cpp", "source": "int main() {\n  return 0;\n"},
    )
    assert response.status_code == 200

    rules = {d["rule"] for d in response.json()["diagnostics"]}
    assert "unclosed-delimiter" in rules


# ---------------------------------------------------------------------------
# Program input and arguments
# ---------------------------------------------------------------------------


@requires_python
def test_execute_passes_stdin_to_the_program(client) -> None:
    response = client.post(
        "/api/v1/execute",
        json={
            "language": "python",
            "files": [
                {
                    "name": "main.py",
                    "content": "import sys\nname = sys.stdin.readline().strip()\nprint(f'hello {name}')",
                }
            ],
            "stdin": "Alexandru\n",
        },
    )
    assert response.status_code == 200
    assert "hello Alexandru" in response.json()["stdout"]


@requires_python
def test_execute_passes_arguments_verbatim(client) -> None:
    """Arguments must survive spaces and shell metacharacters untouched."""
    response = client.post(
        "/api/v1/execute",
        json={
            "language": "python",
            "files": [{"name": "main.py", "content": "import sys\nprint(sys.argv[1:])"}],
            "args": ["--mode", "two words", "$(whoami)", "a;b"],
        },
    )
    assert response.status_code == 200

    stdout = response.json()["stdout"]
    assert "--mode" in stdout
    assert "two words" in stdout
    # The shell must never have expanded this.
    assert "$(whoami)" in stdout
    assert "a;b" in stdout


def test_execute_rejects_too_many_arguments(client) -> None:
    response = client.post(
        "/api/v1/execute",
        json={
            "language": "python",
            "files": [{"name": "main.py", "content": "pass"}],
            "args": [f"a{i}" for i in range(100)],
        },
    )
    assert response.status_code == 422
