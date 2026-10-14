"""S46a T11: no link left — the turn says the machine is offline and that a
wake was sent (or why not), built from the records, and closes ok.

The owner's "Don't wait, fall back" (2026-10-10) with the hub last resort
OFF on his stack: when the gateway answers 503 (nothing in the chain could
answer) and its route types a link `unreachable` / `connect_walled` whose
machine is paired and not connected, the turn does not end in an error. It
closes status ok with a MECHANICAL reply: "<machine> is offline (its agent
last seen at T) — I sent a wake at T from <relay>." (from that turn's
wake_attempts row and devices.last_seen), or why no wake was sent; then
"Nothing else could answer: <the gateway's other verdicts, short>." and "Ask
again once it answers." Never the model, never "asleep" (T30 states that),
never "woke".

A 503 whose route names no machine to wake keeps today's statement and
status error; a served answer (the hub last resort ON, or any link) is
untouched.

DB-backed; the outside world is faked through wake.py's seams exactly as
test_background_wake does. Documentation MACs and TEST-NET addresses only.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from starlette.responses import JSONResponse

from app import chat, devices, devices_ws, traces, wake
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_background_wake import LINK, PROVIDERS, World, _rows, _settle_wakes
from tests.test_machine_wake import HUB_FACTS, TARGET_FACTS, _device

pytestmark = requires_db

T0 = datetime(2026, 10, 12, 9, 0, tzinfo=UTC)
CLOUD_REASON = "cloud refused (402): This request requires more credits"
WORDS = (
    "no model in the 'chat' chain can serve right now — "
    f"{LINK}: {LINK} refused (502): could not reach boxllm at http://192.0.2.23:8080/v1 — "
    f"ConnectTimeout; cloud:m: {CLOUD_REASON}"
)
TAIL = f" Nothing else could answer: cloud:m: {CLOUD_REASON}. Ask again once it answers."


@dataclass
class NoLinkGateway(FakeGateway):
    """The real gateway's 503: {"error": words} WITH its typed route header
    (FakeGateway sends no route header on a refusal)."""

    status: int = 503
    refusal_words: str = WORDS

    async def _completions(self, request):
        await self._record(request)
        if self.status != 200:
            headers = {"X-Nova-Route": self.route_header} if self.route_header else {}
            return JSONResponse(
                {"error": self.refusal_words}, status_code=self.status, headers=headers
            )
        return await super()._completions(request)


@pytest.fixture
async def world(pool, monkeypatch):
    w = World()
    w.t = T0
    monkeypatch.setattr(wake, "_now", w.now)
    monkeypatch.setattr(wake, "_sleep", w.sleep)
    # Patched on the CLASS: undoing an instance patch leaves the old bound
    # method stuck on the shared hub instance, shadowing later class patches
    # (test_devices_ws read "connected" through it — CI on #164).
    monkeypatch.setattr(
        devices_ws.Hub, "is_connected", lambda _self, device_id: w.is_connected(device_id)
    )
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


def _frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        payload = block[len("data: ") :]
        out.append(payload if payload == "[DONE]" else json.loads(payload))
    return out


async def _ask(owner_client, pool) -> tuple[uuid.UUID, list, str | None, str | None]:
    resp = await asyncio.wait_for(
        owner_client.post("/api/v1/chat/stream", json={"message": "what is 2+2?"}), 20
    )
    assert resp.status_code == 200
    frames = _frames(resp.text)
    turn_id = uuid.UUID(frames[0]["meta"]["turn_id"])
    await asyncio.wait_for(chat.drain_background(), 20)
    status = await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id)
    reply = await pool.fetchval(
        "SELECT content FROM messages WHERE role = 'assistant' AND turn_id = $1", turn_id
    )
    return turn_id, frames, status, reply


async def _last_seen(pool, device_id) -> str:
    at = await pool.fetchval("SELECT last_seen FROM devices WHERE id = $1", device_id)
    return wake._utc(at)


def _streamed(frames: list) -> str:
    return "".join(f["t"] for f in frames if isinstance(f, dict) and "t" in f)


def _mount(mount_peers, route: str, **kw) -> NoLinkGateway:
    gateway = NoLinkGateway(route_header=route, **kw)
    mount_peers(gateway=gateway, memory=FakeMemory())
    return gateway


# -- the wake was sent ----------------------------------------------------------------


async def test_no_link_left_closes_ok_with_the_wake_stated_from_its_row(
    owner_client, mount_peers, pool, world
):
    _mount(mount_peers, f"role=chat;unreachable={LINK}")

    turn_id, frames, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    seen = await _last_seen(pool, world.box)
    (row,) = await _rows(pool)
    assert row["turn_id"] == turn_id and row["trigger"] == "route"
    assert row["sent_at"] == T0
    assert reply == (
        f"box is offline (its agent last seen at {seen}) — I sent a wake at "
        f"{wake._utc(T0)} from hubhost." + TAIL
    )
    # Streamed as the reply, the same words; no error frame.
    assert _streamed(frames) == reply
    assert not any(isinstance(f, dict) and "error" in f for f in frames)
    for word in ("asleep", "woke", "awake", "02:00:5e"):
        assert word not in reply
    # ci-event-gaps T2: an ok turn, but the reply is the backend's, not hers.
    meta = await pool.fetchval(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'no_answer'", turn_id
    )
    meta = meta if isinstance(meta, dict) else json.loads(meta)
    assert meta == {"reason": chat.NO_ANSWER_NO_LINK, "words": reply}
    await _settle_wakes()


async def test_a_connect_walled_link_counts_too(owner_client, mount_peers, pool, world):
    _mount(mount_peers, f"role=chat;connect_walled={LINK}")

    _turn_id, _frames_, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    assert reply.startswith("box is offline (its agent last seen at ")
    assert f"I sent a wake at {wake._utc(T0)} from hubhost." in reply
    await _settle_wakes()


# -- no wake sent: why, from the record ----------------------------------------------------


async def test_no_relay_connected_says_why_no_wake_was_sent(owner_client, mount_peers, pool, world):
    world.connected.clear()  # the hub's own agent is offline
    _mount(mount_peers, f"role=chat;unreachable={LINK}")

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    seen = await _last_seen(pool, world.box)
    assert reply.startswith(f"box is offline (its agent last seen at {seen}) — no wake was sent: ")
    assert "hubhost is offline" in reply
    assert "I sent" not in reply
    assert reply.endswith(TAIL)
    (row,) = await _rows(pool)
    assert row["outcome"] == "relay_cannot" and row["sent_at"] is None


async def test_a_pending_attempt_is_stated_and_nothing_more_is_sent(
    owner_client, mount_peers, pool, world
):
    earlier = T0 - timedelta(seconds=30)
    await pool.execute(
        "INSERT INTO wake_attempts (device_id, relay_device_id, adapter, mac, relay_iface, "
        "broadcast, packets, trigger, sent_at, deadline_s) "
        "VALUES ($1, $2, 'Wi-Fi', '02:00:5e:10:00:01', 'eth0', '192.0.2.255', 6, 'tool', $3, 120)",
        world.box,
        world.hub,
        earlier,
    )
    _mount(mount_peers, f"role=chat;unreachable={LINK}")

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    assert "— no wake was sent: " in reply
    assert f"already open, sent at {wake._utc(earlier)}" in reply
    assert "I sent" not in reply
    assert world.sends == []
    assert len(await _rows(pool)) == 1


async def test_no_mac_on_record_says_so(owner_client, mount_peers, pool, world):
    await pool.execute(
        "UPDATE devices SET facts = $2::jsonb WHERE id = $1",
        world.box,
        {"net": {"ifaces": [{"name": "Wi-Fi", "mac": "", "ipv4_cidr": ["192.0.2.23/24"]}]}},
    )
    _mount(mount_peers, f"role=chat;unreachable={LINK}")

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    assert "— no wake was sent: " in reply
    assert "no adapter with a hardware address" in reply
    assert world.sends == [] and await _rows(pool) == []


async def test_a_relay_that_never_answers_is_not_known_never_sent(
    owner_client, mount_peers, pool, world
):
    world.answer = devices.DeviceRefused("no answer within 30 s")
    _mount(mount_peers, f"role=chat;unreachable={LINK}")

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    assert "— no wake was sent: " not in reply and "I sent" not in reply
    assert "whether it sent is not known" in reply
    assert await _rows(pool) == []


async def test_a_send_still_in_flight_past_the_wait_is_stated_as_not_known_yet(
    owner_client, mount_peers, pool, world, monkeypatch
):
    world.release.clear()  # the relay hangs
    monkeypatch.setattr(wake, "NO_LINK_WAIT_S", 0.3)
    _mount(mount_peers, f"role=chat;unreachable={LINK}")

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    assert "I sent" not in reply
    # The record says only that the send was not decided in time — never a
    # cause it did not check (the hang can be anywhere before the relay).
    assert "whether a wake was sent is not known yet: the send had not completed within 0.3 s." in (
        reply
    )
    assert "relay" not in reply and "answered within" not in reply
    assert reply.endswith(TAIL)
    world.release.set()
    await _settle_wakes()


async def test_the_reply_waits_for_the_send_never_for_the_answer(
    owner_client, mount_peers, pool, world, monkeypatch
):
    """The relay sends at once; the machine's wait never ends here. The reply
    still says the wake was sent — from the row, the moment it is written —
    and does not wait out the wake."""
    never = asyncio.Event()

    async def waits_forever(seconds: float) -> None:
        await never.wait()  # held until the test is done, then the fake clock
        await world.sleep(seconds)

    monkeypatch.setattr(wake, "_sleep", waits_forever)
    monkeypatch.setattr(wake, "NO_LINK_WAIT_S", 3)
    _mount(mount_peers, f"role=chat;unreachable={LINK}")

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    seen = await _last_seen(pool, world.box)
    assert reply == (
        f"box is offline (its agent last seen at {seen}) — I sent a wake at "
        f"{wake._utc(T0)} from hubhost." + TAIL
    )
    (row,) = await _rows(pool)
    assert row["outcome"] is None  # the wake is still waiting for the answer
    assert any(not t.done() for t in wake.ROUTE_WAKES)
    never.set()
    await _settle_wakes()


# -- the other verdicts, short ----------------------------------------------------------


async def test_a_long_verdict_is_cut_short_and_the_machines_own_links_are_left_out(
    owner_client, mount_peers, pool, world
):
    long_reason = "openrouter refused (402): " + "credits " * 40
    words = (
        "no model in the 'chat' chain can serve right now — "
        f"{LINK}: could not reach boxllm — ConnectTimeout; boxllm:big: walled for another "
        f"5 min; openrouter:q: {long_reason.strip()}"
    )
    _mount(
        mount_peers, f"role=chat;unreachable={LINK};connect_walled=boxllm:big", refusal_words=words
    )

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    tail = reply.split("Nothing else could answer: ", 1)[1]
    assert tail.startswith("openrouter:q: openrouter refused (402): credits")
    assert "…" in tail
    assert len(tail) < 160
    assert LINK not in tail and "boxllm:big" not in tail
    assert tail.endswith(". Ask again once it answers.")
    await _settle_wakes()


# The owner's chain (2026-10-12): two links on the Dell, then openrouter, which
# may be out of credit. The verdict ids the 503 lists are the machine's own
# links (LINK, boxllm:big) and whatever else the chain holds.
OWN_LINKS = f"{LINK}: could not reach boxllm — ConnectTimeout; boxllm:big: walled for another 5 min"
OWN_ROUTE = f"role=chat;unreachable={LINK};connect_walled=boxllm:big"


async def test_a_503_listing_only_the_machines_links_says_no_other_model_could_answer(
    owner_client, mount_peers, pool, world
):
    """T13(b)'s case: the sleeping machine's links are the whole chain. The
    reply never ends in an empty "Nothing else could answer: ." — it says no
    other model could answer right now, which the 503 itself states. Never
    "no other model is in the chain": core reads a truncated failure text,
    so it cannot know the chain holds nothing else."""
    words = f"no model in the 'chat' chain can serve right now — {OWN_LINKS}"
    _mount(mount_peers, OWN_ROUTE, refusal_words=words)

    _turn_id, frames, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    seen = await _last_seen(pool, world.box)
    assert reply == (
        f"box is offline (its agent last seen at {seen}) — I sent a wake at "
        f"{wake._utc(T0)} from hubhost. No other model could answer right now. "
        "Ask again once it answers."
    )
    assert "Nothing else could answer" not in reply
    assert ": ." not in reply
    assert _streamed(frames) == reply
    await _settle_wakes()


async def test_the_machines_links_and_one_refused_other_name_only_that_one(
    owner_client, mount_peers, pool, world
):
    words = (
        f"no model in the 'chat' chain can serve right now — {OWN_LINKS}; "
        f"openrouter:q: {CLOUD_REASON}"
    )
    _mount(mount_peers, OWN_ROUTE, refusal_words=words)

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    assert reply.endswith(
        f". Nothing else could answer: openrouter:q: {CLOUD_REASON}. Ask again once it answers."
    )
    await _settle_wakes()


async def test_the_machines_links_and_several_others_list_each_briefly(
    owner_client, mount_peers, pool, world
):
    words = (
        f"no model in the 'chat' chain can serve right now — openrouter:q: {CLOUD_REASON}; "
        f"{OWN_LINKS}; cloud:m: walled for another 30 min; anthropic:h: "
        "anthropic refused (401): invalid x-api-key"
    )
    _mount(mount_peers, OWN_ROUTE, refusal_words=words)

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    assert reply.endswith(
        f". Nothing else could answer: openrouter:q: {CLOUD_REASON}; "
        "cloud:m: walled for another 30 min; "
        "anthropic:h: anthropic refused (401): invalid x-api-key. Ask again once it answers."
    )
    await _settle_wakes()


def test_other_verdicts_is_none_when_only_the_machines_links_are_listed():
    detail = f"no model in the 'chat' chain can serve right now — {OWN_LINKS}"
    assert wake.other_verdicts(detail, [LINK, "boxllm:big"]) is None
    assert wake.other_verdicts(detail, [LINK]) == "boxllm:big: walled for another 5 min"
    # An item that is not "<id>: <reason>" is not known to be the machine's:
    # kept as written, so an unreadable list never reads as "no other model".
    assert wake.other_verdicts("no model can serve — a garbled list", [LINK]) == "a garbled list"


def test_other_verdicts_keeps_a_walled_item_that_states_its_refusal_time_whole():
    """wall-probe T2 (a pin: passes before the gateway change too): the
    gateway's walled reason now carries "— refused at MM-DD HH:MM UTC; not
    retried since —" before the suffix. Its "; " and " — " must not split the
    item: it stays ONE "<id>: <reason>" (cut as any long reason is), and the
    machine's own links still leave."""
    reason = (
        "openrouter refused (402): Insufficient credits — refused at "
        "10-13 17:59 UTC; not retried since — walled for another 5 min"
    )
    detail = (
        f"no model in the 'chat' chain can serve right now — {OWN_LINKS}; openrouter:q: {reason}"
    )
    got = wake.other_verdicts(detail, [LINK, "boxllm:big"])
    assert got == f"openrouter:q: {wake._short(reason)}".rstrip(". ")
    assert got.startswith(
        "openrouter:q: openrouter refused (402): Insufficient credits — refused at"
    )
    # Two such items stay two, each whole up to its cut.
    detail = f"{detail}; cloud:m: {reason.replace('openrouter', 'cloud')}"
    got = wake.other_verdicts(detail, [LINK, "boxllm:big"])
    assert got.count("openrouter:q: ") == 1 and got.count("; cloud:m: cloud refused (402)") == 1


