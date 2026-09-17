"""Assemble a fine-tuning set from material that is already true.

Five sources, in descending order of how much I trust them:

1. The repository's own code. Real functions with real docstrings, which makes
   the instruction and the answer a matched pair somebody already reviewed.
2. The runtime registry, which is the single source of truth three layers of
   this project already read. Questions about it have answers that cannot drift.
3. The task catalogue in `tasks.py`: one idea written out by hand in several
   languages, each implementation read before it was committed.
4. Translations between those implementations, which are free once the same
   idea exists in two languages and are exactly the pairing a code model needs.
5. Explanations of the same code, which teach the opposite direction.

What this is not: five thousand independent facts. It is a few hundred pieces
of verified material, turned into the shapes an instruction-tuned model has to
recognise. That distinction matters when reading the count, and the header of
the generated file states it so nobody has to come back here to find out.
"""

from __future__ import annotations

import argparse
import ast
import json
import random
import re
import textwrap
from pathlib import Path

from mining import strip_docstring
from tasks import TASKS, Task

ROOT = Path(__file__).resolve().parents[3]

#: How the editor names each language, mapped to what a person calls it.
SPOKEN = {
    "python": "Python", "javascript": "JavaScript", "typescript": "TypeScript",
    "rust": "Rust", "go": "Go", "c": "C", "cpp": "C++", "java": "Java",
    "ruby": "Ruby", "shell": "Bash", "lua": "Lua", "sql": "SQL",
}

#: Fenced-block tags, which are not always the language id.
FENCE = {"shell": "bash", "cpp": "cpp", "csharp": "csharp"}


def parses(code: str) -> bool:
    """Whether this is Python a compiler would accept.

    Every Python answer goes through here. The set is training data: a model
    has no way to tell a plausible answer from a correct one, so anything that
    does not compile is not worth the tokens it would take to learn.
    """
    try:
        ast.parse(code)
    except (SyntaxError, ValueError):
        return False
    return True


def fence(language: str, code: str) -> str:
    return f"```{FENCE.get(language, language)}\n{code}\n```"


def example(prompt: str, response: str, system: str = "") -> dict:
    payload = {"prompt": prompt, "response": response}
    if system:
        payload["system"] = system
    return payload


# ----------------------------------------------------------- the task catalogue

def from_tasks(rows: list[dict]) -> None:
    """Write-this-for-me, in every language the task was written in."""
    for item in TASKS:
        for language, code in item.code.items():
            spoken = SPOKEN.get(language, language)
            for phrasing in item.phrasings:
                # Half the phrasings name the language, half leave it implied by
                # a preceding "in Rust," — both are how people actually ask.
                rows.append(example(f"{phrasing} in {spoken}", fence(language, code)))
            rows.append(example(f"in {spoken}, {item.phrasings[0]}", fence(language, code)))


def explanations(rows: list[dict]) -> None:
    """Here is code; say what it does."""
    asks = [
        "what does this do?",
        "explain this code",
        "I do not follow this, can you explain it?",
        "what is this function for?",
    ]
    for item in TASKS:
        if not item.explanation:
            continue
        for language, code in item.code.items():
            for ask in asks[:2]:
                rows.append(
                    example(
                        f"{ask}\n\n{fence(language, code)}",
                        f"It {item.name}. {item.explanation}",
                    )
                )


def identifications(rows: list[dict]) -> None:
    """Here is code; name the language."""
    for item in TASKS:
        for language, code in item.code.items():
            spoken = SPOKEN.get(language, language)
            rows.append(
                example(
                    f"what language is this?\n\n```\n{code}\n```",
                    f"{spoken}. It {item.name}.",
                )
            )


def translations(rows: list[dict], limit: int) -> None:
    """The same idea in two languages, which is the pairing a code model wants."""
    asks = [
        "rewrite this in {to}",
        "port this to {to}",
        "what is the {to} equivalent?",
    ]
    for item in TASKS:
        languages = list(item.code)
        for source in languages:
            others = [other for other in languages if other != source][:limit]
            for target in others:
                spoken = SPOKEN.get(target, target)
                for ask in asks:
                    rows.append(
                        example(
                            f"{ask.format(to=spoken)}\n\n{fence(source, item.code[source])}",
                            fence(target, item.code[target]),
                        )
                    )


