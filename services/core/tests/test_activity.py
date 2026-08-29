"""GET /api/v1/activity — the operator's read-only window into the turn
ledger. Every assertion here works against rows this suite inserts itself
(directly, or through traces.py exactly like test_traces.py does), because
the API must report EXACTLY what is in the ledger: an unfinished turn's
NULL status must reach the client as null, never coerced to ok/error, and
a count the ledger has no evidence for must never be invented.
"""
from __future__ import annotations

import uuid

from tests.conftest import requires_db

pytestmark = requires_db


async def _person(pool) -> uuid.UUID:
    # 'adult', not 'owner' — the owner_client fixture already registered
    # the one owner this schema allows (people_one_owner).
    return await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('someone', 'adult') RETURNING id"
    )


async def _conversation(pool, person) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )


async def _turn_at(
    pool, conversation, *, started_offset_secs: float, model="qwen3:8b"
) -> uuid.UUID:
    """A turn whose started_at is explicit, so ordering is deterministic."""
    return await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model, started_at) "
        "VALUES ('chat', $1, $2, now() + make_interval(secs => $3)) RETURNING id",
        conversation,
        model,
        started_offset_secs,
    )


async def _close(pool, turn_id, status="ok", *, ended_offset_secs: float | None = None) -> None:
    if ended_offset_secs is None:
        await pool.execute(
            "UPDATE turns SET status = $2, ended_at = now() WHERE id = $1", turn_id, status
        )
    else:
        await pool.execute(
            "UPDATE turns SET status = $2, "
            "ended_at = now() + make_interval(secs => $3) WHERE id = $1",
            turn_id,
            status,
            ended_offset_secs,
        )


async def _span(pool, turn_id, kind, name=None, *, duration_ms=10, meta=None) -> None:
    await pool.execute(
        "INSERT INTO turn_spans (turn_id, kind, name, duration_ms, meta) "
        "VALUES ($1, $2, $3, $4, $5::jsonb)",
        turn_id,
        kind,
        name,
        duration_ms,
        meta or {},
    )


# -- auth --------------------------------------------------------------


async def test_activity_needs_an_identity(client):
    assert (await client.get("/api/v1/activity")).status_code == 401
    assert (await client.get(f"/api/v1/activity/{uuid.uuid4()}")).status_code == 401


# -- summary math --------------------------------------------------------


async def test_a_closed_turn_reports_its_counts_and_duration(owner_client, pool):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    turn = await _turn_at(pool, conversation, started_offset_secs=0)
    await _span(pool, turn, "llm_call", "qwen3:8b", meta={"round": 1})
    await _span(pool, turn, "llm_call", "qwen3:8b", meta={"round": 2})
    await _span(pool, turn, "tool", "get_time", meta={"ok": True})
    await _close(pool, turn, "ok", ended_offset_secs=5)

    resp = await owner_client.get("/api/v1/activity")
    assert resp.status_code == 200
    rows = resp.json()["turns"]
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == str(turn)
    assert row["kind"] == "chat"
    assert row["model"] == "qwen3:8b"
    assert row["status"] == "ok"
    assert row["conversation_id"] == str(conversation)
    assert row["tool_call_count"] == 1
    assert row["llm_round_count"] == 2
    # ~5000ms, allowing for the make_interval/now() clock skew inherent in
    # comparing two independently-computed "now()" calls.
    assert 4500 <= row["duration_ms"] <= 5500


async def test_an_unfinished_turn_reports_null_never_a_guess(owner_client, pool):
    """The whole point of the ledger: an abandoned turn must look abandoned."""
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    await _turn_at(pool, conversation, started_offset_secs=0)
    # Never closed — status and ended_at stay NULL.

    rows = (await owner_client.get("/api/v1/activity")).json()["turns"]
    assert len(rows) == 1
    assert rows[0]["status"] is None
    assert rows[0]["duration_ms"] is None


async def test_a_turn_with_no_spans_reports_zero_counts_not_absence(owner_client, pool):
    """Zero is a real count (the ledger looked and found nothing) — this is
    the one place a 0 is honest, because a LEFT JOIN with nothing to join
    must not come back as null."""
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    turn = await _turn_at(pool, conversation, started_offset_secs=0)
    await _close(pool, turn, "error")

    rows = (await owner_client.get("/api/v1/activity")).json()["turns"]
    assert rows[0]["tool_call_count"] == 0
    assert rows[0]["llm_round_count"] == 0


async def test_a_conversationless_turn_reports_a_null_conversation_id(owner_client, pool):
    turn = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model) VALUES ('chat', NULL, 'm') RETURNING id"
    )
    await _close(pool, turn)
    rows = (await owner_client.get("/api/v1/activity")).json()["turns"]
    assert rows[0]["id"] == str(turn)
    assert rows[0]["conversation_id"] is None


# -- ordering + cursor pagination -----------------------------------------


async def test_turns_come_back_newest_first(owner_client, pool):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    older = await _turn_at(pool, conversation, started_offset_secs=-20)
    newer = await _turn_at(pool, conversation, started_offset_secs=-10)
    newest = await _turn_at(pool, conversation, started_offset_secs=0)
    for t in (older, newer, newest):
        await _close(pool, t)

    rows = (await owner_client.get("/api/v1/activity")).json()["turns"]
    assert [r["id"] for r in rows] == [str(newest), str(newer), str(older)]


