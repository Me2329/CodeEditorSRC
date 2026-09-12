"""Byte-level BPE: every input must survive a round trip exactly."""

from __future__ import annotations

import pytest

from codecraft_model.tokenizer import (
    BYTE_OFFSET,
    N_SPECIAL,
    PRETOKEN_PATTERN,
    TRAILING_SPECIALS,
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
    assert plain.vocab_size == N_SPECIAL + 256 + len(TRAILING_SPECIALS)
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


def test_vocab_size_accounts_for_specials_bytes_and_merges(tokenizer: Tokenizer) -> None:
    assert tokenizer.vocab_size == (
        N_SPECIAL + 256 + len(tokenizer.merges) + len(TRAILING_SPECIALS)
    )


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


# ------------------------------------------------------- fill in the middle


def test_fim_markers_sit_past_the_merges(tokenizer: Tokenizer) -> None:
    """Appended rather than inserted, so existing token streams stay valid.

    Putting them beside the other specials would shift BYTE_OFFSET and renumber
    every byte and merge, invalidating a corpus that took half an hour to build.
    """
    assert tokenizer.fim_prefix == tokenizer.first_trailing_id
    assert tokenizer.fim_middle > max(tokenizer.vocab)
    assert tokenizer.fim_middle < tokenizer.vocab_size


def test_the_byte_offset_is_unchanged_by_the_new_tokens() -> None:
    """The property that keeps already-encoded corpora readable."""
    assert BYTE_OFFSET == N_SPECIAL == 6


def test_an_infill_prompt_has_all_three_sections(tokenizer: Tokenizer) -> None:
    ids = tokenizer.encode_infill("def f():\n    ", "\n    return result\n")

    assert ids[0] == tokenizer.fim_prefix
    assert tokenizer.fim_suffix in ids
    # The middle marker comes last: everything after it is what the model writes.
    assert ids[-1] == tokenizer.fim_middle


def test_infill_keeps_both_halves_in_order(tokenizer: Tokenizer) -> None:
    ids = tokenizer.encode_infill("BEFORE", "AFTER")
    separator = ids.index(tokenizer.fim_suffix)

    assert tokenizer.decode(ids[:separator]) == "BEFORE"
    assert tokenizer.decode(ids[separator:]) == "AFTER"


def test_an_empty_suffix_still_produces_the_three_part_shape(tokenizer: Tokenizer) -> None:
    """So the model never has to infer its section from a missing marker."""
    ids = tokenizer.encode_infill("def f(", "")

    assert ids[0] == tokenizer.fim_prefix
    assert ids[-1] == tokenizer.fim_middle
    assert tokenizer.fim_suffix in ids


def test_infill_trims_to_the_context_budget(tokenizer: Tokenizer) -> None:
    """The text nearest the caret is what the completion has to agree with."""
    ids = tokenizer.encode_infill("x" * 4000, "y" * 4000, max_context=64)
    assert len(ids) <= 64


def test_trimming_keeps_the_text_closest_to_the_caret(tokenizer: Tokenizer) -> None:
    prefix = "START" + ("filler " * 400) + "NEAREST"
    ids = tokenizer.encode_infill(prefix, "", max_context=48)
    kept = tokenizer.decode(ids)

    assert "NEAREST" in kept
    assert "START" not in kept


def test_typing_does_not_shift_a_trimmed_prompt(tokenizer: Tokenizer) -> None:
    """The property the prefix cache depends on entirely.

    Keeping exactly the last N tokens moves the window one token per character
    typed, so every key press shifts the whole prompt and a prefill cached a
    moment ago matches nothing. That would make the cache useless on exactly the
    files where it matters: the ones bigger than the context.
    """
    body = "def parse(text):\n    " + ("value = compute(text)\n    " * 200)
    first = tokenizer.encode_infill(body, "\n    return value\n", max_context=256)

    for typed in ("r", "re", "ret", "retu"):
        later = tokenizer.encode_infill(body + typed, "\n    return value\n", max_context=256)
        shared = 0
        while shared < min(len(first), len(later)) and first[shared] == later[shared]:
            shared += 1
        # Almost all of it, rather than the single marker token that survives
        # an unquantised window.
        assert shared > len(first) // 2


def test_a_sliding_window_loses_everything(tokenizer: Tokenizer) -> None:
    """The negative control: without the stride, the shared prefix collapses."""
    body = "def parse(text):\n    " + ("value = compute(text)\n    " * 200)
    first = tokenizer.encode_infill(body, "", max_context=256, stride=1)
    later = tokenizer.encode_infill(body + "xyz", "", max_context=256, stride=1)

    shared = 0
    while shared < min(len(first), len(later)) and first[shared] == later[shared]:
        shared += 1
    assert shared < 10


def test_holding_the_window_still_stays_within_the_budget(tokenizer: Tokenizer) -> None:
    """Rounded up, never down: down would buy context by exceeding the budget."""
    body = "filler " * 500
    for typed in range(40):
        ids = tokenizer.encode_infill(body + "x" * typed, "tail " * 20, max_context=128)
        assert len(ids) <= 128


def test_a_prompt_that_fits_is_not_trimmed_at_all(tokenizer: Tokenizer) -> None:
    """The stride costs nothing when there is nothing to trim."""
    short = tokenizer.encode_infill("def f():\n    ", "\n", max_context=4096)
    unbounded = tokenizer.encode_infill("def f():\n    ", "\n")

    assert short == unbounded


def test_the_markers_decode_to_nothing(tokenizer: Tokenizer) -> None:
    """They are structure, not text, so they must not appear in the output."""
    ids = tokenizer.encode_infill("a", "b")
    assert tokenizer.decode(ids) == "ab"


def test_an_unknown_special_name_is_refused(tokenizer: Tokenizer) -> None:
    with pytest.raises(KeyError):
        tokenizer.special_id("<|not_a_token|>")
