"""Cross entropy computed a piece at a time, which has to agree with one pass."""

from __future__ import annotations

import pytest
import torch
import torch.nn.functional as F
from torch import nn

from codecraft_model.loss import (
    DEFAULT_CHUNK,
    chunked_cross_entropy,
    chunked_logit_bytes,
    logit_bytes,
)

VOCAB = 97
WIDTH = 32


def build(dtype: torch.dtype = torch.float32):
    torch.manual_seed(0)
    head = nn.Linear(WIDTH, VOCAB, bias=False).to(dtype)
    hidden = torch.randn(3, 20, WIDTH, dtype=dtype, requires_grad=True)
    targets = torch.randint(0, VOCAB, (3, 20))
    return head, hidden, targets


def reference(head, hidden, targets, ignore_index=0):
    return F.cross_entropy(
        head(hidden).reshape(-1, VOCAB), targets.reshape(-1), ignore_index=ignore_index
    )


def test_the_value_is_exact_in_double_precision():
    """Where rounding cannot hide a real difference, there is none."""
    head, hidden, targets = build(torch.float64)
    assert torch.equal(
        reference(head, hidden, targets),
        chunked_cross_entropy(head, hidden, targets, chunk_size=7),
    )


def test_the_gradient_is_exact_in_double_precision():
    head, hidden, targets = build(torch.float64)

    reference(head, hidden, targets).backward()
    wanted = hidden.grad.clone()
    hidden.grad = None

    chunked_cross_entropy(head, hidden, targets, chunk_size=7).backward()
    assert torch.equal(wanted, hidden.grad)


def test_float32_agrees_to_within_reassociation():
    """Summing in a different order rounds differently, and only that."""
    head, hidden, targets = build()
    wanted = reference(head, hidden, targets)
    got = chunked_cross_entropy(head, hidden, targets, chunk_size=7)
    # Close, and not promised to be closer: float32 bit-exactness would be a
    # property of the summation order, which chunking deliberately changes.
    assert torch.allclose(wanted, got, rtol=1e-6, atol=1e-6)


def test_the_answer_does_not_depend_on_the_chunk_size():
    head, hidden, targets = build(torch.float64)
    sizes = [1, 3, 7, 20, 60, 1000]
    values = [
        chunked_cross_entropy(head, hidden, targets, chunk_size=size).item()
        for size in sizes
    ]
    for value in values[1:]:
        assert value == pytest.approx(values[0], abs=1e-12)


def test_one_chunk_is_the_whole_thing():
    head, hidden, targets = build(torch.float64)
    whole = chunked_cross_entropy(head, hidden, targets, chunk_size=10_000)
    assert torch.equal(reference(head, hidden, targets), whole)


def test_ignored_targets_do_not_count_towards_the_mean():
    """The division is by the tokens that counted, once, at the end."""
    head, hidden, _ = build(torch.float64)
    targets = torch.randint(1, VOCAB, (3, 20))
    targets[0, :10] = 0  # padding

    assert torch.equal(
        reference(head, hidden, targets),
        chunked_cross_entropy(head, hidden, targets, chunk_size=7),
    )


def test_padding_that_falls_on_a_chunk_boundary_is_still_ignored():
    head, hidden, _ = build(torch.float64)
    targets = torch.randint(1, VOCAB, (3, 20))
    targets[:, ::7] = 0

    assert torch.equal(
        reference(head, hidden, targets),
        chunked_cross_entropy(head, hidden, targets, chunk_size=7),
    )


def test_a_batch_of_nothing_but_padding_is_zero_rather_than_nan():
    """`F.cross_entropy` returns NaN here, and one NaN poisons a whole run."""
    head, hidden, _ = build(torch.float64)
    targets = torch.zeros(3, 20, dtype=torch.long)

    assert torch.isnan(reference(head, hidden, targets))
    result = chunked_cross_entropy(head, hidden, targets, chunk_size=7)
    assert result.item() == 0.0
    # And it still has a gradient path, so a step does not fall over.
    result.backward()
    assert hidden.grad is not None


def test_recomputation_can_be_turned_off_and_changes_nothing():
    head, hidden, targets = build(torch.float64)
    assert torch.equal(
        chunked_cross_entropy(head, hidden, targets, chunk_size=7, recompute=True),
        chunked_cross_entropy(head, hidden, targets, chunk_size=7, recompute=False),
    )


