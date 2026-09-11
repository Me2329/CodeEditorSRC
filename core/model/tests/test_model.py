"""The transformer: shapes, the cache, and sampling."""

from __future__ import annotations

import pytest
import torch

from codecraft_model.config import ModelConfig
from codecraft_model.model import (
    Attention,
    CodeCraftLM,
    RMSNorm,
    _apply_repetition_penalty,
    _filter_logits,
    apply_rope,
    build_rope_cache,
)

CONFIG = ModelConfig(
    vocab_size=128, d_model=64, n_layers=2, n_heads=4, n_kv_heads=2, d_ff=128, max_seq_len=32
)


@pytest.fixture
def model() -> CodeCraftLM:
    torch.manual_seed(0)
    return CodeCraftLM(CONFIG).eval()


# ------------------------------------------------------------------ components


def test_rmsnorm_gives_unit_root_mean_square() -> None:
    norm = RMSNorm(16)
    output = norm(torch.randn(4, 16) * 10)
    assert torch.allclose(output.pow(2).mean(-1).sqrt(), torch.ones(4), atol=1e-3)


def test_rmsnorm_does_not_centre() -> None:
    """Unlike LayerNorm, a constant offset survives normalisation."""
    output = RMSNorm(16)(torch.ones(1, 16) * 3)
    assert output.mean() > 0.9


def test_rope_preserves_length() -> None:
    """A rotation changes direction, never magnitude."""
    cos, sin = build_rope_cache(8, 16, 10_000.0)
    x = torch.randn(1, 2, 16, 8)
    rotated = apply_rope(x, cos, sin)
    assert torch.allclose(x.norm(dim=-1), rotated.norm(dim=-1), atol=1e-5)


def test_rope_at_position_zero_is_the_identity() -> None:
    cos, sin = build_rope_cache(8, 4, 10_000.0)
    x = torch.randn(1, 1, 1, 8)
    assert torch.allclose(apply_rope(x, cos[:1], sin[:1]), x, atol=1e-6)


def test_rope_depends_only_on_relative_position() -> None:
    """Two vectors the same distance apart must score the same, wherever they sit."""
    cos, sin = build_rope_cache(8, 32, 10_000.0)
    q, k = torch.randn(1, 1, 1, 8), torch.randn(1, 1, 1, 8)

    def score(offset: int) -> float:
        rq = apply_rope(q, cos[offset : offset + 1], sin[offset : offset + 1])
        rk = apply_rope(k, cos[offset + 3 : offset + 4], sin[offset + 3 : offset + 4])
        return float((rq * rk).sum())

    assert score(0) == pytest.approx(score(10), abs=1e-4)


def test_odd_head_dimension_is_refused() -> None:
    with pytest.raises(ValueError, match="even"):
        build_rope_cache(7, 8, 10_000.0)


def test_attention_output_keeps_the_model_width() -> None:
    attention = Attention(CONFIG)
    cos, sin = build_rope_cache(CONFIG.head_dim, 8, CONFIG.rope_theta)
    output, (k, v) = attention(torch.randn(2, 8, CONFIG.d_model), cos, sin)

    assert output.shape == (2, 8, CONFIG.d_model)
    # The cache holds the reduced number of key/value heads, not the query heads.
    assert k.shape == (2, CONFIG.n_kv_heads, 8, CONFIG.head_dim) == v.shape


# ---------------------------------------------------------------------- model


def test_forward_returns_logits_and_a_cache(model: CodeCraftLM) -> None:
    tokens = torch.randint(0, CONFIG.vocab_size, (2, 8))
    logits, loss, caches = model(tokens)

    # Without targets only the final position is projected.
    assert logits.shape == (2, 1, CONFIG.vocab_size)
    assert loss is None
    assert len(caches) == CONFIG.n_layers


