"""Int8 weights: the arithmetic, the savings, and what is left alone."""

from __future__ import annotations

import pytest
import torch
import torch.nn as nn

from codecraft_model.config import ModelConfig
from codecraft_model.model import CodeCraftLM
from codecraft_model.quantize import (
    QuantizedLinear,
    dequantize_tensor,
    quantize_model,
    quantize_tensor,
)

CONFIG = ModelConfig(
    vocab_size=128, d_model=64, n_layers=2, n_heads=4, n_kv_heads=2, d_ff=128, max_seq_len=32
)


# ----------------------------------------------------------------- arithmetic


def test_the_largest_value_in_a_row_uses_the_full_range() -> None:
    """Anything less would waste precision the row has already paid for."""
    weight = torch.tensor([[1.0, -2.0, 0.5], [10.0, 1.0, 0.0]])
    quantized, _ = quantize_tensor(weight)

    assert int(quantized[0].abs().max()) == 127
    assert int(quantized[1].abs().max()) == 127


def test_each_row_gets_its_own_scale() -> None:
    """One outlier row would otherwise squash every other row's precision."""
    weight = torch.tensor([[0.001, -0.001], [1000.0, -1000.0]])
    _, scales = quantize_tensor(weight)

    assert scales.shape == (2, 1)
    assert scales[1] > scales[0] * 100


def test_a_round_trip_stays_close() -> None:
    torch.manual_seed(0)
    weight = torch.randn(32, 64)
    restored = dequantize_tensor(*quantize_tensor(weight))

    # One part in 127 of each row's largest magnitude, so relative to the row.
    assert torch.allclose(restored, weight, atol=weight.abs().max() / 100)


def test_the_error_is_not_biased_toward_zero() -> None:
    """Truncating instead of rounding would shrink the whole model."""
    torch.manual_seed(0)
    weight = torch.randn(64, 64)
    error = dequantize_tensor(*quantize_tensor(weight)) - weight

    assert abs(float(error.mean())) < float(error.abs().mean()) / 5


def test_an_all_zero_row_does_not_divide_by_zero() -> None:
    weight = torch.zeros(2, 4)
    quantized, scales = quantize_tensor(weight)

    assert torch.isfinite(scales).all()
    assert int(quantized.abs().sum()) == 0


def test_a_vector_is_refused() -> None:
    """Per-output-channel has no meaning without output channels."""
    with pytest.raises(ValueError, match="matrices"):
        quantize_tensor(torch.ones(8))


# --------------------------------------------------------------------- layers


def test_a_quantized_linear_matches_the_original_closely() -> None:
    torch.manual_seed(0)
    linear = nn.Linear(32, 16, bias=False)
    quantized = QuantizedLinear.from_linear(linear)
    x = torch.randn(4, 32)

    assert torch.allclose(quantized(x), linear(x), atol=0.05)


def test_a_bias_is_carried_across() -> None:
    torch.manual_seed(0)
    linear = nn.Linear(8, 4, bias=True)
    quantized = QuantizedLinear.from_linear(linear)

    assert quantized.bias_term is not None
    assert torch.allclose(quantized(torch.zeros(1, 8)), linear.bias, atol=1e-5)


def test_the_stored_weights_really_are_int8() -> None:
    quantized = QuantizedLinear.from_linear(nn.Linear(8, 4))
    assert quantized.quantized.dtype == torch.int8


# ---------------------------------------------------------------- whole model


def test_quantizing_a_model_shrinks_it() -> None:
    model = CodeCraftLM(CONFIG)
    report = quantize_model(model)

    assert report.quantized_tensors > 0
    assert report.quantized_bytes < report.original_bytes
    assert report.compression > 1.5


def test_the_output_head_is_left_alone_by_default() -> None:
    """It is tied to the embedding, and its errors go through a softmax."""
    model = CodeCraftLM(CONFIG)
    quantize_model(model)

    assert isinstance(model.output_head, nn.Linear)
    assert not isinstance(model.output_head, QuantizedLinear)


def test_the_attention_and_feed_forward_matrices_are_quantized() -> None:
    model = CodeCraftLM(CONFIG)
    quantize_model(model)

    assert isinstance(model.blocks[0].attention.q_proj, QuantizedLinear)
    assert isinstance(model.blocks[0].feed_forward.gate_proj, QuantizedLinear)


def test_norm_gains_stay_in_float() -> None:
    """There are very few of them and they scale everything downstream."""
    model = CodeCraftLM(CONFIG)
    quantize_model(model)

    assert model.final_norm.weight.dtype == torch.float32


def test_a_quantized_model_still_produces_sensible_logits() -> None:
    torch.manual_seed(0)
    model = CodeCraftLM(CONFIG).eval()
    tokens = torch.randint(0, CONFIG.vocab_size, (1, 8))

    with torch.no_grad():
        before = model(tokens)[0]
        quantize_model(model)
        after = model(tokens)[0]

    assert after.shape == before.shape
    assert torch.isfinite(after).all()
    # Close enough that the ranking of likely tokens is largely preserved.
    assert torch.corrcoef(torch.stack([before.flatten(), after.flatten()]))[0, 1] > 0.99


def test_a_quantized_model_can_still_generate() -> None:
    torch.manual_seed(0)
    model = CodeCraftLM(CONFIG).eval()
    quantize_model(model)

    produced = list(model.generate(torch.zeros(1, 4, dtype=torch.long), 5, temperature=0.0))
    assert len(produced) == 5


def test_the_report_measures_the_error_it_introduced() -> None:
    report = quantize_model(CodeCraftLM(CONFIG))

    assert report.max_error > 0
    assert report.mean_error < report.max_error
    assert report.skipped_tensors >= 1
