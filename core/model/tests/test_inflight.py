"""Superseding requests whose answers nobody wants any more."""

from __future__ import annotations

import threading

from codecraft_model.inflight import Supersede, Ticket


def test_a_new_request_cancels_the_one_it_replaces() -> None:
    registry = Supersede()

    first = registry.begin("editor")
    second = registry.begin("editor")

    assert first.cancelled
    assert not second.cancelled


def test_a_ticket_reads_as_true_while_it_is_wanted() -> None:
    ticket = Ticket("k")

    assert ticket
    ticket.cancelled = True
    assert not ticket


def test_different_sources_do_not_supersede_each_other() -> None:
    """A completion and a chat are separate conversations."""
    registry = Supersede()

    completion = registry.begin("infill")
    chat = registry.begin("messages")

    assert not completion.cancelled
    assert not chat.cancelled


def test_finishing_removes_the_request() -> None:
    registry = Supersede()
    ticket = registry.begin("editor")

    registry.end(ticket)

    assert registry.running == 0


def test_a_superseded_request_does_not_remove_its_successor() -> None:
    """The bug this prevents shows up as one request in twenty cancelled for no
    reason: the old one finishes last and clears the slot the new one is in."""
    registry = Supersede()
    first = registry.begin("editor")
    second = registry.begin("editor")

    registry.end(first)

    assert registry.running == 1
    assert not second.cancelled


def test_how_many_were_superseded_is_counted() -> None:
    registry = Supersede()
    for _ in range(4):
        registry.begin("editor")

    assert registry.superseded == 3


def test_cancelling_a_key_stops_it() -> None:
    registry = Supersede()
    ticket = registry.begin("editor")

    assert registry.cancel("editor") is True
    assert ticket.cancelled


def test_cancelling_nothing_says_so() -> None:
    registry = Supersede()

    assert registry.cancel("nobody") is False


def test_cancelling_twice_counts_once() -> None:
    registry = Supersede()
    registry.begin("editor")

    registry.cancel("editor")
    registry.cancel("editor")

    assert registry.superseded == 1


def test_everything_can_be_cancelled_at_once() -> None:
    registry = Supersede()
    tickets = [registry.begin(str(index)) for index in range(3)]

    assert registry.cancel_all() == 3
    assert all(ticket.cancelled for ticket in tickets)


def test_concurrent_starts_leave_exactly_one_live() -> None:
    """The registry is shared between request threads, so the lock has to hold."""
    registry = Supersede()
    tickets: list[Ticket] = []
    barrier = threading.Barrier(8)

    def start() -> None:
        barrier.wait()
        tickets.append(registry.begin("editor"))

    threads = [threading.Thread(target=start) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert registry.running == 1
    assert sum(1 for ticket in tickets if not ticket.cancelled) == 1
