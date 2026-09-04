"""The device socket, the hub, the audit chain, and the nine tools on the wire.

Every property slice 5's rails still name after the no-approvals ruling
(2026-09-03) is pinned here, and none by reading prose: the challenge
authenticates (a bad signature is closed 4401, a revoked device is refused at
the challenge), a command is answered only by the device's own result frame (a
silent device is a stated timeout), every device tool — device_run included —
reaches the wire signed with no card and no grant in the way, a relative path
is refused before the wire (the one fs refusal left: a shape, not a boundary),
revoke kills the live socket, and a broken audit chain is a loud governance
event that stores nothing past the break.

The facts channel is pinned here too (relocated from the precheck suite that
died with the precheck): a device tool records {device, connected} the moment
it determines connectivity, exactly once per call, for both outcomes — so the
state-claim guard can tell "it checked and the machine is offline" from "it
never looked" without sniffing a refusal string.

The fake WS conn (tests/device_fakes.py) makes all of this testable with no
socket; test_devices_e2e.py walks the whole lifecycle through it.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path

import pytest

from app import devices, devices_ws, governance, tools
from app.identity import Person
from app.tools.base import ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn

pytestmark = requires_db


@pytest.fixture(autouse=True)
def _clean_hub():
    # The hub is a process-global singleton (like the db pool); reset its live
    # registry around every test so one test's sockets never leak into the next.
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()


# -- helpers -----------------------------------------------------------------


async def _person(pool, role: str = "adult") -> Person:
    # role 'adult' (not 'owner') so a test can make several people — the
    # people_one_owner partial unique index allows exactly one owner.
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", role, role
    )
    return Person(id=pid, name=role, role=role)


async def _enroll(pool, *, name: str = "laptop") -> tuple[uuid.UUID, FakeDevice]:
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
    return uuid.UUID(result["device_id"]), device


async def _connect(pool, **enroll_kw) -> tuple[uuid.UUID, FakeDevice, FakeWSConn, asyncio.Task]:
    """Enroll, then drive serve() through the challenge to a registered socket."""
    device_id, device = await _enroll(pool, **enroll_kw)
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    challenge = await asyncio.wait_for(conn.next_sent(), 2)
    assert challenge["type"] == "challenge"
    conn.feed(
        {"type": "auth", "device_id": str(device_id), "sig": device.sign_nonce(challenge["nonce"])}
    )
    ready = await asyncio.wait_for(conn.next_sent(), 2)
    assert ready["type"] == "ready"
    return device_id, device, conn, task


async def _close(conn: FakeWSConn, task: asyncio.Task) -> None:
    conn.feed_close()
    await asyncio.wait_for(task, 2)


def _ctx(person: Person | None, *, facts: list[dict] | None = None) -> ToolContext:
    return ToolContext(app=None, person=person, workspace_root=Path("/tmp"), facts_sink=facts)


def _command_frames(conn: FakeWSConn) -> list[dict]:
    return [f for f in conn.sent if isinstance(f, dict) and f.get("type") == "command"]


# -- the challenge -----------------------------------------------------------


async def test_challenge_auth_ready_and_registration(pool):
    device_id, device = await _enroll(pool)
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    try:
        challenge = await asyncio.wait_for(conn.next_sent(), 2)
        assert challenge["type"] == "challenge"
        assert len(bytes.fromhex(challenge["nonce"])) == devices_ws.NONCE_BYTES
        assert challenge["core_pubkey"] == await devices.core_public_key_hex(pool)

        conn.feed(
            {
                "type": "auth",
                "device_id": str(device_id),
                "sig": device.sign_nonce(challenge["nonce"]),
            }
        )
        ready = await asyncio.wait_for(conn.next_sent(), 2)
        assert ready["type"] == "ready"
        assert ready["last_seq"] is None  # nothing audited yet
        assert devices_ws.hub.is_connected(device_id)
    finally:
        await _close(conn, task)
    assert not devices_ws.hub.is_connected(device_id)


async def test_a_bad_challenge_signature_is_refused_and_closed(pool):
    device_id, _device = await _enroll(pool)
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    await asyncio.wait_for(conn.next_sent(), 2)  # drain the challenge; the sig below ignores it
    conn.feed({"type": "auth", "device_id": str(device_id), "sig": "00" * 64})
    err = await asyncio.wait_for(conn.next_sent(), 2)
    assert err["type"] == "auth_error"
    await asyncio.wait_for(task, 2)
    assert conn.closed_code == devices_ws.AUTH_FAILED_CLOSE
    assert not devices_ws.hub.is_connected(device_id)


async def test_an_unknown_device_id_is_refused(pool):
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    challenge = await asyncio.wait_for(conn.next_sent(), 2)
    conn.feed(
        {
            "type": "auth",
            "device_id": str(uuid.uuid4()),
            "sig": FakeDevice().sign_nonce(challenge["nonce"]),
        }
    )
    err = await asyncio.wait_for(conn.next_sent(), 2)
    assert err["type"] == "auth_error"
    await asyncio.wait_for(task, 2)
    assert conn.closed_code == devices_ws.AUTH_FAILED_CLOSE


async def test_a_revoked_device_cannot_authenticate(pool):
    device_id, device = await _enroll(pool)
    await devices.revoke(pool, device_id=device_id, actor="tester")
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    challenge = await asyncio.wait_for(conn.next_sent(), 2)
    conn.feed(
        {"type": "auth", "device_id": str(device_id), "sig": device.sign_nonce(challenge["nonce"])}
    )
    err = await asyncio.wait_for(conn.next_sent(), 2)
    assert err["type"] == "auth_error"
    await asyncio.wait_for(task, 2)
    assert not devices_ws.hub.is_connected(device_id)


async def test_an_auth_frame_with_unknown_keys_still_authenticates(pool):
    """The frame contract ignores unknown keys. `home_dir` is the one an older
    novad still sends (it died with the grants editor, 2026-09-03): nothing
    reads it, and the socket authenticates on the signature alone."""
    device_id, device = await _enroll(pool)
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    challenge = await asyncio.wait_for(conn.next_sent(), 2)
    conn.feed(
        {
            "type": "auth",
            "device_id": str(device_id),
            "sig": device.sign_nonce(challenge["nonce"]),
            "home_dir": "/home/jeremy",
            "some_future_key": {"ignored": True},
        }
    )
    ready = await asyncio.wait_for(conn.next_sent(), 2)
    assert ready["type"] == "ready"
    assert devices_ws.hub.is_connected(device_id)
    await _close(conn, task)


# -- heartbeat ---------------------------------------------------------------


async def test_heartbeat_updates_last_seen(pool):
    device_id, _device, conn, task = await _connect(pool)
    assert await pool.fetchval("SELECT last_seen FROM devices WHERE id = $1", device_id) is None
    conn.feed({"type": "heartbeat", "ts": int(time.time())})
    after = None
    for _ in range(100):
        after = await pool.fetchval("SELECT last_seen FROM devices WHERE id = $1", device_id)
        if after is not None:
            break
        await asyncio.sleep(0.02)
    assert after is not None
    await _close(conn, task)


# -- commands: only a result frame resolves ----------------------------------


async def test_a_command_is_signed_by_core_and_answered_by_the_device(pool):
    device_id, device, conn, task = await _connect(pool)
    core_pubkey = await devices.core_public_key_hex(pool)

    async def run():
        return await devices_ws.hub.command(
            pool, device_id=device_id, name="laptop", capability="system.info", args={}, timeout=5
        )

    cmd = asyncio.create_task(run())
    frame = await asyncio.wait_for(conn.next_sent(), 2)
    assert frame["type"] == "command"
    assert frame["envelope"]["capability"] == "system.info"
    assert frame["envelope"]["device_id"] == str(device_id)
    # core signed the envelope with ITS key — a device verifies exactly this.
    assert device.verify_command(core_pubkey, frame)

    conn.feed(device.result(frame["envelope"], ok=True, output="disk 50% free", exit_code=0))
    result = await asyncio.wait_for(cmd, 2)
    assert result["ok"] is True and result["output"] == "disk 50% free"
    await _close(conn, task)


async def test_a_silent_device_times_out_as_a_stated_refusal(pool):
    device_id, _device, conn, task = await _connect(pool)
    with pytest.raises(devices.DeviceRefused) as exc:
        await devices_ws.hub.command(
            pool, device_id=device_id, name="laptop", capability="system.info", args={}, timeout=0.1
        )
    assert "did not answer" in exc.value.reason
    await _close(conn, task)


async def test_a_command_to_a_disconnected_device_is_refused(pool):
    device_id, _device = await _enroll(pool)  # never joins the hub
    with pytest.raises(devices.DeviceRefused) as exc:
        await devices_ws.hub.command(
            pool, device_id=device_id, name="laptop", capability="system.info", args={}, timeout=1
        )
    assert "not connected" in exc.value.reason


async def test_a_command_to_a_revoked_device_is_refused(pool):
    device_id, _device = await _enroll(pool)
    devices_ws.hub.register(device_id, FakeWSConn())  # even a "live" socket cannot save it
    await devices.revoke(pool, device_id=device_id, actor="tester")
    with pytest.raises(devices.DeviceRefused) as exc:
        await devices_ws.hub.command(
            pool, device_id=device_id, name="laptop", capability="system.info", args={}, timeout=1
        )
    assert "revoked" in exc.value.reason


# -- revoke kills the socket -------------------------------------------------


async def test_disconnect_closes_a_live_socket(pool):
    device_id, _device, conn, task = await _connect(pool)
    assert devices_ws.hub.is_connected(device_id)
    killed = await devices_ws.hub.disconnect(device_id, "revoked")
    assert killed is True
    assert conn.closed_code == devices_ws.REVOKED_CLOSE
    assert not devices_ws.hub.is_connected(device_id)
    await asyncio.wait_for(task, 2)


async def test_disconnecting_an_absent_device_is_a_false_no_op(pool):
    assert await devices_ws.hub.disconnect(uuid.uuid4(), "revoked") is False


async def test_revoking_through_the_api_kills_the_live_socket(owner_client, pool):
    device_id, _device = await _enroll(pool, name="laptop")
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)
    resp = await owner_client.post(f"/api/v1/devices/{device_id}/revoke")
    assert resp.status_code == 200, resp.text
    assert conn.closed_code == devices_ws.REVOKED_CLOSE
    assert not devices_ws.hub.is_connected(device_id)


# -- every device tool reaches the wire signed: no card, no grant, no ledger row


async def test_a_device_run_reaches_the_wire_signed(pool):
    """device_run was the consent-tier tool. It now runs like any other: a
    fresh pairing, no grant, no card, no approval — one signed envelope on the
    wire, the device's own result back, and NOTHING in the governance ledger
    beyond the pairing itself (a ledger row here would be a gate recording a
    decision, and there are no decisions)."""
    device_id, device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)
    args = {"device": "laptop", "argv": ["echo", "hi"]}
    core_pubkey = await devices.core_public_key_hex(pool)

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command" and frame["envelope"]["capability"] == "shell.exec"
        assert frame["envelope"]["args"] == {"argv": ["echo", "hi"]}
        assert device.verify_command(core_pubkey, frame)
        conn.feed(device.result(frame["envelope"], ok=True, output="hi", exit_code=0))

    ans = asyncio.create_task(answer())
    result, ok = await tools.dispatch("device_run", args, _ctx(person))
    await asyncio.wait_for(ans, 2)
    assert ok is True
    assert "exit 0" in result and "hi" in result
    assert len(_command_frames(conn)) == 1
    kinds = {
        r["kind"]
        for r in await pool.fetch(
            "SELECT kind FROM governance_events WHERE subject_ref = $1", device_id
        )
    }
    assert kinds == {governance.DEVICE_ENROLLED}
    await _close(conn, task)


# -- the fs path: absolute is the whole check, and it is normalized ----------


async def test_a_relative_path_is_refused_before_the_wire(pool):
    """The ONE filesystem refusal left. A relative path would resolve against
    the daemon's cwd — a different file from the one asked for — so it cannot
    be sent as asked. A shape check, not a boundary: it states the call CANNOT
    run, never that it may not."""
    device_id, _device = await _enroll(pool, name="laptop")
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)  # connected, so a leak WOULD show a frame
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_read_file", {"device": "laptop", "path": "notes.txt"}, _ctx(person)
    )
    assert ok is False
    assert result.startswith("Error: ")
    assert "must be absolute" in result
    assert conn.sent == []  # refused before hub.command — nothing crossed the wire


async def test_a_dotdot_path_is_normalized_before_it_crosses_the_wire(pool):
    """There is no root, so `/home/jeremy/../../etc/shadow` is not refused —
    it is sent, as `/etc/shadow`. normpath runs so the daemon receives one
    spelling of the path core signed for; this reddens if a refactor ever
    ships the raw string."""
    device_id, device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command"
        assert frame["envelope"]["capability"] == "fs.read"
        assert frame["envelope"]["args"]["path"] == "/etc/shadow"
        conn.feed(device.result(frame["envelope"], ok=True, output="root:x", exit_code=0))

    ans = asyncio.create_task(answer())
    result, ok = await tools.dispatch(
        "device_read_file",
        {"device": "laptop", "path": "/home/jeremy/../../etc/shadow"},
        _ctx(person),
    )
    await asyncio.wait_for(ans, 2)
    assert ok is True
    assert "root:x" in result
    await _close(conn, task)


async def test_an_absolute_path_reaches_the_wire_normalized(pool):
    # A plain absolute path crosses as given; one with a redundant "." segment
    # proves normpath ran on the allowed path too, not only on a refused one.
    device_id, device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)

    async def answer_expecting(expected_path: str):
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command"
        assert frame["envelope"]["capability"] == "fs.list"
        assert frame["envelope"]["args"]["path"] == expected_path
        conn.feed(device.result(frame["envelope"], ok=True, output="listing", exit_code=0))

    ans = asyncio.create_task(answer_expecting("/home/jeremy"))
    _r, ok = await tools.dispatch(
        "device_list_files", {"device": "laptop", "path": "/home/jeremy"}, _ctx(person)
    )
    await asyncio.wait_for(ans, 2)
    assert ok is True

    ans2 = asyncio.create_task(answer_expecting("/home/jeremy/notes.txt"))
    _r2, ok2 = await tools.dispatch(
        "device_list_files", {"device": "laptop", "path": "/home/jeremy/./notes.txt"}, _ctx(person)
    )
    await asyncio.wait_for(ans2, 2)
    assert ok2 is True

    await _close(conn, task)


# -- the write cap and the lone-surrogate guard refuse before the wire --------


async def test_device_write_file_over_the_cap_is_refused_before_the_wire(pool):
    """M2: content over 256 KiB is a STATED refusal in the executor, BEFORE the
    envelope reaches the transport — an oversize write would otherwise flap the
    socket into a timeout (a hang, not a refusal). Nothing crosses the wire."""
    from app.tools import devices as device_tools

    device_id, _device = await _enroll(pool, name="laptop")
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)  # connected, so a leak WOULD show a frame
    person = await _person(pool)
    oversize = "a" * (device_tools.WRITE_FILE_CAP_KIB * 1024 + 1)

    with pytest.raises(ToolFailure) as excinfo:
        await device_tools.device_write_file(
            {"device": "laptop", "path": "/home/jeremy/big.txt", "content": oversize},
            _ctx(person),
        )
    assert "write cap" in str(excinfo.value)
    assert conn.sent == []  # refused before hub.command — nothing crossed the wire


async def test_device_write_file_at_exactly_the_cap_reaches_the_wire(pool):
    """M2 boundary: content exactly at 256 KiB is allowed and the full content
    crosses in a signed envelope — the cap refuses, it must not over-refuse."""
    from app.tools import devices as device_tools

    device_id, device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)
    cap_bytes = device_tools.WRITE_FILE_CAP_KIB * 1024
    exact = "a" * cap_bytes

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command"
        assert frame["envelope"]["capability"] == "fs.write"
        # the whole content crossed, unmodified — no truncation at the boundary
        assert len(frame["envelope"]["args"]["content"].encode("utf-8")) == cap_bytes
        conn.feed(device.result(frame["envelope"], ok=True, output="", exit_code=0))

    ans = asyncio.create_task(answer())
    result = await device_tools.device_write_file(
        {"device": "laptop", "path": "/home/jeremy/atcap.txt", "content": exact},
        _ctx(person),
    )
    await asyncio.wait_for(ans, 2)
    assert "Wrote" in result
    await _close(conn, task)


async def test_a_lone_surrogate_arg_is_refused_before_signing(pool):
    """M1: an arg carrying an unpaired UTF-16 surrogate is refused NAMING it,
    before signing — Go decodes a lone surrogate to U+FFFD, so it would surface
    as an opaque "signature did not verify" at the daemon. No frame crosses."""
    from app.tools import devices as device_tools

    device_id, _device = await _enroll(pool, name="laptop")
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)  # connected, so a leak WOULD show a frame
    person = await _person(pool)

    with pytest.raises(ToolFailure) as excinfo:
        await device_tools.device_notify(
            {"device": "laptop", "message": "hi \ud83d there"}, _ctx(person)
        )
    assert "surrogate" in str(excinfo.value)
    assert conn.sent == []  # refused before hub.command — nothing was signed or sent


async def test_a_command_send_failure_is_the_same_stale_tile_refusal(pool):
    # The socket dies between the in-hub check and the write: a send that failed
    # never reached the device, so it must read exactly like a missing socket,
    # never as "failed unexpectedly — <ExcType>".
    class _DeadConn(FakeWSConn):
        async def send(self, frame: dict) -> None:
            raise ConnectionResetError("socket went away mid-write")

    device_id, _device = await _enroll(pool, name="laptop")
    devices_ws.hub.register(device_id, _DeadConn())
    person = await _person(pool)
    result, ok = await tools.dispatch("device_info", {"device": "laptop"}, _ctx(person))
    assert ok is False
    assert "not connected" in result and "tile is stale" in result
    assert "unexpectedly" not in result  # a stated refusal, not a leaked exception


async def test_a_disconnected_device_tool_is_a_stated_failure(pool):
    await _enroll(pool, name="laptop")  # paired, not connected
    person = await _person(pool)
    result, ok = await tools.dispatch("device_info", {"device": "laptop"}, _ctx(person))
    assert ok is False
    assert "not connected" in result


async def test_a_tool_for_a_revoked_device_is_refused_by_name(pool):
    device_id, _device = await _enroll(pool, name="laptop")
    await devices.revoke(pool, device_id=device_id, actor="tester")
    person = await _person(pool)
    result, ok = await tools.dispatch("device_info", {"device": "laptop"}, _ctx(person))
    assert ok is False
    assert "no paired device named 'laptop'" in result


async def test_a_device_reporting_failure_is_not_dressed_as_success(pool):
    device_id, device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        conn.feed(
            device.result(
                frame["envelope"], ok=False, output="", exit_code=None, error="probe blew up"
            )
        )

    ans = asyncio.create_task(answer())
    result, ok = await tools.dispatch("device_info", {"device": "laptop"}, _ctx(person))
    await asyncio.wait_for(ans, 2)
    assert ok is False
    assert "probe blew up" in result
    await _close(conn, task)


async def test_device_list_derives_connected_from_hub_membership(pool):
    # Names deliberately do NOT echo a status word, so the assertions prove the
    # DERIVED status per device rather than a name colliding with the status text.
    laptop_id, _d1 = await _enroll(pool, name="laptop")
    await _enroll(pool, name="deskbox")
    devices_ws.hub.register(laptop_id, FakeWSConn())  # only the laptop is in the hub
    person = await _person(pool)
    result, ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert ok is True
    lines = {
        line.split(" (")[0].removeprefix("- "): line
        for line in result.splitlines()
        if line.startswith("- ")
    }
    assert "connected" in lines["laptop"]  # in the hub -> connected
    assert "offline" in lines["deskbox"]  # not in the hub -> offline


# -- the facts channel: a refusal that DETERMINED connectivity says so ---------
#
# Review finding C1. The per-device layer is the ONE place core decides whether
# a machine's socket is live, and it decides it just as much when it then
# refuses. Downstream (the chat turn's state-claim guard) has to be able to tell
# "it checked and the machine is offline" from "it never looked", and the only
# honest way is a structured record written where the decision happens — never a
# caller sniffing "not connected" out of a refusal string. Without it an honest
# "I ran it and it came back not connected" is CORRECTED and REPLACED, which is
# the worst thing that guard can do.


async def test_an_offline_device_records_connected_false_before_refusing(pool):
    """The device is not in the hub. The executor refuses — and records the
    connectivity it just determined, for the refusal path."""
    await _enroll(pool, name="laptop")
    person = await _person(pool)
    facts: list[dict] = []

    result, ok = await tools.dispatch(
        "device_run", {"device": "laptop", "argv": ["ls"]}, _ctx(person, facts=facts)
    )

    assert ok is False
    assert "not connected" in result
    assert facts == [{"device": "laptop", "connected": False}]


async def test_an_unknown_device_name_determines_nothing_and_records_nothing(pool):
    """`_resolve` refuses BEFORE connectivity is looked at. Nothing was settled,
    so nothing is recorded — and nothing downstream may treat it as a check."""
    await _enroll(pool, name="laptop")
    person = await _person(pool)
    facts: list[dict] = []

    result, ok = await tools.dispatch(
        "device_run", {"device": "nope", "argv": ["ls"]}, _ctx(person, facts=facts)
    )

    assert ok is False
    assert "no paired device named" in result
    assert facts == []


async def test_a_successful_call_records_the_fact_exactly_once(pool):
    """One call, one determination, one record. The chat loop slices the sink
    per call to fill each span's `facts`, so a call that recorded twice would
    be trace noise and a call that recorded nothing would look unchecked."""
    device_id, _device = await _enroll(pool, name="laptop")
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)
    person = await _person(pool)
    facts: list[dict] = []

    task = asyncio.create_task(
        tools.dispatch("device_info", {"device": "laptop"}, _ctx(person, facts=facts))
    )
    frame = await asyncio.wait_for(conn.next_sent(), 2)
    assert frame["type"] == "command"
    envelope_id = frame["envelope"]["envelope_id"]
    devices_ws.hub.resolve(
        device_id,
        envelope_id,
        {
            "type": "result",
            "envelope_id": envelope_id,
            "ok": True,
            "output": "disk: 431 GiB free",
            "exit_code": 0,
            "error": None,
        },
    )
    result, ok = await asyncio.wait_for(task, 2)

    assert ok is True and "disk: 431 GiB free" in result
    assert facts == [{"device": "laptop", "connected": True}]  # exactly once


async def test_two_calls_in_one_turn_each_record_their_own_fact(pool):
    """The sink is per TURN; the chat loop takes the slice appended during each
    call as that call's facts. Two calls on the same device must therefore each
    leave a record, or the second span reads as never having looked."""
    device_id, device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)
    core_pubkey = await devices.core_public_key_hex(pool)
    facts: list[dict] = []

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command" and device.verify_command(core_pubkey, frame)
        conn.feed(device.result(frame["envelope"], ok=True, output="ok", exit_code=0))

    for _ in range(2):
        ans = asyncio.create_task(answer())
        _r, ok = await tools.dispatch(
            "device_info", {"device": "laptop"}, _ctx(person, facts=facts)
        )
        await asyncio.wait_for(ans, 2)
        assert ok is True

    assert facts == [
        {"device": "laptop", "connected": True},
        {"device": "laptop", "connected": True},
    ]
    await _close(conn, task)


async def test_a_missing_facts_sink_changes_nothing(pool):
    """The channel is optional: a caller that passes none still gets the same
    refusal, and nothing raises."""
    await _enroll(pool, name="laptop")
    person = await _person(pool)

    result, ok = await tools.dispatch(
        "device_run", {"device": "laptop", "argv": ["ls"]}, _ctx(person)
    )

    assert ok is False
    assert "not connected" in result


async def test_a_device_gone_by_send_time_ends_the_facts_on_connected_false(
    pool, monkeypatch
):
    """N3: `_require_connected` determines connectivity inside `_admit`, BEFORE
    anything is sent, and never sees a socket that dies in the window between
    that check and hub.command's actual write. hub.command has its OWN re-check
    right before it sends, and with facts_sink threaded through it gets the
    last word. Simulated by patching `Hub.is_connected` to always say True
    (what `_admit` sees) while the device never actually joins `hub._conns`
    (what hub.command's own check sees) — the same shape a real mid-flight
    drop produces, without needing to win an actual race."""
    await _enroll(pool, name="laptop")  # never joins the hub
    monkeypatch.setattr(devices_ws.Hub, "is_connected", lambda self, device_id: True)
    person = await _person(pool)
    facts: list[dict] = []

    result, ok = await tools.dispatch(
        "device_info", {"device": "laptop"}, _ctx(person, facts=facts)
    )

    assert ok is False
    assert "not connected" in result and "tile is stale" in result
    # `_admit`'s stale read, then the truth.
    assert facts == [
        {"device": "laptop", "connected": True},
        {"device": "laptop", "connected": False},
    ]


async def test_the_executor_alone_still_refuses_an_unknown_device(pool):
    with pytest.raises(ToolFailure):
        await tools.REGISTRY["device_info"].executor({"device": "nobody"}, _ctx(None))


# -- the audit chain ---------------------------------------------------------


def _entry(
    seq: int,
    prev_hash: str,
    *,
    ts: int = 1756600000,
    envelope_id: str = "env-1",
    capability: str = "system.info",
    summary: str = "ok",
    ok: bool = True,
    exit_code: int | None = 0,
) -> dict:
    without = {
        "seq": seq,
        "prev_hash": prev_hash,
        "ts": ts,
        "envelope_id": envelope_id,
        "capability": capability,
        "summary": summary,
        "ok": ok,
        "exit_code": exit_code,
    }
    return {**without, "hash": devices_ws.chain_hash(prev_hash, without)}


def test_chain_hash_matches_the_committed_vector():
    # A cross-language pin: T3's Go audit chain must reproduce this exact hex for
    # this exact entry, or the two implementations have drifted.
    entry = {
        "seq": 0,
        "prev_hash": "",
        "ts": 1756600000,
        "envelope_id": "env-1",
        "capability": "system.info",
        "summary": "ok",
        "ok": True,
        "exit_code": 0,
    }
    assert (
        devices_ws.chain_hash("", entry)
        == "35e014b6f5d8a09503084e59db7b59b964fb523b49e97f92bd91f97b360c63a4"
    )


async def test_a_good_audit_batch_stores_in_order(pool):
    device_id, _device = await _enroll(pool)
    e0 = _entry(0, "")
    e1 = _entry(1, e0["hash"])
    e2 = _entry(2, e1["hash"])
    res = await devices_ws.ingest_audit(pool, device_id, [e0, e1, e2])
    assert res == {"stored": 3, "break": None}
    rows = await pool.fetch(
        "SELECT seq FROM device_audit WHERE device_id = $1 ORDER BY seq", device_id
    )
    assert [r["seq"] for r in rows] == [0, 1, 2]


async def test_a_broken_prev_hash_stops_at_the_break_and_is_a_governance_event(pool):
    device_id, _device = await _enroll(pool)
    e0 = _entry(0, "")
    e1 = _entry(1, e0["hash"])
    bad = _entry(2, "deadbeef")  # prev_hash does not join the chain
    res = await devices_ws.ingest_audit(pool, device_id, [e0, e1, bad])
    assert res == {"stored": 2, "break": 2}
    stored = await pool.fetch(
        "SELECT seq FROM device_audit WHERE device_id = $1 ORDER BY seq", device_id
    )
    assert [r["seq"] for r in stored] == [0, 1]  # nothing past the break
    events = await pool.fetch(
        "SELECT meta FROM governance_events WHERE kind = $1", governance.DEVICE_AUDIT_BREAK
    )
    assert len(events) == 1
    assert events[0]["meta"]["seq"] == 2
    assert events[0]["meta"]["got_prev"] == "deadbeef"


async def test_a_tampered_entry_breaks_even_with_a_right_prev_hash(pool):
    device_id, _device = await _enroll(pool)
    e0 = _entry(0, "")
    tampered = _entry(1, e0["hash"])
    tampered["summary"] = "rewritten after the hash was taken"
    res = await devices_ws.ingest_audit(pool, device_id, [e0, tampered])
    assert res == {"stored": 1, "break": 1}
    events = await pool.fetch(
        "SELECT meta FROM governance_events WHERE kind = $1", governance.DEVICE_AUDIT_BREAK
    )
    assert len(events) == 1


async def test_replaying_stored_entries_is_idempotent(pool):
    device_id, _device = await _enroll(pool)
    e0 = _entry(0, "")
    e1 = _entry(1, e0["hash"])
    await devices_ws.ingest_audit(pool, device_id, [e0, e1])
    res = await devices_ws.ingest_audit(pool, device_id, [e0, e1])  # a full replay
    assert res == {"stored": 2, "break": None}
    count = await pool.fetchval(
        "SELECT count(*) FROM device_audit WHERE device_id = $1", device_id
    )
    assert count == 2  # ON CONFLICT DO NOTHING — no duplicates