async def test_a_503_without_a_verdict_list_states_the_gateways_sentence(
    owner_client, mount_peers, pool, world
):
    _mount(
        mount_peers,
        f"role=chat;unreachable={LINK}",
        refusal_words="every link in the 'chat' chain refused this request",
    )

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    assert reply.endswith(
        " Nothing else could answer: every link in the 'chat' chain refused this request. "
        "Ask again once it answers."
    )
    await _settle_wakes()


# -- unchanged ---------------------------------------------------------------------------


async def test_a_503_with_no_route_keeps_the_error_statement(
    owner_client, mount_peers, pool, world
):
    _mount(mount_peers, "")

    _turn_id, frames, status, reply = await _ask(owner_client, pool)

    assert status == "error"
    assert reply.startswith("I didn't get a response from ")
    assert "the gateway refused the request (503)" in reply
    assert any(isinstance(f, dict) and "error" in f for f in frames)
    assert world.sends == []


async def test_a_503_whose_link_maps_to_no_machine_keeps_the_error_statement(
    owner_client, mount_peers, pool, world
):
    _mount(mount_peers, "role=chat;unreachable=cloud:m")

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "error"
    assert reply.startswith("I didn't get a response from ")
    assert world.sends == []


async def test_a_503_whose_machine_is_connected_keeps_the_error_statement(
    owner_client, mount_peers, pool, world, monkeypatch
):
    async def inputs(_app):
        agents = [
            {"name": "box", "connected": True, "hub": False, "addresses": ("192.0.2.23",)},
            {"name": "hubhost", "connected": True, "hub": True, "addresses": ("192.0.2.10",)},
        ]
        return PROVIDERS, agents, (await world.route_inputs(_app))[2]

    monkeypatch.setattr(wake, "_route_inputs", inputs)
    _mount(mount_peers, f"role=chat;unreachable={LINK}")

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "error"
    assert reply.startswith("I didn't get a response from ")
    assert world.sends == []


