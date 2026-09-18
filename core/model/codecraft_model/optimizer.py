"""An optimiser whose state does not scale with the model.

AdamW keeps two running averages the size of the parameters. With the weights
and their gradients that is four copies, sixteen bytes per parameter in float32,
and it is what decides whether a size trains on a given card: a billion
parameters is 16GB of state before a single activation, which is a whole
consumer GPU.

Adafactor keeps the second moment *factored*. For a matrix of shape (rows,
columns) it stores one running average per row and one per column, and
reconstructs the full second moment as their outer product divided by the total.
That is rows + columns numbers instead of rows × columns: for the 2048 × 5632
matrices in the billion-parameter size, 7,680 floats instead of 11.5 million.
The state stops being proportional to the model and becomes proportional to its
perimeter.

It gives up two things, and both are deliberate here. The first moment is off by
default, which is what makes the saving complete — momentum cannot be factored,
so keeping it would put a third full copy back. In its place comes update
clipping: the update is scaled down whenever its root-mean-square exceeds a
threshold, which is what stops the occasional enormous step that momentum would
otherwise have smoothed. The second is a little end quality; the trade is a size
that trains at all against a size that does not.

Written here rather than imported, like everything else in this directory.
Vectors keep an unfactored second moment, because a vector has no second
dimension to factor along and its state is negligible anyway.
"""

from __future__ import annotations

import math

import torch


class Adafactor(torch.optim.Optimizer):
    """Adam's adaptivity with a second moment stored as two vectors."""

    def __init__(
        self,
        params,
        lr: float = 1e-3,
        beta2: float = 0.999,
        eps: tuple[float, float] = (1e-30, 1e-3),
        clip_threshold: float = 1.0,
        weight_decay: float = 0.0,
        beta1: float | None = None,
    ) -> None:
        if lr <= 0:
            raise ValueError("lr must be positive")
        if not 0.0 <= beta2 < 1.0:
            raise ValueError("beta2 belongs in [0, 1)")
        if beta1 is not None and not 0.0 <= beta1 < 1.0:
            raise ValueError("beta1 belongs in [0, 1) when it is used at all")

        super().__init__(
            params,
            {
                "lr": lr,
                "beta2": beta2,
                "eps": eps,
                "clip_threshold": clip_threshold,
                "weight_decay": weight_decay,
                "beta1": beta1,
            },
        )

    @staticmethod
    def _factored(shape: torch.Size) -> bool:
        """Whether a parameter of this shape has two dimensions to factor over."""
        return len(shape) >= 2

    @staticmethod
    def _approximate(row: torch.Tensor, column: torch.Tensor) -> torch.Tensor:
        """Rebuild the second moment from its row and column averages.

        The outer product of the two, normalised by the row average's mean so
        the reconstruction has the right scale. This is the whole trick: the
        matrix is never stored, only these two vectors and the multiplication
        that happens at the moment it is needed.
        """
        scaled = (row / row.mean(dim=-1, keepdim=True)).rsqrt_().unsqueeze(-1)
        return scaled * column.rsqrt().unsqueeze(-2)

    @torch.no_grad()
    def step(self, closure=None):  # type: ignore[override]
        loss = None
        if closure is not None:
            with torch.enable_grad():
                loss = closure()

        for group in self.param_groups:
            for parameter in group["params"]:
                if parameter.grad is not None:
                    self.step_parameter(parameter, group)

        return loss

    @torch.no_grad()
    def step_parameter(self, parameter: torch.Tensor, group: dict) -> None:
        """Update one parameter from its own gradient.

        Separate from `step` because a gradient can be consumed the moment it is
        final rather than after every other one has been computed, which is what
        lets a model train without ever holding a second full copy of itself.
        Nothing here reads any other parameter, which is what makes that safe.
        """
        gradient = parameter.grad
        if gradient is None:
            return
        if gradient.is_sparse:
            raise RuntimeError("Adafactor does not support sparse gradients")
        # The moments are float32 whatever the parameter is, because a running
        # average in bfloat16 stops moving once the update is small relative
        # to it.
        gradient = gradient.float()

        state = self.state[parameter]
        factored = self._factored(gradient.shape)
        if not state:
            state["step"] = 0
            if factored:
                state["row"] = torch.zeros(
                    gradient.shape[:-1], device=gradient.device, dtype=torch.float32
                )
                state["column"] = torch.zeros(
                    gradient.shape[:-2] + gradient.shape[-1:],
                    device=gradient.device,
                    dtype=torch.float32,
                )
            else:
                state["square"] = torch.zeros_like(gradient, dtype=torch.float32)
            if group["beta1"] is not None:
                state["moment"] = torch.zeros_like(gradient, dtype=torch.float32)

        state["step"] += 1
        beta2 = group["beta2"]
        # Bias correction, as in Adam: the averages start at zero and would
        # otherwise make the first steps far too large.
        correction = 1.0 - beta2 ** state["step"]

        squared = gradient.square().add_(group["eps"][0])
        if factored:
            state["row"].mul_(beta2).add_(squared.mean(dim=-1), alpha=1 - beta2)
            state["column"].mul_(beta2).add_(squared.mean(dim=-2), alpha=1 - beta2)
            update = self._approximate(
                state["row"] / correction, state["column"] / correction
            )
            update.mul_(gradient)
        else:
            state["square"].mul_(beta2).add_(squared, alpha=1 - beta2)
            update = gradient * (state["square"] / correction).rsqrt()

        # Update clipping, in place of the momentum that is not kept: a step
        # whose root-mean-square is above the threshold is scaled back to it,
        # which is what keeps a rare huge gradient from moving the weights
        # somewhere they cannot come back from.
        rms = update.norm(2) / math.sqrt(update.numel())
        update.div_(max(1.0, float(rms) / group["clip_threshold"]))

        if group["beta1"] is not None:
            state["moment"].mul_(group["beta1"]).add_(update, alpha=1 - group["beta1"])
            update = state["moment"].clone()

        if group["weight_decay"] != 0:
            # Decoupled, as in AdamW: applied to the weights rather than folded
            # into the gradient, so it does not interact with the adaptive
            # scaling.
            parameter.add_(parameter, alpha=-group["weight_decay"] * group["lr"])

        parameter.add_(update.to(parameter.dtype), alpha=-group["lr"])

    def state_bytes(self) -> int:
        """How much the optimiser is actually holding, for a report that knows."""
        total = 0
        for group in self.param_groups:
            for parameter in group["params"]:
                for value in self.state.get(parameter, {}).values():
                    if torch.is_tensor(value):
                        total += value.numel() * value.element_size()
        return total
