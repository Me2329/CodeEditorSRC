"""Command line for the model.

    python -m codecraft_model sizes
    python -m codecraft_model prepare --roots . --vocab 4096 --out runs/demo
    python -m codecraft_model train   --run runs/demo --size micro --steps 2000
    python -m codecraft_model sample  --run runs/demo --prompt "def parse("
    python -m codecraft_model serve   --run runs/demo --port 8940
"""

from __future__ import annotations

import argparse
import codecs
import json
import shutil
import sys
import time
from pathlib import Path

import torch

from .config import SIZES, get_size, humanise
from .device import describe_device, memory_total_bytes, resolve_device
from .corpus import (
    Repository,
    estimate,
    iter_repository_sources,
    parse_repository,
    read_repository_list,
)
from .data import (
    FILE_MARKER,
    TokenDataset,
    iter_sources,
    sample_corpus,
    stream_dataset,
)
from .model import CodeCraftLM
from .tokenizer import Tokenizer
from .train import TrainConfig, load_checkpoint, train


def command_sizes(args: argparse.Namespace) -> int:
    """Print every named size with its true parameter count."""
    device = resolve_device(getattr(args, "device", None))
    budget = memory_total_bytes(device)
    print(f"device: {describe_device(device)}\n")

    header = (
        f"{'size':8}{'parameters':>12}{'d_model':>9}{'layers':>8}{'heads':>7}"
        f"{'kv':>5}{'d_ff':>7}{'context':>9}{'train mem':>11}"
        + ("  fits" if memory_total_bytes(device) is not None else "")
    )
    print(header)
    print("-" * len(header))

    for name, config in SIZES.items():
        needed = config.memory_estimate_bytes()["training"]
        # Activations, the batch and allocator fragmentation all sit on top of
        # the four fixed copies, and roughly a third again covers them.
        fits = "" if budget is None else ("  yes" if needed * 1.35 < budget else "   no")
        print(
            f"{name:8}{humanise(config.parameter_count()):>12}{config.d_model:>9}"
            f"{config.n_layers:>8}{config.n_heads:>7}{config.n_kv_heads:>5}"
            f"{config.d_ff:>7}{config.max_seq_len:>9}{needed / 1e9:>10.1f}G{fits}"
        )

    print(
        "\nTraining memory is weights, gradients and two Adam moments at 4 bytes\n"
        "each, before activations. Mixed precision narrows the matmuls, not those\n"
        "four copies, so it buys speed rather than room."
    )
    if budget is not None:
        print(
            "The last column allows about a third again for activations and the\n"
            "batch. A size marked 'no' still trains with a smaller batch, gradient\n"
            "accumulation to make the effective batch back up, and a shorter block."
        )
    return 0


def command_corpus(args: argparse.Namespace) -> int:
    """Answer the only question that decides whether a corpus is possible."""
    header = f"{'tokens':>14}{'source text':>14}{'repositories':>14}{'tokens on disk':>16}{'peak, streaming':>18}"
    print(header)
    print("-" * len(header))

    targets = args.tokens or [10_000_000, 100_000_000, 1_000_000_000, 10_000_000_000]
    for target in targets:
        numbers = estimate(target, args.characters_per_token)
        print(
            f"{humanise(target):>14}"
            f"{numbers['source_text_gb']:>12.1f}GB"
            f"{numbers['repositories_gb']:>12.1f}GB"
            f"{numbers['token_stream_gb']:>14.1f}GB"
            f"{numbers['peak_disk_streaming_gb']:>16.1f}GB"
        )

    print(
        "\nA token is two bytes, so the trained corpus is small. What is large is\n"
        "the source it came from, and the repositories holding that source are\n"
        "larger again once tests, assets and generated files are counted.\n\n"
        "'peak, streaming' is what you actually need free: prepare clones one\n"
        "repository at a time, encodes it, and deletes it before the next. Keeping\n"
        f"every source instead would need "
        f"{estimate(targets[-1], args.characters_per_token)['peak_disk_keeping_sources_gb']:.0f}GB "
        f"for the largest row."
    )
    return 0


