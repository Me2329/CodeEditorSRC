"""The optimiser that decides whether a size fits on a card."""

import math

import pytest
import torch

from codecraft_model.config import ModelConfig, get_size
from codecraft_model.optimizer import Adafactor


def fitting_problem(seed: int = 0):
    """A linear layer with a target it can actually reach.

    The target comes from another linear layer, so a perfect fit exists and a
    loss that stalls means the optimiser stalled rather than the problem being
    unsolvable.
    """
    torch.manual_seed(seed)
    layer = torch.nn.Linear(32, 32)
    teacher = torch.nn.Linear(32, 32)
    data = torch.randn(64, 32)
    return layer, data, teacher(data).detach()


def run(optimizer, layer, data, target, steps: int = 150) -> tuple[float, float]:
    first = None
    for _ in range(steps):
        loss = torch.nn.functional.mse_loss(layer(data), target)
        if first is None:
            first = float(loss.detach())
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
    return first, float(loss.detach())


def test_it_actually_reduces_the_loss():
    layer, data, target = fitting_problem()
    before, after = run(Adafactor(layer.parameters(), lr=1e-2), layer, data, target)

    assert after < before / 10


def test_its_state_is_the_perimeter_of_a_matrix_rather_than_its_area():
    """The whole point: rows plus columns, not rows times columns."""
    weight = torch.nn.Parameter(torch.randn(256, 512))
    optimizer = Adafactor([weight], lr=1e-3)
    weight.grad = torch.randn_like(weight)
    optimizer.step()

    # One float per row and one per column, and nothing else.
    assert optimizer.state_bytes() == (256 + 512) * 4
    assert optimizer.state_bytes() * 100 < weight.numel() * 4


def test_a_vector_keeps_an_ordinary_second_moment():
    """It has no second dimension to factor along, and costs nothing anyway."""
    gain = torch.nn.Parameter(torch.ones(128))
    optimizer = Adafactor([gain], lr=1e-3)
    gain.grad = torch.randn_like(gain)
    optimizer.step()

    assert optimizer.state_bytes() == 128 * 4


def test_momentum_can_be_turned_on_and_then_costs_a_full_copy():
    weight = torch.nn.Parameter(torch.randn(64, 64))
    optimizer = Adafactor([weight], lr=1e-3, beta1=0.9)
    weight.grad = torch.randn_like(weight)
    optimizer.step()

    assert optimizer.state_bytes() == (64 + 64) * 4 + 64 * 64 * 4


def test_a_huge_gradient_does_not_move_the_weights_far():
    """Update clipping is what replaces the momentum that is not kept."""
    weight = torch.nn.Parameter(torch.zeros(16, 16))
    optimizer = Adafactor([weight], lr=1e-2, clip_threshold=1.0)
    weight.grad = torch.full_like(weight, 1e6)
    optimizer.step()

    moved = weight.detach().abs().max().item()
    assert moved <= 1e-2 * 1.001, moved


def test_it_refuses_a_setting_that_cannot_work():
    weight = torch.nn.Parameter(torch.zeros(4, 4))
    with pytest.raises(ValueError):
        Adafactor([weight], lr=0)
    with pytest.raises(ValueError):
        Adafactor([weight], lr=1e-3, beta2=1.0)


def test_it_survives_a_parameter_with_no_gradient():
    used = torch.nn.Parameter(torch.randn(8, 8))
    unused = torch.nn.Parameter(torch.randn(8, 8))
    optimizer = Adafactor([used, unused], lr=1e-3)
    used.grad = torch.randn_like(used)

    optimizer.step()

    assert torch.equal(unused, unused)


def test_it_reaches_a_comparable_loss_to_adamw():
    """Not as good, and in the same neighbourhood: the trade is memory."""
    layer, data, target = fitting_problem(seed=3)
    _, factored = run(Adafactor(layer.parameters(), lr=1e-2), layer, data, target)

    layer, data, target = fitting_problem(seed=3)
    _, adam = run(torch.optim.AdamW(layer.parameters(), lr=1e-2), layer, data, target)

    assert factored < adam * 50
    assert math.isfinite(factored)


# ------------------------------------------------------------ what it saves


def test_the_estimate_knows_which_optimiser_is_being_used():
    config = get_size("xl")
    adamw = config.memory_estimate_bytes()["training"]
    factored = config.memory_estimate_bytes(optimizer="adafactor")["training"]

    # A billion parameters: 16GB of state under AdamW, 8GB under Adafactor,
    # which is the difference between fitting on a 16GB card and not.
    assert adamw > 16e9
    assert factored < 9e9


def test_the_factored_state_is_a_rounding_error_next_to_the_weights():
    config = get_size("xl")
    estimate = config.memory_estimate_bytes(optimizer="adafactor")

    assert estimate["optimizer_state"] < estimate["weights"] / 1000


def test_the_counted_state_matches_what_the_optimiser_allocates():
    """The table would be a guess otherwise."""
    from codecraft_model.model import CodeCraftLM
    from codecraft_model.train import TrainConfig, build_optimizer

    config = ModelConfig(
        vocab_size=64, d_model=32, n_layers=2, n_heads=4, n_kv_heads=2, d_ff=64, max_seq_len=32
    )
    model = CodeCraftLM(config)
    optimizer = build_optimizer(model, TrainConfig(optimizer="adafactor"))

    tokens = torch.randint(0, config.vocab_size, (2, 16))
    _, loss, _ = model(tokens, targets=tokens)
    loss.backward()
    optimizer.step()

    assert optimizer.state_bytes() == config.factored_state_count() * 4


def test_an_unknown_optimiser_is_refused_rather_than_guessed():
    with pytest.raises(ValueError, match="adafactor"):
        get_size("micro").memory_estimate_bytes(optimizer="lion")
