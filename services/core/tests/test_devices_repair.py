"""Re-pair (S42b decision 4): a code minted from a machine's tile — or by her,
for a machine she names — binds to that one row. Whoever enrolls with it
within ten minutes becomes that machine under a new key: its name and history
stay, its audit chain restarts under a new epoch, and the old key's socket is
dropped."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

import pytest

from app import devices, devices_ws, governance
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice
from tests.test_devices_ws import AUTH_FACTS, _auth_with, _chain, _close, _enroll, _person, _until

pytestmark = requires_db


@pytest.fixture(autouse=True)
def _clean_hub():
    # The hub is process-global (test_devices_ws.py resets it the same way):
    # one test's sockets must never leak into the next.
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    devices_ws.hub._epochs.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    devices_ws.hub._epochs.clear()


async def _repair(
    pool, device_id: uuid.UUID, new: FakeDevice, *, platform: str = "windows"
) -> dict:
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    return await devices.enroll(
        pool,
        code=code["code"],
        pubkey=new.pubkey_hex,
        name="ignored",
        platform=platform,
        hostname="NEW-HOST",
    )


async def _audit_rows(pool, device_id: uuid.UUID, epoch: int) -> int:
    return await pool.fetchval(
        "SELECT count(*) FROM device_audit WHERE device_id = $1 AND epoch = $2", device_id, epoch
    )


async def _breaks(pool, device_id: uuid.UUID) -> list:
    return await pool.fetch(
        "SELECT meta FROM governance_events WHERE kind = $1 AND subject_ref = $2",
        governance.DEVICE_AUDIT_BREAK,
        device_id,
    )


# -- the brief's pins ----------------------------------------------------------


async def test_a_repair_code_rebinds_the_row_keeping_its_name_and_history(pool):
    device_id, old = await _enroll(pool, name="OFFICE-PC", platform="windows")
    await devices_ws.ingest_audit(pool, device_id, _chain({}, {}))
    new = FakeDevice()
    result = await _repair(pool, device_id, new)
    assert result == {
        "device_id": str(device_id),
        "name": "OFFICE-PC",
        "core_pubkey": await devices.core_public_key_hex(pool),
        "repaired": True,
    }
    row = await devices.get(pool, device_id)
    assert row["pubkey"] == new.pubkey_hex and row["hostname"] == "NEW-HOST"
    assert row["audit_epoch"] == 1 and row["facts"] is None and row["revoked_at"] is None
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM device_audit WHERE device_id = $1 AND epoch = 0", device_id
        )
        == 2
    )
    event = await pool.fetchrow(
        "SELECT meta FROM governance_events WHERE kind = $1 AND subject_ref = $2",
        governance.DEVICE_REPAIRED,
        device_id,
    )
    assert event["meta"]["old_pubkey"] == old.pubkey_hex
    assert event["meta"]["new_pubkey"] == new.pubkey_hex
    assert event["meta"]["epoch"] == 1


async def test_a_repaired_device_starts_a_new_audit_chain_without_a_break(pool):
    device_id, _old = await _enroll(pool, name="pc")
    await devices_ws.ingest_audit(pool, device_id, _chain({}, {}, {}))
    new = FakeDevice()
    await _repair(pool, device_id, new, platform="linux")
    got = await devices_ws.ingest_audit(pool, device_id, _chain({}), epoch=1)
    assert got == {"stored": 1, "break": None}
    breaks = await pool.fetchval(
        "SELECT count(*) FROM governance_events WHERE kind = $1 AND subject_ref = $2",
        governance.DEVICE_AUDIT_BREAK,
        device_id,
    )
    assert breaks == 0


async def test_a_repair_code_for_a_revoked_device_is_refused_at_mint(pool):
    device_id, _old = await _enroll(pool, name="pc")
    person = await _person(pool)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    with pytest.raises(devices.DeviceRefused) as caught:
        await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    assert caught.value.status_code == 409 and "re-paired" in caught.value.reason


async def test_a_device_revoked_after_its_code_was_minted_is_not_repaired_and_the_code_is_not_spent(
    pool,
):
    device_id, _old = await _enroll(pool, name="pc")
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    with pytest.raises(devices.DeviceRefused) as caught:
        await devices.enroll(
            pool,
            code=code["code"],
            pubkey=FakeDevice().pubkey_hex,
            name="x",
            platform="linux",
            hostname="h",
        )
    assert caught.value.status_code == 409
    assert (
        await pool.fetchval(
            "SELECT used_at FROM pairing_codes WHERE code_hash = $1",
            devices.hash_code(code["code"]),
        )
        is None
    )


async def test_a_code_that_names_the_machine_names_it(pool):
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, name="work-laptop")
    result = await devices.enroll(
        pool,
        code=code["code"],
        pubkey=FakeDevice().pubkey_hex,
        name="thinkpad",
        platform="linux",
        hostname="thinkpad",
    )
    assert result["name"] == "work-laptop" and result["repaired"] is False


@pytest.mark.parametrize("name", ["hub", "HUB", " Hub "])
async def test_hub_is_never_a_device_name(pool, name):
    person = await _person(pool)
    with pytest.raises(devices.DeviceRefused) as caught:
        await devices.mint_pairing_code(pool, created_by=person.id, name=name)
    assert "bundled engine" in caught.value.reason
    code = await devices.mint_pairing_code(pool, created_by=person.id)
    with pytest.raises(devices.DeviceRefused):
        await devices.enroll(
            pool,
            code=code["code"],
            pubkey=FakeDevice().pubkey_hex,
            name=name,
            platform="linux",
            hostname="h",
        )
    device_id, _ = await _enroll(pool, name="pc")
    with pytest.raises(devices.DeviceRefused):
        await devices.rename(pool, device_id=device_id, name=name)


async def test_the_repair_route_mints_a_code_bound_to_the_device(owner_client, pool):
    device_id, _old = await _enroll(pool, name="pc")
    resp = await owner_client.post(f"/api/v1/devices/{device_id}/repair-code")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["device"]["id"] == str(device_id) and len(body["code"]) == 8
    bound = await pool.fetchval(
        "SELECT device_id FROM pairing_codes WHERE code_hash = $1", devices.hash_code(body["code"])
    )
    assert bound == device_id


async def test_enrolling_with_a_repair_code_drops_the_old_keys_socket(client, pool, monkeypatch):
    device_id, _old = await _enroll(pool, name="pc")
    dropped: list = []

    async def _disconnect(did, reason):
        dropped.append((str(did), reason))
        return True

    monkeypatch.setattr(devices_ws.hub, "disconnect", _disconnect)
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    resp = await client.post(
        "/api/v1/devices/enroll",
        json={
            "code": code["code"],
            "pubkey": FakeDevice().pubkey_hex,
            "name": "pc",
            "platform": "linux",
            "hostname": "h",
        },
    )
    assert resp.status_code == 200, resp.text
    assert dropped == [(str(device_id), "re-paired")]


# -- what a re-pair code can bind, and what it cannot ---------------------------


async def test_a_repair_code_rebinds_only_its_own_row_whatever_name_the_agent_sends(pool):
    """The row is chosen when the code is minted, by an authenticated person.
    The enrolling caller has no identity and no say: the name it sends — even
    another live machine's — selects nothing."""
    target_id, _ = await _enroll(pool, name="pc")
    other_id, other = await _enroll(pool, name="laptop")
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, device_id=target_id)
    new = FakeDevice()
    result = await devices.enroll(
        pool,
        code=code["code"],
        pubkey=new.pubkey_hex,
        name="laptop",
        platform="linux",
        hostname="h",
    )
    assert (result["device_id"], result["name"], result["repaired"]) == (str(target_id), "pc", True)
    assert (await devices.get(pool, target_id))["pubkey"] == new.pubkey_hex
    untouched = await devices.get(pool, other_id)
    assert untouched["pubkey"] == other.pubkey_hex and untouched["audit_epoch"] == 0
    events = await pool.fetch(
        "SELECT subject_ref FROM governance_events WHERE kind = $1", governance.DEVICE_REPAIRED
    )
    assert [e["subject_ref"] for e in events] == [target_id]


