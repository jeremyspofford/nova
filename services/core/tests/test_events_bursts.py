"""S37c T5: bursts and restart (spec §2.5, §4).

At most one event turn runs per sender, and the DATABASE says so: a claim
takes a per-sender lock and claims nothing while any of that sender's rows is
running. Events that arrive meanwhile wait, and the next turn — started by
the end of the running one — frames all of them, in order, each row naming
the turn that read it. A restart puts running events back to queued, and the
scheduler's tick starts a turn for every sender with queued events and none
running, so nothing accepted is ever dropped."""

from __future__ import annotations

import asyncio
import re
import uuid

import pytest

from app import chat, events, scheduler, timers, traces
from app.main import app, lifespan
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

MODEL = "qwen3:8b"


async def _owner(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )


async def _set_model(pool) -> None:
    await pool.execute("INSERT INTO settings (key, value) VALUES ('chat.model', $1::jsonb)", MODEL)


async def _ready(pool, mount_peers, *names: str) -> tuple[FakeGateway, dict[str, str]]:
    await _owner(pool)
    await _set_model(pool)
    tokens = {}
    for name in names or ("test",):
        _, tokens[name] = await events.add_sender(pool, name, added_by="owner")
    gateway = FakeGateway(deltas=("looked into it",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    return gateway, tokens


async def _event(pool, name: str = "test", payload: str = "p") -> uuid.UUID:
    return await events.accept(pool, name, payload, "text/plain")


_GATES: list[Gate] = []


@pytest.fixture(autouse=True)
async def _open_every_gate(pool, mount_peers):
    """A test that fails while a turn waits at its gate must not leave that
    turn (and the pool under it) hanging into the next test."""
    yield
    for gate in _GATES:
        gate.release.set()
    _GATES.clear()
    await chat.drain_background()


class Gate:
    """Wraps chat._run_turn: each event turn waits at the gate until released,
    and the most turns of one sender ever running at once is kept."""

    def __init__(self, monkeypatch) -> None:
        self.release = asyncio.Event()
        self.entered = asyncio.Event()
        self.running: dict[str, int] = {}
        self.most: dict[str, int] = {}
        self.texts: list[str] = []
        _GATES.append(self)
        original = chat._run_turn

        async def gated(app_, pool_, turn, owner, conv, text, *args, **kwargs):
            sender = turn.role.removeprefix("event_")
            self.running[sender] = self.running.get(sender, 0) + 1
            self.most[sender] = max(self.most.get(sender, 0), self.running[sender])
            self.texts.append(text)
            self.entered.set()
            try:
                await self.release.wait()
                return await original(app_, pool_, turn, owner, conv, text, *args, **kwargs)
            finally:
                self.running[sender] -= 1

        monkeypatch.setattr(chat, "_run_turn", gated)


def _blocks(framed: str) -> list[str]:
    nonce = re.search(r"ends at the line `--- end event data (\S+) ---`", framed).group(1)
    begin, end = f"--- begin event data {nonce} ---", f"--- end event data {nonce} ---"
    lines, out, i = framed.split("\n"), [], 0
    while i < len(lines):
        if lines[i] == begin:
            j = lines.index(end, i + 1)
            out.append("\n".join(lines[i + 1 : j]))
            i = j + 1
        else:
            i += 1
    return out


async def _event_turns(pool) -> list:
    return await pool.fetch("SELECT * FROM turns WHERE kind = 'event' ORDER BY started_at")


# -- C1: one running turn per sender, held by the database ---------------------


@requires_db
async def test_an_event_arriving_while_a_turn_runs_starts_no_second_turn(
    pool, mount_peers, monkeypatch
):
    await _ready(pool, mount_peers)
    gate = Gate(monkeypatch)
    first = await _event(pool, payload="first")
    task = await events.start_event_turn(app, pool, "test")
    assert task is not None
    await gate.entered.wait()

    second = await _event(pool, payload="second")
    assert await events.start_event_turn(app, pool, "test") is None
    assert await pool.fetchval("SELECT state FROM events WHERE id = $1", second) == "queued"
    assert len(await _event_turns(pool)) == 1

    gate.release.set()
    await task
    await chat.drain_background()
    assert gate.most == {"test": 1}
    rows = {
        r["id"]: r
        for r in await pool.fetch("SELECT * FROM events WHERE id = ANY($1)", [first, second])
    }
    assert rows[first]["state"] == rows[second]["state"] == "done"
    assert rows[first]["turn_id"] != rows[second]["turn_id"]


@requires_db
async def test_a_running_row_in_the_table_blocks_the_claim_not_a_flag(pool, mount_peers):
    """Another process's running turn is a row, not this process's memory:
    a running row alone is enough to claim nothing."""
    await _ready(pool, mount_peers)
    await pool.execute(
        "INSERT INTO events (sender, payload, state) VALUES ('test', 'elsewhere', 'running')"
    )
    queued = await _event(pool)
    assert await events.start_event_turn(app, pool, "test") is None
    assert await pool.fetchval("SELECT state FROM events WHERE id = $1", queued) == "queued"
    assert await pool.fetchval("SELECT count(*) FROM turns") == 0


@requires_db
async def test_two_events_arriving_together_start_exactly_one_turn(
    client, pool, mount_peers, monkeypatch
):
    """The concurrency case: two POSTs for one sender at the same moment, and
    two more while that turn runs — one turn at a time, every event read."""
    _, tokens = await _ready(pool, mount_peers)
    gate = Gate(monkeypatch)
    headers = {"Authorization": f"Bearer {tokens['test']}", "Content-Type": "text/plain"}

    async def post(body: str):
        resp = await client.post("/api/v1/events/test", content=body.encode(), headers=headers)
        assert resp.status_code == 202
        return uuid.UUID(resp.json()["id"])

    ids = list(await asyncio.gather(post("a"), post("b")))
    await gate.entered.wait()
    ids += list(await asyncio.gather(post("c"), post("d")))
    assert len(await _event_turns(pool)) == 1
    open_turns = await pool.fetchval(
        "SELECT count(*) FROM turns WHERE kind = 'event' AND status IS NULL"
    )
    assert open_turns == 1

    gate.release.set()
    await chat.drain_background()
    assert gate.most == {"test": 1}
    rows = await pool.fetch("SELECT state, turn_id FROM events WHERE id = ANY($1)", ids)
    assert {r["state"] for r in rows} == {"done"}
    turns = await _event_turns(pool)
    # c and d arrived while a turn ran: read together by one later turn.
    assert len(turns) == 2
    assert turns[1]["started_at"] >= turns[0]["ended_at"]


@requires_db
async def test_the_claim_waits_for_the_senders_lock_and_reads_after_it(pool, mount_peers):
    """The claim takes the per-sender lock and reads the running rows only
    once it holds it: a claim racing another's commit sees that commit."""
    await _ready(pool, mount_peers)
    queued = await _event(pool)
    async with pool.acquire() as holder, holder.transaction():
        await holder.execute(
            "SELECT pg_advisory_xact_lock(hashtext($1))", events._RUN_LOCK + "test"
        )
        claim = asyncio.create_task(events.start_event_turn(app, pool, "test"))
        await asyncio.sleep(0.3)
        assert not claim.done()
        # What the lock's holder commits, the waiting claim must see.
        await holder.execute(
            "INSERT INTO events (sender, payload, state) VALUES ('test', 'other', 'running')"
        )
    assert await asyncio.wait_for(claim, 5) is None
    assert await pool.fetchval("SELECT state FROM events WHERE id = $1", queued) == "queued"
    assert await pool.fetchval("SELECT count(*) FROM turns") == 0


@requires_db
async def test_two_claims_at_once_take_one_turn(pool, mount_peers, monkeypatch):
    await _ready(pool, mount_peers)
    gate = Gate(monkeypatch)
    await _event(pool, payload="a")
    await _event(pool, payload="b")
    started = await asyncio.gather(*(events.start_event_turn(app, pool, "test") for _ in range(4)))
    assert sum(t is not None for t in started) == 1
    gate.release.set()
    await chat.drain_background()
    assert len(await _event_turns(pool)) == 1 and gate.most == {"test": 1}


@requires_db
async def test_a_running_sender_never_holds_up_another(pool, mount_peers, monkeypatch):
    await _ready(pool, mount_peers, "test", "other")
    gate = Gate(monkeypatch)
    await _event(pool, "test")
    assert await events.start_event_turn(app, pool, "test") is not None
    await gate.entered.wait()
    await _event(pool, "other")
    assert await events.start_event_turn(app, pool, "other") is not None
    gate.release.set()
    await chat.drain_background()
    assert gate.most == {"test": 1, "other": 1}


# -- C2: the waiting events are read together, next, in order ------------------


@requires_db
async def test_events_that_waited_are_read_together_next_in_order(pool, mount_peers, monkeypatch):
    await _ready(pool, mount_peers)
    gate = Gate(monkeypatch)
    first = await _event(pool, payload="first")
    task = await events.start_event_turn(app, pool, "test")
    await gate.entered.wait()
    waited = [await _event(pool, payload=f"later {i}") for i in range(3)]
    for _ in waited:
        assert await events.start_event_turn(app, pool, "test") is None

    gate.release.set()
    await task
    # Nobody calls start again: the end of the running turn starts the next.
    await chat.drain_background()

    assert len(gate.texts) == 2
    assert _blocks(gate.texts[0]) == ["first"]
    assert _blocks(gate.texts[1]) == ["later 0", "later 1", "later 2"]
    turns = await _event_turns(pool)
    assert len(turns) == 2
    first_turn = await pool.fetchval("SELECT turn_id FROM events WHERE id = $1", first)
    assert first_turn == turns[0]["id"]
    rows = await pool.fetch("SELECT state, turn_id FROM events WHERE id = ANY($1)", waited)
    assert {(r["state"], r["turn_id"]) for r in rows} == {("done", turns[1]["id"])}
    (span,) = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'event'", turns[1]["id"]
    )
    assert span["meta"]["event_ids"] == [str(i) for i in waited]


@requires_db
async def test_the_frame_follows_when_events_were_received_not_the_table_order(
    pool, mount_peers, monkeypatch
):
    """Rows stored out of time order (a requeued row, a clock step) are still
    framed oldest first: the order is read from received_at, never from
    where postgres happens to keep the rows."""
    await _ready(pool, mount_peers)
    gate = Gate(monkeypatch)
    gate.release.set()
    ids = [await _event(pool, payload=p) for p in ("third", "first", "second")]
    for offset, event_id in zip((30, 10, 20), ids, strict=True):
        await pool.execute(
            "UPDATE events SET received_at = now() - make_interval(secs => $2) WHERE id = $1",
            event_id,
            100 - offset,
        )
    await events.start_event_turn(app, pool, "test")
    await chat.drain_background()
    (text,) = gate.texts
    assert _blocks(text) == ["first", "second", "third"]


# -- C3: a restart puts running events back --------------------------------------


async def _orphan(pool, payload: str = "half read") -> tuple[uuid.UUID, uuid.UUID]:
    """An event the dead process was running: its turn never closed."""
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, model, role) VALUES ('event', $1, 'event_test') RETURNING id",
        MODEL,
    )
    event_id = await pool.fetchval(
        "INSERT INTO events (sender, payload, state, turn_id) "
        "VALUES ('test', $1, 'running', $2) RETURNING id",
        payload,
        turn_id,
    )
    return event_id, turn_id


