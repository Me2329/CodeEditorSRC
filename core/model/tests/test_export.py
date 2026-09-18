"""A checkpoint format with nothing in it to execute."""

from __future__ import annotations

import json
import struct

import pytest
import torch

from codecraft_model.config import ModelConfig
from codecraft_model.export import (
    ALIGNMENT,
    MAGIC,
    export_model,
    import_model,
    read_header,
)
from codecraft_model.model import CodeCraftLM

CONFIG = ModelConfig(
    vocab_size=64, d_model=64, n_layers=2, n_heads=4, n_kv_heads=2, d_ff=128, max_seq_len=32
)


@pytest.fixture
def exported(tmp_path):
    torch.manual_seed(0)
    model = CodeCraftLM(CONFIG).eval()
    path = tmp_path / "model.cclm"
    export_model(model, path, metadata={"note": "test"})
    return model, path


# ------------------------------------------------------------------ round trip


def test_a_model_survives_the_round_trip(exported) -> None:
    original, path = exported
    restored, _ = import_model(path)

    tokens = torch.randint(0, CONFIG.vocab_size, (1, 8))
    with torch.no_grad():
        assert torch.allclose(original(tokens)[0], restored(tokens)[0])


def test_every_weight_is_bit_identical(exported) -> None:
    """Not close: the same. A lossy export would be a silent quality change."""
    original, path = exported
    restored, _ = import_model(path)

    for name, tensor in original.state_dict().items():
        assert torch.equal(tensor, restored.state_dict()[name]), name


def test_the_configuration_comes_back(exported) -> None:
    _, path = exported
    restored, _ = import_model(path)
    assert restored.config == CONFIG


def test_metadata_is_carried(exported) -> None:
    _, path = exported
    assert read_header(path)["metadata"] == {"note": "test"}


# ---------------------------------------------------------------- the format


def test_the_file_starts_with_the_magic(exported) -> None:
    _, path = exported
    assert path.read_bytes()[: len(MAGIC)] == MAGIC


def test_the_header_is_plain_json(exported) -> None:
    """Readable without this library, and with nothing in it to evaluate."""
    _, path = exported
    raw = path.read_bytes()

    (length,) = struct.unpack("<Q", raw[len(MAGIC) : len(MAGIC) + 8])
    header = json.loads(raw[len(MAGIC) + 8 : len(MAGIC) + 8 + length])

    assert header["format"] == "codecraft-lm"
    assert header["tensors"]


def test_every_tensor_is_aligned(exported) -> None:
    """So a reader can memory-map and slice without copying."""
    _, path = exported
    for entry in read_header(path)["tensors"]:
        assert entry["offset"] % ALIGNMENT == 0


def test_the_declared_sizes_match_the_shapes(exported) -> None:
    _, path = exported
    for entry in read_header(path)["tensors"]:
        elements = 1
        for dimension in entry["shape"]:
            elements *= dimension
        assert entry["bytes"] % max(elements, 1) == 0


def test_reading_the_header_does_not_read_the_weights(exported, tmp_path) -> None:
    """Asking what a file is should not cost gigabytes."""
    _, path = exported
    truncated = tmp_path / "header-only.cclm"

    header_length = struct.unpack("<Q", path.read_bytes()[len(MAGIC) : len(MAGIC) + 8])[0]
    truncated.write_bytes(path.read_bytes()[: len(MAGIC) + 8 + header_length])

    assert read_header(truncated)["format"] == "codecraft-lm"


# ----------------------------------------------------------------- rejections


def test_a_file_that_is_not_a_checkpoint_is_refused(tmp_path) -> None:
    path = tmp_path / "not-a-model.bin"
    path.write_bytes(b"PK\x03\x04" + b"\0" * 100)

    with pytest.raises(ValueError, match="not a CodeCraft checkpoint"):
        read_header(path)


def test_an_implausible_header_length_is_refused(tmp_path) -> None:
    """A corrupt length would otherwise be handed straight to read()."""
    path = tmp_path / "corrupt.cclm"
    path.write_bytes(MAGIC + struct.pack("<Q", 2**40))

    with pytest.raises(ValueError, match="implausible"):
        read_header(path)


def test_a_truncated_payload_is_reported(exported, tmp_path) -> None:
    _, path = exported
    truncated = tmp_path / "cut.cclm"
    truncated.write_bytes(path.read_bytes()[:-64])

    with pytest.raises(ValueError, match="truncated"):
        import_model(truncated)


# ------------------------------------------------------------------- dtypes


def test_bfloat16_survives_despite_numpy_not_having_it(tmp_path) -> None:
    """The bit pattern goes through an unsigned view and comes back."""
    torch.manual_seed(0)
    model = CodeCraftLM(CONFIG).to(torch.bfloat16)
    path = tmp_path / "half.cclm"
    export_model(model, path)

    restored, _ = import_model(path)

    for name, tensor in model.state_dict().items():
        assert torch.equal(tensor, restored.state_dict()[name]), name


def test_an_unsupported_dtype_is_refused(tmp_path) -> None:
    """Rather than silently widening the format to carry anything."""
    model = CodeCraftLM(CONFIG)
    state = model.state_dict()
    first = next(iter(state))

    class Odd(CodeCraftLM):
        def state_dict(self, *args, **kwargs):  # noqa: D102
            return {**state, first: state[first].to(torch.complex64)}

    odd = Odd(CONFIG)
    with pytest.raises(ValueError, match="does not carry"):
        export_model(odd, tmp_path / "odd.cclm")
