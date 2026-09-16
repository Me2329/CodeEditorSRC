"""Training loop.

AdamW with decoupled weight decay, a cosine schedule with linear warmup,
gradient accumulation, gradient clipping, and periodic validation. Checkpoints
carry the configuration alongside the weights, so a saved model can be loaded
without being told what shape it is.

On a GPU the forward and backward passes run under autocast, in bfloat16 where
the card supports it. Weights, gradients and the optimiser's moments stay in
float32: mixed precision means the matmuls are narrow, not the master copy, and
keeping the master copy wide is what stops small updates rounding away to
nothing over thousands of steps.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import torch

from .config import ModelConfig, humanise
from .data import TokenDataset
from .device import (
    architecture_warning,
    autocast_dtype,
    describe_device,
    enable_fast_matmul,
    peak_memory_bytes,
    reset_peak_memory,
    resolve_device,
    synchronize,
)
from .model import CodeCraftLM


@dataclass
class TrainConfig:
    steps: int = 2000
    batch_size: int = 16
    block_size: int = 256
    # Multiplies the effective batch without needing the memory for it: several
    # forward and backward passes accumulate before one optimiser step.
    grad_accumulation: int = 1

    learning_rate: float = 3e-4
    min_learning_rate: float = 3e-5
    warmup_steps: int = 100
    weight_decay: float = 0.1
    beta1: float = 0.9
    # Slightly lower than the usual 0.999: shorter runs benefit from the second
    # moment adapting faster.
    beta2: float = 0.95
    grad_clip: float = 1.0

    eval_every: int = 200
    eval_batches: int = 20
    log_every: int = 20
    seed: int = 1337

    # "auto" picks bfloat16 on a card that supports it, float16 on an older one,
    # and float32 on a CPU. Recorded in the checkpoint so a run is reproducible.
    precision: str = "auto"
    # torch.compile fuses the graph, which is a solid speedup on a GPU and costs
    # a slow first step. Off by default because compilation can fail on an
    # unusual setup and a failed compile should not cost you a training run.
    compile_model: bool = False

    # Stop after this many hours regardless of step count. A long run on a
    # machine someone also uses needs an end it can be relied on to reach.
    max_hours: float | None = None

    # "adamw" or "adafactor". AdamW is better and costs two full copies of the
    # parameters; Adafactor stores a second moment as one number per row and
    # one per column, which is what decides whether a size fits on a card at
    # all. See `optimizer.py`.
    optimizer: str = "adamw"

    # Update each parameter as soon as its gradient is final, inside the
    # backward pass, and free the gradient there and then. The model is then
    # never accompanied by a second full copy of itself: peak memory becomes the
    # weights plus the largest single gradient. Costs global gradient clipping
    # and gradient accumulation, both of which need every gradient at once.
    fused_step: bool = False


def build_optimizer(model: CodeCraftLM, config: TrainConfig) -> torch.optim.Optimizer:
    """The chosen optimiser, with weight decay applied only where it belongs.

    Decay is for the matrices that mix channels. Applying it to norm gains and
    biases shrinks parameters whose scale is the thing being learned, which
    costs quality for no regularisation benefit. That split is the same
    whichever optimiser runs.
    """
    decay, no_decay = [], []
    seen: set[int] = set()

    for parameter in model.parameters():
        if not parameter.requires_grad or id(parameter) in seen:
            continue
        seen.add(id(parameter))
        (decay if parameter.dim() >= 2 else no_decay).append(parameter)

    groups = [
        {"params": decay, "weight_decay": config.weight_decay},
        {"params": no_decay, "weight_decay": 0.0},
    ]

    if config.optimizer == "adafactor":
        from .optimizer import Adafactor

        return Adafactor(groups, lr=config.learning_rate, beta2=config.beta2)
    if config.optimizer != "adamw":
        raise ValueError(f"unknown optimizer {config.optimizer!r}; use adamw or adafactor")

    return torch.optim.AdamW(
        groups,
        lr=config.learning_rate,
        betas=(config.beta1, config.beta2),
        eps=1e-8,
    )


def check_fused_step(config: TrainConfig, *, scaler_enabled: bool) -> None:
    """Refuse a fused step that cannot mean what it says.

    Each of these is a combination that would appear to work and would quietly
    train something other than what was asked for, so each is an error rather
    than a warning.
    """
    if config.grad_accumulation != 1:
        raise ValueError(
            "fused_step updates each parameter during the backward pass, so there is "
            "no gradient left to accumulate into; use a larger batch instead"
        )
    if config.optimizer != "adafactor":
        raise ValueError(
            "fused_step is for fitting a model that does not otherwise fit, and AdamW's "
            "two extra copies are most of what does not fit; use --optimizer adafactor"
        )
    if scaler_enabled:
        raise ValueError(
            "fused_step cannot use a gradient scaler: unscaling needs every gradient at "
            "once, which is the thing being avoided. Use bf16 or fp32"
        )


def install_fused_step(model: CodeCraftLM, optimizer) -> list:
    """Give each parameter its own step, run the moment its gradient is final.

    The hook fires once per parameter per backward pass, after every
    contribution to that gradient has been summed, so nothing is updated while
    it is still being read: a layer's weights are used to produce the gradient
    flowing past them, and that has already happened by the time this runs.

    Returns the handles, which the caller removes when it is done with them.
    """
    groups = {
        id(parameter): group
        for group in optimizer.param_groups
        for parameter in group["params"]
    }

    def consume(parameter: torch.Tensor) -> None:
        optimizer.step_parameter(parameter, groups[id(parameter)])
        # The whole point. Holding it would be holding the second copy.
        parameter.grad = None

    return [
        parameter.register_post_accumulate_grad_hook(consume)
        for parameter in model.parameters()
        if parameter.requires_grad and id(parameter) in groups
    ]


def learning_rate_at(step: int, config: TrainConfig) -> float:
    """Linear warmup, then cosine decay to the floor.

    Warmup keeps the first updates from wrecking a freshly initialised model,
    when gradients are large and Adam's moment estimates are still empty.
    """
    if step < config.warmup_steps:
        return config.learning_rate * (step + 1) / max(1, config.warmup_steps)

    # Denominator counts the gaps between steps, not the steps, so the last
    # step of the run lands exactly on the floor rather than just above it.
    progress = (step - config.warmup_steps) / max(1, config.steps - config.warmup_steps - 1)
    progress = min(1.0, max(0.0, progress))
    cosine = 0.5 * (1.0 + math.cos(math.pi * progress))
    return config.min_learning_rate + cosine * (
        config.learning_rate - config.min_learning_rate
    )


@torch.no_grad()
def evaluate(
    model: CodeCraftLM,
    dataset: TokenDataset,
    config: TrainConfig,
    device: torch.device,
    amp_dtype: torch.dtype | None = None,
) -> float:
    """Mean loss over a fixed set of validation windows.

    The same windows every time, which is the point. Drawing fresh ones on each
    evaluation compares two checkpoints against two different samples, and at 20
    batches the difference between samples is large enough to pick the wrong
    one: on the run this was found in, the checkpoint kept as best scored 2.577
    against its own sample and 2.686 against a proper evaluation, while the
    final checkpoint it beat scored 2.680.

    The cost is that the number describes one sample of the validation set
    rather than an unbiased estimate of all of it. That is the right trade for a
    number whose whole job is to be compared with the same number from a
    hundred steps ago.

    Run in the same precision as training, or the reported number describes a
    model that is not the one being trained.
    """
    model.eval()
    losses = []
    # Seeded from the configuration rather than from a generator that advances,
    # so every evaluation in a run scores the same windows and successive
    # numbers can be compared.
    windows = np.random.default_rng(config.seed + 1)
    for _ in range(config.eval_batches):
        inputs, targets = dataset.batch(
            config.batch_size, config.block_size, windows, device=device
        )
        with torch.autocast(
            device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None
        ):
            _, loss, _ = model(inputs, targets=targets)
        losses.append(loss.item())
    model.train()
    return float(np.mean(losses))


def uncompiled(model: CodeCraftLM) -> CodeCraftLM:
    """The original module behind a `torch.compile` wrapper.

    Compiling prefixes every parameter name with `_orig_mod.`, so a checkpoint
    written from the wrapper cannot be loaded by anything that did not also
    compile. Saving the module underneath keeps checkpoints portable.
    """
    return getattr(model, "_orig_mod", model)


def save_checkpoint(
    path: Path,
    model: CodeCraftLM,
    optimizer: torch.optim.Optimizer | None,
    step: int,
    val_loss: float,
    train_config: TrainConfig,
) -> None:
    """Write weights plus everything needed to reconstruct or resume.

    Through a temporary file and a rename, which is atomic on every filesystem
    this runs on. A checkpoint written in place is a checkpoint that can be
    half-written: the disk filling during `torch.save` leaves a file that is the
    right size and unreadable, and it has replaced the last good one.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    model = uncompiled(model)
    payload = {
        "model_config": model.config.to_dict(),
        "train_config": asdict(train_config),
        # Always on the CPU, so a checkpoint written on a GPU loads on a machine
        # that has none.
        "model": {name: tensor.detach().cpu() for name, tensor in model.state_dict().items()},
        "step": step,
        "val_loss": val_loss,
    }
    if optimizer is not None:
        payload["optimizer"] = optimizer.state_dict()

    staged = path.with_name(path.name + ".partial")
    try:
        torch.save(payload, staged)
        staged.replace(path)
    finally:
        # A failed write leaves gigabytes behind, on the disk that just proved
        # it had no room.
        staged.unlink(missing_ok=True)