def command_prepare(args: argparse.Namespace) -> int:
    """Collect source files, train a tokenizer, and write the token stream."""
    run = Path(args.run)
    run.mkdir(parents=True, exist_ok=True)

    roots = [Path(root).resolve() for root in args.roots]
    allow = frozenset(args.allow_dir or ())
    repositories = _repositories(args)

    if roots:
        print(f"scanning {', '.join(str(root) for root in roots)}")
    if repositories:
        print(f"{len(repositories)} repositories to clone, read and discard")
    if allow:
        print(f"  including normally-skipped directories: {', '.join(sorted(allow))}")

    print(f"sampling up to {args.sample_mb}MB to train the tokenizer")
    started = time.time()
    sample = _tokenizer_sample(args, roots, repositories, allow)
    if not sample:
        print("no source files found", file=sys.stderr)
        return 1
    print(f"  {len(sample) / 1e6:.1f}MB sampled in {time.time() - started:.1f}s")

    print(f"training a {args.vocab}-token byte-level BPE vocabulary")
    started = time.time()
    tokenizer = Tokenizer.train(sample, args.vocab, progress=True)
    tokenizer.save(run / "tokenizer.json")
    print(f"  {tokenizer.vocab_size} tokens learned in {time.time() - started:.1f}s")

    # The sample can be large, and encoding the full corpus needs the memory.
    del sample

    print("encoding the corpus")
    started = time.time()
    workspace = Path(args.workspace) if args.workspace else run / "checkouts"
    metadata = stream_dataset(
        _all_sources(roots, repositories, workspace, allow, depth=args.depth),
        tokenizer,
        run,
        validation_fraction=args.val_fraction,
        max_tokens=args.max_tokens,
        progress=True,
    )
    shutil.rmtree(workspace, ignore_errors=True)
    print(
        f"  {metadata['files']:,} files, {metadata['characters'] / 1e6:.1f}MB\n"
        f"  {metadata['total_tokens']:,} tokens "
        f"({metadata['train_tokens']:,} train / {metadata['val_tokens']:,} val)\n"
        f"  {metadata['characters_per_token']} characters per token, "
        f"{time.time() - started:.1f}s\n"
        f"  {metadata['bytes_on_disk'] / 1e9:.2f}GB on disk as tokens"
    )
    return 0


def _repositories(args: argparse.Namespace) -> list[Repository]:
    repositories = [parse_repository(spec) for spec in (args.repos or ())]
    if args.repos_file:
        repositories.extend(read_repository_list(Path(args.repos_file)))
    return repositories


def _all_sources(
    roots: list[Path],
    repositories: list[Repository],
    workspace: Path,
    allow: frozenset[str],
    *,
    depth: int,
):
    """Local directories first, then repositories cloned one at a time."""
    yield from iter_sources(roots, allow=allow)
    if repositories:
        yield from iter_repository_sources(
            repositories, workspace, allow=allow, depth=depth
        )


def _tokenizer_sample(
    args: argparse.Namespace,
    roots: list[Path],
    repositories: list[Repository],
    allow: frozenset[str],
) -> str:
    """Text to learn a vocabulary from, without cloning everything twice.

    Local roots are sampled directly. With only repositories to go on, the
    first few are cloned for the sample and the rest are read during encoding;
    a vocabulary does not need to see the whole corpus to be a good one.
    """
    if roots:
        return sample_corpus(
            roots,
            max_bytes=args.sample_mb * 1_000_000,
            allow=allow,
            stride=args.sample_stride,
        )

    workspace = Path(args.workspace) if args.workspace else Path(args.run) / "sample"
    pieces: list[str] = []
    total = 0
    for path, text in iter_repository_sources(
        repositories[: args.sample_repos], workspace, allow=allow, depth=args.depth
    ):
        pieces.append(f"{FILE_MARKER}{Path(path).name}\n{text}")
        total += len(text)
        if total >= args.sample_mb * 1_000_000:
            break
    shutil.rmtree(workspace, ignore_errors=True)
    return "\n".join(pieces)


