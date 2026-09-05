"""Prove the assistant daemon can answer from our own weights.

Starts the model server, starts the Rust assistant daemon pointed at it through
`ANTHROPIC_BASE_URL`, drives the daemon's Unix socket, and prints what comes
back. Nothing is stubbed: the text below is produced by the checkpoint in the
run directory, streamed through the same client that talks to a hosted model.

    python verify_assistant.py --run runs/demo

Exits non-zero if the daemon reports the model unavailable or the reply is
empty, so this is usable as a check rather than only as a demonstration.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DAEMON = REPO / "core" / "assistant" / "target" / "debug" / "codecraft-assistant"
RELEASE_DAEMON = REPO / "core" / "assistant" / "target" / "release" / "codecraft-assistant"


def wait_for_port(port: int, timeout: float = 120.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return
        except OSError:
            time.sleep(0.2)
    raise SystemExit(f"the model server never listened on {port}")


def wait_for_socket(path: Path, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.exists():
            return
        time.sleep(0.2)
    raise SystemExit(f"the assistant daemon never created {path}")


def request(path: Path, payload: dict, timeout: float = 300.0) -> list[dict]:
    """Send one request and collect the frames until the socket closes."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    client.connect(str(path))
    client.sendall((json.dumps(payload) + "\n").encode())
    # The daemon reads to end-of-stream, so the write side has to close.
    client.shutdown(socket.SHUT_WR)

    buffer = b""
    frames: list[dict] = []
    while True:
        chunk = client.recv(65536)
        if not chunk:
            break
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if line.strip():
                frames.append(json.loads(line))
    client.close()
    return frames


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", default="runs/demo", help="the run directory to serve")
    parser.add_argument("--port", type=int, default=8941)
    parser.add_argument("--prompt", default="def parse(text):")
    parser.add_argument("--socket", default="/var/tmp/codecraft-verify.sock")
    args = parser.parse_args(argv)

    daemon_binary = DAEMON if DAEMON.exists() else RELEASE_DAEMON
    if not daemon_binary.exists():
        print("the assistant daemon is not built; run 'make assistant' first", file=sys.stderr)
        return 1

    socket_path = Path(args.socket)
    socket_path.unlink(missing_ok=True)

    server = subprocess.Popen(
        [sys.executable, "-m", "codecraft_model", "serve", "--run", args.run,
         "--port", str(args.port)],
        cwd=HERE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    daemon = None

    try:
        wait_for_port(args.port)
        print(f"model server listening on {args.port}")

        environment = os.environ | {
            "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{args.port}",
            # The local server does not authenticate; the client needs some
            # credential or it refuses to make the request at all.
            "ANTHROPIC_API_KEY": "local",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
        daemon = subprocess.Popen(
            [str(daemon_binary), "--socket", str(socket_path), "--model", "codecraft-local"],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )
        wait_for_socket(socket_path)
        print("assistant daemon listening\n")

        health = request(socket_path, {"op": "health"})[0]
        print(f"daemon reports model '{health['model']}', reachable: {health['remote_available']}")
        if not health["remote_available"]:
            print(f"  {health['remote_reason']}", file=sys.stderr)
            return 1

        frames = request(
            socket_path,
            {
                "op": "chat",
                "route": "remote",
                "messages": [{"role": "user", "content": args.prompt}],
                "workspace": {
                    "language": "python",
                    "active_file": "main.py",
                    "files": [{"name": "main.py", "content": args.prompt + "\n"}],
                },
            },
        )

        text = "".join(frame["text"] for frame in frames if frame["type"] == "delta")
        done = next((frame for frame in frames if frame["type"] == "done"), None)
        error = next((frame for frame in frames if frame["type"] == "error"), None)

        if error is not None:
            print(f"daemon returned an error: {error['message']}", file=sys.stderr)
            return 1
        if not text.strip():
            print("the model produced nothing", file=sys.stderr)
            return 1

        usage = (done or {}).get("usage") or {}
        print(
            f"\n{usage.get('output_tokens', 0)} tokens in "
            f"{(done or {}).get('elapsed_ms', 0)}ms, from local weights:\n"
        )
        print(text)
        return 0
    finally:
        if daemon is not None:
            daemon.terminate()
        server.terminate()
        socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
