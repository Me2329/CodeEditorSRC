"""Stopping on text rather than on a token.

A stop token works when the model was trained to emit one. Everything else needs
stopping on what the text says: an editor wants a completion to end at the next
blank line, a chat client wants generation to stop before the model writes the
user's next turn, and a template wants it to stop at a closing delimiter.

The whole difficulty is that tokens are not characters. A stop sequence of
"\\n\\n" can arrive as one token, as two, or as the tail of one token and the head
of the next, so a check that looks at each delta on its own misses it about as
often as it catches it. The text has to be accumulated and matched across the
joins.

The second difficulty follows from the first: a streaming caller must not be
shown text that turns out to be the beginning of a stop sequence. So the last
few characters are held back until they are known not to be, and released when
the generation ends without matching.
"""

from __future__ import annotations


class StopWatcher:
    """Accumulates generated text and reports where it should end."""

    def __init__(self, stops: list[str] | tuple[str, ...] = ()) -> None:
        # Empty strings would match everywhere and stop everything immediately.
        self.stops = [stop for stop in stops if stop]
        self.longest = max((len(stop) for stop in self.stops), default=0)
        self.buffer = ""
        self.emitted = 0
        self.stopped = False
        self.matched: str | None = None

    def feed(self, text: str) -> tuple[str, bool]:
        """Take more generated text.

        Returns the part safe to show now, and whether generation should stop.
        The safe part excludes any tail that could still turn out to be the
        start of a stop sequence.
        """
        if self.stopped:
            return "", True
        if not self.stops:
            self.buffer += text
            self.emitted = len(self.buffer)
            return text, False

        self.buffer += text

        earliest: int | None = None
        for stop in self.stops:
            found = self.buffer.find(stop)
            if found != -1 and (earliest is None or found < earliest):
                earliest = found
                self.matched = stop

        if earliest is not None:
            self.stopped = True
            safe = self.buffer[self.emitted : earliest]
            self.emitted = earliest
            return safe, True

        # Hold back what could still become a stop sequence. One character short
        # of the longest stop is enough: anything longer than that would have
        # matched already.
        keep = max(0, len(self.buffer) - (self.longest - 1))
        safe = self.buffer[self.emitted : keep]
        self.emitted = max(self.emitted, keep)
        return safe, False

    def flush(self) -> str:
        """Release what was held back, once nothing more is coming."""
        if self.stopped:
            return ""
        tail = self.buffer[self.emitted :]
        self.emitted = len(self.buffer)
        return tail

    @property
    def text(self) -> str:
        """Everything that should be shown, stop sequence excluded."""
        return self.buffer[: self.emitted] if self.stopped else self.buffer
