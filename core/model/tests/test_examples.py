"""The fine-tuning set, checked rather than trusted.

A model cannot tell a plausible answer from a correct one, and neither will its
output. Everything here guards that: the set has to load with the loader that
will read it, and the code in it has to be code.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

from codecraft_model.instruct import load_examples

EXAMPLES = Path(__file__).resolve().parents[1] / "examples" / "instructions.jsonl"
FENCED = re.compile(r"```(\w+)\n(.*?)\n```", re.S)


@pytest.fixture(scope="module")
def rows() -> list[dict]:
    found = []
    for line in EXAMPLES.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            found.append(json.loads(line))
    return found


def test_the_set_is_big_enough_to_be_worth_training_on(rows) -> None:
    assert len(rows) > 5000


def test_it_loads_with_the_loader_that_will_read_it(rows) -> None:
    loaded = load_examples(EXAMPLES)
    assert len(loaded) == len(rows)


def test_every_example_has_both_halves(rows) -> None:
    for index, row in enumerate(rows):
        assert row.get("prompt"), f"row {index} has no prompt"
        assert row.get("response"), f"row {index} has no response"


def test_no_example_is_a_duplicate_of_another(rows) -> None:
    pairs = {(row["prompt"], row["response"]) for row in rows}
    assert len(pairs) == len(rows)


def test_every_python_answer_is_python_that_compiles(rows) -> None:
    """The failure this exists for: 88 blocks once did not parse.

    The miner lifted methods out of their classes with the indentation still on
    them, so they were syntactically invalid on their own — plausible-looking
    training data teaching a model code a compiler rejects.
    """
    broken = []
    for row in rows:
        for text in (row["prompt"], row["response"]):
            for language, body in FENCED.findall(text):
                if language != "python":
                    continue
                try:
                    ast.parse(body)
                except SyntaxError as error:
                    broken.append(f"{error.msg}: {body.splitlines()[0][:60]}")
    assert not broken, f"{len(broken)} Python blocks do not parse:\n" + "\n".join(broken[:5])


def test_every_fence_is_closed(rows) -> None:
    for row in rows:
        for text in (row["prompt"], row["response"]):
            assert text.count("```") % 2 == 0, f"unbalanced fence in: {text[:80]}"


def test_the_answers_are_not_all_the_same_shape(rows) -> None:
    """A set that is one template repeated teaches the template."""
    answers = {row["response"] for row in rows}
    assert len(answers) > 900


def test_prompts_are_overwhelmingly_distinct(rows) -> None:
    prompts = {row["prompt"] for row in rows}
    assert len(prompts) > 0.99 * len(rows)


def test_nothing_is_long_enough_to_blow_the_context(rows) -> None:
    """A 4096-token context, and an example has to leave room for an answer."""
    for row in rows:
        assert len(row["prompt"]) < 4000
        assert len(row["response"]) < 4000


def test_the_header_says_what_the_count_means(rows) -> None:
    """The count is not the number of independent facts, and says so."""
    header = "\n".join(
        line for line in EXAMPLES.read_text(encoding="utf-8").splitlines()[:20]
        if line.startswith("#")
    )
    assert "not" in header and "independent facts" in header
    assert "build.py" in header


def test_the_hand_written_seeds_survived(rows) -> None:
    """Regenerating once wrote over them; they live in their own file now."""
    seeds = EXAMPLES.parent / "seed.jsonl"
    assert seeds.is_file()
    written = [
        json.loads(line)
        for line in seeds.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert written
    present = {(row["prompt"], row["response"]) for row in rows}
    for seed in written:
        assert (seed["prompt"], seed["response"]) in present
