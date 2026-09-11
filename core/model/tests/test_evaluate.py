"""Measuring a model: what the numbers mean and when they are comparable."""

from __future__ import annotations

import math

import numpy as np
import pytest
import torch

from codecraft_model.config import ModelConfig
from codecraft_model.data import TokenDataset, write_dataset
from codecraft_model.evaluate import measure_perplexity, measure_throughput, report
from codecraft_model.model import CodeCraftLM

CONFIG = ModelConfig(
    vocab_size=64, d_model=64, n_layers=2, n_heads=4, n_kv_heads=2, d_ff=128, max_seq_len=128
)


@pytest.fixture
def dataset(tmp_path):
    write_dataset(np.tile(np.arange(1, 17, dtype=np.uint16), 2000), tmp_path)
    return TokenDataset(tmp_path / "train.bin")


@pytest.fixture
def model():
    torch.manual_seed(0)
    return CodeCraftLM(CONFIG).eval()


# ------------------------------------------------------------------ perplexity


def test_an_untrained_model_is_near_the_uniform_baseline(model, dataset) -> None:
    """log(vocab) is what a model that has learned nothing scores."""
    measured = measure_perplexity(model, dataset, batches=4, batch_size=4, block_size=32)

    assert abs(measured.loss - math.log(CONFIG.vocab_size)) < 1.0


def test_perplexity_is_the_loss_exponentiated(model, dataset) -> None:
    measured = measure_perplexity(model, dataset, batches=3, batch_size=4, block_size=32)
    assert measured.perplexity == pytest.approx(math.exp(measured.loss), rel=1e-6)


def test_bits_per_token_is_the_loss_in_base_two(model, dataset) -> None:
    measured = measure_perplexity(model, dataset, batches=3, batch_size=4, block_size=32)
    assert measured.bits_per_token == pytest.approx(measured.loss / math.log(2), rel=1e-6)


def test_bits_per_character_needs_the_compression_ratio(model, dataset) -> None:
    """Without it the number is not comparable across tokenizers, so it is nan."""
    without = measure_perplexity(model, dataset, batches=2, batch_size=2, block_size=32)
    assert math.isnan(without.bits_per_character)

    with_ratio = measure_perplexity(
        model, dataset, batches=2, batch_size=2, block_size=32, characters_per_token=3.5
    )
    assert with_ratio.bits_per_character == pytest.approx(with_ratio.bits_per_token / 3.5)


def test_the_measurement_is_reproducible(model, dataset) -> None:
    """A fixed seed, so a difference between checkpoints is a real difference."""
    first = measure_perplexity(model, dataset, batches=4, batch_size=4, block_size=32)
    second = measure_perplexity(model, dataset, batches=4, batch_size=4, block_size=32)

    assert first.loss == pytest.approx(second.loss, rel=1e-9)


def test_a_different_seed_gives_a_different_sample(model, dataset) -> None:
    first = measure_perplexity(model, dataset, batches=4, batch_size=4, block_size=32, seed=1)
    second = measure_perplexity(model, dataset, batches=4, batch_size=4, block_size=32, seed=2)

    assert first.loss != second.loss


def test_the_token_count_is_reported(model, dataset) -> None:
    measured = measure_perplexity(model, dataset, batches=5, batch_size=4, block_size=32)
    assert measured.tokens_scored == 5 * 4 * 32


def test_measuring_leaves_a_training_model_in_training_mode(dataset) -> None:
    """Dropout silently off for the rest of a run would be hard to notice."""
    model = CodeCraftLM(CONFIG)
    model.train()

    measure_perplexity(model, dataset, batches=2, batch_size=2, block_size=32)

    assert model.training


def test_an_untrained_model_does_not_report_infinity(dataset) -> None:
    """True, but useless in a table."""
    measured = measure_perplexity(
        CodeCraftLM(CONFIG), dataset, batches=2, batch_size=2, block_size=32
    )
    assert math.isfinite(measured.perplexity)


# ----------------------------------------------------------------- throughput


def test_throughput_reports_both_phases(model) -> None:
    measured = measure_throughput(model, prompt_tokens=32, generate_tokens=8, warmup=1)

    assert measured.prefill_tokens_per_second > 0
    assert measured.decode_tokens_per_second > 0
    assert measured.first_token_ms > 0


def test_prefill_is_faster_per_token_than_decode(model) -> None:
    """Prefill does the whole prompt in one pass; decode does one at a time."""
    measured = measure_throughput(model, prompt_tokens=64, generate_tokens=16, warmup=1)

    assert measured.prefill_tokens_per_second > measured.decode_tokens_per_second


def test_the_prompt_is_capped_to_leave_room_to_generate(model) -> None:
    measured = measure_throughput(model, prompt_tokens=10_000, generate_tokens=8, warmup=0)

    assert measured.prompt_tokens + measured.generated_tokens < CONFIG.max_seq_len


def test_the_counts_are_reported_as_requested(model) -> None:
    measured = measure_throughput(model, prompt_tokens=32, generate_tokens=12, warmup=1)

    assert measured.prompt_tokens == 32
    assert measured.generated_tokens == 12


# --------------------------------------------------------------------- report


def test_a_report_carries_both_halves(model, dataset) -> None:
    perplexity = measure_perplexity(model, dataset, batches=2, batch_size=2, block_size=32)
    throughput = measure_throughput(model, prompt_tokens=16, generate_tokens=4, warmup=0)

    payload = report(perplexity, throughput)

    assert payload["perplexity"]["loss"] > 0
    assert payload["throughput"]["decode_tokens_per_second"] > 0


def test_a_report_tolerates_a_missing_half(model) -> None:
    """A run directory without val.bin still gets throughput numbers."""
    throughput = measure_throughput(model, prompt_tokens=16, generate_tokens=4, warmup=0)
    assert report(None, throughput)["perplexity"] is None
