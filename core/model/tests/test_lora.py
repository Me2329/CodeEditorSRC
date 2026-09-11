"""Low-rank adapters: small, additive, and foldable back into the model."""

from __future__ import annotations

import pytest
import torch
import torch.nn as nn

from codecraft_model.lora import (
    LoRAConfig,
    LoRALinear,
    adapter_parameters,
    adapter_state,
    apply_lora,
    describe,
    load_adapter,
    merge_lora,
    save_adapter,
)
from codecraft_model.model import CodeCraftLM, ModelConfig

CONFIG = ModelConfig(
    vocab_size=128, d_model=64, n_layers=2, n_heads=4, n_kv_heads=2, d_ff=128, max_seq_len=32
)


@pytest.fixture
def model() -> CodeCraftLM:
    torch.manual_seed(0)
    return CodeCraftLM(CONFIG).eval()


@pytest.fixture
def tokens() -> torch.Tensor:
    torch.manual_seed(1)
    return torch.randint(1, CONFIG.vocab_size, (1, 8))


def logits_of(model: CodeCraftLM, tokens: torch.Tensor) -> torch.Tensor:
    return model(tokens, project_all=True)[0]


# ------------------------------------------------------------------- the shape


def test_an_adapter_starts_as_the_model_it_adapts(model, tokens) -> None:
    """B is zero, so the correction is zero and training starts where you were.

    Without this, attaching an adapter would move the model before a single
    gradient step, and the first thing fine-tuning would have to do is undo it.
    """
    before = logits_of(model, tokens)
    apply_lora(model, LoRAConfig(rank=4))

    assert torch.allclose(before, logits_of(model, tokens))


def test_only_the_adapter_is_trainable(model) -> None:
    apply_lora(model, LoRAConfig(rank=4))

    trainable = adapter_parameters(model)
    assert trainable
    assert all("lora" in name for name, parameter in model.named_parameters() if parameter.requires_grad)


def test_the_adapter_is_a_fraction_of_the_model(model) -> None:
    apply_lora(model, LoRAConfig(rank=4))
    measured = describe(model)

    assert measured["fraction"] < 0.05
    assert measured["adapters"] == CONFIG.n_layers * 2


def test_a_higher_rank_trains_more(model) -> None:
    small = CodeCraftLM(CONFIG)
    apply_lora(small, LoRAConfig(rank=2))
    apply_lora(model, LoRAConfig(rank=16))

    assert describe(model)["trainable"] > describe(small)["trainable"]


def test_scaling_does_not_follow_the_rank(model) -> None:
    """alpha over rank, so raising the rank does not also raise the correction."""
    apply_lora(model, LoRAConfig(rank=8, alpha=16))
    layer = next(module for module in model.modules() if isinstance(module, LoRALinear))

    assert layer.scaling == pytest.approx(2.0)


def test_targets_that_match_nothing_are_refused(model) -> None:
    """Silently training nothing looks exactly like training that did not work."""
    with pytest.raises(ValueError, match="would train nothing"):
        apply_lora(model, LoRAConfig(rank=4, targets=("not_a_layer",)))


def test_a_rank_of_zero_is_refused() -> None:
    with pytest.raises(ValueError, match="rank must be at least 1"):
        LoRAConfig(rank=0)


def test_no_targets_is_refused() -> None:
    with pytest.raises(ValueError, match="no targets"):
        LoRAConfig(targets=())


# ---------------------------------------------------------------- the training


def test_a_step_moves_the_adapter_and_not_the_model(model, tokens) -> None:
    """The base weights are frozen, and frozen has to mean unchanged.

    An adapter over an unfrozen model is full fine-tuning with extra steps, and
    the symptom is a run that looks fine and a checkpoint that is wrong.
    """
    apply_lora(model, LoRAConfig(rank=4))
    model.train()

    base = next(
        module.base.weight.clone()
        for module in model.modules()
        if isinstance(module, LoRALinear)
    )
    adapter_before = adapter_state(model)

    optimizer = torch.optim.AdamW(adapter_parameters(model), lr=0.1)
    logits, loss, _ = model(tokens, targets=tokens)
    loss.backward()
    optimizer.step()

    base_after = next(
        module.base.weight for module in model.modules() if isinstance(module, LoRALinear)
    )
    adapter_after = adapter_state(model)

    assert torch.equal(base, base_after)
    assert not torch.equal(adapter_before["blocks.0.attention.q_proj.lora_b"],
                           adapter_after["blocks.0.attention.q_proj.lora_b"])


def test_a_trained_adapter_changes_the_answer(model, tokens) -> None:
    """The point of the exercise: after training, the model is different."""
    apply_lora(model, LoRAConfig(rank=4))
    before = logits_of(model, tokens)

    optimizer = torch.optim.AdamW(adapter_parameters(model), lr=0.1)
    for _ in range(3):
        _, loss, _ = model(tokens, targets=tokens)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

    assert not torch.allclose(before, logits_of(model, tokens))