async def test_the_cursor_pages_through_without_gap_or_overlap(owner_client, pool):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    ids = []
    for i in range(5):
        turn = await _turn_at(pool, conversation, started_offset_secs=-50 + i * 10)
        await _close(pool, turn)
        ids.append(turn)
    # Newest first means index 4 (the latest offset) comes first.
    newest_first = list(reversed(ids))

    first = await owner_client.get("/api/v1/activity?limit=2")
    first_ids = [r["id"] for r in first.json()["turns"]]
    assert first_ids == [str(t) for t in newest_first[0:2]]

    second = await owner_client.get(f"/api/v1/activity?limit=2&before={first_ids[-1]}")
    second_ids = [r["id"] for r in second.json()["turns"]]
    assert second_ids == [str(t) for t in newest_first[2:4]]

    third = await owner_client.get(f"/api/v1/activity?limit=2&before={second_ids[-1]}")
    third_ids = [r["id"] for r in third.json()["turns"]]
    assert third_ids == [str(t) for t in newest_first[4:5]]

    # The boundary: paging past the last row yields nothing, not an error
    # and not a wraparound back to the top.
    fourth = await owner_client.get(f"/api/v1/activity?limit=2&before={third_ids[-1]}")
    assert fourth.json()["turns"] == []


async def test_the_cursor_breaks_ties_on_id_when_started_at_matches(owner_client, pool):
    """Two turns landing in the same instant must not be skipped or
    repeated — started_at alone cannot order them, so id disambiguates."""
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    same_time = await pool.fetchval("SELECT now()")
    ids = []
    for _ in range(3):
        turn = await pool.fetchval(
            "INSERT INTO turns (kind, conversation_id, model, started_at) "
            "VALUES ('chat', $1, 'm', $2) RETURNING id",
            conversation,
            same_time,
        )
        await _close(pool, turn)
        ids.append(turn)

    all_rows = (await owner_client.get("/api/v1/activity?limit=10")).json()["turns"]
    seen = [r["id"] for r in all_rows]
    assert sorted(seen) == sorted(str(t) for t in ids)
    assert len(seen) == len(set(seen))

    # Paging one at a time must eventually surface all three exactly once.
    collected: list[str] = []
    before = None
    for _ in range(len(ids)):
        url = "/api/v1/activity?limit=1"
        if before:
            url += f"&before={before}"
        page = (await owner_client.get(url)).json()["turns"]
        assert len(page) == 1
        collected.append(page[0]["id"])
        before = page[0]["id"]
    assert sorted(collected) == sorted(str(t) for t in ids)
    assert len(collected) == len(set(collected))


async def test_an_unknown_cursor_is_a_404_not_a_silent_full_list(owner_client):
    resp = await owner_client.get(f"/api/v1/activity?before={uuid.uuid4()}")
    assert resp.status_code == 404


# -- the limit cap ---------------------------------------------------------


async def test_the_limit_is_capped_at_200_even_when_more_asked_for(owner_client, pool):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    await pool.execute(
        "INSERT INTO turns (kind, conversation_id, model, started_at) "
        "SELECT 'chat', $1, 'm', now() - (n || ' seconds')::interval "
        "FROM generate_series(1, 205) AS n",
        conversation,
    )

    resp = await owner_client.get("/api/v1/activity?limit=500")
    assert resp.status_code == 200
    assert len(resp.json()["turns"]) == 200


# -- the drill-in ----------------------------------------------------------


async def test_the_drill_in_returns_the_turn_and_its_spans_in_order(owner_client, pool):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    turn = await _turn_at(pool, conversation, started_offset_secs=0)
    await _span(pool, turn, "memory_recall", meta={"k": 5, "hits": 1})
    await _span(pool, turn, "llm_call", "qwen3:8b", meta={"round": 1})
    await _span(pool, turn, "tool", "get_time", meta={"ok": True, "result_head": "14:02"})
    await _close(pool, turn, "ok")

    resp = await owner_client.get(f"/api/v1/activity/{turn}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["turn"]["id"] == str(turn)
    assert body["turn"]["status"] == "ok"
    kinds = [s["kind"] for s in body["spans"]]
    assert kinds == ["memory_recall", "llm_call", "tool"]
    assert body["spans"][2]["name"] == "get_time"
    assert body["spans"][2]["meta"]["result_head"] == "14:02"


async def test_an_unknown_turn_is_a_404(owner_client):
    resp = await owner_client.get(f"/api/v1/activity/{uuid.uuid4()}")
    assert resp.status_code == 404


# -- the polymorphic args_redacted quirk survives verbatim -----------------


async def test_the_object_shape_of_args_redacted_survives_verbatim(owner_client, pool):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    turn = await _turn_at(pool, conversation, started_offset_secs=0)
    await _span(
        pool,
        turn,
        "tool",
        "workspace_write_file",
        meta={
            "ok": True,
            "args_redacted": {"path": "a.md", "content": "hi"},
            "result_head": "Wrote a.md",
        },
    )
    await _close(pool, turn)

    body = (await owner_client.get(f"/api/v1/activity/{turn}")).json()
    args = body["spans"][0]["meta"]["args_redacted"]
    assert isinstance(args, dict)
    assert args == {"path": "a.md", "content": "hi"}


async def test_the_clipped_string_shape_of_args_redacted_survives_verbatim(owner_client, pool):
    """The KNOWN QUIRK: when the model's arguments were oversized or
    unparseable, args_redacted degrades to a clipped STRING — the API
    must pass that shape through unchanged too, not coerce it into an
    object."""
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    turn = await _turn_at(pool, conversation, started_offset_secs=0)
    clipped = "xxx… (+4800 more chars, 5000 total)"
    await _span(
        pool,
        turn,
        "tool",
        "workspace_write_file",
        meta={"ok": False, "args_redacted": clipped, "result_head": "Error: too many keys"},
    )
    await _close(pool, turn)

    body = (await owner_client.get(f"/api/v1/activity/{turn}")).json()
    args = body["spans"][0]["meta"]["args_redacted"]
    assert isinstance(args, str)
    assert args == clipped
