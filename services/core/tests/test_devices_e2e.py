"""The whole slice-5 DoD, walked in order against a FAKE device — the tripwire.

This is the model-INDEPENDENT regression gate for the device daemon's definition
of done (docs/plans/rebuild/slice-05-daemon.md, as amended 2026-09-03). No
model, no LLM, no reply prose — it drives the REAL machinery (the enroll route,
`devices_ws.serve`, `tools.dispatch`, the FakeDevice speaking the real WS
protocol) and asserts every step off the LEDGER (governance_events), the TABLES
(devices / device_audit) and the FRAMES the FakeWSConn recorded. A reply is a
claim; the row and the frame are the fact.

It drives an in-process FakeDevice through `devices_ws.serve` — the SAME code
path a Starlette WebSocket drives (WebSocketConn wraps a real socket in the same
conn abstraction) — and the fake is HONEST: it verifies core's signature over
each envelope (envelopes.verify) before returning a result, and appends a real
hash-chained audit entry per command, so a step that reaches past it has proven
the envelope was real and the chain joins up.

After the no-approvals ruling the walk is shorter and the bar is different:
there is no default grant to refuse against, no card to raise, no approval to
burn and no promotion to earn. What is left to prove is IDENTITY (the code
burn, the key pin, the challenge), TRANSPORT (one signed envelope per command;
only the device's own result resolves it) and the RECORD (the device's hash
chain lands link by link; a break is loud; the ledger holds exactly the pairing,
the break and the revoke, and nothing else). A fresh device runs a shell
command and reads a file outside any folder anyone chose, on its first connect
— that is the D1 consequence the owner accepted, pinned here so a gate cannot
quietly grow back.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path

import pytest

from app import devices, devices_ws, envelopes, governance, tools
from app.identity import Person
from app.tools.base import ToolContext
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn

pytestmark = requires_db

DEVICE_NAME = "workstation"


@pytest.fixture(autouse=True)
def _clean_hub():
    # The hub is a process-global singleton (like the db pool); reset its live
    # registry around the walk so no socket leaks in or out.
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()


# -- helpers -----------------------------------------------------------------


async def _owner(pool) -> Person:
    row = await pool.fetchrow("SELECT id, name, role FROM people WHERE role = 'owner'")
    return Person(id=row["id"], name=row["name"], role=row["role"])


def _ctx(person) -> ToolContext:
    return ToolContext(app=None, person=person, workspace_root=Path("/tmp"))


async def _events(pool) -> list:
    return await governance.recent_events(pool, limit=500)


def _kinds(events) -> set[str]:
    return {e["kind"] for e in events}


def _command_frames(conn: FakeWSConn) -> list[dict]:
    """Every `command` frame core put on this socket — the wire (the
    challenge/ready frames also ride conn.sent, so the count is filtered to
    commands, not `sent == []`)."""
    return [f for f in conn.sent if isinstance(f, dict) and f.get("type") == "command"]


async def _wait_for_audit_count(pool, device_id, expected: int) -> int:
    """The FakeDevice feeds audit frames into serve()'s receive loop, which
    ingests them fire-and-forget; poll until the stored count catches up (or
    return what is there, so an assertion names the shortfall)."""
    stored = 0
    for _ in range(200):
        stored = await pool.fetchval(
            "SELECT count(*) FROM device_audit WHERE device_id = $1", device_id
        )
        if stored >= expected:
            return stored
        await asyncio.sleep(0.02)
    return stored


async def test_the_device_daemon_walks_the_entire_dod(owner_client, pool):
    person = await _owner(pool)
    device = FakeDevice()

    # (a) ENROLL — the one public write, exercised through the real route so the
    # ------------ PUBLIC_PATHS path and the governance device.enrolled fire.
    minted = await devices.mint_pairing_code(pool, created_by=person.id)
    resp = await owner_client.post(
        "/api/v1/devices/enroll",
        json={
            "code": minted["code"],
            "pubkey": device.pubkey_hex,
            "name": DEVICE_NAME,
            "platform": "linux",
            "hostname": "host",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    device_id = uuid.UUID(body["device_id"])
    device.device_id = str(device_id)
    # core handed back its own key so each side has pinned the other.
    assert body["core_pubkey"] == await devices.core_public_key_hex(pool)
    # The registry row exists — identity, and nothing to grant.
    row = await pool.fetchrow("SELECT * FROM devices WHERE id = $1", device_id)
    assert row is not None and row["revoked_at"] is None
    assert row["pubkey"] == device.pubkey_hex
    enrolled = [e for e in await _events(pool) if e["kind"] == governance.DEVICE_ENROLLED]
    assert len(enrolled) == 1 and enrolled[0]["subject_ref"] == device_id
    assert _kinds(await _events(pool)) == {governance.DEVICE_ENROLLED}

    # (b) CONNECT + CHALLENGE — the fake runs serve()'s handshake, signing the
    # ------------------------- RAW nonce with its key. Reaching the hub proves
    # it authenticated BY KEY, not by any exemption.
    conn = FakeWSConn()
    serve_task = asyncio.create_task(devices_ws.serve(conn, pool))
    ready = await asyncio.wait_for(device.handshake(conn), 2)
    assert ready["type"] == "ready"
    assert ready["last_seq"] is None  # nothing audited yet
    assert devices_ws.hub.is_connected(device_id)

    # A heartbeat bumps last_seen (core's clock) — the DERIVED input the tile's
    # online/stale state is computed from. Proven here as the fact the
    # heartbeat actually moves last_seen off NULL.
    assert await pool.fetchval("SELECT last_seen FROM devices WHERE id = $1", device_id) is None
    conn.feed({"type": "heartbeat", "ts": int(time.time())})
    last_seen = None
    for _ in range(200):
        last_seen = await pool.fetchval("SELECT last_seen FROM devices WHERE id = $1", device_id)
        if last_seen is not None:
            break
        await asyncio.sleep(0.02)
    assert last_seen is not None  # the heartbeat landed — the tile has a clock to derive from

    # (c) SIGNED READ — device_info on a fresh pairing: a real number crosses,
    # --------------- core-signed, and the fake verified the signature before
    # it answered.
    core_pubkey = await devices.core_public_key_hex(pool)
    ans = asyncio.create_task(
        device.answer_command(
            conn, ok=True, output="disk: 431 GiB free of 512 GiB", summary="system.info"
        )
    )
    info_result, info_ok = await tools.dispatch(
        "device_info", {"device": DEVICE_NAME}, _ctx(person)
    )
    info_frame = await asyncio.wait_for(ans, 2)
    assert info_ok is True
    assert "431 GiB" in info_result
    # The command frame carried a core-SIGNED envelope — asserted off the frame,
    # not the reply.
    assert info_frame["type"] == "command"
    assert info_frame["envelope"]["capability"] == "system.info"
    assert info_frame["envelope"]["device_id"] == str(device_id)
    assert envelopes.verify(core_pubkey, info_frame["envelope"], info_frame["sig"])
    assert len(_command_frames(conn)) == 1

    # (d) SIGNED FILE READ, ANYWHERE — /etc/hostname is outside every folder the
    # ------------------------------ old grants editor would have offered. There
    # is no root: the path is absolute, so it is sent, as asked, on a device
    # paired seconds ago with nothing granted to it (the D1 consequence).
    ans = asyncio.create_task(
        device.answer_command(conn, ok=True, output="workstation\n", summary="fs.read")
    )
    read_result, read_ok = await tools.dispatch(
        "device_read_file", {"device": DEVICE_NAME, "path": "/etc/hostname"}, _ctx(person)
    )
    read_frame = await asyncio.wait_for(ans, 2)
    assert read_ok is True
    assert read_frame["envelope"]["capability"] == "fs.read"
    assert read_frame["envelope"]["args"]["path"] == "/etc/hostname"
    assert envelopes.verify(core_pubkey, read_frame["envelope"], read_frame["sig"])
    assert len(_command_frames(conn)) == 2

    # (e) SIGNED SHELL RUN — device_run was the consent-tier tool. No card, no
    # ------------------- approval, no ledger row: one signed envelope crosses
    # and the device's own result comes back. The ledger still holds only the
    # pairing — a row here would be a decision, and there are none.
    run_args = {"device": DEVICE_NAME, "argv": ["echo", "hi"]}
    ans = asyncio.create_task(
        device.answer_command(conn, ok=True, output="hi", exit_code=0, summary="ran echo")
    )
    run_result, run_ok = await tools.dispatch("device_run", run_args, _ctx(person))
    run_frame = await asyncio.wait_for(ans, 2)
    assert run_ok is True
    assert run_result.startswith(f"{DEVICE_NAME} ran ['echo', 'hi'] — exit 0")
    assert run_frame["envelope"]["capability"] == "shell.exec"
    assert run_frame["envelope"]["args"] == {"argv": ["echo", "hi"]}
    assert envelopes.verify(core_pubkey, run_frame["envelope"], run_frame["sig"])
    assert len(_command_frames(conn)) == 3
    assert _kinds(await _events(pool)) == {governance.DEVICE_ENROLLED}

    # (f) AUDIT LEDGER — the device's own chain landed in device_audit in order,
    # ---------------- link by link, and the stored hashes are exactly the ones
    # the device believes it sent. Assert BEFORE revoke, while the socket lives.
    expected_entries = len(device.audit_log)
    assert expected_entries == 3  # one per command that ran
    stored = await _wait_for_audit_count(pool, device_id, expected_entries)
    assert stored == expected_entries, f"only {stored}/{expected_entries} audit entries stored"
    audit_rows = await pool.fetch(
        "SELECT seq, hash, capability, ok, exit_code FROM device_audit "
        "WHERE device_id = $1 ORDER BY seq",
        device_id,
    )
    assert [r["seq"] for r in audit_rows] == list(range(expected_entries))  # in order, no gaps
    assert [r["hash"] for r in audit_rows] == [e["hash"] for e in device.audit_log]  # link by link
    assert [r["capability"] for r in audit_rows] == ["system.info", "fs.read", "shell.exec"]
    assert all(r["ok"] for r in audit_rows)

    # A deliberately broken chain is a LOUD device.audit_break naming the seq,
    # never a silent reindex — and stores nothing past the break. A daemon
    # running as the owner can rewrite its own audit file; this is what makes
    # that DETECTED rather than prevented.
    broke = await devices_ws.ingest_audit(
        pool, device_id, [device.broken_audit_entry(run_frame["envelope"])]
    )
    assert broke == {"stored": 0, "break": expected_entries}
    breaks = [
        e for e in await _events(pool)
        if e["kind"] == governance.DEVICE_AUDIT_BREAK and e["subject_ref"] == device_id
    ]
    assert len(breaks) == 1 and breaks[0]["meta"]["seq"] == expected_entries
    assert (
        await pool.fetchval("SELECT count(*) FROM device_audit WHERE device_id = $1", device_id)
        == expected_entries  # nothing stored past the break
    )

    # (g) REVOKE — through the operator route (DB revoke + hub.disconnect in one):
    # ---------- the live socket drops with 4403, a reconnect fails the challenge
    # with 4401 (get_live -> None), and a device tool for it refuses by name.
    resp = await owner_client.post(f"/api/v1/devices/{device_id}/revoke")
    assert resp.status_code == 200, resp.text
    assert conn.closed_code == devices_ws.REVOKED_CLOSE  # 4403 — dropped immediately
    assert not devices_ws.hub.is_connected(device_id)
    await asyncio.wait_for(serve_task, 2)  # the socket's serve loop unwound
    assert any(
        e["kind"] == governance.DEVICE_REVOKED and e["subject_ref"] == device_id
        for e in await _events(pool)
    )

    # A reconnect attempt is refused at the challenge — the row is gone, so the
    # auth fails and the socket is closed 4401; it never re-enters the hub.
    reconnect = FakeWSConn()
    reconnect_task = asyncio.create_task(devices_ws.serve(reconnect, pool))
    challenge = await asyncio.wait_for(reconnect.next_sent(), 2)
    assert challenge["type"] == "challenge"
    reconnect.feed(
        {"type": "auth", "device_id": str(device_id), "sig": device.sign_nonce(challenge["nonce"])}
    )
    err = await asyncio.wait_for(reconnect.next_sent(), 2)
    assert err["type"] == "auth_error"
    await asyncio.wait_for(reconnect_task, 2)
    assert reconnect.closed_code == devices_ws.AUTH_FAILED_CLOSE  # 4401
    assert not devices_ws.hub.is_connected(device_id)

    # A device tool now refuses the revoked machine BY NAME (get_live_by_name
    # returns nothing), never a silent no-op.
    gone_result, gone_ok = await tools.dispatch(
        "device_info", {"device": DEVICE_NAME}, _ctx(person)
    )
    assert gone_ok is False
    assert f"no paired device named '{DEVICE_NAME}'" in gone_result

    # (h) THE FULL ARC — the ledger holds EXACTLY the pairing, the break and the
    # ---------------- revoke: what happened, and no decision about it. Read
    # BOTH straight off the ledger AND through the authenticated operator route.
    every_kind = {
        governance.DEVICE_ENROLLED,
        governance.DEVICE_AUDIT_BREAK,
        governance.DEVICE_REVOKED,
    }
    assert _kinds(await _events(pool)) == every_kind
    resp = await owner_client.get("/api/v1/governance?limit=200")
    assert resp.status_code == 200, resp.text
    assert {e["kind"] for e in resp.json()["events"]} == every_kind
