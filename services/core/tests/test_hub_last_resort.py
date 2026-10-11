"""The hub last resort, core's half (epic hub-last-resort, T2).

The owner's switch `routing.hub_last_resort` (default OFF) lives in core and
is stated per call in `X-Nova-Hub-Last-Resort: 1`, exactly like the decision
switches: the gateway reads none of core's settings. Pins: the def ships off
with its notice; every role-carrying chat call sends the header iff the
switch is on, read at call time; a call with no role never sends it; explain
(the Routing page, her route tool, an agent's route) forwards it and drops a
browser's own copy; a round the gateway served as the last resort lands
`last_resort` on its span and streams the gateway's own reason in the one
route frame."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from urllib.parse import parse_qs, quote

import httpx

from app import agents, chat, model_read, settings_store, traces
from app.main import app
from app.tools import route
from app.tools.base import ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat import _say, _set_model, _spans

pytestmark = requires_db

KEY = "routing.hub_last_resort"
HEADER = "x-nova-hub-last-resort"
COMPLETIONS = "/v1/chat/completions"
LAST_RESORT_REASON = (
    "fell back to the hub's own model hub:qwen3:8b (the hub's default model; last resort, "
    "CPU-only, slower) — dell:qwen3:8b: could not reach dell; "
    "openrouter:google/gemini-3.8-flash: openrouter refused (402)"
)
EXPLAIN = {"role": "chat", "chain": [], "would_serve": None, "reason": "no chain"}


async def _switch(owner_client, on: bool) -> None:
    resp = await owner_client.put("/api/v1/settings", json={"key": KEY, "value": on})
    assert resp.status_code == 200, resp.text


def _completion_headers(gateway: FakeGateway) -> list[dict[str, str]]:
    return [h for (p, _), h in zip(gateway.seen, gateway.seen_headers) if p == COMPLETIONS]


def _turn(**fields) -> traces.Turn:
    return traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC), model="qwen3:8b", **fields)


# -- the setting --------------------------------------------------------------


async def test_the_switch_ships_off_with_its_notice(owner_client, pool):
    resp = await owner_client.get("/api/v1/settings")
    item = {i["key"]: i for i in resp.json()["settings"]}[KEY]

    assert (item["type"], item["default"], item["value"]) == ("bool", False, False)
    notice = item["description"]
    # What it does, when it runs, and what it costs — the Settings notice.
    assert "hub's own" in notice and "CPU-only" in notice and "slower" in notice
    assert "every link" in notice
    # How it differs from naming a hub model as a chain link.
    assert "link" in notice and "hub:" in notice
    assert await settings_store.hub_last_resort(pool) is False


async def test_the_switch_takes_true_or_false_and_nothing_else(owner_client, pool):
    resp = await owner_client.put("/api/v1/settings", json={"key": KEY, "value": "true"})

    assert resp.status_code == 400
    assert f"setting {KEY} expects bool" in resp.json()["error"]
    assert await pool.fetchval("SELECT count(*) FROM settings WHERE key = $1", KEY) == 0


# -- the header on every role-carrying chat call -----------------------------


async def test_a_turn_states_the_switch_read_at_call_time(owner_client, mount_peers):
    """Off: no header at all — the gateway's off is the header's absence. On:
    the very next turn sends '1' with no restart; off again: gone."""
    gateway = FakeGateway(deltas=("Hi",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    await _say(owner_client, "one")
    assert all(HEADER not in h for h in _completion_headers(gateway))

    await _switch(owner_client, True)
    await _say(owner_client, "two")
    sent = _completion_headers(gateway)[-1]
    assert sent[HEADER] == "1" and sent["x-nova-role"] == "chat"

    await _switch(owner_client, False)
    await _say(owner_client, "three")
    assert HEADER not in _completion_headers(gateway)[-1]


async def test_a_judge_or_redirect_call_states_what_its_turn_carries(mount_peers):
    """The switch rides the Turn (read once in open_turn); the call reads no
    database for it — whatever the stored setting, the Turn decides."""
    gateway = FakeGateway(deltas=("on_topic",))
    mount_peers(gateway=gateway)
    ask = [{"role": "user", "content": "hi"}]

    await chat._collect_completion(app, _turn(), "qwen3:8b", ask, purpose="judge")
    assert HEADER not in _completion_headers(gateway)[-1]

    await chat._collect_completion(
        app, _turn(hub_last_resort=True), "qwen3:8b", ask, purpose="judge"
    )
    assert _completion_headers(gateway)[-1][HEADER] == "1"


async def test_open_turn_reads_the_switch_per_turn(owner_client, pool):
    assert (await traces.open_turn(pool)).hub_last_resort is False
    await _switch(owner_client, True)
    assert (await traces.open_turn(pool)).hub_last_resort is True
    await _switch(owner_client, False)
    assert (await traces.open_turn(pool)).hub_last_resort is False


async def test_a_beat_read_states_what_it_is_passed_and_a_call_with_no_role_never_does(
    mount_peers,
):
    """model_read.complete (distil, review) walks the beat role's chain, so it
    states the switch its caller read and passed; not passed is off. A call
    that names no role walks no chain (an eval, a warm-up) and the header
    would mean nothing — it is never sent."""
    gateway = FakeGateway(deltas=("[]",))
    mount_peers(gateway=gateway)

    async def read(headers: dict[str, str], **kw) -> None:
        await model_read.complete(
            app,
            system="s",
            brief="b",
            model=None,
            headers=headers,
            timeout=httpx.Timeout(5.0),
            max_tokens=16,
            **kw,
        )

    await read(model_read.attribution(uuid.uuid4(), "distil"))
    assert HEADER not in _completion_headers(gateway)[-1]

    await read(model_read.attribution(uuid.uuid4(), "distil"), hub_last_resort=True)
    assert _completion_headers(gateway)[-1][HEADER] == "1"

    await read({"X-Nova-Purpose": "eval"}, hub_last_resort=True)
    assert HEADER not in _completion_headers(gateway)[-1]


# -- explain -------------------------------------------------------------------


async def test_the_routing_page_explains_with_the_switch_and_drops_a_browsers(
    owner_client, mount_peers
):
    gateway = FakeGateway()
    mount_peers(gateway=gateway)

    await owner_client.get("/api/v1/routes/explain?role=chat&hub_last_resort=1")
    assert gateway.queries[-1] == b"role=chat"

    await _switch(owner_client, True)
    await owner_client.get("/api/v1/routes/explain?role=chat&hub_last_resort=0")
    assert parse_qs(gateway.queries[-1].decode()) == {"role": ["chat"], "hub_last_resort": ["1"]}


async def test_her_route_tool_and_an_agents_route_explain_with_the_switch(
    owner_client, mount_peers, tmp_path
):
    gateway = FakeGateway(explain_body=EXPLAIN)
    mount_peers(gateway=gateway)
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)

    await route.route_explain({"role": "chat", "model": "qwen3:8b"}, ctx)
    assert b"hub_last_resort" not in gateway.queries[-1]
    await agents._explain(app, "agent_coder", own_chain_empty=None)
    assert b"hub_last_resort" not in gateway.queries[-1]

    await _switch(owner_client, True)
    await route.route_explain({"role": "chat", "model": "qwen3:8b"}, ctx)
    assert parse_qs(gateway.queries[-1].decode())["hub_last_resort"] == ["1"]
    await agents._explain(app, "agent_coder", own_chain_empty=None)
    assert parse_qs(gateway.queries[-1].decode())["hub_last_resort"] == ["1"]


# -- a turn the last resort served --------------------------------------------


async def test_a_last_resort_round_is_on_the_span_and_stated_in_the_route_frame(
    owner_client, pool, mount_peers
):
    gateway = FakeGateway(
        deltas=("Hi",),
        served_by="hub:qwen3:8b",
        route_header=(
            f"role=chat;link=3;reason={quote(LAST_RESORT_REASON, safe='')};last_resort=1"
        ),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "dell:qwen3:8b")
    await _switch(owner_client, True)

    status, sent = await _say(owner_client, "hello")
    assert status == 200

    turn = await pool.fetchrow("SELECT id FROM turns")
    meta = (await _spans(pool, turn["id"]))["llm_call"]["meta"]
    assert meta["last_resort"] is True
    assert meta["route_link"] == 3 and meta["route_reason"] == LAST_RESORT_REASON

    routes = [f["route"] for f in sent if isinstance(f, dict) and "route" in f]
    assert routes == [
        {"role": "chat", "link": 3, "reason": LAST_RESORT_REASON, "served_by": "hub:qwen3:8b"}
    ]


async def test_an_ordinary_fallback_records_no_last_resort(owner_client, pool, mount_peers):
    gateway = FakeGateway(deltas=("Hi",), route_header="role=chat;link=2;reason=x")
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    await _say(owner_client, "hello")

    turn = await pool.fetchrow("SELECT id FROM turns")
    assert "last_resort" not in (await _spans(pool, turn["id"]))["llm_call"]["meta"]
