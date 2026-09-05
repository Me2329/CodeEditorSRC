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

from .config import humanise
from .tokenizer import Tokenizer
from .train import load_checkpoint

# A request body larger than this is a mistake or an attack, not a prompt.
MAX_BODY_BYTES = 4 * 1024 * 1024

DEFAULT_MAX_TOKENS = 512

# Marks text produced by flushing the decoder at the end of a generation rather
# than by a token of its own.
FLUSH_TOKEN = -1


class Engine:
    """A loaded checkpoint, ready to answer requests."""

    def __init__(self, run: Path, device: str = "cpu") -> None:
        checkpoint = run / "model.pt"
        tokenizer_path = run / "tokenizer.json"
        for path in (checkpoint, tokenizer_path):
            if not path.exists():
                raise FileNotFoundError(f"{path} is missing; run prepare and train first")

        self.run = run
        self.tokenizer = Tokenizer.load(tokenizer_path)
        self.model, self.payload = load_checkpoint(checkpoint, device)
        self.device = torch.device(device)

        # PyTorch releases the GIL inside kernels, so two concurrent generations
        # would genuinely run at once and thrash a machine sized for one.
        self.lock = threading.Lock()

        self.name = f"codecraft-{run.name}"
        self.end_token = self.tokenizer.special_id("<|end|>")

    def describe(self) -> dict:
        config = self.model.config
        return {
            "model": self.name,
            "parameters": self.model.parameter_count(),
            "parameters_human": humanise(self.model.parameter_count()),
            "vocab_size": config.vocab_size,
            "context": config.max_seq_len,
            "layers": config.n_layers,
            "d_model": config.d_model,
            "trained_steps": self.payload.get("step"),
            "val_loss": self.payload.get("val_loss"),
        }

    def stream(
        self,
        prompt: str,
        *,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = 0.8,
        top_k: int | None = 40,
        top_p: float | None = 0.95,
        repetition_penalty: float = 1.1,
    ):
        """Yield (text_delta, token_id) pairs for `prompt`.

        Every generated token is yielded, so callers can count them, but the
        delta may be empty: bytes go through an incremental UTF-8 decoder rather
        than being decoded per token, because a multi-byte character can span
        two tokens and decoding each alone would emit a replacement character
        for text that is perfectly valid a moment later.
        """
        ids = self.tokenizer.encode(prompt)
        # Leave room to answer: a prompt that fills the context has nowhere to
        # put the reply, so the oldest tokens go first.
        room = self.model.config.max_seq_len - max(1, min(max_tokens, 64))
        if len(ids) > room:
            ids = ids[-room:]

        tokens = torch.tensor([ids or [self.tokenizer.special_id("<|begin|>")]], dtype=torch.long)

        with self.lock:
            decoder = codecs.getincrementaldecoder("utf-8")("replace")

            for token_id in self.model.generate(
                tokens.to(self.device),
                max_new_tokens=max_tokens,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                repetition_penalty=repetition_penalty,
                stop_tokens={self.end_token},
            ):
                piece = self.tokenizer.vocab.get(token_id)
                yield (decoder.decode(piece) if piece is not None else ""), token_id

            # Flush whatever the decoder was holding. A generation that stops
            # mid-character would otherwise drop those bytes silently. The id is
            # -1 because this text belongs to no single token, which is how
            # callers know not to count it as one.
            tail = decoder.decode(b"", final=True)
            if tail:
                yield tail, FLUSH_TOKEN

    def complete(self, prompt: str, **options) -> tuple[str, int]:
        """Non-streaming generation. Returns the text and the token count."""
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
        if self.path.rstrip("/") == "/v1/messages":
            self._handle_messages()
        elif self.path.rstrip("/") == "/generate":
            self._handle_generate()
        else:
            self._send_error(404, "not_found_error", f"no route for POST {self.path}")

    # ------------------------------------------------------------- the routes

    def _sampling_options(self, body: dict) -> dict:
        return {
            "max_tokens": max(1, min(int(body.get("max_tokens", DEFAULT_MAX_TOKENS)), 4096)),
            "temperature": float(body.get("temperature", 0.8)),
            "top_k": body.get("top_k", 40),
            "top_p": body.get("top_p", 0.95),
            "repetition_penalty": float(body.get("repetition_penalty", 1.1)),
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
            text, count = self.engine.complete(prompt, **options)
            self._send_json(
                200,
                {
                    "id": message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.engine.name,
                    "content": [{"type": "text", "text": text}],
                    # A generator that runs out of budget stopped for length;
                    # one that stopped early hit the end-of-text token.
                    "stop_reason": "max_tokens" if count >= options["max_tokens"] else "end_turn",
                    "stop_sequence": None,
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
        for delta, token_id in self.engine.stream(prompt, **options):
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
                "delta": {
                    "stop_reason": "max_tokens" if count >= options["max_tokens"] else "end_turn",
                    "stop_sequence": None,
                },
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


def build_server(run: Path, host: str = "127.0.0.1", port: int = 8940) -> ModelServer:
    """Load the checkpoint and bind the socket, without serving yet.

    Split out from `serve` so tests can bind port 0 and drive the server on a
    thread of their own.
    """
    return ModelServer((host, port), Engine(run))


def serve(run: Path, *, host: str = "127.0.0.1", port: int = 8940) -> int:
    try:
        server = build_server(run, host, port)
    except FileNotFoundError as error:
        print(f"error: {error}")
        return 1

    described = server.engine.describe()
    bound = server.server_address[1]
    print(
        f"CodeCraft LM  {described['parameters_human']} parameters  "
        f"context {described['context']}  val loss {described['val_loss']:.3f}\n"
        f"listening on http://{host}:{bound}\n"
        f"  POST /v1/messages   Messages-compatible, set ANTHROPIC_BASE_URL to this\n"
        f"  POST /generate      native prompt completion\n"
        f"  GET  /health        model card\n"
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        server.shutdown()
        server.server_close()
    return 0
