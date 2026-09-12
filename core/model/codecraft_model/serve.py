"""HTTP serving for a trained checkpoint.

Two surfaces, one model:

  POST /v1/messages   the Messages request and SSE shape the assistant client
                      already speaks, so pointing ANTHROPIC_BASE_URL at this
                      server swaps the hosted model for ours with no code
                      change on the client side
  POST /generate      the native surface: a prompt, sampling settings, and a
                      stream of tokens with their ids

Only the wire format of the first is borrowed. The weights, tokenizer,
architecture and sampling below are entirely local; nothing in this file
contacts a hosted service.

The standard library's threading HTTP server is enough here. Generation holds
the GIL through PyTorch, so a lock serialises requests rather than letting two
of them interleave and corrupt each other's caches.
"""

from __future__ import annotations

import codecs
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch

from .cache import PrefixCache, ResponseCache
from .config import humanise
from .data import FILE_MARKER
from .device import (
    architecture_warning,
    autocast_dtype,
    describe_device,
    enable_fast_matmul,
    resolve_device,
)
from .inflight import Supersede, Ticket
from .reload import Watcher
from .stopping import StopWatcher
from .structure import ScopeWatcher, settled
from .tokenizer import Tokenizer
from .train import load_checkpoint

# A request body larger than this is a mistake or an attack, not a prompt.
MAX_BODY_BYTES = 4 * 1024 * 1024

DEFAULT_MAX_TOKENS = 512

# Marks text produced by flushing the decoder at the end of a generation rather
# than by a token of its own.
FLUSH_TOKEN = -1

# The corpus writes "<|file|>name" ahead of every document, as ordinary text
# rather than as a special token, so a model trained on it can and does emit one
# mid-completion: it is simply a string that often follows the end of a file.
# Nothing downstream wants it, and a completion that reaches it has left the
# file it was completing.
DEFAULT_INFILL_STOPS: tuple[str, ...] = (FILE_MARKER,)


