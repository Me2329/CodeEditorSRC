"""Turning a base model into one that answers rather than continues.

A base model has no idea it is in a conversation. Given "write a function that
sorts a list" it will happily produce three more feature requests, because in
its training data that string was usually followed by more prose. Nothing is
broken; it is doing exactly what it was trained to do.

What changes that is supervised fine-tuning: more next-token prediction, on
examples shaped like the thing you want. The whole mechanism is two decisions.

First, a format. Every example is rendered into the same token sequence, so the
model can learn where a question ends and an answer begins. The specials for
that already exist in the tokenizer.

Second, and the part that is easy to get wrong: loss is computed on the answer
only. Training on the question as well teaches the model to generate questions,
which is the opposite of the goal, and it dilutes the signal that matters with
tokens the model will never need to produce. The mask is what makes this
fine-tuning rather than just more pretraining on differently-shaped text.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from .tokenizer import Tokenizer

# Loss is skipped at these positions. -100 is what cross_entropy treats as
# "ignore", and it cannot collide with a real token id because ids are positive.
IGNORE_INDEX = -100


@dataclass(frozen=True)
class Example:
    """One instruction and the answer it should produce."""

    prompt: str
    response: str
    system: str = ""


def render(example: Example, tokenizer: Tokenizer) -> tuple[list[int], list[int]]:
    """Return the token ids and the labels, with the prompt masked out.

    Labels are shifted by one, matching what the model expects everywhere else:
    the logits at position i predict the token at position i+1, so `labels[i]`
    holds `tokens[i+1]`. The pretraining path gets this for free because its
    targets are the inputs shifted; here it has to be done deliberately.

    Aligning them position for position instead trains the model to predict the
    token it has already been shown, which it learns immediately and which
    teaches it nothing. The symptom is a fine-tuned model that emits its stop
    token as the first thing it says.
    """
    prompt_ids = render_for_inference(example.prompt, tokenizer, example.system)

    # The end marker is part of the answer: the model has to learn to stop, and
    # it can only learn that if stopping is something it is scored on.
    response_ids = tokenizer.encode(example.response) + [tokenizer.special_id("<|end|>")]

    tokens = prompt_ids + response_ids

    # labels[i] is what position i should predict, which is tokens[i+1]. The
    # last position has nothing after it to predict, so it is masked.
    labels = [IGNORE_INDEX] * len(tokens)
    for index in range(len(prompt_ids) - 1, len(tokens) - 1):
        labels[index] = tokens[index + 1]

    return tokens, labels


def render_for_inference(prompt: str, tokenizer: Tokenizer, system: str = "") -> list[int]:
    """The same shape, stopping where the answer would start.

    Built from the same function as the training prompt rather than written
    twice, because a training format and an inference format that drift apart
    produce a model that works in evaluation and not in use.
    """
    prompt_ids: list[int] = [tokenizer.special_id("<|begin|>")]
    if system:
        prompt_ids += tokenizer.encode(system)
    prompt_ids += [tokenizer.special_id("<|user|>")]
    prompt_ids += tokenizer.encode(prompt)
    prompt_ids += [tokenizer.special_id("<|assistant|>")]
    return prompt_ids


def load_examples(path: Path) -> list[Example]:
    """Read JSON Lines: one object per line with prompt, response, system.

    Lines that are blank or unparseable are skipped rather than fatal. A
    fine-tuning set is usually assembled by hand or by script, and losing the
    whole file to one bad line is not a useful way to find out.
    """
    examples: list[Example] = []

    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            print(f"  skipping line {number}: not valid JSON")
            continue

        prompt = payload.get("prompt")
        response = payload.get("response")
        if not isinstance(prompt, str) or not isinstance(response, str):
            print(f"  skipping line {number}: needs a string prompt and response")
            continue
        if not prompt.strip() or not response.strip():
            print(f"  skipping line {number}: prompt or response is empty")
            continue

        examples.append(Example(prompt, response, str(payload.get("system", ""))))

    return examples


class InstructionDataset:
    """Rendered examples, padded into batches with their masks.

    Held in memory rather than memory-mapped, unlike the pretraining corpus: an
    instruction set is thousands of examples, not billions of tokens, and the
    padding is easier to reason about in one place.
    """

    def __init__(self, examples: list[Example], tokenizer: Tokenizer, max_length: int) -> None:
        self.rendered: list[tuple[list[int], list[int]]] = []
        self.skipped = 0

        for example in examples:
            tokens, labels = render(example, tokenizer)
            if len(tokens) > max_length:
                # Truncating would cut the answer, and an example whose answer
                # is half missing teaches the model to stop mid-sentence.
                self.skipped += 1
                continue
            self.rendered.append((tokens, labels))

        self.pad = tokenizer.special_id("<|pad|>")
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.rendered)

    def batch(self, batch_size: int, generator: np.random.Generator):
        """One padded batch of (tokens, labels).

        Padded to the longest example in the batch rather than to `max_length`,
        which is most of the saving when example lengths vary: a batch of short
        answers should not cost the same as a batch of long ones.
        """
        if not self.rendered:
            raise ValueError("no examples survived rendering")

        chosen = generator.integers(0, len(self.rendered), size=batch_size)
        picked = [self.rendered[index] for index in chosen]
        width = max(len(tokens) for tokens, _ in picked)

        token_rows = [tokens + [self.pad] * (width - len(tokens)) for tokens, _ in picked]
        # Padding is masked out of the loss for the same reason the prompt is:
        # the model must not be trained to produce it.
        label_rows = [
            labels + [IGNORE_INDEX] * (width - len(labels)) for _, labels in picked
        ]

        return (
            torch.tensor(token_rows, dtype=torch.long),
            torch.tensor(label_rows, dtype=torch.long),
        )


def masked_loss(logits: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
    """Cross entropy over the answer positions only.

    The model's own forward pass computes loss against `targets` with padding
    ignored, but fine-tuning needs a different mask per example, so the loss is
    computed here from the logits instead.
    """
    return torch.nn.functional.cross_entropy(
        logits.reshape(-1, logits.size(-1)),
        labels.reshape(-1),
        ignore_index=IGNORE_INDEX,
    )
