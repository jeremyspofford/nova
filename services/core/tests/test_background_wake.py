"""S46a T10: a turn whose route says a machine's link did not answer a dial
wakes that machine IN THE BACKGROUND — the owner's "Don't wait, fall back"
(2026-10-10): the reply comes from the next link at once, and the wake is for
later turns.

Every gateway round that walks a role's chain records the route's typed
`unreachable` / `connect_walled` ids (S46a T8/T9) on its llm_call span and,
when any is there, STARTS wake.start_route_wakes — never awaits it. The task
maps the ids to paired machines (wake.route_targets), skips a machine whose
wake_attempts rows say a wake is already open or was sent within its
deadline, sends through T5's wake_now with trigger 'route' and the turn's id,
and files one `background_wake` turn_spans row per machine with the attempt
or the reason nothing was sent. A failure anywhere is logged and recorded,
never raised into the turn. The tasks live in wake.ROUTE_WAKES, which the
app's shutdown cancels.

DB-backed. The relay, the clock, the hub's registry, the route's inputs and
the model probe are faked through wake.py's seams (as test_machine_wake
does); no packet leaves. Documentation MACs and TEST-NET addresses only.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app import chat, devices_ws, traces, wake, wake_attempts
from app.browser import agent as browser_agent
from app.main import app, lifespan
from app.network import NO_PEERS_FILE, Peers
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_machine_wake import HUB_FACTS, TARGET_FACTS, WIFI_MAC, _device

pytestmark = requires_db

T0 = datetime(2026, 10, 12, 9, 0, tzinfo=UTC)
LINK = "boxllm:qwen3:8b"
ROUTE = f"role=chat;link=2;unreachable={LINK}"
PROVIDERS = [
    {"name": "boxllm", "base_url": "http://192.0.2.23:8080/v1"},
    {"name": "cloud", "base_url": "https://api.example.com/v1"},
]
NO_PEERS = Peers((), NO_PEERS_FILE)


def _agents():
    return [
        {"name": "box", "connected": False, "hub": False, "addresses": ("192.0.2.23",)},
        {"name": "hubhost", "connected": True, "hub": True, "addresses": ("192.0.2.10",)},
    ]


class World:
    """The fake outside, with a relay that can be held: a send waits on
    `release` until the test sets it — the slow relay."""

    def __init__(self) -> None:
        self.t = T0
        self.connected: dict[str, datetime] = {}
        self.sends: list[dict] = []
        self.release = asyncio.Event()
        self.release.set()
        self.started = asyncio.Event()
        self.answer: object = None
        self.inputs_error: Exception | None = None

    def now(self) -> datetime:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.t += timedelta(seconds=seconds)

    def is_connected(self, device_id) -> bool:
        since = self.connected.get(str(device_id))
        return since is not None and self.t >= since

    async def send(self, pool, relay, args, timeout):
        self.sends.append({"relay": relay, "args": dict(args)})
        self.started.set()
        await self.release.wait()
        if isinstance(self.answer, Exception):
            raise self.answer
        return {"ok": True, "output": "sent", "meta": {"sent": 6, "iface": "eth0"}}

    async def providers_on(self, app_, name):
        return [PROVIDERS[0]], None

    async def serving(self, app_, provider) -> bool:
        return False

    async def route_inputs(self, app_):
        if self.inputs_error is not None:
            raise self.inputs_error
        return PROVIDERS, _agents(), NO_PEERS


@pytest.fixture
async def world(pool, monkeypatch):
    w = World()
    monkeypatch.setattr(wake, "_now", w.now)
    monkeypatch.setattr(wake, "_sleep", w.sleep)
    monkeypatch.setattr(devices_ws.hub, "is_connected", w.is_connected)
    monkeypatch.setattr(wake, "_send", w.send)
    monkeypatch.setattr(wake, "_providers_on", w.providers_on)
    monkeypatch.setattr(wake, "_serving", w.serving)
    monkeypatch.setattr(wake, "_route_inputs", w.route_inputs)
    w.box = await _device(pool, "box", platform="windows", facts=TARGET_FACTS, key="ab")
    w.hub = await _device(
        pool, "hubhost", platform="linux", facts=HUB_FACTS, transport="host", key="cd"
    )
    w.connected[str(w.hub)] = T0 - timedelta(hours=1)
    yield w
    w.release.set()
    await wake.cancel_route_wakes()


async def _settle_wakes() -> None:
    """Let every background wake finish (the relay released) — including the
    per-machine tasks a route task starts."""
    for _ in range(100):
        running = [t for t in wake.ROUTE_WAKES if not t.done()]
        if not running:
            return
        await asyncio.wait_for(asyncio.gather(*running, return_exceptions=True), 10)
    raise AssertionError("background wakes kept starting")


async def _bg_spans(pool, turn_id=None) -> list[dict]:
    rows = await pool.fetch(
        "SELECT turn_id, name, meta FROM turn_spans WHERE kind = 'background_wake' "
        "ORDER BY started_at"
    )
    return [dict(r) for r in rows if turn_id is None or r["turn_id"] == turn_id]


async def _rows(pool):
    return await pool.fetch("SELECT * FROM wake_attempts ORDER BY created_at")


async def _open_turn(pool) -> traces.Turn:
    return await traces.open_turn(pool, kind="chat")


def _frames(body: str) -> list:
    import json

    out = []
    for block in body.strip().split("\n\n"):
        payload = block[len("data: ") :]
        out.append(payload if payload == "[DONE]" else json.loads(payload))
    return out


# -- the turn never waits ---------------------------------------------------------


async def test_a_chat_turn_answers_and_closes_while_its_wake_is_still_being_sent(
    owner_client, mount_peers, pool, world
):
    world.release.clear()  # the relay hangs until the test lets it answer
    gateway = FakeGateway(deltas=("From", " the cloud."), served_by="cloud:m", route_header=ROUTE)
    mount_peers(gateway=gateway, memory=FakeMemory())

    resp = await asyncio.wait_for(
        owner_client.post("/api/v1/chat/stream", json={"message": "hello"}), 10
    )
    assert resp.status_code == 200
    sent = _frames(resp.text)
    turn_id = uuid.UUID(sent[0]["meta"]["turn_id"])
    # The turn's own detached work (its close) finishes without the wake.
    await asyncio.wait_for(chat.drain_background(), 10)
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) == "ok"
    assert (
        await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
        == "From the cloud."
    )
    # ...while the wake is still at the relay, tracked, not finished.
    await asyncio.wait_for(world.started.wait(), 10)
    assert len(world.sends) == 1 and world.sends[0]["args"]["mac"] == WIFI_MAC
    assert wake.ROUTE_WAKES and not all(t.done() for t in wake.ROUTE_WAKES)
    assert await _rows(pool) == []

    world.release.set()
    await _settle_wakes()
    (row,) = await _rows(pool)
    assert row["trigger"] == "route" and row["turn_id"] == turn_id
    assert row["device_id"] == world.box and row["outcome"] == "no_answer"
    (span,) = await _bg_spans(pool, turn_id)
    assert span["name"] == "box"
    assert span["meta"]["background_wake"] == {
        "machine": "box",
        "links": [LINK],
        "attempt": str(row["id"]),
        "outcome": "no_answer",
    }
    assert WIFI_MAC not in str(span["meta"])


async def test_the_llm_call_span_records_the_typed_route_ids(
    owner_client, mount_peers, pool, world
):
    gateway = FakeGateway(
        deltas=("ok",),
        served_by="cloud:m",
        route_header="role=chat;link=3;unreachable=boxllm:a%2Cb;connect_walled=boxllm:big",
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "hello"})
    assert resp.status_code == 200
    await chat.drain_background()
    await _settle_wakes()
    meta = await pool.fetchval("SELECT meta FROM turn_spans WHERE kind = 'llm_call' LIMIT 1")
    assert meta["route_unreachable"] == ["boxllm:a,b"]
    assert meta["route_connect_walled"] == ["boxllm:big"]
    (span,) = await _bg_spans(pool)
    assert span["meta"]["background_wake"]["links"] == ["boxllm:a,b", "boxllm:big"]


async def test_a_route_with_nothing_unreachable_starts_no_wake(
    owner_client, mount_peers, pool, world
):
    gateway = FakeGateway(deltas=("ok",), served_by="cloud:m", route_header="role=chat;link=1")
    mount_peers(gateway=gateway, memory=FakeMemory())
    await owner_client.post("/api/v1/chat/stream", json={"message": "hello"})
    await chat.drain_background()
    assert not wake.ROUTE_WAKES
    meta = await pool.fetchval("SELECT meta FROM turn_spans WHERE kind = 'llm_call' LIMIT 1")
    assert "route_unreachable" not in meta and "route_connect_walled" not in meta
    assert world.sends == [] and await _rows(pool) == [] and await _bg_spans(pool) == []


# -- every round that walks a chain; none that does not --------------------------------


class RefusingGateway:
    """A 503 with the gateway's typed route header: nothing could answer."""

    def __init__(self, route: str) -> None:
        self.route = route
        self.app = Starlette(
            routes=[Route("/v1/chat/completions", self._completions, methods=["POST"])]
        )

    async def _completions(self, request):
        return JSONResponse(
            {"error": {"message": "no link could answer"}},
            status_code=503,
            headers={"X-Nova-Route": self.route},
        )