# ------------------------------------------------------------ the repository

SKIP_NAMES = re.compile(r"^(test_|_)")


def mine_python(rows: list[dict]) -> int:
    """Real functions, with the docstring as the instruction."""
    found = 0
    for directory in ("backend/app", "core/model/codecraft_model", "scripts"):
        for path in sorted((ROOT / directory).rglob("*.py")):
            try:
                source = path.read_text(encoding="utf-8")
                tree = ast.parse(source)
            except (OSError, SyntaxError):
                continue
            lines = source.splitlines()
            # Which functions are methods, so the instruction can say so and the
            # body can be dedented to something that stands on its own.
            methods = {
                child
                for parent in ast.walk(tree)
                if isinstance(parent, ast.ClassDef)
                for child in parent.body
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            }

            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                doc = ast.get_docstring(node)
                if not doc or SKIP_NAMES.match(node.name):
                    continue
                summary = doc.strip().split("\n")[0].rstrip(".")
                if not (20 < len(summary) < 160):
                    continue

                # Decorators sit above the def and belong with it.
                start = min([node.lineno] + [d.lineno for d in node.decorator_list])
                body = textwrap.dedent("\n".join(lines[start - 1 : node.end_lineno]))
                if not (60 < len(body) < 1400):
                    continue
                # A method lifted out of its class is indented and does not
                # parse on its own. Dedenting fixes that; anything still broken
                # is dropped, because a model cannot tell plausible from
                # correct and neither will its output.
                if not parses(body):
                    continue
                kind = "method" if node in methods else "function"

                rows.append(example(f"{summary[0].lower()}{summary[1:]}, in Python",
                                    fence("python", body)))
                rows.append(example(f"write a Python {kind} named {node.name} that "
                                    f"{summary[0].lower()}{summary[1:]}",
                                    fence("python", body)))
                rows.append(example(f"what does this do?\n\n{fence('python', body)}",
                                    summary + "."))

                # The same function with its docstring taken out: the
                # instruction becomes "document this", and the answer is one a
                # person wrote and reviewed.
                stripped = strip_docstring(body)
                if stripped:
                    rows.append(example(
                        f"add a docstring to this\n\n{fence('python', stripped)}",
                        fence("python", body),
                    ))
                    rows.append(example(
                        f"document this function\n\n{fence('python', stripped)}",
                        fence("python", body),
                    ))
                found += 1
    return found


def mine_typescript(rows: list[dict]) -> int:
    """Exported functions whose JSDoc opens with a sentence."""
    pattern = re.compile(
        r"/\*\*\s*\n(?P<doc>(?:\s*\*.*\n)+?)\s*\*/\s*\n"
        r"(?P<code>export (?:async )?function (?P<name>\w+)[\s\S]{40,1200}?\n\})",
        re.M,
    )
    found = 0
    for path in sorted((ROOT / "frontend/src/lib").rglob("*.ts")):
        if path.name.endswith(".test.ts"):
            continue
        for match in pattern.finditer(path.read_text(encoding="utf-8")):
            doc = " ".join(
                line.strip().lstrip("*").strip()
                for line in match.group("doc").splitlines()
            ).strip()
            summary = doc.split(".")[0].strip()
            if not (20 < len(summary) < 160):
                continue
            code = match.group("code")
            rows.append(example(f"{summary[0].lower()}{summary[1:]}, in TypeScript",
                                fence("typescript", code)))
            rows.append(example(f"what does this do?\n\n{fence('typescript', code)}",
                                summary + "."))
            found += 1
    return found


