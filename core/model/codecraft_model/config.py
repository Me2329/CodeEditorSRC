"""Model configuration and exact parameter accounting.

A decoder-only transformer with RMSNorm, rotary position embeddings, grouped
query attention and a SwiGLU feed-forward block. Sizes are named presets, and
the parameter count for each is computed from the architecture rather than
guessed, so `codecraft-model sizes` reports what the model will actually
allocate.
"""

from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True)
class ModelConfig:
    """Everything that determines the shape of the network."""

    vocab_size: int = 16384
    # Width of the residual stream.
    d_model: int = 512
    n_layers: int = 8
    n_heads: int = 8
    # Grouped query attention: fewer key/value heads than query heads shrinks
    # the KV cache, which is what dominates memory during generation. Must
    # divide n_heads.
    n_kv_heads: int = 4
    # Hidden width of the SwiGLU block. Two of the three matrices project up to
    # this size, so it drives most of the parameter count.
    d_ff: int = 1408
    max_seq_len: int = 512
    dropout: float = 0.0
    rope_theta: float = 10_000.0
    rms_norm_eps: float = 1e-5
    # Share one matrix between the token embedding and the output projection.
    # Saves vocab_size * d_model parameters and usually helps small models.
    tie_embeddings: bool = True

    def __post_init__(self) -> None:
        if self.d_model % self.n_heads != 0:
            raise ValueError(
                f"d_model ({self.d_model}) must divide evenly into n_heads ({self.n_heads})"
            )
        if self.n_heads % self.n_kv_heads != 0:
            raise ValueError(
                f"n_heads ({self.n_heads}) must be a multiple of "
                f"n_kv_heads ({self.n_kv_heads})"
            )
        if self.n_kv_heads > self.n_heads:
            raise ValueError("n_kv_heads cannot exceed n_heads")
        for name in ("vocab_size", "d_model", "n_layers", "n_heads", "d_ff", "max_seq_len"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")

    @property
    def head_dim(self) -> int:
        return self.d_model // self.n_heads

    @property
    def n_kv_groups(self) -> int:
        """How many query heads share each key/value head."""
        return self.n_heads // self.n_kv_heads

    # ---------------------------------------------------------------- counting

    def parameter_count(self) -> int:
        """Exact number of parameters this configuration allocates.

        Derived from the architecture, and checked against a real module in the
        tests so the two can never drift apart.
        """
        d = self.d_model
        kv_dim = self.n_kv_heads * self.head_dim

        embedding = self.vocab_size * d
        # Query and output projections are square; key and value shrink with GQA.
        attention = (d * d) + (d * kv_dim) + (d * kv_dim) + (d * d)
        # SwiGLU uses three matrices: gate and up project out, down projects back.
        feed_forward = (d * self.d_ff) * 2 + (self.d_ff * d)
        # One RMSNorm before attention, one before the feed-forward block.
        norms = 2 * d

        per_layer = attention + feed_forward + norms
        total = embedding + self.n_layers * per_layer + d  # final norm

        if not self.tie_embeddings:
            total += self.vocab_size * d
        return total

    def parameter_breakdown(self) -> dict[str, int]:
        """Where the parameters go, for the size report."""
        d = self.d_model
        kv_dim = self.n_kv_heads * self.head_dim

        attention = ((d * d) + (d * kv_dim) * 2 + (d * d)) * self.n_layers
        feed_forward = ((d * self.d_ff) * 2 + (self.d_ff * d)) * self.n_layers
        norms = (2 * d) * self.n_layers + d
        embedding = self.vocab_size * d
        head = 0 if self.tie_embeddings else self.vocab_size * d

        return {
            "embedding": embedding,
            "attention": attention,
            "feed_forward": feed_forward,
            "norms": norms,
            "output_head": head,
        }

    def memory_estimate_bytes(self, bytes_per_parameter: int = 4) -> dict[str, int]:
        """Rough memory needed to train and to run this configuration.

        Training holds the weights, their gradients and two Adam moments, so it
        needs about four times what inference does, before activations.
        """
        weights = self.parameter_count() * bytes_per_parameter
        return {
            "weights": weights,
            "inference": weights,
            "training": weights * 4,
        }

    def with_vocab(self, vocab_size: int) -> "ModelConfig":
        """A copy sized for a tokenizer that was actually trained."""
        return replace(self, vocab_size=vocab_size)

    def to_dict(self) -> dict:
        return {
            "vocab_size": self.vocab_size,
            "d_model": self.d_model,
            "n_layers": self.n_layers,
            "n_heads": self.n_heads,
            "n_kv_heads": self.n_kv_heads,
            "d_ff": self.d_ff,
            "max_seq_len": self.max_seq_len,
            "dropout": self.dropout,
            "rope_theta": self.rope_theta,
            "rms_norm_eps": self.rms_norm_eps,
            "tie_embeddings": self.tie_embeddings,
        }

    @classmethod
    def from_dict(cls, payload: dict) -> "ModelConfig":
        known = {field for field in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in payload.items() if k in known})


# ---------------------------------------------------------------------------
# Named sizes
#
# d_ff is roughly 8/3 * d_model rounded to a multiple of 64, the usual choice
# for SwiGLU: it uses three matrices instead of two, so the hidden width is
# reduced to keep the parameter count comparable to a 4x GELU block.
# ---------------------------------------------------------------------------

SIZES: dict[str, ModelConfig] = {
    # Trains to something coherent on a laptop in minutes. Useful for proving
    # the pipeline end to end.
    "micro": ModelConfig(
        vocab_size=4096, d_model=128, n_layers=4, n_heads=4, n_kv_heads=2,
        d_ff=384, max_seq_len=256,
    ),
    "tiny": ModelConfig(
        vocab_size=8192, d_model=256, n_layers=6, n_heads=8, n_kv_heads=4,
        d_ff=704, max_seq_len=512,
    ),
    "small": ModelConfig(
        vocab_size=16384, d_model=512, n_layers=8, n_heads=8, n_kv_heads=4,
        d_ff=1408, max_seq_len=1024,
    ),
    "base": ModelConfig(
        vocab_size=32768, d_model=768, n_layers=12, n_heads=12, n_kv_heads=4,
        d_ff=2048, max_seq_len=2048,
    ),
    "large": ModelConfig(
        vocab_size=32768, d_model=1536, n_layers=24, n_heads=16, n_kv_heads=8,
        d_ff=4096, max_seq_len=4096,
    ),
    # About one billion parameters. Instantiable anywhere with enough memory;
    # training it is a cluster-scale job, not a laptop one.
    "xl": ModelConfig(
        vocab_size=32768, d_model=2048, n_layers=20, n_heads=16, n_kv_heads=8,
        d_ff=5632, max_seq_len=4096,
    ),
}


def get_size(name: str) -> ModelConfig:
    if name not in SIZES:
        available = ", ".join(SIZES)
        raise KeyError(f"unknown size '{name}'. Available: {available}")
    return SIZES[name]


def humanise(count: int) -> str:
    """Format a parameter count the way model cards do."""
    if count >= 1_000_000_000:
        return f"{count / 1_000_000_000:.2f}B"
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}M"
    if count >= 1_000:
        return f"{count / 1_000:.1f}K"
    return str(count)