def test_forward_with_targets_scores_every_position(model: CodeCraftLM) -> None:
    tokens = torch.randint(1, CONFIG.vocab_size, (2, 8))
    targets = torch.randint(1, CONFIG.vocab_size, (2, 8))
    logits, loss, _ = model(tokens, targets=targets)

    assert logits.shape == (2, 8, CONFIG.vocab_size)
    assert loss.requires_grad


def test_untrained_loss_is_near_uniform(model: CodeCraftLM) -> None:
    """Targets are independent of the inputs.

    Reusing the inputs as targets would measure something else: tied embeddings
    give an untrained model a head start at predicting the token it was just
    shown, and the loss comes out below the uniform baseline.
    """
    tokens = torch.randint(1, CONFIG.vocab_size, (4, 16))
    targets = torch.randint(1, CONFIG.vocab_size, (4, 16))
    _, loss, _ = model(tokens, targets=targets)

    uniform = float(torch.log(torch.tensor(float(CONFIG.vocab_size))))
    assert abs(float(loss.detach()) - uniform) < 0.5


def test_attention_is_causal(model: CodeCraftLM) -> None:
    """Changing a later token must not change an earlier position's logits."""
    tokens = torch.randint(0, CONFIG.vocab_size, (1, 8))
    with torch.no_grad():
        first, _, _ = model(tokens[:, :4])

        altered = tokens.clone()
        altered[0, 6] = (altered[0, 6] + 1) % CONFIG.vocab_size
        second, _, _ = model(altered[:, :4])

    assert torch.allclose(first, second)


def test_cache_matches_a_full_forward_pass(model: CodeCraftLM) -> None:
    """Incremental decoding must produce exactly what re-reading the prefix does.

    This is the property the whole generation path rests on: if it fails, the
    model's output during generation differs from what it was trained to give.
    """
    tokens = torch.randint(0, CONFIG.vocab_size, (1, 10))

    with torch.no_grad():
        full, _, _ = model(tokens)

        # Same sequence, but the last token processed on its own against a cache.
        _, _, caches = model(tokens[:, :-1])
        stepped, _, _ = model(tokens[:, -1:], caches=caches, start_position=9)

    assert torch.allclose(full, stepped, atol=1e-4)


def test_sequences_past_the_context_are_refused(model: CodeCraftLM) -> None:
    with pytest.raises(ValueError, match="exceeds"):
        model(torch.zeros(1, CONFIG.max_seq_len + 1, dtype=torch.long))


def test_tied_weights_are_one_matrix(model: CodeCraftLM) -> None:
    assert model.output_head.weight is model.token_embedding.weight


def test_untied_weights_are_separate() -> None:
    untied = CodeCraftLM(ModelConfig(**{**CONFIG.to_dict(), "tie_embeddings": False}))
    assert untied.output_head.weight is not untied.token_embedding.weight
    assert untied.parameter_count() > CodeCraftLM(CONFIG).parameter_count()


def test_gradients_reach_every_parameter(model: CodeCraftLM) -> None:
    """A parameter with no gradient is a wiring bug, not a design choice."""
    model.train()
    tokens = torch.randint(1, CONFIG.vocab_size, (2, 8))
    _, loss, _ = model(tokens, targets=tokens)
    loss.backward()

    missing = [
        name
        for name, parameter in model.named_parameters()
        if parameter.grad is None or not torch.isfinite(parameter.grad).all()
    ]
    assert missing == []


# ------------------------------------------------------------------- sampling


def test_generate_yields_the_requested_number(model: CodeCraftLM) -> None:
    tokens = torch.randint(0, CONFIG.vocab_size, (1, 4))
    produced = list(model.generate(tokens, max_new_tokens=6, temperature=0.9))

    assert len(produced) == 6
    assert all(0 <= token < CONFIG.vocab_size for token in produced)


