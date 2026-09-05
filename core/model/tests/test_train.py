"""The training loop, the schedule, and checkpoints."""

from __future__ import annotations

import json

import numpy as np
import pytest
import torch

from codecraft_model.config import ModelConfig
from codecraft_model.data import TokenDataset, write_dataset
from codecraft_model.model import CodeCraftLM
from codecraft_model.train import (
    TrainConfig,
    build_optimizer,
    evaluate,
    learning_rate_at,
    load_checkpoint,
    save_checkpoint,
    train,
    uncompiled,
)

CONFIG = ModelConfig(
    vocab_size=64, d_model=64, n_layers=2, n_heads=4, n_kv_heads=2, d_ff=128, max_seq_len=64
)


@pytest.fixture
def learnable_dataset(tmp_path):
    """A repeating pattern: a working model must drive the loss down on it."""
    pattern = np.tile(np.arange(1, 17, dtype=np.uint16), 3000)
    write_dataset(pattern, tmp_path, validation_fraction=0.1)
    return (
        TokenDataset(tmp_path / "train.bin"),
        TokenDataset(tmp_path / "val.bin"),
        tmp_path,
    )


# ------------------------------------------------------------------- schedule


def test_warmup_rises_to_the_peak() -> None:
    config = TrainConfig(steps=100, warmup_steps=10, learning_rate=1e-3)
    assert learning_rate_at(0, config) < learning_rate_at(5, config)
    assert learning_rate_at(9, config) == pytest.approx(1e-3)


def test_cosine_decays_to_the_floor() -> None:
    config = TrainConfig(
        steps=100, warmup_steps=10, learning_rate=1e-3, min_learning_rate=1e-5
    )
    assert learning_rate_at(99, config) == pytest.approx(1e-5, rel=1e-2)


def test_schedule_never_leaves_its_bounds() -> None:
    config = TrainConfig(steps=50, warmup_steps=5, learning_rate=1e-3, min_learning_rate=1e-5)
    rates = [learning_rate_at(step, config) for step in range(60)]
    assert all(1e-5 - 1e-9 <= rate <= 1e-3 + 1e-9 for rate in rates)


def test_schedule_decreases_after_warmup() -> None:
    config = TrainConfig(steps=100, warmup_steps=10)
    after = [learning_rate_at(step, config) for step in range(10, 100)]
    assert after == sorted(after, reverse=True)


# ------------------------------------------------------------------ optimizer


def test_weight_decay_applies_only_to_matrices() -> None:
    """Decaying norm gains shrinks the very scale being learned."""
    model = CodeCraftLM(CONFIG)
    optimizer = build_optimizer(model, TrainConfig(weight_decay=0.1))

    decayed, undecayed = optimizer.param_groups
    assert decayed["weight_decay"] == 0.1 and undecayed["weight_decay"] == 0.0
    assert all(parameter.dim() >= 2 for parameter in decayed["params"])
    assert all(parameter.dim() < 2 for parameter in undecayed["params"])


def test_tied_weights_are_registered_once() -> None:
    """Twice would apply decay and momentum to the same matrix twice over."""
    model = CodeCraftLM(CONFIG)
    optimizer = build_optimizer(model, TrainConfig())

    registered = sum(len(group["params"]) for group in optimizer.param_groups)
    assert registered == len({id(p) for p in model.parameters()})


# ----------------------------------------------------------------------- loop


def test_training_reduces_the_loss(learnable_dataset) -> None:
    """The point of all of it: on learnable data, the loss must fall."""
    train_dataset, val_dataset, output = learnable_dataset
    torch.manual_seed(0)

    summary = train(
        CodeCraftLM(CONFIG),
        train_dataset,
        val_dataset,
        TrainConfig(steps=60, batch_size=8, block_size=32, warmup_steps=5, eval_every=30),
        output_dir=output,
        log=False,
    )

    history = summary["history"]
    assert history[-1]["val_loss"] < history[0]["val_loss"]
    # Below the uniform baseline of log(64) ~= 4.16, so it learned something.
    assert summary["best_val_loss"] < 4.0


def test_summary_records_the_run(learnable_dataset) -> None:
    train_dataset, val_dataset, output = learnable_dataset
    summary = train(
        CodeCraftLM(CONFIG),
        train_dataset,
        val_dataset,
        TrainConfig(steps=4, batch_size=4, block_size=16, warmup_steps=1, eval_every=2),
        output_dir=output,
        log=False,
    )

    assert summary["tokens_seen"] == 4 * 4 * 16
    assert summary["parameters"] == CONFIG.parameter_count()
    assert summary["best_val_perplexity"] > 1.0
    assert json.loads((output / "training.json").read_text())["steps"] == 4


def test_gradient_accumulation_multiplies_the_effective_batch(learnable_dataset) -> None:
    train_dataset, val_dataset, output = learnable_dataset
    summary = train(
        CodeCraftLM(CONFIG),
        train_dataset,
        val_dataset,
        TrainConfig(
            steps=2, batch_size=4, block_size=16, grad_accumulation=3, warmup_steps=1,
            eval_every=2,
        ),
        output_dir=output,
        log=False,
    )
    assert summary["tokens_seen"] == 2 * 4 * 16 * 3


def test_training_is_reproducible_from_a_seed(learnable_dataset) -> None:
    train_dataset, val_dataset, output = learnable_dataset

    def run() -> float:
        torch.manual_seed(0)
        return train(
            CodeCraftLM(CONFIG),
            train_dataset,
            val_dataset,
            TrainConfig(steps=6, batch_size=4, block_size=16, warmup_steps=2, eval_every=6),
            output_dir=output,
            log=False,
        )["best_val_loss"]

    assert run() == pytest.approx(run(), rel=1e-6)


