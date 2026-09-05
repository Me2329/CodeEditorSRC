"""The parameter arithmetic has to match what PyTorch actually allocates."""

from __future__ import annotations

import pytest

from codecraft_model.config import SIZES, ModelConfig, get_size, humanise
from codecraft_model.model import CodeCraftLM


@pytest.mark.parametrize("name", ["micro", "tiny", "small"])
def test_counts_match_a_real_module(name: str) -> None:
    """The reported count is derived from the architecture, so prove it.

    Only the sizes small enough to instantiate on a test machine are built; the
    formula is shared, so a bug here would show up in all of them.
    """
    config = get_size(name)
    model = CodeCraftLM(config)
    assert model.parameter_count() == config.parameter_count()


def test_breakdown_sums_to_the_total() -> None:
    """Nothing may be counted twice or left out of the report."""
    config = get_size("small")
    assert sum(config.parameter_breakdown().values()) == config.parameter_count()


def test_xl_really_is_about_a_billion() -> None:
    count = get_size("xl").parameter_count()
    assert 0.95e9 < count < 1.15e9


def test_untying_adds_one_embedding_matrix() -> None:
    tied = ModelConfig(vocab_size=1000, d_model=64, n_heads=4, n_kv_heads=2, d_ff=128)
    untied = ModelConfig(
        vocab_size=1000, d_model=64, n_heads=4, n_kv_heads=2, d_ff=128, tie_embeddings=False
    )
    assert untied.parameter_count() - tied.parameter_count() == 1000 * 64


def test_grouped_query_attention_is_smaller_than_full() -> None:
    grouped = ModelConfig(d_model=512, n_heads=8, n_kv_heads=2, d_ff=1024)
    full = ModelConfig(d_model=512, n_heads=8, n_kv_heads=8, d_ff=1024)
    assert grouped.parameter_count() < full.parameter_count()


def test_with_vocab_leaves_everything_else_alone() -> None:
    config = get_size("micro").with_vocab(7777)
    assert config.vocab_size == 7777
    assert config.d_model == get_size("micro").d_model


def test_round_trips_through_a_dict() -> None:
    config = get_size("tiny")
    assert ModelConfig.from_dict(config.to_dict()) == config


def test_from_dict_ignores_unknown_keys() -> None:
    """Checkpoints from an older shape must still load."""
    payload = get_size("micro").to_dict() | {"invented_field": 1}
    assert ModelConfig.from_dict(payload).d_model == 128


def test_rejects_shapes_that_cannot_be_built() -> None:
    with pytest.raises(ValueError):
        ModelConfig(d_model=100, n_heads=8)
    with pytest.raises(ValueError):
        ModelConfig(n_heads=8, n_kv_heads=3)
    with pytest.raises(ValueError):
        ModelConfig(n_heads=4, n_kv_heads=8)
    with pytest.raises(ValueError):
        ModelConfig(n_layers=0)


def test_unknown_size_names_the_alternatives() -> None:
    with pytest.raises(KeyError, match="micro"):
        get_size("enormous")


def test_sizes_increase_monotonically() -> None:
    counts = [SIZES[name].parameter_count() for name in ["micro", "tiny", "small", "base"]]
    assert counts == sorted(counts)


def test_training_memory_is_four_times_the_weights() -> None:
    estimate = get_size("micro").memory_estimate_bytes()
    assert estimate["training"] == estimate["weights"] * 4


def test_humanise_uses_model_card_units() -> None:
    assert humanise(999) == "999"
    assert humanise(1_500) == "1.5K"
    assert humanise(1_300_000) == "1.3M"
    assert humanise(1_010_000_000) == "1.01B"
