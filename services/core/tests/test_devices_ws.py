"""The device socket, the hub, the audit chain, and the nine tools on the funnel.

Every property slice 5's rails name is pinned here, and none by reading prose:
the challenge authenticates (a bad signature is closed 4401, a revoked device is
refused at the challenge), a command is answered only by the device's own result
frame (a silent device is a stated timeout), a DENY leaves ZERO frames on the
wire (the "Activity proves nothing ran" bar, on a second machine), the
per-device grant and fs-root checks refuse before the wire, revoke kills the
live socket, and a broken audit chain is a loud governance event that stores
nothing past the break.

The fake WS conn (tests/device_fakes.py) makes all of this testable with no
socket; T5 grows it into the full fake device.
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
) -> tuple[uuid.UUID, FakeDevice]:
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
    return device_id, device


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


def _ctx(person: Person | None, *, conversation_id=None, sink=None) -> ToolContext:
    return ToolContext(
        app=None,
        person=person,
        workspace_root=Path("/tmp"),
        conversation_id=conversation_id,
        consent_sink=sink,
    )


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


# -- the auth frame's optional home_dir ---------------------------------------


async def _auth(pool, device_id, device, extra: dict) -> tuple[FakeWSConn, asyncio.Task, dict]:
    """Drive serve() through the challenge with an auth frame carrying `extra`
    keys; return the conn, the serve task and the frame core answered with."""
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    challenge = await asyncio.wait_for(conn.next_sent(), 2)
    conn.feed(
        {
            "type": "auth",
            "device_id": str(device_id),
            "sig": device.sign_nonce(challenge["nonce"]),
            **extra,
        }
    )
    reply = await asyncio.wait_for(conn.next_sent(), 2)
    return conn, task, reply


async def _stored_home(pool, device_id) -> str | None:
    return await pool.fetchval("SELECT home_dir FROM devices WHERE id = $1", device_id)


async def test_a_successful_auth_records_the_home_dir_the_device_reports(pool):
    """An already-enrolled device (no home_dir on its row) reports one in its
    auth frame — an ADDITIVE optional key — and core stores it on the row, so
    the grants editor can suggest it without a re-pair."""
    device_id, device = await _enroll(pool)
    assert await _stored_home(pool, device_id) is None
    conn, task, reply = await _auth(pool, device_id, device, {"home_dir": "/home/jeremy"})
    assert reply["type"] == "ready"
    assert await _stored_home(pool, device_id) == "/home/jeremy"
    await _close(conn, task)


async def test_an_auth_frame_without_a_home_dir_leaves_the_stored_one_alone(pool):
    device_id, device = await _enroll(pool)
    await devices.record_home_dir(pool, device_id, "/home/jeremy")
    conn, task, reply = await _auth(pool, device_id, device, {})
    assert reply["type"] == "ready"
    assert await _stored_home(pool, device_id) == "/home/jeremy"
    await _close(conn, task)


async def test_a_junk_home_dir_on_auth_is_ignored_and_auth_still_succeeds(pool):
    """A daemon that cannot name its home is still a paired machine: junk is
    dropped, never stored, and never a reason to refuse the socket."""
    device_id, device = await _enroll(pool)
    conn, task, reply = await _auth(pool, device_id, device, {"home_dir": "relative"})
    assert reply["type"] == "ready"
    assert await _stored_home(pool, device_id) is None
    await _close(conn, task)


async def test_a_failed_auth_records_no_home_dir(pool):
    """The home_dir is stored only AFTER the challenge verifies — an
    unauthenticated frame must not write anything onto a device row."""
    device_id, _device = await _enroll(pool)
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    await asyncio.wait_for(conn.next_sent(), 2)  # the challenge
    conn.feed(
        {"type": "auth", "device_id": str(device_id), "sig": "00" * 64, "home_dir": "/home/mallory"}
    )
    reply = await asyncio.wait_for(conn.next_sent(), 2)
    assert reply["type"] == "auth_error"
    await asyncio.wait_for(task, 2)
    assert await _stored_home(pool, device_id) is None


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
    device_id, device, conn, task = await _connect(pool, capabilities=["system.info"])
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
    device_id, _device, conn, task = await _connect(pool, capabilities=["system.info"])
    with pytest.raises(devices.DeviceRefused) as exc:
        await devices_ws.hub.command(
            pool, device_id=device_id, name="laptop", capability="system.info", args={}, timeout=0.1
        )
    assert "did not answer" in exc.value.reason
    await _close(conn, task)


async def test_a_command_to_a_disconnected_device_is_refused(pool):
    device_id, _device = await _enroll(pool, capabilities=["system.info"])  # never joins the hub
    with pytest.raises(devices.DeviceRefused) as exc:
        await devices_ws.hub.command(
            pool, device_id=device_id, name="laptop", capability="system.info", args={}, timeout=1
        )
    assert "not connected" in exc.value.reason


async def test_a_command_to_a_revoked_device_is_refused(pool):
    device_id, _device = await _enroll(pool, capabilities=["system.info"])
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


# -- the funnel: a DENY leaves zero frames -----------------------------------


async def test_a_consent_gated_device_run_leaves_zero_frames_on_the_wire(pool):
    device_id, _device = await _enroll(pool, name="laptop", capabilities=["shell.exec"])
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)  # the device IS connected...
    person = await _person(pool)
    conv = await _conversation(pool, person)
    sink: list[dict] = []
    result, ok = await tools.dispatch(
        "device_run",
        {"device": "laptop", "argv": ["rm", "-rf", "/tmp/x"]},
        _ctx(person, conversation_id=conv, sink=sink),
    )
    assert ok is False
    assert result.startswith("Awaiting your approval")  # gated, not run
    assert conn.sent == []  # ...and NOTHING crossed the wire — the kernel refused first
    assert len(sink) == 1 and sink[0]["action_class"] == "device_run"


async def test_an_approved_device_run_reaches_the_wire_and_burns(pool):
    from app import consents

    device_id, device, conn, task = await _connect(pool, name="laptop", capabilities=["shell.exec"])
    person = await _person(pool)
    args = {"device": "laptop", "argv": ["echo", "hi"]}
    card = await consents.raise_consent(
        pool,
        action_class="device_run",
        args=args,
        summary="run echo",
        person_id=person.id,
        agent="chat",
        conversation_id=None,
    )
    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )

    core_pubkey = await devices.core_public_key_hex(pool)

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command" and frame["envelope"]["capability"] == "shell.exec"
        assert device.verify_command(core_pubkey, frame)
        conn.feed(device.result(frame["envelope"], ok=True, output="hi", exit_code=0))

    ans = asyncio.create_task(answer())
    result, ok = await tools.dispatch("device_run", args, _ctx(person))
    await asyncio.wait_for(ans, 2)
    assert ok is True
    assert "exit 0" in result and "hi" in result
    await _close(conn, task)


# -- the per-device grant and fs checks refuse before the wire ---------------


async def test_a_capability_not_granted_is_refused_naming_settings(pool):
    device_id, _device = await _enroll(pool, name="laptop", capabilities=["system.info"])
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_read_file", {"device": "laptop", "path": "/home/x"}, _ctx(person)
    )
    assert ok is False
    assert result.startswith("Error: ")
    assert "fs.read" in result and "Settings" in result
    assert conn.sent == []  # the grant check fired before hub.command


async def test_an_fs_path_outside_the_granted_roots_is_refused(pool):
    device_id, _device = await _enroll(
        pool, name="laptop", capabilities=["fs.read"], fs_roots=["/home/jeremy"]
    )
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_read_file", {"device": "laptop", "path": "/etc/passwd"}, _ctx(person)
    )
    assert ok is False
    assert "outside the roots" in result
    assert conn.sent == []


async def test_a_dotdot_path_escaping_the_root_is_refused(pool):
    # normpath collapses the ".." to /etc/shadow, which is not under the granted
    # root — this reddens if a refactor ever prefix-checks the raw string.
    device_id, _device = await _enroll(
        pool, name="laptop", capabilities=["fs.read"], fs_roots=["/home/jeremy"]
    )
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_read_file",
        {"device": "laptop", "path": "/home/jeremy/../../etc/shadow"},
        _ctx(person),
    )
    assert ok is False
    assert "outside the roots" in result
    assert conn.sent == []  # never reached the wire


async def test_a_sibling_prefix_path_is_not_treated_as_inside_the_root(pool):
    # The classic prefix trap: /home/jeremy-evil is NOT under /home/jeremy, even
    # though the latter is a string prefix of the former. The "/" boundary in the
    # check is what refuses it.
    device_id, _device = await _enroll(
        pool, name="laptop", capabilities=["fs.read"], fs_roots=["/home/jeremy"]
    )
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_read_file", {"device": "laptop", "path": "/home/jeremy-evil/x"}, _ctx(person)
    )
    assert ok is False
    assert "outside the roots" in result
    assert conn.sent == []


async def test_the_exact_root_and_a_legitimate_child_reach_the_wire(pool):
    # The other half of the prefix check: it must not OVER-refuse. The exact root
    # and a real child both pass, and the normalized path is what crosses.
    device_id, device, conn, task = await _connect(
        pool, name="laptop", capabilities=["fs.list"], fs_roots=["/home/jeremy"]
    )
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

    # A child given with a redundant "." segment proves normpath ran on the
    # allowed path too, not only the refused ones.
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

    device_id, _device = await _enroll(
        pool, name="laptop", capabilities=["fs.write"], fs_roots=["/home/jeremy"]
    )
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

    device_id, device, conn, task = await _connect(
        pool, name="laptop", capabilities=["fs.write"], fs_roots=["/home/jeremy"]
    )
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

    device_id, _device = await _enroll(pool, name="laptop", capabilities=["system.notify"])
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

    device_id, _device = await _enroll(pool, name="laptop", capabilities=["system.info"])
    devices_ws.hub.register(device_id, _DeadConn())
    person = await _person(pool)
    result, ok = await tools.dispatch("device_info", {"device": "laptop"}, _ctx(person))
    assert ok is False
    assert "not connected" in result and "tile is stale" in result
    assert "unexpectedly" not in result  # a stated refusal, not a leaked exception


async def test_a_disconnected_device_tool_is_a_stated_failure(pool):
    await _enroll(pool, name="laptop", capabilities=["system.info"])  # paired, not connected
    person = await _person(pool)
    result, ok = await tools.dispatch("device_info", {"device": "laptop"}, _ctx(person))
    assert ok is False
    assert "not connected" in result


async def test_a_tool_for_a_revoked_device_is_refused_by_name(pool):
    device_id, _device = await _enroll(pool, name="laptop", capabilities=["system.info"])
    await devices.revoke(pool, device_id=device_id, actor="tester")
    person = await _person(pool)
    result, ok = await tools.dispatch("device_info", {"device": "laptop"}, _ctx(person))
    assert ok is False
    assert "no paired device named 'laptop'" in result


async def test_a_device_reporting_failure_is_not_dressed_as_success(pool):
    device_id, device, conn, task = await _connect(
        pool, name="laptop", capabilities=["system.info"]
    )
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


# -- authorize precedes the executor, for a device tool ----------------------


async def test_authorize_precedes_the_executor_for_device_tools(pool):
    # An auto device tool still passes THROUGH the kernel: monkeypatching the
    # authorizer to deny stops device_info before it ever resolves the device.
    from app import policy

    device_id, _device = await _enroll(pool, name="laptop", capabilities=["system.info"])
    conn = FakeWSConn()
    devices_ws.hub.register(device_id, conn)
    person = await _person(pool)

    async def deny(ctx, action_class, args):
        return policy.Decision(outcome=policy.DENY, reason="kernel said no")

    import unittest.mock as mock

    with mock.patch.object(policy, "authorize", deny):
        result, ok = await tools.dispatch("device_info", {"device": "laptop"}, _ctx(person))
    assert ok is False
    assert "kernel said no" in result
    assert conn.sent == []  # the executor never ran


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