async def test_the_hub_last_resort_serving_is_untouched(owner_client, mount_peers, pool, world):
    _mount(
        mount_peers,
        f"role=chat;link=3;last_resort=1;unreachable={LINK}",
        status=200,
        deltas=("Four.",),
        served_by="hub:qwen3:8b",
    )

    _turn_id, _f, status, reply = await _ask(owner_client, pool)

    assert status == "ok"
    assert reply == "Four."
    await _settle_wakes()


async def test_a_served_round_that_fails_mid_stream_keeps_the_error_statement(
    owner_client, mount_peers, pool, world
):
    """A fallback link served (200) while the route named the box unreachable,
    then its stream failed: something else DID answer, so "Nothing else could
    answer" would be false. Only a 503 takes the no-link reply."""
    _mount(
        mount_peers,
        f"role=chat;link=2;unreachable={LINK}",
        status=200,
        deltas=(),
        error_chunk="the backend stream failed — ReadTimeout",
        served_by="cloud:m",
    )

    _turn_id, frames, status, reply = await _ask(owner_client, pool)

    assert status == "error"
    assert reply.startswith("I didn't get a response from ")
    assert "Nothing else could answer" not in reply
    assert any(isinstance(f, dict) and "error" in f for f in frames)
    await _settle_wakes()


async def test_a_turn_that_started_no_wake_has_no_no_link_reply(pool):
    turn = await traces.open_turn(pool, kind="chat")
    assert (
        await wake.no_link_reply(
            None, turn.id, "the gateway refused the request (503): nothing", timeout=0.1
        )
        is None
    )
