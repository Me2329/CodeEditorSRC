"""Training loop.

AdamW with decoupled weight decay, a cosine schedule with linear warmup,
gradient accumulation, gradient clipping, and periodic validation. Checkpoints
carry the configuration alongside the weights, so a saved model can be loaded
without being told what shape it is.
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


def build_optimizer(model: CodeCraftLM, config: TrainConfig) -> torch.optim.Optimizer:
    """AdamW with weight decay applied only where it belongs.

    Decay is for the matrices that mix channels. Applying it to norm gains and
    biases shrinks parameters whose scale is the thing being learned, which
    costs quality for no regularisation benefit.
    """
    decay, no_decay = [], []
    seen: set[int] = set()

    for parameter in model.parameters():
        if not parameter.requires_grad or id(parameter) in seen:
            continue
        seen.add(id(parameter))
        (decay if parameter.dim() >= 2 else no_decay).append(parameter)

    return torch.optim.AdamW(
        [
            {"params": decay, "weight_decay": config.weight_decay},
            {"params": no_decay, "weight_decay": 0.0},
        ],
        lr=config.learning_rate,
        betas=(config.beta1, config.beta2),
        eps=1e-8,
    )


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
    generator: np.random.Generator,
    device: torch.device,
) -> float:
    """Mean loss over a fixed number of random validation windows."""
    model.eval()
    losses = []
    for _ in range(config.eval_batches):
        inputs, targets = dataset.batch(config.batch_size, config.block_size, generator)
        _, loss, _ = model(inputs.to(device), targets=targets.to(device))
        losses.append(loss.item())
    model.train()
    return float(np.mean(losses))


def save_checkpoint(
    path: Path,
    model: CodeCraftLM,
    optimizer: torch.optim.Optimizer | None,
    step: int,
    val_loss: float,
    train_config: TrainConfig,
) -> None:
    """Write weights plus everything needed to reconstruct or resume."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "model_config": model.config.to_dict(),
        "train_config": asdict(train_config),
        "model": model.state_dict(),
        "step": step,
        "val_loss": val_loss,
    }
    if optimizer is not None:
        payload["optimizer"] = optimizer.state_dict()
    torch.save(payload, path)


def load_checkpoint(
    path: Path, device: torch.device | str = "cpu"
) -> tuple[CodeCraftLM, dict]:
    """Rebuild a model from a checkpoint without being told its shape."""
    payload = torch.load(path, map_location=device, weights_only=False)
    config = ModelConfig.from_dict(payload["model_config"])
    model = CodeCraftLM(config)
    model.load_state_dict(payload["model"])
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
) -> dict:
    """Run the training loop and return a record of it."""
    device = device or torch.device("cpu")
    model.to(device)
    model.train()

    torch.manual_seed(config.seed)
    generator = np.random.default_rng(config.seed)
    eval_generator = np.random.default_rng(config.seed + 1)

    optimizer = build_optimizer(model, config)

    history: list[dict] = []
    best_val = float("inf")
    tokens_per_step = config.batch_size * config.block_size * config.grad_accumulation
    started = time.time()

    if log:
        print(
            f"training {humanise(model.parameter_count())} parameters on "
            f"{len(train_dataset):,} tokens for {config.steps} steps "
            f"({tokens_per_step:,} tokens/step)"
        )

    for step in range(config.steps):
        learning_rate = learning_rate_at(step, config)
        for group in optimizer.param_groups:
            group["lr"] = learning_rate

        optimizer.zero_grad(set_to_none=True)

        total_loss = 0.0
        for _ in range(config.grad_accumulation):
            inputs, targets = train_dataset.batch(
                config.batch_size, config.block_size, generator
            )
            _, loss, _ = model(inputs.to(device), targets=targets.to(device))
            # Scale so accumulated gradients average rather than sum.
            (loss / config.grad_accumulation).backward()
            total_loss += loss.item() / config.grad_accumulation

        grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), config.grad_clip)
        optimizer.step()

        if log and (step % config.log_every == 0 or step == config.steps - 1):
            elapsed = time.time() - started
            throughput = tokens_per_step * (step + 1) / max(elapsed, 1e-6)
            print(
                f"  step {step:>5}/{config.steps}  loss {total_loss:6.3f}  "
                f"lr {learning_rate:.2e}  |grad| {grad_norm:5.2f}  "
                f"{throughput:>7,.0f} tok/s",
                flush=True,
            )

        is_last = step == config.steps - 1
        if (step + 1) % config.eval_every == 0 or is_last:
            val_loss = evaluate(model, val_dataset, config, eval_generator, device)
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

            if val_loss < best_val:
                best_val = val_loss
                save_checkpoint(
                    output_dir / "model.pt", model, optimizer, step + 1, val_loss, config
                )

    elapsed = time.time() - started
    summary = {
        "parameters": model.parameter_count(),
        "steps": config.steps,
        "tokens_seen": tokens_per_step * config.steps,
        "best_val_loss": best_val,
        "best_val_perplexity": math.exp(min(best_val, 20)),
        "elapsed_seconds": elapsed,
        "tokens_per_second": tokens_per_step * config.steps / max(elapsed, 1e-6),
        "history": history,
    }
    (output_dir / "training.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )

    if log:
        print(
            f"\ndone in {elapsed:.1f}s  best val loss {best_val:.3f}  "
            f"perplexity {summary['best_val_perplexity']:.1f}"
        )
    return summary
