"""Choosing where to run, and the numeric precision that goes with it.

Picking a device is the easy half. The half that actually bites is that a
PyTorch wheel built for an older CUDA installs cleanly on a new card and then
fails on every kernel launch with "no kernel image is available for execution on
the device". Nothing about the install warns you. So this module checks the
card's compute capability against the architectures the wheel was actually built
for, and says which wheel to install when they do not match.

Precision follows the device. On any card new enough to matter, bfloat16
autocast is roughly twice the throughput of float32 with none of float16's
overflow problems, because it keeps float32's exponent range and only sheds
mantissa bits. Float32 accumulation still happens inside the matmul, so the
numerics that matter are unchanged.
"""

from __future__ import annotations

import torch

# Compute capability of each generation, for the message that tells a user why
# their card is not working with the wheel they installed.
ARCHITECTURE_NAMES: dict[tuple[int, int], str] = {
    (7, 5): "Turing",
    (8, 0): "Ampere",
    (8, 6): "Ampere",
    (8, 9): "Ada Lovelace",
    (9, 0): "Hopper",
    (10, 0): "Blackwell",
    (12, 0): "Blackwell",
}

# The build that first carried sm_120, which is what a 50-series card needs.
BLACKWELL_WHEEL = "pip install torch --index-url https://download.pytorch.org/whl/cu128"
CPU_WHEEL = "pip install torch --index-url https://download.pytorch.org/whl/cpu"


def resolve_device(requested: str | None = None) -> torch.device:
    """Return the device to use.

    `None` or "auto" takes the best available. An explicit request is honoured
    even when it is the slower choice, because "run this on the CPU to compare"
    is a real thing to want.
    """
    if requested and requested != "auto":
        device = torch.device(requested)
        if device.type == "cuda" and not torch.cuda.is_available():
            raise RuntimeError(
                "cuda was requested but this PyTorch build cannot see a GPU. "
                f"Install a CUDA build:\n  {BLACKWELL_WHEEL}"
            )
        return device

    if torch.cuda.is_available():
        return torch.device("cuda")
    # Apple silicon. Useful for generation; training support is still patchy,
    # so it is taken only when nothing better exists.
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def architecture_warning(device: torch.device) -> str | None:
    """Explain a card the installed wheel cannot actually run kernels on.

    Returns None when everything matches. Otherwise a message naming the card,
    what the wheel was built for, and the command that fixes it.
    """
    if device.type != "cuda" or not torch.cuda.is_available():
        return None

    index = device.index or 0
    major, minor = torch.cuda.get_device_capability(index)
    target = f"sm_{major}{minor}"
    built_for = torch.cuda.get_arch_list()

    if target in built_for:
        return None

    name = torch.cuda.get_device_name(index)
    generation = ARCHITECTURE_NAMES.get((major, minor), "")
    described = f"{name} ({generation} {target})" if generation else f"{name} ({target})"

    # A `compute_NN` entry means PTX is embedded and the driver can compile it
    # forward at load time. That works, but only from an older capability, and
    # the first launch pays for the compile.
    forward_compatible = [
        entry for entry in built_for if entry.startswith("compute_")
    ]
    if forward_compatible:
        return (
            f"{described} is not in this PyTorch build's architecture list "
            f"({', '.join(built_for)}).\n"
            "The driver may compile the embedded PTX forward, which works but is "
            "slow to start and slower to run.\n"
            f"For real speed install a build that targets {target}:\n  {BLACKWELL_WHEEL}"
        )

    return (
        f"{described} is not supported by this PyTorch build, which targets "
        f"{', '.join(built_for)}.\n"
        "Every kernel launch will fail with 'no kernel image is available for "
        "execution on the device'.\n"
        f"Install a build that targets {target}:\n  {BLACKWELL_WHEEL}"
    )


def autocast_dtype(device: torch.device, precision: str = "auto") -> torch.dtype | None:
    """The dtype to run autocast in, or None to stay in float32.

    bfloat16 is preferred wherever it is supported: same exponent range as
    float32, so no loss scaling and no overflow, at roughly float16's speed.
    float16 is the fallback for older cards, and it needs a gradient scaler.
    """
    if precision == "fp32":
        return None
    if precision == "bf16":
        return torch.bfloat16
    if precision == "fp16":
        return torch.float16

    if device.type == "cuda":
        return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    # CPU bfloat16 autocast is slower than float32 unless the chip has AMX, and
    # detecting that reliably is not worth it. MPS autocast is not dependable.
    return None


def enable_fast_matmul(device: torch.device) -> None:
    """Let float32 matmuls use tensor cores.

    The remaining float32 operations run through TF32, which keeps float32's
    range and 10 mantissa bits. For training this is free accuracy-wise and
    several times faster on any card with tensor cores.
    """
    if device.type != "cuda":
        return
    torch.set_float32_matmul_precision("high")
    if hasattr(torch.backends.cuda, "matmul"):
        torch.backends.cuda.matmul.allow_tf32 = True
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.allow_tf32 = True
        # Input shapes are fixed across a run, so let cuDNN benchmark once and
        # keep the fastest algorithm.
        torch.backends.cudnn.benchmark = True


def describe_device(device: torch.device) -> str:
    """One line naming the device and what it can do."""
    if device.type == "cuda" and torch.cuda.is_available():
        index = device.index or 0
        name = torch.cuda.get_device_name(index)
        major, minor = torch.cuda.get_device_capability(index)
        total = torch.cuda.get_device_properties(index).total_memory / 1e9
        bf16 = "bf16" if torch.cuda.is_bf16_supported() else "fp16"
        return f"{name}, sm_{major}{minor}, {total:.1f}GB VRAM, {bf16}"
    if device.type == "mps":
        return "Apple GPU via Metal"
    return f"CPU, {torch.get_num_threads()} threads"


def memory_total_bytes(device: torch.device) -> int | None:
    """Device memory, when the device has a number to report."""
    if device.type == "cuda" and torch.cuda.is_available():
        return torch.cuda.get_device_properties(device.index or 0).total_memory
    return None


def peak_memory_bytes(device: torch.device) -> int | None:
    """High-water mark since the counter was last reset."""
    if device.type == "cuda" and torch.cuda.is_available():
        return torch.cuda.max_memory_allocated(device)
    return None


def reset_peak_memory(device: torch.device) -> None:
    if device.type == "cuda" and torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats(device)


def synchronize(device: torch.device) -> None:
    """Wait for queued work.

    CUDA calls are asynchronous, so a timing measurement taken without this
    reports how fast work was queued, not how fast it ran.
    """
    if device.type == "cuda" and torch.cuda.is_available():
        torch.cuda.synchronize(device)
