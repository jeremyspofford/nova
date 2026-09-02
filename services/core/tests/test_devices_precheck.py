"""The per-device precheck runs BEFORE the policy kernel — a call that could
never run must never raise a card or burn an approval.

The owner's live walk (2026-09-01) hit this twice: an approved device_run was
BURNED on re-attempt and THEN refused "has not been granted shell.exec" — the
approval spent on a call that could never execute — and a malformed tool call
whose device name was leaked XML had a consent card raised for it, which the
owner approved. Both because the per-device layer (paired? connected? granted?
path inside a root?) lived INSIDE the executor, i.e. AFTER policy.authorize.

Now each device tool carries a `precheck` dispatch runs after schema validation
and before the kernel. A precheck may ONLY refuse (D-012: it adds a refusal, it
never allows); when it refuses, policy.authorize is NEVER called — so no card,
no burn, no governance row, and nothing on the wire. The executor keeps its own
identical checks (defence in depth: a grant can change between the two).

Every assertion here is off the TABLES (consents, governance_events), the
FRAMES the FakeWSConn recorded, and a spy on the kernel — never the reply text.
"""
from __future__ import annotations

import dataclasses
import uuid
from pathlib import Path

import pytest

from app import consents, devices, devices_ws, governance, policy, tools
from app.identity import Person
from app.tools.base import ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn

pytestmark = requires_db

# The exact garbage the local model emitted at 23:58 on the walk — the tool-call
# XML leaked into the JSON arg. A consent card was raised for it.
LEAKED_XML_NAME = '\n<atem:parameter name="device">DELL-XPS-8950'


@pytest.fixture(autouse=True)
def _clean_hub():
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()


async def _person(pool, role: str = "adult") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", role, role
    )
    return Person(id=pid, name=role, role=role)


async def _conversation(pool, person: Person) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person.id
    )


async def _enroll(
    pool,
    *,
    name: str = "laptop",
    capabilities: list[str] | None = None,
    fs_roots: list[str] | None = None,
) -> uuid.UUID:
    device = FakeDevice()
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id)
    result = await devices.enroll(
        pool,
        code=code["code"],
        pubkey=device.pubkey_hex,
        name=name,
        platform="linux",
        hostname="host",
    )
    device_id = uuid.UUID(result["device_id"])
    if capabilities is not None or fs_roots is not None:
        await devices.set_grants(
            pool,
            device_id=device_id,
            capabilities=capabilities or [],
            fs_roots=fs_roots or [],
            actor=str(person.id),
        )
    return device_id


def _ctx(person, *, conversation_id=None, sink=None) -> ToolContext:
    return ToolContext(
        app=None,
        person=person,
        workspace_root=Path("/tmp"),
        conversation_id=conversation_id,
        consent_sink=sink,
    )


async def _consent_rows(pool) -> int:
    return await pool.fetchval("SELECT count(*) FROM consents")


async def _raised_events(pool) -> list:
    return [
        e
        for e in await governance.recent_events(pool, limit=200)
        if e["kind"] == governance.CONSENT_RAISED
    ]


class KernelSpy:
    """Records every authorize call — and refuses to decide, so a call that
    reaches the kernel when it must not is loud in two ways."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, ctx, action_class, args):
        self.calls.append((action_class, args))
        raise AssertionError(f"policy.authorize was reached for {action_class}")


# -- (a) the walk's defect: an ungranted consent-tier call raises no card ------


async def test_an_ungranted_device_run_is_refused_before_the_kernel(pool):
    device_id = await _enroll(pool, name="laptop", capabilities=["system.info"])
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)  # connected, so a leak WOULD show a frame
    person = await _person(pool)
    conv = await _conversation(pool, person)
    sink: list[dict] = []

    result, ok = await tools.dispatch(
        "device_run",
        {"device": "laptop", "argv": ["ls", "-la"]},
        _ctx(person, conversation_id=conv, sink=sink),
    )

    assert ok is False
    assert result.startswith("Error: ")
    assert "shell.exec" in result and "Settings" in result  # the stated grant refusal
    assert not result.startswith("Awaiting")
    # The kernel was never reached: no card, no consent row, no ledger row.
    assert sink == []
    assert await _consent_rows(pool) == 0
    assert await _raised_events(pool) == []
    assert await consents.pending_for_conversation(pool, conv) == []
    assert conn.sent == []  # and nothing crossed the wire


async def test_an_approved_consent_is_not_burned_on_a_call_that_cannot_run(pool):
    """The 23:48 defect exactly: an approval exists for the call, the device
    lacks the grant. The re-attempt must refuse WITHOUT spending the approval —
    the owner's decision is not wasted on a call that could never execute."""
    device_id = await _enroll(pool, name="laptop", capabilities=["system.info"])
    devices_ws.hub.register(device_id, FakeWSConn())
    person = await _person(pool)
    args = {"device": "laptop", "argv": ["ls", "-la"]}
    card = await consents.raise_consent(
        pool,
        action_class="device_run",
        args=args,
        summary="run ls",
        person_id=person.id,
        agent="chat",
        conversation_id=None,
    )
    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )

    result, ok = await tools.dispatch("device_run", args, _ctx(person))

    assert ok is False and "shell.exec" in result
    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["used_at"] is None  # NOT burned — still spendable once the grant exists
    assert not any(
        e["kind"] == governance.CONSENT_BURNED
        for e in await governance.recent_events(pool, limit=200)
    )