@requires_db
async def test_startup_requeues_running_events_with_the_reason(pool, mount_peers):
    await _ready(pool, mount_peers)
    event_id, turn_id = await _orphan(pool)
    done = await _event(pool)
    await pool.execute("UPDATE events SET state = 'done' WHERE id = $1", done)

    await traces.sweep_orphaned_turns(pool)
    assert await events.requeue_interrupted(app, pool) == 1

    row = await pool.fetchrow("SELECT * FROM events WHERE id = $1", event_id)
    assert row["state"] == "queued"
    assert str(turn_id) in row["reason"] and "interrupted" in row["reason"]
    assert await pool.fetchval("SELECT state FROM events WHERE id = $1", done) == "done"


@requires_db
async def test_a_restart_picks_the_event_up_and_runs_it(pool, mount_peers):
    """The whole restart through main.lifespan: the running row is requeued,
    the first tick starts its turn, and it ends done under a NEW turn."""
    await _ready(pool, mount_peers)
    event_id, old_turn = await _orphan(pool)
    async with lifespan(app):
        # The lifespan's pool is the fixture's (db.init_pool is one pool), and
        # it closes on the way out: everything is read inside.
        for _ in range(200):
            state = await pool.fetchval("SELECT state FROM events WHERE id = $1", event_id)
            if state in ("done", "failed"):
                break
            await asyncio.sleep(0.05)
        await chat.drain_background()
        row = await pool.fetchrow("SELECT * FROM events WHERE id = $1", event_id)
        old_status = await pool.fetchval("SELECT status FROM turns WHERE id = $1", old_turn)
    chat.accept_queued_turns_again()
    assert row["state"] == "done", row
    assert row["turn_id"] != old_turn and row["reason"] is None
    assert old_status == "interrupted"


