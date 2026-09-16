"""Which attention kernel a card will actually use, asked rather than assumed.

Scaled dot product attention has several implementations behind one call, and
which one runs is decided at the call site from the shapes, the dtype, the mask
and the card. The fused ones read the sequence in tiles and never write the
attention matrix to memory; the fallback materialises it, which at a context of
four thousand tokens is the difference between a run that finishes and one that
does not. Nothing warns you when you land on the fallback. It is simply slower,
by a factor large enough to be mistaken for the model being big.

The specific thing this exists to check is grouped query attention. Several
query heads share one key/value head, and the sharing can be handed to the
kernel or materialised first by copying K and V up to full size. The results are
bit-identical; the memory traffic is not. Handing it to the kernel is only the
better choice if the kernel still takes the fused path, and that is a property
of the installed wheel and the card in the machine — not something a README can
know. So this asks, on the machine, and `plan` prints the answer.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch

from .config import ModelConfig

#: In the order the dispatcher prefers them, fastest first.
BACKENDS: tuple[str, ...] = ("flash", "cudnn", "efficient")


@dataclass(frozen=True)
class Support:
    """Which fused kernels accept one attention shape."""

    flash: bool
    cudnn: bool
    efficient: bool

    @property
    def fused(self) -> bool:
        """Whether anything but the fallback will run."""
        return self.flash or self.cudnn or self.efficient

    @property
    def chosen(self) -> str:
        """The one the dispatcher will pick, which is the first that fits."""
        for name in BACKENDS:
            if getattr(self, name):
                return name
        return "math"


def _probe(
    config: ModelConfig,
    device: torch.device,
    *,
    batch: int,
    seq: int,
    dtype: torch.dtype,
    enable_gqa: bool,
) -> Support:
    """Ask the dispatcher about a shape without running anything on it.

    The tensors are empty rather than allocated: the backends are chosen from
    shape, stride, dtype and device, none of which needs the memory behind them.
    """
    heads = config.n_heads
    kv_heads = config.n_kv_heads if enable_gqa else config.n_heads
    shape_q = (batch, heads, seq, config.head_dim)
    shape_kv = (batch, kv_heads, seq, config.head_dim)
    query = torch.empty(shape_q, device=device, dtype=dtype)
    key = torch.empty(shape_kv, device=device, dtype=dtype)
    value = torch.empty(shape_kv, device=device, dtype=dtype)

    params = torch.backends.cuda.SDPAParams(
        query, key, value, None, 0.0, True, enable_gqa
    )
    backends = torch.backends.cuda

    def accepts(name: str) -> bool:
        # Each of these can raise rather than answer: asking about cuDNN on a
        # machine whose driver is older than the wheel initialises CUDA to find
        # out, and fails there. A question that cannot be answered is not a yes.
        try:
            return bool(getattr(backends, f"can_use_{name}_attention")(params, False))
        except Exception:
            return False

    return Support(
        flash=accepts("flash"),
        cudnn=accepts("cudnn"),
        efficient=accepts("efficient"),
    )


def attention_support(
    config: ModelConfig,
    device: torch.device,
    *,
    batch: int = 1,
    seq: int | None = None,
    dtype: torch.dtype = torch.bfloat16,
) -> tuple[Support, Support] | None:
    """What the card accepts with the sharing folded in, and with it copied out.

    Returns the grouped case first, because that is what the model asks for.
    The second is what it would fall back to, and comparing them is the whole
    question: if the grouped one loses the fused kernel and the copied one keeps
    it, then the copy is worth making.

    None where the question does not arise. Off a card there is one
    implementation and no choice to report, and asking anyway would only invent
    a distinction that does not exist on the machine being asked about.
    """
    if device.type != "cuda":
        return None
    length = config.max_seq_len if seq is None else seq
    grouped = _probe(
        config, device, batch=batch, seq=length, dtype=dtype, enable_gqa=True
    )
    copied = _probe(
        config, device, batch=batch, seq=length, dtype=dtype, enable_gqa=False
    )
    return grouped, copied


def describe_attention(grouped: Support, copied: Support) -> str:
    """One line on what will run, and a second only when something is wrong."""
    if not grouped.fused and not copied.fused:
        return (
            "attention falls back to the unfused kernel, which writes the whole "
            "attention\n  matrix to memory. On a card this is worth investigating "
            "before a long run"
        )
    if not grouped.fused:
        return (
            f"grouped query attention is not fused here, though {copied.chosen} "
            f"takes it when\n  the shared heads are copied up first. That copy is "
            f"the faster of the two"
        )
    if grouped.chosen == copied.chosen:
        return f"attention: {grouped.chosen}, with the shared heads folded into the kernel"
    # Both are fused, but not the same one. BACKENDS is ordered fastest first,
    # so a later choice with the fold in place means the fold cost something.
    order = {name: index for index, name in enumerate(BACKENDS)}
    if order[grouped.chosen] > order[copied.chosen]:
        return (
            f"attention: {grouped.chosen} with the shared heads folded into the kernel, "
            f"where\n  copying them up first would reach {copied.chosen}. Worth measuring "
            f"both ways"
        )
    return (
        f"attention: {grouped.chosen}, with the shared heads folded into the kernel "
        f"(only\n  {copied.chosen} without folding, so the fold is the faster of the two)"
    )