class Engine:
    """A loaded checkpoint, ready to answer requests."""

    def __init__(
        self,
        run: Path,
        device: str | None = None,
        *,
        quantize: bool = False,
        adapter: Path | None = None,
    ) -> None:
        checkpoint = run / "model.pt"
        tokenizer_path = run / "tokenizer.json"
        for path in (checkpoint, tokenizer_path):
            if not path.exists():
                raise FileNotFoundError(f"{path} is missing; run prepare and train first")

        self.device = resolve_device(device)
        warning = architecture_warning(self.device)
        if warning:
            print(f"warning: {warning}")
        enable_fast_matmul(self.device)

        # Generation is dominated by the output projection and the attention
        # matmuls, both of which run at roughly twice the speed in bfloat16
        # with no visible difference in what is sampled.
        self.amp_dtype = autocast_dtype(self.device)

        self.run = run
        self.tokenizer = Tokenizer.load(tokenizer_path)
        self.model, self.payload = load_checkpoint(checkpoint, self.device)

        self.adapter = None
        if adapter is not None:
            from .lora import load_adapter, merge_lora

            if not adapter.exists():
                raise FileNotFoundError(f"no adapter at {adapter}")
            lora_config = load_adapter(adapter, self.model)
            # Merged rather than served through the adapter modules. The result
            # is numerically identical and every request afterwards runs through
            # ordinary linear layers, so serving costs nothing for having been
            # fine-tuned this way.
            merge_lora(self.model)
            self.model.to(self.device)
            self.adapter = {"path": str(adapter), "rank": lora_config.rank}

        self.quantization = None
        if quantize:
            # Serving holds one copy of the weights, unlike training's four, so
            # the weights are the whole budget and int8 quarters it.
            from .quantize import quantize_model

            self.quantization = quantize_model(self.model)
            self.model.to(self.device)

        # PyTorch releases the GIL inside kernels, so two concurrent generations
        # would genuinely run at once and thrash a machine sized for one.
        self.lock = threading.Lock()

        self.name = f"codecraft-{run.name}"
        self.end_token = self.tokenizer.special_id("<|end|>")

        # A run prepared before the fill-in-the-middle markers existed has a
        # tokenizer that now knows four tokens its checkpoint has no embeddings
        # for. Ordinary generation never emits them, so chat is unaffected, but
        # infill puts them in the prompt and the model indexes off the end of
        # its own table. The failure without this check is an IndexError from
        # inside the embedding, which says nothing about what to do.
        self.infill_error: str | None = None
        if self.tokenizer.vocab_size > self.model.config.vocab_size:
            self.infill_error = (
                f"this checkpoint has {self.model.config.vocab_size} embeddings and its "
                f"tokenizer now has {self.tokenizer.vocab_size} tokens, so it predates the "
                "fill-in-the-middle markers. Ordinary generation works; completing at a "
                "caret needs the run prepared and trained again."
            )

        # Both caches serve the caret, where requests repeat: one remembers the
        # prefill so a keystroke costs a token instead of a context, the other
        # remembers whole answers so going back to where you were costs nothing.
        self.prefix_cache = PrefixCache()
        self.response_cache = ResponseCache()

        # The mean log-probability of the last completion, which is how
        # best-of-n picks between candidates.
        self.last_confidence = float("-inf")
        self._superseded = 0

    def supersede_count(self) -> int:
        """How many requests were abandoned because a newer one arrived.

        On the engine rather than the server so it appears in the model card
        beside the cache numbers, which answer the same kind of question: is the
        editor asking for more than it uses?
        """
        return self._superseded

    def describe(self) -> dict:
        config = self.model.config
        return {
            "model": self.name,
            "device": describe_device(self.device),
            "precision": (
                "fp32" if self.amp_dtype is None
                else str(self.amp_dtype).removeprefix("torch.")
            ),
            "parameters": self.model.parameter_count(),
            "parameters_human": humanise(self.model.parameter_count()),
            "vocab_size": config.vocab_size,
            "context": config.max_seq_len,
            "layers": config.n_layers,
            "d_model": config.d_model,
            "trained_steps": self.payload.get("step"),
            "val_loss": self.payload.get("val_loss"),
            "adapter": self.adapter,
            "infill": self.infill_error is None,
            "infill_error": self.infill_error,
            "quantized": self.quantization is not None,
            "weight_bytes": (
                self.quantization.quantized_bytes if self.quantization else None
            ),
            "superseded_requests": self.supersede_count(),
            "cache": {
                "responses": len(self.response_cache.entries),
                "response_hit_rate": round(self.response_cache.stats.hit_rate, 3),
                "prefix_reuses": self.prefix_cache.stats.partial,
                "prefix_misses": self.prefix_cache.stats.misses,
            },
        }

    def stream(
        self,
        prompt: str,
        *,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = 0.8,
        top_k: int | None = 40,
        top_p: float | None = 0.95,
        min_p: float | None = None,
        repetition_penalty: float = 1.1,
        no_repeat_ngram: int = 0,
        stop: list[str] | None = None,
        report: dict | None = None,
        prompt_ids: list[int] | None = None,
    ):
        """Yield (text_delta, token_id) pairs for `prompt`.

        Every generated token is yielded, so callers can count them, but the
        delta may be empty: bytes go through an incremental UTF-8 decoder rather
        than being decoded per token, because a multi-byte character can span
        two tokens and decoding each alone would emit a replacement character
        for text that is perfectly valid a moment later.

        `stop` ends generation on text rather than on a token. A delta may be
        empty for a second reason once it is given: text that could still turn
        out to be the start of a stop sequence is held back until it is known
        not to be.

        `report` is filled in with what happened, which the caller needs and the
        return value has no room for. Passed in rather than kept on the engine:
        the engine is shared between request threads, and an attribute holding
        "what the last call did" belongs to whichever call finished most
        recently, not to the one asking.

        `prompt_ids` replaces the encoding step for a caller that has already
        built the ids. That matters for anything using the instruction format:
        the turn markers are special tokens, and decoding them to text to hand
        over a string drops them, so the model would be asked a question with no
        format at all.
        """
        ids = prompt_ids if prompt_ids is not None else self.tokenizer.encode(prompt)
        # Leave room to answer: a prompt that fills the context has nowhere to
        # put the reply, so the oldest tokens go first.
        room = self.model.config.max_seq_len - max(1, min(max_tokens, 64))
        if len(ids) > room:
            ids = ids[-room:]

        tokens = torch.tensor([ids or [self.tokenizer.special_id("<|begin|>")]], dtype=torch.long)

        with self.lock, torch.autocast(
            device_type=self.device.type,
            dtype=self.amp_dtype,
            enabled=self.amp_dtype is not None,
        ):
            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            watcher = StopWatcher(stop or ())
            halted = False

            for token_id in self.model.generate(
                tokens.to(self.device),
                max_new_tokens=max_tokens,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                min_p=min_p,
                repetition_penalty=repetition_penalty,
                no_repeat_ngram=no_repeat_ngram,
                stop_tokens={self.end_token},
            ):
                piece = self.tokenizer.vocab.get(token_id)
                text = decoder.decode(piece) if piece is not None else ""
                safe, hit = watcher.feed(text)
                # Yielded even when empty, so a caller counting tokens still
                # sees every one of them.
                yield safe, token_id
                if hit:
                    halted = True
                    break

            # Flush whatever the decoder was holding. A generation that stops
            # mid-character would otherwise drop those bytes silently. The id is
            # -1 because this text belongs to no single token, which is how
            # callers know not to count it as one.
            if not halted:
                tail = decoder.decode(b"", final=True)
                if tail:
                    safe, _ = watcher.feed(tail)
                    if safe:
                        yield safe, FLUSH_TOKEN
                held = watcher.flush()
                if held:
                    yield held, FLUSH_TOKEN

            if report is not None:
                report["stop"] = watcher.matched

    def infill(
        self,
        prefix: str,
        suffix: str,
        *,
        max_tokens: int = 64,
        temperature: float = 0.2,
        top_k: int | None = 40,
        top_p: float | None = 0.95,
        repetition_penalty: float = 1.05,
        # Measured on the FIM checkpoint: without this a small model walks into
        # "\n#\n#\n#" and spends its whole budget there. Four rather than two,
        # because code repeats short sequences legitimately and forbidding a
        # second run of indentation would be worse than the loop.
        no_repeat_ngram: int = 4,
        stop: list[str] | None = None,
        heal: bool = True,
        scope: bool = True,
        line_comment: str | None = None,
        use_cache: bool = True,
        reuse_prefill: bool | None = None,
        ticket: Ticket | None = None,
        report: dict | None = None,
    ) -> tuple[str, int]:
        """Write what goes between `prefix` and `suffix`.

        This is what an editor needs at a caret: there is almost always code on
        both sides, and a completion that ignores the right-hand side will
        cheerfully redeclare a variable that already exists two lines down.

        The defaults differ from chat on purpose. Temperature is low because an
        inline suggestion should be the likely continuation rather than an
        interesting one, and the budget is small because a suggestion nobody
        asked for should not be a paragraph.

        Two caches sit in front of the model, and both exist because an editor
        asks the same question over and over. An identical request returns the
        answer it gave last time, which also keeps a suggestion stable as the
        editor re-requests it rather than flickering between samples. A request
        that merely extends an earlier one reuses that prefill and pays only for
        the tokens that are new.

        They are separate switches because they answer different questions.
        `use_cache=False` asks for a fresh sample rather than the remembered
        answer; it defaults `reuse_prefill` to match, which is what a caller
        wanting a different suggestion means. Set `reuse_prefill=True` alongside
        it to sample again from a prompt already read, which is what drawing
        several candidates from one prompt is: the prefill is identical every
        time and only the sampling differs.

        Returns the completion and the number of tokens generated, which is zero
        for an answer that came from the cache.
        """
        if self.infill_error is not None:
            raise ValueError(self.infill_error)
        key = ResponseCache.key(
            prefix,
            suffix,
            max_tokens=max_tokens,
            temperature=temperature,
            top_k=top_k,
            top_p=top_p,
            repetition_penalty=repetition_penalty,
            no_repeat_ngram=no_repeat_ngram,
            stop=tuple(stop) if stop else (),
            heal=heal,
            scope=scope,
            line_comment=line_comment,
        )
        if use_cache:
            remembered = self.response_cache.get(key)
            if remembered is not None:
                if report is not None:
                    report.update(
                    cached=True, confidence=None,
                    stop=None, trimmed=None, superseded=False,
                )
                return remembered, 0

        if reuse_prefill is None:
            reuse_prefill = use_cache
        if stop is None:
            stop = list(DEFAULT_INFILL_STOPS)

        # Token healing: the prompt is cut back to a boundary the model has
        # seen, and the characters removed are put back by constraining the
        # first token. The caret itself does not move, so everything after this
        # still sees the prefix the editor sent.
        prompt_prefix, tail = self.tokenizer.heal(prefix) if heal else (prefix, "")
        allowed_first = None
        if tail:
            candidates = self.tokenizer.starting_with(tail)
            if candidates:
                allowed_first = torch.tensor(candidates, dtype=torch.long, device=self.device)
            else:
                # Nothing in the vocabulary begins with those characters, which
                # cannot happen for text that was tokenized from them, but a
                # constraint with nothing in it would forbid every token.
                prompt_prefix, tail = prefix, ""

        ids = self.tokenizer.encode_infill(
            prompt_prefix, suffix, max_context=self.model.config.max_seq_len - max_tokens
        )
        tokens = torch.tensor([ids], dtype=torch.long, device=self.device)

        with self.lock, torch.autocast(
            device_type=self.device.type,
            dtype=self.amp_dtype,
            enabled=self.amp_dtype is not None,
        ):
            reuse = self.prefix_cache.take(ids) if reuse_prefill else None
            prefix_caches, reused = reuse if reuse else (None, 0)

            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            watcher = StopWatcher(stop or ())
            # Two watchers over one stream: one ends the completion at text the
            # model wrote, the other at structure it broke. Whichever fires
            # first is where the suggestion ends.
            scoper = (
                ScopeWatcher(prefix, suffix, line_comment=line_comment)
                if scope
                else None
            )
            count = 0
            pending = tail
            logprobs: list[float] = []

            for token_id in self.model.generate(
                tokens,
                max_new_tokens=max_tokens,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                repetition_penalty=repetition_penalty,
                no_repeat_ngram=no_repeat_ngram,
                on_token=lambda _id, logprob: logprobs.append(logprob),
                # A model that has finished the middle says so; without these it
                # would run on into whatever it thinks follows the suffix.
                stop_tokens={self.end_token, self.tokenizer.fim_prefix,
                             self.tokenizer.fim_suffix, self.tokenizer.fim_middle},
                prefix_caches=prefix_caches,
                prefix_length=reused,
                allowed_first=allowed_first,
                # Remembering the prompt's own prefill, not the generated tail:
                # the next request extends the prompt, never the suggestion.
                on_prefill=(
                    (lambda caches, length: self._remember_prefill(ids, caches, length))
                    if reuse_prefill
                    else None
                ),
            ):
                count += 1
                if ticket is not None and ticket.cancelled:
                    # Between tokens is the only safe place to stop: there is
                    # nothing to kill, only a loop holding tensors.
                    break
                piece = self.tokenizer.vocab.get(token_id)
                if piece is not None:
                    text = decoder.decode(piece)
                    if pending:
                        # The healed characters were already in the file before
                        # the model was asked; returning them would type them
                        # twice.
                        shared = min(len(pending), len(text))
                        if text[:shared] == pending[:shared]:
                            text = text[shared:]
                            pending = pending[shared:]
                        else:
                            pending = ""
                        if not text:
                            continue
                    _, hit = watcher.feed(text)
                    if scoper is not None and scoper.feed(text)[1]:
                        hit = True
                    if hit:
                        break
            else:
                tail = decoder.decode(b"", final=True)
                watcher.feed(tail)
                if scoper is not None:
                    scoper.feed(tail)

        completion = watcher.text
        # Both watchers hold the same generated text, so the shorter answer is
        # a prefix of the longer one and taking it needs no reconciling.
        if scoper is not None and len(scoper.text) < len(completion):
            completion = scoper.text
        confidence = sum(logprobs) / len(logprobs) if logprobs else float("-inf")
        self.last_confidence = confidence
        if report is not None:
            report.update(
                cached=False,
                confidence=confidence,
                stop=watcher.matched,
                trimmed=scoper.reason if scoper is not None else None,
                superseded=bool(ticket is not None and ticket.cancelled),
            )
        # A half-finished answer is not the answer to this prompt, and caching
        # it would hand it to the next request that asks the same question.
        if ticket is not None and ticket.cancelled:
            self._superseded += 1
            return "", count
        if use_cache:
            self.response_cache.put(key, completion)
        return completion, count

    def infill_best_of(
        self,
        prefix: str,
        suffix: str,
        *,
        candidates: int = 4,
        temperature: float = 0.6,
        ticket: Ticket | None = None,
        **options,
    ) -> tuple[str, int]:
        """Sample several completions and return the one the model believed most.

        A weak model at temperature zero is not the same as a weak model at its
        best. Greedy decoding takes the likeliest token at every step, which is
        not the likeliest sequence, and for a suggestion that will be accepted
        or rejected whole, the sequence is what matters.

        Scored first by whether the candidate is finished — every bracket it
        opened closed, and not ending on a character that demands a right-hand
        side — and only then by the model's own confidence. Measured on this
        checkpoint, confidence alone does not separate a good completion from a
        bad one, while `= [` and `sum([1, 2])` come out of the same caret and
        one of them is obviously the one to show.

        Confidence is mean log-probability rather than total, or the shortest
        candidate wins every time by having fewer chances to be wrong.

        Costs `candidates` times as much. Worth it for a completion someone is
        waiting on and reading; not worth it for anything generated in bulk.

        That cost is also why cancellation matters most here: this is the
        request most likely to still be running when the next one arrives, and
        it stops between candidates as well as between tokens.
        """
        if candidates < 1:
            raise ValueError("best-of needs at least one candidate")

        best_text = ""
        best_score: tuple[int, float] = (-1, float("-inf"))
        best_trimmed: str | None = None
        total = 0
        outer = options.pop("report", None)

        for _ in range(candidates):
            if ticket is not None and ticket.cancelled:
                break
            # Caching is off: identical requests would otherwise return the same
            # remembered answer every time and the sampling would do nothing.
            scored: dict = {}
            text, count = self.infill(
                prefix, suffix, temperature=temperature,
                # No remembered answer, or every candidate would be the same
                # one. The prefill is another matter: the prompt is identical
                # for all of them, so reading it once is the whole saving here.
                use_cache=False, reuse_prefill=True,
                report=scored, ticket=ticket, **options,
            )
            total += count
            if not text.strip():
                continue
            score = (int(settled(text)), scored.get("confidence", float("-inf")))
            if score > best_score:
                best_score, best_text = score, text
                # The winner's, not the last one's: a caller asking why the
                # answer is short is asking about the answer it was given.
                best_trimmed = scored.get("trimmed")

        cancelled = bool(ticket is not None and ticket.cancelled)
        if outer is not None:
            outer.update(
                cached=False, confidence=best_score[1],
                # Whether the one that won was finished, which is the thing the
                # caller cannot see from the text alone without redoing the work.
                settled=best_score[0] == 1,
                stop=None, trimmed=best_trimmed, superseded=cancelled,
            )
        # Half a search is not the answer to the question, for the same reason
        # half a generation is not.
        return ("" if cancelled else best_text), total

    def _remember_prefill(self, ids: list[int], caches, length: int) -> None:
        """Store a prefill, unless the prompt was trimmed to fit the context.

        A trimmed prompt's cache describes the tail of `ids` while the cache is
        looked up by leading tokens, so storing it would hand a later request
        keys attached to the wrong positions. Dropping it costs one prefill.
        """
        if length == len(ids):
            self.prefix_cache.store(ids, caches)

    def complete(self, prompt: str, **options) -> tuple[str, int]:
        """Non-streaming generation. Returns the text and the token count.

        Anything else worth knowing goes into `report`, which is passed straight
        through to `stream`.
        """
        pieces: list[str] = []
        count = 0
        for delta, token_id in self.stream(prompt, **options):
            pieces.append(delta)
            if token_id != FLUSH_TOKEN:
                count += 1
        return "".join(pieces), count


