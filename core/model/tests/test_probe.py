"""The fixed questions, and how the answers are presented."""

import json

import pytest

from pathlib import Path

from codecraft_model.probe import (
    Answer,
    Case,
    DEFAULT_CASES,
    caret_line,
    labels,
    load_cases,
    report,
    show,
    summarise,
)


def answer(name: str, completion: str, *, tokens: int = 4, confidence: float = -1.0,
           trimmed: str | None = None) -> Answer:
    return Answer(case=name, completion=completion, tokens=tokens,
                  confidence=confidence, trimmed=trimmed)


def test_the_built_in_cases_are_carets_in_the_middle_of_something():
    cases = load_cases(None)
    assert len(cases) == len(DEFAULT_CASES)
    # A caret with nothing after it is a prompt, not a caret, and the point of
    # the set is that the model has to fit between two sides.
    assert all(case.suffix for case in cases)
    assert all(case.name for case in cases)


def test_cases_come_from_a_file_when_one_is_given(tmp_path):
    path = tmp_path / "cases.json"
    path.write_text(json.dumps([{"name": "mine", "prefix": "a(", "suffix": ")"}]))

    cases = load_cases(path)

    assert [case.name for case in cases] == ["mine"]
    assert cases[0].prefix == "a("


def test_a_case_without_a_name_is_numbered(tmp_path):
    path = tmp_path / "cases.json"
    path.write_text(json.dumps([{"prefix": "a"}, {"prefix": "b"}]))

    assert [case.name for case in load_cases(path)] == ["case 1", "case 2"]


def test_a_case_with_no_prefix_is_refused(tmp_path):
    path = tmp_path / "cases.json"
    path.write_text(json.dumps([{"suffix": ")"}]))

    with pytest.raises(ValueError, match="case 1"):
        load_cases(path)


def test_an_empty_file_is_refused(tmp_path):
    path = tmp_path / "cases.json"
    path.write_text("[]")

    with pytest.raises(ValueError, match="non-empty"):
        load_cases(path)


def test_something_that_is_not_a_list_is_refused(tmp_path):
    path = tmp_path / "cases.json"
    path.write_text('{"prefix": "a"}')

    with pytest.raises(ValueError):
        load_cases(path)


def test_the_caret_line_is_the_line_it_sits_on():
    case = Case(name="x", prefix="def f():\n    return ", suffix="\n")
    assert caret_line(case) == "    return "


def test_a_caret_on_a_blank_line_is_reported_by_column():
    case = Case(name="x", prefix="def f():\n    ", suffix="\n")
    assert caret_line(case) == "(column 5)"


def test_line_breaks_are_shown_rather_than_taken():
    # The failure being looked for is a completion that leaves the block, and
    # printing it over four lines is exactly what hides that.
    assert show("a\n    b") == "a\\n    b"


def test_a_backslash_is_not_mistaken_for_an_escape():
    assert show("a\\nb") == "a\\\\nb"


def test_nothing_is_said_to_be_nothing():
    assert show("") == "(nothing)"


def test_a_long_answer_is_cut_to_the_width():
    assert len(show("x" * 200, width=20)) == 20
    assert show("x" * 200, width=20).endswith("…")


def test_a_report_counts_what_matters_about_a_run():
    summary = report([
        answer("a", "x"),
        answer("b", "   ", tokens=2),
        answer("c", "y", trimmed="dedent"),
    ])

    assert summary["cases"] == 3
    assert summary["empty"] == 1
    assert summary["trimmed"] == 1
    assert summary["tokens"] == 10
    assert summary["answers"][2]["trimmed"] == "dedent"


def test_the_summary_line_says_the_same_thing_in_words():
    line = summarise([answer("a", "x", confidence=-1.0), answer("b", "", confidence=-2.0)])

    assert "2 cases" in line
    assert "1 empty" in line
    assert "-1.500" in line


def test_an_empty_run_has_nothing_to_summarise():
    assert summarise([]) == "no cases"


def test_runs_are_labelled_by_their_directory_name():
    assert labels([Path("runs/fim"), Path("runs/fim2")]) == ["fim", "fim2"]


def test_two_runs_with_the_same_name_are_told_apart_by_path():
    assert labels([Path("a/run"), Path("b/run")]) == ["a/run", "b/run"]


def test_a_run_compared_with_itself_gets_two_distinguishable_rows():
    # Two rows labelled the same would fold into one, and comparing a run with
    # itself is how the probe is checked for determinism.
    assert labels([Path("runs/fim"), Path("runs/fim")]) == ["runs/fim", "runs/fim (2)"]