async def _closed(pool, status: str, payload: str = "already read") -> tuple[uuid.UUID, uuid.UUID]:
    """An event whose turn CLOSED (ok, error, ...) but the process died before
    the row was settled — the window between close and _settle, which holds
    chat.settle_detached."""
    event_id, turn_id = await _orphan(pool, payload)
    await pool.execute(
        "UPDATE turns SET status = $2, ended_at = now() WHERE id = $1", turn_id, status
    )
    return event_id, turn_id


async def _outcome_turns(pool) -> list:
    from app.checks import events as event_checks

    return [
        r["turn_id"]
        for r in await pool.fetch(
            "SELECT turn_id FROM notices WHERE check_name = $1", event_checks.OUTCOMES
        )
    ]


@requires_db
@pytest.mark.parametrize(("status", "state"), [("ok", "done"), ("error", "failed")])
async def test_a_restart_never_reruns_an_event_whose_turn_already_closed(
    pool, mount_peers, status, state
):
    """Gap 1: a row left running under a turn that CLOSED is settled from that
    turn at startup — never requeued, never re-run, never told it was
    'interrupted' — and it keeps naming the turn that already ran her tools."""
    await _ready(pool, mount_peers)
    event_id, turn_id = await _closed(pool, status)
    async with lifespan(app):
        for _ in range(40):  # long enough for the first tick to have re-run it
            await asyncio.sleep(0.05)
        await chat.drain_background()
        row = await pool.fetchrow("SELECT * FROM events WHERE id = $1", event_id)
        turns = await _event_turns(pool)
        told = await _outcome_turns(pool)
    chat.accept_queued_turns_again()
    assert row["state"] == state, row
    assert row["turn_id"] == turn_id
    assert [t["id"] for t in turns] == [turn_id]
    assert "interrupted" not in (row["reason"] or "") and "requeued" not in (row["reason"] or "")
    if state == "failed":
        assert status in row["reason"]
    assert turn_id in told