# --------------------------------------------------------------------- prompts


def render_messages(system: str | list | None, messages: list[dict]) -> str:
    """Flatten a Messages-shaped conversation into one prompt string.

    The model was trained on plain source text, not on a chat template, so the
    turn markers here are the tokenizer's own specials rather than a format
    borrowed from anyone.
    """
    parts: list[str] = []

    system_text = _flatten_content(system)
    if system_text:
        parts.append(system_text.strip())

    for message in messages:
        role = message.get("role", "user")
        text = _flatten_content(message.get("content"))
        if not text:
            continue
        marker = "<|user|>" if role == "user" else "<|assistant|>"
        parts.append(f"{marker}{text}")

    parts.append("<|assistant|>")
    return "\n".join(parts)


def _stop_fields(matched: str | None, count: int, budget: int) -> dict:
    """The two fields a Messages client reads to know why generation ended.

    Three reasons, in the order they take precedence: a stop sequence matched,
    the budget ran out, or the model stopped on its own. Reporting `end_turn`
    for all three, which this did until the whole chain was run end to end,
    means a client cannot tell "it finished" from "you cut it off".
    """
    if matched is not None:
        return {"stop_reason": "stop_sequence", "stop_sequence": matched}
    if count >= budget:
        return {"stop_reason": "max_tokens", "stop_sequence": None}
    return {"stop_reason": "end_turn", "stop_sequence": None}


