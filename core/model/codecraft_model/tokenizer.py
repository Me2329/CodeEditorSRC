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

import heapq
import json
import re
from collections import Counter, defaultdict
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

# Fill-in-the-middle markers, which is what lets the model complete code with
# text on both sides of the caret rather than only before it.
#
# These live at the END of the vocabulary, after the merges, rather than
# alongside the specials at the start. Inserting them at the start would shift
# BYTE_OFFSET and renumber every byte and merge, silently invalidating every
# tokenizer already trained and every token stream already encoded. Appending
# costs nothing and keeps a billion-token corpus readable.
TRAILING_SPECIALS: tuple[str, ...] = (
    "<|fim_prefix|>",
    "<|fim_suffix|>",
    "<|fim_middle|>",
    # Emitted when a suffix is empty, so the three-part shape is always present
    # and the model never has to infer which section it is in from absence.
    "<|fim_pad|>",
)


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
        return N_SPECIAL + 256 + len(self.merges) + len(TRAILING_SPECIALS)

    @property
    def first_trailing_id(self) -> int:
        """Where the appended specials start, just past the last merge."""
        return N_SPECIAL + 256 + len(self.merges)

    def special_id(self, name: str) -> int:
        if name in self.specials:
            return self.specials[name]
        if name in TRAILING_SPECIALS:
            return self.first_trailing_id + TRAILING_SPECIALS.index(name)
        raise KeyError(f"unknown special token {name!r}")

    @property
    def fim_prefix(self) -> int:
        return self.special_id("<|fim_prefix|>")

    @property
    def fim_suffix(self) -> int:
        return self.special_id("<|fim_suffix|>")

    @property
    def fim_middle(self) -> int:
        return self.special_id("<|fim_middle|>")

    # ------------------------------------------------------ fill in the middle

    def encode_infill(
        self, prefix: str, suffix: str, *, max_context: int | None = None
    ) -> list[int]:
        """Build a prompt asking the model to write what goes between two halves.

        The prefix-suffix-middle ordering is what makes this work with a causal
        model: both sides of the hole are in the context before the model is
        asked to produce anything, so it can condition on the code that follows
        the caret as well as the code before it.

        `max_context` trims from the outside in. The text nearest the caret is
        what the completion has to agree with, so the far ends are what goes.
        """
        prefix_ids = self.encode(prefix)
        suffix_ids = self.encode(suffix)

        if max_context is not None:
            # Three marker tokens, plus room to actually answer.
            budget = max(0, max_context - 3)
            half = budget // 2
            if len(prefix_ids) + len(suffix_ids) > budget:
                prefix_ids = prefix_ids[-max(half, budget - len(suffix_ids)) :]
                suffix_ids = suffix_ids[: max(0, budget - len(prefix_ids))]

        return [
            self.fim_prefix,
            *prefix_ids,
            self.fim_suffix,
            *suffix_ids,
            self.fim_middle,
        ]

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

        # Counting every pair afresh on every merge is what makes the naive
        # trainer unusable past a few megabytes: it is O(corpus) per merge, so
        # the work grows with the product of corpus size and vocabulary size.
        #
        # Instead the counts are kept incrementally. `where` maps a pair to the
        # words containing it, so a merge only has to revisit those words, and
        # each one contributes the difference between its pairs before and
        # after. The heap finds the most frequent pair without a scan; entries
        # go stale as counts change, and a stale entry is recognised on pop by
        # disagreeing with the live count, so it is discarded rather than
        # repaired. That is cheaper than keeping the heap exact.
        pair_counts: Counter[tuple[int, int]] = Counter()
        where: dict[tuple[int, int], set[int]] = defaultdict(set)
        for index, (symbols, frequency) in enumerate(zip(words, frequencies)):
            for pair in zip(symbols, symbols[1:]):
                pair_counts[pair] += frequency
            for pair in set(zip(symbols, symbols[1:])):
                where[pair].add(index)

        heap = [(-count, pair) for pair, count in pair_counts.items()]
        heapq.heapify(heap)

        merges: list[tuple[int, int]] = []
        next_id = BYTE_OFFSET + 256

        for step in range(target_merges):
            best: tuple[int, int] | None = None
            best_count = 0
            while heap:
                negative_count, candidate = heapq.heappop(heap)
                live = pair_counts.get(candidate, 0)
                if live != -negative_count:
                    continue
                if live < min_frequency:
                    # The heap is ordered, so nothing below this is worth it.
                    heap.clear()
                    break
                best, best_count = candidate, live
                break

            if best is None:
                break

            merges.append(best)

            for index in list(where[best]):
                symbols = words[index]
                frequency = frequencies[index]

                before = set(zip(symbols, symbols[1:]))
                for pair in zip(symbols, symbols[1:]):
                    pair_counts[pair] -= frequency
                    if pair_counts[pair] <= 0:
                        del pair_counts[pair]

                merged = _merge_pair(symbols, best, next_id)
                words[index] = merged

                after = set(zip(merged, merged[1:]))
                for pair in zip(merged, merged[1:]):
                    pair_counts[pair] += frequency

                for pair in before - after:
                    where[pair].discard(index)
                for pair in after - before:
                    where[pair].add(index)

                # Both directions have to be pushed. A pair whose count only
                # went down would otherwise be left in the heap at its old
                # value, be discarded as stale, and never be reconsidered.
                for pair in before | after:
                    if pair in pair_counts:
                        heapq.heappush(heap, (-pair_counts[pair], pair))

            where.pop(best, None)
            pair_counts.pop(best, None)
            next_id += 1

            if progress and (step + 1) % 500 == 0:
                print(
                    f"  merge {step + 1}/{target_merges}  "
                    f"pair seen {best_count} times",
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
        first_trailing = self.first_trailing_id
        for token in tokens:
            # Special tokens carry no text of their own, at either end of the
            # vocabulary.
            if token < BYTE_OFFSET or token >= first_trailing:
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
