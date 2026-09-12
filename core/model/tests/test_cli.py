"""The command line, driven end to end at a size that fits in a test run."""

from __future__ import annotations

import json

import pytest

from codecraft_model.cli import main
from codecraft_model.tokenizer import Tokenizer


@pytest.fixture
def sources(tmp_path):
    """A source tree with enough repetition to be learnable."""
    directory = tmp_path / "src"
    directory.mkdir()
    for index in range(6):
        (directory / f"module_{index}.py").write_text(
            f"def parse_{index}(text):\n"
            "    result = []\n"
            "    for line in text.splitlines():\n"
            "        result.append(line.strip())\n"
            "    return result\n" * 12
        )
    return directory


def test_sizes_reports_every_preset(capsys) -> None:
    assert main(["sizes"]) == 0

    output = capsys.readouterr().out
    for name in ["micro", "tiny", "small", "base", "large", "xl"]:
        assert name in output
    # The billion-parameter configuration is reported as such.
    assert "1.01B" in output


def test_prepare_train_sample_round_trip(tmp_path, sources, capsys) -> None:
    """The whole pipeline, from source files to generated text.

    Every stage is exercised for real: a tokenizer is trained, a corpus is
    encoded, weights are updated by gradient descent, a checkpoint is written
    and reloaded, and tokens are sampled from it.
    """
    run = tmp_path / "run"

    assert main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"]) == 0
    assert (run / "tokenizer.json").exists()
    assert json.loads((run / "meta.json").read_text())["total_tokens"] > 0

    assert (
        main(
            [
                "train", "--run", str(run), "--size", "micro", "--steps", "30",
                "--batch", "4", "--block", "64", "--warmup", "5", "--eval-every", "15",
                "--threads", "2",
            ]
        )
        == 0
    )
    summary = json.loads((run / "training.json").read_text())
    assert summary["history"][-1]["val_loss"] < summary["history"][0]["val_loss"]

    capsys.readouterr()
    assert main(["sample", "--run", str(run), "--prompt", "def parse", "--tokens", "20"]) == 0
    assert "def parse" in capsys.readouterr().out


def test_prepare_reports_a_tree_with_nothing_in_it(tmp_path, capsys) -> None:
    assert main(["prepare", "--run", str(tmp_path / "run"), "--roots", str(tmp_path)]) == 1
    assert "no source files" in capsys.readouterr().err


def test_train_without_a_tokenizer_says_to_prepare_first(tmp_path, capsys) -> None:
    assert main(["train", "--run", str(tmp_path)]) == 1
    assert "prepare" in capsys.readouterr().err


def test_sample_without_a_checkpoint_says_to_train_first(tmp_path, capsys) -> None:
    assert main(["sample", "--run", str(tmp_path)]) == 1
    assert "train first" in capsys.readouterr().err


def test_serve_without_a_checkpoint_fails_cleanly(tmp_path, capsys) -> None:
    assert main(["serve", "--run", str(tmp_path), "--port", "0"]) == 1
    assert "missing" in capsys.readouterr().out


def test_the_model_is_sized_for_the_tokenizer_that_was_trained(
    tmp_path, sources, capsys
) -> None:
    """A preset's vocabulary would index outside the embedding table.

    `prepare` learns as many merges as the corpus supports, which is often fewer
    than asked for, so the model has to take its vocabulary from the tokenizer.
    """
    run = tmp_path / "run"
    main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"])
    capsys.readouterr()

    main(
        [
            "train", "--run", str(run), "--size", "micro", "--steps", "2",
            "--batch", "2", "--block", "32", "--warmup", "1", "--eval-every", "2",
            "--threads", "2",
        ]
    )
    reported = capsys.readouterr().out
    tokenizer = Tokenizer.load(run / "tokenizer.json")

    assert f"vocab {tokenizer.vocab_size}" in reported


def test_serving_can_be_told_how_many_threads_to_use(tmp_path, monkeypatch) -> None:
    """Serving usually shares a box with an editor, a build, or the training run
    that produced the checkpoint."""
    import torch

    from codecraft_model import cli

    asked: list[int] = []
    monkeypatch.setattr(torch, "set_num_threads", lambda count: asked.append(count))
    monkeypatch.setattr(cli, "serve", lambda *args, **kwargs: 0, raising=False)

    # The run is empty, so serve refuses after the thread count is applied.
    cli.main(["serve", "--run", str(tmp_path), "--port", "0", "--threads", "2", "--device", "cpu"])

    assert asked == [2]


def test_prepare_says_what_the_validation_set_is(tmp_path, sources, capsys) -> None:
    """The pair "training 2.77, validation 4.11" reads as overfitting and is not.

    The split is the tail of the corpus, so validation is whole files the model
    never sees. Leaving that to be worked out from the split point leads to
    adding dropout that was never needed.
    """
    run = tmp_path / "run"

    main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"])

    assert "whole files the model never sees" in capsys.readouterr().out