# -- (b) a garbage device name raises no card ---------------------------------


async def test_a_garbage_device_name_is_refused_by_name_with_no_card(pool):
    await _enroll(pool, name="DELL-XPS-8950", capabilities=["shell.exec"])
    person = await _person(pool)
    conv = await _conversation(pool, person)
    sink: list[dict] = []

    result, ok = await tools.dispatch(
        "device_run",
        {"device": LEAKED_XML_NAME, "argv": ["ls"]},
        _ctx(person, conversation_id=conv, sink=sink),
    )

    assert ok is False
    assert result.startswith("Error: no paired device named")
    assert "DELL-XPS-8950" in result  # names what it was given (repr-escaped)
    assert "atem:parameter" in result
    assert sink == []
    assert await _consent_rows(pool) == 0
    assert await _raised_events(pool) == []


async def test_a_revoked_device_is_refused_before_the_kernel(pool):
    device_id = await _enroll(pool, name="laptop", capabilities=["shell.exec"])
    await devices.revoke(pool, device_id=device_id, actor="tester")
    person = await _person(pool)
    sink: list[dict] = []

    result, ok = await tools.dispatch(
        "device_run", {"device": "laptop", "argv": ["ls"]}, _ctx(person, sink=sink)
    )

    assert ok is False and "no paired device named 'laptop'" in result
    assert sink == [] and await _consent_rows(pool) == 0


# -- connected and fs-root prechecks, before the kernel ------------------------


async def test_a_disconnected_device_is_refused_before_the_kernel(pool):
    await _enroll(pool, name="laptop", capabilities=["shell.exec"])  # paired, offline
    person = await _person(pool)
    conv = await _conversation(pool, person)
    sink: list[dict] = []

    result, ok = await tools.dispatch(
        "device_run",
        {"device": "laptop", "argv": ["ls"]},
        _ctx(person, conversation_id=conv, sink=sink),
    )

    assert ok is False
    assert "not connected" in result and "tile is stale" in result
    assert sink == []  # a card for an offline machine would be another wasted approval
    assert await _consent_rows(pool) == 0
    assert await _raised_events(pool) == []


async def test_an_empty_fs_roots_grant_is_refused_before_the_kernel(pool):
    """The 3rd walk defect: fs.list granted with fs_roots=[] is a dead grant.
    The stated refusal names it, and for a consent-tier fs write it never
    reaches the kernel either."""
    device_id = await _enroll(pool, name="laptop", capabilities=["fs.list", "fs.write"])
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)
    person = await _person(pool)
    sink: list[dict] = []

    result, ok = await tools.dispatch(
        "device_list_files", {"device": "laptop", "path": "/home/x"}, _ctx(person)
    )
    assert ok is False and "no filesystem roots granted" in result

    result, ok = await tools.dispatch(
        "device_write_file",
        {"device": "laptop", "path": "/home/x/a.txt", "content": "hi"},
        _ctx(person, sink=sink),
    )
    assert ok is False and "no filesystem roots granted" in result
    assert sink == [] and await _consent_rows(pool) == 0
    assert conn.sent == []


async def test_a_path_outside_the_roots_is_refused_before_the_kernel(pool):
    device_id = await _enroll(
        pool, name="laptop", capabilities=["fs.write"], fs_roots=["/home/jeremy"]
    )
    devices_ws.hub.register(device_id, FakeWSConn())
    person = await _person(pool)
    sink: list[dict] = []

    result, ok = await tools.dispatch(
        "device_write_file",
        {"device": "laptop", "path": "/etc/passwd", "content": "x"},
        _ctx(person, sink=sink),
    )

    assert ok is False and "outside the roots" in result
    assert sink == [] and await _consent_rows(pool) == 0


