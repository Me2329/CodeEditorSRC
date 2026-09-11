"""Noticing that a checkpoint has been replaced.

Training writes a new checkpoint every time the validation loss improves. A
server started before that has the old weights and keeps them until somebody
restarts it, which means the obvious way to watch a run get better is to keep
restarting the thing you are testing with.

Watching the file is easy. Doing it safely is the part worth writing down: a
checkpoint being written is a checkpoint that is half there, and loading one is
either an exception or, worse, weights that load and are wrong. `torch.save`
writes in place rather than atomically, so the only signal available from
outside is that the file has stopped changing.

So a change is acted on only after the file has been the same size and mtime
for a whole poll interval. That costs one interval of latency and removes the
entire class of problem.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Stamp:
    """What a file looked like, as far as this can tell from outside."""

    size: int
    mtime: float

    @classmethod
    def of(cls, path: Path) -> "Stamp | None":
        try:
            info = path.stat()
        except OSError:
            # Missing, or being replaced. Either way there is nothing to load.
            return None
        return cls(info.st_size, info.st_mtime)


class Watcher:
    """Reports when a file has changed and settled.

    Deliberately not a filesystem notification: those fire on the first byte
    written, which is the moment the file is least safe to read.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.current = Stamp.of(path)
        # A change seen but not yet confirmed still.
        self.pending: Stamp | None = None
        self.reloads = 0

    def poll(self) -> bool:
        """Call on an interval. True when the file has changed and settled."""
        seen = Stamp.of(self.path)
        if seen is None or seen == self.current:
            self.pending = None
            return False

        if self.pending is None or self.pending != seen:
            # First sight of this version, or it is still being written. Wait
            # for it to look the same twice.
            self.pending = seen
            return False

        self.current = seen
        self.pending = None
        self.reloads += 1
        return True
