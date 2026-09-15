"""S24: a thread is a room off the hallway.

A thread is a conversation that hangs off a message. The shape was chosen
because ISOLATION IS FREE — a turn's history is `WHERE m.conversation_id =
$1`, and a thread IS a conversation, so its history is already only its own
messages. Nothing in prompt assembly has to remember to exclude the hallway,
which means nothing can forget to.

This file is the spec's "what refuses when this is wrong" section, made
real. Every one of these is a database predicate or a derived read rather
than a rule somebody follows.
"""

from __future__ import annotations

import asyncio
import uuid

import asyncpg
import pytest

from app import chat, conversations
from tests.conftest import requires_db

pytestmark = requires_db


async def _hallway(pool, person_id) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person_id
    )


async def _message(pool, conversation_id, content="the digest", role="assistant") -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id",
        conversation_id,
        role,
        content,
    )


async def _owner(pool):
    row = await pool.fetchrow("SELECT id, name, role FROM people ORDER BY created_at LIMIT 1")
    return row


class _Person:
    """The two fields `open_thread` reads off a Person."""

    def __init__(self, row):
        self.id = row["id"]
        self.name = row["name"]


# ── one room per message ─────────────────────────────────────────────────


async def test_a_message_has_at_most_one_room_however_fast_you_tap(owner_client, pool):
    """A double-tapped stub must not fork a message into two rooms.

    Enforced by the partial unique index, not by checking first: a
    check-then-insert lets both racers win. `ON CONFLICT` turns the loser
    into a read, so the second tap opens the room the first one made.
    """
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    message_id = await _message(pool, hallway)

    first, created_first = await conversations.open_thread(pool, owner, message_id)
    second, created_second = await conversations.open_thread(pool, owner, message_id)

    assert created_first is True
    assert created_second is False
    assert first["id"] == second["id"]

    rooms = await pool.fetchval(
        "SELECT count(*) FROM conversations WHERE parent_message_id = $1", message_id
    )
    assert rooms == 1


async def test_two_simultaneous_taps_cannot_fork_a_message(owner_client, pool):
    """The same thing, concurrently — which is how a double tap actually
    arrives. The index is what holds here; nothing in python is serialising
    these."""
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    message_id = await _message(pool, hallway)

    results = await asyncio.gather(
        conversations.open_thread(pool, owner, message_id),
        conversations.open_thread(pool, owner, message_id),
    )

    assert {row["id"] for row, _ in results} == {results[0][0]["id"]}
    assert sorted(created for _, created in results) == [False, True]


async def test_the_index_refuses_a_second_room_even_from_raw_sql(owner_client, pool):
    """The guarantee is the database's, not the helper's. A future path that
    inserts a conversation directly is refused too."""
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    message_id = await _message(pool, hallway)
    await conversations.open_thread(pool, owner, message_id)

    with pytest.raises(asyncpg.UniqueViolationError):
        await pool.execute(
            "INSERT INTO conversations (person_id, parent_message_id) VALUES ($1, $2)",
            owner.id,
            message_id,
        )


async def test_threadless_conversations_are_still_unlimited(owner_client, pool):
    """The index is PARTIAL for this reason. Postgres treats NULLs as
    distinct, so a plain unique index would have allowed this anyway — but
    stating it pins that the predicate was not dropped."""
    owner = _Person(await _owner(pool))
    for _ in range(3):
        await _hallway(pool, owner.id)
    count = await pool.fetchval(
        "SELECT count(*) FROM conversations WHERE person_id = $1 AND parent_message_id IS NULL",
        owner.id,
    )
    assert count >= 3


# ── a room is never the hallway ──────────────────────────────────────────


async def test_a_thread_never_becomes_the_active_conversation(owner_client, pool):
    """THE DEFECT THIS PREDICATE EXISTS FOR.

    `active_conversation` takes the NEWEST active row, and `active` defaults
    true — so without `parent_message_id IS NULL` a thread would qualify on
    every other term and be the newest row the moment one is opened.
    `delivery.py`'s chat rung would then deliver the next digest into
    whichever side room was opened last, where he is not looking.
    """
    row = await _owner(pool)
    owner = _Person(row)
    hallway = await _hallway(pool, owner.id)
    message_id = await _message(pool, hallway)
    room, _ = await conversations.open_thread(pool, owner, message_id)

    active = await conversations.active_conversation(pool, owner)

    assert active["id"] != room["id"]
    assert active["id"] == hallway


async def test_a_person_with_only_a_room_still_gets_a_hallway(owner_client, pool):
    """The predicate must not strand somebody: if every conversation they own
    is a room, `active_conversation` opens a new hallway rather than
    returning one."""
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    message_id = await _message(pool, hallway)
    await conversations.open_thread(pool, owner, message_id)
    await pool.execute("UPDATE conversations SET active = false WHERE id = $1", hallway)

    active = await conversations.active_conversation(pool, owner)
    assert active["id"] != hallway
    parent = await pool.fetchval(
        "SELECT parent_message_id FROM conversations WHERE id = $1", active["id"]
    )
    assert parent is None


# ── a room cannot outlive its message ────────────────────────────────────


