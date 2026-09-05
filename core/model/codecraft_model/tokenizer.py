"""Byte-level byte-pair encoding, trained from scratch on our own corpus.

Byte level means every possible input encodes: there is no unknown token and no
normalisation step to lose information. That matters more for code than for
prose, because source files carry tabs, box-drawing characters, emoji in
strings, and mixed line endings that a word-level vocabulary would mangle.

Training follows the usual approach: split the corpus into pre-tokens with a
regular expression, count how often each distinct pre-token appears, then
repeatedly merge the most frequent adjacent pair. Working over the set of
distinct pre-tokens weighted by frequency, rather than over the raw byte
stream, is what makes training tractable in pure Python.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

# Pre-tokenisation pattern.
#
# Splits contractions, words, numbers and punctuation runs, and keeps a leading
# space attached to the token that follows it. Digits are split into runs of at
# most three so that numeric literals do not each become their own token.
#
# The alternatives must between them match every character: anything the pattern
# skips is deleted from the corpus, and the model would be trained on text with
# holes in it. The word class is `[^\W\d]`, letters and underscore, rather than
# letters alone, so that `__init__` and `1_000_000` survive intact. A test
# asserts the reconstruction property directly.
PRETOKEN_PATTERN = re.compile(
    r"""'(?:[sdmt]|ll|ve|re)|"""      # common English contractions
    r""" ?[^\W\d]+|"""                 # letters and underscores, with any leading space
    r""" ?\d{1,3}|"""                  # short digit runs
    r""" ?[^\s\w]+|"""                 # punctuation and symbols
    r"""\s+(?!\S)|"""                  # a whitespace run that is not followed by text
    r"""\s+""",                        # any other whitespace run
    re.UNICODE,
)

# Reserved ids, before any byte or merge token.
SPECIAL_TOKENS: dict[str, int] = {
    "<|pad|>": 0,
    "<|begin|>": 1,
    "<|end|>": 2,
    # Marks the boundary between a prompt and the model's reply.
    "<|user|>": 3,
    "<|assistant|>": 4,
    # Emitted between files when a corpus is packed into one stream.
    "<|file|>": 5,
}
N_SPECIAL = len(SPECIAL_TOKENS)
BYTE_OFFSET = N_SPECIAL  # the 256 byte tokens follow the specials


