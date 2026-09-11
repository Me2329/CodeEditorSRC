"""A checkpoint format that does not execute anything to load.

`torch.save` uses pickle, and unpickling runs code. That is fine for a file you
produced yourself and wrong for one you downloaded, which is exactly what a
model checkpoint usually is. `torch.load(weights_only=True)` narrows the problem
but does not remove the format's shape: it is still a pickle, and the guarantee
is a denylist maintained by someone else.

This format has no code path that can execute anything, because there is nothing
in it to execute. A header of JSON, then raw tensor bytes. Loading is a read and
a reshape.

    magic     8 bytes   "CCLM0001"
    length    8 bytes   little-endian uint64, the header's size
    header    JSON      configuration, plus name/dtype/shape/offset per tensor
    payload   bytes     each tensor's data, in header order, 64-byte aligned

The alignment is so a reader can memory-map the file and hand slices straight to
a tensor without copying. It costs at most 63 bytes per tensor.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import torch

from .config import ModelConfig
from .model import CodeCraftLM

MAGIC = b"CCLM0001"
ALIGNMENT = 64

# Only the dtypes a checkpoint actually holds. Anything else is a mistake worth
# hearing about rather than silently widening.
DTYPES: dict[str, np.dtype] = {
    "float32": np.dtype("<f4"),
    "float16": np.dtype("<f2"),
    "bfloat16": np.dtype("<u2"),  # no numpy bfloat16; the bit pattern is kept
    "int8": np.dtype("<i1"),
    "int64": np.dtype("<i8"),
}

TORCH_DTYPES = {
    "float32": torch.float32,
    "float16": torch.float16,
    "bfloat16": torch.bfloat16,
    "int8": torch.int8,
    "int64": torch.int64,
}


def _pad(offset: int) -> int:
    return (ALIGNMENT - offset % ALIGNMENT) % ALIGNMENT


def export_model(
    model: CodeCraftLM, path: Path | str, *, metadata: dict | None = None
) -> dict:
    """Write `model` as a header and a payload. Returns what went in.

    Tensors are written on the CPU and contiguous, because a view into a larger
    storage would otherwise serialise the whole storage.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    state = model.state_dict()
    entries: list[dict] = []
    offset = 0

    for name, tensor in state.items():
        dtype = str(tensor.dtype).removeprefix("torch.")
        if dtype not in DTYPES:
            raise ValueError(f"{name} has dtype {dtype}, which this format does not carry")

        padding = _pad(offset)
        offset += padding
        entries.append(
            {
                "name": name,
                "dtype": dtype,
                "shape": list(tensor.shape),
                "offset": offset,
                "bytes": tensor.numel() * DTYPES[dtype].itemsize,
                "padding": padding,
            }
        )
        offset += entries[-1]["bytes"]

    header = {
        "format": "codecraft-lm",
        "version": 1,
        "model_config": model.config.to_dict(),
        "tensors": entries,
        "metadata": metadata or {},
    }
    encoded = json.dumps(header).encode("utf-8")

    with path.open("wb") as handle:
        handle.write(MAGIC)
        handle.write(struct.pack("<Q", len(encoded)))
        handle.write(encoded)

        for entry, (_, tensor) in zip(entries, state.items()):
            handle.write(b"\0" * entry["padding"])
            values = tensor.detach().cpu().contiguous()
            # bfloat16 has no numpy equivalent, so the bit pattern is written
            # through an unsigned view and read back the same way.
            if entry["dtype"] == "bfloat16":
                handle.write(values.view(torch.uint16).numpy().tobytes())
            else:
                handle.write(values.numpy().tobytes())

    return header


def read_header(path: Path | str) -> dict:
    """Read the header alone, without touching the weights.

    Useful for asking what a file is before deciding to load gigabytes of it.
    """
    path = Path(path)
    with path.open("rb") as handle:
        magic = handle.read(len(MAGIC))
        if magic != MAGIC:
            raise ValueError(
                f"{path} is not a CodeCraft checkpoint (magic {magic!r})"
            )

        (length,) = struct.unpack("<Q", handle.read(8))
        # A corrupt length would otherwise be handed straight to read().
        if length > 64 * 1024 * 1024:
            raise ValueError(f"{path} declares an implausible header of {length} bytes")

        return json.loads(handle.read(length).decode("utf-8"))


def import_model(
    path: Path | str, device: torch.device | str = "cpu"
) -> tuple[CodeCraftLM, dict]:
    """Rebuild a model from an exported file.

    Nothing here evaluates anything from the file: the header is JSON, and the
    payload is read as bytes and reshaped.
    """
    # Accepting a string as well as a Path: a loader that rejects the obvious
    # spelling is a nuisance for no benefit.
    path = Path(path)
    header = read_header(path)
    config = ModelConfig.from_dict(header["model_config"])
    model = CodeCraftLM(config)

    raw = np.memmap(path, dtype=np.uint8, mode="r")
    state: dict[str, torch.Tensor] = {}

    for entry in header["tensors"]:
        start = _payload_start(path) + entry["offset"]
        block = raw[start : start + entry["bytes"]]
        if len(block) != entry["bytes"]:
            raise ValueError(
                f"{path} is truncated: {entry['name']} needs {entry['bytes']} bytes"
            )

        values = np.frombuffer(block.tobytes(), dtype=DTYPES[entry["dtype"]])
        tensor = torch.from_numpy(values.copy()).reshape(entry["shape"])
        if entry["dtype"] == "bfloat16":
            tensor = tensor.view(torch.bfloat16)
        state[entry["name"]] = tensor

    del raw
    model.load_state_dict(state)
    model.to(device)
    model.eval()
    return model, header


def _payload_start(path: Path | str) -> int:
    with Path(path).open("rb") as handle:
        handle.seek(len(MAGIC))
        (length,) = struct.unpack("<Q", handle.read(8))
    return len(MAGIC) + 8 + length