async def test_a_503_round_with_an_unreachable_link_starts_the_wake(mount_peers, pool, world):
    mount_peers(gateway=RefusingGateway(f"role=chat;unreachable={LINK}"))
    turn = await _open_turn(pool)
    _text, _calls, failure = await chat._gateway_round(
        app, turn, "m", [{"role": "user", "content": "hi"}], [], round_number=1, on_delta=None
    )
    assert failure and "503" in failure
    await _settle_wakes()
    (row,) = await _rows(pool)
    assert row["trigger"] == "route" and row["turn_id"] == turn.id


async def test_a_judge_round_walks_a_chain_and_starts_the_wake_too(mount_peers, pool, world):
    gateway = FakeGateway(deltas=("on",), served_by="cloud:m", route_header=ROUTE)
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn = await _open_turn(pool)
    await chat._collect_completion(
        app, turn, "m", [{"role": "user", "content": "x"}], purpose="judge"
    )
    await _settle_wakes()
    (row,) = await _rows(pool)
    assert row["turn_id"] == turn.id


async def test_an_eval_round_walks_no_chain_and_never_wakes_a_machine(mount_peers, pool, world):
    gateway = FakeGateway(deltas=("ok",), served_by="cloud:m", route_header=ROUTE)
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC), kind="eval")
    await chat._gateway_round(
        app, turn, "m", [{"role": "user", "content": "hi"}], [], round_number=1, on_delta=None
    )
    assert not wake.ROUTE_WAKES
    assert world.sends == []


