"""Reusing work between requests that share a prefix."""

from __future__ import annotations

import pytest
import torch

from codecraft_model.cache import (
    PrefixCache,
    ResponseCache,
    shared_prefix_length,
)


def fake_caches(length: int, layers: int = 2) -> list[tuple[torch.Tensor, torch.Tensor]]:
    """Key/value tensors shaped the way the model produces them."""
    return [
        (torch.randn(1, 2, length, 8), torch.randn(1, 2, length, 8)) for _ in range(layers)
    ]


# ------------------------------------------------------------------ prefixes


def test_a_shared_prefix_is_counted() -> None:
    assert shared_prefix_length([1, 2, 3, 4], [1, 2, 9, 9]) == 2


def test_identical_sequences_share_everything() -> None:
    assert shared_prefix_length([1, 2, 3], [1, 2, 3]) == 3


def test_a_shorter_sequence_bounds_the_count() -> None:
    assert shared_prefix_length([1, 2], [1, 2, 3, 4]) == 2


def test_nothing_in_common_is_zero() -> None:
    assert shared_prefix_length([1], [2]) == 0


def test_an_empty_sequence_shares_nothing() -> None:
    assert shared_prefix_length([], [1, 2]) == 0


# --------------------------------------------------------------- prefix cache


def test_an_empty_cache_offers_nothing() -> None:
    assert PrefixCache().take([1, 2, 3]) is None


def test_a_request_extending_a_stored_one_reuses_it() -> None:
    """The case behind a caret: last request plus one more token."""
    cache = PrefixCache(minimum_reuse=4)
    tokens = list(range(20))
    cache.store(tokens, fake_caches(20))

    taken = cache.take(tokens + [99])

    assert taken is not None
    trimmed, shared = taken
    assert shared == 20
    assert trimmed[0][0].shape[2] == 20


def test_a_diverging_request_reuses_only_the_common_part() -> None:
    cache = PrefixCache(minimum_reuse=4)
    cache.store(list(range(20)), fake_caches(20))

    taken = cache.take([*range(10), 900, 901, 902])

    assert taken is not None
    assert taken[1] == 10


def test_too_little_in_common_is_not_worth_reusing() -> None:
    """Below the threshold, rebuilding beats slicing and copying."""
    cache = PrefixCache(minimum_reuse=16)
    cache.store(list(range(20)), fake_caches(20))

    assert cache.take([0, 1, 2, 500]) is None


def test_an_identical_request_leaves_a_token_to_run() -> None:
    """Reusing everything would leave nothing to score."""
    cache = PrefixCache(minimum_reuse=4)
    tokens = list(range(20))
    cache.store(tokens, fake_caches(20))

    taken = cache.take(tokens)

    assert taken is not None
    assert taken[1] == len(tokens) - 1


def test_the_trim_is_a_view_rather_than_a_copy() -> None:
    """Key/value tensors are large; copying them would undo the saving."""
    cache = PrefixCache(minimum_reuse=4)
    caches = fake_caches(20)
    cache.store(list(range(20)), caches)

    trimmed, _ = cache.take(list(range(20)) + [99])

    # A view shares storage with what it was sliced from.
    assert trimmed[0][0].data_ptr() == cache.caches[0][0].data_ptr()


def test_stored_tensors_are_detached() -> None:
    """Otherwise the autograd graph stays alive for the life of the server."""
    cache = PrefixCache()
    caches = [(torch.randn(1, 2, 4, 8, requires_grad=True), torch.randn(1, 2, 4, 8))]
    cache.store([1, 2, 3, 4], caches)

    assert not cache.caches[0][0].requires_grad


def test_storing_again_replaces_what_was_there() -> None:
    cache = PrefixCache(minimum_reuse=2)
    cache.store([1, 2, 3, 4, 5, 6], fake_caches(6))
    cache.store([7, 8, 9, 10, 11, 12], fake_caches(6))

    assert cache.take([1, 2, 3, 4, 5, 6, 13]) is None
    assert cache.take([7, 8, 9, 10, 11, 12, 13]) is not None


def test_clearing_empties_it() -> None:
    cache = PrefixCache(minimum_reuse=2)
    cache.store([1, 2, 3, 4], fake_caches(4))
    cache.clear()

    assert cache.take([1, 2, 3, 4, 5]) is None


# ------------------------------------------------------------- response cache


def test_a_stored_answer_comes_back() -> None:
    cache = ResponseCache()
    key = ResponseCache.key("def f(", "):\n", temperature=0.2)
    cache.put(key, "x")

    assert cache.get(key) == "x"


def test_a_different_prompt_is_a_miss() -> None:
    cache = ResponseCache()
    cache.put(ResponseCache.key("a", "b"), "x")

    assert cache.get(ResponseCache.key("c", "d")) is None


def test_sampling_settings_are_part_of_the_question() -> None:
    """The same prompt at temperature zero and at one are different questions."""
    cache = ResponseCache()
    cache.put(ResponseCache.key("a", "b", temperature=0.0), "cold")

    assert cache.get(ResponseCache.key("a", "b", temperature=1.0)) is None


def test_option_order_does_not_change_the_key() -> None:
    assert ResponseCache.key("a", "b", x=1, y=2) == ResponseCache.key("a", "b", y=2, x=1)


def test_the_oldest_entry_is_evicted_first() -> None:
    cache = ResponseCache(capacity=2)
    for name in ("a", "b", "c"):
        cache.put(ResponseCache.key(name, ""), name)

    assert cache.get(ResponseCache.key("a", "")) is None
    assert cache.get(ResponseCache.key("c", "")) == "c"
    assert cache.stats.evictions == 1


def test_reading_an_entry_keeps_it_alive() -> None:
    """The caret returns to where it was far more often than it goes somewhere new."""
    cache = ResponseCache(capacity=2)
    cache.put(ResponseCache.key("a", ""), "a")
    cache.put(ResponseCache.key("b", ""), "b")

    cache.get(ResponseCache.key("a", ""))
    cache.put(ResponseCache.key("c", ""), "c")

    assert cache.get(ResponseCache.key("a", "")) == "a"
    assert cache.get(ResponseCache.key("b", "")) is None


def test_the_hit_rate_is_reported() -> None:
    cache = ResponseCache()
    cache.put(ResponseCache.key("a", ""), "a")
    cache.get(ResponseCache.key("a", ""))
    cache.get(ResponseCache.key("b", ""))

    assert cache.stats.hit_rate == pytest.approx(0.5)


def test_a_cache_with_no_capacity_is_refused() -> None:
    with pytest.raises(ValueError, match="not a cache"):
        ResponseCache(capacity=0)
