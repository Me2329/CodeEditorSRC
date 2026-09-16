"""What a run costs in time, which is the constraint memory arithmetic hides."""

from __future__ import annotations

import math

import pytest

from codecraft_model.config import SIZES
from codecraft_model.doctor import TOKENS_PER_PARAMETER
from codecraft_model.schedule import (
    FLOPS_PER_PARAMETER_PER_TOKEN,
    Plan,
    Throughput,
    corpus_within,
    describe_rate,
    describe_tokens,
    largest_fully_trained,
    largest_size_within,
    measure,
    plan_for,
    proportionate_corpus,
    scaled_rate,
    training_flops,
)


def test_training_flops_is_six_n_d():
    assert training_flops(1_000, 2_000) == 6 * 1_000 * 2_000


def test_a_proportionate_corpus_is_twenty_tokens_a_parameter():
    assert proportionate_corpus(1_000_000) == 20_000_000


class FakeClock:
    """A clock that advances a fixed amount every time it is read."""

    def __init__(self, per_read: float = 0.5) -> None:
        self.now = 0.0
        self.per_read = per_read

    def __call__(self) -> float:
        value = self.now
        self.now += self.per_read
        return value


def test_measure_times_only_the_steps_it_says_it_does():
    calls = []
    # Two reads bracket the timed region, so the elapsed time is one increment.
    throughput = measure(
        lambda: calls.append(1),
        tokens_per_step=100,
        steps=4,
        warmup=3,
        clock=FakeClock(2.0),
    )
    assert len(calls) == 7, "warmup runs, and is not counted"
    assert throughput.steps == 4
    assert throughput.tokens == 400
    assert throughput.seconds == pytest.approx(2.0)
    assert throughput.tokens_per_second == pytest.approx(200.0)


def test_measure_warms_up_before_the_clock_starts():
    """The first step allocates everything; timing it slanders the machine."""
    durations = iter([10.0, 10.0, 10.0, 0.1, 0.1, 0.1])
    elapsed = [0.0]

    def step() -> None:
        elapsed[0] += next(durations)

    cold = measure(step, tokens_per_step=10, steps=3, warmup=3, clock=lambda: elapsed[0])
    # Three slow warmup steps, then three fast ones: the rate reported is the
    # fast one, which is what every step after the first few will cost.
    assert cold.seconds == pytest.approx(0.3)


def test_measure_refuses_a_measurement_with_no_steps():
    with pytest.raises(ValueError, match="at least one step"):
        measure(lambda: None, tokens_per_step=1, steps=0)


def test_measure_refuses_negative_warmup():
    with pytest.raises(ValueError, match="cannot be negative"):
        measure(lambda: None, tokens_per_step=1, warmup=-1)


def test_a_rate_needs_time_to_have_passed():
    with pytest.raises(ValueError, match="taken some time"):
        Throughput(tokens=10, seconds=0.0, steps=1).tokens_per_second


def test_flops_per_second_is_the_work_over_the_time():
    throughput = Throughput(tokens=1_000, seconds=2.0, steps=10)
    assert throughput.flops_per_second(1_000_000) == pytest.approx(
        FLOPS_PER_PARAMETER_PER_TOKEN * 1_000_000 * 1_000 / 2.0
    )


def test_a_plan_over_the_corpus_a_size_deserves():
    plan = plan_for(parameters=1_000_000, tokens_per_second=1_000)
    assert plan.tokens == 20_000_000
    assert plan.seconds == pytest.approx(20_000.0)
    assert plan.tokens_per_parameter == pytest.approx(TOKENS_PER_PARAMETER)
    assert plan.verdict == "proportionate to the size"


def test_a_plan_over_a_corpus_someone_actually_has():
    plan = plan_for(parameters=1_000_000, tokens_per_second=1_000, tokens=1_000_000)
    assert plan.tokens_per_parameter == pytest.approx(1.0)
    assert "barely" in plan.verdict