async def test_an_eval_turns_judge_round_never_wakes_a_machine(mount_peers, pool, world):
    """An eval turn's judge/redirect round walks the judge role's chain, so
    its route can name a sleeping machine — a replay must still never reach
    a real one."""
    gateway = FakeGateway(deltas=("on",), served_by="cloud:m", route_header=ROUTE)
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC), kind="eval")
    await chat._collect_completion(
        app, turn, "m", [{"role": "user", "content": "x"}], purpose="judge"
    )
    await chat._collect_completion(
        app, turn, "m", [{"role": "user", "content": "x"}], purpose="redirect"
    )
    (llm, _redirect) = [s for s in turn.spans if s.kind == "llm_call"]
    assert llm.meta["route_unreachable"] == [LINK]  # the route DID name it
    assert not wake.ROUTE_WAKES
    assert world.sends == [] and await _rows(pool) == []


# -- debounce, derived from the rows -----------------------------------------------------


async def _start(pool) -> traces.Turn:
    turn = await _open_turn(pool)
    wake.start_route_wakes(app, turn.id, {"unreachable": [LINK]})
    await _settle_wakes()
    return turn


async def _sent_row(pool, world, *, sent_at, outcome=None, deadline_s=120):
    attempt = await wake_attempts.record_sent(
        pool,
        device_id=world.box,
        relay_device_id=world.hub,
        adapter="Wi-Fi",
        mac=WIFI_MAC,
        relay_iface="eth0",
        broadcast="192.0.2.255",
        packets=6,
        trigger="tool",
        sent_at=sent_at,
        deadline_s=deadline_s,
    )
    if outcome is not None:
        await pool.execute(
            "UPDATE wake_attempts SET outcome = $2::text, decided_at = $3::timestamptz, "
            "serving_at = CASE WHEN $2::text = 'ready' THEN $3::timestamptz END WHERE id = $1",
            attempt,
            outcome,
            sent_at + timedelta(seconds=10),
        )
    return attempt


