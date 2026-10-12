"""machine_wake (S46a T5): send a wake through the hub's own agent and MEASURE
whether the machine answered — never "woke" on the strength of a send.

DB-backed (the ledger is wake_attempts, T4). Everything outside the database
is faked through app/wake.py's seams: the relay's answer (_send), whether an
agent is connected (the hub's registry, devices_ws.hub.is_connected, under
the real agent_updates._connected read that records it), the clock and its
sleep (_now/_sleep), the
gateway providers that run on the target (_providers_on) and their model
endpoint (_serving). No packet leaves, no socket opens, no real wait.
Documentation MACs and TEST-NET addresses only (the repo is public)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app import devices, devices_ws, tools, wake, wake_attempts
from tests.conftest import requires_db

pytestmark = requires_db

WIFI_MAC = "02:00:5e:10:00:01"
ETH_MAC = "02:00:5e:10:00:02"
HUB_MAC = "02:00:5e:10:00:0a"
T0 = datetime(2026, 10, 11, 12, 0, tzinfo=UTC)
PROVIDER = {"name": "boxllm", "base_url": "http://192.0.2.23:8080/v1"}

TARGET_FACTS = {
    "net": {
        "ifaces": [
            {"name": "Wi-Fi", "mac": WIFI_MAC, "ipv4_cidr": ["192.0.2.23/24"], "up": True},
            {"name": "Ethernet", "mac": ETH_MAC, "ipv4_cidr": [], "up": False},
        ]
    }
}
HUB_FACTS = {
    "net": {
        "ifaces": [{"name": "eth0", "mac": HUB_MAC, "ipv4_cidr": ["192.0.2.10/24"], "up": True}]
    }
}


async def _device(pool, name, *, platform, facts, transport=None, key="ab"):
    return await pool.fetchval(
        "INSERT INTO devices (name, platform, hostname, pubkey, facts, facts_at, last_seen, "
        "last_transport) VALUES ($1, $2, $1, $3, $4::jsonb, now(), now(), $5) RETURNING id",
        name,
        platform,
        key * 32,
        facts,
        transport,
    )


class World:
    """The fake outside: a clock, who is connected when, what the relay says."""

    def __init__(self) -> None:
        self.t = T0
        self.connected: dict[str, datetime] = {}  # device id -> connected from
        self.serving_from: datetime | None = None
        self.sends: list[dict] = []
        self.answer: object = None  # dict to return, or an exception to raise
        self.providers: tuple[list[dict], str | None] = ([PROVIDER], None)
        self.probes = 0

    def now(self) -> datetime:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.t += timedelta(seconds=seconds)

    def is_connected(self, device_id) -> bool:
        since = self.connected.get(str(device_id))
        return since is not None and self.t >= since

    async def send(self, pool, relay, args, timeout):
        self.sends.append({"relay": relay, "args": dict(args), "timeout": timeout})
        if isinstance(self.answer, Exception):
            raise self.answer
        if self.answer is not None:
            return self.answer
        return {
            "ok": True,
            "output": "sent 6 magic packets",
            "meta": {"sent": 6, "iface": "eth0", "at": self.t.isoformat(), "to": []},
        }

    async def providers_on(self, app, name):
        return self.providers

    async def serving(self, app, provider) -> bool:
        self.probes += 1
        return self.serving_from is not None and self.t >= self.serving_from


@pytest.fixture
async def world(pool, monkeypatch):
    w = World()
    monkeypatch.setattr(wake, "_now", w.now)
    monkeypatch.setattr(wake, "_sleep", w.sleep)
    # Patched on the CLASS: undoing an instance patch leaves the old bound
    # method stuck on the shared hub instance, shadowing later class patches.
    monkeypatch.setattr(
        devices_ws.Hub, "is_connected", lambda _self, device_id: w.is_connected(device_id)
    )
    monkeypatch.setattr(wake, "_send", w.send)
    monkeypatch.setattr(wake, "_providers_on", w.providers_on)
    monkeypatch.setattr(wake, "_serving", w.serving)
    w.box = await _device(pool, "box", platform="windows", facts=TARGET_FACTS, key="ab")
    w.hub = await _device(
        pool, "hubhost", platform="linux", facts=HUB_FACTS, transport="host", key="cd"
    )
    w.connected[str(w.hub)] = T0 - timedelta(hours=1)
    return w


def _ctx(sink=None):
    return tools.context_for(SimpleNamespace(), SimpleNamespace(id="p"), facts_sink=sink)


async def _wake(args, sink=None):
    return await tools.dispatch("machine_wake", args, _ctx(sink))


def _clean(text: str) -> None:
    low = text.lower()
    assert "woke" not in low, text
    for mac in (WIFI_MAC, ETH_MAC, HUB_MAC):
        assert mac not in low and mac.replace(":", "") not in low, text


async def _rows(pool):
    return await pool.fetch("SELECT * FROM wake_attempts ORDER BY created_at")


# -- the measured send ----------------------------------------------------------


async def test_a_machine_that_answers_and_serves_is_ready_with_both_times(pool, world):
    world.connected[str(world.box)] = T0 + timedelta(seconds=40)
    world.serving_from = T0 + timedelta(seconds=52)
    sink: list[dict] = []
    text, ok = await _wake({"machine": "box"}, sink)
    assert ok, text
    _clean(text)
    assert "sent at 2026-10-11 12:00:00 UTC from hubhost (eth0)" in text
    assert "box's Wi-Fi" in text and "6 packets" in text
    assert "reconnected after 40 s" in text
    assert "boxllm" in text and "answered after 52 s" in text
    # exactly one send, through the hub's agent, with the target's own MAC
    assert len(world.sends) == 1
    assert world.sends[0]["relay"]["name"] == "hubhost"
    assert world.sends[0]["args"] == {"mac": WIFI_MAC, "broadcast": "192.0.2.255"}
    (row,) = await _rows(pool)
    assert row["outcome"] == "ready" and row["trigger"] == "tool"
    assert row["device_id"] == world.box and row["relay_device_id"] == world.hub
    assert row["sent_at"] == T0 and row["deadline_s"] == 120
    assert row["answered_at"] == T0 + timedelta(seconds=40)
    assert row["serving_at"] == T0 + timedelta(seconds=52)
    assert str(row["mac"]) == WIFI_MAC and row["adapter"] == "Wi-Fi"
    assert str(row["broadcast"]) == "192.0.2.255" and row["relay_iface"] == "eth0"
    fact = next(f for f in sink if "machine_wake" in f)
    assert fact == {
        "machine_wake": "box",
        "attempt": str(row["id"]),
        "outcome": "ready",
        "sent": True,
        "relay": "hubhost",
        "adapter": "Wi-Fi",
        "answered_after_s": 40,
        "serving_after_s": 52,
    }
    _clean(json.dumps(sink))


async def test_silence_until_the_deadline_is_no_answer(pool, world):
    text, ok = await _wake({"machine": "box", "wait_s": 60})
    assert ok, text
    _clean(text)
    assert "no answer within 60 s" in text
    assert "sending is not waking" in text.lower()
    (row,) = await _rows(pool)
    assert row["outcome"] == "no_answer" and row["deadline_s"] == 60
    assert row["answered_at"] is None and row["serving_at"] is None
    assert T0 + timedelta(seconds=60) <= world.t <= T0 + timedelta(seconds=60 + wake.POLL_S)
    assert world.probes == 0  # a sleeping machine's model is never probed


async def test_answered_but_the_model_never_served_is_answered(pool, world):
    world.connected[str(world.box)] = T0 + timedelta(seconds=30)
    text, ok = await _wake({"machine": "box", "wait_s": 60})
    assert ok, text
    _clean(text)
    assert "reconnected after 30 s" in text
    assert "did not answer within 60 s" in text
    (row,) = await _rows(pool)
    assert row["outcome"] == "answered" and row["serving_at"] is None


async def test_a_machine_with_no_routed_model_stops_at_its_answer(pool, world):
    world.providers = ([], None)
    world.connected[str(world.box)] = T0 + timedelta(seconds=20)
    text, ok = await _wake({"machine": "box"})
    assert ok, text
    _clean(text)
    assert "reconnected after 20 s" in text
    assert "runs no model" in text
    assert world.t < T0 + timedelta(seconds=120)  # it did not sit out the deadline
    (row,) = await _rows(pool)
    assert row["answered_at"] == T0 + timedelta(seconds=20)
    assert row["outcome"] is None  # decided at its deadline, from its columns
    assert "decided at its deadline" in text


async def test_a_provider_read_that_failed_is_stated(pool, world):
    world.providers = ([], "the gateway could not be reached — boom")
    world.connected[str(world.box)] = T0 + timedelta(seconds=10)
    text, ok = await _wake({"machine": "box"})
    assert ok, text
    assert "the gateway could not be reached — boom" in text


# -- nothing sent ----------------------------------------------------------------


async def test_a_connected_machine_is_already_awake_and_nothing_is_sent(pool, world):
    world.connected[str(world.box)] = T0 - timedelta(minutes=5)
    sink: list[dict] = []
    text, ok = await _wake({"machine": "box"}, sink)
    assert ok, text
    _clean(text)
    assert "already connected" in text and "nothing was sent" in text
    assert world.sends == []
    (row,) = await _rows(pool)
    assert row["outcome"] == "not_asleep" and row["sent_at"] is None
    fact = next(f for f in sink if "machine_wake" in f)
    assert fact["outcome"] == "not_asleep" and fact["sent"] is False
    # T5-T6 fix (VERIFY gap 2): the reading that found it connected is a fact
    # on the span — what backs T6's "the box was already awake" — filed by
    # the read itself (agent_updates._connected), not left to a fixture.
    assert {"device": "box", "connected": True} in sink
    assert [f for f in sink if f.get("device") == "box"] == [{"device": "box", "connected": True}]


async def test_the_already_awake_reading_backs_already_awake_through_the_guards(pool, world):
    """The producer and the consumer together: the span machine_wake leaves
    backs "the box was already awake" (wake-claim guard)."""
    from app import guards

    world.connected[str(world.box)] = T0 - timedelta(minutes=5)
    sink: list[dict] = []
    await _wake({"machine": "box"}, sink)
    span = SimpleNamespace(kind="tool", name="machine_wake", meta={"ok": True, "facts": sink})
    reply = "The box is already awake, so nothing was sent."
    assert guards.wake_claim_check(reply, [span], ["box", "hubhost"], purpose="chat") is None
    # Not vacuous: the machine_wake fact alone (no reading) backs nothing.
    bare = SimpleNamespace(
        kind="tool",
        name="machine_wake",
        meta={"ok": True, "facts": [f for f in sink if "machine_wake" in f]},
    )
    assert guards.wake_claim_check(reply, [bare], ["box", "hubhost"], purpose="chat") is not None


async def test_an_offline_hub_agent_is_a_reading_on_the_failed_span(pool, world):
    """T5-T6 fix (VERIFY's allow-list finding): the relay candidates' reads
    are recorded, so "hubhost is offline" beside a relay_cannot is a check —
    the state guard does not correct it as "I did not check"."""
    from app import guards

    del world.connected[str(world.hub)]
    sink: list[dict] = []
    text, ok = await _wake({"machine": "box"}, sink)
    assert not ok and "hubhost is offline" in text
    assert {"device": "hubhost", "connected": False} in sink
    assert {"device": "box", "connected": False} in sink
    failed = SimpleNamespace(kind="tool", name="machine_wake", meta={"ok": False, "facts": sink})
    names = ["box", "hubhost"]
    for reply in (
        "hubhost is offline, so no wake could be sent to box.",
        "hubhost is offline right now.",
    ):
        assert guards.state_claim_check(reply, [failed], names) is None, reply
        # Not vacuous: the machine_wake fact alone (the old record) is corrected.
        bare = SimpleNamespace(
            kind="tool",
            name="machine_wake",
            meta={"ok": False, "facts": [f for f in sink if "machine_wake" in f]},
        )
        assert guards.state_claim_check(reply, [bare], names) is not None, reply


async def test_a_relay_ok_without_a_packet_count_is_a_cannot_and_no_row(pool, world):
    """VERIFY's note: an ok answer that does not say how many packets left is
    a stated cannot — never a row claiming a send nobody counted."""
    for meta in ({"iface": "eth0"}, {"sent": 0}, {"sent": True}, None):
        world.answer = {"ok": True, "output": "sent", "meta": meta}
        text, ok = await _wake({"machine": "box"})
        assert not ok and "without saying how many packets" in text, meta
        assert await _rows(pool) == []


async def test_no_connected_hub_agent_is_relay_cannot(pool, world):
    del world.connected[str(world.hub)]
    text, ok = await _wake({"machine": "box"})
    assert not ok and text.startswith(tools.ERROR_PREFIX)
    assert "no connected agent shares box's network" in text
    assert world.sends == []
    (row,) = await _rows(pool)
    assert row["outcome"] == "relay_cannot"
    assert "no connected agent shares box's network" in row["reason"]


async def test_a_relay_that_refuses_is_relay_cannot_with_its_words(pool, world):
    world.answer = {"ok": False, "error": "cannot wake: no interface owns 192.0.2.255"}
    text, ok = await _wake({"machine": "box"})
    assert not ok
    assert "no interface owns 192.0.2.255" in text
    (row,) = await _rows(pool)
    assert row["outcome"] == "relay_cannot" and "no interface owns" in row["reason"]


async def test_a_relay_not_reached_is_relay_cannot(pool, world):
    world.answer = devices_ws.NotSent("device 'hubhost' is not connected")
    text, ok = await _wake({"machine": "box"})
    assert not ok and "not connected" in text
    (row,) = await _rows(pool)
    assert row["outcome"] == "relay_cannot"


async def test_a_relay_that_never_answered_records_nothing(pool, world):
    world.answer = devices.DeviceRefused("device 'hubhost' did not answer within 30s")
    text, ok = await _wake({"machine": "box"})
    assert not ok
    assert "not known" in text
    assert await _rows(pool) == []


async def test_an_unknown_machine_is_a_cannot_naming_the_paired_ones(pool, world):
    text, ok = await _wake({"machine": "toaster"})
    assert not ok and "box" in text and "hubhost" in text
    assert world.sends == [] and await _rows(pool) == []


async def test_the_name_resolves_loosely(pool, world):
    text, ok = await _wake({"machine": "the box", "wait_s": 30})
    assert ok, text
    assert world.sends and world.sends[0]["args"]["mac"] == WIFI_MAC


# -- adapter, deadline, one at a time ------------------------------------------


async def test_another_adapter_is_its_own_attempt_and_says_it_had_no_address(pool, world):
    text, ok = await _wake({"machine": "box", "adapter": "Ethernet", "wait_s": 30})
    assert ok, text
    _clean(text)
    assert "box's Ethernet" in text and "no address at its last report" in text
    assert world.sends[0]["args"] == {"mac": ETH_MAC, "broadcast": "192.0.2.255"}
    (row,) = await _rows(pool)
    assert row["adapter"] == "Ethernet" and str(row["mac"]) == ETH_MAC


async def test_an_adapter_not_in_its_facts_is_a_cannot_listing_them(pool, world):
    text, ok = await _wake({"machine": "box", "adapter": "nope"})
    assert not ok and "Wi-Fi" in text and "Ethernet" in text
    assert world.sends == [] and await _rows(pool) == []


@pytest.mark.parametrize(("asked", "used"), [(5, 30), (9999, 600)])
async def test_the_wait_is_clamped_and_the_clamp_is_said(pool, world, asked, used):
    text, ok = await _wake({"machine": "box", "wait_s": asked})
    assert ok, text
    assert f"waited {used} s, not {asked}" in text
    (row,) = await _rows(pool)
    assert row["deadline_s"] == used


async def test_an_attempt_in_flight_is_a_cannot_and_nothing_is_sent(pool, world):
    await wake_attempts.record_sent(
        pool,
        device_id=world.box,
        relay_device_id=world.hub,
        adapter="Wi-Fi",
        mac=WIFI_MAC,
        relay_iface="eth0",
        broadcast="192.0.2.255",
        packets=6,
        trigger="route",
        sent_at=T0 - timedelta(seconds=10),
    )
    text, ok = await _wake({"machine": "box"})
    assert not ok and "already in flight" in text and "11:59:50" in text
    assert world.sends == []


async def test_an_attempt_past_its_deadline_is_settled_first(pool, world):
    old = await wake_attempts.record_sent(
        pool,
        device_id=world.box,
        relay_device_id=world.hub,
        adapter="Wi-Fi",
        mac=WIFI_MAC,
        relay_iface="eth0",
        broadcast="192.0.2.255",
        packets=6,
        trigger="route",
        sent_at=T0 - timedelta(minutes=10),
    )
    text, ok = await _wake({"machine": "box", "wait_s": 30})
    assert ok, text
    assert (await wake_attempts.get(pool, old))["outcome"] == "no_answer"
    assert len(world.sends) == 1


# -- registration ----------------------------------------------------------------


def test_machine_wake_is_registered_acts_and_waits_on_no_one():
    tool = tools.REGISTRY["machine_wake"]
    assert tool.reads_only is False
    assert tool.parameters["required"] == ["machine"]
    assert set(tool.parameters["properties"]) == {"machine", "adapter", "wait_s"}
    assert "woke" not in tool.description.lower()


# -- S46a T6: the ledger's last attempt per machine, for machine_status ---------


async def test_latest_by_device_settles_a_past_deadline_row_and_reads_no_mac(pool, world):
    world.answer = None
    await wake_attempts.record_sent(
        pool,
        device_id=world.box,
        relay_device_id=world.hub,
        adapter="Wi-Fi",
        mac=WIFI_MAC,
        relay_iface="eth0",
        broadcast="192.0.2.255",
        packets=6,
        trigger="tool",
        sent_at=T0,
        deadline_s=120,
    )
    latest = await wake_attempts.latest_by_device(pool, now=T0 + timedelta(seconds=300))
    box = latest[world.box]
    assert box["outcome"] == "no_answer"
    assert box["sent_at"] == T0.isoformat() and box["deadline_s"] == 120
    assert box["answered_after_s"] is None and box["serving_after_s"] is None
    assert world.hub not in latest
    assert WIFI_MAC not in repr(latest) and WIFI_MAC.replace(":", "") not in repr(latest)
    # The settle was the ledger's own: the row is decided now.
    stored = await pool.fetchval("SELECT outcome FROM wake_attempts")
    assert stored == "no_answer"


async def test_the_plant_hands_each_agent_its_last_wake(pool, world, monkeypatch):
    from app import machines

    world.connected[str(world.box)] = T0 + timedelta(seconds=40)
    world.serving_from = T0 + timedelta(seconds=52)
    await _wake({"machine": "box"})
    monkeypatch.setattr(devices_ws.hub, "connected_ids", lambda: {str(world.hub)})
    agents = {a["name"]: a for a in await machines.GatewayPlant().agents(SimpleNamespace())}
    assert agents["box"]["last_wake"]["outcome"] == "ready"
    assert agents["box"]["last_wake"]["answered_after_s"] == 40
    # A machine never woken has the key, None: the ledger WAS read.
    assert "last_wake" in agents["hubhost"] and agents["hubhost"]["last_wake"] is None
