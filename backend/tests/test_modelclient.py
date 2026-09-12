"""The gateway's link to the local model server.

Driven against a real HTTP server on a real socket rather than a mocked client:
the failure modes worth covering here are transport ones, and a mock cannot have
a connection refused.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import dataclasses

import pytest

from app import modelclient
from app.config import settings


def point_at(monkeypatch, url: str, **overrides) -> None:
    """Aim the client at `url`.

    Settings is a frozen dataclass, so the module's reference is replaced with a
    modified copy rather than the instance being mutated. Frozen is the right
    choice for configuration read from the environment once at import.
    """
    monkeypatch.setattr(
        modelclient, "settings", dataclasses.replace(settings, model_url=url, **overrides)
    )


class Handler(BaseHTTPRequestHandler):
    """A stand-in model server whose behaviour each test chooses."""

    # Set per test: (status, body) or an exception to simulate a hang.
    response: tuple[int, dict] = (200, {})
    seen: dict | None = None
    seen_headers: dict | None = None

    def log_message(self, *args) -> None:  # noqa: A002 - stdlib signature
        return

    def _send(self) -> None:
        status, body = Handler.response
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        self._send()

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        length = int(self.headers.get("Content-Length", "0"))
        Handler.seen = json.loads(self.rfile.read(length) or b"{}")
        Handler.seen_headers = dict(self.headers)
        self._send()


@pytest.fixture
def model_server(monkeypatch):
    """A server on an ephemeral port, with the gateway pointed at it."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    point_at(monkeypatch, f"http://127.0.0.1:{server.server_address[1]}")
    Handler.seen = None
    Handler.seen_headers = None
    try:
        yield Handler
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def no_model_server(monkeypatch):
    """A port with nothing listening, which is the common real state."""
    # Port 1 needs privileges to bind, so nothing can be running there.
    point_at(
        monkeypatch,
        "http://127.0.0.1:1",
        model_timeout_seconds=1.0,
        model_probe_seconds=1.0,
    )


# ------------------------------------------------------------------- success


@pytest.mark.asyncio
async def test_infill_returns_what_the_model_wrote(model_server) -> None:
    model_server.response = (
        200,
        {"completion": "    return result", "tokens": 5, "model": "codecraft-demo", "seconds": 0.2},
    )

    result = await modelclient.infill("def f():\n", "\n", max_tokens=32, temperature=0.2)

    assert result.completion == "    return result"
    assert result.tokens == 5
    assert result.model == "codecraft-demo"


@pytest.mark.asyncio
async def test_both_halves_reach_the_model(model_server) -> None:
    """The suffix is the whole point; dropping it would be silent and wrong."""
    model_server.response = (200, {"completion": ""})

    await modelclient.infill("BEFORE", "AFTER", max_tokens=8, temperature=0.0)

    assert model_server.seen == {
        "prefix": "BEFORE",
        "suffix": "AFTER",
        "max_tokens": 8,
        "temperature": 0.0,
    }


@pytest.mark.asyncio
async def test_the_asking_editor_is_identified_to_the_model(model_server) -> None:
    """So a client that keeps typing supersedes its own last request.

    A header rather than a body field: it says who is asking, not what is being
    asked, and the model server reads it before parsing anything.
    """
    model_server.response = (200, {"completion": ""})

    await modelclient.infill("a", "b", max_tokens=4, temperature=0.0, source="editor-7")

    assert Handler.seen_headers["X-Request-Source"] == "editor-7"
    assert "source" not in (Handler.seen or {})


@pytest.mark.asyncio
async def test_no_source_sends_no_header(model_server) -> None:
    """An empty one would be a key every client shared, superseding each other."""
    model_server.response = (200, {"completion": ""})

    await modelclient.infill("a", "b", max_tokens=4, temperature=0.0)

    assert "X-Request-Source" not in Handler.seen_headers


@pytest.mark.asyncio
async def test_a_superseded_completion_is_reported_as_one(model_server) -> None:
    """The editor should show nothing, rather than "the model had no suggestion"."""
    model_server.response = (200, {"completion": "", "superseded": True})

    result = await modelclient.infill("a", "b", max_tokens=4, temperature=0.0)

    assert result.superseded is True