@requires_db
async def test_startup_requeues_only_events_whose_turn_never_closed(pool, mount_peers):
    await _ready(pool, mount_peers)
    cut, cut_turn = await _orphan(pool, "cut off")
    closed, closed_turn = await _closed(pool, "ok")
    never = await pool.fetchval(
        "INSERT INTO events (sender, payload, state) VALUES ('test', 'no turn', 'running') "
        "RETURNING id"
    )
    await traces.sweep_orphaned_turns(pool)
    assert await events.requeue_interrupted(app, pool) == 2

    rows = {
        r["id"]: r
        for r in await pool.fetch("SELECT * FROM events WHERE id = ANY($1)", [cut, closed, never])
    }
    assert rows[cut]["state"] == "queued" and str(cut_turn) in rows[cut]["reason"]
    assert "interrupted" in rows[cut]["reason"]
    assert rows[never]["state"] == "queued" and "no turn had opened" in rows[never]["reason"]
    assert rows[closed]["state"] == "done" and rows[closed]["turn_id"] == closed_turn


# -- C1+C4: a raise after the claim never leaves a sender blocked -----------------


def _raise_once(monkeypatch, module, name: str, message: str) -> None:
    original = getattr(module, name)

    def boom(*args, **_kwargs):
        monkeypatch.setattr(module, name, original)
        for arg in args:  # a coroutine handed to _spawn is closed, not leaked
            if asyncio.iscoroutine(arg):
                arg.close()
        raise RuntimeError(message)

    async def aboom(*args, **kwargs):
        boom(*args, **kwargs)

    monkeypatch.setattr(module, name, boom if name == "_spawn" else aboom)