def load_checkpoint(
    path: Path, device: torch.device | str = "cpu"
) -> tuple[CodeCraftLM, dict]:
    """Rebuild a model from a checkpoint without being told its shape."""
    payload = torch.load(path, map_location="cpu", weights_only=False)
    config = ModelConfig.from_dict(payload["model_config"])
    model = CodeCraftLM(config)

    # Tolerate a checkpoint written from a compiled model by an older version.
    state = {
        name.removeprefix("_orig_mod."): tensor
        for name, tensor in payload["model"].items()
    }
    model.load_state_dict(state)

    model.to(device)
    model.eval()
    return model, payload


def train(
    model: CodeCraftLM,
    train_dataset: TokenDataset,
    val_dataset: TokenDataset,
    config: TrainConfig,
    *,
    output_dir: Path,
    device: torch.device | None = None,
    log: bool = True,
    resume_from: Path | None = None,
) -> dict:
    """Run the training loop and return a record of it."""
    device = device or resolve_device()

    warning = architecture_warning(device)
    if warning and log:
        print(f"warning: {warning}\n")

    enable_fast_matmul(device)
    amp_dtype = autocast_dtype(device, config.precision)
    # float16 has too little exponent range to hold gradients directly: without
    # scaling, small ones flush to zero and the model silently stops learning.
    # bfloat16 keeps float32's range, so it needs no scaler.
    scaler = torch.amp.GradScaler(device.type, enabled=amp_dtype is torch.float16)

    model.to(device)
    model.train()

    torch.manual_seed(config.seed)
    generator = np.random.default_rng(config.seed)

    optimizer = build_optimizer(model, config)

    if config.fused_step:
        check_fused_step(config, scaler_enabled=scaler.is_enabled())

    saves_failed = 0
    start_step = 0
    if resume_from is not None and resume_from.exists():
        payload = torch.load(resume_from, map_location="cpu", weights_only=False)
        state = {
            name.removeprefix("_orig_mod."): tensor
            for name, tensor in payload["model"].items()
        }
        model.load_state_dict(state)
        model.to(device)
        trained_with = str(payload.get("train_config", {}).get("optimizer", "adamw"))
        if "optimizer" in payload and trained_with == config.optimizer:
            # Without the moments the first steps after a resume are effectively
            # unwarmed, and the loss visibly jumps.
            optimizer.load_state_dict(payload["optimizer"])
        elif "optimizer" in payload and log:
            # Two optimisers keep different state under the same key, and
            # loading one into the other raises somewhere unhelpful. Starting
            # this one empty costs a few hundred warm-up steps and is the only
            # thing that can work.
            print(
                f"  note: this checkpoint was trained with {trained_with}, and this run uses "
                f"{config.optimizer}; its state is being started fresh"
            )
        start_step = int(payload.get("step", 0))
        best_val_seen = float(payload.get("val_loss", float("inf")))
        if log:
            print(f"resuming from step {start_step}, val loss {best_val_seen:.3f}")
    else:
        best_val_seen = float("inf")

    hooks: list = []
    if config.fused_step:
        hooks = install_fused_step(model, optimizer)

    # The optimiser must be built from the real parameters, so compile after.
    # It wraps the module, and `uncompiled` unwraps it again for checkpointing.
    if config.compile_model:
        if log:
            print("compiling the model (the first step will be slow)")
        model = torch.compile(model)

    history: list[dict] = []
    best_val = best_val_seen
    tokens_per_step = config.batch_size * config.block_size * config.grad_accumulation
    reset_peak_memory(device)
    started = time.time()

    if log:
        precision_name = "fp32" if amp_dtype is None else str(amp_dtype).removeprefix("torch.")
        print(
            f"training {humanise(uncompiled(model).parameter_count())} parameters on "
            f"{len(train_dataset):,} tokens for {config.steps} steps "
            f"({tokens_per_step:,} tokens/step)\n"
            f"  device: {describe_device(device)}, precision {precision_name}"
        )

    deadline = started + config.max_hours * 3600 if config.max_hours else None
    stopped_early = False
    last_step = start_step - 1

    for step in range(start_step, config.steps):
        # Checked at the top but acted on at the bottom, so the step in progress
        # finishes and is evaluated and checkpointed before the loop exits.
        # Breaking here instead would throw away everything since the last eval.
        out_of_time = deadline is not None and time.time() > deadline

        last_step = step
        learning_rate = learning_rate_at(step, config)
        for group in optimizer.param_groups:
            group["lr"] = learning_rate

        optimizer.zero_grad(set_to_none=True)

        total_loss = 0.0
        for _ in range(config.grad_accumulation):
            inputs, targets = train_dataset.batch(
                config.batch_size, config.block_size, generator, device=device
            )
            with torch.autocast(
                device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None
            ):
                _, loss, _ = model(inputs, targets=targets)
            # Scale so accumulated gradients average rather than sum.
            scaler.scale(loss / config.grad_accumulation).backward()
            total_loss += loss.item() / config.grad_accumulation

        if config.fused_step:
            # Already applied, parameter by parameter, during the backward pass.
            # There is no global norm to report because there was never a moment
            # when every gradient existed at once; Adafactor's own per-parameter
            # update clipping is what stands in for clipping them together.
            grad_norm = float("nan")
        else:
            # Gradients have to come out of the scaler's units before they can be
            # clipped, or the norm being compared to the threshold is the scaled one.
            scaler.unscale_(optimizer)
            grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), config.grad_clip)
            scaler.step(optimizer)
            scaler.update()

        if log and (step % config.log_every == 0 or step == config.steps - 1):
            # CUDA queues work asynchronously, so timing without this measures
            # how fast steps were submitted rather than how fast they ran.
            synchronize(device)
            elapsed = time.time() - started
            throughput = tokens_per_step * (step + 1) / max(elapsed, 1e-6)
            print(
                f"  step {step:>5}/{config.steps}  loss {total_loss:6.3f}  "
                f"lr {learning_rate:.2e}  |grad| {grad_norm:5.2f}  "
                f"{throughput:>7,.0f} tok/s",
                flush=True,
            )

        is_last = step == config.steps - 1 or out_of_time
        if (step + 1) % config.eval_every == 0 or is_last:
            val_loss = evaluate(
                model, val_dataset, config, device, amp_dtype
            )
            record = {
                "step": step + 1,
                "train_loss": total_loss,
                "val_loss": val_loss,
                # Perplexity is the loss exponentiated: how many equally likely
                # tokens the model is effectively choosing between.
                "val_perplexity": math.exp(min(val_loss, 20)),
            }
            history.append(record)
            if log:
                print(
                    f"  eval  step {step + 1:>5}  val loss {val_loss:6.3f}  "
                    f"perplexity {record['val_perplexity']:8.1f}",
                    flush=True,
                )

            improved = val_loss < best_val
            if improved:
                best_val = val_loss

            # A failed write must not end the run. A checkpoint at a billion
            # parameters is four gigabytes, the disk it goes to is shared with
            # whatever else the machine does, and losing three weeks of training
            # because the last save found no room would be absurd. The rename in
            # `save_checkpoint` means the previous checkpoint is still intact,
            # so the honest thing is to say so and keep going: the next eval is
            # another chance, and the disk may have room by then.
            for name, wanted in (("model.pt", improved), ("latest.pt", True)):
                if not wanted:
                    continue
                try:
                    save_checkpoint(
                        output_dir / name, model, optimizer, step + 1, val_loss, config
                    )
                except (OSError, RuntimeError) as error:
                    saves_failed += 1
                    if log:
                        print(f"  warning: could not write {name}: {error}", flush=True)

        if out_of_time:
            if log:
                print(f"\nreached the {config.max_hours}h budget at step {step + 1}")
            stopped_early = True
            break

    synchronize(device)
    elapsed = time.time() - started
    peak = peak_memory_bytes(device)
    # What this invocation actually did, which is not `config.steps` when a run
    # resumes partway or stops on its time budget. Reporting the planned figure
    # makes a resumed run look several times faster than it is.
    steps_run = last_step + 1 - start_step
    summary = {
        "parameters": uncompiled(model).parameter_count(),
        "started_at_step": start_step,
        "steps_run": steps_run,
        "stopped_early": stopped_early,
        # Zero unless a disk refused a checkpoint. Recorded rather than only
        # printed, because a run nobody watched is exactly the one where this
        # matters.
        "checkpoint_writes_failed": saves_failed,
        "device": describe_device(device),
        "precision": "fp32" if amp_dtype is None else str(amp_dtype).removeprefix("torch."),
        "peak_memory_gb": round(peak / 1e9, 2) if peak else None,
        "steps": config.steps,
        "tokens_seen": tokens_per_step * steps_run,
        "tokens_per_step": tokens_per_step,
        "best_val_loss": best_val,
        "best_val_perplexity": math.exp(min(best_val, 20)),
        "elapsed_seconds": elapsed,
        "tokens_per_second": tokens_per_step * steps_run / max(elapsed, 1e-6),
        "optimizer": config.optimizer,
        "fused_step": config.fused_step,
        "history": history,
    }
    for hook in hooks:
        hook.remove()

    (output_dir / "training.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )

    if log:
        memory = f"  peak {summary['peak_memory_gb']}GB" if peak else ""
        print(
            f"\ndone in {elapsed:.1f}s  best val loss {best_val:.3f}  "
            f"perplexity {summary['best_val_perplexity']:.1f}{memory}"
        )
    return summary