def test_gradients_reach_the_adapter_and_stop_there(model, tokens) -> None:
    apply_lora(model, LoRAConfig(rank=4))
    _, loss, _ = model(tokens, targets=tokens)
    loss.backward()

    layer = next(module for module in model.modules() if isinstance(module, LoRALinear))
    assert layer.lora_b.grad is not None
    assert layer.base.weight.grad is None


# ----------------------------------------------------------------- the merging


def test_merging_gives_the_same_numbers(model, tokens) -> None:
    """A merged model is servable by code that knows nothing about adapters,
    which is only true if merging is exact."""
    apply_lora(model, LoRAConfig(rank=4))

    optimizer = torch.optim.AdamW(adapter_parameters(model), lr=0.1)
    for _ in range(3):
        _, loss, _ = model(tokens, targets=tokens)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

    model.eval()
    unmerged = logits_of(model, tokens)
    merged_count = merge_lora(model)

    assert merged_count == CONFIG.n_layers * 2
    assert torch.allclose(unmerged, logits_of(model, tokens), atol=1e-6)


def test_merging_leaves_an_ordinary_model(model, tokens) -> None:
    apply_lora(model, LoRAConfig(rank=4))
    merge_lora(model)

    assert not any(isinstance(module, LoRALinear) for module in model.modules())
    # The state dict is the shape the original checkpoint had.
    assert "blocks.0.attention.q_proj.weight" in model.state_dict()
    assert not any("lora" in name for name in model.state_dict())
    # And the merged weight is trainable again, so the model can be fine-tuned
    # the ordinary way afterwards rather than being frozen for good.
    assert model.blocks[0].attention.q_proj.weight.requires_grad


def test_merging_a_model_with_no_adapter_does_nothing(model) -> None:
    assert merge_lora(model) == 0


def test_merging_unfreezes_what_applying_froze(model) -> None:
    """A merged but frozen model is not an ordinary model.

    It reports a parameter count of whatever the adapter touched, and a later
    full fine-tune would silently train four projections and nothing else.
    """
    whole = model.parameter_count()
    apply_lora(model, LoRAConfig(rank=4))
    merge_lora(model)

    assert model.parameter_count() == whole
    assert all(parameter.requires_grad for parameter in model.parameters())


# ------------------------------------------------------------------ the file


def test_an_adapter_file_holds_only_the_adapter(tmp_path, model) -> None:
    apply_lora(model, LoRAConfig(rank=4))
    path = tmp_path / "adapter.pt"

    size = save_adapter(path, model, LoRAConfig(rank=4))
    payload = torch.load(path, map_location="cpu", weights_only=False)

    assert all("lora" in name for name in payload["adapter"])
    assert size < 100_000


def test_an_adapter_round_trips(tmp_path, tokens) -> None:
    """Saved from one model, loaded into another, same answers."""
    torch.manual_seed(0)
    trained = CodeCraftLM(CONFIG)
    config = LoRAConfig(rank=4)
    apply_lora(trained, config)

    optimizer = torch.optim.AdamW(adapter_parameters(trained), lr=0.1)
    for _ in range(3):
        _, loss, _ = trained(tokens, targets=tokens)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
    trained.eval()

    path = tmp_path / "adapter.pt"
    save_adapter(path, trained, config, metadata={"examples": 12})

    torch.manual_seed(0)
    fresh = CodeCraftLM(CONFIG).eval()
    restored = load_adapter(path, fresh)

    assert restored.rank == 4
    assert torch.allclose(logits_of(trained, tokens), logits_of(fresh, tokens), atol=1e-6)


def test_an_adapter_for_a_different_shape_is_refused(tmp_path, model) -> None:
    """Loading it anyway would give wrong answers rather than an error."""
    config = LoRAConfig(rank=4)
    apply_lora(model, config)
    path = tmp_path / "adapter.pt"
    save_adapter(path, model, config)

    wider = CodeCraftLM(ModelConfig(**{**CONFIG.to_dict(), "d_model": 128}))

    with pytest.raises(RuntimeError):
        load_adapter(path, wider)


def test_metadata_travels_with_the_adapter(tmp_path, model) -> None:
    config = LoRAConfig(rank=4)
    apply_lora(model, config)
    path = tmp_path / "adapter.pt"
    save_adapter(path, model, config, metadata={"examples": 12, "loss": 0.4})

    payload = torch.load(path, map_location="cpu", weights_only=False)
    assert payload["metadata"]["examples"] == 12


def test_a_plain_linear_is_left_alone(model) -> None:
    """Only the targets are wrapped; the feed-forward stays as it was."""
    apply_lora(model, LoRAConfig(rank=4))

    gate = model.blocks[0].feed_forward.gate_proj
    assert isinstance(gate, nn.Linear)
    assert not isinstance(gate, LoRALinear)