async def test_an_open_attempt_means_no_send_and_the_span_says_why(pool, world):
    await _sent_row(pool, world, sent_at=T0 - timedelta(seconds=20))
    turn = await _start(pool)
    assert world.sends == []
    assert len(await _rows(pool)) == 1
    (span,) = await _bg_spans(pool, turn.id)
    fact = span["meta"]["background_wake"]
    assert fact["machine"] == "box" and fact["links"] == [LINK] and "attempt" not in fact
    assert "already" in fact["reason"] and "2026-10-12 08:59:40 UTC" in fact["reason"]


async def test_a_decided_attempt_still_inside_its_deadline_means_no_send(pool, world):
    await _sent_row(pool, world, sent_at=T0 - timedelta(seconds=60), outcome="ready")
    turn = await _start(pool)
    assert world.sends == []
    (span,) = await _bg_spans(pool, turn.id)
    assert "within its" in span["meta"]["background_wake"]["reason"]


async def test_a_recent_relay_cannot_means_no_send(pool, world):
    await wake_attempts.record_not_sent(
        pool,
        device_id=world.box,
        outcome="relay_cannot",
        reason="no connected agent shares box's network",
        trigger="route",
    )
    # The not-sent row is stamped by the DB clock; the fake clock is set to it.
    world.t = await pool.fetchval("SELECT created_at FROM wake_attempts") + timedelta(seconds=5)
    turn = await _start(pool)
    assert world.sends == []
    (span,) = await _bg_spans(pool, turn.id)
    assert "relay" in span["meta"]["background_wake"]["reason"]


async def test_an_attempt_past_its_deadline_does_not_block_the_next_send(pool, world):
    old = await _sent_row(pool, world, sent_at=T0 - timedelta(seconds=300))
    turn = await _start(pool)
    assert len(world.sends) == 1
    rows = await _rows(pool)
    assert [r["outcome"] for r in rows] == ["no_answer", "no_answer"]
    assert rows[0]["id"] == old
    (span,) = await _bg_spans(pool, turn.id)
    assert span["meta"]["background_wake"]["attempt"] == str(rows[1]["id"])


async def test_two_turns_while_the_first_wake_is_still_sending_send_once(pool, world):
    world.release.clear()
    first = await _open_turn(pool)
    second = await _open_turn(pool)
    wake.start_route_wakes(app, first.id, {"unreachable": [LINK]})
    await asyncio.wait_for(world.started.wait(), 10)
    wake.start_route_wakes(app, second.id, {"unreachable": [LINK]})
    for _ in range(50):
        if await _bg_spans(pool, second.id):
            break
        await asyncio.sleep(0.01)
    world.release.set()
    await _settle_wakes()
    assert len(world.sends) == 1
    (span,) = await _bg_spans(pool, second.id)
    # What is known: a wake is pending, and since when — never which turn
    # started it (it can be this turn's own earlier round).
    assert span["meta"]["background_wake"]["reason"] == (
        "a wake for box is already pending (attempt since 2026-10-12 09:00:00 UTC)"
    )
    (row,) = await _rows(pool)
    assert row["turn_id"] == first.id


# -- failures are recorded, never raised ------------------------------------------------


