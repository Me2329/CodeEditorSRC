"""How long a run takes, measured on the card that will run it.

`doctor` answers whether a size fits. Fitting is the easier half. A 2.29B model
fits on a 16GB card once the optimiser stops keeping two full copies of it, and
a person reading that answer will start the run — and find out somewhere in the
second month that memory was never the binding constraint.

So this module answers the other question, and answers it by measurement: run a
handful of real training steps at the real size, time them, and multiply out.
The arithmetic underneath is one constant. A forward and backward pass together
cost about six floating point operations per parameter per token, so a run over
D tokens of an N parameter model costs 6ND, and the time it takes is that
divided by what the card actually achieves — not what the box it came in says.

The second thing here is a closed form worth knowing before choosing a size. A
corpus proportionate to a model is about twenty tokens per parameter, so the
cost of training a model properly is 6N x 20N = 120N^2, which grows with the
*square* of the size. A card that trains a 1B model properly in a fortnight
needs four times that for 2B, not twice. `largest_fully_trained` inverts that:
given the time someone actually has, it says how big a model they can finish.
Below about ten tokens per parameter the answer to "which is better" stops
being the bigger model, which is why the number is worth having before the run
rather than after it.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Callable, Iterable

from .config import SIZES, ModelConfig
from .doctor import TOKENS_PER_PARAMETER

#: Forward and backward together, per parameter per token: two operations for
#: the forward multiply-accumulate and four for the backward pass, which
#: computes a gradient with respect to both the activation and the weight. The
#: constant ignores attention, which adds a few percent at these context
#: lengths and rather more at long ones.
FLOPS_PER_PARAMETER_PER_TOKEN = 6


def training_flops(parameters: int, tokens: int) -> float:
    """What it costs to train a model of this size over this many tokens."""
    return FLOPS_PER_PARAMETER_PER_TOKEN * parameters * tokens


def proportionate_corpus(parameters: int) -> int:
    """The corpus a size deserves, at the usual tokens per parameter."""
    return parameters * TOKENS_PER_PARAMETER


@dataclass(frozen=True)
class Throughput:
    """What one machine achieved, rather than what its spec sheet claims."""

    tokens: int
    seconds: float
    steps: int
    peak_bytes: int | None = None

    @property
    def tokens_per_second(self) -> float:
        if self.seconds <= 0:
            raise ValueError("a measurement needs to have taken some time")
        return self.tokens / self.seconds

    def flops_per_second(self, parameters: int) -> float:
        """The rate this card sustained, which is the number worth quoting."""
        return training_flops(parameters, self.tokens) / self.seconds


def measure(
    step: Callable[[], None],
    *,
    tokens_per_step: int,
    steps: int = 6,
    warmup: int = 2,
    clock: Callable[[], float] = time.perf_counter,
    peak: Callable[[], int | None] | None = None,
) -> Throughput:
    """Time `step` honestly: warm up first, then measure.

    The warmup is not a formality. The first step allocates every buffer the
    run will use, picks the kernels it will use, and on a compiled model spends
    longer than the rest of the measurement put together. Timing it would make
    a fast card look slow, and would make a longer measurement look faster than
    a short one, which is the failure mode that quietly turns a benchmark into
    a number someone believes.
    """
    if steps <= 0:
        raise ValueError("measuring needs at least one step")
    if warmup < 0:
        raise ValueError("warmup cannot be negative")

    for _ in range(warmup):
        step()

    started = clock()
    for _ in range(steps):
        step()
    elapsed = clock() - started

    return Throughput(
        tokens=tokens_per_step * steps,
        seconds=elapsed,
        steps=steps,
        peak_bytes=peak() if peak is not None else None,
    )


@dataclass(frozen=True)
class Plan:
    """A run, in the only two units anyone plans in: tokens and days."""

    parameters: int
    tokens: int
    tokens_per_second: float

    @property
    def seconds(self) -> float:
        if self.tokens_per_second <= 0:
            raise ValueError("a plan needs a positive rate")
        return self.tokens / self.tokens_per_second

    @property
    def days(self) -> float:
        return self.seconds / 86_400

    @property
    def tokens_per_parameter(self) -> float:
        """How well fed the model is. Twenty is proportionate; five is thin."""
        return self.tokens / self.parameters

    @property
    def verdict(self) -> str:
        """What that ratio means, in the words someone would use out loud."""
        ratio = self.tokens_per_parameter
        if ratio >= TOKENS_PER_PARAMETER:
            return "proportionate to the size"
        if ratio >= TOKENS_PER_PARAMETER / 2:
            return "a little thin, but a real model"
        if ratio >= TOKENS_PER_PARAMETER / 5:
            return "undertrained: a smaller size on the same corpus would beat it"
        return "far too little: the model would barely be trained at all"


def plan_for(parameters: int, tokens_per_second: float, tokens: int | None = None) -> Plan:
    """A run of this size over this corpus, or over the one it deserves."""
    return Plan(
        parameters=parameters,
        tokens=proportionate_corpus(parameters) if tokens is None else tokens,
        tokens_per_second=tokens_per_second,
    )


def corpus_within(seconds: float, tokens_per_second: float) -> int:
    """How many tokens fit inside a deadline, which is how people plan."""
    return int(max(seconds, 0.0) * tokens_per_second)


def scaled_rate(
    tokens_per_second: float, measured_parameters: int, target_parameters: int
) -> float:
    """The rate at another size, if the card stays compute-bound.

    Time per token is proportional to parameter count once the card is busy, so
    this is one division. It is an extrapolation and should be labelled as one:
    a much smaller model can be bound by kernel launches rather than arithmetic,
    in which case this is optimistic about the larger one.
    """
    if measured_parameters <= 0 or target_parameters <= 0:
        raise ValueError("parameter counts have to be positive")
    return tokens_per_second * measured_parameters / target_parameters


def largest_fully_trained(seconds: float, flops_per_second: float) -> int:
    """The biggest model this machine can train *properly* in this much time.

    Properly means on a corpus proportionate to the size. Substituting D = 20N
    into 6ND gives 120N^2, so the size that fits a time budget goes as the
    square root of it: four times the compute buys twice the model, and no
    amount of patience with one card buys a frontier one.
    """
    if seconds <= 0 or flops_per_second <= 0:
        return 0
    budget = seconds * flops_per_second
    return int(math.sqrt(budget / (FLOPS_PER_PARAMETER_PER_TOKEN * TOKENS_PER_PARAMETER)))


def largest_size_within(
    seconds: float,
    flops_per_second: float,
    vocab_size: int = 32768,
    sizes: Iterable[tuple[str, ModelConfig]] | None = None,
) -> str | None:
    """The largest named size that can be trained properly inside a deadline."""
    budget = largest_fully_trained(seconds, flops_per_second)
    chosen: str | None = None
    for name, preset in sizes if sizes is not None else SIZES.items():
        if preset.with_vocab(vocab_size).parameter_count() <= budget:
            chosen = name
    return chosen


def describe_tokens(count: float) -> str:
    """A token count at whatever scale it happens to be."""
    if count >= 1e12:
        return f"{count / 1e12:,.1f}T"
    if count >= 1e9:
        return f"{count / 1e9:,.1f}B"
    if count >= 1e6:
        return f"{count / 1e6:,.0f}M"
    return f"{count:,.0f}"


def describe_rate(flops_per_second: float) -> str:
    """A compute rate in the unit it belongs in, rather than always teraflops.

    A card sustains hundreds of teraflops and a laptop's processor tens of
    gigaflops, and rounding the second one to "0 TFLOP/s" tells the person
    running it nothing about their machine.
    """
    if flops_per_second >= 1e12:
        return f"{flops_per_second / 1e12:,.0f} TFLOP/s"
    if flops_per_second >= 1e9:
        return f"{flops_per_second / 1e9:,.0f} GFLOP/s"
    return f"{flops_per_second / 1e6:,.0f} MFLOP/s"