def from_runtimes(rows: list[dict]) -> int:
    """Questions about the editor itself, answered from its own registry."""
    registry = json.loads((ROOT / "scripts/runtimes.json").read_text(encoding="utf-8"))
    entries = registry.get("runtimes", {})
    found = 0
    for identifier, entry in entries.items():
        label = entry.get("label") or identifier
        extension = entry.get("extension", "")
        entry_file = entry.get("entry", "")
        compile_step = entry.get("compile") or []
        run_step = entry.get("run") or []
        template = entry.get("template", "")
        category = entry.get("category", "")

        rows.append(example(
            f"what file extension does {label} use in this editor?",
            f"`.{extension}`, and a new file is created as `{entry_file}`."
            if extension else f"It uses the default entry file, `{entry_file}`.",
        ))
        rows.append(example(
            f"how do I run {label} here?",
            f"Pick {label} in the runtime selector and press Run, or Ctrl+Enter. "
            f"Your entry file is `{entry_file}`.",
        ))
        if compile_step:
            rows.append(example(
                f"how is {label} compiled in this editor?",
                f"`{' '.join(compile_step)}`, then it runs `{' '.join(run_step)}`.",
            ))
        elif run_step:
            rows.append(example(
                f"what command runs {label} here?",
                f"`{' '.join(run_step)}`. Nothing is compiled first; it is "
                f"{category or 'interpreted'}.",
            ))
        if template and len(template) < 900:
            rows.append(example(
                f"give me a hello world in {label}",
                fence(entry.get("monaco", identifier), template.rstrip()),
            ))
            rows.append(example(
                f"what does a new {label} file start with here?",
                f"`{entry_file}`, holding:\n\n"
                + fence(entry.get("monaco", identifier), template.rstrip()),
            ))
        found += 1
    return found


def from_seed(rows: list[dict]) -> int:
    """The hand-written examples, which outrank everything generated.

    Kept in their own file so that regenerating the set cannot quietly discard
    work somebody did by hand — which is exactly what happened the first time
    this generator wrote over the file it was supposed to extend.
    """
    path = Path(__file__).parent / "seed.jsonl"
    if not path.is_file():
        return 0
    found = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if payload.get("prompt") and payload.get("response"):
            rows.append(payload)
            found += 1
    return found


# ------------------------------------------------------------------- assembly

def deduplicate(rows: list[dict]) -> list[dict]:
    """One example per (prompt, response). A repeated pair teaches nothing new."""
    seen: set[tuple[str, str]] = set()
    kept = []
    for row in rows:
        key = (row["prompt"], row["response"])
        if key in seen:
            continue
        seen.add(key)
        kept.append(row)
    return kept


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(Path(__file__).parent / "instructions.jsonl"))
    parser.add_argument("--seed", type=int, default=1337, help="the shuffle is seeded, so the file is reproducible")
    parser.add_argument(
        "--translate-limit",
        type=int,
        default=5,
        help=(
            "how many other languages each implementation is asked to be translated "
            "into. Translation is the cheapest direction to generate and the easiest "
            "to overdo; at 5 it is just under half the set"
        ),
    )
    args = parser.parse_args()

    rows: list[dict] = []
    counts: dict[str, int] = {}

    def mark(name: str, before: int) -> None:
        counts[name] = len(rows) - before

    before = len(rows); from_seed(rows); mark("hand-written", before)
    before = len(rows); from_tasks(rows); mark("write it for me", before)
    before = len(rows); explanations(rows); mark("explain this", before)
    before = len(rows); identifications(rows); mark("name the language", before)
    before = len(rows); translations(rows, args.translate_limit); mark("translate it", before)
    before = len(rows); mine_python(rows); mark("real code, Python", before)
    before = len(rows); mine_typescript(rows); mark("real code, TypeScript", before)
    before = len(rows); from_runtimes(rows); mark("about the editor", before)

    rows = deduplicate(rows)
    random.Random(args.seed).shuffle(rows)

    header = [
        "# Fine-tuning examples for CodeCraft LM. Generated by build.py; edit that,",
        "# not this. Regenerate with: python3 build.py",
        "#",
        f"# {len(rows)} examples, and they are not {len(rows)} independent facts: a few",
        "# hundred pieces of verified material — real functions from this repository,",
        "# the runtime registry, and a hand-written task catalogue — turned into the",
        "# shapes an instruction-tuned model has to recognise. Several phrasings of one",
        "# request map to one answer on purpose: that is how a model learns they are",
        "# one intent. Read the count with that in mind.",
        "#",
        "# By source:",
    ]
    for name, count in counts.items():
        header.append(f"#   {count:>5}  {name}")
    header.append(f"#   {len(rows):>5}  after removing duplicates")

    out = Path(args.out)
    with out.open("w", encoding="utf-8") as handle:
        handle.write("\n".join(header) + "\n")
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    print("\n".join(header[3:]))
    print(f"\nwritten to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