def test_it_works_without_a_gradient_at_all():
    head, hidden, targets = build(torch.float64)
    with torch.no_grad():
        plain = hidden.detach()
        assert torch.equal(
            reference(head, plain, targets),
            chunked_cross_entropy(head, plain, targets, chunk_size=7),
        )


def test_a_chunk_has_to_hold_something():
    head, hidden, targets = build()
    with pytest.raises(ValueError, match="at least one token"):
        chunked_cross_entropy(head, hidden, targets, chunk_size=0)


def test_mismatched_targets_are_refused_where_they_are_noticed():
    head, hidden, _ = build()
    with pytest.raises(ValueError, match="hidden states"):
        chunked_cross_entropy(head, hidden, torch.zeros(3, 19, dtype=torch.long))


def test_the_default_chunk_is_a_sensible_size():
    assert 128 <= DEFAULT_CHUNK <= 4096


def test_the_arithmetic_that_justifies_it():
    """What the whole sequence would cost, against what one piece costs."""
    whole = logit_bytes(batch=4, sequence=1024, vocab_size=32768)
    piece = chunked_logit_bytes(chunk_size=512, vocab_size=32768)
    assert whole == 4 * 1024 * 32768 * 4
    assert piece * 8 == whole


def test_a_short_run_trains_the_same_either_way():
    """The claim that matters: a run using this is comparable with one that is not.

    Twelve optimiser steps, the same seed, the same data. If chunking changed
    the trajectory at all the difference would compound, and a run trained with
    it would not be comparable with one trained without — the difference would
    show up as a hyperparameter nobody changed.
    """
    from codecraft_model.config import ModelConfig
    from codecraft_model.model import CodeCraftLM
    from codecraft_model.train import TrainConfig, build_optimizer

    def run(chunk: int | None) -> list[float]:
        torch.manual_seed(1234)
        config = ModelConfig(
            vocab_size=512, d_model=64, n_layers=2, n_heads=4,
            n_kv_heads=2, d_ff=128, max_seq_len=64,
        )
        model = CodeCraftLM(config)
        model.loss_chunk_size = chunk
        model.train()
        optimizer = build_optimizer(model, TrainConfig(learning_rate=1e-3))
        generator = torch.Generator().manual_seed(7)
        losses = []
        for _ in range(12):
            inputs = torch.randint(1, 512, (4, 32), generator=generator)
            targets = torch.randint(1, 512, (4, 32), generator=generator)
            optimizer.zero_grad(set_to_none=True)
            _, loss, _ = model(inputs, targets=targets)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses.append(loss.item())
        return losses

    whole = run(None)
    pieces = run(16)
    for step, (left, right) in enumerate(zip(whole, pieces)):
        assert left == pytest.approx(right, abs=1e-5), f"diverged at step {step}"


def test_chunking_returns_no_logits_because_none_were_kept():
    """Not holding them is the point, so the caller is not handed any."""
    from codecraft_model.config import ModelConfig
    from codecraft_model.model import CodeCraftLM

    config = ModelConfig(
        vocab_size=128, d_model=32, n_layers=1, n_heads=4,
        n_kv_heads=2, d_ff=64, max_seq_len=16,
    )
    model = CodeCraftLM(config)
    tokens = torch.randint(1, 128, (2, 8))

    model.loss_chunk_size = 4
    logits, loss, _ = model(tokens, targets=tokens)
    assert logits is None
    assert loss is not None

    model.loss_chunk_size = None
    logits, loss, _ = model(tokens, targets=tokens)
    assert logits is not None


def test_asking_for_every_logit_overrides_chunking():
    """A caller that scores the output itself needs the logits, chunked or not."""
    from codecraft_model.config import ModelConfig
    from codecraft_model.model import CodeCraftLM

    config = ModelConfig(
        vocab_size=128, d_model=32, n_layers=1, n_heads=4,
        n_kv_heads=2, d_ff=64, max_seq_len=16,
    )
    model = CodeCraftLM(config)
    model.loss_chunk_size = 4
    logits, _, _ = model(torch.randint(1, 128, (2, 8)), project_all=True)
    assert logits is not None
    assert logits.shape == (2, 8, 128)