def test_greedy_generation_is_reproducible(model: CodeCraftLM) -> None:
    tokens = torch.randint(0, CONFIG.vocab_size, (1, 4))
    first = list(model.generate(tokens, max_new_tokens=5, temperature=0.0))
    second = list(model.generate(tokens, max_new_tokens=5, temperature=0.0))
    assert first == second


def test_generation_stops_at_a_stop_token(model: CodeCraftLM) -> None:
    """Every token is a stop token, so nothing should come out."""
    tokens = torch.randint(0, CONFIG.vocab_size, (1, 4))
    produced = list(
        model.generate(
            tokens,
            max_new_tokens=5,
            temperature=0.0,
            stop_tokens=set(range(CONFIG.vocab_size)),
        )
    )
    assert produced == []


def test_generation_stops_at_the_context_limit(model: CodeCraftLM) -> None:
    """Rather than silently dropping tokens whose keys are already cached."""
    tokens = torch.randint(0, CONFIG.vocab_size, (1, CONFIG.max_seq_len - 3))
    produced = list(model.generate(tokens, max_new_tokens=50, temperature=0.0))
    assert len(produced) <= 4


def test_top_k_leaves_exactly_k_candidates() -> None:
    logits = torch.tensor([[1.0, 2.0, 3.0, 4.0, 5.0]])
    filtered = _filter_logits(logits.clone(), top_k=2, top_p=None)
    assert int(torch.isfinite(filtered).sum()) == 2


def test_top_p_keeps_the_smallest_sufficient_set() -> None:
    logits = torch.tensor([[10.0, 1.0, 1.0, 1.0]])
    filtered = _filter_logits(logits.clone(), top_k=None, top_p=0.5)
    # One token holds almost all the mass, so it alone should survive.
    assert int(torch.isfinite(filtered).sum()) == 1


def test_top_p_always_keeps_one_token() -> None:
    """A very peaked distribution must not filter down to nothing."""
    logits = torch.tensor([[100.0, 0.0, 0.0]])
    filtered = _filter_logits(logits.clone(), top_k=None, top_p=0.01)
    assert int(torch.isfinite(filtered).sum()) >= 1


def test_repetition_penalty_pushes_seen_tokens_down() -> None:
    logits = torch.tensor([[2.0, 2.0, 2.0]])
    penalised = _apply_repetition_penalty(logits.clone(), [1], 2.0)
    assert float(penalised[0, 1]) == pytest.approx(1.0)
    assert float(penalised[0, 0]) == pytest.approx(2.0)


def test_repetition_penalty_moves_negative_scores_further_away() -> None:
    """Dividing a negative score would make it more likely, not less."""
    logits = torch.tensor([[-2.0, -2.0]])
    penalised = _apply_repetition_penalty(logits.clone(), [0], 2.0)
    assert float(penalised[0, 0]) < float(penalised[0, 1])


# ---------------------------------------------------------------- min-p


def test_min_p_keeps_only_what_is_close_to_the_best() -> None:
    """A fraction of the top probability, not a fixed one.

    The values sit clear of the threshold rather than on it: a candidate exactly
    at the boundary is decided by floating-point rounding, which is not a
    behaviour worth pinning down.
    """
    logits = torch.log(torch.tensor([[0.6, 0.4, 0.05, 0.05]]))
    filtered = _filter_logits(logits.clone(), top_k=None, top_p=None, min_p=0.5)

    # 0.4 is comfortably above half of 0.6; 0.05 is well below.
    assert int(torch.isfinite(filtered).sum()) == 2


def test_min_p_narrows_when_the_model_is_confident() -> None:
    """After `def ` there is not much to choose from, and that is correct."""
    confident = torch.log(torch.tensor([[0.97, 0.01, 0.01, 0.01]]))
    filtered = _filter_logits(confident.clone(), top_k=None, top_p=None, min_p=0.1)

    assert int(torch.isfinite(filtered).sum()) == 1


