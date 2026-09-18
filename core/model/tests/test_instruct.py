"""Supervised fine-tuning: the format, and the mask that makes it work."""

from __future__ import annotations

import json

import numpy as np
import pytest
import torch

from codecraft_model.instruct import (
    IGNORE_INDEX,
    Example,
    InstructionDataset,
    load_examples,
    masked_loss,
    render,
    render_for_inference,
)
from codecraft_model.tokenizer import Tokenizer


@pytest.fixture(scope="module")
def tokenizer() -> Tokenizer:
    return Tokenizer.train("def parse(text): return text.strip()\n" * 80, 400)


# ------------------------------------------------------------------- the mask


def test_the_prompt_is_masked_out_of_the_loss(tokenizer: Tokenizer) -> None:
    """Training on the question teaches the model to ask questions."""
    tokens, labels = render(Example("sort a list", "sorted(items)"), tokenizer)

    assert len(tokens) == len(labels)
    assert labels[0] == IGNORE_INDEX
    assert any(label != IGNORE_INDEX for label in labels)


def test_only_the_answer_is_scored(tokenizer: Tokenizer) -> None:
    _, labels = render(Example("a question", "an answer"), tokenizer)

    scored = [label for label in labels if label != IGNORE_INDEX]
    assert tokenizer.decode(scored) == "an answer"


def test_the_end_marker_is_scored(tokenizer: Tokenizer) -> None:
    """The model can only learn to stop if stopping is something it is scored on.

    It is the last non-masked label rather than the last one: the final position
    has nothing after it to predict.
    """
    _, labels = render(Example("q", "a"), tokenizer)
    scored = [label for label in labels if label != IGNORE_INDEX]

    assert scored[-1] == tokenizer.special_id("<|end|>")
    assert labels[-1] == IGNORE_INDEX


def test_labels_are_shifted_by_one(tokenizer: Tokenizer) -> None:
    """labels[i] is tokens[i+1], matching what the model expects everywhere.

    Aligning them position for position instead trains the model to predict the
    token it has already been shown. It learns that instantly, learns nothing
    else, and the symptom is a fine-tuned model whose first output is its own
    stop token.
    """
    tokens, labels = render(Example("question here", "answer here"), tokenizer)

    for index, label in enumerate(labels):
        if label != IGNORE_INDEX:
            assert label == tokens[index + 1]


# ------------------------------------------------------------------ the format


def test_the_turn_markers_are_present(tokenizer: Tokenizer) -> None:
    tokens, _ = render(Example("q", "a"), tokenizer)

    assert tokens[0] == tokenizer.special_id("<|begin|>")
    assert tokenizer.special_id("<|user|>") in tokens
    assert tokenizer.special_id("<|assistant|>") in tokens


def test_a_system_prompt_comes_before_the_question(tokenizer: Tokenizer) -> None:
    tokens, _ = render(Example("q", "a", system="be terse"), tokenizer)

    assert tokens.index(tokenizer.special_id("<|user|>")) > 1
    assert "be terse" in tokenizer.decode(tokens)


def test_inference_stops_where_the_answer_starts(tokenizer: Tokenizer) -> None:
    """The two formats are derived from one, so they cannot drift."""
    prompt_ids = render_for_inference("sort a list", tokenizer)

    assert prompt_ids[-1] == tokenizer.special_id("<|assistant|>")
    assert tokenizer.special_id("<|end|>") not in prompt_ids


def test_the_inference_prompt_is_the_training_prompt(tokenizer: Tokenizer) -> None:
    """The prefix the model sees at inference is exactly what it was trained on."""
    tokens, _ = render(Example("sort a list", "sorted(x)"), tokenizer)
    prompt_ids = render_for_inference("sort a list", tokenizer)

    assert tokens[: len(prompt_ids)] == prompt_ids


def test_the_first_scored_position_is_the_end_of_the_prompt(tokenizer: Tokenizer) -> None:
    """So the model is scored on producing the answer's first token."""
    tokens, labels = render(Example("sort a list", "sorted(x)"), tokenizer)
    prompt_ids = render_for_inference("sort a list", tokenizer)

    first_scored = next(index for index, label in enumerate(labels) if label != IGNORE_INDEX)
    assert first_scored == len(prompt_ids) - 1
    assert labels[first_scored] == tokens[len(prompt_ids)]


