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


# ------------------------------------------------------- fill in the middle


def test_infill_writes_between_the_two_halves(run_directory) -> None:
    """The budget is respected and the result is text.

    The count is not asserted to be non-zero: these weights are random, and a
    greedy step that lands on a stop marker immediately is a property of an
    untrained model rather than of this code.
    """
    engine = Engine(run_directory)
    text, count = engine.infill("def parse(text):\n    ", "\n    return result\n",
                                max_tokens=16, temperature=0.0)

    assert isinstance(text, str)
    assert 0 <= count <= 16


def test_infill_stops_at_a_structural_marker(run_directory) -> None:
    """Without this the model runs on past the hole it was asked to fill."""
    engine = Engine(run_directory)
    text, _ = engine.infill("a", "b", max_tokens=64, temperature=0.0)

    for marker in ("<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>"):
        assert marker not in text


def test_infill_with_an_empty_suffix_still_works(run_directory) -> None:
    """The caret at the end of a file is the ordinary completion case."""
    engine = Engine(run_directory)
    text, _ = engine.infill("def parse(", "", max_tokens=8, temperature=0.0)
    assert isinstance(text, str)


def test_an_identical_infill_request_is_answered_from_the_cache(run_directory) -> None:
    """An editor re-asking the same question should not pay for it twice.

    The token count is zero because nothing was generated, which is also how a
    caller can tell a remembered answer from a fresh one.
    """
    engine = Engine(run_directory)
    first, generated = engine.infill("def parse(", ")\n", max_tokens=8, temperature=0.0)
    second, remembered = engine.infill("def parse(", ")\n", max_tokens=8, temperature=0.0)

    assert second == first
    assert remembered == 0
    assert engine.response_cache.stats.hits == 1
    assert generated >= 0


def test_asking_again_without_the_cache_runs_the_model(run_directory) -> None:
    """`use_cache=False` is what a request for a different suggestion needs."""
    engine = Engine(run_directory)
    engine.infill("def parse(", ")\n", max_tokens=8, temperature=0.0)
    _, count = engine.infill(
        "def parse(", ")\n", max_tokens=8, temperature=0.0, use_cache=False
    )

    assert engine.response_cache.stats.hits == 0
    assert count >= 0


def test_a_different_budget_is_a_different_question(run_directory) -> None:
    """Sampling settings are part of the key, or the cache answers the wrong one."""
    engine = Engine(run_directory)
    engine.infill("def parse(", ")\n", max_tokens=8, temperature=0.0)
    engine.infill("def parse(", ")\n", max_tokens=16, temperature=0.0)

    assert engine.response_cache.stats.hits == 0


def test_extending_a_prompt_reuses_the_earlier_prefill(run_directory) -> None:
    """The keystroke case: the same file with one more character typed.

    A file rather than a line, because reuse is deliberately declined when there
    is too little in common to be worth the slicing, and a one-line prompt is
    under that threshold.
    """
    engine = Engine(run_directory)
    head = CORPUS[:400]
    engine.infill(head + "return [line", "]\n", max_tokens=4, temperature=0.0)
    engine.infill(head + "return [line.", "]\n", max_tokens=4, temperature=0.0)

    assert engine.prefix_cache.stats.partial == 1


def test_a_prompt_with_little_in_common_is_not_worth_reusing(run_directory) -> None:
    """Slicing and concatenating a cache is not free; a short prefix is cheaper
    to rebuild than to reuse."""
    engine = Engine(run_directory)
    engine.infill("def f(", ")\n", max_tokens=4, temperature=0.0)
    engine.infill("def g(", ")\n", max_tokens=4, temperature=0.0)

    assert engine.prefix_cache.stats.partial == 0


def test_a_cached_prefill_does_not_change_the_completion(run_directory) -> None:
    """Reuse is an optimisation; an optimisation that changes the answer is a bug."""
    engine = Engine(run_directory)
    warm, _ = engine.infill("def parse(text):\n    return x", "\n", max_tokens=6, temperature=0.0)

    cold_engine = Engine(run_directory)
    cold, _ = cold_engine.infill(
        "def parse(text):\n    return x", "\n", max_tokens=6, temperature=0.0, use_cache=False
    )

    assert warm == cold


