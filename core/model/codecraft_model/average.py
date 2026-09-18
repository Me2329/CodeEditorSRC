"""Averaging checkpoints, which costs nothing and often helps.

Training walks a noisy path. The weights at step 4000 and the weights at step
3800 are both near the same minimum but on different sides of the noise, and the
point halfway between them is usually a little better than either: averaging
cancels the part of each that is a step's worth of randomness and keeps the part
that is the thing learned.

This is the cheapest improvement available to a small model. It needs no extra
training, no extra data and no hyperparameters, and it either helps or it does
not, which the evaluation says in a minute.

Two things it is not. It is not an ensemble: one model comes out, not several,
so inference costs exactly what it did. And it is not valid between unrelated
runs. Two models trained from different initialisations sit in different basins
and the point between them is worse than both, often much worse. Averaging works
when the checkpoints are steps along one path, which is why this refuses any set
whose architectures do not match and says so rather than producing a soup that
loads and answers nonsense.
"""

from __future__ import annotations

from pathlib import Path

import torch

from .model import ModelConfig


def average_checkpoints(
    paths: list[Path], weights: list[float] | None = None
) -> tuple[dict[str, torch.Tensor], ModelConfig, dict]:
    """Average the weights of several checkpoints of one architecture.

    Returns the averaged state, the config they agree on, and a record of what
    went in. Unequal weights are allowed, for the common case of leaning on the
    best checkpoint and using the others to smooth it.
    """
    if not paths:
        raise ValueError("nothing to average")

    if weights is None:
        weights = [1.0] * len(paths)
    if len(weights) != len(paths):
        raise ValueError(f"{len(weights)} weights for {len(paths)} checkpoints")
    total_weight = sum(weights)
    if total_weight <= 0:
        raise ValueError("weights must sum to more than zero")

    averaged: dict[str, torch.Tensor] = {}
    config: ModelConfig | None = None
    record: list[dict] = []

    for path, weight in zip(paths, weights):
        payload = torch.load(path, map_location="cpu", weights_only=False)
        here = ModelConfig.from_dict(payload["model_config"])

        if config is None:
            config = here
        elif here.to_dict() != config.to_dict():
            # A soup of two architectures is not a model. Refusing is the only
            # useful thing to do, because the alternative loads and answers
            # nonsense.
            raise ValueError(
                f"{path.name} has a different architecture "
                f"(d_model {here.d_model} against {config.d_model})"
            )

        state = {
            name.removeprefix("_orig_mod."): tensor
            for name, tensor in payload["model"].items()
        }

        if averaged and set(state) != set(averaged):
            raise ValueError(f"{path.name} has different tensors from the first checkpoint")

        for name, tensor in state.items():
            share = tensor.to(torch.float32) * (weight / total_weight)
            averaged[name] = averaged[name] + share if name in averaged else share

        record.append(
            {
                "path": str(path),
                "weight": weight / total_weight,
                "step": payload.get("step"),
                "val_loss": payload.get("val_loss"),
            }
        )

    assert config is not None
    return averaged, config, {"sources": record}