async def test_a_relay_that_throws_is_logged_and_recorded_never_raised(pool, world, caplog):
    world.answer = RuntimeError("relay exploded")
    with caplog.at_level(logging.WARNING, logger="core"):
        turn = await _start(pool)
    (span,) = await _bg_spans(pool, turn.id)
    fact = span["meta"]["background_wake"]
    assert fact["machine"] == "box" and "relay exploded" in fact["reason"]
    assert any("relay exploded" in r.getMessage() for r in caplog.records)
    assert all(not t.done() or t.exception() is None for t in wake.ROUTE_WAKES)


async def test_unreadable_route_inputs_are_recorded_with_no_machine(pool, world, caplog):
    world.inputs_error = RuntimeError("gateway down")
    with caplog.at_level(logging.WARNING, logger="core"):
        turn = await _start(pool)
    (span,) = await _bg_spans(pool, turn.id)
    fact = span["meta"]["background_wake"]
    assert fact["machine"] is None and fact["links"] == [LINK]
    assert "gateway down" in fact["reason"]
    assert world.sends == []


async def test_a_wake_the_relay_cannot_send_is_recorded_with_its_row(pool, world):
    world.connected.pop(str(world.hub))  # the hub's agent is offline: no relay
    turn = await _start(pool)
    (row,) = await _rows(pool)
    assert row["outcome"] == "relay_cannot" and row["trigger"] == "route"
    assert row["turn_id"] == turn.id
    (span,) = await _bg_spans(pool, turn.id)
    fact = span["meta"]["background_wake"]
    assert fact["attempt"] == str(row["id"]) and fact["outcome"] == "relay_cannot"
    assert "reason" in fact


# -- shutdown -----------------------------------------------------------------------------


async def test_the_apps_shutdown_cancels_a_wake_still_in_flight(pool, world, monkeypatch):
    async def already_settled(pool_, app_):
        return True

    monkeypatch.setattr(browser_agent, "ensure_browser_agent", already_settled)
    world.release.clear()
    async with lifespan(app):
        turn = await _open_turn(pool)
        wake.start_route_wakes(app, turn.id, {"unreachable": [LINK]})
        await asyncio.wait_for(world.started.wait(), 10)
        held = list(wake.ROUTE_WAKES)
        assert held
    assert all(t.done() for t in held)
    assert not wake.ROUTE_WAKES


# -- S46a T12: a background wake that lands is news, once ----------------------------------
#
# When the wake's wait ends: answered (or serving) -> one non-urgent notice
# "<machine> answered after N s" and the gateway's walls on that machine's
# providers lifted (DELETE /admin/routes/walls/{provider}) so the next turn
# routes to it; no answer -> one notice with the outcome. One per attempt
# (keyed by its id), never repeated; a clear that fails is logged and said.


class WallGateway:
    """The gateway's wall-clear route, per provider: 200 cleared, 404 not
    walled, or whatever `status` says; every call recorded."""

    def __init__(self, status: dict[str, int] | None = None) -> None:
        self.status = status or {}
        self.cleared: list[str] = []
        self.app = Starlette(
            routes=[
                Route("/admin/routes/walls/{provider}", self._clear, methods=["DELETE"]),
            ]
        )

    async def _clear(self, request):
        provider = request.path_params["provider"]
        self.cleared.append(provider)
        status = self.status.get(provider, 200)
        if status == 200:
            return JSONResponse({"provider": provider, "cleared": True})
        if status == 404:
            return JSONResponse({"detail": f"{provider!r} is not walled"}, status_code=404)
        if status == 4040:
            # A 404 that is not the clear's "not walled": a wrong path, an
            # older gateway without the route.
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        return JSONResponse({"detail": "the walls table is locked"}, status_code=status)


async def _notices(pool) -> list[dict]:
    rows = await pool.fetch(
        "SELECT * FROM notices WHERE check_name = 'machine_wakes' ORDER BY first_seen_at"
    )
    return [dict(r) for r in rows]