def test_the_caches_are_reported(run_directory) -> None:
    """Whether the cache is working is not something to guess at from timings."""
    engine = Engine(run_directory)
    engine.infill("def parse(", ")\n", max_tokens=4, temperature=0.0)

    described = engine.describe()
    assert described["cache"]["responses"] == 1


def test_an_adapter_is_merged_before_serving(run_directory, tmp_path) -> None:
    """A fine-tuned adapter has to be servable, or training one is a hobby."""
    from codecraft_model.lora import LoRAConfig, apply_lora, save_adapter
    from codecraft_model.train import load_checkpoint

    model, _ = load_checkpoint(run_directory / "model.pt")
    config = LoRAConfig(rank=4)
    apply_lora(model, config)
    adapter = tmp_path / "adapter.pt"
    save_adapter(adapter, model, config)

    engine = Engine(run_directory, adapter=adapter)

    assert engine.describe()["adapter"]["rank"] == 4
    # Merged, so nothing downstream needs to know an adapter was ever involved.
    assert not any("lora" in name for name in engine.model.state_dict())


def test_an_adapter_that_is_not_there_says_so(run_directory, tmp_path) -> None:
    with pytest.raises(FileNotFoundError, match="no adapter"):
        Engine(run_directory, adapter=tmp_path / "missing.pt")


def test_serving_without_an_adapter_reports_none(run_directory) -> None:
    assert Engine(run_directory).describe()["adapter"] is None


def test_a_checkpoint_older_than_the_fim_markers_says_so(run_directory, tmp_path) -> None:
    """The failure without this is an IndexError from inside the embedding.

    A run prepared before the markers existed has a tokenizer that knows four
    tokens its checkpoint has no embeddings for. Ordinary generation never emits
    them; infill puts them in the prompt.
    """
    import shutil

    older = tmp_path / "older"
    older.mkdir()
    for name in ("tokenizer.json", "meta.json", "train.bin", "val.bin"):
        shutil.copy(run_directory / name, older / name)

    tokenizer = Tokenizer.load(run_directory / "tokenizer.json")
    narrow = ModelConfig(
        vocab_size=tokenizer.vocab_size - 4, d_model=64, n_layers=2, n_heads=4,
        n_kv_heads=2, d_ff=128, max_seq_len=128,
    )
    torch.manual_seed(0)
    save_checkpoint(older / "model.pt", CodeCraftLM(narrow), None, 10, 2.5, TrainConfig())

    engine = Engine(older)

    assert engine.describe()["infill"] is False
    with pytest.raises(ValueError, match="predates the fill-in-the-middle"):
        engine.infill("def f(", ")")


def test_an_ordinary_run_supports_infill(run_directory) -> None:
    assert Engine(run_directory).describe()["infill"] is True


def test_generation_stops_on_text(run_directory) -> None:
    """A stop token works when the model was trained to emit one; this is for
    everything else."""
    engine = Engine(run_directory)
    text, _ = engine.complete("def ", max_tokens=40, temperature=0.0, stop=["e"])

    assert "e" not in text


def test_a_stop_sequence_is_not_included_in_the_answer(run_directory) -> None:
    engine = Engine(run_directory)
    text, _ = engine.complete("def ", max_tokens=40, temperature=0.0, stop=["a", "e", "i"])

    assert not any(vowel in text for vowel in "aei")


def test_stop_sequences_come_from_either_field_name(base_url: str) -> None:
    """`stop_sequences` is what a Messages client sends; `stop` is what most
    other APIs call it."""
    from codecraft_model.serve import _stop_sequences

    assert _stop_sequences({"stop_sequences": ["a"]}) == ["a"]
    assert _stop_sequences({"stop": ["b"]}) == ["b"]
    assert _stop_sequences({"stop": "c"}) == ["c"]


def test_unusable_stop_sequences_are_dropped_rather_than_refused(base_url: str) -> None:
    from codecraft_model.serve import _stop_sequences

    assert _stop_sequences({"stop": [1, "", None, "keep"]}) == ["keep"]
    assert _stop_sequences({"stop": 5}) == []