@requires_db
@pytest.mark.parametrize("where", ["owner", "model", "spawn"])
async def test_a_raise_after_the_claim_leaves_no_event_running(
    pool, mount_peers, monkeypatch, where
):
    """Gap 2: anything that raises after _claim (the owner lookup, the model
    setting, the spawn after the turn opened) settles the claimed rows as
    failed with the reason and files T4's notice — none stays `running`, so
    the sender's next event still starts."""
    import contextlib

    from app import identity, settings_store

    await _ready(pool, mount_peers)
    target = {
        "owner": (identity, "owner"),
        "model": (settings_store, "read_value"),
        "spawn": (chat, "_spawn"),
    }[where]
    _raise_once(monkeypatch, *target, f"{where} broke")
    first = await _event(pool, payload="first")
    with contextlib.suppress(RuntimeError):
        await events.start_event_turn(app, pool, "test")
    await chat.drain_background()

    row = await pool.fetchrow("SELECT * FROM events WHERE id = $1", first)
    assert row["state"] == "failed", row
    assert f"{where} broke" in row["reason"]
    assert await pool.fetchval("SELECT count(*) FROM events WHERE state = 'running'") == 0
    if where == "spawn":
        assert row["turn_id"] is not None
        assert (
            await pool.fetchval("SELECT status FROM turns WHERE id = $1", row["turn_id"]) == "error"
        )
    from app.checks import events as event_checks

    assert (
        await pool.fetchval(
            "SELECT count(*) FROM notices WHERE check_name = $1", event_checks.OUTCOMES
        )
        == 1
    )

    second = await _event(pool, payload="second")
    assert await events.start_queued(app, pool) == ["test"]
    await chat.drain_background()
    assert await pool.fetchval("SELECT state FROM events WHERE id = $1", second) == "done"


@requires_db
@pytest.mark.parametrize("where", ["owner", "model", "spawn"])
async def test_a_raise_after_the_claim_still_pushes_an_urgent_event_to_the_owner(
    pool, mount_peers, monkeypatch, where
):
    """Gap 3: the raise path tells the REAL owner (looked up as the normal path
    does), so an urgent event is still pushed, and the notice states the real
    failure — never "there is no person on this delivery"."""
    import contextlib

    from app import delivery, identity, notices, settings_store
    from app.checks import events as event_checks

    await _ready(pool, mount_peers)
    owner_id = await pool.fetchval("SELECT id FROM people WHERE role = 'owner'")
    calls: list[dict] = []
    original = delivery.deliver

    async def spy(app_, pool_, **kwargs):
        calls.append(kwargs)
        return await original(app_, pool_, **kwargs)

    monkeypatch.setattr(delivery, "deliver", spy)
    target = {
        "owner": (identity, "owner"),
        "model": (settings_store, "read_value"),
        "spawn": (chat, "_spawn"),
    }[where]
    _raise_once(monkeypatch, *target, f"{where} broke")
    first = await _event(pool, payload="urgent one")
    await pool.execute("UPDATE events SET urgent = true WHERE id = $1", first)
    with contextlib.suppress(RuntimeError):
        await events.start_event_turn(app, pool, "test")
    await chat.drain_background()

    (call,) = calls
    assert call["urgent"] is True
    assert call["person"] is not None and call["person"].id == owner_id
    assert f"{where} broke" in call["text"]
    notice_id = await pool.fetchval(
        "SELECT id FROM notices WHERE check_name = $1", event_checks.OUTCOMES
    )
    notice = await notices.get(pool, notice_id)
    assert notice.state == notices.DELIVERED, (notice.state, notice.failed_reason)
    assert notice.delivery and notice.delivery["chat"]["ok"] is True


@requires_db
async def test_an_owner_lookup_that_keeps_failing_still_files_the_notice(
    pool, mount_peers, monkeypatch
):
    """Gap 3's fallback: when the owner lookup raises on the failure path too,
    the rows are failed with the real reason and the notice is still filed;
    the push says there is no person (the one case None is true)."""
    from app import delivery, identity, notices
    from app.checks import events as event_checks

    await _ready(pool, mount_peers)
    calls: list[dict] = []
    original = delivery.deliver

    async def spy(app_, pool_, **kwargs):
        calls.append(kwargs)
        return await original(app_, pool_, **kwargs)

    async def broken(*_args, **_kwargs):
        raise RuntimeError("owner lookup broke")

    monkeypatch.setattr(delivery, "deliver", spy)
    monkeypatch.setattr(identity, "owner", broken)
    first = await _event(pool, payload="urgent one")
    await pool.execute("UPDATE events SET urgent = true WHERE id = $1", first)
    assert await events.start_event_turn(app, pool, "test") is None

    row = await pool.fetchrow("SELECT state, reason FROM events WHERE id = $1", first)
    assert row["state"] == "failed" and "owner lookup broke" in row["reason"]
    (call,) = calls
    assert call["person"] is None and "owner lookup broke" in call["text"]
    notice_id = await pool.fetchval(
        "SELECT id FROM notices WHERE check_name = $1", event_checks.OUTCOMES
    )
    assert (await notices.get(pool, notice_id)).state == notices.FAILED


