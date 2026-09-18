"""Fine-tuning by adding a small correction rather than moving the whole model.

Full fine-tuning updates every weight, which means the optimiser holds two more
copies of the model, the result is another checkpoint the same size as the
original, and a machine with room to serve a model may have no room to train
one.

A low-rank adapter replaces the update with a product of two thin matrices. A
weight of shape (out, in) is corrected by B @ A where A is (rank, in) and B is
(out, rank), so at rank 8 a 256x256 projection carries 4,096 trainable numbers
instead of 65,536. The base weights are frozen, so the optimiser state and the
gradients are proportional to the adapter, not to the model.

Two properties make this practical rather than merely small:

  - B starts at zero, so an adapter that has learned nothing is exactly the base
    model. Fine-tuning begins from the model you had, with no discontinuity.
  - The correction is linear, so a trained adapter can be folded into the base
    weights and served with no adapter code at all. Merged and unmerged produce
    the same numbers, which is a test rather than a claim.

The rank is the whole trade. Too low and there is nothing to learn with; too
high and the saving disappears and the adapter starts to overfit the way full
fine-tuning does on a small set.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

# The projections adapted by default. Attention's query and value are the usual
# choice: the literature finds them to carry most of the benefit, and adapting
# every linear layer costs several times as much for little more.
DEFAULT_TARGETS: tuple[str, ...] = ("q_proj", "v_proj")


@dataclass(frozen=True)
class LoRAConfig:
    rank: int = 8
    alpha: float = 16.0
    dropout: float = 0.0
    targets: tuple[str, ...] = DEFAULT_TARGETS

    def __post_init__(self) -> None:
        if self.rank < 1:
            raise ValueError("rank must be at least 1; rank 0 is no adapter at all")
        if self.alpha <= 0:
            raise ValueError("alpha must be positive")
        if not self.targets:
            raise ValueError("an adapter with no targets would train nothing")

    def to_dict(self) -> dict:
        return {
            "rank": self.rank,
            "alpha": self.alpha,
            "dropout": self.dropout,
            "targets": list(self.targets),
        }

    @classmethod
    def from_dict(cls, payload: dict) -> "LoRAConfig":
        return cls(
            rank=int(payload["rank"]),
            alpha=float(payload["alpha"]),
            dropout=float(payload.get("dropout", 0.0)),
            targets=tuple(payload.get("targets", DEFAULT_TARGETS)),
        )


class LoRALinear(nn.Module):
    """A frozen linear layer plus a trainable low-rank correction."""

    def __init__(self, base: nn.Linear, config: LoRAConfig) -> None:
        super().__init__()
        self.base = base
        for parameter in self.base.parameters():
            parameter.requires_grad_(False)

        self.rank = config.rank
        # alpha over rank, so raising the rank does not also raise the size of
        # the correction: the two knobs stay independent.
        self.scaling = config.alpha / config.rank
        self.dropout = nn.Dropout(config.dropout) if config.dropout > 0 else nn.Identity()

        in_features = base.in_features
        out_features = base.out_features
        self.lora_a = nn.Parameter(torch.empty(config.rank, in_features))
        self.lora_b = nn.Parameter(torch.zeros(out_features, config.rank))

        # A is initialised the way a linear layer's weight would be, and B is
        # left at zero. Their product is therefore zero, so the adapter starts
        # as an exact no-op: training begins from the model you already had.
        nn.init.kaiming_uniform_(self.lora_a, a=math.sqrt(5))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        correction = F.linear(F.linear(self.dropout(x), self.lora_a), self.lora_b)
        return self.base(x) + correction * self.scaling

    def merged_weight(self) -> torch.Tensor:
        """The base weight with the correction folded in."""
        return self.base.weight + (self.lora_b @ self.lora_a) * self.scaling


def _replace(parent: nn.Module, name: str, module: nn.Module) -> None:
    setattr(parent, name, module)


def apply_lora(model: nn.Module, config: LoRAConfig) -> int:
    """Freeze the model and wrap its target projections. Returns how many.

    Freezing happens here rather than being left to the caller, because an
    adapter over an unfrozen model is full fine-tuning with extra steps and the
    symptom is a training run that looks fine and a checkpoint that is wrong.
    """
    for parameter in model.parameters():
        parameter.requires_grad_(False)

    replaced = 0
    for module in list(model.modules()):
        for name, child in list(module.named_children()):
            if name in config.targets and isinstance(child, nn.Linear):
                _replace(module, name, LoRALinear(child, config))
                replaced += 1

    if replaced == 0:
        raise ValueError(
            f"none of {config.targets} matched a linear layer; the model would train nothing"
        )
    return replaced


def adapter_parameters(model: nn.Module) -> list[nn.Parameter]:
    """The parameters an optimiser should be given."""
    return [parameter for parameter in model.parameters() if parameter.requires_grad]


def adapter_state(model: nn.Module) -> dict[str, torch.Tensor]:
    """Only the adapter's own tensors, which is what makes the file small.

    Cloned rather than referenced, unlike `state_dict`. On a CPU model `.cpu()`
    returns the same tensor, so a caller holding this as a snapshot would watch
    it change under them as training continued. An adapter is a few thousand
    numbers by construction, so the copy costs nothing worth saving.
    """
    return {
        name: tensor.detach().clone().cpu()
        for name, tensor in model.state_dict().items()
        if ".lora_a" in name or ".lora_b" in name
    }


def save_adapter(path: Path, model: nn.Module, config: LoRAConfig, metadata: dict | None = None) -> int:
    """Write the adapter alone. Returns the size in bytes.

    The base model is not included. An adapter is meaningful only against the
    checkpoint it was trained on, so what is stored instead is enough to check
    that at load time rather than discovering it through wrong answers.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "lora_config": config.to_dict(),
        "adapter": adapter_state(model),
        "metadata": metadata or {},
    }
    torch.save(payload, path)
    return path.stat().st_size