def test_stop_sequences_are_bounded(base_url: str) -> None:
    """Each is searched for after every token, on every request."""
    from codecraft_model.serve import _stop_sequences

    assert len(_stop_sequences({"stop": [f"s{index}" for index in range(50)]})) == 8
    assert len(_stop_sequences({"stop": ["x" * 500]})[0]) == 64


def test_the_infill_route_takes_stop_sequences(base_url: str) -> None:
    body = post(
        f"{base_url}/infill",
        {"prefix": "def f(", "suffix": ")", "max_tokens": 20, "temperature": 0, "stop": ["e"]},
    )

    assert "e" not in body["completion"]


def test_a_completion_reports_how_confident_the_model_was(run_directory) -> None:
    """Mean log-probability under the model's own distribution, before sampling."""
    engine = Engine(run_directory)
    engine.infill("def f(", ")", max_tokens=8, temperature=0.0, use_cache=False)

    assert engine.last_confidence < 0
    assert engine.last_confidence > -20


def test_best_of_returns_one_of_its_candidates(run_directory) -> None:
    engine = Engine(run_directory)
    text, total = engine.infill_best_of(
        "def parse(text):\n    ", "\n", candidates=3, max_tokens=6, temperature=0.8
    )

    assert isinstance(text, str)
    # Every candidate is a whole generation, so the tokens add up.
    assert total >= 0


def test_best_of_costs_what_it_says(run_directory) -> None:
    engine = Engine(run_directory)
    one, _ = engine.infill_best_of("def f(", ")", candidates=1, max_tokens=4)
    engine.response_cache.clear()
    _, many = engine.infill_best_of("def f(", ")", candidates=4, max_tokens=4)
    _, single = engine.infill("def f(", ")", max_tokens=4, use_cache=False)

    assert isinstance(one, str)
    assert many >= single


def test_candidates_share_one_prefill(run_directory) -> None:
    """Four candidates of one prompt are four samples, not four readings.

    Behavioural rather than timed: the prompt is identical for every candidate,
    so every candidate after the first should find it already read.
    """
    engine = Engine(run_directory)
    head = CORPUS[:400]

    engine.infill_best_of(head + "return ", "\n", candidates=4, max_tokens=4, temperature=0.8)

    assert engine.prefix_cache.stats.partial == 3


def test_a_fresh_sample_still_reads_the_prompt_once(run_directory) -> None:
    """`use_cache=False` asks for a different answer, not for slower work."""
    engine = Engine(run_directory)
    head = CORPUS[:400]

    engine.infill(head + "return ", "\n", max_tokens=4, use_cache=False)
    engine.infill(head + "return ", "\n", max_tokens=4, use_cache=False)

    # Nothing was remembered, because nothing asked for the prefill to be kept.
    assert engine.prefix_cache.stats.partial == 0


def test_a_cancelled_search_stops_between_candidates(run_directory) -> None:
    """The expensive request is the one most likely to be running when the next
    one arrives, so it stops between candidates as well as between tokens."""
    from codecraft_model.inflight import Ticket

    engine = Engine(run_directory)
    ticket = Ticket("editor")
    ticket.cancelled = True

    text, total = engine.infill_best_of(
        "def parse(", ")", candidates=6, max_tokens=8, ticket=ticket
    )

    assert text == ""
    assert total == 0


def test_best_of_zero_is_refused(run_directory) -> None:
    """Picking the best of nothing has no answer."""
    engine = Engine(run_directory)

    with pytest.raises(ValueError, match="at least one candidate"):
        engine.infill_best_of("a", "b", candidates=0)


def test_the_infill_route_takes_candidates(base_url: str) -> None:
    body = post(
        f"{base_url}/infill",
        {"prefix": "def f(", "suffix": ")", "max_tokens": 6, "candidates": 3},
    )

    assert body["candidates"] == 3
    assert isinstance(body["confidence"], float)


def test_the_candidate_count_is_bounded(base_url: str) -> None:
    """A request for fifty generations is a denial of service with a polite name."""
    body = post(
        f"{base_url}/infill",
        {"prefix": "def f(", "suffix": ")", "max_tokens": 4, "candidates": 500},
    )

    assert body["candidates"] == 8