def command_train(args: argparse.Namespace) -> int:
    run = Path(args.run)
    tokenizer_path = run / "tokenizer.json"
    if not tokenizer_path.exists():
        print(f"no tokenizer at {tokenizer_path}; run 'prepare' first", file=sys.stderr)
        return 1

    tokenizer = Tokenizer.load(tokenizer_path)
    metadata = json.loads((run / "meta.json").read_text(encoding="utf-8"))

    # The vocabulary comes from the tokenizer that was actually trained, not
    # from the preset: a mismatch would index outside the embedding table.
    config = get_size(args.size).with_vocab(tokenizer.vocab_size)

    overrides: dict = {}
    if args.context is not None:
        overrides["max_seq_len"] = args.context
    if args.dropout is not None:
        overrides["dropout"] = args.dropout
    if overrides:
        config = config.__class__(**{**config.to_dict(), **overrides})

    model = CodeCraftLM(config)
    print(
        f"model '{args.size}': {humanise(model.parameter_count())} parameters, "
        f"vocab {config.vocab_size}, context {config.max_seq_len}, "
        f"dropout {config.dropout}"
    )

    tokens_per_step = args.batch * min(args.block, config.max_seq_len) * args.accumulate
    epochs = tokens_per_step * args.steps / max(metadata["train_tokens"], 1)
    if epochs > 3:
        print(
            f"  note: {epochs:.0f} passes over {metadata['train_tokens']:,} training "
            "tokens. A model this size will start memorising; watch the gap between\n"
            "  training and validation loss, and raise --dropout or the corpus size."
        )

    block = min(args.block, config.max_seq_len)
    train_config = TrainConfig(
        steps=args.steps,
        batch_size=args.batch,
        block_size=block,
        grad_accumulation=args.accumulate,
        learning_rate=args.lr,
        warmup_steps=args.warmup,
        eval_every=args.eval_every,
        seed=args.seed,
        precision=args.precision,
        compile_model=args.compile,
        max_hours=args.max_hours,
    )

    device = resolve_device(args.device)
    # Threads matter on a CPU run and are irrelevant on a GPU one, where the
    # host thread only queues work.
    if device.type == "cpu":
        torch.set_num_threads(args.threads)

    summary = train(
        model,
        TokenDataset(run / "train.bin", metadata["dtype"]),
        TokenDataset(run / "val.bin", metadata["dtype"]),
        train_config,
        output_dir=run,
        device=device,
        resume_from=run / "latest.pt" if args.resume else None,
    )

    print(f"\ncheckpoint written to {run / 'model.pt'}")
    print(f"  best validation loss {summary['best_val_loss']:.3f}")
    if summary["stopped_early"]:
        print("  stopped on the time budget; rerun with --resume to continue")
    return 0


def command_sample(args: argparse.Namespace) -> int:
    run = Path(args.run)
    checkpoint = run / "model.pt"
    if not checkpoint.exists():
        print(f"no checkpoint at {checkpoint}; train first", file=sys.stderr)
        return 1

    device = resolve_device(args.device)
    tokenizer = Tokenizer.load(run / "tokenizer.json")
    model, payload = load_checkpoint(checkpoint, device)

    print(
        f"# {humanise(model.parameter_count())} parameters, "
        f"step {payload['step']}, val loss {payload['val_loss']:.3f}, "
        f"on {describe_device(device)}\n"
    )

    tokens = torch.tensor([tokenizer.encode(args.prompt)], dtype=torch.long, device=device)
    print(args.prompt, end="", flush=True)

    # An incremental decoder holds back the bytes of a character that spans
    # several tokens, so nothing prints as a replacement that is about to
    # become a real character.
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    for token in model.generate(
        tokens,
        max_new_tokens=args.tokens,
        temperature=args.temperature,
        top_k=args.top_k,
        top_p=args.top_p,
        repetition_penalty=args.repetition_penalty,
        stop_tokens={tokenizer.special_id("<|end|>")},
    ):
        piece = tokenizer.vocab.get(token)
        if piece is not None:
            print(decoder.decode(piece), end="", flush=True)

    print(decoder.decode(b"", final=True))
    print()
    return 0


