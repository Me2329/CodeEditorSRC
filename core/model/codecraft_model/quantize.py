"""Int8 weights, so a bigger model fits and a smaller one loads faster.

Serving a model holds one copy of the weights, unlike training which holds
four. That makes the weights themselves the whole budget, and int8 quarters the
matrices this touches.

Measured, not assumed. Quartering the matrices is not quartering the model,
because the embedding is deliberately left in float and at these vocabulary
sizes it is a large share of the total:

    small  128.2MB -> 57.6MB   2.23x
    base   403.3MB -> 177.1MB  2.28x

The matrices themselves do shrink fourfold, which is what matters for the large
configurations where they dominate: `xl` goes from about 4GB of float32 weights
to roughly 1GB.

The scheme is symmetric per-output-channel. Each row of a weight matrix gets its
own scale, chosen so the largest magnitude in that row lands on 127. Per-channel
rather than per-tensor because one outlier row would otherwise squash the scale
for every other row, and per-channel costs one float per row against millions of
weights.

Symmetric rather than asymmetric because weights are close to zero-centred and
the zero point buys accuracy that matters for activations, not for these. Skipping
it keeps dequantization a single multiply.

What is deliberately not quantized: the embedding, the norms, and anything with
fewer than two dimensions. Norm gains are the scale of everything downstream and
there are very few of them, so quantizing them saves nothing and costs accuracy.
The embedding is tied to the output head, where small errors are amplified by
the softmax over the whole vocabulary.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
import torch.nn as nn


@dataclass(frozen=True)
class QuantizationReport:
    """What quantizing actually achieved, so the claim can be checked."""

    quantized_tensors: int
    skipped_tensors: int
    original_bytes: int
    quantized_bytes: int
    max_error: float
    mean_error: float

    @property
    def compression(self) -> float:
        return self.original_bytes / max(self.quantized_bytes, 1)


def quantize_tensor(weight: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Return int8 values and the per-row scales that undo them.

    The scale is the largest magnitude in the row over 127. A row that is
    entirely zero would give a scale of zero and then a division by it, so those
    are pinned to one: the values are zero either way and the scale is unused.
    """
    if weight.dim() < 2:
        raise ValueError("only matrices are quantized per output channel")

    largest = weight.abs().amax(dim=1, keepdim=True)
    scales = torch.where(largest > 0, largest / 127.0, torch.ones_like(largest))

    # round() rather than truncation: truncating biases every value toward zero,
    # which across millions of weights is a systematic shrink of the model.
    quantized = torch.round(weight / scales).clamp(-127, 127).to(torch.int8)
    return quantized, scales.to(torch.float32)


def dequantize_tensor(quantized: torch.Tensor, scales: torch.Tensor) -> torch.Tensor:
    return quantized.to(torch.float32) * scales


class QuantizedLinear(nn.Module):
    """A Linear holding int8 weights, dequantized per forward pass.

    This trades compute for memory rather than being faster: the matmul still
    happens in floating point. It exists so a model that would not otherwise fit
    can be served at all, which beats being fast in the case where the
    alternative is nothing.
    """

    def __init__(self, quantized: torch.Tensor, scales: torch.Tensor, bias: torch.Tensor | None):
        super().__init__()
        self.register_buffer("quantized", quantized)
        self.register_buffer("scales", scales)
        self.register_buffer("bias_term", bias)
        self.out_features, self.in_features = quantized.shape

    @classmethod
    def from_linear(cls, linear: nn.Linear) -> "QuantizedLinear":
        quantized, scales = quantize_tensor(linear.weight.detach())
        bias = linear.bias.detach().clone() if linear.bias is not None else None
        return cls(quantized, scales, bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        weight = dequantize_tensor(self.quantized, self.scales).to(x.dtype)
        return torch.nn.functional.linear(x, weight, self.bias_term)

    def extra_repr(self) -> str:
        return f"in_features={self.in_features}, out_features={self.out_features}, int8"


def _tensor_bytes(module: nn.Module) -> int:
    return sum(
        tensor.numel() * tensor.element_size()
        for tensor in list(module.parameters()) + list(module.buffers())
    )


def quantize_model(model: nn.Module, *, skip: tuple[str, ...] = ("output_head",)) -> QuantizationReport:
    """Replace every eligible Linear in `model` with an int8 one, in place.

    `skip` names modules to leave alone. The output head is skipped by default
    because it is tied to the embedding, and because errors there are amplified
    by a softmax over the whole vocabulary rather than averaged away.
    """
    original = _tensor_bytes(model)
    quantized_count = 0
    skipped = 0
    errors: list[torch.Tensor] = []

    # Collected first: replacing while walking would visit the replacements.
    targets = [
        (name, child)
        for name, child in model.named_modules()
        if isinstance(child, nn.Linear)
    ]

    for name, linear in targets:
        if any(name.endswith(pattern) or f".{pattern}." in f".{name}." for pattern in skip):
            skipped += 1
            continue

        replacement = QuantizedLinear.from_linear(linear)
        with torch.no_grad():
            restored = dequantize_tensor(replacement.quantized, replacement.scales)
            errors.append((restored - linear.weight.detach()).abs().flatten())

        parent_path, _, attribute = name.rpartition(".")
        parent = model.get_submodule(parent_path) if parent_path else model
        setattr(parent, attribute, replacement)
        quantized_count += 1

    combined = torch.cat(errors) if errors else torch.zeros(1)
    return QuantizationReport(
        quantized_tensors=quantized_count,
        skipped_tensors=skipped,
        original_bytes=original,
        quantized_bytes=_tensor_bytes(model),
        max_error=float(combined.max()),
        mean_error=float(combined.mean()),
    )
