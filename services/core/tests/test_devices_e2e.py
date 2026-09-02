"""The whole slice-5 DoD, walked in order against a FAKE device — the tripwire.

This is the model-INDEPENDENT regression gate for the device daemon's definition
of done (docs/plans/rebuild/slice-05-daemon.md §Definition of done). It mirrors
test_policy_e2e.py exactly: no model, no LLM, no reply prose — it drives the REAL
machinery (the enroll route, `devices_ws.serve`, `tools.dispatch`,
`consents.decide`, the FakeDevice speaking the real WS protocol) and asserts every
step off the LEDGER (governance_events), the TABLES (devices / device_audit /
consents / action_classes) and the FRAMES the FakeWSConn recorded. A reply is a
claim; the row and the frame are the fact.

Where the policy tripwire drove a Spy executor, this drives an in-process
FakeDevice through `devices_ws.serve` — the SAME code path a Starlette WebSocket
drives (WebSocketConn wraps a real socket in the same conn abstraction). So this
closes the "the real ASGI/socket lifecycle was never exercised end to end" gap
the T2/T3 reviews flagged: the fake completes the whole handshake / command /
result / audit lifecycle a real novad performs, and it is HONEST — it verifies
core's signature over each envelope (envelopes.verify) before returning a result,
and appends a real hash-chained audit entry per command, so a step that reaches
past it has proven the envelope was real and the chain joins up.

The model-driven halves of the DoD — ask Nova "read that file on <device>" and a
tool call is emitted; approve an "open Firefox" card and the model re-attempts —
are the OWNER's live gate, walked with a real novad on Jeremy's laptop after
review (task-5-report.md §"How to run the live walk"). This proves everything
underneath them mechanically.

Isolation, the same discipline test_policy_e2e.py documents: this walk PROMOTES
device_run (a real seeded class, migration 012) to prove DoD item 4's graduation
on a device tool — which mutates action_classes.disposition, and conftest does
NOT truncate action_classes (it carries the migration seed the kernel reads, so
it persists like schema). A leaked auto/earned device_run would redden
test_devices_ws.py's "a consent-gated device_run leaves zero frames" and
test_action_classes.py's "device_run is consent". The `_restore_device_classes`
fixture snapshots the three consent-tier device classes and restores them after,
so the mutation is reversible — "register nothing that mutates the shared seed
IRREVERSIBLY". devices / device_audit / consents / governance_events DO truncate
per test, so those need no restore.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path

import pytest

from app import autonomy, consents, devices, devices_ws, envelopes, governance, tools
from app.identity import Person
from app.tools.base import ToolContext
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn

pytestmark = requires_db

DEVICE_NAME = "workstation"
GRADUATION_N = 2  # small: proves promotion reads the LIVE setting and ACCUMULATES


@pytest.fixture(autouse=True)
def _clean_hub():
    # The hub is a process-global singleton (like the db pool); reset its live
    # registry around the walk so no socket leaks in or out.
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()


@pytest.fixture
async def _restore_device_classes(pool):
    """Snapshot the three consent-tier device classes and restore them after —
    the walk graduates device_run and action_classes is not truncated, so
    without this the promotion would leak into every later test in the session."""
    names = ["device_run", "device_write_file", "device_launch_app"]
    before = {
        r["action_class"]: (r["disposition"], r["earned"], r["consecutive_successes"])
        for r in await pool.fetch(
            "SELECT action_class, disposition, earned, consecutive_successes "
            "FROM action_classes WHERE action_class = ANY($1)",
            names,
        )
    }
    yield
    for ac, (disp, earned, streak) in before.items():
        await pool.execute(
            "UPDATE action_classes SET disposition = $2, earned = $3, "
            "consecutive_successes = $4, updated_at = now() WHERE action_class = $1",
            ac,
            disp,
            earned,
            streak,
        )


# -- helpers (mirroring test_policy_e2e.py's shape) --------------------------


async def _owner(pool) -> Person:
    row = await pool.fetchrow("SELECT id, name, role FROM people WHERE role = 'owner'")
    return Person(id=row["id"], name=row["name"], role=row["role"])


async def _conversation(pool, person: Person) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person.id
    )


def _ctx(person, *, conversation_id=None, sink=None) -> ToolContext:
    return ToolContext(
        app=None,
        person=person,
        workspace_root=Path("/tmp"),
        conversation_id=conversation_id,
        consent_sink=sink,
    )


async def _set_graduation(pool, n: int) -> None:
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('autonomy.graduation_runs', $1::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        n,
    )


async def _events(pool) -> list:
    return await governance.recent_events(pool, limit=500)


def _kinds(events) -> set[str]:
    return {e["kind"] for e in events}


def _command_frames(conn: FakeWSConn) -> list[dict]:
    """Every `command` frame core put on this socket — the wire, for the
    "a deny left ZERO frames" bar (the challenge/ready/heartbeat frames also ride
    conn.sent, so the count is filtered to commands, not `sent == []`)."""
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


async def test_the_device_daemon_walks_the_entire_dod(
    owner_client, pool, _restore_device_classes
):
    await _set_graduation(pool, GRADUATION_N)
    person = await _owner(pool)
    conv = await _conversation(pool, person)
    device = FakeDevice()

    # (a) ENROLL — the one public write, exercised through the real route so the
    # ------------ PUBLIC_PATHS path and the governance device.enrolled fire.
    # [DoD item 1]
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
    # The registry row exists, with EXACTLY the roadmap default grant.
    row = await pool.fetchrow("SELECT * FROM devices WHERE id = $1", device_id)
    assert row is not None and row["revoked_at"] is None
    assert row["capabilities"] == ["system.info"]  # nothing more, out of the box
    enrolled = [e for e in await _events(pool) if e["kind"] == governance.DEVICE_ENROLLED]
    assert len(enrolled) == 1 and enrolled[0]["subject_ref"] == device_id

    # (b) CONNECT + CHALLENGE — the fake runs serve()'s handshake, signing the
    # ------------------------- RAW nonce with its key. Reaching the hub proves
    # it authenticated BY KEY, not by any exemption. [DoD item 1]
    conn = FakeWSConn()
    serve_task = asyncio.create_task(devices_ws.serve(conn, pool))
    ready = await asyncio.wait_for(device.handshake(conn), 2)
    assert ready["type"] == "ready"
    assert ready["last_seq"] is None  # nothing audited yet
    assert devices_ws.hub.is_connected(device_id)

    # A heartbeat bumps last_seen (core's clock) — the DERIVED input the tile's
    # online/stale state is computed from (DoD item 5; the tile rendering itself
    # is web e2e 16 + T4's devicesFormat unit tests). Proven here as the fact the
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

    # (b2) AUTO READ on the DEFAULT grant — device_info needs system.info, which
    # ---------------------------------- IS the default grant, so a fresh device
    # answers it: a real number crosses, core-signed. [DoD item 3]
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
    # The command frame carried a core-SIGNED envelope for the granted capability
    # — asserted off the frame, not the reply.
    assert info_frame["type"] == "command"
    assert info_frame["envelope"]["capability"] == "system.info"
    assert info_frame["envelope"]["device_id"] == str(device_id)
    assert envelopes.verify(core_pubkey, info_frame["envelope"], info_frame["sig"])
    assert len(_command_frames(conn)) == 1

    # (c) DEFAULT-GRANT REFUSAL — device_read_file needs fs.read, which the fresh
    # -------------------------- device was NOT granted: refused NAMING Settings,
    # and NO command frame for it crosses the wire. [DoD item 2]
    read_result, read_ok = await tools.dispatch(
        "device_read_file", {"device": DEVICE_NAME, "path": "/home/jeremy/notes.txt"}, _ctx(person)
    )
    assert read_ok is False
    assert read_result.startswith("Error: ")
    assert "fs.read" in read_result and "Settings" in read_result
    assert len(_command_frames(conn)) == 1  # the ungranted read never reached the wire
    # That refusal came from the tool's PRECHECK, before the kernel: an ungranted
    # call is refused before a card can be raised or an approval burned for it,
    # so no policy.denied (and no consent row) exists for it — the kernel never
    # saw the call. (test_devices_precheck.py pins this for the consent tier.)
    assert not any(e["kind"] == governance.POLICY_DENIED for e in await _events(pool))
    assert await consents.pending_all(pool) == []

    # (d) GRANT — add fs.read (+ shell.exec for the consent flow) with a root;
    # ---------- the auto read now dispatches, a signed command crosses, the fake
    # returns the value. [DoD item 2 flip-live]
    await devices.set_grants(
        pool,
        device_id=device_id,
        capabilities=["system.info", "fs.read", "shell.exec"],
        fs_roots=["/home/jeremy"],
        actor=str(person.id),
    )
    grants = [e for e in await _events(pool) if e["kind"] == governance.DEVICE_GRANTS_CHANGED]
    assert len(grants) == 1 and grants[0]["subject_ref"] == device_id

    ans = asyncio.create_task(
        device.answer_command(conn, ok=True, output="line one\nline two", summary="fs.read")
    )
    read_result, read_ok = await tools.dispatch(
        "device_read_file", {"device": DEVICE_NAME, "path": "/home/jeremy/notes.txt"}, _ctx(person)
    )
    read_frame = await asyncio.wait_for(ans, 2)
    assert read_ok is True
    assert read_frame["envelope"]["capability"] == "fs.read"
    assert read_frame["envelope"]["args"]["path"] == "/home/jeremy/notes.txt"
    assert envelopes.verify(core_pubkey, read_frame["envelope"], read_frame["sig"])
    assert len(_command_frames(conn)) == 2

    # (d2) NO-IDENTITY POLICY DENY — a consent-tier device tool with no requestor
    # ----------------------------- has nothing to bind an approval to: the kernel
    # DENIES it and ledgers policy.denied, no frame. Probed AFTER the shell.exec
    # grant on purpose: the per-device precheck sits in front of the kernel, so
    # an ungranted call would be refused there and never reach it (that refusal
    # is a ToolFailure, not a policy.denied). With the grant in place the
    # precheck passes and this is the device path's one true policy.denied.
    # [DoD item 6 audit]
    denied_result, denied_ok = await tools.dispatch(
        "device_run", {"device": DEVICE_NAME, "argv": ["true"]}, _ctx(None)
    )
    assert denied_ok is False and denied_result.startswith("Error: ")
    assert any(
        e["kind"] == governance.POLICY_DENIED and e["action_class"] == "device_run"
        for e in await _events(pool)
    )
    assert len(_command_frames(conn)) == 2  # denied at the kernel, nothing sent

    # (e) CONSENT CARD — device_run is consent-tier: with no approval the kernel
    # ---------------- raises a card and REQUIRE_CONSENTs; a consents row + a
    # consent.raised event exist, and ZERO device_run command frames cross the
    # wire (the gate fires BEFORE the executor's grant/hub layer). [DoD item 4]
    run_args = {"device": DEVICE_NAME, "argv": ["firefox"]}
    sink: list[dict] = []
    result, ok = await tools.dispatch(
        "device_run", run_args, _ctx(person, conversation_id=conv, sink=sink)
    )
    assert ok is False
    assert result.startswith("Awaiting your approval")
    assert len(sink) == 1 and sink[0]["action_class"] == "device_run"
    pending = [
        c for c in await consents.pending_all(pool)
        if c["action_class"] == "device_run" and c["args"] == run_args
    ]
    assert len(pending) == 1
    card1 = pending[0]
    raised = [
        e for e in await _events(pool)
        if e["kind"] == governance.CONSENT_RAISED and e["action_class"] == "device_run"
    ]
    assert len(raised) == 1 and raised[0]["subject_ref"] == uuid.UUID(card1["consent_id"])
    assert len(_command_frames(conn)) == 2  # still no device_run frame

    # (f) DENY — the card is terminal; NOTHING ever crossed the wire for it, and
    # --------- the device's own audit log AND core's device_audit both agree no
    # shell.exec entry exists. "Activity proves nothing ran", on a second
    # machine. [DoD item 4]
    await consents.decide(
        pool, consent_id=uuid.UUID(card1["consent_id"]), approve=False, decided_by=person.id
    )
    decided_denied = [
        e for e in await _events(pool)
        if e["kind"] == governance.CONSENT_DECIDED and e["meta"].get("decision") == "denied"
    ]
    assert len(decided_denied) == 1
    assert len(_command_frames(conn)) == 2  # the deny sent no command
    # The device side agrees: it was never asked to run anything, so it logged
    # nothing for shell.exec — and core stored nothing for it either.
    assert [e for e in device.audit_log if e["capability"] == "shell.exec"] == []
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM device_audit WHERE device_id = $1 AND capability = 'shell.exec'",
            device_id,
        )
        == 0
    )

    # (g) APPROVE + RUN — deny granted nothing, so the next dispatch raises a
    # ----------------- FRESH card; approve it, re-attempt burns it and the run
    # crosses the wire and executes; a second re-attempt does NOT double-spend.
    # [DoD item 4]
    _, ok = await tools.dispatch("device_run", run_args, _ctx(person, conversation_id=conv))
    assert ok is False  # a fresh card, not the denied one
    card2 = next(
        c for c in await consents.pending_all(pool)
        if c["action_class"] == "device_run" and c["args"] == run_args
    )
    assert card2["consent_id"] != card1["consent_id"]
    await consents.decide(
        pool, consent_id=uuid.UUID(card2["consent_id"]), approve=True, decided_by=person.id
    )
    # Approving alone ran nothing (ruling S3-R4): still unspent, still no frame.
    assert (await consents.get(pool, uuid.UUID(card2["consent_id"])))["used_at"] is None
    assert len(_command_frames(conn)) == 2

    ans = asyncio.create_task(
        device.answer_command(conn, ok=True, output="", exit_code=0, summary="launched firefox")
    )
    run_result, run_ok = await tools.dispatch(
        "device_run", run_args, _ctx(person, conversation_id=conv)
    )
    run_frame = await asyncio.wait_for(ans, 2)
    assert run_ok is True
    assert run_frame["envelope"]["capability"] == "shell.exec"
    assert envelopes.verify(core_pubkey, run_frame["envelope"], run_frame["sig"])
    assert len(_command_frames(conn)) == 3  # NOW the device_run crossed the wire
    burned = [
        e for e in await _events(pool)
        if e["kind"] == governance.CONSENT_BURNED
        and e["subject_ref"] == uuid.UUID(card2["consent_id"])
    ]
    assert len(burned) == 1
    assert (await consents.get(pool, uuid.UUID(card2["consent_id"])))["used_at"] is not None

    # No double-spend: the now-spent approval re-raises rather than running again.
    _, ok = await tools.dispatch("device_run", run_args, _ctx(person, conversation_id=conv))
    assert ok is False
    assert len(_command_frames(conn)) == 3  # still just the one device_run run

    # (h) GRADUATE — N approve+burn+succeed cycles promote device_run to auto,
    # ------------ earned, mechanically (autonomy.promoted). The streak is zeroed
    # first so the walk proves the counter ACCUMULATES to the LIVE threshold, not
    # a single-shot promotion. [DoD item 4 graduation]
    await pool.execute(
        "UPDATE action_classes SET disposition = 'consent', earned = false, "
        "consecutive_successes = 0, updated_at = now() WHERE action_class = 'device_run'"
    )
    for i in range(GRADUATION_N):
        cycle_args = {"device": DEVICE_NAME, "argv": ["echo", f"cycle-{i}"]}
        _, ok = await tools.dispatch("device_run", cycle_args, _ctx(person, conversation_id=conv))
        assert ok is False
        card = next(
            c for c in await consents.pending_all(pool)
            if c["action_class"] == "device_run" and c["args"] == cycle_args
        )
        await consents.decide(
            pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
        )
        ans = asyncio.create_task(
            device.answer_command(
                conn, ok=True, output=f"cycle-{i}", exit_code=0, summary="graduation run"
            )
        )
        _, ok = await tools.dispatch("device_run", cycle_args, _ctx(person, conversation_id=conv))
        await asyncio.wait_for(ans, 2)
        assert ok is True
    graduated = await pool.fetchrow(
        "SELECT disposition, earned, consecutive_successes FROM action_classes "
        "WHERE action_class = 'device_run'"
    )
    assert graduated["disposition"] == "auto"
    assert graduated["earned"] is True
    assert graduated["consecutive_successes"] == 0
    promoted = [
        e for e in await _events(pool)
        if e["kind"] == governance.AUTONOMY_PROMOTED and e["action_class"] == "device_run"
    ]
    assert len(promoted) >= 1

    # Now device_run auto-runs with NO card — the kernel reads the row it always
    # reads and ALLOWs straight through.
    auto_args = {"device": DEVICE_NAME, "argv": ["echo", "post-promote"]}
    sink_auto: list[dict] = []
    ans = asyncio.create_task(
        device.answer_command(conn, ok=True, output="post-promote", exit_code=0, summary="auto run")
    )
    _, auto_ok = await tools.dispatch(
        "device_run", auto_args, _ctx(person, conversation_id=conv, sink=sink_auto)
    )
    await asyncio.wait_for(ans, 2)
    assert auto_ok is True
    assert sink_auto == []  # no approval card raised — it just runs
    command_count = len(_command_frames(conn))
    assert command_count == 6  # info + read + run + 2 graduation cycles + post-promote

    # (i) AUDIT LEDGER — the device's own chain landed in device_audit in order,
    # ---------------- link by link, and the stored hashes are exactly the ones
    # the device believes it sent. Assert BEFORE revoke, while the socket lives.
    # [DoD item 6]
    expected_entries = len(device.audit_log)
    assert expected_entries == 6  # one per command that ran
    stored = await _wait_for_audit_count(pool, device_id, expected_entries)
    assert stored == expected_entries, f"only {stored}/{expected_entries} audit entries stored"
    audit_rows = await pool.fetch(
        "SELECT seq, hash, capability, ok, exit_code FROM device_audit "
        "WHERE device_id = $1 ORDER BY seq",
        device_id,
    )
    assert [r["seq"] for r in audit_rows] == list(range(expected_entries))  # in order, no gaps
    assert [r["hash"] for r in audit_rows] == [e["hash"] for e in device.audit_log]  # link by link
    # The shell.exec runs (g + graduation + post-promote) are all ok, non-null exit.
    shell_rows = [r for r in audit_rows if r["capability"] == "shell.exec"]
    assert len(shell_rows) == 4 and all(r["ok"] and r["exit_code"] == 0 for r in shell_rows)

    # A deliberately broken chain is a LOUD device.audit_break naming the seq,
    # never a silent reindex — and stores nothing past the break.
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

    # (j) REVOKE — through the operator route (DB revoke + hub.disconnect in one):
    # ---------- the live socket drops with 4403, a reconnect fails the challenge
    # with 4401 (get_live -> None), and a device tool for it refuses by name.
    # [DoD item 6]
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

    # (k) THE FULL ARC — every governance kind the device DoD produces is in the
    # ---------------- operator's audit, read BOTH straight off the ledger AND
    # through the authenticated operator route the DoD requires. [DoD item 6]
    every_kind = {
        governance.DEVICE_ENROLLED,
        governance.DEVICE_GRANTS_CHANGED,
        governance.POLICY_DENIED,
        governance.CONSENT_RAISED,
        governance.CONSENT_DECIDED,
        governance.CONSENT_BURNED,
        governance.AUTONOMY_PROMOTED,
        governance.DEVICE_AUDIT_BREAK,
        governance.DEVICE_REVOKED,
    }
    from_ledger = _kinds(await _events(pool))
    assert every_kind <= from_ledger, f"missing from ledger: {every_kind - from_ledger}"
    resp = await owner_client.get("/api/v1/governance?limit=200")
    assert resp.status_code == 200, resp.text
    from_route = {e["kind"] for e in resp.json()["events"]}
    assert every_kind <= from_route, f"missing from the audit route: {every_kind - from_route}"

    # The autonomy state route also reflects the earned promotion (before the
    # fixture restores it) — the same row the kernel reads, surfaced to the owner.
    assert any(
        c["action_class"] == "device_run" and c["disposition"] == "auto" and c["earned"] is True
        for c in await autonomy.state(pool)
    )