# ------------------------------------------------------------------- loading


def test_json_lines_are_read(tmp_path) -> None:
    path = tmp_path / "examples.jsonl"
    path.write_text(
        json.dumps({"prompt": "one", "response": "1"})
        + "\n"
        + json.dumps({"prompt": "two", "response": "2", "system": "s"})
        + "\n"
    )

    examples = load_examples(path)

    assert [example.prompt for example in examples] == ["one", "two"]
    assert examples[1].system == "s"


def test_a_bad_line_is_skipped_rather_than_fatal(tmp_path, capsys) -> None:
    """Losing a whole set to one bad line is not a useful way to find out."""
    path = tmp_path / "examples.jsonl"
    path.write_text(
        json.dumps({"prompt": "good", "response": "yes"})
        + "\nnot json at all\n"
        + json.dumps({"prompt": "also good", "response": "yes"})
        + "\n"
    )

    examples = load_examples(path)

    assert len(examples) == 2
    assert "skipping line 2" in capsys.readouterr().out


def test_blank_lines_and_comments_are_ignored(tmp_path) -> None:
    path = tmp_path / "examples.jsonl"
    path.write_text("# a note\n\n" + json.dumps({"prompt": "q", "response": "a"}) + "\n")

    assert len(load_examples(path)) == 1


def test_an_example_missing_its_answer_is_refused(tmp_path) -> None:
    path = tmp_path / "examples.jsonl"
    path.write_text(json.dumps({"prompt": "q", "response": "   "}) + "\n")

    assert load_examples(path) == []


# ------------------------------------------------------------------ batching


def test_a_batch_is_padded_to_its_longest_example(tokenizer: Tokenizer) -> None:
    """Not to the maximum: a batch of short answers should cost less."""
    dataset = InstructionDataset(
        [Example("q", "a"), Example("a longer question", "a considerably longer answer")],
        tokenizer,
        max_length=512,
    )

    tokens, labels = dataset.batch(2, np.random.default_rng(0))

    assert tokens.shape == labels.shape
    assert tokens.shape[1] < 512


def test_padding_is_masked_out_of_the_loss(tokenizer: Tokenizer) -> None:
    """The model must not be trained to produce padding."""
    dataset = InstructionDataset(
        [Example("q", "a"), Example("much longer question", "much longer answer here")],
        tokenizer,
        max_length=512,
    )

    tokens, labels = dataset.batch(8, np.random.default_rng(0))
    padding = tokens == dataset.pad

    assert bool((labels[padding] == IGNORE_INDEX).all())


def test_an_example_too_long_is_dropped_not_truncated(tokenizer: Tokenizer) -> None:
    """A half-cut answer teaches the model to stop mid-sentence."""
    dataset = InstructionDataset(
        [Example("q", "a"), Example("q", "answer " * 500)], tokenizer, max_length=64
    )

    assert len(dataset) == 1
    assert dataset.skipped == 1


def test_an_empty_dataset_says_so_rather_than_producing_an_empty_batch(
    tokenizer: Tokenizer,
) -> None:
    dataset = InstructionDataset([], tokenizer, max_length=64)

    with pytest.raises(ValueError, match="no examples"):
        dataset.batch(2, np.random.default_rng(0))


# ---------------------------------------------------------------------- loss


def test_masked_loss_ignores_the_masked_positions() -> None:
    logits = torch.randn(1, 4, 10)
    everything = torch.tensor([[1, 2, 3, 4]])
    partly = torch.tensor([[IGNORE_INDEX, IGNORE_INDEX, 3, 4]])

    assert masked_loss(logits, everything) != masked_loss(logits, partly)


def test_masked_loss_matches_scoring_only_the_kept_positions() -> None:
    """The mask is a selection, not a reweighting."""
    torch.manual_seed(0)
    logits = torch.randn(1, 4, 10)
    labels = torch.tensor([[IGNORE_INDEX, IGNORE_INDEX, 3, 4]])

    direct = torch.nn.functional.cross_entropy(
        logits[0, 2:], torch.tensor([3, 4])
    )
    assert masked_loss(logits, labels) == pytest.approx(float(direct), rel=1e-5)