async def test_a_repair_keeps_the_rows_owner_and_the_ledger_names_who_minted_it(pool):
    """A re-pair never moves a machine to another person: owner_person stays
    the person whose code first paired it. Who minted THIS code — a person, or
    nobody for ./install's hub agent before anyone registered — is what the
    ledger records as the re-pair's actor."""
    device_id, _ = await _enroll(pool, name="pc")
    owner = (await devices.get(pool, device_id))["owner_person"]
    someone_else = await _person(pool)
    minted = await devices.mint_pairing_code(pool, created_by=someone_else.id, device_id=device_id)
    await devices.enroll(
        pool,
        code=minted["code"],
        pubkey=FakeDevice().pubkey_hex,
        name="pc",
        platform="linux",
        hostname="h",
    )
    by_installer = await devices.mint_pairing_code(pool, created_by=None, device_id=device_id)
    await devices.enroll(
        pool,
        code=by_installer["code"],
        pubkey=FakeDevice().pubkey_hex,
        name="pc",
        platform="linux",
        hostname="h",
    )
    row = await devices.get(pool, device_id)
    assert row["owner_person"] == owner and owner != someone_else.id
    assert row["audit_epoch"] == 2
    actors = await pool.fetch(
        "SELECT actor, meta FROM governance_events WHERE kind = $1 AND subject_ref = $2 "
        "ORDER BY created_at, (meta->>'epoch')::int",
        governance.DEVICE_REPAIRED,
        device_id,
    )
    assert [(e["actor"], e["meta"]["epoch"]) for e in actors] == [
        (str(someone_else.id), 1),
        (None, 2),
    ]


