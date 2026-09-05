"""The command line, driven end to end at a size that fits in a test run."""

from __future__ import annotations

import json

import pytest

from codecraft_model.cli import main


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
    learned = len(json.loads((run / "tokenizer.json").read_text())["merges"])

    assert f"vocab {learned + 262}" in reported


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
