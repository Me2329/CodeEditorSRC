"""Averaging checkpoints: the cheapest improvement a small model can have."""

from __future__ import annotations

import pytest
import torch

from codecraft_model.average import average_checkpoints
from codecraft_model.model import CodeCraftLM, ModelConfig
from codecraft_model.train import TrainConfig, save_checkpoint

CONFIG = ModelConfig(
    vocab_size=64, d_model=32, n_layers=1, n_heads=4, n_kv_heads=2, d_ff=64, max_seq_len=16
)


def write(path, model, step=0, val_loss=1.0):
    save_checkpoint(path, model, None, step, val_loss, TrainConfig())
    return path


@pytest.fixture
def two(tmp_path):
    """Two checkpoints of one architecture, with different weights."""
    torch.manual_seed(0)
    first = CodeCraftLM(CONFIG)
    torch.manual_seed(1)
    second = CodeCraftLM(CONFIG)
    return (
        write(tmp_path / "a.pt", first, step=100, val_loss=2.0),
        write(tmp_path / "b.pt", second, step=200, val_loss=1.8),
        first,
        second,
    )


def test_the_average_is_the_midpoint(two) -> None:
    first_path, second_path, first, second = two

    averaged, _, _ = average_checkpoints([first_path, second_path])

    expected = (
        first.state_dict()["blocks.0.attention.q_proj.weight"]
        + second.state_dict()["blocks.0.attention.q_proj.weight"]
    ) / 2
    assert torch.allclose(averaged["blocks.0.attention.q_proj.weight"], expected, atol=1e-6)


def test_weights_lean_the_average(two) -> None:
    """For the common case: the best checkpoint smoothed by its neighbours."""
    first_path, second_path, first, second = two

    averaged, _, _ = average_checkpoints([first_path, second_path], [3.0, 1.0])

    expected = (
        first.state_dict()["final_norm.weight"] * 0.75
        + second.state_dict()["final_norm.weight"] * 0.25
    )
    assert torch.allclose(averaged["final_norm.weight"], expected, atol=1e-6)


def test_weights_are_relative_rather_than_absolute(two) -> None:
    first_path, second_path, _, _ = two

    a, _, _ = average_checkpoints([first_path, second_path], [1.0, 1.0])
    b, _, _ = average_checkpoints([first_path, second_path], [50.0, 50.0])

    assert torch.allclose(a["final_norm.weight"], b["final_norm.weight"], atol=1e-6)


def test_the_result_is_a_model_that_runs(two) -> None:
    first_path, second_path, _, _ = two

    averaged, config, _ = average_checkpoints([first_path, second_path])
    model = CodeCraftLM(config)
    model.load_state_dict(averaged)

    logits, _, _ = model(torch.randint(1, CONFIG.vocab_size, (1, 4)))
    assert logits.shape[-1] == CONFIG.vocab_size


def test_what_went_in_is_recorded(two) -> None:
    first_path, second_path, _, _ = two

    _, _, record = average_checkpoints([first_path, second_path])

    assert [source["step"] for source in record["sources"]] == [100, 200]
    assert record["sources"][0]["val_loss"] == 2.0
    assert sum(source["weight"] for source in record["sources"]) == pytest.approx(1.0)


# --------------------------------------------------------------- what it refuses


def test_averaging_different_architectures_is_refused(tmp_path) -> None:
    """The point between two basins is worse than either, often much worse.

    Refusing is the only useful answer, because the alternative loads and
    answers nonsense.
    """
    write(tmp_path / "a.pt", CodeCraftLM(CONFIG))
    wider = ModelConfig(**{**CONFIG.to_dict(), "d_model": 64})
    write(tmp_path / "b.pt", CodeCraftLM(wider))

    with pytest.raises(ValueError, match="different architecture"):
        average_checkpoints([tmp_path / "a.pt", tmp_path / "b.pt"])


def test_averaging_nothing_is_refused() -> None:
    with pytest.raises(ValueError, match="nothing to average"):
        average_checkpoints([])


def test_a_weight_for_every_checkpoint_is_required(two) -> None:
    first_path, second_path, _, _ = two

    with pytest.raises(ValueError, match="2 checkpoints"):
        average_checkpoints([first_path, second_path], [1.0])


def test_weights_that_cancel_are_refused(two) -> None:
    first_path, second_path, _, _ = two

    with pytest.raises(ValueError, match="more than zero"):
        average_checkpoints([first_path, second_path], [1.0, -1.0])


def test_one_checkpoint_averages_to_itself(tmp_path) -> None:
    """Degenerate but worth pinning: the mean of one thing is that thing."""
    torch.manual_seed(0)
    model = CodeCraftLM(CONFIG)
    path = write(tmp_path / "a.pt", model)

    averaged, _, _ = average_checkpoints([path])

    assert torch.allclose(
        averaged["final_norm.weight"], model.state_dict()["final_norm.weight"], atol=1e-6
    )