# -- C4: the tick starts queued senders -----------------------------------------


@requires_db
async def test_the_tick_starts_every_sender_with_queued_events(pool, mount_peers):
    await _ready(pool, mount_peers, "test", "other")
    a = await _event(pool, "test")
    b = await _event(pool, "other")
    await scheduler.tick_once(app, pool)
    await chat.drain_background()
    rows = await pool.fetch("SELECT state, turn_id FROM events WHERE id = ANY($1)", [a, b])
    assert {r["state"] for r in rows} == {"done"}
    assert len({r["turn_id"] for r in rows}) == 2


@requires_db
async def test_the_tick_never_starts_a_second_turn_for_a_running_sender(
    pool, mount_peers, monkeypatch
):
    await _ready(pool, mount_peers)
    gate = Gate(monkeypatch)
    await _event(pool, payload="first")
    task = await events.start_event_turn(app, pool, "test")
    await gate.entered.wait()
    waiting = await _event(pool, payload="second")
    await scheduler.tick_once(app, pool)
    assert len(await _event_turns(pool)) == 1
    assert await pool.fetchval("SELECT state FROM events WHERE id = $1", waiting) == "queued"
    gate.release.set()
    await task
    await chat.drain_background()
    assert gate.most == {"test": 1}
    assert await pool.fetchval("SELECT state FROM events WHERE id = $1", waiting) == "done"


@requires_db
async def test_an_event_start_that_raises_never_stops_the_timers(pool, mount_peers, monkeypatch):
    await _ready(pool, mount_peers)
    await _event(pool)

    async def boom(*_a, **_k):
        raise RuntimeError("events table unreachable")

    monkeypatch.setattr(events, "start_queued", boom)
    ran: list[str] = []

    async def job(_pool):
        ran.append("job")
        return "ok"

    monkeypatch.setitem(timers.JOBS, "t5_probe", job)
    timer_id = await pool.fetchval(
        "INSERT INTO timers (kind, title, payload, schedule, timezone, next_fire_at, created_via) "
        "VALUES ('job', 't5_probe', $1::jsonb, $2::jsonb, 'UTC', now() - interval '1 minute', "
        "'system') RETURNING id",
        {"handler": "t5_probe"},
        {"kind": "minutes", "every": 5},
    )
    fired = await scheduler.tick_once(app, pool)
    assert ran == ["job"] and len(fired) == 1
    assert await pool.fetchval("SELECT timer_id FROM timer_firings WHERE id = $1", fired[0]) == (
        timer_id
    )


# -- C5: shutdown leaves them queued ---------------------------------------------


@requires_db
async def test_the_tick_starts_nothing_while_shutting_down(pool, mount_peers):
    await _ready(pool, mount_peers)
    event_id = await _event(pool)
    chat.begin_shutdown()
    try:
        await scheduler.tick_once(app, pool)
    finally:
        chat.accept_queued_turns_again()
    assert await pool.fetchval("SELECT state FROM events WHERE id = $1", event_id) == "queued"
    assert await pool.fetchval("SELECT count(*) FROM turns") == 0


@requires_db
async def test_the_next_turn_is_not_chained_once_shutting_down(pool, mount_peers, monkeypatch):
    await _ready(pool, mount_peers)
    gate = Gate(monkeypatch)
    await _event(pool, payload="first")
    task = await events.start_event_turn(app, pool, "test")
    await gate.entered.wait()
    waiting = await _event(pool, payload="second")
    chat.begin_shutdown()
    try:
        gate.release.set()
        await task
        await chat.drain_background()
    finally:
        chat.accept_queued_turns_again()
    assert len(await _event_turns(pool)) == 1
    assert await pool.fetchval("SELECT state FROM events WHERE id = $1", waiting) == "queued"