def test_tokens_shows_the_split(tmp_path, sources, capsys) -> None:
    """Nearly every surprise about what a model does with a prompt turns out to
    be a surprise about how the prompt was split."""
    run = tmp_path / "run"
    main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"])
    capsys.readouterr()

    assert main(["tokens", "--run", str(run), "--text", "def parse(text):"]) == 0

    printed = capsys.readouterr().out
    assert "16 characters" in printed
    assert "characters per token" in printed

    # One row per token, whatever this tokenizer's merges happen to be: a small
    # vocabulary splits "def" into two pieces and a large one does not.
    reported = int(printed.split("characters, ")[1].split(" tokens")[0])
    rows = [line for line in printed.splitlines() if line.startswith("  ") and line.strip()]
    assert len(rows) == reported


def test_tokens_marks_whitespace(tmp_path, sources, capsys) -> None:
    """Whitespace is where a split is most often surprising."""
    run = tmp_path / "run"
    main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"])
    capsys.readouterr()

    main(["tokens", "--run", str(run), "--text", "a b"])

    assert "·" in capsys.readouterr().out


def test_tokens_counts_without_listing(tmp_path, sources, capsys) -> None:
    run = tmp_path / "run"
    main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"])
    capsys.readouterr()

    main(["tokens", "--run", str(run), "--text", "def parse", "--quiet"])
    printed = capsys.readouterr().out

    assert "characters" in printed
    assert "def" not in printed


def test_tokens_without_a_tokenizer_says_so(tmp_path, capsys) -> None:
    assert main(["tokens", "--run", str(tmp_path), "--text", "x"]) == 1
    assert "no tokenizer" in capsys.readouterr().err


def test_a_chat_prompt_keeps_its_turn_markers(tmp_path, sources) -> None:
    """Decoding the rendered prompt to text drops them, and the model is then
    asked the question with no format around it at all."""
    from codecraft_model.instruct import render_for_inference
    from codecraft_model.tokenizer import Tokenizer as Tok

    run = tmp_path / "run"
    main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"])
    tokenizer = Tok.load(run / "tokenizer.json")

    ids = render_for_inference("a question", tokenizer, "be terse")

    assert tokenizer.special_id("<|user|>") in ids
    assert tokenizer.special_id("<|assistant|>") in ids
    # The round trip that does not hold, which is why the ids are used directly.
    assert tokenizer.encode(tokenizer.decode(ids)) != ids


def test_resuming_takes_the_architecture_from_the_checkpoint(
    tmp_path, sources, capsys
) -> None:
    """Otherwise a resume rebuilds the default preset and fails to load.

    The flag that named the size was given on the first run, not on the one that
    continues it, and the failure is forty lines of size mismatches rather than
    a sentence saying what happened.
    """
    run = tmp_path / "run"
    main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"])
    main(
        [
            "train", "--run", str(run), "--size", "tiny", "--steps", "2",
            "--batch", "2", "--block", "32", "--warmup", "1", "--eval-every", "2",
            "--threads", "2",
        ]
    )
    trained = json.loads((run / "training.json").read_text())["parameters"]
    capsys.readouterr()

    # No --size this time, which is the whole point.
    assert (
        main(
            [
                "train", "--run", str(run), "--steps", "4", "--batch", "2",
                "--block", "32", "--warmup", "1", "--eval-every", "2",
                "--resume", "--threads", "2",
            ]
        )
        == 0
    )

    reported = capsys.readouterr().out
    assert "model resumed" in reported
    assert "resuming from step 2" in reported
    assert json.loads((run / "training.json").read_text())["parameters"] == trained


def test_a_size_given_on_a_resume_says_it_is_ignored(tmp_path, sources, capsys) -> None:
    """Silently ignoring a flag is worse than refusing it; saying so is better
    than either."""
    run = tmp_path / "run"
    main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"])
    main(
        [
            "train", "--run", str(run), "--size", "tiny", "--steps", "2",
            "--batch", "2", "--block", "32", "--warmup", "1", "--eval-every", "2",
            "--threads", "2",
        ]
    )
    capsys.readouterr()

    main(
        [
            "train", "--run", str(run), "--size", "micro", "--steps", "4",
            "--batch", "2", "--block", "32", "--warmup", "1", "--eval-every", "2",
            "--resume", "--threads", "2",
        ]
    )

    assert "--size micro is ignored" in capsys.readouterr().out


def test_resume_without_a_checkpoint_just_trains(tmp_path, sources) -> None:
    """Asking to continue something that was never started is not an error."""
    run = tmp_path / "run"
    main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"])

    assert (
        main(
            [
                "train", "--run", str(run), "--steps", "2", "--batch", "2",
                "--block", "32", "--warmup", "1", "--eval-every", "2",
                "--resume", "--threads", "2",
            ]
        )
        == 0
    )


def test_context_and_dropout_can_be_overridden(tmp_path, sources, capsys) -> None:
    run = tmp_path / "run"
    main(["prepare", "--run", str(run), "--roots", str(sources), "--vocab", "300"])
    capsys.readouterr()

    main(
        [
            "train", "--run", str(run), "--size", "micro", "--steps", "2",
            "--batch", "2", "--block", "32", "--warmup", "1", "--eval-every", "2",
            "--context", "128", "--dropout", "0.2", "--threads", "2",
        ]
    )
    output = capsys.readouterr().out
    assert "context 128" in output and "dropout 0.2" in output