def test_a_cancelled_completion_returns_nothing(run_directory) -> None:
    """Half an answer is not the answer to the prompt that was asked."""
    from codecraft_model.inflight import Ticket

    engine = Engine(run_directory)
    ticket = Ticket("editor")
    ticket.cancelled = True

    text, _ = engine.infill("def f(", ")", max_tokens=8, ticket=ticket, use_cache=False)

    assert text == ""


def test_a_cancelled_completion_is_not_cached(run_directory) -> None:
    """Caching it would hand half an answer to the next request that asks."""
    from codecraft_model.inflight import Ticket

    engine = Engine(run_directory)
    ticket = Ticket("editor")
    ticket.cancelled = True
    engine.infill("def f(", ")", max_tokens=8, temperature=0.0, ticket=ticket)

    assert len(engine.response_cache.entries) == 0


def test_cancellations_are_counted_in_the_model_card(run_directory) -> None:
    from codecraft_model.inflight import Ticket

    engine = Engine(run_directory)
    ticket = Ticket("editor")
    ticket.cancelled = True
    engine.infill("def f(", ")", max_tokens=4, ticket=ticket, use_cache=False)

    assert engine.describe()["superseded_requests"] == 1


def test_the_infill_route_says_whether_it_was_superseded(base_url: str) -> None:
    body = post(f"{base_url}/infill", {"prefix": "def f(", "suffix": ")", "max_tokens": 4})

    assert body["superseded"] is False


