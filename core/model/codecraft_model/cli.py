"""Command line for the model.

    python -m codecraft_model sizes
    python -m codecraft_model prepare --roots . --vocab 4096 --out runs/demo
    python -m codecraft_model train   --run runs/demo --size micro --steps 2000
    python -m codecraft_model sample  --run runs/demo --prompt "def parse("
    python -m codecraft_model serve   --run runs/demo --port 8940
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import torch

from .config import SIZES, get_size, humanise
from .data import (
    TokenDataset,
    build_corpus,
    collect_sources,
    encode_corpus,
    write_dataset,
)
from .model import CodeCraftLM
from .tokenizer import Tokenizer
from .train import TrainConfig, load_checkpoint, train


def command_sizes(_: argparse.Namespace) -> int:
    """Print every named size with its true parameter count."""
    header = (
        f"{'size':8}{'parameters':>12}{'d_model':>9}{'layers':>8}{'heads':>7}"
        f"{'kv':>5}{'d_ff':>7}{'context':>9}{'train RAM':>11}"
    )
    print(header)
    print("-" * len(header))

    for name, config in SIZES.items():
        memory = config.memory_estimate_bytes()["training"] / 1e9
        print(
            f"{name:8}{humanise(config.parameter_count()):>12}{config.d_model:>9}"
            f"{config.n_layers:>8}{config.n_heads:>7}{config.n_kv_heads:>5}"
            f"{config.d_ff:>7}{config.max_seq_len:>9}{memory:>10.1f}G"
        )

    print(
        "\nTraining RAM is weights, gradients and two Adam moments at 4 bytes each,\n"
        "before activations. Sizes up to 'small' train usefully on a CPU; the\n"
        "larger ones need accelerators and a corpus to match."
    )
    return 0


def command_prepare(args: argparse.Namespace) -> int:
    """Collect source files, train a tokenizer, and write the token stream."""
    run = Path(args.run)
    run.mkdir(parents=True, exist_ok=True)

    roots = [Path(root).resolve() for root in args.roots]
    print(f"scanning {', '.join(str(root) for root in roots)}")

    sources = collect_sources(roots, limit=args.max_files)
    if not sources:
        print("no source files found", file=sys.stderr)
        return 1

    corpus = build_corpus(sources)
    characters = len(corpus)
    print(f"  {len(sources):,} files, {characters:,} characters")

    print(f"training a {args.vocab}-token byte-level BPE vocabulary")
    started = time.time()
    tokenizer = Tokenizer.train(corpus, args.vocab, progress=True)
    tokenizer.save(run / "tokenizer.json")
    print(
        f"  {tokenizer.vocab_size} tokens learned in {time.time() - started:.1f}s"
    )

    print("encoding the corpus")
    tokens = encode_corpus(corpus, tokenizer, progress=True)
    metadata = write_dataset(tokens, run, validation_fraction=args.val_fraction)

    ratio = characters / max(len(tokens), 1)
    print(
        f"  {metadata['total_tokens']:,} tokens "
        f"({metadata['train_tokens']:,} train / {metadata['val_tokens']:,} val)\n"
        f"  {ratio:.2f} characters per token"
    )
    return 0


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
    )

    torch.set_num_threads(args.threads)
    summary = train(
        model,
        TokenDataset(run / "train.bin", metadata["dtype"]),
        TokenDataset(run / "val.bin", metadata["dtype"]),
        train_config,
        output_dir=run,
    )

    print(f"\ncheckpoint written to {run / 'model.pt'}")
    print(f"  best validation loss {summary['best_val_loss']:.3f}")
    return 0


def command_sample(args: argparse.Namespace) -> int:
    run = Path(args.run)
    checkpoint = run / "model.pt"
    if not checkpoint.exists():
        print(f"no checkpoint at {checkpoint}; train first", file=sys.stderr)
        return 1

    tokenizer = Tokenizer.load(run / "tokenizer.json")
    model, payload = load_checkpoint(checkpoint)

    print(
        f"# {humanise(model.parameter_count())} parameters, "
        f"step {payload['step']}, val loss {payload['val_loss']:.3f}\n"
    )

    tokens = torch.tensor([tokenizer.encode(args.prompt)], dtype=torch.long)
    print(args.prompt, end="", flush=True)

    pieces: list[int] = []
    for token in model.generate(
        tokens,
        max_new_tokens=args.tokens,
        temperature=args.temperature,
        top_k=args.top_k,
        top_p=args.top_p,
        repetition_penalty=args.repetition_penalty,
        stop_tokens={tokenizer.special_id("<|end|>")},
    ):
        pieces.append(token)
        # Decode the whole tail each time: a multi-byte character can span
        # several tokens, and decoding one at a time would print replacements.
        text = tokenizer.decode(pieces)
        print(text[len(tokenizer.decode(pieces[:-1])) :], end="", flush=True)

    print("\n")
    return 0


def command_serve(args: argparse.Namespace) -> int:
    from .serve import serve

    return serve(Path(args.run), host=args.host, port=args.port)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="codecraft_model",
        description="Train and run CodeCraft LM, a small code model built from scratch.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("sizes", help="list the named model sizes").set_defaults(
        func=command_sizes
    )

    prepare = subparsers.add_parser("prepare", help="build a corpus and tokenizer")
    prepare.add_argument("--run", required=True, help="directory for this run")
    prepare.add_argument("--roots", nargs="+", default=["."], help="directories to scan")
    prepare.add_argument("--vocab", type=int, default=4096, help="tokenizer vocabulary size")
    prepare.add_argument("--max-files", type=int, default=None)
    prepare.add_argument("--val-fraction", type=float, default=0.05)
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
    trainer.add_argument("--threads", type=int, default=4)
    trainer.add_argument("--seed", type=int, default=1337)
    trainer.set_defaults(func=command_train)

    sampler = subparsers.add_parser("sample", help="generate from a checkpoint")
    sampler.add_argument("--run", required=True)
    sampler.add_argument("--prompt", default="def ")
    sampler.add_argument("--tokens", type=int, default=200)
    sampler.add_argument("--temperature", type=float, default=0.8)
    sampler.add_argument("--top-k", type=int, default=40)
    sampler.add_argument("--top-p", type=float, default=0.95)
    sampler.add_argument("--repetition-penalty", type=float, default=1.1)
    sampler.set_defaults(func=command_sample)

    server = subparsers.add_parser("serve", help="serve the model over HTTP")
    server.add_argument("--run", required=True)
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8940)
    server.set_defaults(func=command_serve)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
