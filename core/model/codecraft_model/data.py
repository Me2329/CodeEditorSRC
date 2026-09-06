"""Corpus building and batching.

Source files are concatenated into one token stream with a separator between
files, then written to disk as a flat array of unsigned integers. Training reads
it back with a memory map, so the dataset never has to fit in RAM and a batch is
a slice rather than a parse.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import numpy as np

from .tokenizer import Tokenizer

# Extensions worth learning from. Lock files, minified bundles and generated
# output would teach the model to predict noise.
SOURCE_EXTENSIONS = {
    ".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".c", ".h", ".cpp", ".hpp",
    ".go", ".java", ".rb", ".php", ".sh", ".bash", ".lua", ".sql", ".toml",
    ".yaml", ".yml", ".json", ".md", ".css", ".html",
}

SKIP_DIRECTORIES = {
    ".git", "node_modules", "target", "dist", "build", "__pycache__",
    ".venv", "venv", ".mypy_cache", ".pytest_cache", "site-packages",
}

# Files outside this range are either trivial or generated.
MIN_FILE_BYTES = 64
MAX_FILE_BYTES = 400_000

# Written between files so the model learns where one ends, rather than running
# a file's tail into the next file's imports.
FILE_MARKER = "<|file|>"


def iter_sources(
    roots: list[Path],
    *,
    limit: int | None = None,
    allow: frozenset[str] = frozenset(),
) -> Iterator[tuple[str, str]]:
    """Yield (path, text) for every source file under `roots`, one at a time.

    A generator rather than a list, so a corpus larger than memory can be built
    by streaming through it. `allow` names directories that would otherwise be
    skipped: `site-packages` and `node_modules` are noise inside a project and
    the point of the exercise when the goal is a large corpus of library code.
    """
    skip = SKIP_DIRECTORIES - allow
    produced = 0

    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*")):
            if limit is not None and produced >= limit:
                return
            if not path.is_file() or path.suffix not in SOURCE_EXTENSIONS:
                continue
            if any(part in skip for part in path.parts):
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if not (MIN_FILE_BYTES <= size <= MAX_FILE_BYTES):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                # Binary or unreadable; nothing to learn from it.
                continue
            produced += 1
            yield str(path), text


def collect_sources(
    roots: list[Path],
    *,
    limit: int | None = None,
    allow: frozenset[str] = frozenset(),
) -> list[tuple[str, str]]:
    """Gather every source file under `roots` into memory.

    Fine for a project-sized tree. Use `iter_sources` for anything larger.
    """
    return list(iter_sources(roots, limit=limit, allow=allow))


def sample_corpus(
    roots: list[Path],
    *,
    max_bytes: int = 32_000_000,
    allow: frozenset[str] = frozenset(),
    stride: int = 1,
) -> str:
    """Text for training the tokenizer, capped so it stays affordable.

    A vocabulary learned from a representative sample is essentially the one
    learned from the whole corpus: the merges that matter are the frequent ones,
    and those show up early. `stride` takes every nth file instead of the first
    n, so the sample spans the tree rather than whichever directory sorts first.
    """
    pieces: list[str] = []
    total = 0

    for index, (path, text) in enumerate(iter_sources(roots, allow=allow)):
        if index % stride:
            continue
        pieces.append(f"{FILE_MARKER}{Path(path).name}\n{text}")
        total += len(text)
        if total >= max_bytes:
            break

    return "\n".join(pieces)


def build_corpus(sources: list[tuple[str, str]]) -> str:
    """Join files into one stream, with a marker between them.

    The marker teaches the model where a file ends, which is what stops it
    running one file's tail into the next file's imports.
    """
    parts: list[str] = []
    for path, text in sources:
        name = Path(path).name
        parts.append(f"{FILE_MARKER}{name}\n{text}")
    return "\n".join(parts)


def encode_corpus(
    corpus: str,
    tokenizer: Tokenizer,
    *,
    chunk_size: int = 500_000,
    progress: bool = False,
) -> np.ndarray:
    """Tokenize a large corpus in chunks, at a character boundary each time."""
    dtype = np.uint16 if tokenizer.vocab_size <= 65_536 else np.uint32
    pieces: list[np.ndarray] = []

    position = 0
    while position < len(corpus):
        end = min(position + chunk_size, len(corpus))
        if end < len(corpus):
            end = _split_point(corpus, position, end)

        pieces.append(np.array(tokenizer.encode(corpus[position:end]), dtype=dtype))
        position = end

        if progress:
            done = 100 * position / len(corpus)
            print(f"  tokenising {done:5.1f}%", end="\r", flush=True)

    if progress:
        print()
    return np.concatenate(pieces) if pieces else np.zeros(0, dtype=dtype)


def _split_point(corpus: str, position: int, limit: int) -> int:
    """Find a chunk boundary that encodes the same as the uncut corpus.

    Cutting anywhere would be wrong: a whitespace run is one pre-token, so a
    newline followed by indentation must not be split, or the two halves merge
    differently than they would have together. The boundary is therefore a
    newline whose next character starts a fresh pre-token.
    """
    end = limit
    while end > position:
        newline = corpus.rfind("\n", position, end)
        if newline <= position:
            break
        # The whitespace run ends here only if what follows is not more of it.
        if newline + 1 >= len(corpus) or not corpus[newline + 1].isspace():
            return newline + 1
        end = newline
    # Nothing safe below the limit, so extend past it rather than cut wrongly.
    forward = limit
    while forward < len(corpus):
        newline = corpus.find("\n", forward)
        if newline == -1:
            break
        if newline + 1 >= len(corpus) or not corpus[newline + 1].isspace():
            return newline + 1
        forward = newline + 1
    return len(corpus)


def write_dataset(
    tokens: np.ndarray,
    directory: Path,
    *,
    validation_fraction: float = 0.05,
) -> dict:
    """Split into train and validation and write both to disk."""
    directory.mkdir(parents=True, exist_ok=True)

    split = int(len(tokens) * (1.0 - validation_fraction))
    train, validation = tokens[:split], tokens[split:]

    train.tofile(directory / "train.bin")
    validation.tofile(directory / "val.bin")

    metadata = {
        "dtype": str(tokens.dtype),
        "train_tokens": int(len(train)),
        "val_tokens": int(len(validation)),
        "total_tokens": int(len(tokens)),
    }
    (directory / "meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def stream_dataset(
    roots: list[Path],
    tokenizer: Tokenizer,
    directory: Path,
    *,
    validation_fraction: float = 0.05,
    allow: frozenset[str] = frozenset(),
    progress: bool = False,
) -> dict:
    """Encode every source file straight to disk, one file at a time.

    Nothing larger than a single source file is ever held in memory, so the
    corpus can be far bigger than RAM. Tokens go to one flat file first because
    the split point is only known once the total is; the split then copies
    rather than re-encoding.
    """
    directory.mkdir(parents=True, exist_ok=True)
    dtype = np.uint16 if tokenizer.vocab_size <= 65_536 else np.uint32

    combined = directory / "tokens.bin"
    total_tokens = 0
    total_characters = 0
    files = 0

    with combined.open("wb") as handle:
        for path, text in iter_sources(roots, allow=allow):
            marked = f"{FILE_MARKER}{Path(path).name}\n{text}\n"
            encoded = np.array(tokenizer.encode(marked), dtype=dtype)
            encoded.tofile(handle)

            files += 1
            total_tokens += len(encoded)
            total_characters += len(marked)

            if progress and files % 250 == 0:
                print(
                    f"  {files:,} files  {total_tokens:,} tokens  "
                    f"{total_characters / 1e6:.1f} MB",
                    end="\r",
                    flush=True,
                )

    if progress:
        print()

    if total_tokens == 0:
        combined.unlink(missing_ok=True)
        raise ValueError("no source files produced any tokens")

    split = int(total_tokens * (1.0 - validation_fraction))
    tokens = np.memmap(combined, dtype=dtype, mode="r")

    # Copied in chunks so a corpus larger than memory still splits.
    _copy_range(tokens, directory / "train.bin", 0, split)
    _copy_range(tokens, directory / "val.bin", split, total_tokens)

    del tokens
    combined.unlink()

    metadata = {
        "dtype": str(np.dtype(dtype)),
        "train_tokens": split,
        "val_tokens": total_tokens - split,
        "total_tokens": total_tokens,
        "files": files,
        "characters": total_characters,
        "characters_per_token": round(total_characters / total_tokens, 3),
    }
    (directory / "meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def _copy_range(
    tokens: np.ndarray, path: Path, start: int, end: int, chunk: int = 8_000_000
) -> None:
    """Write tokens[start:end] to `path` without materialising the slice."""
    with path.open("wb") as handle:
        for offset in range(start, end, chunk):
            tokens[offset : min(offset + chunk, end)].tofile(handle)


class TokenDataset:
    """A memory-mapped token stream that yields random training windows."""

    def __init__(self, path: Path, dtype: str = "uint16") -> None:
        self.path = path
        self.dtype = np.dtype(dtype)
        # Memory-mapped, so a corpus larger than RAM still works and the pages
        # are shared between processes.
        self.tokens = np.memmap(path, dtype=self.dtype, mode="r")

    def __len__(self) -> int:
        return len(self.tokens)

    def batch(
        self,
        batch_size: int,
        block_size: int,
        generator: np.random.Generator,
        device=None,
    ):
        """One batch of (inputs, targets), each (batch_size, block_size).

        Targets are the inputs shifted by one: the model predicts the next token
        at every position, so a window of length n gives n training signals.

        When `device` is a GPU the batch is staged in pinned memory and copied
        asynchronously, so the transfer overlaps the previous step's compute
        instead of stalling behind it. Pinned pages cannot be swapped out, which
        is what lets the copy engine run without the CPU.
        """
        import torch

        highest = len(self.tokens) - block_size - 1
        if highest <= 0:
            raise ValueError(
                f"dataset holds {len(self.tokens)} tokens, too few for a block of "
                f"{block_size}"
            )

        starts = generator.integers(0, highest, size=batch_size)
        inputs = np.stack([self.tokens[s : s + block_size] for s in starts])
        targets = np.stack([self.tokens[s + 1 : s + 1 + block_size] for s in starts])

        # astype(int64) because embedding lookups need long indices.
        inputs = torch.from_numpy(inputs.astype(np.int64))
        targets = torch.from_numpy(targets.astype(np.int64))

        if device is None:
            return inputs, targets

        device = torch.device(device)
        if device.type == "cuda":
            return (
                inputs.pin_memory().to(device, non_blocking=True),
                targets.pin_memory().to(device, non_blocking=True),
            )
        return inputs.to(device), targets.to(device)
