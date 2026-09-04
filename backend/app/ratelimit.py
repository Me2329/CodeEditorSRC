"""Execution rate limiting.

Redis backs the limiter when it is reachable, so a horizontally scaled
deployment shares one budget. When it is not, the gateway falls back to an
in-process limiter rather than failing open: a single node stays protected, and
the health endpoint reports which backend is live.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from .config import settings

# Atomic increment-and-expire. Doing this in one round trip avoids the classic
# race where two callers both see a fresh key and both reset the window.
_SLIDING_WINDOW_SCRIPT = """
local current = redis.call('INCR', KEYS[1])
if current == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
"""


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    remaining: int
    retry_after: int


class InMemoryRateLimiter:
    """Fixed-window limiter for single-node deployments and tests."""

    backend = "in-memory"

    def __init__(self, limit: int, window_seconds: int) -> None:
        self._limit = limit
        self._window = window_seconds
        self._counters: dict[str, tuple[int, float]] = {}
        self._lock = asyncio.Lock()

    async def check(self, key: str) -> RateLimitResult:
        now = time.monotonic()
        async with self._lock:
            count, window_start = self._counters.get(key, (0, now))
            if now - window_start >= self._window:
                count, window_start = 0, now

            count += 1
            self._counters[key] = (count, window_start)

            # Opportunistic sweep so abandoned keys do not accumulate.
            if len(self._counters) > 4096:
                cutoff = now - self._window
                self._counters = {
                    k: v for k, v in self._counters.items() if v[1] > cutoff
                }

            retry_after = max(1, int(self._window - (now - window_start)))
            return RateLimitResult(
                allowed=count <= self._limit,
                remaining=max(0, self._limit - count),
                retry_after=retry_after,
            )

    async def close(self) -> None:
        self._counters.clear()


class RedisRateLimiter:
    """Shared limiter for multi-node deployments."""

    backend = "redis"

    def __init__(self, client, limit: int, window_seconds: int) -> None:
        self._client = client
        self._limit = limit
        self._window = window_seconds
        self._script = client.register_script(_SLIDING_WINDOW_SCRIPT)

    async def check(self, key: str) -> RateLimitResult:
        current, ttl = await self._script(keys=[f"codecraft:rate:{key}"], args=[self._window])
        retry_after = max(1, int(ttl)) if ttl and ttl > 0 else self._window
        return RateLimitResult(
            allowed=int(current) <= self._limit,
            remaining=max(0, self._limit - int(current)),
            retry_after=retry_after,
        )

    async def close(self) -> None:
        await self._client.aclose()


async def create_rate_limiter():
    """Return a Redis-backed limiter when one is reachable, else in-memory."""
    try:
        import redis.asyncio as redis_asyncio
    except ImportError:
        return InMemoryRateLimiter(settings.rate_limit_requests, settings.rate_limit_window_seconds)

    try:
        client = redis_asyncio.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1.5,
            socket_timeout=1.5,
        )
        await client.ping()
    except Exception:
        # Redis being absent is an expected development condition, not an error.
        return InMemoryRateLimiter(settings.rate_limit_requests, settings.rate_limit_window_seconds)

    return RedisRateLimiter(client, settings.rate_limit_requests, settings.rate_limit_window_seconds)
