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
    check_fused_step,
    evaluate,
    install_fused_step,
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
             torch.device("cpu"))
    assert model.training


def test_two_evaluations_of_one_model_agree(learnable_dataset) -> None:
    """Otherwise "keep the best checkpoint" compares two different samples.

    On the run this was found in, the checkpoint kept as best scored 2.577
    against its own sample and 2.686 against a proper evaluation, while the
    final checkpoint it had beaten scored 2.680.
    """
    _, val_dataset, _ = learnable_dataset
    model = CodeCraftLM(CONFIG)
    config = TrainConfig(eval_batches=3, batch_size=2, block_size=16)

    first = evaluate(model, val_dataset, config, torch.device("cpu"))
    second = evaluate(model, val_dataset, config, torch.device("cpu"))

    assert first == second


def test_a_different_seed_scores_different_windows(learnable_dataset) -> None:
    """The windows are fixed within a run, not fixed for all time."""
    _, val_dataset, _ = learnable_dataset
    model = CodeCraftLM(CONFIG)

    one = evaluate(model, val_dataset, TrainConfig(eval_batches=3, batch_size=2, block_size=16, seed=1), torch.device("cpu"))
    two = evaluate(model, val_dataset, TrainConfig(eval_batches=3, batch_size=2, block_size=16, seed=2), torch.device("cpu"))

    assert one != two


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


# --------------------------------------------------------- resume and budget


def test_a_resumed_run_continues_from_where_it_stopped(learnable_dataset) -> None:
    train_dataset, val_dataset, output = learnable_dataset
    config = TrainConfig(steps=20, batch_size=4, block_size=16, warmup_steps=2, eval_every=10)

    train(CodeCraftLM(CONFIG), train_dataset, val_dataset, config, output_dir=output, log=False)
    assert (output / "latest.pt").exists()

    resumed = train(
        CodeCraftLM(CONFIG),
        train_dataset,
        val_dataset,
        TrainConfig(steps=30, batch_size=4, block_size=16, warmup_steps=2, eval_every=10),
        output_dir=output,
        log=False,
        resume_from=output / "latest.pt",
    )

    assert resumed["started_at_step"] == 20
    # Only the remaining ten steps ran, not the whole schedule again — which is
    # what this line said in words while asserting the opposite in code.
    assert resumed["steps_run"] == 10
    assert resumed["tokens_seen"] == 10 * 4 * 16


def test_resuming_restores_the_optimiser_moments(learnable_dataset) -> None:
    """Without them the first steps after a resume are effectively unwarmed."""
    train_dataset, val_dataset, output = learnable_dataset
    config = TrainConfig(steps=10, batch_size=4, block_size=16, warmup_steps=2, eval_every=10)
    train(CodeCraftLM(CONFIG), train_dataset, val_dataset, config, output_dir=output, log=False)

    payload = torch.load(output / "latest.pt", weights_only=False)
    assert payload["optimizer"]["state"]


def test_latest_is_written_even_when_it_is_not_the_best(learnable_dataset) -> None:
    """Resuming has to continue from where the run was, not from its best score."""
    train_dataset, val_dataset, output = learnable_dataset
    train(
        CodeCraftLM(CONFIG),
        train_dataset,
        val_dataset,
        TrainConfig(steps=30, batch_size=8, block_size=32, warmup_steps=3, eval_every=10),
        output_dir=output,
        log=False,
    )

    best = torch.load(output / "model.pt", weights_only=False)
    latest = torch.load(output / "latest.pt", weights_only=False)
    assert latest["step"] >= best["step"]


def test_a_run_with_no_time_left_still_checkpoints(learnable_dataset) -> None:
    """Stopping on the budget must not throw away work since the last eval."""
    train_dataset, val_dataset, output = learnable_dataset
    summary = train(
        CodeCraftLM(CONFIG),
        train_dataset,
        val_dataset,
        TrainConfig(
            steps=10_000, batch_size=4, block_size=16, warmup_steps=2,
            eval_every=10_000, max_hours=1e-9,
        ),
        output_dir=output,
        log=False,
    )

    assert summary["stopped_early"]
    assert summary["steps_run"] < 10_000
    assert (output / "latest.pt").exists()
    assert summary["history"], "the final step must have been evaluated"


def test_a_run_inside_its_budget_is_not_marked_early(learnable_dataset) -> None:
    train_dataset, val_dataset, output = learnable_dataset
    summary = train(
        CodeCraftLM(CONFIG),
        train_dataset,
        val_dataset,
        TrainConfig(steps=4, batch_size=4, block_size=16, warmup_steps=1, eval_every=2,
                    max_hours=1.0),
        output_dir=output,
        log=False,
    )
    assert not summary["stopped_early"]