# -- (c) the kernel is not called when the precheck refuses -------------------


async def test_policy_authorize_is_not_called_when_the_precheck_refuses(pool, monkeypatch):
    device_id = await _enroll(pool, name="laptop", capabilities=["system.info"])
    devices_ws.hub.register(device_id, FakeWSConn())
    person = await _person(pool)
    spy = KernelSpy()
    monkeypatch.setattr(policy, "authorize", spy)

    result, ok = await tools.dispatch(
        "device_run", {"device": "laptop", "argv": ["ls"]}, _ctx(person)
    )

    assert ok is False and "shell.exec" in result
    assert spy.calls == []  # never reached

    # And the kernel IS reached once the precheck passes — the precheck only
    # ever refuses; it does not decide.
    await devices.set_grants(
        pool,
        device_id=device_id,
        capabilities=["system.info", "shell.exec"],
        fs_roots=[],
        actor="tester",
    )
    result, ok = await tools.dispatch(
        "device_run", {"device": "laptop", "argv": ["ls"]}, _ctx(person)
    )
    assert ok is False and "policy.authorize was reached" in result  # the spy's own words
    assert spy.calls == [("device_run", {"device": "laptop", "argv": ["ls"]})]


# -- a precheck may only refuse; it never allows and never throws ------------


async def test_a_precheck_that_crashes_is_a_fail_closed_refusal(pool, monkeypatch):
    async def boom(args, ctx):
        raise RuntimeError("registry down")

    tool = tools.REGISTRY["get_time"]
    monkeypatch.setitem(tools.REGISTRY, "get_time", dataclasses.replace(tool, precheck=boom))
    spy = KernelSpy()
    monkeypatch.setattr(policy, "authorize", spy)
    person = await _person(pool)

    result, ok = await tools.dispatch("get_time", {}, _ctx(person))

    assert ok is False
    assert result.startswith("Error: ")
    assert "unexpectedly" in result and "registry down" in result
    assert spy.calls == []  # a crashed precheck is a refusal, never a pass-through


async def test_a_precheck_that_passes_changes_nothing(pool, monkeypatch):
    seen: list[dict] = []

    async def fine(args, ctx):
        seen.append(args)

    tool = tools.REGISTRY["get_time"]
    monkeypatch.setitem(tools.REGISTRY, "get_time", dataclasses.replace(tool, precheck=fine))
    person = await _person(pool)

    result, ok = await tools.dispatch("get_time", {}, _ctx(person))

    assert ok is True and "UTC" in result
    assert seen == [{}]


def test_every_device_tool_but_device_list_carries_a_precheck():
    """Derived from the registry: a device tool added without a precheck would
    put its per-device layer back behind the kernel. device_list reads core's
    own table and names no device, so it has nothing to precheck."""
    for tool in tools.REGISTRY.values():
        if not tool.name.startswith("device_"):
            continue
        if tool.name == "device_list":
            assert tool.precheck is None
        else:
            assert tool.precheck is not None, f"{tool.name} has no precheck"


# -- defence in depth: the executor still refuses on its own ------------------


async def test_the_executor_keeps_its_own_checks_without_the_precheck(pool, monkeypatch):
    """A grant can change between precheck and execution, so the executor's own
    resolve/grant/path checks stay. Proven by stripping the precheck: the
    ungranted call still refuses at the executor with nothing on the wire."""
    device_id = await _enroll(pool, name="laptop", capabilities=["system.info"])
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)
    person = await _person(pool)
    tool = tools.REGISTRY["device_read_file"]
    assert tool.precheck is not None
    monkeypatch.setitem(
        tools.REGISTRY, "device_read_file", dataclasses.replace(tool, precheck=None)
    )

    result, ok = await tools.dispatch(
        "device_read_file", {"device": "laptop", "path": "/home/x"}, _ctx(person)
    )

    assert ok is False and "fs.read" in result and "Settings" in result
    assert conn.sent == []


async def test_the_executor_alone_still_refuses_an_unknown_device(pool):
    with pytest.raises(ToolFailure):
        await tools.REGISTRY["device_info"].executor({"device": "nobody"}, _ctx(None))
