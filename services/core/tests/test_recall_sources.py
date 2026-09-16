"""The trace answers "where did that sentence come from" (2026-09-16).

The recall span recorded `hits: 4` — a count of an answer rather than the
answer. That gap cost a wrong diagnosis during the S28 walk: a sentence she
kept repeating looked like conversation history repeating itself, and only a
hand-built probe (clear the conversation, ask again, watch it say the same
thing) showed it was a recalled JOURNAL line. Memory is not
per-conversation, so a clean transcript proves nothing on its own.

With the paths on the span, that question is one query against the ledger
instead of an afternoon.
"""

from __future__ import annotations

from app.chat import recalled_sources


def test_a_hit_is_named_by_its_path():
    got = recalled_sources(
        [
            {"path": "people/p1/journals/2026-09-16.md#20:48", "snippet": "…"},
            {"path": "people/p1/topics/the-roof.md", "snippet": "…"},
        ]
    )

    assert got == ["people/p1/journals/2026-09-16.md#20:48", "people/p1/topics/the-roof.md"]


def test_paths_never_bodies():
    """The note already lives in memory. Copying its text into the trace is a
    second copy free to drift, and a long note would bloat every turn's
    ledger — a path identifies it and memory can be asked for the rest."""
    got = recalled_sources([{"path": "people/p1/topics/x.md", "snippet": "a very long note" * 50}])

    assert got == ["people/p1/topics/x.md"]
    assert not any("long note" in entry for entry in got)


def test_a_hit_with_no_path_falls_back_to_what_it_does_name():
    """Memory's shape is memory's to choose. A hit that names a document or a
    title is still identifiable; one that names nothing is skipped rather
    than recorded as an empty string, which would read as a note with no
    name rather than as no note."""
    got = recalled_sources(
        [
            {"document": "people/p1/journals/2026-09-01.md", "snippet": "…"},
            {"title": "the backup topic"},
            {"snippet": "no identifier at all"},
            "a bare string, which older memory could return",
        ]
    )

    assert got == ["people/p1/journals/2026-09-01.md", "the backup topic"]


def test_nothing_recalled_names_nothing():
    assert recalled_sources([]) == []


# -- on the span, through the real recall path ------------------------------------

import uuid  # noqa: E402

from tests.conftest import requires_db  # noqa: E402
from tests.fakes import FakeGateway, FakeMemory  # noqa: E402
from tests.test_chat import _say  # noqa: E402

pytestmark = requires_db


async def test_the_span_names_the_notes_that_were_recalled(owner_client, pool, mount_peers):
    """The question this exists for — "did she get that from a note, and
    which one" — answered off the ledger rather than by rebuilding the
    conversation and asking again."""
    memory = FakeMemory(
        results=(
            {"path": "people/p1/journals/2026-09-16.md#20:48", "snippet": "something she said"},
            {"path": "people/p1/topics/the-roof.md", "snippet": "the roof leaks"},
        )
    )
    mount_peers(gateway=FakeGateway(deltas=("ok",)), memory=memory)

    status, _ = await _say(owner_client, "what did I say about the roof?")

    assert status == 200
    span = await pool.fetchrow(
        "SELECT meta FROM turn_spans WHERE kind = 'memory_recall' ORDER BY started_at DESC LIMIT 1"
    )
    assert span["meta"]["hits"] == 2
    assert span["meta"]["recalled"] == [
        "people/p1/journals/2026-09-16.md#20:48",
        "people/p1/topics/the-roof.md",
    ]


async def test_a_turn_that_recalled_nothing_says_nothing(owner_client, pool, mount_peers):
    """An empty key on every turn with no notes is noise in the ledger, and
    "recalled: []" reads as a recall that ran and found nothing — which is
    already `hits: 0`."""
    mount_peers(gateway=FakeGateway(deltas=("ok",)), memory=FakeMemory(results=()))

    await _say(owner_client, "hello")

    span = await pool.fetchrow(
        "SELECT meta FROM turn_spans WHERE kind = 'memory_recall' ORDER BY started_at DESC LIMIT 1"
    )
    assert "recalled" not in span["meta"]