def test_a_run_can_use_the_factored_optimiser(learnable_dataset) -> None:
    """End to end: the loss comes down and the checkpoint records which one."""
    train_set, val_set, directory = learnable_dataset
    summary = train(
        CodeCraftLM(CONFIG),
        train_set,
        val_set,
        TrainConfig(
            steps=40, batch_size=8, block_size=32, eval_every=20, warmup_steps=5,
            learning_rate=3e-3, optimizer="adafactor",
        ),
        output_dir=directory,
        log=False,
    )

    assert summary["history"][-1]["val_loss"] < summary["history"][0]["val_loss"]
    payload = torch.load(directory / "model.pt", map_location="cpu", weights_only=False)
    assert payload["train_config"]["optimizer"] == "adafactor"


def test_resuming_with_a_different_optimiser_starts_its_state_fresh(
    learnable_dataset, capsys
) -> None:
    """Two optimisers keep different state, and loading one into the other raises."""
    train_set, val_set, directory = learnable_dataset
    options = dict(steps=10, batch_size=8, block_size=32, eval_every=10, warmup_steps=2)
    train(
        CodeCraftLM(CONFIG), train_set, val_set,
        TrainConfig(optimizer="adafactor", **options),
        output_dir=directory, log=False,
    )

    capsys.readouterr()
    # Further than the first run reached, or there is nothing left to do.
    summary = train(
        CodeCraftLM(CONFIG), train_set, val_set,
        TrainConfig(**{**options, "steps": 20}),
        output_dir=directory, resume_from=directory / "latest.pt", log=True,
    )

    assert "started fresh" in capsys.readouterr().out
    assert summary["steps_run"] > 0


def test_an_unknown_optimiser_is_refused() -> None:
    with pytest.raises(ValueError, match="adafactor"):
        build_optimizer(CodeCraftLM(CONFIG), TrainConfig(optimizer="lion"))


def test_a_checkpoint_is_written_through_a_rename(learnable_dataset, monkeypatch) -> None:
    """A half-written file must never replace a good one."""
    _, _, directory = learnable_dataset
    model = CodeCraftLM(CONFIG)
    save_checkpoint(directory / "model.pt", model, None, 1, 1.0, TrainConfig())
    good = (directory / "model.pt").read_bytes()

    real_save = torch.save

    def fail_after_writing_something(payload, path, *args, **kwargs):
        real_save(payload, path, *args, **kwargs)
        raise RuntimeError("No space left on device")

    monkeypatch.setattr(torch, "save", fail_after_writing_something)
    with pytest.raises(RuntimeError):
        save_checkpoint(directory / "model.pt", model, None, 2, 0.5, TrainConfig())

    assert (directory / "model.pt").read_bytes() == good
    assert not (directory / "model.pt.partial").exists()


def test_a_failed_checkpoint_does_not_end_the_run(
    learnable_dataset, capsys, monkeypatch
) -> None:
    """Losing three weeks of training to a full disk would be absurd."""
    train_set, val_set, directory = learnable_dataset

    def no_room(*_args, **_kwargs):
        raise RuntimeError("No space left on device")

    monkeypatch.setattr(torch, "save", no_room)

    summary = train(
        CodeCraftLM(CONFIG), train_set, val_set,
        TrainConfig(steps=6, batch_size=4, block_size=16, eval_every=3, warmup_steps=1),
        output_dir=directory, log=True,
    )

    assert summary["steps_run"] == 6
    # Two evaluations, each trying model.pt and latest.pt.
    assert summary["checkpoint_writes_failed"] == 4
    assert "could not write" in capsys.readouterr().out


# ------------------------------------------- updating during the backward pass


def test_a_fused_step_trains(learnable_dataset) -> None:
    train_set, val_set, directory = learnable_dataset
    summary = train(
        CodeCraftLM(CONFIG), train_set, val_set,
        TrainConfig(
            steps=40, batch_size=8, block_size=32, eval_every=20, warmup_steps=5,
            learning_rate=3e-3, optimizer="adafactor", fused_step=True,
        ),
        output_dir=directory, log=False,
    )

    assert summary["history"][-1]["val_loss"] < summary["history"][0]["val_loss"]


def test_a_fused_step_leaves_no_gradients_behind(learnable_dataset) -> None:
    """The whole point: the model is never accompanied by a copy of itself."""
    train_set, val_set, directory = learnable_dataset
    model = CodeCraftLM(CONFIG)
    train(
        model, train_set, val_set,
        TrainConfig(steps=3, batch_size=4, block_size=16, eval_every=3, warmup_steps=1,
                    optimizer="adafactor", fused_step=True),
        output_dir=directory, log=False,
    )

    assert all(parameter.grad is None for parameter in model.parameters())


