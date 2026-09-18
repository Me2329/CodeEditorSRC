"""Which attention kernel a card will use, which no README can know."""

from __future__ import annotations

import torch

from codecraft_model.config import ModelConfig
from codecraft_model.kernels import (
    BACKENDS,
    Support,
    attention_support,
    describe_attention,
)

CONFIG = ModelConfig(
    vocab_size=64, d_model=64, n_layers=2, n_heads=8, n_kv_heads=2,
    d_ff=128, max_seq_len=64,
)


def test_off_a_card_there_is_nothing_to_choose_between():
    """One implementation, so reporting a choice would invent a distinction."""
    assert attention_support(CONFIG, torch.device("cpu")) is None


def test_the_chosen_backend_is_the_first_that_fits():
    assert Support(flash=True, cudnn=True, efficient=True).chosen == "flash"
    assert Support(flash=False, cudnn=True, efficient=True).chosen == "cudnn"
    assert Support(flash=False, cudnn=False, efficient=True).chosen == "efficient"


def test_nothing_fits_means_the_unfused_kernel():
    nothing = Support(flash=False, cudnn=False, efficient=False)
    assert nothing.chosen == "math"
    assert not nothing.fused


def test_any_fused_kernel_counts_as_fused():
    assert Support(flash=False, cudnn=False, efficient=True).fused


def test_the_ordinary_case_says_what_runs():
    every = Support(True, True, True)
    assert describe_attention(every, every) == (
        "attention: flash, with the shared heads folded into the kernel"
    )


def test_losing_every_fused_kernel_is_called_out():
    nothing = Support(False, False, False)
    described = describe_attention(nothing, nothing)
    assert "unfused" in described
    assert "before a long run" in described


def test_a_fold_that_costs_the_fused_path_recommends_the_copy():
    """The copy grouped query attention exists to avoid is worth it here."""
    described = describe_attention(Support(False, False, False), Support(True, False, True))
    assert "not fused here" in described
    assert "the faster of the two" in described


def test_a_fold_that_costs_a_better_kernel_says_to_measure_both():
    described = describe_attention(Support(False, False, True), Support(True, False, True))
    assert "would reach flash" in described
    assert "measuring both ways" in described


def test_a_fold_that_buys_a_better_kernel_says_it_is_free():
    described = describe_attention(Support(True, False, True), Support(False, False, True))
    assert "the fold is the faster of the two" in described


def test_the_backends_are_listed_fastest_first():
    """`chosen` and the cost comparison both depend on this order."""
    assert BACKENDS[0] == "flash"
    assert set(BACKENDS) == {"flash", "cudnn", "efficient"}