def load_adapter(path: Path, model: nn.Module) -> LoRAConfig:
    """Apply a saved adapter to a base model, returning the config it was trained with."""
    payload = torch.load(path, map_location="cpu", weights_only=False)
    config = LoRAConfig.from_dict(payload["lora_config"])
    apply_lora(model, config)

    missing, unexpected = model.load_state_dict(payload["adapter"], strict=False)
    if unexpected:
        raise ValueError(
            f"the adapter has tensors this model has no place for: {sorted(unexpected)[:3]}"
        )
    # Everything that is not an adapter tensor is expected to be missing, since
    # the file deliberately holds nothing else.
    still_missing = [name for name in missing if ".lora_" in name]
    if still_missing:
        raise ValueError(f"the adapter is missing tensors this model needs: {still_missing[:3]}")
    return config


def merge_lora(model: nn.Module) -> int:
    """Fold every adapter into its base weight and unwrap it. Returns how many.

    After this the model is an ordinary one: the same shape as the checkpoint it
    started from, servable by code that knows nothing about adapters. The result
    is numerically identical to the unmerged model, which is worth a test.

    Everything `apply_lora` froze is unfrozen again, because a model that is
    merged but still frozen is not an ordinary model. It reports a parameter
    count of whatever the adapter touched, and a later full fine-tune would
    silently train four projections and nothing else.
    """
    merged = 0
    for module in list(model.modules()):
        for name, child in list(module.named_children()):
            if isinstance(child, LoRALinear):
                base = child.base
                with torch.no_grad():
                    base.weight.copy_(child.merged_weight())
                _replace(module, name, base)
                merged += 1

    if merged:
        for parameter in model.parameters():
            parameter.requires_grad_(True)
    return merged


def describe(model: nn.Module) -> dict:
    """What is trainable and what is not, which is the number worth seeing."""
    trainable = sum(parameter.numel() for parameter in adapter_parameters(model))
    total = sum(parameter.numel() for parameter in model.parameters())
    return {
        "trainable": trainable,
        "total": total,
        "fraction": trainable / total if total else 0.0,
        "adapters": sum(1 for module in model.modules() if isinstance(module, LoRALinear)),
    }
