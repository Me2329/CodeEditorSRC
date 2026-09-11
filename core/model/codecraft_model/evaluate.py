"""Measuring a model, rather than looking at samples and forming an impression.

Three numbers, each answering a different question.

Perplexity answers "how surprised is it by real code", which is the training
objective made legible. Held-out perplexity is the only one worth reporting:
a model can drive training perplexity to one by memorising.

Bits per character answers the same question in units that survive a change of
tokenizer. Loss per token is not comparable between a 4,096-token vocabulary
and a 32,768-token one, because the second is predicting from a harder menu.
Dividing by characters per token removes that, and makes two runs with
different tokenizers comparable.

Throughput answers "is this fast enough to sit behind a caret". Prefill and
decode are measured separately because they have different shapes: prefill
processes the whole prompt in one pass and is compute-bound, while decode
produces one token at a time and is bound by reading the weights.
"""

from __future__ import annotations

import math
import time
from dataclasses import asdict, dataclass

import numpy as np
import torch

from .data import TokenDataset
from .device import autocast_dtype, synchronize
from .model import CodeCraftLM


@dataclass(frozen=True)
class Perplexity:
    loss: float
    perplexity: float
    bits_per_token: float
    bits_per_character: float
    tokens_scored: int
    batches: int


@dataclass(frozen=True)
class Throughput:
    """Tokens per second, split by the two phases that behave differently."""

    prefill_tokens_per_second: float
    decode_tokens_per_second: float
    first_token_ms: float
    prompt_tokens: int
    generated_tokens: int


@torch.no_grad()
def measure_perplexity(
    model: CodeCraftLM,
    dataset: TokenDataset,
    *,
    batches: int = 50,
    batch_size: int = 8,
    block_size: int | None = None,
    characters_per_token: float | None = None,
    device: torch.device | None = None,
    seed: int = 1234,
) -> Perplexity:
    """Mean loss over random windows of held-out data.

    A fixed seed, so two runs of the same checkpoint report the same number and
    a difference between checkpoints is a real difference rather than sampling
    noise.
    """
    device = device or next(model.parameters()).device
    block = block_size or model.config.max_seq_len
    amp_dtype = autocast_dtype(device)

    was_training = model.training
    model.eval()

    generator = np.random.default_rng(seed)
    total_loss = 0.0
    scored = 0

    for _ in range(batches):
        inputs, targets = dataset.batch(batch_size, block, generator, device=device)
        with torch.autocast(
            device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None
        ):
            _, loss, _ = model(inputs, targets=targets)
        total_loss += float(loss)
        scored += inputs.numel()

    if was_training:
        model.train()

    mean_loss = total_loss / max(batches, 1)
    bits_per_token = mean_loss / math.log(2)

    return Perplexity(
        loss=mean_loss,
        # Capped before exponentiating: an untrained model would otherwise
        # report infinity, which is true but useless in a table.
        perplexity=math.exp(min(mean_loss, 20)),
        bits_per_token=bits_per_token,
        bits_per_character=(
            bits_per_token / characters_per_token if characters_per_token else float("nan")
        ),
        tokens_scored=scored,
        batches=batches,
    )


@torch.no_grad()
def measure_throughput(
    model: CodeCraftLM,
    *,
    prompt_tokens: int = 256,
    generate_tokens: int = 64,
    warmup: int = 2,
    device: torch.device | None = None,
) -> Throughput:
    """How fast the model reads a prompt, and how fast it writes.

    Warmup runs first and is discarded. The first pass through a model pays for
    lazy kernel selection, cache allocation and, when compiled, the compile
    itself; including it would measure startup rather than speed.
    """
    device = device or next(model.parameters()).device
    prompt_tokens = min(prompt_tokens, model.config.max_seq_len - generate_tokens - 1)
    amp_dtype = autocast_dtype(device)

    model.eval()
    prompt = torch.randint(
        0, model.config.vocab_size, (1, prompt_tokens), device=device, dtype=torch.long
    )

    def run_prefill():
        with torch.autocast(
            device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None
        ):
            return model(prompt)

    for _ in range(warmup):
        run_prefill()
    synchronize(device)

    started = time.perf_counter()
    _, _, caches = run_prefill()
    synchronize(device)
    prefill_seconds = time.perf_counter() - started

    # Decode, one token at a time against the cache, which is the path that
    # actually runs while someone waits.
    next_token = torch.zeros(1, 1, dtype=torch.long, device=device)
    position = prompt_tokens

    started = time.perf_counter()
    for _ in range(generate_tokens):
        with torch.autocast(
            device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None
        ):
            _, _, caches = model(next_token, caches=caches, start_position=position)
        position += 1
    synchronize(device)
    decode_seconds = time.perf_counter() - started

    return Throughput(
        prefill_tokens_per_second=prompt_tokens / max(prefill_seconds, 1e-9),
        decode_tokens_per_second=generate_tokens / max(decode_seconds, 1e-9),
        # What the user actually perceives as lag before anything appears.
        first_token_ms=prefill_seconds * 1000,
        prompt_tokens=prompt_tokens,
        generated_tokens=generate_tokens,
    )


def report(perplexity: Perplexity | None, throughput: Throughput | None) -> dict:
    return {
        "perplexity": asdict(perplexity) if perplexity else None,
        "throughput": asdict(throughput) if throughput else None,
    }