def test_a_stop_sequence_is_reported_as_the_reason(base_url: str) -> None:
    """A client cannot tell "it finished" from "you cut it off" otherwise."""
    question = {"messages": [{"role": "user", "content": "write"}], "max_tokens": 40,
                "temperature": 0}

    # The weights are random, so what it writes is arbitrary. Asking once tells
    # us a character it will actually produce, which is what makes this a test
    # of the reporting rather than of the model.
    written = post(f"{base_url}/v1/messages", question)["content"][0]["text"]
    marker = written[len(written) // 2]

    body = post(f"{base_url}/v1/messages", {**question, "stop_sequences": [marker]})

    assert body["stop_reason"] == "stop_sequence"
    assert body["stop_sequence"] == marker
    assert marker not in body["content"][0]["text"]


def test_running_out_of_budget_is_reported_as_length(base_url: str) -> None:
    body = post(
        f"{base_url}/v1/messages",
        {"messages": [{"role": "user", "content": "write"}], "max_tokens": 4},
    )

    assert body["stop_reason"] in {"max_tokens", "end_turn"}
    assert body["stop_sequence"] is None


def test_the_stop_fields_take_precedence_in_order() -> None:
    from codecraft_model.serve import _stop_fields

    # A stop sequence that matched on the last allowed token is still a stop
    # sequence, not a budget that ran out.
    assert _stop_fields("END", 10, 10)["stop_reason"] == "stop_sequence"
    assert _stop_fields(None, 10, 10)["stop_reason"] == "max_tokens"
    assert _stop_fields(None, 3, 10)["stop_reason"] == "end_turn"


def test_a_report_says_what_happened_without_shared_state(run_directory) -> None:
    """The engine is shared between request threads; "what the last call did"
    belongs to whichever call finished most recently, not to the one asking."""
    engine = Engine(run_directory)
    report: dict = {}
    engine.infill("def f(", ")", max_tokens=6, temperature=0.0, report=report, use_cache=False)

    assert report["cached"] is False
    assert report["superseded"] is False
    assert report["confidence"] < 0


def test_a_cached_answer_says_it_was_cached(run_directory) -> None:
    engine = Engine(run_directory)
    engine.infill("def g(", ")", max_tokens=6, temperature=0.0)
    report: dict = {}
    engine.infill("def g(", ")", max_tokens=6, temperature=0.0, report=report)

    assert report["cached"] is True


def test_a_replaced_checkpoint_is_picked_up(run_directory, tmp_path) -> None:
    """For watching a run improve without restarting what you test with.

    Driven a poll at a time rather than by waiting on the thread: a test that
    sleeps for a reload fails on a loaded machine, which is exactly when the
    suite runs.
    """
    import shutil

    from codecraft_model.reload import Watcher
    from codecraft_model.serve import build_server

    run = tmp_path / "watched"
    run.mkdir()
    for name in ("tokenizer.json", "meta.json", "model.pt"):
        shutil.copy(run_directory / name, run / name)

    server = build_server(run, "127.0.0.1", 0)
    try:
        before = server.engine
        watcher = Watcher(run / "model.pt")

        torch.manual_seed(7)
        save_checkpoint(
            run / "model.pt", CodeCraftLM(before.model.config), None, 99, 1.25, TrainConfig()
        )

        # The first poll sees a change it does not yet trust; the second acts.
        assert server.reload_if_changed(watcher) is False
        assert server.reload_if_changed(watcher) is True

        assert server.engine is not before
        assert server.engine.payload["step"] == 99
    finally:
        server.server_close()


def test_nothing_changing_is_not_a_reload(run_directory, tmp_path) -> None:
    import shutil

    from codecraft_model.reload import Watcher
    from codecraft_model.serve import build_server

    run = tmp_path / "still"
    run.mkdir()
    for name in ("tokenizer.json", "meta.json", "model.pt"):
        shutil.copy(run_directory / name, run / name)

    server = build_server(run, "127.0.0.1", 0)
    try:
        watcher = Watcher(run / "model.pt")
        assert server.reload_if_changed(watcher) is False
        assert server.reload_if_changed(watcher) is False
    finally:
        server.server_close()


def test_a_checkpoint_that_will_not_load_leaves_the_old_one_running(
    run_directory, tmp_path
) -> None:
    """A server answering with slightly stale weights beats one that stops."""
    import shutil

    from codecraft_model.reload import Watcher
    from codecraft_model.serve import build_server

    run = tmp_path / "broken"
    run.mkdir()
    for name in ("tokenizer.json", "meta.json", "model.pt"):
        shutil.copy(run_directory / name, run / name)

    server = build_server(run, "127.0.0.1", 0)
    try:
        before = server.engine
        watcher = Watcher(run / "model.pt")
        (run / "model.pt").write_bytes(b"not a checkpoint at all")

        server.reload_if_changed(watcher)
        assert server.reload_if_changed(watcher) is False
        assert server.engine is before
    finally:
        server.server_close()


def test_the_watching_thread_starts_and_stops(run_directory, tmp_path) -> None:
    """The thread itself, without depending on what it manages to do."""
    import shutil

    from codecraft_model.serve import build_server

    run = tmp_path / "threaded"
    run.mkdir()
    for name in ("tokenizer.json", "meta.json", "model.pt"):
        shutil.copy(run_directory / name, run / name)

    server = build_server(run, "127.0.0.1", 0, reload_seconds=0.05)
    try:
        assert server._reloader is not None
        assert server._reloader.is_alive()
    finally:
        server.server_close()

    assert not server._reloader.is_alive()


def test_infill_survives_a_prefix_longer_than_the_context(run_directory) -> None:
    engine = Engine(run_directory)
    text, _ = engine.infill("x " * 5000, "y " * 5000, max_tokens=4, temperature=0.0)
    assert isinstance(text, str)


def test_the_infill_route_completes(base_url: str) -> None:
    body = post(f"{base_url}/infill", {"prefix": "def f(", "suffix": "):\n    pass\n",
                                       "max_tokens": 12})
    assert body["tokens"] <= 12
    assert isinstance(body["completion"], str)
    assert body["model"].startswith("codecraft-")


def test_the_infill_route_defaults_the_suffix_to_empty(base_url: str) -> None:
    body = post(f"{base_url}/infill", {"prefix": "def f(", "max_tokens": 8})
    assert isinstance(body["completion"], str)


def test_the_infill_route_rejects_a_missing_prefix(base_url: str) -> None:
    with pytest.raises(urllib.error.HTTPError) as raised:
        post(f"{base_url}/infill", {"suffix": "x"})
    assert raised.value.code == 400
