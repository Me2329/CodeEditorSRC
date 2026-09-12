"""What a completion is allowed to do to the code around it."""

from codecraft_model.structure import ScopeWatcher


def stream(watcher: ScopeWatcher, text: str, chunk: int = 3) -> tuple[str, bool]:
    """Feed the text in pieces, the way tokens arrive."""
    shown = ""
    for start in range(0, len(text), chunk):
        safe, stop = watcher.feed(text[start : start + chunk])
        shown += safe
        if stop:
            return shown, True
    shown += watcher.flush()
    return shown, False


def test_completion_ends_when_it_leaves_the_block():
    watcher = ScopeWatcher("def f():\n    total = ")
    shown, stopped = stream(watcher, "0\n    return total\n\ndef g():\n    pass")
    assert stopped
    assert watcher.reason == "dedent"
    assert watcher.text == "0\n    return total"
    assert shown == watcher.text


def test_blank_lines_before_the_dedent_go_too():
    watcher = ScopeWatcher("    x = ")
    stream(watcher, "1\n\n\n\nprint(x)")
    assert watcher.text == "1"


def test_a_deeper_line_is_part_of_the_same_answer():
    watcher = ScopeWatcher("    if ready:")
    _, stopped = stream(watcher, "\n        run()\n        log()")
    assert not stopped
    assert watcher.text == "\n        run()\n        log()"


def test_the_same_indent_is_still_the_same_block():
    watcher = ScopeWatcher("    a = 1")
    _, stopped = stream(watcher, "\n    b = 2\n    c = 3")
    assert not stopped


def test_nothing_to_fall_out_of_at_column_zero():
    watcher = ScopeWatcher("x = ")
    _, stopped = stream(watcher, "1\nimport os\ny = 2")
    assert not stopped
    assert watcher.text == "1\nimport os\ny = 2"


def test_a_caret_on_a_blank_line_sets_no_floor():
    watcher = ScopeWatcher("def f():\n    pass\n")
    _, stopped = stream(watcher, "\n\ndef g():\n    pass")
    assert not stopped


def test_it_will_not_close_a_bracket_the_suffix_closes():
    watcher = ScopeWatcher("print(", ")\n")
    shown, stopped = stream(watcher, "value)\nprint(other)")
    assert stopped
    assert watcher.reason == "bracket"
    assert watcher.text == "value"
    assert shown == "value"


def test_brackets_it_opened_itself_may_be_closed():
    watcher = ScopeWatcher("print(", ")\n")
    _, stopped = stream(watcher, "sum([1, 2, 3])")
    assert not stopped
    assert watcher.text == "sum([1, 2, 3])"


def test_the_rule_is_off_when_the_suffix_closes_nothing():
    # Nothing on the right-hand side will close this call, so the model's own
    # closing bracket is the one the code needs.
    watcher = ScopeWatcher("print(", "\nrest_of_file()\n")
    _, stopped = stream(watcher, "value)")
    assert not stopped
    assert watcher.text == "value)"


def test_a_bracket_inside_a_string_closes_nothing():
    watcher = ScopeWatcher("print(", ")")
    _, stopped = stream(watcher, '"a )( b"')
    assert not stopped


def test_a_caret_inside_a_string_is_noticed():
    watcher = ScopeWatcher('    name = "', '")')
    # The first quote ends the string it started in; only then do brackets count.
    _, stopped = stream(watcher, 'hello )')
    assert not stopped


def test_a_bracket_after_a_line_comment_closes_nothing():
    watcher = ScopeWatcher("call(", ")", line_comment="#")
    _, stopped = stream(watcher, "x  # )))")
    assert not stopped


def test_a_comment_ends_at_the_line():
    watcher = ScopeWatcher("call(", ")", line_comment="#")
    _, stopped = stream(watcher, "x  # note\n)")
    assert stopped
    assert watcher.text == "x  # note\n"


def test_whitespace_is_held_back_until_the_line_speaks():
    watcher = ScopeWatcher("    x = ")
    safe, stop = watcher.feed("1\n    ")
    assert not stop
    # The indented line may yet turn out to be a dedent, so it waits.
    assert safe == "1"
    safe, stop = watcher.feed("y")
    assert (safe, stop) == ("\n    y", False)


def test_what_was_held_back_is_released_at_the_end():
    watcher = ScopeWatcher("    x = ")
    watcher.feed("1\n   ")
    assert watcher.flush() == "\n   "
    assert watcher.text == "1\n   "


def test_nothing_more_comes_after_a_stop():
    watcher = ScopeWatcher("    x = ")
    stream(watcher, "1\nprint()")
    assert watcher.feed("more") == ("", True)
    assert watcher.flush() == ""


def test_an_escaped_quote_does_not_open_a_string():
    watcher = ScopeWatcher("call(", ")")
    _, stopped = stream(watcher, '"a\\"b" )')
    assert stopped
    assert watcher.text == '"a\\"b" '


def test_either_rule_can_be_turned_off():
    watcher = ScopeWatcher("    x = ", ")", brackets=False, dedent=False)
    _, stopped = stream(watcher, "1)\nprint()")
    assert not stopped


def test_both_rules_at_once_take_the_earlier_cut():
    watcher = ScopeWatcher("    print(", ")")
    stream(watcher, "a\nb)")
    assert watcher.reason == "dedent"
    assert watcher.text == "a"
