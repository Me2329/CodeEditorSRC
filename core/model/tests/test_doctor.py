"""What a machine can do, worked out before a week is spent finding out."""

import pytest

from codecraft_model.config import get_size
from codecraft_model.doctor import (
    TOKENS_PER_PARAMETER,
    describe_bytes,
    describe_recommendation,
    disk_budget,
    free_disk_bytes,
    largest_servable,
    largest_trainable,
)


def test_a_16gb_card_trains_2b_and_only_the_hard_way():
    found = largest_trainable(16e9)

    assert found is not None
    assert found.name == "xxl"
    assert "--fused-step" in found.detail


def test_a_bigger_card_reaches_the_same_size_the_plain_way():
    """There is no reason to recommend giving up momentum when it fits."""
    plain = largest_trainable(80e9)

    assert plain is not None
    assert plain.name == "max"
    assert plain.detail == "--optimizer adafactor"


def test_running_a_model_reaches_further_than_training_one():
    """Serving holds one copy of the weights rather than four."""
    card = 16e9
    trains = largest_trainable(card)
    runs = largest_servable(card)

    assert trains is not None and runs is not None
    assert runs.parameters > trains.parameters


def test_a_small_card_still_runs_something_large_by_quantizing():
    found = largest_servable(6e9)

    assert found is not None
    assert found.detail == "--quantize"


def test_a_machine_too_small_for_anything_is_told_so():
    assert largest_trainable(1e6) is None
    assert "not enough memory" in describe_recommendation(None, "trains")


def test_the_disk_budget_is_two_checkpoints_and_a_matching_corpus():
    config = get_size("xl")
    budget = disk_budget(config)

    assert budget.corpus_tokens == config.parameter_count() * TOKENS_PER_PARAMETER
    # uint16 per token.
    assert budget.corpus_bytes == budget.corpus_tokens * 2
    assert budget.both_checkpoints_bytes == budget.checkpoint_bytes * 2
    assert budget.total_bytes == budget.both_checkpoints_bytes + budget.corpus_bytes


def test_a_checkpoint_is_the_weights_and_whatever_the_optimiser_keeps():
    config = get_size("xl")
    factored = disk_budget(config, optimizer="adafactor").checkpoint_bytes
    full = disk_budget(config, optimizer="adamw").checkpoint_bytes

    # AdamW's two extra copies triple what has to be written.
    assert full > factored * 2.5
    assert factored == pytest.approx(config.parameter_count() * 4, rel=0.01)


def test_sizes_are_said_the_way_a_disk_is_measured():
    assert describe_bytes(4_000_000_000) == "4.0GB"
    assert describe_bytes(400_000_000) == "400MB"
    assert describe_bytes(2_000_000_000_000) == "2.0TB"
    assert describe_bytes(None) == "unknown"


def test_free_space_is_asked_of_the_filesystem(tmp_path):
    assert free_disk_bytes(tmp_path) is not None


def test_a_path_that_does_not_exist_reports_nothing_rather_than_raising(tmp_path):
    assert free_disk_bytes(tmp_path / "nowhere" / "at" / "all") is None