async def test_a_row_already_called_hub_cannot_be_repaired_until_it_is_renamed(pool):
    """A row named before `hub` was reserved (D8) keeps that name through a
    re-pair — so the re-pair is refused, with the way out, until it is renamed."""
    device_id, _ = await _enroll(pool, name="pc")
    await pool.execute("UPDATE devices SET name = ' Hub ' WHERE id = $1", device_id)
    person = await _person(pool)
    with pytest.raises(devices.DeviceRefused) as caught:
        await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    assert caught.value.status_code == 409
    assert "cannot" in caught.value.reason and "bundled engine" in caught.value.reason
    assert "rename" in caught.value.reason
    bound = "SELECT count(*) FROM pairing_codes WHERE device_id = $1"
    assert await pool.fetchval(bound, device_id) == 0
    await devices.rename(pool, device_id=device_id, name="minipc")
    assert (await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id))[
        "code"
    ]


@pytest.mark.parametrize("agent_name", ["hub", "   "])
async def test_the_agents_own_name_never_refuses_a_code_that_decides_the_name(pool, agent_name):
    """P14: a code's name is used over the agent's, and a re-pair keeps the
    row's. The card's command carries no --name, so the agent sends its
    hostname — which is checked only when it is the name the row takes."""
    person = await _person(pool)
    named = await devices.mint_pairing_code(pool, created_by=person.id, name="minipc")
    first = await devices.enroll(
        pool,
        code=named["code"],
        pubkey=FakeDevice().pubkey_hex,
        name=agent_name,
        platform="linux",
        hostname="hub",
    )
    assert (first["name"], first["repaired"]) == ("minipc", False)
    repair = await devices.mint_pairing_code(
        pool, created_by=person.id, device_id=uuid.UUID(first["device_id"])
    )
    again = await devices.enroll(
        pool,
        code=repair["code"],
        pubkey=FakeDevice().pubkey_hex,
        name=agent_name,
        platform="linux",
        hostname="hub",
    )
    assert (again["device_id"], again["name"], again["repaired"]) == (
        first["device_id"],
        "minipc",
        True,
    )