def command_serve(args: argparse.Namespace) -> int:
    from .serve import serve

    return serve(Path(args.run), host=args.host, port=args.port, device=args.device)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="codecraft_model",
        description="Train and run CodeCraft LM, a small code model built from scratch.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_device(parser_: argparse.ArgumentParser) -> None:
        parser_.add_argument(
            "--device",
            default="auto",
            help="auto, cuda, cuda:1, cpu or mps (auto takes the best available)",
        )

    sizes = subparsers.add_parser("sizes", help="list the named model sizes")
    add_device(sizes)
    sizes.set_defaults(func=command_sizes)

    corpus = subparsers.add_parser(
        "corpus", help="what a corpus of a given size costs on disk"
    )
    corpus.add_argument(
        "--tokens",
        type=int,
        nargs="+",
        default=None,
        metavar="N",
        help="token counts to price, e.g. 1000000000",
    )
    corpus.add_argument("--characters-per-token", type=float, default=3.5)
    corpus.set_defaults(func=command_corpus)

    prepare = subparsers.add_parser("prepare", help="build a corpus and tokenizer")
    prepare.add_argument("--run", required=True, help="directory for this run")
    prepare.add_argument(
        "--roots", nargs="*", default=[], help="local directories to scan"
    )
    prepare.add_argument(
        "--repos",
        nargs="+",
        default=None,
        metavar="OWNER/NAME",
        help="repositories to clone, read and delete one at a time",
    )
    prepare.add_argument(
        "--repos-file",
        default=None,
        help="a file of repositories, one per line, # for comments",
    )
    prepare.add_argument(
        "--max-tokens",
        type=int,
        default=None,
        help="stop once the corpus reaches this many tokens",
    )
    prepare.add_argument(
        "--depth",
        type=int,
        default=1,
        help="clone depth; history is bandwidth spent on near-duplicate text",
    )
    prepare.add_argument(
        "--workspace",
        default=None,
        help="where clones are staged; each is deleted after it is read",
    )
    prepare.add_argument(
        "--sample-repos",
        type=int,
        default=3,
        help="repositories to clone for the tokenizer sample when there are no local roots",
    )
    prepare.add_argument("--vocab", type=int, default=4096, help="tokenizer vocabulary size")
    prepare.add_argument("--val-fraction", type=float, default=0.05)
    prepare.add_argument(
        "--sample-mb",
        type=int,
        default=32,
        help="how much text to train the tokenizer on; the corpus itself is unbounded",
    )
    prepare.add_argument(
        "--sample-stride",
        type=int,
        default=1,
        help="take every nth file for the sample, so it spans the whole tree",
    )
    prepare.add_argument(
        "--allow-dir",
        nargs="+",
        default=None,
        metavar="NAME",
        help="include directories normally skipped, e.g. site-packages node_modules",
    )
    prepare.set_defaults(func=command_prepare)

    trainer = subparsers.add_parser("train", help="train a model")
    trainer.add_argument("--run", required=True)
    trainer.add_argument("--size", default="micro", choices=sorted(SIZES))
    trainer.add_argument("--steps", type=int, default=2000)
    trainer.add_argument("--batch", type=int, default=16)
    trainer.add_argument("--block", type=int, default=256, help="tokens per window")
    trainer.add_argument("--accumulate", type=int, default=1)
    trainer.add_argument("--lr", type=float, default=3e-4)
    trainer.add_argument("--warmup", type=int, default=100)
    trainer.add_argument("--eval-every", type=int, default=200)
    trainer.add_argument("--context", type=int, default=None, help="override max_seq_len")
    trainer.add_argument(
        "--dropout",
        type=float,
        default=None,
        help="dropout rate; worth setting on a corpus small enough to memorise",
    )
    trainer.add_argument("--threads", type=int, default=4, help="CPU threads; ignored on a GPU")
    trainer.add_argument("--seed", type=int, default=1337)
    add_device(trainer)
    trainer.add_argument(
        "--precision",
        default="auto",
        choices=["auto", "bf16", "fp16", "fp32"],
        help="auto picks bf16 on a card that supports it",
    )
    trainer.add_argument(
        "--compile",
        action="store_true",
        help="fuse the graph with torch.compile: faster steps, slow first step",
    )
    trainer.add_argument(
        "--max-hours",
        type=float,
        default=None,
        help="stop after this long, checkpointing first; resume with --resume",
    )
    trainer.add_argument(
        "--resume",
        action="store_true",
        help="continue from latest.pt, restoring the optimiser state too",
    )
    trainer.set_defaults(func=command_train)

    sampler = subparsers.add_parser("sample", help="generate from a checkpoint")
    sampler.add_argument("--run", required=True)
    sampler.add_argument("--prompt", default="def ")
    sampler.add_argument("--tokens", type=int, default=200)
    sampler.add_argument("--temperature", type=float, default=0.8)
    sampler.add_argument("--top-k", type=int, default=40)
    sampler.add_argument("--top-p", type=float, default=0.95)
    sampler.add_argument("--repetition-penalty", type=float, default=1.1)
    add_device(sampler)
    sampler.set_defaults(func=command_sample)

    server = subparsers.add_parser("serve", help="serve the model over HTTP")
    server.add_argument("--run", required=True)
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8940)
    add_device(server)
    server.set_defaults(func=command_serve)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except RuntimeError as error:
        # A device that cannot be used is a configuration problem with a known
        # fix, not a crash. The message already names the fix.
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
