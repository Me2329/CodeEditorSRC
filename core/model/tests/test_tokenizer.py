"""Byte-level BPE: every input must survive a round trip exactly."""

from __future__ import annotations

import pytest

from codecraft_model.tokenizer import (
    BYTE_OFFSET,
    N_SPECIAL,
    PRETOKEN_PATTERN,
    Tokenizer,
    _merge_pair,
)

CORPUS = (
    "def parse(text):\n"
    "    result = []\n"
    "    for line in text.splitlines():\n"
    "        result.append(line.strip())\n"
    "    return result\n"
) * 40


@pytest.fixture(scope="module")
def tokenizer() -> Tokenizer:
    return Tokenizer.train(CORPUS, 400)


def test_untrained_tokenizer_still_covers_every_byte() -> None:
    """With no merges at all, the byte vocabulary alone must round trip."""
    plain = Tokenizer([])
    assert plain.vocab_size == N_SPECIAL + 256
    text = "raw ☃ bytes\t\r\n"
    assert plain.decode(plain.encode(text)) == text


def test_round_trips_source_code(tokenizer: Tokenizer) -> None:
    text = "def f(x):\n    return x * 2\n"
    assert tokenizer.decode(tokenizer.encode(text)) == text


@pytest.mark.parametrize(
    "text",
    [
        "",
        " ",
        "\t\t\tindented",
        "emoji 🚀 in a string",
        "mixed\r\nline\nendings\r\n",
        "日本語のコメント",
        "0x1F +  3.14159 - 1_000_000",
        "«»‹›„“”—–…",
        "a" * 500,
    ],
)
def test_round_trips_awkward_input(tokenizer: Tokenizer, text: str) -> None:
    """Byte level means there is no input it cannot represent."""
    assert tokenizer.decode(tokenizer.encode(text)) == text


def test_merges_actually_compress(tokenizer: Tokenizer) -> None:
    text = "def parse(text):\n    result = []\n"
    assert len(tokenizer.encode(text)) < len(text.encode("utf-8"))


def test_more_merges_compress_further() -> None:
    small = Tokenizer.train(CORPUS, 300)
    large = Tokenizer.train(CORPUS, 600)
    text = "    result.append(line.strip())\n"
    assert len(large.encode(text)) <= len(small.encode(text))


def test_vocab_size_accounts_for_specials_and_bytes(tokenizer: Tokenizer) -> None:
    assert tokenizer.vocab_size == N_SPECIAL + 256 + len(tokenizer.merges)


def test_every_id_is_inside_the_vocabulary(tokenizer: Tokenizer) -> None:
    ids = tokenizer.encode(CORPUS)
    assert ids and max(ids) < tokenizer.vocab_size
    assert min(ids) >= BYTE_OFFSET


def test_special_tokens_can_be_added(tokenizer: Tokenizer) -> None:
    ids = tokenizer.encode("hello", add_begin=True, add_end=True)
    assert ids[0] == tokenizer.special_id("<|begin|>")
    assert ids[-1] == tokenizer.special_id("<|end|>")
    # They carry no text, so they vanish on decode.
    assert tokenizer.decode(ids) == "hello"


def test_encoding_is_deterministic(tokenizer: Tokenizer) -> None:
    """The cache must not change what encoding produces."""
    first = tokenizer.encode("    return result\n")
    second = tokenizer.encode("    return result\n")
    assert first == second


def test_vocabulary_smaller_than_the_byte_table_is_refused() -> None:
    with pytest.raises(ValueError, match="at least"):
        Tokenizer.train(CORPUS, 100)


def test_partial_character_decodes_to_a_replacement(tokenizer: Tokenizer) -> None:
    """Generation can stop mid-character; that must not raise."""
    ids = tokenizer.encode("é")
    assert tokenizer.decode(ids[:1]) == "�"


def test_save_and_load_preserve_encoding(tokenizer: Tokenizer, tmp_path) -> None:
    path = tmp_path / "tokenizer.json"
    tokenizer.save(path)
    reloaded = Tokenizer.load(path)

    assert reloaded.vocab_size == tokenizer.vocab_size
    assert reloaded.encode(CORPUS[:400]) == tokenizer.encode(CORPUS[:400])


@pytest.mark.parametrize(
    "text",
    [
        "__init__",
        "1_000_000",
        "self._private_field = None",
        "def f(x):\n    return x_1\n",
        "0x1F +  3.14159 - 1_000_000",
        "日本語 🚀\t\r\n",
        "a\u00a0b",
    ],
)
def test_pretokeniser_covers_every_character(text: str) -> None:
    """Anything the pattern skips is silently deleted from the corpus.

    An earlier version excluded underscores from the word class and matched them
    nowhere else, so every `__init__` in the training data lost its underscores.
    """
    assert "".join(PRETOKEN_PATTERN.findall(text)) == text


def test_pretokeniser_groups_indentation() -> None:
    """Indentation is one piece, not one piece per space.

    The last space joins the word that follows it, which is what makes " return"
    a single token wherever it appears.
    """
    pieces = PRETOKEN_PATTERN.findall("    return x\n")
    assert pieces[0] == "   " and pieces[1] == " return"


def test_pretokeniser_splits_long_digit_runs() -> None:
    """Whole numeric literals as single tokens would waste the vocabulary."""
    pieces = PRETOKEN_PATTERN.findall("1234567")
    assert all(len(piece.strip()) <= 3 for piece in pieces)


def test_merge_pair_replaces_every_occurrence() -> None:
    assert _merge_pair([1, 2, 1, 2, 3], (1, 2), 99) == [99, 99, 3]


def test_merge_pair_does_not_overlap() -> None:
    """Merging (1,1) in [1,1,1] must consume a pair, not reuse a symbol."""
    assert _merge_pair([1, 1, 1], (1, 1), 99) == [99, 1]