def test_min_p_widens_when_the_model_is_unsure() -> None:
    """Mid-comment, where several continuations are equally reasonable."""
    unsure = torch.log(torch.tensor([[0.3, 0.28, 0.22, 0.2]]))
    filtered = _filter_logits(unsure.clone(), top_k=None, top_p=None, min_p=0.1)

    assert int(torch.isfinite(filtered).sum()) == 4


def test_min_p_always_keeps_the_best_token() -> None:
    """It is its own reference, so it can never be filtered out."""
    logits = torch.log(torch.tensor([[0.99, 0.005, 0.005]]))
    filtered = _filter_logits(logits.clone(), top_k=None, top_p=None, min_p=0.99)

    assert int(torch.isfinite(filtered).sum()) >= 1


def test_min_p_is_off_unless_asked_for() -> None:
    """Changing sampling silently would make two runs incomparable."""
    logits = torch.log(torch.tensor([[0.6, 0.3, 0.05, 0.05]]))
    assert int(torch.isfinite(_filter_logits(logits.clone(), None, None)).sum()) == 4


def test_generation_accepts_min_p(model: CodeCraftLM) -> None:
    tokens = torch.randint(0, CONFIG.vocab_size, (1, 4))
    produced = list(model.generate(tokens, max_new_tokens=5, temperature=0.8, min_p=0.05))
    assert len(produced) == 5


# --------------------------------------------------------------- prefix reuse


def _greedy(model: CodeCraftLM, tokens: torch.Tensor, **options) -> list[int]:
    return list(model.generate(tokens, max_new_tokens=6, temperature=0.0, **options))


def test_a_reused_prefix_gives_the_same_logits(model: CodeCraftLM) -> None:
    """The whole point: skipping part of the prefill must change nothing.

    Compared on logits rather than on sampled tokens. An untrained model emits
    the same token whatever it is shown, so a test that compares what was
    generated would pass with the positions wired up wrongly.
    """
    torch.manual_seed(0)
    tokens = torch.randint(1, CONFIG.vocab_size, (1, 12))

    whole, _, caches = model(tokens, project_all=True)
    trimmed = [(keys[:, :, :8, :], values[:, :, :8, :]) for keys, values in caches]
    rest, _, _ = model(tokens[:, 8:], caches=trimmed, start_position=8, project_all=True)

    assert torch.allclose(rest, whole[:, 8:, :], atol=1e-5)


def test_a_prefix_at_the_wrong_position_does_not_give_the_same_logits() -> None:
    """The negative control for the test above.

    Rotary embeddings are applied by position, so a cache used at the wrong
    offset produces different attention. If this ever matches, the test above
    is measuring nothing.
    """
    torch.manual_seed(0)
    model = CodeCraftLM(CONFIG).eval()
    tokens = torch.randint(1, CONFIG.vocab_size, (1, 12))

    whole, _, caches = model(tokens, project_all=True)
    trimmed = [(keys[:, :, :8, :], values[:, :, :8, :]) for keys, values in caches]
    shifted, _, _ = model(tokens[:, 8:], caches=trimmed, start_position=6, project_all=True)

    assert not torch.allclose(shifted, whole[:, 8:, :], atol=1e-5)


def test_generating_with_a_reused_prefix_reads_only_the_new_tokens(
    model: CodeCraftLM,
) -> None:
    """The saving is real only if the prompt is not read again."""
    tokens = torch.randint(1, CONFIG.vocab_size, (1, 12))
    caches = model(tokens[:, :8])[2]

    widths: list[int] = []
    original = model.forward

    def spy(input_tokens, *args, **kwargs):
        widths.append(input_tokens.shape[1])
        return original(input_tokens, *args, **kwargs)

    model.forward = spy  # type: ignore[method-assign]
    try:
        _greedy(model, tokens, prefix_caches=caches, prefix_length=8)
    finally:
        model.forward = original  # type: ignore[method-assign]

    # Four tokens of prompt left, then one forward per generated token.
    assert widths[0] == 4