def test_evaluation_does_not_leave_the_model_in_eval_mode(learnable_dataset) -> None:
    """Dropout silently off for the rest of training would be hard to notice."""
    _, val_dataset, _ = learnable_dataset
    model = CodeCraftLM(CONFIG)
    model.train()

    evaluate(model, val_dataset, TrainConfig(eval_batches=2, batch_size=2, block_size=16),
             np.random.default_rng(0), torch.device("cpu"))
    assert model.training


# ---------------------------------------------------------------- checkpoints


def test_checkpoint_round_trips_without_being_told_the_shape(tmp_path) -> None:
    model = CodeCraftLM(CONFIG)
    path = tmp_path / "model.pt"
    save_checkpoint(path, model, None, step=7, val_loss=1.5, train_config=TrainConfig())

    reloaded, payload = load_checkpoint(path)
    assert reloaded.config == CONFIG
    assert payload["step"] == 7 and payload["val_loss"] == 1.5


def test_reloaded_weights_produce_identical_output(tmp_path) -> None:
    torch.manual_seed(0)
    model = CodeCraftLM(CONFIG).eval()
    path = tmp_path / "model.pt"
    save_checkpoint(path, model, None, 1, 1.0, TrainConfig())

    reloaded, _ = load_checkpoint(path)
    tokens = torch.randint(0, CONFIG.vocab_size, (1, 8))
    with torch.no_grad():
        assert torch.allclose(model(tokens)[0], reloaded(tokens)[0])


def test_checkpoint_carries_optimizer_state_for_resuming(tmp_path) -> None:
    model = CodeCraftLM(CONFIG)
    optimizer = build_optimizer(model, TrainConfig())
    path = tmp_path / "model.pt"
    save_checkpoint(path, model, optimizer, 1, 1.0, TrainConfig())

    assert "optimizer" in torch.load(path, weights_only=False)


def test_only_the_best_checkpoint_is_kept(learnable_dataset) -> None:
    """A later, worse evaluation must not overwrite a better model."""
    train_dataset, val_dataset, output = learnable_dataset
    summary = train(
        CodeCraftLM(CONFIG),
        train_dataset,
        val_dataset,
        TrainConfig(steps=40, batch_size=8, block_size=32, warmup_steps=4, eval_every=10),
        output_dir=output,
        log=False,
    )

    _, payload = load_checkpoint(output / "model.pt")
    assert payload["val_loss"] == pytest.approx(summary["best_val_loss"])


# ------------------------------------------------------------------- device


def test_the_summary_records_where_and_how_it_ran(learnable_dataset) -> None:
    train_dataset, val_dataset, output = learnable_dataset
    summary = train(
        CodeCraftLM(CONFIG),
        train_dataset,
        val_dataset,
        TrainConfig(steps=2, batch_size=2, block_size=16, warmup_steps=1, eval_every=2),
        output_dir=output,
        log=False,
    )

    assert "CPU" in summary["device"]
    # No autocast on a CPU, so the run really was float32.
    assert summary["precision"] == "fp32"
    assert summary["peak_memory_gb"] is None


def test_an_explicit_precision_is_carried_into_the_checkpoint(tmp_path) -> None:
    """So a run can be reproduced exactly, not approximately."""
    model = CodeCraftLM(CONFIG)
    path = tmp_path / "model.pt"
    save_checkpoint(path, model, None, 1, 1.0, TrainConfig(precision="bf16"))

    assert torch.load(path, weights_only=False)["train_config"]["precision"] == "bf16"


def test_uncompiled_returns_the_module_behind_a_wrapper() -> None:
    """`torch.compile` prefixes every parameter name with `_orig_mod.`."""
    model = CodeCraftLM(CONFIG)
    assert uncompiled(model) is model

    class Wrapper:
        def __init__(self, module):
            self._orig_mod = module

    assert uncompiled(Wrapper(model)) is model


def test_a_checkpoint_from_a_compiled_model_still_loads(tmp_path) -> None:
    """A compiled run must not produce weights only a compiled run can read."""
    model = CodeCraftLM(CONFIG)
    path = tmp_path / "model.pt"
    save_checkpoint(path, model, None, 1, 1.0, TrainConfig())

    payload = torch.load(path, weights_only=False)
    payload["model"] = {f"_orig_mod.{k}": v for k, v in payload["model"].items()}
    torch.save(payload, path)

    reloaded, _ = load_checkpoint(path)
    assert reloaded.config == CONFIG


def test_checkpoint_tensors_are_written_on_the_cpu(tmp_path) -> None:
    """A checkpoint trained on a GPU has to load on a machine without one."""
    save_checkpoint(tmp_path / "model.pt", CodeCraftLM(CONFIG), None, 1, 1.0, TrainConfig())

    payload = torch.load(tmp_path / "model.pt", weights_only=False)
    assert all(tensor.device.type == "cpu" for tensor in payload["model"].values())


def test_batches_land_on_the_requested_device(learnable_dataset) -> None:
    train_dataset, _, _ = learnable_dataset
    inputs, targets = train_dataset.batch(
        2, 16, np.random.default_rng(0), device=torch.device("cpu")
    )
    assert inputs.device.type == "cpu" and targets.device.type == "cpu"
