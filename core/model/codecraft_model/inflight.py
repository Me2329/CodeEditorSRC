"""Abandoning work whose answer nobody wants any more.

An editor asking for inline completions sends a request per pause in typing. If
the user keeps typing, the answer to the previous one is already wrong by the
time it arrives. The client abandons it; the server does not, and goes on
holding the model's lock for a suggestion nothing will show.

That is the whole problem: generation is serialised, so an obsolete request is
not merely wasted, it is *in front of* the one that matters. A three-keystroke
burst can leave the useful request waiting behind two dead ones.

The fix is to let a newer request cancel an older one from the same source. Not
every older one: two different editors, or a completion and a chat, are separate
conversations and neither supersedes the other. That is what the key is for.

A cancelled generation stops at the next token rather than being killed, because
there is nothing to kill: it is a loop holding tensors, and the only safe place
to stop is between steps.
"""

from __future__ import annotations

import threading


class Ticket:
    """A running request, and whether anyone still wants its answer."""

    __slots__ = ("key", "cancelled")

    def __init__(self, key: str) -> None:
        self.key = key
        self.cancelled = False

    def __bool__(self) -> bool:
        """True while the answer is still wanted, so `while ticket:` reads right."""
        return not self.cancelled


class Supersede:
    """Keeps one live request per key, cancelling the one it replaces."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.live: dict[str, Ticket] = {}
        self.superseded = 0

    def begin(self, key: str) -> Ticket:
        """Start a request, cancelling any older one from the same source."""
        ticket = Ticket(key)
        with self.lock:
            previous = self.live.get(key)
            if previous is not None and not previous.cancelled:
                previous.cancelled = True
                self.superseded += 1
            self.live[key] = ticket
        return ticket

    def end(self, ticket: Ticket) -> None:
        """Finish a request.

        Only clears the slot if this ticket still holds it: a request that was
        superseded must not remove the newer one that replaced it, which is the
        kind of bug that shows up as one request in twenty being cancelled for
        no reason.
        """
        with self.lock:
            if self.live.get(ticket.key) is ticket:
                del self.live[ticket.key]

    def cancel(self, key: str) -> bool:
        """Cancel whatever is running for a key. True if something was."""
        with self.lock:
            ticket = self.live.get(key)
            if ticket is None or ticket.cancelled:
                return False
            ticket.cancelled = True
            self.superseded += 1
            return True

    def cancel_all(self) -> int:
        with self.lock:
            count = 0
            for ticket in self.live.values():
                if not ticket.cancelled:
                    ticket.cancelled = True
                    count += 1
            self.superseded += count
            return count

    @property
    def running(self) -> int:
        with self.lock:
            return len(self.live)
