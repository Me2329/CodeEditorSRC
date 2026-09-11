"""Stopping on text, across the joins between tokens."""

from __future__ import annotations

from codecraft_model.stopping import StopWatcher


def feed_all(watcher: StopWatcher, pieces: list[str]) -> tuple[str, bool]:
    """Feed every piece, returning what was shown and whether it stopped."""
    shown = ""
    for piece in pieces:
        safe, stop = watcher.feed(piece)
        shown += safe
        if stop:
            return shown, True
    return shown + watcher.flush(), False


def test_text_with_no_stops_passes_straight_through() -> None:
    watcher = StopWatcher()

    assert feed_all(watcher, ["def ", "f():", "\n"]) == ("def f():\n", False)


def test_a_stop_inside_one_piece_is_caught() -> None:
    watcher = StopWatcher(["\n\n"])

    assert feed_all(watcher, ["one\n\ntwo"]) == ("one", True)


def test_a_stop_split_across_two_pieces_is_caught() -> None:
    """The case a per-delta check misses about half the time."""
    watcher = StopWatcher(["\n\n"])

    assert feed_all(watcher, ["one\n", "\ntwo"]) == ("one", True)


def test_a_stop_split_across_three_pieces_is_caught() -> None:
    watcher = StopWatcher(["END"])

    assert feed_all(watcher, ["text E", "N", "D more"]) == ("text ", True)


def test_nothing_is_shown_that_turns_out_to_be_a_stop() -> None:
    """A streaming caller must not print half a stop sequence and take it back."""
    watcher = StopWatcher(["END"])

    shown, stopped = watcher.feed("text EN")
    assert shown == "text "
    assert not stopped

    shown, stopped = watcher.feed("D")
    assert shown == ""
    assert stopped


def test_what_was_held_back_is_released_at_the_end() -> None:
    watcher = StopWatcher(["END"])
    watcher.feed("almost EN")

    assert watcher.flush() == "EN"


def test_the_earliest_stop_wins() -> None:
    watcher = StopWatcher(["\n\n", "END"])

    assert feed_all(watcher, ["a END b\n\n c"]) == ("a ", True)


def test_which_stop_matched_is_recorded() -> None:
    watcher = StopWatcher(["</html>", "\n\n"])
    feed_all(watcher, ["some text\n\nmore"])

    assert watcher.matched == "\n\n"


def test_feeding_after_a_stop_shows_nothing_more() -> None:
    watcher = StopWatcher(["X"])
    watcher.feed("aXb")

    assert watcher.feed("more") == ("", True)


def test_an_empty_stop_is_ignored() -> None:
    """It would match at position zero and stop every generation immediately."""
    watcher = StopWatcher(["", "END"])

    assert feed_all(watcher, ["hello END"]) == ("hello ", True)


def test_the_full_text_is_available_afterwards() -> None:
    watcher = StopWatcher(["END"])
    feed_all(watcher, ["one two END three"])

    assert watcher.text == "one two "


def test_text_without_a_stop_is_all_of_it() -> None:
    watcher = StopWatcher(["END"])
    feed_all(watcher, ["one two three"])

    assert watcher.text == "one two three"


def test_a_stop_at_the_very_start_shows_nothing() -> None:
    watcher = StopWatcher(["END"])

    assert feed_all(watcher, ["END of it"]) == ("", True)


def test_a_long_stop_holds_back_more() -> None:
    watcher = StopWatcher(["<|verylongmarker|>"])
    shown, _ = watcher.feed("hello")

    # Everything is held back: the whole of it could still be the start.
    assert shown == ""
    assert watcher.flush() == "hello"
