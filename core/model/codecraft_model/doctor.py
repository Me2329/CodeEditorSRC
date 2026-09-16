"""What this machine can actually do, before anyone spends a week finding out.

Everything here is arithmetic over three numbers: the memory a card has, the
memory the machine has, and the free space on the disk the run will write to.
The reason it is a command rather than a paragraph in the README is that the
answer depends on the machine, and the person asking is usually about to start
something that takes days.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from .config import SIZES, ModelConfig, humanise

#: Tokens per parameter for a corpus proportionate to a model. The ratio comes
#: from the Chinchilla scaling work and is a rule of thumb, not a law: fewer
#: tokens trains a worse model rather than none.
TOKENS_PER_PARAMETER = 20


@dataclass(frozen=True)
class Recommendation:
    """The largest named size a budget allows, and what it takes to get there."""

    name: str
    parameters: int
    detail: str


def largest_trainable(available: int, vocab_size: int = 32768) -> Recommendation | None:
    """The biggest size that fits in this much memory, with how to make it fit.

    The plainest configuration that works is the one reported: there is no
    reason to recommend an optimiser that gives up momentum, or a step that
    gives up gradient accumulation, when the ordinary one fits.
    """
    best: Recommendation | None = None
    for name, preset in SIZES.items():
        sized = preset.with_vocab(vocab_size)
        for optimizer, fused, detail in (
            ("adamw", False, "adamw"),
            ("adafactor", False, "--optimizer adafactor"),
            ("adafactor", True, "--optimizer adafactor --fused-step"),
        ):
            needed = sized.memory_estimate_bytes(optimizer=optimizer, fused=fused)["training"]
            # Activations, the batch and allocator fragmentation sit on top.
            if needed * 1.35 < available:
                best = Recommendation(name, sized.parameter_count(), detail)
                break
    return best


def largest_servable(available: int, vocab_size: int = 32768) -> Recommendation | None:
    """The biggest size that can be run here, which is a different question.

    Serving holds one copy of the weights rather than four, so the answer is
    usually several sizes larger than what trains.
    """
    best: Recommendation | None = None
    for name, preset in SIZES.items():
        sized = preset.with_vocab(vocab_size)
        estimate = sized.memory_estimate_bytes()
        for cost, detail in (
            (estimate["weights"], "float32"),
            (estimate["inference_bf16"], "--half"),
            (estimate["weights"] // 4, "--quantize"),
        ):
            # A fifth over the weights for the cache and the activations.
            if cost * 1.2 < available:
                best = Recommendation(name, sized.parameter_count(), detail)
                break
    return best


@dataclass(frozen=True)
class Budget:
    """What one size costs on disk, which is the other thing that runs out."""

    parameters: int
    checkpoint_bytes: int
    both_checkpoints_bytes: int
    corpus_tokens: int
    corpus_bytes: int

    @property
    def total_bytes(self) -> int:
        return self.both_checkpoints_bytes + self.corpus_bytes


def disk_budget(config: ModelConfig, optimizer: str = "adafactor") -> Budget:
    """Disk for a run of this size: two checkpoints and a corpus to match it."""
    estimate = config.memory_estimate_bytes(optimizer=optimizer)
    checkpoint = estimate["weights"] + estimate["optimizer_state"]
    tokens = config.parameter_count() * TOKENS_PER_PARAMETER
    return Budget(
        parameters=config.parameter_count(),
        checkpoint_bytes=checkpoint,
        # `model.pt` and `latest.pt`, which every run writes.
        both_checkpoints_bytes=checkpoint * 2,
        corpus_tokens=tokens,
        # uint16 per token, which is every vocabulary this trains.
        corpus_bytes=tokens * 2,
    )


def free_disk_bytes(path: Path) -> int | None:
    """Room where the run will write, or None if the path cannot be reached."""
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return None


def describe_bytes(count: int | None) -> str:
    if count is None:
        return "unknown"
    if count >= 1e12:
        return f"{count / 1e12:.1f}TB"
    if count >= 1e9:
        return f"{count / 1e9:.1f}GB"
    return f"{count / 1e6:.0f}MB"


def describe_recommendation(found: Recommendation | None, verb: str) -> str:
    if found is None:
        return f"nothing here {verb}: not enough memory for the smallest size"
    return f"{found.name} ({humanise(found.parameters)}) with {found.detail}"
