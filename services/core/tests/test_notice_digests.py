"""S25 Q4 — "what you were told on Tuesday".

A digest is a GROUP of notices sharing the message that carried them, and it
is never stored: S24 already records `delivered_message_id` on every row, so
a digest row beside it would be a second copy of the same truth, free to
disagree with the notices it claims to contain.

What these pin is mostly about honesty of grouping — that a limit counts
tellings rather than rows (so the oldest group is never shown as a fragment
of itself), and that a notice nobody has been told about belongs to no
group rather than to the most recent one.
"""

from __future__ import annotations

import uuid

from app import notices
from app.checks import Finding
from tests.conftest import requires_db

pytestmark = requires_db

CHECK = "work_paused_timers"


async def _owner(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )


async def _message(pool, person: uuid.UUID, text: str) -> uuid.UUID:
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    return await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content) "
        "VALUES ($1, 'assistant', $2) RETURNING id",
        conversation,
        text,
    )


async def _raise(pool, key: str, title: str | None = None) -> notices.Notice:
    row, _is_new = await notices.record(
        pool,
        Finding(key=key, title=title or f"{key} is true", facts={"timer_id": key}),
        check_name=CHECK,
        turn_id=None,
        firing_id=None,
    )
    return row


async def _told(pool, notice: notices.Notice, message: uuid.UUID) -> None:
    await notices.mark_delivered(
        pool, notice.id, delivery={"chat": {"ok": True}}, message_id=message
    )


async def test_a_digest_is_the_notices_one_message_carried(pool):
    person = await _owner(pool)
    monday = await _message(pool, person, "Two things came up today.")
    tuesday = await _message(pool, person, "One thing came up today.")

    disk = await _raise(pool, "timer:disk")
    cert = await _raise(pool, "timer:cert")
    later = await _raise(pool, "timer:later")
    await _told(pool, disk, monday)
    await _told(pool, cert, monday)
    await _told(pool, later, tuesday)

    groups = await notices.digests(pool)

    # Newest telling first — the order he would read them in.
    assert [g.message_id for g in groups] == [tuesday, monday]
    assert {n.id for n in groups[0].notices} == {later.id}
    assert {n.id for n in groups[1].notices} == {disk.id, cert.id}


async def test_the_limit_counts_TELLINGS_and_never_halves_the_oldest(pool):
    """A row limit would cut the last group in half and present the
    remainder as the whole of it — "on Monday she told you one thing", when
    she told him four. The groups are chosen first, then filled."""
    person = await _owner(pool)
    monday = await _message(pool, person, "Four things came up today.")
    tuesday = await _message(pool, person, "One thing came up today.")
    for n in range(4):
        await _told(pool, await _raise(pool, f"timer:m{n}"), monday)
    await _told(pool, await _raise(pool, "timer:t0"), tuesday)

    both = await notices.digests(pool, limit=2)
    one = await notices.digests(pool, limit=1)

    assert [len(g.notices) for g in both] == [1, 4]
    # One TELLING, whole: the newest, with everything it carried.
    assert [g.message_id for g in one] == [tuesday]
    assert len(one[0].notices) == 1


async def test_a_notice_nobody_was_told_about_belongs_to_no_group(pool):
    """It is not in the newest digest and it is not in any digest. The same
    fact the Inbox renders as a disabled "talk about this" — no message, so
    no telling and no room."""
    person = await _owner(pool)
    monday = await _message(pool, person, "One thing came up today.")
    told = await _raise(pool, "timer:told")
    await _told(pool, told, monday)
    silent = await _raise(pool, "timer:silent")

    groups = await notices.digests(pool)
    waiting = await notices.not_told_yet(pool)

    assert [n.id for g in groups for n in g.notices] == [told.id]
    assert [n.id for n in waiting] == [silent.id]


async def test_a_silenced_row_is_not_waiting_to_be_told(pool):
    """ "Not told yet" is a debt. A condition he asked to stop hearing about
    is not one — it would otherwise sit at the top of the page he opens to
    see what is outstanding, which is the noise this slice removed."""
    hushed = await _raise(pool, "timer:hushed")
    await notices.set_muted(pool, hushed.id, True)
    loud = await _raise(pool, "timer:loud")

    assert [n.id for n in await notices.not_told_yet(pool)] == [loud.id]


async def test_a_cleared_notice_stays_in_the_telling_it_was_part_of(pool):
    """A digest is a record of what he was TOLD, so it does not change when
    the world does. The card still says the condition stopped — that is
    `cleared_at` on the row, which the page renders — but the telling itself
    is history and history does not get edited."""
    person = await _owner(pool)
    monday = await _message(pool, person, "One thing came up today.")
    notice = await _raise(pool, "timer:fixed")
    await _told(pool, notice, monday)
    await notices.clear(pool, notice.id)

    groups = await notices.digests(pool)

    assert [n.id for g in groups for n in g.notices] == [notice.id]
    assert groups[0].notices[0].cleared_at is not None
    # And it is not waiting to be told about: it was told, and it is over.
    assert await notices.not_told_yet(pool) == []


async def test_there_are_no_tellings_before_anything_was_delivered(pool):
    await _raise(pool, "timer:one")

    assert await notices.digests(pool) == []
    assert len(await notices.not_told_yet(pool)) == 1
