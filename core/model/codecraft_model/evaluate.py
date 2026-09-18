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
import torch.nn.functional as F

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
class InfillPerplexity:
    """Loss on the middles only, which is the part an editor actually asks for."""

    loss: float
    perplexity: float
    middle_tokens: int
    tokens_seen: int
    #: Scored tokens as a fraction of those read. Each window is mostly the
    #: context the model needed in order to be asked the question.
    coverage: float
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
def measure_infill_perplexity(
    model: CodeCraftLM,
    dataset: TokenDataset,
    *,
    fim_middle: int,
    boundaries: tuple[int, ...],
    windows: int = 48,
    batch_size: int = 4,
    block_size: int | None = None,
    answer_tokens: int = 64,
    device: torch.device | None = None,
    seed: int = 1234,
) -> InfillPerplexity | None:
    """Mean loss over what the model is asked to write, and nothing else.

    Ordinary perplexity scores every token in the stream, and nearly all of it
    is prefix and suffix: text the model is given rather than asked for. An
    editor only ever asks for the middle. A checkpoint can get better at reading
    code while getting worse at writing the part that goes in the hole, and one
    number cannot show that.

    The windows are placed rather than sampled. Each one ends `answer_tokens`
    after a fill-in-the-middle marker, so the model has read a full prefix and
    suffix and is scored on the first tokens of the answer — which is the whole
    of what an editor ever sees. Sampling windows at random would instead land
    mostly inside long prefixes and score a handful of middle tokens by luck:
    measured on this corpus, 0.2% of what was read.

    Returns None when the held-out set has no markers in it, which is what a
    corpus prepared without fill-in-the-middle looks like.
    """
    device = device or next(model.parameters()).device
    block = block_size or model.config.max_seq_len
    answer = max(1, min(answer_tokens, block - 1))
    amp_dtype = autocast_dtype(device)

    markers = dataset.find(fim_middle)
    lead = block - answer
    # A marker needs a whole window of context behind it and one token of
    # lookahead in front, or the window would run off an end of the stream.
    usable = markers[(markers >= lead) & (markers + answer + 1 < len(dataset))]
    if len(usable) == 0:
        return None

    generator = np.random.default_rng(seed)
    if len(usable) > windows:
        usable = generator.choice(usable, size=windows, replace=False)
    usable = np.sort(usable)

    was_training = model.training
    model.eval()

    total_loss = torch.zeros((), device=device, dtype=torch.float64)
    middle_tokens = 0
    seen = 0
    batches = 0

    for offset in range(0, len(usable), batch_size):
        starts = [int(marker) - lead for marker in usable[offset : offset + batch_size]]
        inputs, targets = dataset.windows_at(starts, block, device=device)
        mask = middle_mask(inputs, fim_middle, boundaries)
        seen += inputs.numel()
        batches += 1
        if not bool(mask.any()):
            continue

        with torch.autocast(
            device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None
        ):
            logits, _, _ = model(inputs, targets=targets)
        # Per token rather than per batch: only some of these positions are the
        # answer to a caret, and the rest must not be averaged in.
        losses = F.cross_entropy(
            logits.float().view(-1, logits.size(-1)),
            targets.reshape(-1),
            reduction="none",
        ).view_as(targets)
        total_loss += (losses * mask).sum().double()
        middle_tokens += int(mask.sum())

    if was_training:
        model.train()

    if middle_tokens == 0:
        return None

    mean_loss = float(total_loss) / middle_tokens
    return InfillPerplexity(
        loss=mean_loss,
        perplexity=math.exp(min(mean_loss, 20)),
        middle_tokens=middle_tokens,
        tokens_seen=seen,
        coverage=middle_tokens / max(seen, 1),
        batches=batches,
    )


def middle_mask(
    inputs: torch.Tensor, fim_middle: int, boundaries: tuple[int, ...]
) -> torch.Tensor:
    """Which predictions are of middle tokens.

    Position `i` predicts `inputs[i + 1]`, so a position counts when the token
    at it opens or continues a middle: the marker itself, and everything after
    it until the next document begins.

    Done with running maxima rather than a loop over the batch, because the
    question "was the most recent marker a start or an end" is exactly what a
    cumulative maximum of positions answers.
    """
    positions = torch.arange(inputs.size(-1), device=inputs.device).expand_as(inputs)
    starts = inputs == fim_middle
    ends = torch.zeros_like(starts)
    for token in boundaries:
        ends |= inputs == token

    last_start = torch.cummax(torch.where(starts, positions, -1), dim=-1).values
    last_end = torch.cummax(torch.where(ends, positions, -1), dim=-1).values
    return (last_start > last_end).to(torch.float32)


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


def report(
    perplexity: Perplexity | None,
    throughput: Throughput | None,
    infill: InfillPerplexity | None = None,
) -> dict:
    return {
        "perplexity": asdict(perplexity) if perplexity else None,
        "infill": asdict(infill) if infill else None,
        "throughput": asdict(throughput) if throughput else None,
    }
