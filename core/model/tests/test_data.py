"""Corpus collection, encoding, and batching."""

from __future__ import annotations

import json

import numpy as np
import pytest

from codecraft_model.data import (
    FILE_MARKER,
    MAX_FILE_BYTES,
    MIN_FILE_BYTES,
    TokenDataset,
    build_corpus,
    collect_sources,
    encode_corpus,
    iter_sources,
    sample_corpus,
    stream_dataset,
    write_dataset,
)
from codecraft_model.tokenizer import Tokenizer


@pytest.fixture
def tree(tmp_path):
    """A small source tree with the things collection has to skip."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("def main():\n" + "    pass\n" * 20)
    (tmp_path / "src" / "lib.rs").write_text("fn main() {\n" + "    let x = 1;\n" * 20 + "}\n")

    # Too small to teach anything.
    (tmp_path / "src" / "tiny.py").write_text("x=1\n")
    # Not a source extension.
    (tmp_path / "src" / "image.png").write_bytes(b"\x89PNG" + b"\x00" * 200)

    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "bundle.js").write_text("var a=1;\n" * 50)

    (tmp_path / "__pycache__").mkdir()
    (tmp_path / "__pycache__" / "cached.py").write_text("cached = True\n" * 20)

    return tmp_path


def test_collects_only_real_sources(tree) -> None:
    names = {path.rsplit("/", 1)[-1] for path, _ in collect_sources([tree])}
    assert names == {"main.py", "lib.rs"}


def test_skips_generated_directories(tree) -> None:
    paths = [path for path, _ in collect_sources([tree])]
    assert not any("node_modules" in path or "__pycache__" in path for path in paths)


def test_skips_files_outside_the_size_window(tmp_path) -> None:
    (tmp_path / "small.py").write_text("x" * (MIN_FILE_BYTES - 1))
    (tmp_path / "huge.py").write_text("x" * (MAX_FILE_BYTES + 1))
    assert collect_sources([tmp_path]) == []


def test_skips_files_that_are_not_utf8(tmp_path) -> None:
    (tmp_path / "binary.py").write_bytes(b"\xff\xfe" * 100)
    assert collect_sources([tmp_path]) == []


def test_missing_roots_are_not_an_error(tmp_path) -> None:
    assert collect_sources([tmp_path / "does-not-exist"]) == []


def test_limit_caps_the_number_of_files(tree) -> None:
    assert len(collect_sources([tree], limit=1)) == 1


def test_corpus_marks_file_boundaries(tree) -> None:
    corpus = build_corpus(collect_sources([tree]))
    assert corpus.count("<|file|>") == 2
    assert "main.py" in corpus


def test_encoding_a_corpus_is_the_same_as_encoding_it_whole() -> None:
    """Chunking must not change the tokens, or training sees different text."""
    corpus = "def f():\n    return 1\n" * 200
    tokenizer = Tokenizer.train(corpus, 320)

    chunked = encode_corpus(corpus, tokenizer, chunk_size=100)
    assert list(chunked) == tokenizer.encode(corpus)


def test_encoding_picks_a_dtype_that_fits_the_vocabulary() -> None:
    tokenizer = Tokenizer.train("abc def abc def " * 100, 300)
    assert encode_corpus("abc def", tokenizer).dtype == np.uint16


def test_empty_corpus_encodes_to_nothing() -> None:
    tokenizer = Tokenizer([])
    assert len(encode_corpus("", tokenizer)) == 0


def test_dataset_is_split_and_written(tmp_path) -> None:
    tokens = np.arange(1000, dtype=np.uint16)
    metadata = write_dataset(tokens, tmp_path, validation_fraction=0.1)

    assert metadata["train_tokens"] == 900
    assert metadata["val_tokens"] == 100
    assert metadata["total_tokens"] == 1000
    assert json.loads((tmp_path / "meta.json").read_text())["dtype"] == "uint16"
    assert (tmp_path / "train.bin").exists() and (tmp_path / "val.bin").exists()


def test_batches_have_the_requested_shape(tmp_path) -> None:
    write_dataset(np.arange(1000, dtype=np.uint16), tmp_path)
    dataset = TokenDataset(tmp_path / "train.bin")

    inputs, targets = dataset.batch(4, 16, np.random.default_rng(0))
    assert inputs.shape == targets.shape == (4, 16)


def test_targets_are_the_inputs_shifted_by_one(tmp_path) -> None:
    """The training signal is next-token prediction at every position."""
    write_dataset(np.arange(1000, dtype=np.uint16), tmp_path)
    dataset = TokenDataset(tmp_path / "train.bin")

    inputs, targets = dataset.batch(2, 8, np.random.default_rng(0))
    assert (targets[:, :-1] == inputs[:, 1:]).all()


def test_batch_indices_are_long(tmp_path) -> None:
    """Embedding lookups reject anything narrower."""
    import torch

    write_dataset(np.arange(1000, dtype=np.uint16), tmp_path)
    inputs, _ = TokenDataset(tmp_path / "train.bin").batch(2, 8, np.random.default_rng(0))
    assert inputs.dtype == torch.int64


def test_a_dataset_too_short_for_the_block_says_so(tmp_path) -> None:
    write_dataset(np.arange(20, dtype=np.uint16), tmp_path)
    with pytest.raises(ValueError, match="too few"):
        TokenDataset(tmp_path / "train.bin").batch(2, 64, np.random.default_rng(0))


# ------------------------------------------------------------------ streaming


def test_iteration_yields_the_same_files_as_collection(tree) -> None:
    assert list(iter_sources([tree])) == collect_sources([tree])


def test_iteration_does_not_read_the_whole_tree_first(tree) -> None:
    """A generator, so a corpus larger than memory can be streamed."""
    stream = iter_sources([tree])
    first = next(stream)
    assert isinstance(first, tuple) and len(first) == 2


def test_allowed_directories_are_no_longer_skipped(tree) -> None:
    """`node_modules` is noise inside a project and the point of the exercise
    when the goal is a large corpus of library code."""
    default = {path for path, _ in collect_sources([tree])}
    widened = {path for path, _ in collect_sources([tree], allow=frozenset({"node_modules"}))}

    assert not any("node_modules" in path for path in default)
    assert any("node_modules" in path for path in widened)
    assert default < widened


def test_allowing_one_directory_does_not_allow_the_others(tree) -> None:
    paths = {p for p, _ in collect_sources([tree], allow=frozenset({"node_modules"}))}
    assert not any("__pycache__" in path for path in paths)


def test_the_tokenizer_sample_is_capped(tree) -> None:
    """Training a vocabulary on a whole large corpus is wasted work."""
    assert len(sample_corpus([tree], max_bytes=500)) < 2000


def test_the_sample_carries_file_markers(tree) -> None:
    assert FILE_MARKER in sample_corpus([tree], max_bytes=100_000)


def test_a_stride_spreads_the_sample_across_the_tree(tree) -> None:
    """Taking the first n files would sample whichever directory sorts first."""
    every = sample_corpus([tree], max_bytes=10_000_000, stride=1)
    every_other = sample_corpus([tree], max_bytes=10_000_000, stride=2)
    assert len(every_other) < len(every)


def test_streaming_a_dataset_writes_the_same_files_as_the_batch_path(tree) -> None:
    tokenizer = Tokenizer.train(build_corpus(collect_sources([tree])), 320)
    directory = tree / "run"

    metadata = stream_dataset(iter_sources([tree]), tokenizer, directory)

    assert (directory / "train.bin").exists() and (directory / "val.bin").exists()
    assert metadata["train_tokens"] + metadata["val_tokens"] == metadata["total_tokens"]
    assert metadata["files"] == 2
    assert metadata["characters_per_token"] > 1


def test_streaming_leaves_no_intermediate_file_behind(tree) -> None:
    """The combined stream exists only until the split point is known."""
    tokenizer = Tokenizer.train(build_corpus(collect_sources([tree])), 320)
    directory = tree / "run"
    stream_dataset(iter_sources([tree]), tokenizer, directory)

    assert not (directory / "tokens.bin").exists()


def test_streamed_tokens_are_readable_as_a_dataset(tree) -> None:
    tokenizer = Tokenizer.train(build_corpus(collect_sources([tree])), 320)
    directory = tree / "run"
    metadata = stream_dataset(iter_sources([tree]), tokenizer, directory)

    dataset = TokenDataset(directory / "train.bin", metadata["dtype"])
    assert len(dataset) == metadata["train_tokens"]
    assert max(dataset.tokens[:1000]) < tokenizer.vocab_size


def test_streaming_an_empty_tree_says_so(tmp_path) -> None:
    tokenizer = Tokenizer([])
    with pytest.raises(ValueError, match="no source files"):
        stream_dataset(iter_sources([tmp_path / "nothing"]), tokenizer, tmp_path / "run")


def test_a_token_budget_stops_the_stream(tree) -> None:
    """So a corpus can target a size rather than consume everything offered."""
    tokenizer = Tokenizer.train(build_corpus(collect_sources([tree])), 320)

    unbounded = stream_dataset(iter_sources([tree]), tokenizer, tree / "all")
    bounded = stream_dataset(
        iter_sources([tree]), tokenizer, tree / "capped", max_tokens=50
    )

    assert bounded["total_tokens"] < unbounded["total_tokens"]


def test_the_metadata_records_what_it_costs_on_disk(tree) -> None:
    tokenizer = Tokenizer.train(build_corpus(collect_sources([tree])), 320)
    metadata = stream_dataset(iter_sources([tree]), tokenizer, tree / "run")

    # uint16 for any vocabulary that fits in 16 bits.
    assert metadata["bytes_on_disk"] == metadata["total_tokens"] * 2
