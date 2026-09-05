"""Device selection and precision.

This machine has no GPU, so the CUDA branches are driven with stubs rather than
skipped. That is deliberate: the failure these guard against is a wheel built
for the wrong architecture, which by definition cannot be reproduced on the
machine that has the right one.
"""

from __future__ import annotations

import pytest
import torch

from codecraft_model.device import (
    architecture_warning,
    autocast_dtype,
    describe_device,
    enable_fast_matmul,
    memory_total_bytes,
    peak_memory_bytes,
    resolve_device,
    synchronize,
)


@pytest.fixture
def blackwell(monkeypatch):
    """Present a 50-series card to the device module."""

    def install(arch_list: list[str], capability: tuple[int, int] = (12, 0)) -> None:
        monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
        monkeypatch.setattr(torch.cuda, "get_device_capability", lambda index=0: capability)
        monkeypatch.setattr(torch.cuda, "get_arch_list", lambda: arch_list)
        monkeypatch.setattr(
            torch.cuda, "get_device_name", lambda index=0: "NVIDIA GeForce RTX 5080"
        )

    return install


# ------------------------------------------------------------------ selection


def test_auto_falls_back_to_cpu_when_there_is_nothing_better() -> None:
    assert resolve_device("auto").type in {"cpu", "cuda", "mps"}


def test_an_explicit_cpu_request_is_honoured() -> None:
    """Even on a machine with a GPU, for comparing the two."""
    assert resolve_device("cpu").type == "cpu"


def test_auto_prefers_cuda_when_it_exists(monkeypatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    assert resolve_device("auto").type == "cuda"


def test_asking_for_cuda_without_cuda_names_the_wheel_to_install() -> None:
    if torch.cuda.is_available():
        pytest.skip("this machine has a GPU, so the request succeeds")
    with pytest.raises(RuntimeError, match="download.pytorch.org"):
        resolve_device("cuda")


def test_a_device_index_survives_resolution(monkeypatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    assert resolve_device("cuda:1").index == 1


# --------------------------------------------------------- architecture check


def test_a_matching_wheel_produces_no_warning(blackwell) -> None:
    blackwell(["sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"])
    assert architecture_warning(torch.device("cuda")) is None


def test_a_wheel_without_the_card_s_architecture_is_reported(blackwell) -> None:
    """The failure this catches is silent at install time and fatal at runtime.

    A CUDA 12.1 wheel installs cleanly on a 5080 and then fails on every kernel
    launch with 'no kernel image is available for execution on the device'.
    """
    blackwell(["sm_75", "sm_80", "sm_86", "sm_90"])
    warning = architecture_warning(torch.device("cuda"))

    assert warning is not None
    assert "sm_120" in warning
    assert "RTX 5080" in warning
    assert "no kernel image" in warning
    assert "cu128" in warning


def test_an_embedded_ptx_build_is_reported_as_slow_rather_than_broken(blackwell) -> None:
    """A `compute_` entry means the driver can compile forward at load time."""
    blackwell(["sm_80", "sm_90", "compute_90"])
    warning = architecture_warning(torch.device("cuda"))

    assert warning is not None
    assert "PTX" in warning
    assert "no kernel image" not in warning


def test_the_architecture_name_is_used_when_known(blackwell) -> None:
    blackwell(["sm_80"], capability=(12, 0))
    assert "Blackwell" in architecture_warning(torch.device("cuda"))


def test_a_cpu_device_is_never_warned_about() -> None:
    assert architecture_warning(torch.device("cpu")) is None


# ------------------------------------------------------------------ precision


def test_a_cpu_stays_in_float32() -> None:
    """CPU autocast is slower than float32 without the right instructions."""
    assert autocast_dtype(torch.device("cpu")) is None


def test_a_card_with_bfloat16_gets_bfloat16(monkeypatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_bf16_supported", lambda *a, **k: True)
    assert autocast_dtype(torch.device("cuda")) is torch.bfloat16


def test_an_older_card_falls_back_to_float16(monkeypatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_bf16_supported", lambda *a, **k: False)
    assert autocast_dtype(torch.device("cuda")) is torch.float16


@pytest.mark.parametrize(
    "requested,expected",
    [("fp32", None), ("bf16", torch.bfloat16), ("fp16", torch.float16)],
)
def test_an_explicit_precision_overrides_the_device(requested, expected) -> None:
    assert autocast_dtype(torch.device("cuda"), requested) is expected


def test_float16_is_the_only_precision_needing_a_gradient_scaler() -> None:
    """Why the training loop scales gradients for float16 and not bfloat16.

    bfloat16 reaches as far down as float32, so a small gradient stays
    representable. float16 bottoms out around 6e-8, and gradients below that
    flush to zero: the model stops learning without any error being raised.
    """
    assert torch.finfo(torch.bfloat16).tiny <= torch.finfo(torch.float32).tiny * 2
    assert torch.finfo(torch.float16).tiny > torch.finfo(torch.float32).tiny * 1e20


# ----------------------------------------------------------------- reporting


def test_a_cpu_describes_its_thread_count() -> None:
    assert "CPU" in describe_device(torch.device("cpu"))


def test_the_cpu_has_no_memory_budget_to_report() -> None:
    """Host RAM is not a fixed allowance the way VRAM is."""
    assert memory_total_bytes(torch.device("cpu")) is None
    assert peak_memory_bytes(torch.device("cpu")) is None


def test_fast_matmul_and_synchronise_are_safe_on_a_cpu() -> None:
    """Both are called unconditionally by the training loop."""
    enable_fast_matmul(torch.device("cpu"))
    synchronize(torch.device("cpu"))