def _stop_sequences(body: dict) -> list[str]:
    """Read stop sequences from either name, and bound what they can cost.

    `stop_sequences` is what a Messages client sends and `stop` is what most
    other APIs call it; accepting both costs one line and saves the caller
    finding out which this is. Non-strings are dropped rather than refused,
    because a client that sends a number here meant a string.

    Bounded in count and in length: every stop sequence is searched for in the
    text after every token, and a caller that sends two hundred of them is
    paying for that on every step of every request.
    """
    raw = body.get("stop_sequences", body.get("stop", []))
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    kept = [item for item in raw if isinstance(item, str) and item]
    # A long stop sequence also delays streaming, because that much text has to
    # be held back until it is known not to be the start of one.
    return [item[:64] for item in kept[:8]]


def _flatten_content(content) -> str:
    """Accept the string form and the block-list form of a message body."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces = []
        for block in content:
            if isinstance(block, str):
                pieces.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                pieces.append(str(block.get("text", "")))
        return "\n".join(piece for piece in pieces if piece)
    return str(content)


# ----------------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    """Request routing. `engine` is attached to the server, not the handler."""

    protocol_version = "HTTP/1.1"
    server_version = "CodeCraftLM"

    # Silence the default per-request line; the routes log what matters.
    def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib name
        return

    @property
    def engine(self) -> Engine:
        return self.server.engine  # type: ignore[attr-defined]

    # -------------------------------------------------------------- responding

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: int, kind: str, message: str) -> None:
        self._send_json(status, {"type": "error", "error": {"type": kind, "message": message}})

    def _begin_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # Chunked, because the length is unknown until generation finishes.
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def _send_event(self, name: str, payload: dict) -> None:
        """Write one SSE event as an HTTP chunk."""
        frame = f"event: {name}\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
        self.wfile.write(f"{len(frame):X}\r\n".encode("ascii") + frame + b"\r\n")
        self.wfile.flush()

    def _end_stream(self) -> None:
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def _read_body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_error(400, "invalid_request_error", "Content-Length is not a number")
            return None
        if length > MAX_BODY_BYTES:
            self._send_error(413, "invalid_request_error", "request body is too large")
            return None
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            self._send_error(400, "invalid_request_error", f"body is not valid JSON: {error}")
            return None

    # ----------------------------------------------------------------- routing

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib naming
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type, x-api-key, anthropic-version")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        if self.path in ("/health", "/"):
            self._send_json(200, {"status": "ok", **self.engine.describe()})
        elif self.path == "/v1/models":
            described = self.engine.describe()
            self._send_json(
                200,
                {
                    "data": [
                        {
                            "id": described["model"],
                            "type": "model",
                            "display_name": f"CodeCraft LM ({described['parameters_human']})",
                        }
                    ]
                },
            )
        else:
            self._send_error(404, "not_found_error", f"no route for GET {self.path}")

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        try:
            if self.path.rstrip("/") == "/v1/messages":
                self._handle_messages()
            elif self.path.rstrip("/") == "/generate":
                self._handle_generate()
            elif self.path.rstrip("/") == "/infill":
                self._handle_infill()
            elif self.path.rstrip("/") == "/tokenize":
                self._handle_tokenize()
            else:
                self._send_error(404, "not_found_error", f"no route for POST {self.path}")
        except (BrokenPipeError, ConnectionResetError):
            # The client went away mid-stream. Letting this escape would print a
            # traceback for something entirely normal; raising out of the loop
            # has already closed the generator and freed the lock.
            self.close_connection = True

    # ------------------------------------------------------------- the routes

    def _sampling_options(self, body: dict) -> dict:
        return {
            "max_tokens": max(1, min(int(body.get("max_tokens", DEFAULT_MAX_TOKENS)), 4096)),
            "temperature": float(body.get("temperature", 0.8)),
            "top_k": body.get("top_k", 40),
            "top_p": body.get("top_p", 0.95),
            "repetition_penalty": float(body.get("repetition_penalty", 1.1)),
            "min_p": body.get("min_p"),
            "no_repeat_ngram": max(0, min(int(body.get("no_repeat_ngram", 0)), 16)),
            "stop": _stop_sequences(body),
        }

    def _handle_generate(self) -> None:
        body = self._read_body()
        if body is None:
            return

        prompt = body.get("prompt")
        if not isinstance(prompt, str):
            self._send_error(400, "invalid_request_error", "'prompt' must be a string")
            return

        options = self._sampling_options(body)
        started = time.time()

        if not body.get("stream"):
            text, count = self.engine.complete(prompt, **options)
            self._send_json(
                200,
                {
                    "model": self.engine.name,
                    "prompt": prompt,
                    "completion": text,
                    "tokens": count,
                    "seconds": round(time.time() - started, 3),
                },
            )
            return

        self._begin_stream()
        count = 0
        for delta, token_id in self.engine.stream(prompt, **options):
            if token_id != FLUSH_TOKEN:
                count += 1
            if not delta:
                # A token that only completed part of a character; nothing to
                # show the client until the rest of it arrives.
                continue
            self._send_event("token", {"text": delta, "id": token_id, "index": count})
        self._send_event(
            "done", {"tokens": count, "seconds": round(time.time() - started, 3)}
        )
        self._end_stream()

    def _handle_tokenize(self) -> None:
        """How this tokenizer splits a piece of text.

        Here because a client sizing a prompt has no other way to know. The
        editor budgets context in characters, which is a guess that is wrong by
        a factor of three either way depending on what the code looks like; this
        is the number it was guessing at.

        The pieces are returned as text, with anything that is not valid UTF-8
        on its own replaced: a token can be half a character, and a client
        showing the split would rather see one replacement mark than fail to
        parse the response.
        """
        body = self._read_body()
        if body is None:
            return

        text = body.get("text")
        if not isinstance(text, str):
            self._send_error(400, "invalid_request_error", "'text' must be a string")
            return

        ids = self.engine.tokenizer.encode(text)
        response = {
            "model": self.engine.name,
            "tokens": len(ids),
            "characters": len(text),
            "context": self.engine.model.config.max_seq_len,
        }
        if body.get("pieces"):
            response["ids"] = ids
            response["pieces"] = [
                self.engine.tokenizer.vocab.get(token_id, b"").decode("utf-8", "replace")
                for token_id in ids
            ]
        self._send_json(200, response)

    def _handle_infill(self) -> None:
        """Complete at a caret, with the code on both sides of it."""
        body = self._read_body()
        if body is None:
            return

        prefix = body.get("prefix")
        suffix = body.get("suffix", "")
        if not isinstance(prefix, str) or not isinstance(suffix, str):
            self._send_error(
                400, "invalid_request_error", "'prefix' and 'suffix' must be strings"
            )
            return

        if self.engine.infill_error is not None:
            self._send_error(400, "invalid_request_error", self.engine.infill_error)
            return

        started = time.time()
        # One live completion per source. A client that keeps typing supersedes
        # its own last request rather than queueing behind it; a different
        # client, or the chat route, is a separate conversation and unaffected.
        source = self.headers.get("X-Request-Source") or "infill"
        ticket = self.server.supersede.begin(source)

        # Bounded low: each candidate is a whole generation, and a request that
        # asks for fifty of them is a denial of service with a polite name.
        candidates = max(1, min(int(body.get("candidates", 1)), 8))
        shared = {
            "max_tokens": max(1, min(int(body.get("max_tokens", 64)), 512)),
            "no_repeat_ngram": max(0, min(int(body.get("no_repeat_ngram", 4)), 16)),
            "stop": _stop_sequences(body),
            "scope": bool(body.get("scope", True)),
            "heal": bool(body.get("heal", True)),
            # The caller knows the language and the server does not, so it says
            # what a comment looks like or the rule stays off.
            "line_comment": (
                body["line_comment"]
                if isinstance(body.get("line_comment"), str) and body["line_comment"]
                else None
            ),
        }
        report: dict = {}

        try:
            if candidates > 1:
                text, count = self.engine.infill_best_of(
                    prefix,
                    suffix,
                    candidates=candidates,
                    temperature=float(body.get("temperature", 0.6)),
                    ticket=ticket,
                    report=report,
                    **shared,
                )
            else:
                text, count = self.engine.infill(
                    prefix,
                    suffix,
                    temperature=float(body.get("temperature", 0.2)),
                    ticket=ticket,
                    report=report,
                    **shared,
                )
        finally:
            self.server.supersede.end(ticket)
        self._send_json(
            200,
            {
                "model": self.engine.name,
                "completion": text,
                "tokens": count,
                "candidates": candidates,
                "confidence": round(self.engine.last_confidence, 4),
                # Why the completion ended, when it was not the model's choice:
                # "dedent" and "bracket" for structure, otherwise the stop
                # sequence that matched.
                "trimmed": report.get("trimmed"),
                # Whether the chosen candidate closed what it opened. Only
                # best-of decides anything by it, and only best-of reports it.
                "settled": report.get("settled"),
                "stop": report.get("stop"),
                "superseded": ticket.cancelled,
                "seconds": round(time.time() - started, 3),
            },
        )

    def _handle_messages(self) -> None:
        body = self._read_body()
        if body is None:
            return

        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            self._send_error(400, "invalid_request_error", "'messages' must be a non-empty list")
            return

        prompt = render_messages(body.get("system"), messages)
        options = self._sampling_options(body)
        message_id = f"msg_{uuid.uuid4().hex[:24]}"
        input_tokens = len(self.engine.tokenizer.encode(prompt))

        if not body.get("stream"):
            report: dict = {}
            text, count = self.engine.complete(prompt, report=report, **options)
            self._send_json(
                200,
                {
                    "id": message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.engine.name,
                    "content": [{"type": "text", "text": text}],
                    **_stop_fields(report.get("stop"), count, options["max_tokens"]),
                    "usage": {"input_tokens": input_tokens, "output_tokens": count},
                },
            )
            return

        self._stream_messages(message_id, prompt, options, input_tokens)

    def _stream_messages(
        self, message_id: str, prompt: str, options: dict, input_tokens: int
    ) -> None:
        """Emit the same event sequence the assistant client already parses."""
        self._begin_stream()

        self._send_event(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.engine.name,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": input_tokens, "output_tokens": 0},
                },
            },
        )
        self._send_event(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        )

        count = 0
        last_ping = time.time()
        report: dict = {}
        for delta, token_id in self.engine.stream(prompt, report=report, **options):
            if token_id != FLUSH_TOKEN:
                count += 1
            if not delta:
                continue
            self._send_event(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": delta},
                },
            )
            # A slow CPU run can go quiet for a while; a ping keeps proxies and
            # idle timeouts from closing a connection that is still working.
            if time.time() - last_ping > 10:
                self._send_event("ping", {"type": "ping"})
                last_ping = time.time()

        self._send_event("content_block_stop", {"type": "content_block_stop", "index": 0})
        self._send_event(
            "message_delta",
            {
                "type": "message_delta",
                "delta": _stop_fields(report.get("stop"), count, options["max_tokens"]),
                "usage": {"output_tokens": count},
            },
        )
        self._send_event("message_stop", {"type": "message_stop"})
        self._end_stream()


class ModelServer(ThreadingHTTPServer):
    daemon_threads = True
    # Restarting the server should not have to wait out TIME_WAIT.
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], engine: Engine) -> None:
        super().__init__(address, Handler)
        self.engine = engine
        # Generation is serialised, so a request nobody wants is not merely
        # wasted, it is in front of the one that matters.
        self.supersede = Supersede()
        self._reloader: threading.Thread | None = None
        self._stop_reloading = threading.Event()

    def reload_if_changed(self, watcher: Watcher) -> bool:
        """One poll. True when the engine was replaced.

        Separate from the thread that calls it so the behaviour can be tested
        without waiting on a clock: a test that sleeps for a reload is a test
        that fails on a loaded machine, which is exactly when the suite runs.

        The new engine is built completely before it is swapped in, so a request
        in flight finishes against the weights it started with and the next one
        gets the new ones. A failed load leaves the old engine in place: a
        server that keeps answering with slightly stale weights is better than
        one that stops.
        """
        if not watcher.poll():
            return False

        try:
            replacement = Engine(self.engine.run, str(self.engine.device))
        except Exception as error:  # noqa: BLE001 - any failure means keep the old one
            print(f"reload failed, keeping the running model: {error}")
            return False

        previous = self.engine
        self.engine = replacement
        print(
            f"reloaded at step {replacement.payload.get('step')}, "
            f"val loss {replacement.payload.get('val_loss'):.3f} "
            f"(was step {previous.payload.get('step')})"
        )
        return True

    def watch_checkpoint(self, seconds: float = 5.0) -> None:
        """Poll the checkpoint on an interval, for watching a run improve."""

        def loop() -> None:
            watcher = Watcher(self.engine.run / "model.pt")
            while not self._stop_reloading.wait(seconds):
                self.reload_if_changed(watcher)

        self._reloader = threading.Thread(target=loop, daemon=True, name="reload")
        self._reloader.start()

    def server_close(self) -> None:
        self._stop_reloading.set()
        if self._reloader is not None:
            self._reloader.join(timeout=2)
        super().server_close()


def build_server(
    run: Path,
    host: str = "127.0.0.1",
    port: int = 8940,
    device: str | None = None,
    *,
    quantize: bool = False,
    adapter: Path | None = None,
    reload_seconds: float = 0.0,
) -> ModelServer:
    """Load the checkpoint and bind the socket, without serving yet.

    Split out from `serve` so tests can bind port 0 and drive the server on a
    thread of their own.
    """
    server = ModelServer((host, port), Engine(run, device, quantize=quantize, adapter=adapter))
    if reload_seconds > 0:
        server.watch_checkpoint(reload_seconds)
    return server


def serve(
    run: Path,
    *,
    host: str = "127.0.0.1",
    port: int = 8940,
    device: str | None = None,
    quantize: bool = False,
    adapter: Path | None = None,
    reload_seconds: float = 0.0,
) -> int:
    try:
        server = build_server(
            run, host, port, device, quantize=quantize, adapter=adapter,
            reload_seconds=reload_seconds,
        )
    except FileNotFoundError as error:
        print(f"error: {error}")
        return 1

    described = server.engine.describe()
    bound = server.server_address[1]
    print(
        f"CodeCraft LM  {described['parameters_human']} parameters  "
        f"context {described['context']}  val loss {described['val_loss']:.3f}\n"
        f"running on {described['device']}, precision {described['precision']}"
        + (
            f", int8 weights ({server.engine.quantization.compression:.1f}x smaller)"
            if server.engine.quantization
            else ""
        )
        + (
            f", adapter rank {server.engine.adapter['rank']} merged in"
            if server.engine.adapter
            else ""
        )
        + "\n"
        f"listening on http://{host}:{bound}\n"
        f"  POST /v1/messages   Messages-compatible, set ANTHROPIC_BASE_URL to this\n"
        f"  POST /generate      native prompt completion\n"
        f"  POST /tokenize      how text splits, for a client sizing a prompt\n"
        f"  GET  /health        model card\n"
        + (
            f"  watching {run / 'model.pt'} every {reload_seconds:g}s\n"
            if reload_seconds > 0
            else ""
        )
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        server.shutdown()
        server.server_close()
    return 0
