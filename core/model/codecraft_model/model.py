"""The transformer.

A decoder-only language model written from scratch: RMSNorm, rotary position
embeddings, grouped query attention, SwiGLU feed-forward blocks, and tied input
and output embeddings. Every component is implemented here rather than imported,
because the point of this module is to be the model, not to configure someone
else's.

Generation uses a key/value cache, so producing a token costs one step of work
rather than re-reading the whole prefix.
"""

from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.utils.checkpoint

from .config import ModelConfig


class RMSNorm(nn.Module):
    """Root-mean-square normalisation.

    Scales each vector by its own root-mean-square and applies a learned gain.
    Unlike LayerNorm it does not centre the input, which removes the mean
    subtraction and its parameters for no measured loss in quality.
    """

    def __init__(self, dim: int, eps: float = 1e-5) -> None:
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # Computed in float32 even under autocast: the reciprocal square root
        # of a mean of squares loses too much precision in half precision.
        dtype = x.dtype
        x = x.float()
        normed = x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)
        return (normed.to(dtype)) * self.weight


def build_rope_cache(
    head_dim: int,
    max_seq_len: int,
    theta: float,
    device: torch.device | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Precompute the cosine and sine tables for rotary embeddings.

    Rotary embeddings encode position by rotating each pair of channels by an
    angle proportional to the position. Attention scores then depend on the
    difference between two positions rather than their absolute values, which
    is what lets the model generalise past the lengths it saw in training.
    """
    if head_dim % 2 != 0:
        raise ValueError(f"head_dim must be even for rotary embeddings, got {head_dim}")

    # Each channel pair rotates at its own frequency, geometrically spaced.
    inverse_frequency = 1.0 / (
        theta ** (torch.arange(0, head_dim, 2, dtype=torch.float32, device=device) / head_dim)
    )
    positions = torch.arange(max_seq_len, dtype=torch.float32, device=device)
    angles = torch.outer(positions, inverse_frequency)
    return torch.cos(angles), torch.sin(angles)


def apply_rope(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    """Rotate the channel pairs of `x` by the given angles.

    `x` is (batch, heads, seq, head_dim); `cos` and `sin` are (seq, head_dim/2).
    """
    # Split each head's channels into the two halves of every rotation pair.
    x1, x2 = x.chunk(2, dim=-1)
    cos = cos[None, None, :, :]
    sin = sin[None, None, :, :]
    return torch.cat([x1 * cos - x2 * sin, x1 * sin + x2 * cos], dim=-1)


class Attention(nn.Module):
    """Causal self-attention with grouped query heads.

    Query heads outnumber key/value heads, and each key/value head is shared by
    a group of query heads. That shrinks the cache held during generation by the
    group size without measurably hurting quality, which is what makes long
    contexts affordable.
    """

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.n_heads = config.n_heads
        self.n_kv_heads = config.n_kv_heads
        self.n_groups = config.n_kv_groups
        self.head_dim = config.head_dim

        kv_dim = config.n_kv_heads * config.head_dim
        self.q_proj = nn.Linear(config.d_model, config.d_model, bias=False)
        self.k_proj = nn.Linear(config.d_model, kv_dim, bias=False)
        self.v_proj = nn.Linear(config.d_model, kv_dim, bias=False)
        self.o_proj = nn.Linear(config.d_model, config.d_model, bias=False)
        self.dropout = config.dropout

    def forward(
        self,
        x: torch.Tensor,
        cos: torch.Tensor,
        sin: torch.Tensor,
        cache: tuple[torch.Tensor, torch.Tensor] | None = None,
    ) -> tuple[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]:
        batch, seq, _ = x.shape

        q = self.q_proj(x).view(batch, seq, self.n_heads, self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(batch, seq, self.n_kv_heads, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(batch, seq, self.n_kv_heads, self.head_dim).transpose(1, 2)

        q = apply_rope(q, cos, sin)
        k = apply_rope(k, cos, sin)

        past = 0 if cache is None else cache[0].shape[2]
        if cache is not None:
            past_k, past_v = cache
            k = torch.cat([past_k, k], dim=2)
            v = torch.cat([past_v, v], dim=2)
        new_cache = (k, v)

        # Repeat each key/value head across the query heads that share it.
        if self.n_groups > 1:
            k = k.repeat_interleave(self.n_groups, dim=1)
            v = v.repeat_interleave(self.n_groups, dim=1)

        # Three cases, and the third is the one that is easy to get wrong.
        #
        # One query with a cache behind it attends to everything, so no mask.
        # A whole sequence with nothing cached is the ordinary causal case.
        # A run of queries *on top of* a cache needs a mask aligned to the
        # bottom right: query i sits at absolute position past+i and may see
        # every key up to it. `is_causal=True` would align the mask to the top
        # left instead, letting query 0 see only key 0 and hiding the entire
        # cached prefix from the new tokens. That case does not arise while
        # decoding one token at a time, which is why it can lurk.
        attn_mask = None
        is_causal = False
        if seq > 1:
            if past == 0:
                is_causal = True
            else:
                rows = torch.arange(past, past + seq, device=q.device).unsqueeze(1)
                columns = torch.arange(past + seq, device=q.device).unsqueeze(0)
                # True means the key takes part, which is SDPA's convention for
                # a boolean mask.
                attn_mask = columns <= rows

        attended = F.scaled_dot_product_attention(
            q,
            k,
            v,
            attn_mask=attn_mask,
            dropout_p=self.dropout if self.training else 0.0,
            is_causal=is_causal,
        )

        attended = attended.transpose(1, 2).contiguous().view(batch, seq, -1)
        return self.o_proj(attended), new_cache


class SwiGLU(nn.Module):
    """Gated feed-forward block.

    Two projections up, one of which is passed through SiLU and used to gate the
    other, then one projection back down. The gate lets the block suppress
    channels per token, which consistently outperforms a plain two-matrix block
    at the same parameter count.
    """

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.gate_proj = nn.Linear(config.d_model, config.d_ff, bias=False)
        self.up_proj = nn.Linear(config.d_model, config.d_ff, bias=False)
        self.down_proj = nn.Linear(config.d_ff, config.d_model, bias=False)
        self.dropout = nn.Dropout(config.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.dropout(self.down_proj(F.silu(self.gate_proj(x)) * self.up_proj(x)))


class Block(nn.Module):
    """One transformer layer: attention then feed-forward, each pre-normalised.

    Normalising before each sub-layer rather than after leaves the residual
    stream unnormalised end to end, which is what lets deep stacks train without
    a learning-rate warmup fight.
    """

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.attention_norm = RMSNorm(config.d_model, config.rms_norm_eps)
        self.attention = Attention(config)
        self.ffn_norm = RMSNorm(config.d_model, config.rms_norm_eps)
        self.feed_forward = SwiGLU(config)

    def forward(
        self,
        x: torch.Tensor,
        cos: torch.Tensor,
        sin: torch.Tensor,
        cache: tuple[torch.Tensor, torch.Tensor] | None = None,
    ) -> tuple[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]:
        attended, new_cache = self.attention(self.attention_norm(x), cos, sin, cache)
        x = x + attended
        x = x + self.feed_forward(self.ffn_norm(x))
        return x, new_cache


class CodeCraftLM(nn.Module):
    """The language model."""

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.config = config

        self.token_embedding = nn.Embedding(config.vocab_size, config.d_model)
        self.dropout = nn.Dropout(config.dropout)
        self.blocks = nn.ModuleList(Block(config) for _ in range(config.n_layers))
        self.final_norm = RMSNorm(config.d_model, config.rms_norm_eps)

        self.output_head = nn.Linear(config.d_model, config.vocab_size, bias=False)
        if config.tie_embeddings:
            # One matrix serves as both the embedding and the output projection.
            self.output_head.weight = self.token_embedding.weight

        cos, sin = build_rope_cache(config.head_dim, config.max_seq_len, config.rope_theta)
        # Buffers, not parameters: derived from the configuration, and excluded
        # from the checkpoint so a saved model can be reloaded at any length.
        self.register_buffer("rope_cos", cos, persistent=False)
        self.register_buffer("rope_sin", sin, persistent=False)

        # Recompute activations in the backward pass instead of keeping them.
        # Off by default: it is a memory-for-time trade, and a run that fits
        # should not pay for it.
        self.gradient_checkpointing = False

        self.apply(self._init_weights)
        # Scale the projections that write into the residual stream by depth, so
        # the stream's variance does not grow with the number of layers.
        scale = 1.0 / math.sqrt(2 * config.n_layers)
        for name, parameter in self.named_parameters():
            if name.endswith("o_proj.weight") or name.endswith("down_proj.weight"):
                torch.nn.init.normal_(parameter, mean=0.0, std=0.02 * scale)

    def enable_gradient_checkpointing(self, enabled: bool = True) -> None:
        """Trade time for memory during training.

        The activations of every block are normally kept from the forward pass
        so the backward pass can use them, and they are most of what a training
        run holds: at a long context they dwarf the weights, the gradients and
        the optimiser state together. Checkpointing keeps only each block's
        input and recomputes the rest when the gradient arrives.

        The cost is one extra forward pass, so roughly a third more time per
        step. The gain is that activation memory stops scaling with depth. It is
        what lets a model that does not fit be trained at all, which beats
        training a smaller one faster.
        """
        self.gradient_checkpointing = enabled

    @staticmethod
    def _init_weights(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            torch.nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                torch.nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            torch.nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def parameter_count(self, trainable_only: bool = True) -> int:
        seen: set[int] = set()
        total = 0
        for parameter in self.parameters():
            if trainable_only and not parameter.requires_grad:
                continue
            # Tied weights appear twice; count the storage once.
            if id(parameter) in seen:
                continue
            seen.add(id(parameter))
            total += parameter.numel()
        return total

    def forward(
        self,
        tokens: torch.Tensor,
        targets: torch.Tensor | None = None,
        caches: list[tuple[torch.Tensor, torch.Tensor]] | None = None,
        start_position: int = 0,
        project_all: bool = False,
    ) -> tuple[torch.Tensor, torch.Tensor | None, list[tuple[torch.Tensor, torch.Tensor]]]:
        """Run the model.

        Returns the logits, the loss when targets are given, and the updated
        key/value caches.

        `project_all` asks for logits at every position without computing a
        loss, which is what a caller needs when it scores the output itself
        against a different mask. Without it, the only way to get full logits is
        to hand over targets, and then the model scores them too.
        """
        _, seq = tokens.shape
        end = start_position + seq
        if end > self.config.max_seq_len:
            raise ValueError(
                f"sequence of {end} tokens exceeds the model's context of "
                f"{self.config.max_seq_len}"
            )

        cos = self.rope_cos[start_position:end]
        sin = self.rope_sin[start_position:end]

        x = self.dropout(self.token_embedding(tokens))

        new_caches: list[tuple[torch.Tensor, torch.Tensor]] = []
        # Only while training, and only without a cache: recomputation needs to
        # run the block a second time, and a block that appends to a key/value
        # cache would append twice.
        recompute = (
            self.gradient_checkpointing
            and self.training
            and torch.is_grad_enabled()
            and caches is None
        )
        for index, block in enumerate(self.blocks):
            cache = caches[index] if caches is not None else None
            if recompute:
                # use_reentrant=False is the supported implementation: it keeps
                # working with anything that does not return a plain tensor,
                # which this does not.
                x, updated = torch.utils.checkpoint.checkpoint(
                    block, x, cos, sin, cache, use_reentrant=False
                )
            else:
                x, updated = block(x, cos, sin, cache)
            new_caches.append(updated)

        x = self.final_norm(x)

        loss = None
        if targets is not None or project_all:
            logits = self.output_head(x)
        if targets is not None:
            loss = F.cross_entropy(
                logits.view(-1, logits.size(-1)),
                targets.reshape(-1),
                # Padding must not contribute to the loss.
                ignore_index=0,
            )
        elif not project_all:
            # Generation only needs the last position, and the output head is
            # the largest matrix in the model: projecting the whole sequence
            # would dominate the cost of a step.
            logits = self.output_head(x[:, -1:, :])

        return logits, loss, new_caches

    @torch.no_grad()
    def generate(
        self,
        tokens: torch.Tensor,
        max_new_tokens: int,
        *,
        temperature: float = 0.8,
        top_k: int | None = 40,
        top_p: float | None = 0.95,
        min_p: float | None = None,
        repetition_penalty: float = 1.1,
        no_repeat_ngram: int = 0,
        recycle_context: float = 0.0,
        on_token=None,
        stop_tokens: set[int] | None = None,
        prefix_caches: list[tuple[torch.Tensor, torch.Tensor]] | None = None,
        prefix_length: int = 0,
        on_prefill=None,
        allowed_first: torch.Tensor | None = None,
    ):
        """Yield tokens one at a time, using the cache so each step is O(1).

        `prefix_caches` skips part of the prefill. When the caller already holds
        the key/value tensors for the first `prefix_length` tokens of this exact
        prompt, only what follows them is run. This is the difference between
        re-reading a 256-token context on every keystroke and reading the one
        character that was typed.

        `on_prefill` is handed the caches and their length once the prompt has
        been read, which is the moment worth remembering: the prompt is what the
        next request will share, and the tokens generated after it are not.

        `no_repeat_ngram` forbids repeating an n-gram this call has already
        produced, which is what stops a small model looping on a phrase. Zero
        turns it off.

        `on_token` is called with each token and its log-probability under the
        model's own distribution, before temperature, top-k or any penalty. That
        is the number worth reporting: a probability measured after the
        distribution has been cut down says how likely the token was among the
        ones still allowed, which is not a property of the model.

        `recycle_context` is the fraction of the window to keep when it fills.
        Zero stops instead, which is the default and the honest answer for a
        completion. Set it, and generation continues: the most recent tokens are
        re-read from position zero and everything before them is forgotten. That
        costs one prefill per recycle and loses the beginning of the text, which
        is a real trade rather than a free continuation.
        """
        if not 0.0 <= recycle_context < 1.0:
            raise ValueError("recycle_context is a fraction of the window, below 1")
        self.eval()
        stop_tokens = stop_tokens or set()

        # Prefill: run the prompt once and keep its cache.
        context = tokens[:, -self.config.max_seq_len :]
        generated = context[0].tolist()

        reused = 0
        if prefix_caches is not None and prefix_length > 0:
            if context.shape[1] != tokens.shape[1]:
                # The prompt was trimmed to fit, so position i of the cache is
                # no longer position i of the prompt and every cached key is
                # attached to the wrong place. Refusing beats answering wrongly.
                raise ValueError("a trimmed prompt cannot reuse a cached prefix")
            if prefix_length >= context.shape[1]:
                raise ValueError("the cached prefix leaves no token to run")
            reused = prefix_length

        logits, _, caches = self.forward(
            context[:, reused:],
            caches=prefix_caches if reused else None,
            start_position=reused,
        )
        position = context.shape[1]

        if on_prefill is not None:
            on_prefill(caches, position)

        produced: list[int] = []

        for _ in range(max_new_tokens):
            next_logits = logits[:, -1, :].float()
            # Taken before anything modifies the distribution, so what is
            # reported is the model's own opinion rather than the sampler's.
            true_logprobs = (
                F.log_softmax(next_logits, dim=-1) if on_token is not None else None
            )

            if repetition_penalty != 1.0 and generated:
                next_logits = _apply_repetition_penalty(
                    next_logits, generated, repetition_penalty
                )

            if allowed_first is not None and not produced:
                # Token healing: the prompt was cut back to a token boundary and
                # the characters removed have to come back, so the first token
                # is chosen from those that begin with them. Only the first:
                # after it the model is on a boundary again and unconstrained.
                permitted = torch.full_like(next_logits, float("-inf"))
                permitted[:, allowed_first] = next_logits[:, allowed_first]
                next_logits = permitted

            banned = _ngram_bans(produced, no_repeat_ngram)
            if banned:
                # Cloned first: the logits are a view of the model's own output
                # under no_grad, and writing through it would corrupt the tensor
                # the next step reads.
                next_logits = next_logits.clone()
                next_logits[:, banned] = float("-inf")

            if temperature <= 0:
                next_token = torch.argmax(next_logits, dim=-1, keepdim=True)
            else:
                next_logits = next_logits / temperature
                next_logits = _filter_logits(next_logits, top_k, top_p, min_p)
                probabilities = F.softmax(next_logits, dim=-1)
                next_token = torch.multinomial(probabilities, num_samples=1)

            token_id = int(next_token.item())
            if true_logprobs is not None:
                on_token(token_id, float(true_logprobs[0, token_id]))
            if token_id in stop_tokens:
                return
            yield token_id

            generated.append(token_id)
            produced.append(token_id)

            if len(produced) >= max_new_tokens:
                # The budget is spent. Running the model once more would compute
                # logits nobody reads, which on the last step of a short
                # completion is a measurable fraction of the whole thing.
                return

            if position >= self.config.max_seq_len:
                if recycle_context <= 0:
                    # The context is full. Stopping is honest; silently dropping
                    # the oldest tokens would invalidate every cached key.
                    return

                # Every cached key is bound to the position it was computed at,
                # so keeping the recent tokens means reading them again from
                # position zero. The cache cannot be shifted, only rebuilt.
                keep = max(1, int(self.config.max_seq_len * recycle_context))
                window = torch.tensor(
                    [generated[-keep:]], dtype=torch.long, device=next_token.device
                )
                logits, _, caches = self.forward(window)
                position = window.shape[1]
                continue

            logits, _, caches = self.forward(
                next_token, caches=caches, start_position=position
            )
            position += 1


def _ngram_bans(produced: list[int], size: int) -> list[int]:
    """Tokens that would repeat an n-gram this generation has already produced.

    The repetition penalty discourages tokens seen before; this forbids a
    specific continuation. They catch different things. A penalty scales every
    occurrence of a token and a small model will still walk into ", value,
    value, value" because each individual token stays plausible. Banning the
    completion of an n-gram already produced breaks the cycle exactly.

    Only what this call generated is considered. Code legitimately repeats
    itself, and a completion that cannot reuse a phrase from the file it is
    completing is worse than one that loops: repeating the surrounding idiom is
    most of what an inline suggestion is for.
    """
    if size <= 0 or len(produced) < size:
        return []

    context = tuple(produced[len(produced) - size + 1 :]) if size > 1 else ()
    banned = []
    for start in range(len(produced) - size + 1):
        if tuple(produced[start : start + size - 1]) == context:
            banned.append(produced[start + size - 1])
    return banned


def _apply_repetition_penalty(
    logits: torch.Tensor, generated: list[int], penalty: float
) -> torch.Tensor:
    """Discourage tokens already produced.

    A small model left unchecked will loop on a phrase, so scores for tokens
    already in the output are divided down (or multiplied, when negative, which
    moves them further from selection either way).
    """
    unique = torch.tensor(sorted(set(generated)), device=logits.device, dtype=torch.long)
    selected = logits[0, unique]
    logits[0, unique] = torch.where(selected > 0, selected / penalty, selected * penalty)
    return logits


def _filter_logits(
    logits: torch.Tensor,
    top_k: int | None,
    top_p: float | None,
    min_p: float | None = None,
) -> torch.Tensor:
    """Restrict sampling to the most probable tokens.

    Three filters, applied together, each covering a case the others miss.

    top_k keeps a fixed number of candidates, which puts a hard ceiling on how
    wrong a sample can go but ignores how confident the model is.

    top_p keeps the smallest set whose probabilities sum past a threshold, which
    does adapt to confidence but badly at the extremes: when the model is very
    sure, top_p still admits a long tail of near-zero candidates to reach its
    sum, and one of them eventually gets picked.

    min_p keeps everything within a fraction of the most likely token. That is
    the filter that matches what code needs. After `def ` the model is certain
    and min_p leaves almost nothing to choose from; mid-comment it is not, and
    min_p widens on its own. It is off by default because changing sampling
    silently would make two runs of the same checkpoint incomparable.
    """
    if top_k is not None and top_k > 0:
        k = min(top_k, logits.size(-1))
        threshold = torch.topk(logits, k, dim=-1).values[..., -1, None]
        logits = logits.masked_fill(logits < threshold, float("-inf"))

    if min_p is not None and 0 < min_p < 1.0:
        probabilities = F.softmax(logits, dim=-1)
        # Relative to the best candidate, not to a fixed probability: the whole
        # point is that the threshold moves with the model's confidence.
        floor = probabilities.amax(dim=-1, keepdim=True) * min_p
        logits = logits.masked_fill(probabilities < floor, float("-inf"))

    if top_p is not None and 0 < top_p < 1.0:
        ordered, indices = torch.sort(logits, descending=True, dim=-1)
        cumulative = torch.cumsum(F.softmax(ordered, dim=-1), dim=-1)

        remove = cumulative - F.softmax(ordered, dim=-1) > top_p
        # Always keep the single most likely token, or a very peaked
        # distribution could leave nothing to sample from.
        remove[..., 0] = False

        ordered = ordered.masked_fill(remove, float("-inf"))
        logits = torch.zeros_like(logits).scatter_(-1, indices, ordered)

    return logits