def test_the_prefill_is_reported_with_its_length(model: CodeCraftLM) -> None:
    seen: list[int] = []
    tokens = torch.randint(1, CONFIG.vocab_size, (1, 9))

    _greedy(model, tokens, on_prefill=lambda _caches, length: seen.append(length))

    assert seen == [9]


def test_reusing_the_whole_prompt_is_refused(model: CodeCraftLM) -> None:
    """There would be no token left to produce logits from."""
    tokens = torch.randint(1, CONFIG.vocab_size, (1, 5))
    caches = model(tokens)[2]

    with pytest.raises(ValueError, match="no token to run"):
        _greedy(model, tokens, prefix_caches=caches, prefix_length=5)


def test_a_trimmed_prompt_refuses_a_cached_prefix(model: CodeCraftLM) -> None:
    """Trimming shifts every position, so cached keys belong somewhere else."""
    long_prompt = torch.randint(1, CONFIG.vocab_size, (1, CONFIG.max_seq_len + 4))
    caches = model(long_prompt[:, : CONFIG.max_seq_len])[2]

    with pytest.raises(ValueError, match="trimmed prompt"):
        _greedy(model, long_prompt, prefix_caches=caches, prefix_length=4)


def test_no_prefix_cache_is_the_ordinary_path(model: CodeCraftLM) -> None:
    tokens = torch.randint(1, CONFIG.vocab_size, (1, 6))

    assert len(_greedy(model, tokens)) == 6


# ------------------------------------------------------------- repeat control


def test_an_ngram_already_produced_is_not_produced_again() -> None:
    """The direct check on the helper, without a model in the way."""
    from codecraft_model.model import _ngram_bans

    # "1 2 3" has been produced, and the last two tokens are "2 3"... the only
    # continuation that would repeat a 3-gram is what followed "2 3" before.
    assert _ngram_bans([1, 2, 3, 2, 3], 3) == [2]


def test_nothing_is_banned_before_there_is_an_ngram() -> None:
    from codecraft_model.model import _ngram_bans

    assert _ngram_bans([1, 2], 3) == []
    assert _ngram_bans([1, 2, 3], 0) == []


def test_every_repeat_of_the_context_is_banned() -> None:
    """Two different tokens have followed the same pair, so both are out."""
    from codecraft_model.model import _ngram_bans

    assert sorted(_ngram_bans([1, 2, 5, 1, 2, 7, 1, 2], 3)) == [5, 7]


def test_a_loop_is_broken_by_banning_its_ngram(model: CodeCraftLM) -> None:
    """An untrained model is a loop generator, which makes it the right subject.

    Greedy decoding with nothing to stop it produces the same token forever. The
    ban is what makes the output stop being one token repeated.
    """
    tokens = torch.randint(1, CONFIG.vocab_size, (1, 6))

    looping = list(model.generate(tokens, max_new_tokens=8, temperature=0.0))
    broken = list(
        model.generate(tokens, max_new_tokens=8, temperature=0.0, no_repeat_ngram=2)
    )

    assert len(set(looping)) == 1
    assert len(set(broken)) > 1


def test_the_prompt_is_exempt_from_the_ban(model: CodeCraftLM) -> None:
    """A completion that cannot reuse a phrase from the file is worse than a loop.

    Repeating the surrounding idiom is most of what an inline suggestion is for,
    so only what this call generated counts. The observable form of that: at the
    first step nothing has been generated, so the ban cannot forbid anything
    whatever the prompt contains.
    """
    # A prompt that repeats, which is where a ban over the prompt would bite.
    tokens = torch.tensor([[7, 9, 7, 9, 7, 9]])

    free = list(model.generate(tokens, max_new_tokens=1, temperature=0.0))
    banned = list(
        model.generate(tokens, max_new_tokens=1, temperature=0.0, no_repeat_ngram=2)
    )

    assert banned == free