def test_the_ordinary_path_still_holds_its_gradients(learnable_dataset) -> None:
    """So the comparison above means something."""
    train_set, val_set, directory = learnable_dataset
    model = CodeCraftLM(CONFIG)
    train(
        model, train_set, val_set,
        TrainConfig(steps=3, batch_size=4, block_size=16, eval_every=3, warmup_steps=1,
                    optimizer="adafactor"),
        output_dir=directory, log=False,
    )

    assert any(parameter.grad is not None for parameter in model.parameters())


def weights_after(dataset, *, fused: bool, clip: float) -> list[torch.Tensor]:
    """Train the same model the same way twice, once per ordering."""
    train_set, val_set, directory = dataset
    torch.manual_seed(0)
    model = CodeCraftLM(CONFIG)
    train(
        model, train_set, val_set,
        TrainConfig(
            steps=3, batch_size=8, block_size=32, eval_every=3, warmup_steps=0,
            learning_rate=1e-3, optimizer="adafactor", fused_step=fused, grad_clip=clip,
        ),
        output_dir=directory, log=False,
    )
    return [parameter.detach().clone() for parameter in model.parameters()]


def test_a_fused_step_is_the_same_arithmetic_in_a_different_order(learnable_dataset) -> None:
    """Identical weights, not merely similar ones.

    Updating a parameter during the backward pass is safe because nothing reads
    it afterwards: the gradient flowing past a layer is produced from its old
    weights before the hook fires. With global clipping out of the way — the one
    thing the fused path genuinely cannot do — that claim is testable exactly,
    and this is the test.
    """
    fused = weights_after(learnable_dataset, fused=True, clip=1e9)
    ordinary = weights_after(learnable_dataset, fused=False, clip=1e9)

    for one, other in zip(fused, ordinary):
        assert torch.equal(one, other)


def test_what_differs_is_the_clipping_it_cannot_do(learnable_dataset) -> None:
    """A global norm needs every gradient at once, which is the thing avoided."""
    fused = weights_after(learnable_dataset, fused=True, clip=1.0)
    ordinary = weights_after(learnable_dataset, fused=False, clip=1.0)

    assert any(not torch.equal(one, other) for one, other in zip(fused, ordinary))


def test_a_fused_step_refuses_what_it_cannot_do(learnable_dataset) -> None:
    train_set, val_set, directory = learnable_dataset
    common = dict(steps=2, batch_size=4, block_size=16, eval_every=2, warmup_steps=1)

    # Accumulation needs a gradient to accumulate into, and there is none.
    with pytest.raises(ValueError, match="accumulate"):
        train(
            CodeCraftLM(CONFIG), train_set, val_set,
            TrainConfig(optimizer="adafactor", fused_step=True, grad_accumulation=2, **common),
            output_dir=directory, log=False,
        )

    # And AdamW's two extra copies are most of what does not fit.
    with pytest.raises(ValueError, match="adafactor"):
        train(
            CodeCraftLM(CONFIG), train_set, val_set,
            TrainConfig(fused_step=True, **common),
            output_dir=directory, log=False,
        )


def test_the_summary_counts_the_steps_that_ran(learnable_dataset) -> None:
    """A resumed run reported the planned total, making it look far faster."""
    train_set, val_set, directory = learnable_dataset
    options = dict(batch_size=4, block_size=16, eval_every=5, warmup_steps=1)

    train(
        CodeCraftLM(CONFIG), train_set, val_set, TrainConfig(steps=5, **options),
        output_dir=directory, log=False,
    )
    resumed = train(
        CodeCraftLM(CONFIG), train_set, val_set, TrainConfig(steps=8, **options),
        output_dir=directory, resume_from=directory / "latest.pt", log=False,
    )

    assert resumed["steps_run"] == 3
    assert resumed["tokens_seen"] == resumed["tokens_per_step"] * 3
    # And the throughput follows from what ran, not from what was planned.
    assert resumed["tokens_per_second"] == pytest.approx(
        resumed["tokens_seen"] / resumed["elapsed_seconds"], rel=1e-6
    )


def test_check_fused_step_refuses_accumulation() -> None:
    """Each gradient is spent the moment it exists, so there is none to add to."""
    config = TrainConfig(optimizer="adafactor", fused_step=True, grad_accumulation=4)
    with pytest.raises(ValueError, match="use a larger batch"):
        check_fused_step(config, scaler_enabled=False)