@pytest.mark.parametrize(
    "ratio, expected",
    [
        (40, "proportionate to the size"),
        (20, "proportionate to the size"),
        (12, "a little thin, but a real model"),
        (5, "undertrained: a smaller size on the same corpus would beat it"),
        (1, "far too little: the model would barely be trained at all"),
    ],
)
def test_the_verdict_tracks_how_well_fed_the_model_is(ratio, expected):
    plan = Plan(parameters=1_000, tokens=1_000 * ratio, tokens_per_second=1.0)
    assert plan.verdict == expected


def test_a_plan_needs_a_positive_rate():
    with pytest.raises(ValueError, match="positive rate"):
        Plan(parameters=10, tokens=10, tokens_per_second=0.0).seconds


def test_days_is_seconds_in_the_unit_people_plan_in():
    plan = Plan(parameters=1, tokens=86_400, tokens_per_second=1.0)
    assert plan.days == pytest.approx(1.0)


def test_a_deadline_buys_a_corpus():
    assert corpus_within(seconds=10.0, tokens_per_second=1_500) == 15_000


def test_a_deadline_already_passed_buys_nothing():
    assert corpus_within(seconds=-5.0, tokens_per_second=1_500) == 0


def test_the_rate_at_another_size_falls_with_the_parameter_count():
    assert scaled_rate(1_000.0, measured_parameters=100, target_parameters=200) == 500.0


def test_scaling_refuses_a_size_that_is_not_a_size():
    with pytest.raises(ValueError, match="positive"):
        scaled_rate(1_000.0, measured_parameters=0, target_parameters=10)


def test_the_largest_model_a_budget_trains_properly():
    """Time is 120 N^2 / F, so the size it buys is the square root of it."""
    flops_per_second = 1e14
    seconds = 86_400.0
    size = largest_fully_trained(seconds, flops_per_second)
    expected = math.sqrt(
        seconds * flops_per_second / (FLOPS_PER_PARAMETER_PER_TOKEN * TOKENS_PER_PARAMETER)
    )
    assert size == pytest.approx(expected, rel=1e-6)

    # And the run it implies really does take the time it was priced at.
    plan = plan_for(size, tokens_per_second=flops_per_second / (6 * size))
    assert plan.seconds == pytest.approx(seconds, rel=1e-6)


def test_four_times_the_compute_buys_twice_the_model():
    """The square root is the whole point: patience does not buy a large model."""
    one = largest_fully_trained(86_400.0, 1e14)
    four = largest_fully_trained(4 * 86_400.0, 1e14)
    assert four == pytest.approx(2 * one, rel=1e-6)


def test_no_time_buys_no_model():
    assert largest_fully_trained(0.0, 1e14) == 0
    assert largest_fully_trained(86_400.0, 0.0) == 0


def test_the_largest_named_size_within_a_deadline():
    # A year on a card sustaining a hundred teraflops.
    chosen = largest_size_within(365 * 86_400.0, 1e14)
    assert chosen is not None
    budget = largest_fully_trained(365 * 86_400.0, 1e14)
    assert SIZES[chosen].with_vocab(32768).parameter_count() <= budget

    names = list(SIZES)
    after = names[names.index(chosen) + 1 :]
    for name in after:
        assert SIZES[name].with_vocab(32768).parameter_count() > budget


def test_a_deadline_too_short_for_anything_named_says_so():
    assert largest_size_within(1.0, 1e9) is None


@pytest.mark.parametrize(
    "count, expected",
    [(4.6e10, "46.0B"), (2.5e12, "2.5T"), (2.56e8, "256M"), (900, "900")],
)
def test_token_counts_are_written_at_their_own_scale(count, expected):
    assert describe_tokens(count) == expected


@pytest.mark.parametrize(
    "rate, expected",
    [(1.7e14, "170 TFLOP/s"), (1.32e11, "132 GFLOP/s"), (5e7, "50 MFLOP/s")],
)
def test_a_laptop_is_not_rounded_to_zero_teraflops(rate, expected):
    assert describe_rate(rate) == expected
