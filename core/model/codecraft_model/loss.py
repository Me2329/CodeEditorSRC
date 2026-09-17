"""Computing the loss without holding every logit at once.

The output head is the largest matrix in the model and it produces the largest
tensor in a step. At `xxl`'s training shape it is 134 million numbers — half a
gigabyte in float32 — and cross entropy needs roughly that again for its own
backward pass. None of it is interesting: the logits are consumed immediately
to produce one scalar, and then thrown away.

So they are produced in pieces. The sequence is split, each piece is projected
and scored on its own, and the pieces are summed. On its own that saves nothing,
because autograd keeps every piece for the backward pass; the saving comes from
recomputing each piece during backward instead of keeping it, which is the same
trade gradient checkpointing makes everywhere else and costs one extra forward
pass through a single matrix multiply.

What that buys is not a faster step. It is a *larger batch* in the same memory,
which is the thing that decides whether a run finishes: at a fixed number of
tokens, fewer and larger steps spend proportionally less time on the fixed cost
of a step. The measurement is in the README rather than here.

The agreement matters more than the saving, because a run trained with this
has to be comparable with one trained without it — otherwise the difference
shows up as a hyperparameter nobody changed. Measured: in float64 the value and
the gradient are both exactly equal to `F.cross_entropy`; in float32 the
gradient is still bit-identical and the value differs by about 5e-7 on a loss
of order 6, which is the reassociation you get from summing in a different
order and nothing more. It is not bit-exact in float32 and this does not claim
to be. The tests pin both.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F
import torch.utils.checkpoint
from torch import nn

#: Tokens per piece. Small enough that one piece's logits are a fraction of the
#: whole, large enough that the per-piece overhead stays negligible. At a
#: 32768-token vocabulary this is 16M numbers, or 64MB in float32.
DEFAULT_CHUNK = 512


def chunked_cross_entropy(
    head: nn.Module,
    hidden: torch.Tensor,
    targets: torch.Tensor,
    *,
    chunk_size: int = DEFAULT_CHUNK,
    ignore_index: int = 0,
    recompute: bool = True,
) -> torch.Tensor:
    """Mean cross entropy over `targets`, computed a piece at a time.

    `hidden` is the final residual stream, shape (batch, sequence, d_model).
    `targets` is (batch, sequence). The result is identical to projecting the
    whole thing and calling `F.cross_entropy` with `reduction="mean"`.

    The mean is over the tokens that count, which is why the pieces are summed
    rather than averaged: averaging per piece and averaging those would weight a
    piece with two real tokens the same as one with five hundred.
    """
    if chunk_size <= 0:
        raise ValueError("a chunk has to hold at least one token")

    flat_hidden = hidden.reshape(-1, hidden.size(-1))
    flat_targets = targets.reshape(-1)
    if flat_hidden.size(0) != flat_targets.size(0):
        raise ValueError(
            f"{flat_hidden.size(0)} hidden states and {flat_targets.size(0)} targets"
        )

    counted = (flat_targets != ignore_index).sum()

    def score(piece: torch.Tensor, wanted: torch.Tensor) -> torch.Tensor:
        return F.cross_entropy(
            head(piece),
            wanted,
            ignore_index=ignore_index,
            # Summed, not averaged: the division happens once, at the end, by
            # the number of tokens that actually counted.
            reduction="sum",
        )

    total = flat_hidden.new_zeros(())
    for start in range(0, flat_hidden.size(0), chunk_size):
        piece = flat_hidden[start : start + chunk_size]
        wanted = flat_targets[start : start + chunk_size]
        if recompute and torch.is_grad_enabled() and piece.requires_grad:
            # use_reentrant=False is the supported implementation and the one
            # that works with a piece that requires grad.
            total = total + torch.utils.checkpoint.checkpoint(
                score, piece, wanted, use_reentrant=False
            )
        else:
            total = total + score(piece, wanted)

    # Every target ignored means no tokens to average over. Returning zero
    # rather than a NaN keeps one empty batch from poisoning a whole run, and
    # `F.cross_entropy` returns NaN here, so this is the one place the two
    # deliberately differ.
    if counted == 0:
        return total * 0.0
    return total / counted


def logit_bytes(batch: int, sequence: int, vocab_size: int, bytes_per_number: int = 4) -> int:
    """What the whole-sequence logits would cost, for reporting."""
    return batch * sequence * vocab_size * bytes_per_number


def chunked_logit_bytes(
    chunk_size: int, vocab_size: int, bytes_per_number: int = 4
) -> int:
    """What one piece costs instead."""
    return chunk_size * vocab_size * bytes_per_number
