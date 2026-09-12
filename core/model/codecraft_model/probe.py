"""Asking a checkpoint the same questions every time.

Perplexity says how surprised a model is by held-out code. It does not say
whether the thing it writes at a caret is worth showing to anyone, and the two
come apart: the run on six times the corpus scored worse and wrote better-formed
nonsense. The only way to know what changed is to look, and looking is worth
doing the same way twice.

So a probe is a fixed list of carets, run at temperature zero against one
checkpoint or two, printed side by side. Nothing here is clever. What it is, is
repeatable: the same cases, the same seed, the same order, so a difference
between two runs is a difference between the models rather than between two
afternoons of typing prompts by hand.

The default cases are the shapes a caret actually takes in an editor, chosen so
that a model with nothing to say has nowhere to hide: finish this call, finish
this assignment, write this function's body, continue this import block.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CASES: list[dict] = [
    {
        "name": "call argument",
        "prefix": "def show(items):\n    for item in items:\n        print(",
        "suffix": ")\n",
        "line_comment": "#",
    },
    {
        "name": "assignment",
        "prefix": "class Note:\n    def __init__(self, text):\n        self.text = ",
        "suffix": "\n",
        "line_comment": "#",
    },
    {
        "name": "accumulator",
        "prefix": "def total(rows):\n    result = 0\n    for row in rows:\n        result += ",
        "suffix": "\n    return result\n",
        "line_comment": "#",
    },
    {
        "name": "function body",
        "prefix": "import json\n\n\ndef load(path):\n    ",
        "suffix": "\n",
        "line_comment": "#",
    },
    {
        "name": "import block",
        "prefix": "import os\nimport sys\nimport ",
        "suffix": "\n\n\ndef main():\n    pass\n",
        "line_comment": "#",
    },
    {
        "name": "condition",
        "prefix": "def check(value):\n    if value ",
        "suffix": ":\n        raise ValueError(value)\n",
        "line_comment": "#",
    },
]


@dataclass(frozen=True)
class Case:
    """One caret, and what surrounds it."""

    name: str
    prefix: str
    suffix: str
    line_comment: str | None = None


@dataclass(frozen=True)
class Answer:
    """What one checkpoint wrote at one caret."""

    case: str
    completion: str
    tokens: int
    confidence: float
    trimmed: str | None


def load_cases(path: Path | None) -> list[Case]:
    """Read cases from a JSON file, or use the built-in ones.

    The file is a list of objects with `prefix` and `suffix`; `name` and
    `line_comment` are optional. A caret in a real file is the point of this, so
    a case is allowed to be as long as a file.
    """
    raw = DEFAULT_CASES if path is None else json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list) or not raw:
        raise ValueError("a probe file must be a non-empty JSON list of cases")

    cases: list[Case] = []
    for index, entry in enumerate(raw, start=1):
        if not isinstance(entry, dict) or "prefix" not in entry:
            raise ValueError(f"case {index} has no 'prefix'")
        cases.append(
            Case(
                name=str(entry.get("name") or f"case {index}"),
                prefix=str(entry["prefix"]),
                suffix=str(entry.get("suffix", "")),
                line_comment=(
                    str(entry["line_comment"]) if entry.get("line_comment") else None
                ),
            )
        )
    return cases


def labels(runs: list[Path]) -> list[str]:
    """What to call each run in the output.

    Its directory name, which is what anyone reading the table has in mind,
    unless two of them share one. Comparing a run with itself is a real thing
    to do — it is how you check that the probe is deterministic — and two rows
    labelled the same would fold into one.
    """
    names = [run.name or str(run) for run in runs]
    if len(set(names)) != len(names):
        names = [str(run) for run in runs]

    # Still the same: the identical directory was given twice, which is how the
    # probe is checked for determinism rather than a mistake. Number them.
    seen: dict[str, int] = {}
    distinct: list[str] = []
    for name in names:
        seen[name] = seen.get(name, 0) + 1
        distinct.append(name if seen[name] == 1 else f"{name} ({seen[name]})")
    return distinct


def caret_line(case: Case) -> str:
    """The line the caret sits on, which is what the answer has to fit."""
    line = case.prefix[case.prefix.rfind("\n") + 1 :]
    # A blank line is still a caret, and where it sits along it is the part
    # that decides what a completion is allowed to do.
    return line if line.strip() else f"(column {len(line) + 1})"


def show(text: str, width: int = 68) -> str:
    """One line, with the line breaks visible rather than taken.

    A completion that walks out of the function is the failure being looked for,
    and printing it over four lines hides exactly that.
    """
    flat = text.replace("\\", "\\\\").replace("\n", "\\n").replace("\t", "\\t")
    if len(flat) <= width:
        return flat or "(nothing)"
    return flat[: width - 1] + "…"


def report(answers: list[Answer]) -> dict:
    """Everything one checkpoint said, in a form worth keeping."""
    return {
        "cases": len(answers),
        "empty": sum(1 for answer in answers if not answer.completion.strip()),
        "trimmed": sum(1 for answer in answers if answer.trimmed),
        "tokens": sum(answer.tokens for answer in answers),
        "answers": [
            {
                "case": answer.case,
                "completion": answer.completion,
                "tokens": answer.tokens,
                "confidence": round(answer.confidence, 4),
                "trimmed": answer.trimmed,
            }
            for answer in answers
        ],
    }


def summarise(answers: list[Answer]) -> str:
    """The line that goes under the table."""
    if not answers:
        return "no cases"
    empty = sum(1 for answer in answers if not answer.completion.strip())
    trimmed = sum(1 for answer in answers if answer.trimmed)
    mean = sum(answer.confidence for answer in answers) / len(answers)
    return (
        f"{len(answers)} cases, {empty} empty, {trimmed} cut for structure, "
        f"mean confidence {mean:.3f}"
    )