async def test_clearing_a_conversation_takes_its_rooms_with_it(owner_client, pool):
    """ON DELETE CASCADE. A room hanging off a deleted message is
    unreachable by construction — there is no stub to open it from — so it
    would be a conversation nobody could ever see or delete."""
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    message_id = await _message(pool, hallway)
    room, _ = await conversations.open_thread(pool, owner, message_id)

    await conversations.clear_messages(pool, hallway)

    assert await pool.fetchval("SELECT count(*) FROM conversations WHERE id = $1", room["id"]) == 0


# ── the reply count is derived ───────────────────────────────────────────


async def test_the_reply_count_is_counted_not_stored(owner_client, pool):
    """A stored count drifts the first time a message is written by a path
    that forgets to bump it, and a stub reading "3 replies" over an empty
    room is worse than no stub at all."""
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    message_id = await _message(pool, hallway)
    room, _ = await conversations.open_thread(pool, owner, message_id)

    assert await conversations.thread_reply_counts(pool, hallway) == {message_id: 0}

    await _message(pool, room["id"], "what about it?", role="user")
    await _message(pool, room["id"], "here is what", role="assistant")

    assert await conversations.thread_reply_counts(pool, hallway) == {message_id: 2}


async def test_a_message_with_no_room_is_absent_rather_than_zero(owner_client, pool):
    """Absent, not `0`: "no room here" and "a room nobody has spoken in" are
    different things, and the stub only renders for the second."""
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    plain = await _message(pool, hallway, "just a message")

    assert await conversations.thread_reply_counts(pool, hallway) == {}
    assert plain not in await conversations.thread_reply_counts(pool, hallway)


# ── ownership ────────────────────────────────────────────────────────────


async def test_somebody_elses_message_is_not_found(owner_client, pool):
    """Not forbidden — not found. The same answer `owned_conversation`
    gives, because "not yours" and "not there" are not distinctions this API
    makes."""
    from fastapi import HTTPException

    owner = _Person(await _owner(pool))
    stranger = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('stranger', 'guest') RETURNING id"
    )
    theirs = await _hallway(pool, stranger)
    message_id = await _message(pool, theirs)

    with pytest.raises(HTTPException) as caught:
        await conversations.open_thread(pool, owner, message_id)
    assert caught.value.status_code == 404


# ── the seed ─────────────────────────────────────────────────────────────


async def test_a_room_starts_from_the_message_it_hangs_off(owner_client, pool):
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    message_id = await _message(pool, hallway, "2 timers have failed twice running.")
    room, _ = await conversations.open_thread(pool, owner, message_id)

    seed = await chat.thread_seed(pool, room["id"])

    assert seed[0]["role"] == "system"
    assert "side conversation" in seed[0]["content"]
    assert seed[1] == {"role": "assistant", "content": "2 timers have failed twice running."}


async def test_a_hallway_has_no_seed_at_all(owner_client, pool):
    """One indexed lookup, and nothing changes for an ordinary turn."""
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    assert await chat.thread_seed(pool, hallway) == []


async def test_the_room_carries_the_checks_OWN_facts_not_only_her_prose(owner_client, pool):
    """THE SECOND BLOCKING FINDING of the revision-1 review.

    The parent message is model PROSE. A check composes its finding in code
    — the timer id, the failure count — and those reach the digest as rows,
    surviving into the message only if the model chose to write them. Open a
    room and ask "which timer is failing?" and she would have had her own
    sentence and nothing else. These are the rows, read back through
    `delivered_message_id`.
    """
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    message_id = await _message(pool, hallway, "A couple of your timers keep failing.")
    await pool.execute(
        "INSERT INTO notices (check_name, finding_key, fingerprint, title, facts, "
        "delivered_message_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
        "work_paused_timers",
        "timer:abc",
        "fp-1",
        "the 7am backup has failed twice running",
        '{"timer_id": "abc-123", "consecutive_failures": 2}',
        message_id,
    )
    room, _ = await conversations.open_thread(pool, owner, message_id)

    seed = await chat.thread_seed(pool, room["id"])
    facts = seed[-1]["content"]

    assert seed[-1]["role"] == "system"
    assert "work_paused_timers" in facts
    assert "the 7am backup has failed twice running" in facts
    # The FACT, which her prose never mentioned. This is the whole point.
    assert "abc-123" in facts
    assert "consecutive_failures: 2" in facts


async def test_every_notice_a_digest_carried_reaches_its_room(owner_client, pool):
    """A digest is ONE message about several findings, so a room opened from
    it is a room about the digest. Stated in the spec so nobody files the
    breadth as a bug."""
    owner = _Person(await _owner(pool))
    hallway = await _hallway(pool, owner.id)
    message_id = await _message(pool, hallway, "Two things.")
    for i, (check, key) in enumerate([("a_check", "k1"), ("b_check", "k2")]):
        await pool.execute(
            "INSERT INTO notices (check_name, finding_key, fingerprint, title, facts, "
            "delivered_message_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
            check,
            key,
            f"fp-{i}",
            f"finding {i}",
            "{}",
            message_id,
        )
    room, _ = await conversations.open_thread(pool, owner, message_id)

    facts = (await chat.thread_seed(pool, room["id"]))[-1]["content"]
    assert "a_check" in facts
    assert "b_check" in facts
