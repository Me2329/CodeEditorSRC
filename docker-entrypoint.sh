#!/usr/bin/env bash
# Start the assistant daemon, then the gateway in the foreground.
#
# The daemon is optional, so a failure to start it is reported and the gateway
# still comes up: the editor works without an assistant, and the health endpoint
# says the assistant is not running rather than the container failing outright.
set -uo pipefail

cleanup() {
    [[ -n "${ASSISTANT_PID:-}" ]] && kill "$ASSISTANT_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

if command -v codecraft-assistant >/dev/null 2>&1; then
    codecraft-assistant --socket "${CODECRAFT_ASSISTANT_SOCKET:-/run/codecraft/assistant.sock}" &
    ASSISTANT_PID=$!
else
    echo "[entrypoint] assistant binary not found; continuing without it" >&2
fi

exec python3 -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
