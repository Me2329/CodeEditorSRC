"""Noticing a checkpoint has been replaced, without reading it half-written."""

from __future__ import annotations

import os

from codecraft_model.reload import Stamp, Watcher


def write(path, text: str, mtime: float) -> None:
    path.write_text(text)
    os.utime(path, (mtime, mtime))


def test_an_unchanged_file_is_not_a_change(tmp_path) -> None:
    path = tmp_path / "model.pt"
    write(path, "one", 1000)
    watcher = Watcher(path)

    assert watcher.poll() is False
    assert watcher.poll() is False


def test_a_change_is_reported_once_it_has_settled(tmp_path) -> None:
    """Not on the first sight of it: a file being written is half there."""
    path = tmp_path / "model.pt"
    write(path, "one", 1000)
    watcher = Watcher(path)

    write(path, "two longer", 2000)
    assert watcher.poll() is False  # Seen, not yet trusted.
    assert watcher.poll() is True


def test_a_file_still_being_written_is_not_reported(tmp_path) -> None:
    """The whole point: torch.save writes in place, so a growing file is a
    checkpoint that would load as wrong weights."""
    path = tmp_path / "model.pt"
    write(path, "one", 1000)
    watcher = Watcher(path)

    write(path, "growing", 2000)
    assert watcher.poll() is False
    write(path, "growing more", 3000)
    assert watcher.poll() is False
    write(path, "growing more still", 4000)
    assert watcher.poll() is False

    assert watcher.poll() is True


def test_a_change_is_reported_only_once(tmp_path) -> None:
    path = tmp_path / "model.pt"
    write(path, "one", 1000)
    watcher = Watcher(path)

    write(path, "two", 2000)
    watcher.poll()

    assert watcher.poll() is True
    assert watcher.poll() is False


def test_several_changes_are_each_reported(tmp_path) -> None:
    path = tmp_path / "model.pt"
    write(path, "one", 1000)
    watcher = Watcher(path)

    for index, mtime in enumerate((2000, 3000, 4000), start=1):
        write(path, f"version {index}", mtime)
        watcher.poll()
        assert watcher.poll() is True

    assert watcher.reloads == 3


def test_a_missing_file_is_not_a_change(tmp_path) -> None:
    """Missing or being replaced; either way there is nothing to load."""
    path = tmp_path / "model.pt"
    write(path, "one", 1000)
    watcher = Watcher(path)

    path.unlink()

    assert watcher.poll() is False
    assert watcher.poll() is False


def test_a_file_that_appears_later_is_picked_up(tmp_path) -> None:
    path = tmp_path / "model.pt"
    watcher = Watcher(path)

    write(path, "first", 1000)
    watcher.poll()

    assert watcher.poll() is True


def test_a_file_rewritten_to_the_same_size_is_still_a_change(tmp_path) -> None:
    """Training writes checkpoints of identical size every time."""
    path = tmp_path / "model.pt"
    write(path, "same size!", 1000)
    watcher = Watcher(path)

    write(path, "same size!", 2000)
    watcher.poll()

    assert watcher.poll() is True


def test_a_stamp_of_nothing_is_nothing(tmp_path) -> None:
    assert Stamp.of(tmp_path / "absent") is None