@pytest.mark.asyncio
async def test_asking_for_one_candidate_sends_no_field(model_server) -> None:
    """So a model server old enough not to know it never sees it."""
    model_server.response = (200, {"completion": ""})

    await modelclient.infill("a", "b", max_tokens=4, temperature=0.0)

    assert "candidates" not in (Handler.seen or {})


@pytest.mark.asyncio
async def test_asking_for_several_candidates_says_so(model_server) -> None:
    model_server.response = (200, {"completion": ""})

    await modelclient.infill("a", "b", max_tokens=4, temperature=0.0, candidates=4)

    assert Handler.seen["candidates"] == 4


@pytest.mark.asyncio
async def test_confidence_comes_back_when_the_model_reports_it(model_server) -> None:
    model_server.response = (200, {"completion": "x", "confidence": -1.25})

    result = await modelclient.infill("a", "b", max_tokens=4, temperature=0.0)

    assert result.confidence == -1.25


@pytest.mark.asyncio
async def test_a_model_that_reports_no_confidence_is_not_an_error(model_server) -> None:
    """An older server, or one answering from its cache."""
    model_server.response = (200, {"completion": "x"})

    result = await modelclient.infill("a", "b", max_tokens=4, temperature=0.0)

    assert result.confidence is None


@pytest.mark.asyncio
async def test_a_response_missing_fields_still_parses(model_server) -> None:
    """A partial answer is better than an exception in the editor's path."""
    model_server.response = (200, {})

    result = await modelclient.infill("a", "b", max_tokens=4, temperature=0.1)

    assert result.completion == ""
    assert result.tokens == 0


@pytest.mark.asyncio
async def test_health_reports_the_model_card(model_server) -> None:
    model_server.response = (200, {"status": "ok", "parameters": 1234})
    assert (await modelclient.health())["parameters"] == 1234


@pytest.mark.asyncio
async def test_available_is_true_when_the_server_answers(model_server) -> None:
    model_server.response = (200, {"status": "ok"})
    assert await modelclient.available() is True


# ------------------------------------------------------------------ failures


@pytest.mark.asyncio
async def test_a_missing_server_is_reported_not_raised_as_a_transport_error(
    no_model_server,
) -> None:
    with pytest.raises(modelclient.ModelUnavailable, match="could not reach"):
        await modelclient.infill("a", "b", max_tokens=4, temperature=0.1)


@pytest.mark.asyncio
async def test_available_is_false_rather_than_throwing(no_model_server) -> None:
    """The capability report describes an absent model; it does not fail."""
    assert await modelclient.available() is False


@pytest.mark.asyncio
async def test_an_error_status_carries_the_body(model_server) -> None:
    model_server.response = (400, {"error": {"message": "prefix must be a string"}})

    with pytest.raises(modelclient.ModelUnavailable, match="400"):
        await modelclient.infill("a", "b", max_tokens=4, temperature=0.1)


# -------------------------------------------------------------------- routes


def test_the_infill_route_reports_an_absent_model_as_503(client, no_model_server) -> None:
    response = client.post("/api/v1/assistant/infill", json={"prefix": "def f("})
    assert response.status_code == 503


def test_the_infill_route_needs_something_to_work_with(client) -> None:
    response = client.post("/api/v1/assistant/infill", json={"prefix": "", "suffix": ""})
    assert response.status_code == 400


def test_the_infill_route_clamps_the_token_budget(client) -> None:
    """An inline suggestion must not be able to ask for a thousand tokens."""
    response = client.post(
        "/api/v1/assistant/infill", json={"prefix": "x", "max_tokens": 99999}
    )
    assert response.status_code == 422


def test_the_model_route_describes_an_absent_model(client, no_model_server) -> None:
    body = client.get("/api/v1/assistant/model").json()
    assert body["available"] is False
    assert "reason" in body


def test_the_model_route_describes_a_present_one(client, model_server) -> None:
    model_server.response = (200, {"status": "ok", "parameters": 42, "model": "codecraft-x"})

    body = client.get("/api/v1/assistant/model").json()

    assert body["available"] is True
    assert body["parameters"] == 42