async def test_a_name_the_code_carries_that_is_taken_is_refused_with_its_way_out(pool):
    """The agent cannot pick another name when the code chose it, so the
    refusal says what can actually be done — and the code is not spent."""
    await _enroll(pool, name="minipc")
    person = await _person(pool)
    named = await devices.mint_pairing_code(pool, created_by=person.id, name="minipc")
    with pytest.raises(devices.DeviceRefused) as caught:
        await devices.enroll(
            pool,
            code=named["code"],
            pubkey=FakeDevice().pubkey_hex,
            name="thinkpad",
            platform="linux",
            hostname="h",
        )
    assert caught.value.status_code == 409
    assert "'minipc' is already enrolled" in caught.value.reason
    assert "pick another name" not in caught.value.reason
    assert "this code names the machine" in caught.value.reason
    assert (
        await pool.fetchval(
            "SELECT used_at FROM pairing_codes WHERE code_hash = $1",
            devices.hash_code(named["code"]),
        )
        is None
    )


async def test_the_repaired_event_carries_the_keys_and_never_the_code(client, pool, caplog):
    """The code exists in the clear in one response and nowhere else: not in
    the ledger, not in a log line, not in a refusal."""
    device_id, old = await _enroll(pool, name="pc")
    person = await _person(pool)
    caplog.set_level(logging.DEBUG)
    minted = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    new = FakeDevice()
    resp = await client.post(
        "/api/v1/devices/enroll",
        json={
            "code": minted["code"],
            "pubkey": new.pubkey_hex,
            "name": "pc",
            "platform": "linux",
            "hostname": "h",
        },
    )
    assert resp.status_code == 200, resp.text
    spent = await client.post(
        "/api/v1/devices/enroll",
        json={
            "code": minted["code"],
            "pubkey": FakeDevice().pubkey_hex,
            "name": "pc",
            "platform": "linux",
            "hostname": "h",
        },
    )
    assert spent.status_code == 403
    (event,) = await pool.fetch(
        "SELECT meta FROM governance_events WHERE kind = $1", governance.DEVICE_REPAIRED
    )
    assert event["meta"] == {
        "name": "pc",
        "old_pubkey": old.pubkey_hex,
        "new_pubkey": new.pubkey_hex,
        "epoch": 1,
        "platform": "linux",
        "hostname": "h",
    }
    ledger = json.dumps(
        [dict(r) for r in await pool.fetch("SELECT * FROM governance_events")], default=str
    )
    for leak in (minted["code"], devices.hash_code(minted["code"])):
        assert leak not in ledger
        assert leak not in caplog.text
        assert leak not in spent.text


async def test_the_repair_route_states_why_it_cannot(owner_client, pool):
    device_id, _ = await _enroll(pool, name="pc")
    unknown = await owner_client.post(f"/api/v1/devices/{uuid.uuid4()}/repair-code")
    assert unknown.status_code == 404
    person = await _person(pool)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    revoked = await owner_client.post(f"/api/v1/devices/{device_id}/repair-code")
    assert revoked.status_code == 409 and "cannot be re-paired" in revoked.json()["error"]
    assert (
        await pool.fetchval("SELECT count(*) FROM pairing_codes WHERE device_id IS NOT NULL") == 0
    )


# -- the old key's socket ------------------------------------------------------