async def test_an_answered_background_wake_files_one_notice_and_lifts_the_wall(
    mount_peers, pool, world
):
    walls = WallGateway()
    mount_peers(gateway=walls)
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)
    turn = await _start(pool)
    (row,) = await _rows(pool)
    assert row["outcome"] == "answered"
    assert walls.cleared == ["boxllm"]
    (notice,) = await _notices(pool)
    assert notice["urgent"] is False and notice["turn_id"] == turn.id
    assert notice["finding_key"] == f"wake_landed:{row['id']}"
    assert notice["title"].startswith("box answered after 10 s.")
    assert "Lifted the gateway's wall on boxllm" in notice["title"]
    assert notice["facts"]["attempt"] == str(row["id"])
    assert notice["facts"]["answered_after_s"] == 10
    # Only the columns that never move once the wait ended — never outcome.
    assert set(notice["facts"]) == {
        "machine",
        "attempt",
        "sent_at",
        "deadline_s",
        "answered_after_s",
        "serving_after_s",
    }
    assert WIFI_MAC not in str(notice)


async def test_a_serving_background_wake_says_when_its_model_answered(
    mount_peers, pool, world, monkeypatch
):
    mount_peers(gateway=WallGateway())
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)

    async def serving(app_, provider) -> bool:
        return world.t >= T0 + timedelta(seconds=30)

    monkeypatch.setattr(wake, "_serving", serving)
    await _start(pool)
    (row,) = await _rows(pool)
    assert row["outcome"] == "ready"
    (notice,) = await _notices(pool)
    assert notice["title"].startswith("box answered after 10 s; its model served after 30 s.")
    assert notice["facts"]["serving_after_s"] == 30


async def test_a_background_wake_with_no_answer_files_the_outcome_and_lifts_nothing(
    mount_peers, pool, world
):
    walls = WallGateway()
    mount_peers(gateway=walls)
    await _start(pool)
    (row,) = await _rows(pool)
    assert row["outcome"] == "no_answer"
    assert walls.cleared == []
    (notice,) = await _notices(pool)
    assert notice["urgent"] is False
    assert notice["title"] == (
        "box: a wake was sent at 2026-10-12 09:00:00 UTC; no answer in 120 s."
    )
    assert notice["facts"]["answered_after_s"] is None


async def test_a_wall_that_could_not_be_lifted_is_logged_and_said(mount_peers, pool, world, caplog):
    mount_peers(gateway=WallGateway({"boxllm": 500}))
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)
    with caplog.at_level(logging.WARNING, logger="core"):
        await _start(pool)
    (notice,) = await _notices(pool)
    assert notice["title"].startswith("box answered after 10 s.")
    assert "could not be lifted" in notice["title"] and "boxllm" in notice["title"]
    assert "500" in notice["title"]
    assert any("boxllm" in r.getMessage() and "wall" in r.getMessage() for r in caplog.records)


async def test_an_unreachable_gateway_for_the_clear_is_said_too(pool, world, caplog, monkeypatch):
    # No gateway link at all: the clear cannot be made.
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)
    with caplog.at_level(logging.WARNING, logger="core"):
        await _start(pool)
    (notice,) = await _notices(pool)
    assert "could not be lifted" in notice["title"]
    assert any("wall" in r.getMessage() for r in caplog.records)


async def test_a_provider_that_was_not_walled_is_not_a_failure(mount_peers, pool, world):
    walls = WallGateway({"boxllm": 404})
    mount_peers(gateway=walls)
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)
    await _start(pool)
    (notice,) = await _notices(pool)
    assert walls.cleared == ["boxllm"]
    assert notice["title"] == "box answered after 10 s."


async def test_a_404_that_is_not_the_not_walled_answer_is_logged_and_said(
    mount_peers, pool, world, caplog
):
    """Only the clear's own 404 ("'p' is not walled") means nothing to lift.
    Any other 404 lifted nothing for a reason not known: logged AND stated."""
    walls = WallGateway({"boxllm": 4040})
    mount_peers(gateway=walls)
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)
    with caplog.at_level(logging.WARNING, logger="core"):
        await _start(pool)
    (notice,) = await _notices(pool)
    assert walls.cleared == ["boxllm"]
    assert notice["title"] == (
        "box answered after 10 s. The gateway's wall on boxllm could not be lifted (the "
        "gateway answered 404); the next turn may pass it over until the wall lapses."
    )
    assert any("boxllm" in r.getMessage() and "404" in r.getMessage() for r in caplog.records)


