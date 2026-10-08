"""stack-claim epic T3: a device call records the names its device is known by.

_require_connected is the ONE place core determines a device's connectivity,
and it records that fact on the turn's facts_sink. The stack-claim guard is
pure over spans, so the names a reply may call that device by ride the same
fact as `known_as`: the paired name, the row's hostname, and every remote
model provider whose URL model_machines.device_of maps to that device. A
remote that maps to another device adds nothing; a providers read that fails
drops the provider names only, and the call still runs.

The names (and the providers read they cost) are recorded only inside a turn
whose kind arms the stack-claim guard (devices.TURN_PURPOSE, set by
chat._run_turn, in guards.STACK_CLAIM_KINDS). The tests that exercise
known_as dispatch under `_armed()`; the last pins hold the other side: unset
or an unarmed kind makes no providers read, and a turn resets what it set."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime

import pytest

from app import conversations, device_facts, devices_ws, guards, machines, network, tools, traces
from app.tools import devices as device_tools
from tests.conftest import requires_db
from tests.device_fakes import FakeWSConn
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import MODEL, _nova_turn, _owner
from tests.test_chat_presented_listing import tool_call
from tests.test_chat_tools import text
from tests.test_devices_ws import _ctx, _enroll, _person

pytestmark = requires_db

AT = datetime(2026, 10, 7, 19, 58, tzinfo=UTC)
DELL_IP = "100.122.40.93"
LAPTOP_IP = "100.64.0.7"


def _facts(hostname: str, ip: str) -> dict:
    return {
        "v": 2,
        "agent": {"version": "0.2.0", "mode": "foreground", "session_interactive": True},
        "os": {"goos": "windows", "arch": "amd64", "version": "Windows 11", "wsl": None},
        "hostname": hostname,
        "machine_uid": "a" * 64,
        "net": {
            "ifaces": [{"name": "Tailscale", "mac": "", "ipv4_cidr": [f"{ip}/32"], "up": True}]
        },
    }


def _agent(name: str, hostname: str, ip: str) -> dict:
    return device_facts.agent_view(
        name=name,
        platform="windows",
        hostname=hostname,
        connected=True,
        last_seen=AT,
        facts=_facts(hostname, ip),
        facts_at=AT,
    )


def _provider(name: str, base_url: str, *, builtin: bool = False) -> dict:
    return {
        "name": name,
        "adapter": "ollama" if builtin else "openai-chat",
        "base_url": base_url,
        "builtin": builtin,
        "listing": "unknown",
        "listing_note": None,
    }


PROVIDERS = [
    _provider("hub", "http://ollama:11434", builtin=True),
    _provider("dell", f"http://{DELL_IP}:11435/v1"),
    _provider("laptop-ollama", f"http://{LAPTOP_IP}:11434/v1"),
    _provider("dell-kev", f"http://{DELL_IP}:8009/v1"),
    _provider("openrouter", "https://openrouter.ai/api/v1"),
]


class _Plant(machines.GatewayPlant):
    """The real paired_device (the DB row), with the agents and the gateway's
    providers answered from lists — or the providers read raising."""

    def __init__(self, agents, providers=None, providers_error=None, agents_error=None) -> None:
        self._agents = agents
        self._providers = PROVIDERS if providers is None else providers
        self._providers_error = providers_error
        self._agents_error = agents_error
        self.provider_reads = 0

    async def agents(self, app):
        if self._agents_error is not None:
            raise self._agents_error
        return [dict(a) for a in self._agents]

    async def model_providers(self, app):
        self.provider_reads += 1
        if self._providers_error is not None:
            raise self._providers_error
        return [dict(p) for p in self._providers], []


@pytest.fixture
def plant(monkeypatch, tmp_path):
    # No tailnet peer file: matching rides the agents' own addresses alone.
    monkeypatch.setenv(network.STATUS_FILE_ENV, str(tmp_path / "tailscale.json"))

    def install(**kw):
        installed = _Plant(**kw)
        monkeypatch.setattr(machines, "plant", lambda: installed)
        return installed

    return install


@contextlib.contextmanager
def _armed(purpose: str = "chat"):
    """Stand in for chat._run_turn: state the turn's kind for the block, reset
    after. Set and reset in the test's own context (a fixture cannot reset a
    token set inside an async test — different Context)."""
    assert purpose in guards.STACK_CLAIM_KINDS
    token = device_tools.TURN_PURPOSE.set(purpose)
    try:
        yield
    finally:
        device_tools.TURN_PURPOSE.reset(token)


async def _dell(pool, *, hostname="DELL-XPS-8950"):
    device_id, _device = await _enroll(pool, name="DELL-XPS-8950", platform="windows")
    await pool.execute("UPDATE devices SET hostname = $1 WHERE id = $2", hostname, device_id)
    return device_id


AGENTS = [
    _agent("DELL-XPS-8950", "DELL-XPS-8950", DELL_IP),
    _agent("laptop", "LAPTOP-1", LAPTOP_IP),
]


async def test_an_offline_device_call_records_its_known_as(pool, plant):
    await _dell(pool)
    plant(agents=AGENTS)
    person = await _person(pool)
    facts: list[dict] = []

    with _armed():
        result, ok = await tools.dispatch(
            "device_run",
            {"device": "DELL-XPS-8950", "argv": ["where", "ollama"]},
            _ctx(person, facts=facts),
        )

    assert ok is False and "not connected" in result
    assert facts == [
        {
            "device": "DELL-XPS-8950",
            "connected": False,
            "known_as": ["DELL-XPS-8950", "DELL-XPS-8950", "dell", "dell-kev"],
        }
    ]


async def test_known_as_carries_the_rows_hostname_not_only_the_paired_name(pool, plant):
    await _dell(pool, hostname="XPS-HOST")
    plant(agents=[_agent("DELL-XPS-8950", "XPS-HOST", DELL_IP)])
    person = await _person(pool)
    facts: list[dict] = []

    with _armed():
        await tools.dispatch(
            "device_list_apps", {"device": "DELL-XPS-8950"}, _ctx(person, facts=facts)
        )

    (fact,) = facts
    assert "known_as" in fact, fact
    assert fact["known_as"][:2] == ["DELL-XPS-8950", "XPS-HOST"]
    assert "dell" in fact["known_as"]


async def test_a_remote_that_maps_to_another_device_adds_nothing(pool, plant):
    await _dell(pool)
    plant(agents=AGENTS)
    person = await _person(pool)
    facts: list[dict] = []

    with _armed():
        await tools.dispatch(
            "device_list_apps", {"device": "DELL-XPS-8950"}, _ctx(person, facts=facts)
        )

    (fact,) = facts
    assert "known_as" in fact, fact
    assert "laptop-ollama" not in fact["known_as"]
    assert "hub" not in fact["known_as"]
    assert "openrouter" not in fact["known_as"]


async def test_a_failed_providers_read_drops_provider_names_and_the_call_still_runs(pool, plant):
    device_id = await _dell(pool)
    plant(
        agents=AGENTS,
        providers_error=machines.PlantUnavailable("the gateway refused /admin/providers — 503"),
    )
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)
    person = await _person(pool)
    facts: list[dict] = []

    with _armed():  # create_task copies the context, so the task is armed
        task = asyncio.create_task(
            tools.dispatch(
                "device_list_apps", {"device": "DELL-XPS-8950"}, _ctx(person, facts=facts)
            )
        )
    frame = await asyncio.wait_for(conn.next_sent(), 2)
    assert frame["type"] == "command" and frame["envelope"]["capability"] == "apps.list"
    envelope_id = frame["envelope"]["envelope_id"]
    devices_ws.hub.resolve(
        device_id,
        envelope_id,
        {
            "type": "result",
            "envelope_id": envelope_id,
            "ok": True,
            "output": "Brave",
            "exit_code": 0,
            "error": None,
        },
    )
    result, ok = await asyncio.wait_for(task, 2)

    assert ok is True and "Brave" in result
    assert facts == [
        {
            "device": "DELL-XPS-8950",
            "connected": True,
            "known_as": ["DELL-XPS-8950", "DELL-XPS-8950"],
        }
    ]


async def test_a_blank_hostname_is_not_a_name(pool, plant):
    # T3 COVERAGE: a whitespace-only hostname adds no alias.
    await _dell(pool, hostname="   ")
    plant(agents=AGENTS, providers=[])
    person = await _person(pool)
    facts: list[dict] = []

    with _armed():
        await tools.dispatch(
            "device_list_apps", {"device": "DELL-XPS-8950"}, _ctx(person, facts=facts)
        )

    (fact,) = facts
    assert fact["known_as"] == ["DELL-XPS-8950"]


async def test_a_failed_agents_read_drops_provider_names_and_says_so(pool, plant, caplog):
    # T3 COVERAGE: without the agents no provider maps to a device; the names
    # drop (never a guess) and the log says why, never a silent OK.
    await _dell(pool)
    plant(agents=AGENTS, agents_error=machines.PlantUnavailable("agents listing refused"))
    person = await _person(pool)
    facts: list[dict] = []

    with _armed(), caplog.at_level("INFO", logger="app.tools.devices"):
        result, ok = await tools.dispatch(
            "device_run",
            {"device": "DELL-XPS-8950", "argv": ["where", "ollama"]},
            _ctx(person, facts=facts),
        )

    assert ok is False and "not connected" in result
    assert facts == [
        {
            "device": "DELL-XPS-8950",
            "connected": False,
            "known_as": ["DELL-XPS-8950", "DELL-XPS-8950"],
        }
    ]
    assert any("agents not read, provider names dropped" in r.getMessage() for r in caplog.records)


async def test_a_failed_providers_read_is_said_in_the_log(pool, plant, caplog):
    # T3 COVERAGE: the providers read failing is stated, not swallowed.
    await _dell(pool)
    plant(agents=AGENTS, providers_error=machines.PlantUnavailable("gateway 503"))
    person = await _person(pool)
    facts: list[dict] = []

    with _armed(), caplog.at_level("INFO", logger="app.tools.devices"):
        await tools.dispatch(
            "device_run",
            {"device": "DELL-XPS-8950", "argv": ["where", "ollama"]},
            _ctx(person, facts=facts),
        )

    assert any(
        "remote provider names not read" in r.getMessage() and "gateway 503" in r.getMessage()
        for r in caplog.records
    )


async def _offline_call(pool, plant) -> tuple[_Plant, list[dict]]:
    await _dell(pool)
    installed = plant(agents=AGENTS)
    person = await _person(pool)
    facts: list[dict] = []
    result, ok = await tools.dispatch(
        "device_run",
        {"device": "DELL-XPS-8950", "argv": ["where", "ollama"]},
        _ctx(person, facts=facts),
    )
    assert ok is False and "not connected" in result
    return installed, facts


async def test_a_device_call_outside_a_turn_makes_no_providers_read(pool, plant):
    # T3 COVERAGE (a): TURN_PURPOSE unset is no turn's call (a beat push, a
    # direct dispatch) — nothing reads the names, so no /admin/providers read.
    assert device_tools.TURN_PURPOSE.get() is None
    installed, facts = await _offline_call(pool, plant)

    assert installed.provider_reads == 0
    assert facts == [{"device": "DELL-XPS-8950", "connected": False}]


async def test_a_device_call_in_an_unarmed_kind_makes_no_providers_read(pool, plant):
    # T3 COVERAGE (c): a beat is a stated kind the stack-claim guard never
    # runs in, so its device call costs no providers read and records no names.
    assert "beat" not in guards.STACK_CLAIM_KINDS
    token = device_tools.TURN_PURPOSE.set("beat")
    try:
        installed, facts = await _offline_call(pool, plant)
    finally:
        device_tools.TURN_PURPOSE.reset(token)

    assert installed.provider_reads == 0
    assert facts == [{"device": "DELL-XPS-8950", "connected": False}]


async def test_a_chat_turn_states_its_kind_and_resets_it_after(pool, plant, mount_peers):
    # T3 COVERAGE (b): chat._run_turn sets TURN_PURPOSE for the turn (its
    # device call reads the providers and records known_as) and resets it in
    # its finally — awaited directly, as the scheduler and the eval runner do,
    # so a leak would arm the next thing run in this same context.
    await _dell(pool)
    installed = plant(agents=AGENTS)
    owner = await _owner(pool)
    gateway = ScriptedGateway(
        rounds=(
            (
                tool_call(
                    "d1", "device_run", {"device": "DELL-XPS-8950", "argv": ["where", "ollama"]}
                ),
            ),
            (text("The Dell is not connected."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    assert device_tools.TURN_PURPOSE.get() is None

    turn, _frames = await _nova_turn(pool, owner, "is the dell up?")

    meta = await pool.fetchval(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND name = 'device_run'", turn.id
    )
    assert meta["facts"] == [
        {
            "device": "DELL-XPS-8950",
            "connected": False,
            "known_as": ["DELL-XPS-8950", "DELL-XPS-8950", "dell", "dell-kev"],
        }
    ]
    assert installed.provider_reads == 1
    assert device_tools.TURN_PURPOSE.get() is None  # reset: no leak to what runs next


@pytest.mark.parametrize(
    ("kind", "armed"),
    [("scheduled", False), ("eval", True)],
)
async def test_a_turn_states_its_own_kind_not_chats(pool, plant, mount_peers, kind, armed):
    # T3 COVERAGE (T3 VERIFY gap): the purpose chat._run_turn states is the
    # TURN's kind (traces.purpose_of), not "chat". A scheduled firing (a real
    # unarmed kind run through the funnel) records no known_as and makes no
    # providers read; an eval turn (armed) does both.
    await _dell(pool)
    installed = plant(agents=AGENTS)
    owner = await _owner(pool)
    gateway = ScriptedGateway(
        rounds=(
            (
                tool_call(
                    "d1", "device_run", {"device": "DELL-XPS-8950", "argv": ["where", "ollama"]}
                ),
            ),
            (text("The Dell is not connected."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    conversation = await conversations.active_conversation(pool, owner)
    opened = await traces.open_turn(
        pool, kind=kind, conversation_id=conversation["id"], model=MODEL, person_id=owner.id
    )
    assert (kind in guards.STACK_CLAIM_KINDS) is armed

    turn, _frames = await _nova_turn(pool, owner, "is the dell up?", turn=opened)

    meta = await pool.fetchval(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND name = 'device_run'", turn.id
    )
    if armed:
        assert meta["facts"] == [
            {
                "device": "DELL-XPS-8950",
                "connected": False,
                "known_as": ["DELL-XPS-8950", "DELL-XPS-8950", "dell", "dell-kev"],
            }
        ]
        assert installed.provider_reads == 1
    else:
        assert meta["facts"] == [{"device": "DELL-XPS-8950", "connected": False}]
        assert installed.provider_reads == 0
    assert device_tools.TURN_PURPOSE.get() is None
