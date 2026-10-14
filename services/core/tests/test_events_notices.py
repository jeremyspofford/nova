"""S37c T4: what reaches him after an event turn (spec §2.4, §3, §4).

A notice written by CODE: the sender, the event, and her one-line conclusion
(the first line of her stored reply) — or that it failed and why — linked to
the event and the turn, filed under the `event_outcomes` family so it shows in
the Inbox. Only an urgent event goes out at once, through delivery.deliver
with urgent set. The family's hourly run derives the same finding from the
event rows, so a beat folds onto the notice instead of raising a second one."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from app import chat, checks, delivery, events, notices
from app.checks import events as event_checks
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway

MODEL = "qwen3:8b"
PAYLOAD = '{"disk": "92%", "secret_marker": "PAYLOAD-ONLY-7731"}'


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


async def _owner(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )


async def _set_model(pool, model: str = MODEL) -> None:
    await pool.execute("INSERT INTO settings (key, value) VALUES ('chat.model', $1::jsonb)", model)


async def _event(pool, name: str = "test", payload: str = PAYLOAD, *, urgent: bool = False):
    event_id = await events.accept(pool, name, payload, "application/json")
    if urgent:
        await pool.execute("UPDATE events SET urgent = true WHERE id = $1", event_id)
    return event_id


async def _run(pool, name: str = "test") -> None:
    task = await events.start_event_turn(app, pool, name)
    if task is not None:
        await task
    await chat.drain_background()


async def _outcomes(pool) -> list:
    rows = await pool.fetch(
        "SELECT id FROM notices WHERE check_name = $1 ORDER BY first_seen_at",
        event_checks.OUTCOMES,
    )
    return [await notices.get(pool, row["id"]) for row in rows]


def _spy_deliver(monkeypatch) -> list[dict]:
    calls: list[dict] = []
    original = delivery.deliver

    async def spy(app_, pool_, **kwargs):
        calls.append(kwargs)
        return await original(app_, pool_, **kwargs)

    monkeypatch.setattr(delivery, "deliver", spy)
    return calls


# -- C1: the family ------------------------------------------------------------


def test_the_outcomes_family_is_registered_and_not_urgent():
    check = checks.REGISTRY[event_checks.OUTCOMES]
    assert check.urgent is False
    assert event_checks.OUTCOMES not in checks.urgent_names()
    assert check.run.__module__ == "app.checks.events"
    assert check.describe.strip()


# -- C2: an ok turn files one code-written notice -----------------------------


@requires_db
async def test_an_ok_event_turn_files_one_notice_with_her_first_line(pool, mount_peers):
    await _owner(pool)
    await _set_model(pool)
    await events.add_sender(pool, "test", added_by="owner")
    reply = "\n  Disk was at 92%; I cleared the build cache.\nDetails: /var/cache freed 4 GB."
    mount_peers(gateway=ScriptedGateway(rounds=((text(reply),),)), memory=FakeMemory())
    event_id = await _event(pool)

    await _run(pool)

    turn_id = await pool.fetchval("SELECT turn_id FROM events WHERE id = $1", event_id)
    (notice,) = await _outcomes(pool)
    assert notice.check_name == event_checks.OUTCOMES
    assert notice.turn_id == turn_id
    assert notice.urgent is False and notice.state == notices.RAISED
    assert notice.facts == {
        "sender": "test",
        "events": [str(event_id)],
        "turn": str(turn_id),
        "outcome": "done",
    }
    assert "test" in notice.title
    assert "Disk was at 92%; I cleared the build cache." in notice.title
    assert "Details" not in notice.title
    # The payload is data for her, never words on his screen.
    assert "PAYLOAD-ONLY-7731" not in notice.title
    assert "PAYLOAD-ONLY-7731" not in str(notice.facts)
    # In the Inbox.
    assert notice.id in [n.id for n in await notices.recent(pool)]


@requires_db
async def test_the_conclusion_is_read_from_her_stored_reply(pool, mount_peers, monkeypatch):
    """The line comes from the messages row chat persisted, not from anything
    the turn said on the way: what reaches him is what is on the record."""
    await _owner(pool)
    await _set_model(pool)
    await events.add_sender(pool, "test", added_by="owner")
    mount_peers(gateway=ScriptedGateway(rounds=((text("what she said"),),)), memory=FakeMemory())
    original = chat._persist_assistant

    async def stored(pool_, conversation_id, content, turn_id, *args, **kwargs):
        return await original(pool_, conversation_id, "the stored line", turn_id, *args, **kwargs)

    monkeypatch.setattr(chat, "_persist_assistant", stored)
    await _event(pool)
    await _run(pool)
    (notice,) = await _outcomes(pool)
    assert "the stored line" in notice.title
    assert "what she said" not in notice.title


@requires_db
async def test_several_events_read_by_one_turn_file_one_notice(pool, mount_peers):
    await _owner(pool)
    await _set_model(pool)
    await events.add_sender(pool, "test", added_by="owner")
    mount_peers(gateway=ScriptedGateway(rounds=((text("both looked at"),),)), memory=FakeMemory())
    a = await _event(pool, payload="first")
    b = await _event(pool, payload="second")
    await _run(pool)
    (notice,) = await _outcomes(pool)
    assert notice.facts["events"] == [str(a), str(b)]
    assert "2 events" in notice.title


# -- C3: failures are stated ---------------------------------------------------


@requires_db
async def test_a_failed_turn_still_files_the_notice_saying_why(pool, mount_peers):
    await _owner(pool)
    await _set_model(pool)
    await events.add_sender(pool, "test", added_by="owner")
    mount_peers(
        gateway=ScriptedGateway(rounds=(Refusal(503, {"error": {"message": "no backend"}}),)),
        memory=FakeMemory(),
    )
    event_id = await _event(pool)
    await _run(pool)
    row = await pool.fetchrow("SELECT state, reason, turn_id FROM events WHERE id = $1", event_id)
    assert row["state"] == "failed"
    (notice,) = await _outcomes(pool)
    assert notice.facts["outcome"] == "failed"
    assert notice.turn_id == row["turn_id"]
    assert "failed" in notice.title and "no backend" in notice.title


@requires_db
async def test_a_turn_that_raises_still_files_the_notice(pool, mount_peers, monkeypatch):
    await _owner(pool)
    await _set_model(pool)
    await events.add_sender(pool, "test", added_by="owner")
    mount_peers(gateway=ScriptedGateway(rounds=((text("x"),),)), memory=FakeMemory())

    async def boom(*args, **kwargs):
        raise RuntimeError("the run blew up")

    monkeypatch.setattr(chat, "_run_turn", boom)
    await _event(pool)
    await _run(pool)
    (notice,) = await _outcomes(pool)
    assert notice.facts["outcome"] == "failed"
    assert "the run blew up" in notice.title


@requires_db
async def test_no_chat_model_files_a_notice_per_event_with_the_reason(pool, mount_peers):
    await _owner(pool)
    await events.add_sender(pool, "test", added_by="owner")
    mount_peers(gateway=ScriptedGateway(rounds=()), memory=FakeMemory())
    a = await _event(pool, payload="one")
    b = await _event(pool, payload="two")
    await _run(pool)
    found = await _outcomes(pool)
    assert sorted(n.facts["events"][0] for n in found) == sorted([str(a), str(b)])
    for notice in found:
        assert notice.facts["turn"] is None and notice.turn_id is None
        assert notice.facts["outcome"] == "failed"
        assert "chat model" in notice.title


@requires_db
async def test_shutting_down_files_nothing(pool, mount_peers):
    await _owner(pool)
    await _set_model(pool)
    await events.add_sender(pool, "test", added_by="owner")
    mount_peers(gateway=ScriptedGateway(rounds=()), memory=FakeMemory())
    await _event(pool)
    chat.begin_shutdown()
    try:
        await _run(pool)
    finally:
        chat.accept_queued_turns_again()
    assert await _outcomes(pool) == []


# -- C4: urgent goes out now, nothing else does --------------------------------


@requires_db
async def test_an_urgent_event_is_delivered_at_once(pool, mount_peers, monkeypatch):
    owner = await _owner(pool)
    await _set_model(pool)
    await events.ensure_builtins(pool)
    mount_peers(
        gateway=ScriptedGateway(rounds=((text("memory is back up"),),)), memory=FakeMemory()
    )
    calls = _spy_deliver(monkeypatch)
    await _event(pool, "monitor", urgent=True)
    await _run(pool, "monitor")
    (call,) = calls
    assert call["urgent"] is True
    assert call["person"].id == owner
    (notice,) = await _outcomes(pool)
    assert "memory is back up" in call["text"]
    assert notice.state == notices.DELIVERED
    assert notice.delivery and notice.delivery["chat"]["ok"] is True
    assert "PAYLOAD-ONLY-7731" not in call["text"]


@requires_db
async def test_a_failed_urgent_delivery_is_marked_failed_on_the_notice(
    pool, mount_peers, monkeypatch
):
    """No owner: the chat rung reaches nobody, and the notice says so."""
    await events.ensure_builtins(pool)
    mount_peers(gateway=ScriptedGateway(rounds=()), memory=FakeMemory())
    calls = _spy_deliver(monkeypatch)
    await _event(pool, "monitor", urgent=True)
    await _run(pool, "monitor")
    assert [c["urgent"] for c in calls] == [True]
    (notice,) = await _outcomes(pool)
    assert notice.state == notices.FAILED and notice.failed_reason


@requires_db
async def test_a_non_urgent_event_never_pushes(pool, mount_peers, monkeypatch):
    await _owner(pool)
    await _set_model(pool)
    await events.add_sender(pool, "test", added_by="owner")
    mount_peers(gateway=ScriptedGateway(rounds=((text("fine"),),)), memory=FakeMemory())
    calls = _spy_deliver(monkeypatch)
    await _event(pool)
    await _run(pool)
    assert calls == []
    (notice,) = await _outcomes(pool)
    assert notice.state == notices.RAISED


@requires_db
async def test_a_failed_urgent_turn_is_still_pushed(pool, mount_peers, monkeypatch):
    await _owner(pool)
    await _set_model(pool)
    await events.ensure_builtins(pool)
    mount_peers(
        gateway=ScriptedGateway(rounds=(Refusal(503, {"error": {"message": "no backend"}}),)),
        memory=FakeMemory(),
    )
    calls = _spy_deliver(monkeypatch)
    await _event(pool, "monitor", urgent=True)
    await _run(pool, "monitor")
    (call,) = calls
    assert call["urgent"] is True and "no backend" in call["text"]


# -- C5: the hourly run derives the same finding -------------------------------


@requires_db
async def test_the_hourly_run_derives_the_same_finding(pool, mount_peers):
    await _owner(pool)
    await _set_model(pool)
    await events.add_sender(pool, "test", added_by="owner")
    mount_peers(gateway=ScriptedGateway(rounds=((text("all good"),),)), memory=FakeMemory())
    await _event(pool)
    await _run(pool)
    (notice,) = await _outcomes(pool)
    run = await checks.run_one(app, pool, event_checks.OUTCOMES)
    assert run.ran
    (finding,) = run.findings
    assert checks.fingerprint(finding) == notice.fingerprint
    assert finding.title == notice.title
    _, is_new = await notices.record(
        pool, finding, check_name=event_checks.OUTCOMES, turn_id=None, firing_id=None
    )
    assert is_new is False
    cleared = await notices.reconcile(
        pool,
        check_name=event_checks.OUTCOMES,
        live_fingerprints={checks.fingerprint(f) for f in run.findings},
    )
    assert cleared == []


@requires_db
async def test_the_hourly_run_skips_unsettled_refused_and_old_rows(pool):
    await events.add_sender(pool, "test", added_by="owner")
    await _event(pool)  # queued
    running = await _event(pool)
    await pool.execute("UPDATE events SET state = 'running' WHERE id = $1", running)
    await events.refuse(pool, "test", events.WRONG_TOKEN)
    old = await _event(pool)
    await pool.execute(
        "UPDATE events SET state = 'failed', reason = 'x', received_at = $2 WHERE id = $1",
        old,
        datetime.now(UTC) - timedelta(days=event_checks.WINDOW_DAYS, hours=1),
    )
    recent = await _event(pool)
    await pool.execute("UPDATE events SET state = 'failed', reason = 'y' WHERE id = $1", recent)
    run = await checks.run_one(app, pool, event_checks.OUTCOMES)
    assert run.ran
    assert [f.facts["events"] for f in run.findings] == [[str(recent)]]


@requires_db
async def test_a_turn_that_could_not_be_opened_files_the_notice(pool, mount_peers, monkeypatch):
    from app import traces

    await _owner(pool)
    await _set_model(pool)
    await events.add_sender(pool, "test", added_by="owner")
    mount_peers(gateway=ScriptedGateway(rounds=()), memory=FakeMemory())

    async def no_turn(*args, **kwargs):
        raise RuntimeError("turns table is gone")

    monkeypatch.setattr(traces, "open_turn", no_turn)
    event_id = await _event(pool)
    await _run(pool)
    (notice,) = await _outcomes(pool)
    assert notice.facts == {
        "sender": "test",
        "events": [str(event_id)],
        "turn": None,
        "outcome": "failed",
    }
    assert "could not be opened" in notice.title and "turns table is gone" in notice.title


@requires_db
async def test_a_turn_whose_burst_straddles_the_window_stays_one_finding(pool):
    """A group is in the window by its newest event: a turn that read an old
    event and a new one keeps both, so the hourly fact is the filed fact."""
    owner = await _owner(pool)
    await events.add_sender(pool, "test", added_by="owner")
    conv = await pool.fetchval(
        "INSERT INTO conversations (person_id, active, title) VALUES ($1, false, 't') RETURNING id",
        owner,
    )
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, status) VALUES ('event', $1, 'ok') RETURNING id",
        conv,
    )
    old = await _event(pool, payload="old")
    new = await _event(pool, payload="new")
    await pool.execute(
        "UPDATE events SET received_at = $2 WHERE id = $1",
        old,
        datetime.now(UTC) - timedelta(days=event_checks.WINDOW_DAYS, hours=1),
    )
    await pool.execute(
        "UPDATE events SET state = 'done', turn_id = $2 WHERE id = ANY($1::uuid[])",
        [old, new],
        turn_id,
    )
    run = await checks.run_one(app, pool, event_checks.OUTCOMES)
    assert [f.facts["events"] for f in run.findings] == [[str(old), str(new)]]
    assert run.findings[0].key == f"event_turn:{turn_id}"
