"""Reading a training run that is still going, or one that has stopped.

A run of the size this repository can now configure takes days or weeks, and
the only record of it is a JSON file and a log nobody keeps. The questions
someone actually has are always the same four: how far in is it, is the loss
still falling, when will it finish, and is it starting to memorise the corpus
instead of learning from it.

Nothing here computes anything the trainer did not already write down. What it
adds is the arithmetic between those numbers, which is the part people get
wrong when they are tired and the run is on hour ninety.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Progress:
    """Where a run is, and where it is going."""

    step: int
    steps: int
    fraction: float
    tokens_seen: int
    elapsed_seconds: float
    tokens_per_second: float
    #: None when there is nothing left to do, or nothing to estimate from.
    remaining_seconds: float | None


def progress_of(summary: dict) -> Progress:
    """How far along a run is, from what the trainer recorded."""
    history = summary.get("history") or []
    step = int(history[-1]["step"]) if history else int(summary.get("started_at_step", 0))
    steps = int(summary.get("steps", 0)) or step
    rate = float(summary.get("tokens_per_second", 0.0))
    per_step = int(summary.get("tokens_per_step", 0))

    remaining = None
    if rate > 0 and per_step > 0 and steps > step:
        remaining = (steps - step) * per_step / rate

    return Progress(
        step=step,
        steps=steps,
        fraction=step / steps if steps else 0.0,
        tokens_seen=int(summary.get("tokens_seen", 0)),
        elapsed_seconds=float(summary.get("elapsed_seconds", 0.0)),
        tokens_per_second=rate,
        remaining_seconds=remaining,
    )


def describe_duration(seconds: float | None) -> str:
    """A length of time as someone would say it out loud."""
    if seconds is None:
        return "unknown"
    if seconds < 90:
        return f"{seconds:.0f}s"
    minutes = seconds / 60
    if minutes < 90:
        return f"{minutes:.0f}m"
    hours = minutes / 60
    if hours < 48:
        return f"{hours:.1f}h"
    return f"{hours / 24:.1f} days"


def trend(history: list[dict], window: int = 5) -> str:
    """Whether the held-out loss is still going down.

    Over a window rather than the last two evaluations, because validation loss
    is noisy enough that any two consecutive numbers say nothing.
    """
    losses = [float(entry["val_loss"]) for entry in history if "val_loss" in entry]
    if len(losses) < 2:
        return "too early to say"

    recent = losses[-window:]
    change = recent[-1] - recent[0]
    if len(recent) < 3:
        return "falling" if change < 0 else "not falling"
    if change < -0.01:
        return "falling"
    if change > 0.01:
        return "rising"
    return "flat"


def memorisation(history: list[dict], window: int = 5) -> float | None:
    """The gap between training loss and held-out loss, averaged over a window.

    A model that scores much better on what it has seen than on what it has not
    is learning the corpus rather than the language. Returned as a number rather
    than a verdict; a nat and a half is a lot, a tenth is nothing.
    """
    pairs = [
        (float(entry["train_loss"]), float(entry["val_loss"]))
        for entry in history
        if "train_loss" in entry and "val_loss" in entry
    ]
    if not pairs:
        return None
    recent = pairs[-window:]
    return sum(val - train for train, val in recent) / len(recent)


def sparkline(values: list[float], width: int = 40) -> str:
    """The shape of a curve, in one line of text.

    A run is watched over a terminal, and a picture of the loss is worth more
    than the last three numbers of it. Blocks rather than a plot, because this
    has to work over ssh on a machine with nothing installed.
    """
    marks = "▁▂▃▄▅▆▇█"
    if len(values) < 2:
        return ""

    if len(values) > width:
        # Take an even spread rather than the tail: the shape of the whole run
        # is the point.
        step = (len(values) - 1) / (width - 1)
        values = [values[round(index * step)] for index in range(width)]

    low, high = min(values), max(values)
    if not math.isfinite(low) or not math.isfinite(high) or high - low < 1e-12:
        return marks[0] * len(values)

    return "".join(
        marks[min(len(marks) - 1, int((value - low) / (high - low) * len(marks)))]
        for value in values
    )
