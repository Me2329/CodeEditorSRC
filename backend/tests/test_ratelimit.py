"""Rate limiter behaviour, exercised through the in-memory backend."""

from __future__ import annotations

import asyncio

from app.ratelimit import InMemoryRateLimiter


async def test_allows_up_to_the_limit_then_refuses() -> None:
    limiter = InMemoryRateLimiter(limit=3, window_seconds=60)

    verdicts = [await limiter.check("client-a") for _ in range(4)]

    assert [v.allowed for v in verdicts] == [True, True, True, False]
    assert verdicts[0].remaining == 2
    assert verdicts[3].remaining == 0
    assert verdicts[3].retry_after >= 1


async def test_budgets_are_per_client() -> None:
    limiter = InMemoryRateLimiter(limit=1, window_seconds=60)

    assert (await limiter.check("client-a")).allowed is True
    assert (await limiter.check("client-b")).allowed is True
    assert (await limiter.check("client-a")).allowed is False


async def test_window_resets_after_it_expires() -> None:
    limiter = InMemoryRateLimiter(limit=1, window_seconds=1)

    assert (await limiter.check("client")).allowed is True
    assert (await limiter.check("client")).allowed is False

    await asyncio.sleep(1.05)
    assert (await limiter.check("client")).allowed is True


async def test_concurrent_callers_do_not_exceed_the_limit() -> None:
    """The window reset must not be racy under concurrent access."""
    limiter = InMemoryRateLimiter(limit=5, window_seconds=60)

    verdicts = await asyncio.gather(*(limiter.check("shared") for _ in range(20)))

    assert sum(1 for v in verdicts if v.allowed) == 5
