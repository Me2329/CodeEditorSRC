"""Reading a run that takes weeks."""

import pytest

from codecraft_model.report import (
    describe_duration,
    memorisation,
    progress_of,
    sparkline,
    trend,
)


def run(step: int, steps: int, **extra) -> dict:
    return {
        "steps": steps,
        "tokens_per_step": 4096,
        "tokens_seen": 4096 * step,
        "elapsed_seconds": 100.0,
        "tokens_per_second": 4096 * step / 100.0,
        "history": [{"step": step, "train_loss": 2.0, "val_loss": 3.0}],
        **extra,
    }


def test_progress_estimates_what_is_left_from_what_has_been_done():
    measured = progress_of(run(step=250, steps=1000))

    assert measured.fraction == 0.25
    # 750 steps at the rate the first 250 managed: three times the elapsed time.
    assert measured.remaining_seconds == pytest.approx(300.0, rel=1e-6)


def test_a_finished_run_has_nothing_left():
    assert progress_of(run(step=1000, steps=1000)).remaining_seconds is None


def test_a_run_with_no_measured_rate_does_not_guess():
    summary = run(step=10, steps=100)
    summary["tokens_per_second"] = 0.0
    assert progress_of(summary).remaining_seconds is None


def test_progress_survives_a_summary_with_nothing_in_it():
    measured = progress_of({})
    assert measured.step == 0 and measured.remaining_seconds is None


def test_a_duration_is_said_the_way_someone_would_say_it():
    assert describe_duration(35) == "35s"
    assert describe_duration(600) == "10m"
    assert describe_duration(9000) == "2.5h"
    assert describe_duration(400_000) == "4.6 days"
    assert describe_duration(None) == "unknown"


def test_the_trend_is_taken_over_a_window_rather_than_two_points():
    """Two consecutive validation losses say nothing; they are noisy."""
    noisy = [{"val_loss": value} for value in [3.0, 2.8, 2.9, 2.7, 2.75]]
    assert trend(noisy) == "falling"

    stuck = [{"val_loss": value} for value in [2.70, 2.71, 2.69, 2.70, 2.70]]
    assert trend(stuck) == "flat"

    worsening = [{"val_loss": value} for value in [2.5, 2.6, 2.7, 2.8, 2.9]]
    assert trend(worsening) == "rising"


def test_a_run_with_one_evaluation_says_it_is_too_early():
    assert trend([{"val_loss": 3.0}]) == "too early to say"


def test_the_gap_between_seen_and_unseen_is_reported_as_a_number():
    history = [{"train_loss": 1.9, "val_loss": 3.5}] * 5
    assert memorisation(history) == pytest.approx(1.6)


def test_a_history_without_losses_has_no_gap():
    assert memorisation([{"step": 1}]) is None


def test_a_curve_fits_in_one_line_however_long_the_run():
    values = [10.0 - index * 0.01 for index in range(4000)]
    drawn = sparkline(values, width=40)

    assert len(drawn) == 40
    # Falling all the way, so it starts high and ends low.
    assert drawn[0] == "█" and drawn[-1] == "▁"


def test_a_flat_curve_does_not_divide_by_zero():
    assert sparkline([2.5] * 10) == "▁" * 10


def test_a_curve_needs_two_points_to_be_a_curve():
    assert sparkline([1.0]) == ""
