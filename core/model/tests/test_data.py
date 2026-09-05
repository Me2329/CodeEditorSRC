"""Corpus collection, encoding, and batching."""

from __future__ import annotations

import json

import numpy as np
import pytest

from codecraft_model.data import (
    MAX_FILE_BYTES,
    MIN_FILE_BYTES,
    TokenDataset,
    build_corpus,
    collect_sources,
    encode_corpus,
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
