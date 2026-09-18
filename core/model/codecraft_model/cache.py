"""Reusing work between requests that share a prefix.

An editor asking for inline completions sends almost the same prompt every
time. The user types one character, and the next request is the previous one
plus a token. Prefilling that from scratch re-reads a context that has not
changed, which at 256 tokens of prompt is most of the time spent.

Two caches, for two different kinds of repetition.

A prefix cache keeps the key/value tensors from a previous prefill, so a
request extending an earlier one starts from where that one finished and pays
only for the new tokens. This is the one that matters behind a caret.

A response cache keeps whole answers, so a request identical to a recent one
returns immediately. That happens more than it sounds: a user moves the caret
away and back, or an editor re-requests after a cancelled attempt.

Both are bounded. An unbounded cache in a long-running server is a memory leak
with extra steps.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass

import torch


@dataclass
class CacheStats:
    hits: int = 0
    misses: int = 0
    partial: int = 0
    evictions: int = 0

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total else 0.0


def shared_prefix_length(left: list[int], right: list[int]) -> int:
    """How many leading tokens two sequences agree on."""
    limit = min(len(left), len(right))
    for index in range(limit):
        if left[index] != right[index]:
            return index
    return limit


class PrefixCache:
    """One remembered prefill, reusable by any request that extends it.

    Deliberately holds a single entry rather than many. The access pattern
    behind a caret is one conversation growing, not many independent ones, and
    key/value tensors are large enough that keeping several is a real memory
    cost for a case that does not arise.
    """

    def __init__(self, minimum_reuse: int = 16) -> None:
        # Below this, rebuilding is cheaper than slicing and copying the cache.
        self.minimum_reuse = minimum_reuse
        self.tokens: list[int] = []
        self.caches: list[tuple[torch.Tensor, torch.Tensor]] | None = None
        self.stats = CacheStats()

    def reusable(self, tokens: list[int]) -> int:
        """How many of `tokens` a stored prefill already covers."""
        if self.caches is None:
            return 0

        shared = shared_prefix_length(self.tokens, tokens)
        # The whole request already being cached is not reuse: there would be
        # nothing left to run, and the caller needs at least one token to score.
        if shared >= len(tokens):
            shared = len(tokens) - 1

        return shared if shared >= self.minimum_reuse else 0

    def take(self, tokens: list[int]) -> tuple[list[tuple[torch.Tensor, torch.Tensor]], int] | None:
        """Caches trimmed to the shared prefix, and how many tokens they cover."""
        shared = self.reusable(tokens)
        if shared == 0 or self.caches is None:
            self.stats.misses += 1
            return None

        self.stats.partial += 1
        # Trimmed along the sequence axis, which is where a key/value cache
        # grows. Copying is avoided: these are views into the stored tensors.
        trimmed = [(keys[:, :, :shared, :], values[:, :, :shared, :]) for keys, values in self.caches]
        return trimmed, shared

    def store(self, tokens: list[int], caches: list[tuple[torch.Tensor, torch.Tensor]]) -> None:
        """Replace what is remembered. Detached, or the graph is kept alive."""
        self.tokens = list(tokens)
        self.caches = [(keys.detach(), values.detach()) for keys, values in caches]

    def clear(self) -> None:
        self.tokens = []
        self.caches = None


class ResponseCache:
    """Whole answers, keyed by the request that produced them.

    Least-recently-used, because the caret moves back to where it was far more
    often than it visits somewhere at random.
    """

    def __init__(self, capacity: int = 64) -> None:
        if capacity < 1:
            raise ValueError("a cache with no capacity is not a cache")
        self.capacity = capacity
        self.entries: OrderedDict[tuple, str] = OrderedDict()
        self.stats = CacheStats()

    @staticmethod
    def key(prefix: str, suffix: str, **options) -> tuple:
        """Everything that changes the answer, and nothing that does not.

        Sampling settings are part of the key: the same prompt at temperature
        zero and at one are different questions.
        """
        return (prefix, suffix, tuple(sorted(options.items())))

    def get(self, key: tuple) -> str | None:
        if key not in self.entries:
            self.stats.misses += 1
            return None

        self.stats.hits += 1
        self.entries.move_to_end(key)
        return self.entries[key]

    def put(self, key: tuple, value: str) -> None:
        if key in self.entries:
            self.entries.move_to_end(key)
        self.entries[key] = value

        while len(self.entries) > self.capacity:
            self.entries.popitem(last=False)
            self.stats.evictions += 1

    def clear(self) -> None:
        self.entries.clear()
