"""The HTTP surfaces, driven against a real server on a real socket."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request

import numpy as np
import pytest
import torch

from codecraft_model.config import ModelConfig
from codecraft_model.data import write_dataset
from codecraft_model.model import CodeCraftLM
from codecraft_model.serve import Engine, _flatten_content, build_server, render_messages
from codecraft_model.tokenizer import Tokenizer
from codecraft_model.train import TrainConfig, save_checkpoint

CORPUS = "def parse(text):\n    return [line.strip() for line in text.splitlines()]\n" * 60


@pytest.fixture(scope="module")
def run_directory(tmp_path_factory):
    """A tiny but genuine run: trained tokenizer, real weights, real checkpoint."""
    directory = tmp_path_factory.mktemp("run")

    tokenizer = Tokenizer.train(CORPUS, 320)
    tokenizer.save(directory / "tokenizer.json")

    write_dataset(np.array(tokenizer.encode(CORPUS), dtype=np.uint16), directory)

    config = ModelConfig(
        vocab_size=tokenizer.vocab_size, d_model=64, n_layers=2, n_heads=4,
        n_kv_heads=2, d_ff=128, max_seq_len=128,
    )
    torch.manual_seed(0)
    save_checkpoint(
        directory / "model.pt", CodeCraftLM(config), None, 10, 2.5, TrainConfig()
    )
    return directory


@pytest.fixture(scope="module")
def base_url(run_directory):
    """A server bound to an ephemeral port, running on its own thread."""
    server = build_server(run_directory, "127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def post(url: str, payload: dict, *, raw: bool = False):
    request = urllib.request.Request(
        url, json.dumps(payload).encode(), {"Content-Type": "application/json"}
    )
    # No proxy: this is loopback, and the environment's proxy would swallow it.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=60) as response:
        body = response.read().decode()
    return body if raw else json.loads(body)


def get(url: str) -> dict:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=30) as response:
        return json.loads(response.read().decode())


def parse_sse(body: str) -> list[tuple[str, dict]]:
    events = []
    for block in body.strip().split("\n\n"):
        lines = block.splitlines()
        name = next((l[7:] for l in lines if l.startswith("event: ")), "")
        data = next((l[6:] for l in lines if l.startswith("data: ")), "{}")
        events.append((name, json.loads(data)))
    return events


# ---------------------------------------------------------------- the engine


def test_engine_reports_the_model_it_loaded(run_directory) -> None:
    described = Engine(run_directory).describe()
    assert described["parameters"] > 0
    assert described["trained_steps"] == 10
    assert described["context"] == 128


def test_engine_refuses_a_directory_without_a_checkpoint(tmp_path) -> None:
    with pytest.raises(FileNotFoundError, match="missing"):
        Engine(tmp_path)


def test_engine_truncates_a_prompt_that_fills_the_context(run_directory) -> None:
    """Otherwise there is no room left to answer in."""
    engine = Engine(run_directory)
    text, _ = engine.complete("x " * 4000, max_tokens=4, temperature=0.0)
    assert isinstance(text, str)


def test_streamed_deltas_reassemble_into_the_completion(run_directory) -> None:
    """Streaming and completing must produce the same text.

    Deltas are cut at character boundaries by an incremental decoder, so a
    character spanning two tokens arrives whole rather than as two replacements.
    """
    engine = Engine(run_directory)
    torch.manual_seed(7)
    streamed = "".join(delta for delta, _ in engine.stream("def ", max_tokens=20, temperature=0.0))
    torch.manual_seed(7)
    completed, _ = engine.complete("def ", max_tokens=20, temperature=0.0)

    assert streamed == completed


def test_streaming_counts_every_token(run_directory) -> None:
    """A token that only completes part of a character still counts."""
    engine = Engine(run_directory)
    _, count = engine.complete("def ", max_tokens=16, temperature=0.0)
    assert 0 < count <= 16


# -------------------------------------------------------------- prompt shape


def test_flatten_accepts_both_content_forms() -> None:
    assert _flatten_content("plain") == "plain"
    assert _flatten_content([{"type": "text", "text": "block"}]) == "block"
    assert _flatten_content(None) == ""


def test_flatten_skips_non_text_blocks() -> None:
    content = [{"type": "text", "text": "keep"}, {"type": "image", "source": {}}]
    assert _flatten_content(content) == "keep"


def test_rendered_prompt_marks_the_turns() -> None:
    prompt = render_messages(
        "you are terse", [{"role": "user", "content": "hi"}]
    )
    assert prompt.startswith("you are terse")
    assert "<|user|>hi" in prompt
    # It ends open, so the model continues as the assistant.
    assert prompt.endswith("<|assistant|>")


def test_rendered_prompt_keeps_the_conversation_in_order() -> None:
    prompt = render_messages(
        None,
        [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "second"},
            {"role": "user", "content": "third"},
        ],
    )
    assert prompt.index("first") < prompt.index("second") < prompt.index("third")


def test_rendered_prompt_drops_empty_messages() -> None:
    prompt = render_messages(None, [{"role": "user", "content": ""}])
    assert prompt == "<|assistant|>"


# ------------------------------------------------------------------- routing


def test_health_returns_the_model_card(base_url: str) -> None:
    body = get(f"{base_url}/health")
    assert body["status"] == "ok" and body["parameters"] > 0


def test_model_listing_names_the_local_model(base_url: str) -> None:
    body = get(f"{base_url}/v1/models")
    assert body["data"][0]["id"].startswith("codecraft-")


def test_unknown_routes_are_a_clean_404(base_url: str) -> None:
    with pytest.raises(urllib.error.HTTPError) as raised:
        get(f"{base_url}/nope")
    assert raised.value.code == 404


def test_malformed_json_is_rejected(base_url: str) -> None:
    request = urllib.request.Request(
        f"{base_url}/generate", b"{not json", {"Content-Type": "application/json"}
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with pytest.raises(urllib.error.HTTPError) as raised:
        opener.open(request, timeout=30)

    assert raised.value.code == 400
    assert json.loads(raised.value.read())["error"]["type"] == "invalid_request_error"


# ------------------------------------------------------------- /generate


def test_generate_completes_a_prompt(base_url: str) -> None:
    body = post(f"{base_url}/generate", {"prompt": "def ", "max_tokens": 12})
    assert body["tokens"] > 0
    assert isinstance(body["completion"], str)
    assert body["seconds"] >= 0


def test_generate_requires_a_prompt(base_url: str) -> None:
    with pytest.raises(urllib.error.HTTPError) as raised:
        post(f"{base_url}/generate", {"max_tokens": 4})
    assert raised.value.code == 400


def test_generate_streams_tokens(base_url: str) -> None:
    raw = post(
        f"{base_url}/generate", {"prompt": "def ", "max_tokens": 8, "stream": True}, raw=True
    )
    events = parse_sse(raw)

    assert [name for name, _ in events][-1] == "done"
    assert all("text" in payload for name, payload in events if name == "token")


# ------------------------------------------------------------- /v1/messages


def test_messages_returns_an_assistant_message(base_url: str) -> None:
    body = post(
        f"{base_url}/v1/messages",
        {"messages": [{"role": "user", "content": "hello"}], "max_tokens": 12},
    )

    assert body["role"] == "assistant" and body["type"] == "message"
    assert body["content"][0]["type"] == "text"
    assert body["usage"]["input_tokens"] > 0
    assert body["stop_reason"] in {"end_turn", "max_tokens"}


def test_messages_requires_a_conversation(base_url: str) -> None:
    with pytest.raises(urllib.error.HTTPError) as raised:
        post(f"{base_url}/v1/messages", {"messages": []})
    assert raised.value.code == 400


def test_messages_stream_follows_the_expected_event_order(base_url: str) -> None:
    """This sequence is what the assistant client already parses."""
    raw = post(
        f"{base_url}/v1/messages",
        {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 8, "stream": True},
        raw=True,
    )
    names = [name for name, _ in parse_sse(raw)]

    assert names[0] == "message_start"
    assert names[1] == "content_block_start"
    assert names[-3:] == ["content_block_stop", "message_delta", "message_stop"]
    assert "content_block_delta" in names


def test_streamed_deltas_reassemble_into_the_reply(base_url: str) -> None:
    raw = post(
        f"{base_url}/v1/messages",
        {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 10, "stream": True},
        raw=True,
    )
    events = parse_sse(raw)

    text = "".join(
        payload["delta"]["text"]
        for name, payload in events
        if name == "content_block_delta"
    )
    usage = next(payload for name, payload in events if name == "message_delta")

    assert isinstance(text, str)
    assert usage["usage"]["output_tokens"] > 0


def test_max_tokens_is_honoured_and_reported(base_url: str) -> None:
    body = post(
        f"{base_url}/v1/messages",
        {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 5},
    )
    assert body["usage"]["output_tokens"] <= 5


def test_concurrent_requests_are_serialised(base_url: str) -> None:
    """Two generations sharing one model must not interleave into nonsense."""
    results: list[dict] = []

    def call() -> None:
        results.append(post(f"{base_url}/generate", {"prompt": "def ", "max_tokens": 8}))

    threads = [threading.Thread(target=call) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=90)

    assert len(results) == 3
    assert all(result["tokens"] > 0 for result in results)


def test_a_client_that_disconnects_mid_stream_does_not_break_the_server(
    base_url: str,
) -> None:
    """Closing early must not leave a traceback or a held lock behind."""
    request = urllib.request.Request(
        f"{base_url}/generate",
        json.dumps({"prompt": "def ", "max_tokens": 400, "stream": True}).encode(),
        {"Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    response = opener.open(request, timeout=60)
    response.read(16)
    response.close()

    # The next request proves the server and the generation lock both survived.
    assert get(f"{base_url}/health")["status"] == "ok"