async def test_after_a_repair_the_old_key_is_dropped_and_the_new_key_starts_its_own_chain(
    client, pool
):
    """Through the real route and the real hub: the old key's live socket is
    closed at the enroll, its reconnect fails the challenge (with no revoked
    proof, so the old agent never wipes itself), and the new key's chain is
    the new epoch's — last_seq counts that chain alone."""
    device_id, old = await _enroll(pool, name="pc")
    old_conn, old_task, ready = await _auth_with(pool, device_id, old, None)
    assert ready == {"type": "ready", "last_seq": None}
    old_conn.feed({"type": "audit", "entries": _chain({}, {}, {})})

    async def old_chain_stored():
        return await _audit_rows(pool, device_id, 0) == 3

    await _until(old_chain_stored)

    person = await _person(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    new = FakeDevice()
    resp = await client.post(
        "/api/v1/devices/enroll",
        json={
            "code": minted["code"],
            "pubkey": new.pubkey_hex,
            "name": "pc",
            "platform": "linux",
            "hostname": "h",
        },
    )
    assert resp.status_code == 200 and resp.json()["repaired"] is True
    await asyncio.wait_for(old_task, 2)
    assert old_conn.closed_code == devices_ws.REVOKED_CLOSE
    assert not devices_ws.hub.is_connected(device_id)

    again_conn, again_task, refused = await _auth_with(pool, device_id, old, None)
    assert refused == {"type": "auth_error", "reason": "the challenge signature did not verify"}
    await asyncio.wait_for(again_task, 2)
    assert not devices_ws.hub.is_connected(device_id)

    new_conn, new_task, new_ready = await _auth_with(pool, device_id, new, None)
    assert new_ready == {"type": "ready", "last_seq": None}
    assert devices_ws.hub.is_connected(device_id)
    # Not the old chain's entries: a lookup that crossed epochs would break at seq 1.
    new_conn.feed({"type": "audit", "entries": _chain({"summary": "new"}, {"summary": "new"})})

    async def new_chain_stored():
        return await _audit_rows(pool, device_id, 1) == 2

    await _until(new_chain_stored)
    await _close(new_conn, new_task)
    third_conn, third_task, third_ready = await _auth_with(pool, device_id, new, None)
    assert third_ready == {"type": "ready", "last_seq": 1}
    await _close(third_conn, third_task)
    assert await _audit_rows(pool, device_id, 0) == 3
    assert await _breaks(pool, device_id) == []


# What the rebound row says once the NEW key has reported — the old socket must
# not overwrite it, nor clear it.
NEW_AGENT_FACTS = {**AUTH_FACTS, "hostname": "NEW-HOST"}


@pytest.mark.parametrize("same_key", [False, True], ids=["new-key", "same-key"])
@pytest.mark.parametrize("old_facts", [AUTH_FACTS, None], ids=["with-facts", "no-facts"])
async def test_a_socket_that_authenticated_as_the_repair_landed_is_dropped_once_it_joins(
    pool, monkeypatch, same_key, old_facts
):
    """The window: authenticate read the row and verified the OLD key; the
    re-pair committed and its drop found no socket in the hub yet; then the
    socket joined. serve re-reads the row after joining, so the old pairing
    never stays connected — even re-paired with the same key, since the
    epoch moved — and its auth writes nothing onto the rebound row: neither
    its own facts nor a clear of the new key's."""
    device_id, old = await _enroll(pool, name="pc")
    new = old if same_key else FakeDevice()
    real_record = devices_ws._record_auth_facts
    drop_found: list[bool] = []

    async def _repaired_meanwhile(*args, **kwargs):
        if not drop_found:
            await _repair(pool, device_id, new, platform="linux")
            drop_found.append(await devices_ws.hub.disconnect(device_id, "re-paired"))
            await pool.execute(
                "UPDATE devices SET facts = $2, facts_at = now() WHERE id = $1",
                device_id,
                NEW_AGENT_FACTS,
            )
        await real_record(*args, **kwargs)

    monkeypatch.setattr(devices_ws, "_record_auth_facts", _repaired_meanwhile)
    conn, task, reply = await _auth_with(pool, device_id, old, old_facts)
    assert reply["type"] == "ready"
    assert drop_found == [False]  # the route's drop came too early to find it
    await asyncio.wait_for(task, 2)
    assert conn.closed_code == devices_ws.REVOKED_CLOSE
    assert not devices_ws.hub.is_connected(device_id)
    row = await devices.get(pool, device_id)
    assert row["pubkey"] == new.pubkey_hex and row["audit_epoch"] == 1
    assert row["facts"] == NEW_AGENT_FACTS


async def test_a_command_never_reaches_a_socket_the_repair_left_behind(pool, monkeypatch):
    """The narrowest window: the old pairing's socket is already in the hub,
    and serve has not yet re-read the row to drop it. A tool that fires right
    then must not reach the old key — hub.command sends only over a socket
    that authenticated at the row's current epoch, and records the truth."""
    device_id, old = await _enroll(pool, name="pc")
    real_record = devices_ws._record_auth_facts
    real_bound = devices_ws._still_bound
    seen: list = []

    async def _repaired_meanwhile(*args, **kwargs):
        if not seen:
            await _repair(pool, device_id, FakeDevice(), platform="linux")
            seen.append(await devices_ws.hub.disconnect(device_id, "re-paired"))
        await real_record(*args, **kwargs)

    async def _a_tool_fires_first(pool_, row):
        facts: list[dict] = []
        with pytest.raises(devices.DeviceRefused) as caught:
            await devices_ws.hub.command(
                pool_,
                device_id=device_id,
                name="pc",
                capability="system.info",
                args={},
                timeout=1,
                facts_sink=facts,
            )
        seen.append((caught.value.reason, facts))
        return await real_bound(pool_, row)

    monkeypatch.setattr(devices_ws, "_record_auth_facts", _repaired_meanwhile)
    monkeypatch.setattr(devices_ws, "_still_bound", _a_tool_fires_first)
    conn, task, reply = await _auth_with(pool, device_id, old, None)
    assert reply["type"] == "ready"
    await asyncio.wait_for(task, 3)
    assert seen[0] is False  # the route's drop found no socket yet
    reason, facts = seen[1]
    assert "not connected" in reason
    assert facts == [{"device": "pc", "connected": False}]
    assert [f for f in conn.sent if f.get("type") == "command"] == []
    assert conn.closed_code == devices_ws.REVOKED_CLOSE


async def test_a_repair_that_fails_before_commit_leaves_the_old_key_on_the_old_epoch(
    pool, monkeypatch
):
    """Key and epoch move in ONE UPDATE, inside the transaction that spends the
    code and writes device.repaired. A failure after the rebind but before the
    commit — here the ledger write — leaves no half: the old key on the old
    epoch, its facts, the code unspent, and no event."""
    device_id, old = await _enroll(pool, name="pc")
    await pool.execute(
        "UPDATE devices SET facts = $2, facts_at = now() WHERE id = $1", device_id, AUTH_FACTS
    )
    person = await _person(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    real_record = governance.record_event

    async def _ledger_down(conn, **kwargs):
        if kwargs.get("kind") == governance.DEVICE_REPAIRED:
            raise RuntimeError("simulated: the ledger write failed")
        await real_record(conn, **kwargs)

    monkeypatch.setattr(governance, "record_event", _ledger_down)
    with pytest.raises(RuntimeError):
        await devices.enroll(
            pool,
            code=minted["code"],
            pubkey=FakeDevice().pubkey_hex,
            name="pc",
            platform="linux",
            hostname="h",
        )
    row = await devices.get(pool, device_id)
    assert (row["pubkey"], row["audit_epoch"]) == (old.pubkey_hex, 0)
    assert row["facts"] == AUTH_FACTS and row["hostname"] == "host"
    assert (
        await pool.fetchval(
            "SELECT used_at FROM pairing_codes WHERE code_hash = $1",
            devices.hash_code(minted["code"]),
        )
        is None
    )
    repaired = "SELECT count(*) FROM governance_events WHERE kind = $1"
    assert await pool.fetchval(repaired, governance.DEVICE_REPAIRED) == 0


async def test_a_repair_clears_what_described_the_old_agent(pool):
    """Facts, last_seen and the door were the OLD agent's observations; the
    row keeps its name, owner and enrolled_at (history), and takes the new
    agent's platform and host."""
    device_id, _old = await _enroll(pool, name="pc", platform="windows")
    await pool.execute(
        "UPDATE devices SET facts = $2, facts_at = now(), last_seen = now(), "
        "last_transport = 'tailnet' WHERE id = $1",
        device_id,
        AUTH_FACTS,
    )
    before = await devices.get(pool, device_id)
    await _repair(pool, device_id, FakeDevice(), platform="linux")
    row = await devices.get(pool, device_id)
    assert (row["facts"], row["facts_at"], row["last_seen"], row["last_transport"]) == (
        None,
        None,
        None,
        None,
    )
    assert (row["platform"], row["hostname"]) == ("linux", "NEW-HOST")
    assert (row["name"], row["owner_person"], row["enrolled_at"]) == (
        before["name"],
        before["owner_person"],
        before["enrolled_at"],
    )


async def test_a_socket_whose_device_was_revoked_as_it_authenticated_is_dropped_too(
    pool, monkeypatch
):
    """The same window, for revoke: the re-read after joining is what closes it."""
    device_id, device = await _enroll(pool, name="pc")
    person = await _person(pool)
    real_record = devices_ws._record_auth_facts
    drop_found: list[bool] = []

    async def _revoked_meanwhile(*args, **kwargs):
        if not drop_found:
            await devices.revoke(pool, device_id=device_id, actor=str(person.id))
            drop_found.append(await devices_ws.hub.disconnect(device_id, "revoked"))
        await real_record(*args, **kwargs)

    monkeypatch.setattr(devices_ws, "_record_auth_facts", _revoked_meanwhile)
    conn, task, reply = await _auth_with(pool, device_id, device, None)
    assert reply["type"] == "ready" and drop_found == [False]
    await asyncio.wait_for(task, 2)
    assert conn.closed_code == devices_ws.REVOKED_CLOSE
    assert not devices_ws.hub.is_connected(device_id)


async def test_frames_the_old_key_had_in_flight_never_reach_the_new_epoch_or_the_rebound_row(
    pool,
):
    """The re-pair has committed but the route's drop has not landed (enroll
    itself drops nothing): whatever the old socket still sends speaks for a key
    the row no longer holds. Its heartbeat and facts stamp nothing on the
    rebound row, and its audit lands only in its own epoch's chain — never in
    the new key's."""
    device_id, old = await _enroll(pool, name="pc")
    conn, task, _ready = await _auth_with(pool, device_id, old, None)
    old_chain = _chain({}, {}, {})
    conn.feed({"type": "audit", "entries": old_chain[:2]})

    async def first_two_stored():
        return await _audit_rows(pool, device_id, 0) == 2

    await _until(first_two_stored)
    await _repair(pool, device_id, FakeDevice(), platform="linux")
    assert devices_ws.hub.is_connected(device_id)  # nothing has dropped it yet

    conn.feed({"type": "heartbeat", "ts": 1_790_000_000})
    conn.feed({"type": "facts", "net": {"ifaces": []}})
    conn.feed({"type": "audit", "entries": old_chain[2:]})
    conn.feed_close()
    await asyncio.wait_for(task, 2)  # every frame before the close was handled

    row = await devices.get(pool, device_id)
    assert row["last_seen"] is None
    assert row["facts"] is None and row["facts_at"] is None
    assert await _audit_rows(pool, device_id, 1) == 0
    assert await _audit_rows(pool, device_id, 0) == 3
    assert await _breaks(pool, device_id) == []


async def test_a_break_in_the_new_chain_names_its_epoch(pool):
    """After a re-pair a device has two chains that both start at seq 0, so a
    break that named only the seq could not be told apart."""
    device_id, _old = await _enroll(pool, name="pc")
    await devices_ws.ingest_audit(pool, device_id, _chain({}, {}))
    await _repair(pool, device_id, FakeDevice(), platform="linux")
    good, tampered = _chain({}, {})
    tampered["summary"] = "rewritten after the hash was taken"
    got = await devices_ws.ingest_audit(pool, device_id, [good, tampered], epoch=1)
    assert got == {"stored": 1, "break": 1}
    (event,) = await _breaks(pool, device_id)
    assert (event["meta"]["epoch"], event["meta"]["seq"]) == (1, 1)
