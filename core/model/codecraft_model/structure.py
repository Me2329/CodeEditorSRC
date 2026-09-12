"""Stopping on the shape of the code rather than on what it says.

A stop sequence ends a completion at text the model wrote. This ends one at
structure the model broke. The two failures it catches are the two a small
model makes constantly at a caret, and neither of them contains any particular
string to watch for:

  * It closes a bracket the suffix already closes, so accepting the suggestion
    leaves `foo(a, b))` behind.
  * It finishes the line it was asked for and then keeps going — out of the
    function, into a new `def`, or into prose it remembers from somewhere else
    in its training data. An inline suggestion is an answer to the caret, not
    the rest of the file.

Both are decided from the text as it arrives, so generation stops at the token
that broke the structure rather than after the whole budget is spent.

The interface mirrors `StopWatcher` on purpose: same `feed`, same `flush`, same
`text`, so a caller can run both over the same stream and keep whichever cut
comes first. Neither knows about the other.
"""

from __future__ import annotations

CLOSERS = ")]}"
OPENERS = "([{"
QUOTES = "\"'`"


def _leading_closers(suffix: str) -> int:
    """How many brackets the suffix closes before it says anything else."""
    count = 0
    for char in suffix:
        if char in CLOSERS:
            count += 1
        elif char.isspace():
            continue
        else:
            break
    return count


def _indent_of(line: str) -> int:
    """The column the line's first non-space character sits at, tabs as one."""
    return len(line) - len(line.lstrip())


def _open_quote(line: str) -> str | None:
    """Which quote the caret sits inside, judged from its own line.

    Wrong for a string that began on an earlier line, and deliberately so: a
    guess that says "not in a string" costs at most a stop that should not have
    happened, while scanning the whole prefix costs it on every keystroke.
    """
    quote: str | None = None
    escaped = False
    for char in line:
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
        elif quote is not None:
            if char == quote:
                quote = None
        elif char in QUOTES:
            quote = char
    return quote


class ScopeWatcher:
    """Reports where a completion stops belonging to the caret it started at."""

    def __init__(
        self,
        prefix: str,
        suffix: str = "",
        *,
        brackets: bool = True,
        dedent: bool = True,
        line_comment: str | None = None,
    ) -> None:
        caret_line = prefix[prefix.rfind("\n") + 1 :]

        # The bracket rule applies only when the suffix already closes what the
        # prefix opened, which is the normal case at a caret in an editor that
        # closes brackets as you type. When it does not, a closing bracket in
        # the completion is the one the code needs and cutting it is the bug.
        self.brackets = brackets and _leading_closers(suffix) > 0

        # Indentation of the line the caret is on, whether or not the caret has
        # reached its end. At column zero there is nothing to fall out of, so
        # the rule turns itself off rather than firing on every line.
        self.floor = _indent_of(caret_line) if caret_line.strip() else 0
        self.dedent = dedent and self.floor > 0

        self.line_comment = line_comment
        self.buffer = ""
        self.emitted = 0
        self.stopped = False
        self.reason: str | None = None
        self.cut = 0

        self._depth = 0
        self._quote = _open_quote(caret_line)
        self._escaped = False
        self._commented = False
        # Everything below describes the line being read now: whether it has
        # said anything yet, and where the run of blank lines before it began.
        self._line_has_content = bool(caret_line.strip())
        self._indent = 0
        self._measuring = False
        self._blank_since: int | None = None

    def feed(self, text: str) -> tuple[str, bool]:
        """Take more generated text.

        Returns the part safe to show now and whether generation should stop.
        Held back: a trailing run of whitespace after a newline, because the
        line it starts may turn out to be one that ends the completion.
        """
        if self.stopped:
            return "", True

        for char in text:
            index = len(self.buffer)
            self.buffer += char
            if self._consume(char, index):
                self.stopped = True
                self.cut = min(self.cut, len(self.buffer))
                safe = self.buffer[self.emitted : self.cut]
                self.emitted = self.cut
                return safe, True

        keep = self._safe_upto()
        safe = self.buffer[self.emitted : keep]
        self.emitted = max(self.emitted, keep)
        return safe, False

    def _safe_upto(self) -> int:
        """The end of what cannot still turn out to be cut away."""
        if self._measuring and self._blank_since is not None:
            return self._blank_since
        return len(self.buffer)

    def _consume(self, char: str, index: int) -> bool:
        """Read one character. True when the completion should end."""
        if char == "\n":
            if self._blank_since is None or self._line_has_content:
                self._blank_since = index
            self._line_has_content = False
            self._indent = 0
            self._measuring = True
            self._commented = False
            # A quote that never closed was a quote the model got wrong, not a
            # string spanning lines. Believing it would switch every rule off
            # for the rest of the completion.
            if self._quote is not None and self._quote * 3 not in self.buffer:
                self._quote = None
            return False

        if self._measuring:
            if char.isspace():
                self._indent += 1
                return False
            self._measuring = False
            if self.dedent and self._indent < self.floor and self._quote is None:
                self.reason = "dedent"
                self.cut = self._blank_since if self._blank_since is not None else index
                return True

        if not char.isspace():
            self._line_has_content = True
            self._blank_since = None

        if self._escaped:
            self._escaped = False
            return False
        if self._commented:
            return False
        if char == "\\":
            self._escaped = True
            return False
        if self._quote is not None:
            if char == self._quote:
                self._quote = None
            return False
        if char in QUOTES:
            self._quote = char
            return False
        if self.line_comment and self.buffer.endswith(self.line_comment):
            self._commented = True
            return False

        if char in OPENERS:
            self._depth += 1
        elif char in CLOSERS:
            self._depth -= 1
            if self.brackets and self._depth < 0:
                self.reason = "bracket"
                self.cut = index
                return True
        return False

    def flush(self) -> str:
        """Release what was held back, once nothing more is coming."""
        if self.stopped:
            return ""
        tail = self.buffer[self.emitted :]
        self.emitted = len(self.buffer)
        return tail

    @property
    def text(self) -> str:
        """Everything that belongs to the caret, and nothing after it."""
        return self.buffer[: self.cut] if self.stopped else self.buffer