class Tokenizer:
    """A trained byte-level BPE tokenizer."""

    def __init__(
        self,
        merges: list[tuple[int, int]],
        specials: dict[str, int] | None = None,
    ) -> None:
        self.specials = dict(specials or SPECIAL_TOKENS)
        self.merges = merges

        # Rank of each merge, lowest first. Encoding always applies the
        # earliest-learned merge available, which is what makes encoding
        # deterministic and match training.
        self.merge_ranks: dict[tuple[int, int], int] = {
            pair: index for index, pair in enumerate(merges)
        }
        # id -> the bytes it expands to, used for decoding.
        self.vocab: dict[int, bytes] = {}
        for index in range(256):
            self.vocab[BYTE_OFFSET + index] = bytes([index])
        for index, (left, right) in enumerate(merges):
            self.vocab[BYTE_OFFSET + 256 + index] = self.vocab[left] + self.vocab[right]

        self._cache: dict[str, list[int]] = {}

    # ------------------------------------------------------------------ sizes

    @property
    def vocab_size(self) -> int:
        return N_SPECIAL + 256 + len(self.merges)

    def special_id(self, name: str) -> int:
        return self.specials[name]

    # --------------------------------------------------------------- training

    @classmethod
    def train(
        cls,
        corpus: str,
        vocab_size: int,
        *,
        min_frequency: int = 2,
        progress: bool = False,
    ) -> "Tokenizer":
        """Learn merges from `corpus` until the vocabulary reaches `vocab_size`."""
        target_merges = vocab_size - N_SPECIAL - 256
        if target_merges < 0:
            raise ValueError(
                f"vocab_size must be at least {N_SPECIAL + 256} to hold the "
                "special tokens and every byte"
            )

        # Distinct pre-tokens and how often each occurs. Merges are counted
        # against these frequencies rather than the raw text, which is the
        # difference between seconds and hours.
        counts: Counter[str] = Counter(PRETOKEN_PATTERN.findall(corpus))

        # Each distinct pre-token starts as its sequence of byte tokens.
        words: list[list[int]] = []
        frequencies: list[int] = []
        for word, frequency in counts.items():
            if frequency < min_frequency and len(counts) > target_merges * 4:
                continue
            words.append([BYTE_OFFSET + b for b in word.encode("utf-8")])
            frequencies.append(frequency)

        merges: list[tuple[int, int]] = []
        next_id = BYTE_OFFSET + 256

        for step in range(target_merges):
            pair_counts: Counter[tuple[int, int]] = Counter()
            for symbols, frequency in zip(words, frequencies):
                for left, right in zip(symbols, symbols[1:]):
                    pair_counts[(left, right)] += frequency

            if not pair_counts:
                break
            best, best_count = pair_counts.most_common(1)[0]
            if best_count < min_frequency:
                break

            merges.append(best)
            words = [_merge_pair(symbols, best, next_id) for symbols in words]
            next_id += 1

            if progress and (step + 1) % 200 == 0:
                print(
                    f"  merge {step + 1}/{target_merges}  "
                    f"pair {best} seen {best_count} times",
                    flush=True,
                )

        return cls(merges)

    # --------------------------------------------------------------- encoding

    def encode(self, text: str, *, add_begin: bool = False, add_end: bool = False) -> list[int]:
        tokens: list[int] = []
        if add_begin:
            tokens.append(self.specials["<|begin|>"])

        for pretoken in PRETOKEN_PATTERN.findall(text):
            cached = self._cache.get(pretoken)
            if cached is None:
                cached = self._encode_pretoken(pretoken)
                # Source code repeats the same identifiers constantly, so the
                # cache pays for itself immediately.
                if len(self._cache) < 100_000:
                    self._cache[pretoken] = cached
            tokens.extend(cached)

        if add_end:
            tokens.append(self.specials["<|end|>"])
        return tokens

    def _encode_pretoken(self, pretoken: str) -> list[int]:
        symbols = [BYTE_OFFSET + b for b in pretoken.encode("utf-8")]
        if len(symbols) < 2:
            return symbols

        while True:
            # Apply the earliest-learned merge present anywhere in the word.
            best_rank = None
            best_index = -1
            for index, pair in enumerate(zip(symbols, symbols[1:])):
                rank = self.merge_ranks.get(pair)
                if rank is not None and (best_rank is None or rank < best_rank):
                    best_rank = rank
                    best_index = index
            if best_rank is None:
                break
            symbols[best_index : best_index + 2] = [BYTE_OFFSET + 256 + best_rank]
        return symbols

    def decode(self, tokens: list[int]) -> str:
        pieces: list[bytes] = []
        for token in tokens:
            # Special tokens carry no text of their own.
            if token < BYTE_OFFSET:
                continue
            piece = self.vocab.get(token)
            if piece is not None:
                pieces.append(piece)
        # Generation can stop mid-character, so a partial sequence is replaced
        # rather than raising.
        return b"".join(pieces).decode("utf-8", errors="replace")

    # ------------------------------------------------------------ persistence

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "specials": self.specials,
                    "merges": [[left, right] for left, right in self.merges],
                },
                indent=None,
            ),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, path: str | Path) -> "Tokenizer":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        merges = [(left, right) for left, right in payload["merges"]]
        return cls(merges, payload.get("specials"))


def _merge_pair(symbols: list[int], pair: tuple[int, int], new_id: int) -> list[int]:
    """Replace every occurrence of `pair` in `symbols` with `new_id`."""
    if len(symbols) < 2:
        return symbols

    merged: list[int] = []
    index = 0
    left, right = pair
    while index < len(symbols):
        if (
            index < len(symbols) - 1
            and symbols[index] == left
            and symbols[index + 1] == right
        ):
            merged.append(new_id)
            index += 2
        else:
            merged.append(symbols[index])
            index += 1
    return merged