def test_check_fused_step_refuses_adamw() -> None:
    config = TrainConfig(optimizer="adamw", fused_step=True)
    with pytest.raises(ValueError, match="use --optimizer adafactor"):
        check_fused_step(config, scaler_enabled=False)


def test_check_fused_step_refuses_a_gradient_scaler() -> None:
    config = TrainConfig(optimizer="adafactor", fused_step=True)
    with pytest.raises(ValueError, match="bf16 or fp32"):
        check_fused_step(config, scaler_enabled=True)


def test_check_fused_step_allows_the_one_combination_that_works() -> None:
    config = TrainConfig(optimizer="adafactor", fused_step=True, grad_accumulation=1)
    check_fused_step(config, scaler_enabled=False)


def test_install_fused_step_frees_every_gradient_as_it_is_produced() -> None:
    """The whole point: the model is never accompanied by a copy of itself."""
    config = ModelConfig(
        vocab_size=64, d_model=32, n_layers=2, n_heads=4, n_kv_heads=2,
        d_ff=64, max_seq_len=16,
    )
    model = CodeCraftLM(config)
    training = TrainConfig(optimizer="adafactor", fused_step=True)
    optimizer = build_optimizer(model, training)
    hooks = install_fused_step(model, optimizer)
    assert hooks, "every trainable parameter should have been given a hook"

    before = [parameter.detach().clone() for parameter in model.parameters()]
    tokens = torch.randint(1, 64, (2, 8))
    _, loss, _ = model(tokens, targets=tokens)
    loss.backward()

    assert all(parameter.grad is None for parameter in model.parameters())
    assert any(
        not torch.equal(old, new)
        for old, new in zip(before, model.parameters())
    ), "the backward pass should have stepped the parameters on its way through"

    for handle in hooks:
        handle.remove()


def test_removing_the_hooks_puts_the_ordinary_behaviour_back() -> None:
    config = ModelConfig(
        vocab_size=64, d_model=32, n_layers=2, n_heads=4, n_kv_heads=2,
        d_ff=64, max_seq_len=16,
    )
    model = CodeCraftLM(config)
    optimizer = build_optimizer(model, TrainConfig(optimizer="adafactor", fused_step=True))
    for handle in install_fused_step(model, optimizer):
        handle.remove()

    tokens = torch.randint(1, 64, (2, 8))
    _, loss, _ = model(tokens, targets=tokens)
    loss.backward()
    assert any(parameter.grad is not None for parameter in model.parameters())


def test_a_resumed_run_reports_its_own_throughput(tmp_path, capsys) -> None:
    """Tokens this process moved, over time this process spent.

    A resumed run measures elapsed time from the resume, so counting tokens
    from step zero divides work it never did by time it did spend. Resuming
    from step 60 reported 565,850 tokens a second against a steady 9,400 for
    the same model on the same machine — and it is the number a reader uses to
    estimate what is left.

    The comparison is against the first run rather than within the second,
    because with the arithmetic wrong every line of the resumed run is inflated,
    not only the first.
    """
    import re

    def rates(output: str) -> list[float]:
        return [float(n.replace(",", "")) for n in re.findall(r"([\d,]+) tok/s", output)]

    tokens = np.tile(np.arange(1, 17, dtype=np.uint16), 400)
    write_dataset(tokens, tmp_path, validation_fraction=0.1)
    dataset = TokenDataset(tmp_path / "train.bin")
    held_out = TokenDataset(tmp_path / "val.bin")

    config = ModelConfig(
        vocab_size=64, d_model=32, n_layers=2, n_heads=4, n_kv_heads=2,
        d_ff=64, max_seq_len=32,
    )
    common = dict(batch_size=2, block_size=16, warmup_steps=1, eval_every=1000)

    capsys.readouterr()
    train(
        CodeCraftLM(config), dataset, held_out,
        TrainConfig(steps=60, log_every=10, **common),
        output_dir=tmp_path, log=True,
    )
    fresh = rates(capsys.readouterr().out)

    capsys.readouterr()
    train(
        CodeCraftLM(config), dataset, held_out,
        TrainConfig(steps=70, log_every=1, **common),
        output_dir=tmp_path, log=True, resume_from=tmp_path / "model.pt",
    )
    resumed = rates(capsys.readouterr().out)

    assert fresh and resumed, "a run reported no throughput at all"
    # Same model, same data, same machine: the second run cannot legitimately
    # be an order of magnitude faster than the first. Counting from step zero
    # made it sixty times faster, because it claimed sixty steps of work in one
    # step of time.
    assert max(resumed) < max(fresh) * 10, (
        f"the resumed run claims {max(resumed):,.0f} tok/s against {max(fresh):,.0f} "
        "for identical work: it is counting steps this process never ran"
    )