async def test_one_notice_per_attempt_never_repeated(mount_peers, pool, world):
    walls = WallGateway()
    mount_peers(gateway=walls)
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)
    turn = await _start(pool)
    (row,) = await _rows(pool)
    await wake.announce_landing(app, turn.id, "box", row["id"])
    await wake.announce_landing(app, turn.id, "box", row["id"])
    (notice,) = await _notices(pool)
    assert notice["repeats"] == 1
    assert walls.cleared == ["boxllm"]


async def test_a_wake_that_sent_nothing_files_no_notice(mount_peers, pool, world):
    mount_peers(gateway=WallGateway())
    world.connected.pop(str(world.hub))  # no relay: relay_cannot
    await _start(pool)
    assert [r["outcome"] for r in await _rows(pool)] == ["relay_cannot"]
    await _sent_row(pool, world, sent_at=T0 - timedelta(seconds=20))  # debounced next time
    await _start(pool)
    assert await _notices(pool) == []


async def test_the_hourly_check_derives_the_same_finding_so_the_beat_folds(
    mount_peers, pool, world
):
    from app import checks

    mount_peers(gateway=WallGateway())
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)
    await _start(pool)
    (notice,) = await _notices(pool)
    check = checks.REGISTRY["machine_wakes"]
    assert check.urgent is False
    findings = await check.run(app, pool)
    (finding,) = findings
    assert finding.key == notice["finding_key"]
    assert checks.fingerprint(finding) == notice["fingerprint"]


async def test_the_hourly_check_folds_even_after_the_rows_outcome_moved(mount_peers, pool, world):
    """An answered row with no model to probe takes its outcome only at its
    deadline: the moment's notice and the hour's derivation can read the same
    attempt with a different outcome, and must still be the same news."""
    from app import checks

    mount_peers(gateway=WallGateway())
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)
    await _start(pool)
    (notice,) = await _notices(pool)
    decided = await pool.fetchval("SELECT decided_at FROM wake_attempts")
    for outcome in (None, "answered"):  # still open at the moment, decided by the hour
        await pool.execute(
            "UPDATE wake_attempts SET outcome = $1::text, "
            "decided_at = CASE WHEN $1::text IS NULL THEN NULL ELSE $2::timestamptz END",
            outcome,
            decided,
        )
        (finding,) = await checks.REGISTRY["machine_wakes"].run(app, pool)
        assert finding.key == notice["finding_key"]
        assert checks.fingerprint(finding) == notice["fingerprint"], outcome


async def test_unreadable_providers_are_logged_and_named_in_the_notice(
    mount_peers, pool, world, caplog, monkeypatch
):
    walls = WallGateway()
    mount_peers(gateway=walls)
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)

    async def unreadable(app_, name):
        return [], "the gateway's model providers could not be read — gateway down"

    monkeypatch.setattr(wake, "_providers_on", unreadable)
    with caplog.at_level(logging.WARNING, logger="core"):
        await _start(pool)
    (notice,) = await _notices(pool)
    assert notice["title"].startswith("box answered after 10 s.")
    assert "walls were not lifted" in notice["title"]
    assert "could not be read — gateway down" in notice["title"]
    assert walls.cleared == []
    assert any(
        "not lifted" in r.getMessage() and "gateway down" in r.getMessage() for r in caplog.records
    )


async def test_the_check_ignores_a_wake_she_was_asked_for(pool, world):
    from app import checks

    await _sent_row(pool, world, sent_at=datetime.now(UTC) - timedelta(seconds=300))
    await pool.execute("UPDATE wake_attempts SET outcome = 'no_answer', decided_at = now()")
    assert await checks.REGISTRY["machine_wakes"].run(app, pool) == []
    await pool.execute("UPDATE wake_attempts SET trigger = 'route'")
    (finding,) = await checks.REGISTRY["machine_wakes"].run(app, pool)
    assert finding.facts["machine"] == "box"
