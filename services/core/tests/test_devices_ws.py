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
import json
import re
import time
import uuid
from pathlib import Path

import asyncpg
import pytest

from app import devices, devices_ws, envelopes, governance, machines, tools
from app.identity import Person
from app.tools import devices as device_tools
from app.tools.base import ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn
from tests.test_device_facts import PROBED

pytestmark = requires_db


@pytest.fixture(autouse=True)
def _clean_hub():
    # The hub is a process-global singleton (like the db pool); reset its live
    # registry around every test so one test's sockets never leak into the next.
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    devices_ws.hub._last_command.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    devices_ws.hub._last_command.clear()


# -- helpers -----------------------------------------------------------------


async def _person(pool, role: str = "adult") -> Person:
    # role 'adult' (not 'owner') so a test can make several people — the
    # people_one_owner partial unique index allows exactly one owner.
    #
    # And a DISTINCT NAME per person, which the name is now required to be
    # (migration 031): the name is the login identifier, and `login` reads
    # `WHERE name = $1` and takes one row, so two people sharing one made
    # sign-in ambiguous. This helper named everybody after their role, so
    # "several people" were all called 'adult' — which is what the index
    # caught the day it landed.
    name = f"{role}-{uuid.uuid4().hex[:8]}"
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", name, role
    )
    return Person(id=pid, name=name, role=role)


async def _enroll(
    pool, *, name: str = "laptop", platform: str = "linux"
) -> tuple[uuid.UUID, FakeDevice]:
    device = FakeDevice()
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id)
    result = await devices.enroll(
        pool,
        code=code["code"],
        pubkey=device.pubkey_hex,
        name=name,
        platform=platform,
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
    # Fix round 1: pinned exactly — a live row's bad signature carries no
    # proof and no sig, unlike a revoked row's auth_error.
    assert err == {"type": "auth_error", "reason": "the challenge signature did not verify"}
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


# -- S42b: what was sent, how many are in flight, when the hub last sent -----


async def test_every_refusal_before_the_send_is_not_sent_and_a_timeout_is_not(pool):
    """An update reads the difference (agent_updates): a command that never
    reached the socket did nothing; one sent and left unanswered may have."""

    class _DeadConn(FakeWSConn):
        async def send(self, frame: dict) -> None:
            raise ConnectionResetError("socket went away mid-write")

    offline_id, _device = await _enroll(pool, name="offline")  # never joins the hub
    revoked_id, _device = await _enroll(pool, name="revoked")
    devices_ws.hub.register(revoked_id, FakeWSConn())
    await devices.revoke(pool, device_id=revoked_id, actor="tester")
    dead_id, _device = await _enroll(pool, name="dead")
    devices_ws.hub.register(dead_id, _DeadConn())
    for device_id, name in ((offline_id, "offline"), (revoked_id, "revoked"), (dead_id, "dead")):
        with pytest.raises(devices_ws.NotSent):
            await devices_ws.hub.command(
                pool, device_id=device_id, name=name, capability="system.info", args={}, timeout=1
            )
    device_id, _device, conn, task = await _connect(pool, name="silent")
    with pytest.raises(devices.DeviceRefused) as exc:
        await devices_ws.hub.command(
            pool, device_id=device_id, name="silent", capability="system.info", args={}, timeout=0.1
        )
    assert not isinstance(exc.value, devices_ws.NotSent) and "did not answer" in exc.value.reason
    await _close(conn, task)


async def test_a_command_prepared_for_an_agent_a_repair_replaced_is_never_sent(pool):
    """`epoch` names the agent a command was prepared for: after a re-pair the
    new key's socket never receives it, while a command for the new epoch
    still goes out."""
    device_id, _old, conn, task = await _connect(pool, name="pc")
    await devices_ws.hub.disconnect(device_id, "re-paired")
    await asyncio.wait_for(task, 2)
    new = FakeDevice()
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    await devices.enroll(
        pool,
        code=code["code"],
        pubkey=new.pubkey_hex,
        name="ignored",
        platform="linux",
        hostname="h",
    )
    new.device_id = str(device_id)
    conn2 = FakeWSConn()
    task2 = asyncio.create_task(devices_ws.serve(conn2, pool))
    assert (await asyncio.wait_for(new.handshake(conn2), 2))["type"] == "ready"
    with pytest.raises(devices_ws.NotSent, match="re-paired"):
        await devices_ws.hub.command(
            pool,
            device_id=device_id,
            name="pc",
            capability="system.info",
            args={},
            timeout=1,
            epoch=0,
        )
    assert _command_frames(conn2) == []
    pending = asyncio.create_task(
        devices_ws.hub.command(
            pool,
            device_id=device_id,
            name="pc",
            capability="system.info",
            args={},
            timeout=2,
            epoch=1,
        )
    )
    frame = await new.answer_command(conn2)
    assert frame["envelope"]["capability"] == "system.info"
    assert (await asyncio.wait_for(pending, 2))["ok"] is True
    await _close(conn2, task2)


async def test_the_hub_counts_what_is_in_flight_and_when_it_last_sent(pool):
    device_id, device, conn, task = await _connect(pool, name="pc")
    assert devices_ws.hub.in_flight(device_id) == 0
    assert devices_ws.hub.idle(device_id, 300)  # nothing ever sent
    pending = asyncio.create_task(
        devices_ws.hub.command(
            pool, device_id=device_id, name="pc", capability="system.info", args={}, timeout=2
        )
    )
    frame = await asyncio.wait_for(conn.next_sent(), 2)
    assert devices_ws.hub.in_flight(device_id) == 1
    assert not devices_ws.hub.idle(device_id, 0)  # one in flight
    conn.feed(device.result(frame["envelope"]))
    assert (await asyncio.wait_for(pending, 2))["ok"] is True
    assert devices_ws.hub.in_flight(device_id) == 0
    assert not devices_ws.hub.idle(device_id, 300)  # one sent within the quiet window
    assert devices_ws.hub.idle(device_id, 0)
    await _close(conn, task)
    assert not devices_ws.hub.idle(device_id, 0)  # no socket


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
    # Pin moved (Task 21): device_info asks for a fresh look (facts.refresh)
    # before system.info, so the device's failure is system.info's answer —
    # the second command. A refresh that fails is said in device_info's own
    # last line, never dressed as a look (test_device_info_says_the_agent_
    # could_not_look_again_in_its_own_words).
    device_id, device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)

    async def answer():
        refresh = await asyncio.wait_for(conn.next_sent(), 2)
        assert refresh["envelope"]["capability"] == "facts.refresh"
        conn.feed(device.result(refresh["envelope"], output="facts sent"))
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
    # Pin moved (Task 21): device_info sends two commands now — facts.refresh,
    # then system.info — and still records its one determination once.
    for capability, output in (
        ("facts.refresh", "facts sent"),
        ("system.info", "disk: 431 GiB free"),
    ):
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command" and frame["envelope"]["capability"] == capability
        envelope_id = frame["envelope"]["envelope_id"]
        devices_ws.hub.resolve(
            device_id,
            envelope_id,
            {
                "type": "result",
                "envelope_id": envelope_id,
                "ok": True,
                "output": output,
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
        # Pin moved (Task 21): each device_info is two commands — the refresh,
        # then system.info.
        for _ in range(2):
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


async def test_a_device_gone_by_send_time_ends_the_facts_on_connected_false(pool, monkeypatch):
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
    count = await pool.fetchval("SELECT count(*) FROM device_audit WHERE device_id = $1", device_id)
    assert count == 2  # ON CONFLICT DO NOTHING — no duplicates


# -- Fix round 2: a poison audit entry must never take the socket down ------
#
# The live bug: novad on Windows sent exit_code 0x80070005 (2147942405),
# which does not fit device_audit.exit_code's old int4 — asyncpg's DataError
# on the INSERT escaped ingest_audit, escaped _handle_frame, and killed the
# socket. The agent's backoff resets after any authenticated session, so it
# reconnected in about a second, replayed the same poison entry, and hit the
# same DataError again — a permanent crash-reconnect-crash loop.
#
# Migration 037 widens the column, so the real value no longer triggers
# postgres at all (proven below with no monkeypatch — the actual bug, fixed).
# The try/except is the belt-and-suspenders half, proven by an INJECTED
# DataError exactly like the facts-frame tests below: it protects against
# whatever postgres refuses NEXT, not just this one value.


async def test_a_data_error_on_insert_stops_the_batch_and_does_not_claim_the_entry(
    pool, monkeypatch
):
    """A postgres refusal on the INSERT must stop ingestion AT that entry —
    not skip it and carry on (e2 is never attempted), and not claim it as
    stored (only e0's seq lands). This is deliberately NOT a chain break: the
    hash still verified and nothing was tampered with, so no
    DEVICE_AUDIT_BREAK governance event is written for what is a storage
    failure, not a tamper detection."""
    device_id, _device = await _enroll(pool)
    e0 = _entry(0, "")
    e1 = _entry(1, e0["hash"])
    e2 = _entry(2, e1["hash"])
    real_execute = type(pool).execute

    async def _boom(self, query, *args, **kwargs):
        if "INSERT INTO device_audit" in query and args[1] == 1:
            raise asyncpg.DataError("simulated: postgres refused this value")
        return await real_execute(self, query, *args, **kwargs)

    monkeypatch.setattr(type(pool), "execute", _boom)
    res = await devices_ws.ingest_audit(pool, device_id, [e0, e1, e2])
    assert res == {"stored": 1, "break": 1}
    rows = await pool.fetch(
        "SELECT seq FROM device_audit WHERE device_id = $1 ORDER BY seq", device_id
    )
    assert [r["seq"] for r in rows] == [0]  # e1 not stored, e2 never attempted
    events = await pool.fetch(
        "SELECT meta FROM governance_events WHERE kind = $1", governance.DEVICE_AUDIT_BREAK
    )
    assert events == []  # not a tamper detection — no chain-break event


async def test_an_injected_data_error_on_audit_insert_never_takes_the_socket_down(
    pool, monkeypatch
):
    """Same belt-and-suspenders shape as the facts-frame DataError tests
    below: whatever postgres refuses on the INSERT, the frame loop must
    survive it and keep serving later frames, exactly the property missing
    live — a heartbeat fed right after the poison entry proves serve()'s
    loop is still alive to process it."""
    device_id, _device, conn, task = await _connect(pool, name="pc")
    real_execute = type(pool).execute

    async def _boom(self, query, *args, **kwargs):
        if "INSERT INTO device_audit" in query:
            raise asyncpg.DataError("simulated: postgres refused this value")
        return await real_execute(self, query, *args, **kwargs)

    monkeypatch.setattr(type(pool), "execute", _boom)
    conn.feed({"type": "audit", "entries": [_entry(0, "")]})
    conn.feed({"type": "heartbeat", "ts": int(time.time())})

    async def heartbeat_landed():
        seen = await pool.fetchval("SELECT last_seen FROM devices WHERE id = $1", device_id)
        return seen is not None

    await _until(heartbeat_landed)
    assert devices_ws.hub.is_connected(device_id)
    count = await pool.fetchval("SELECT count(*) FROM device_audit WHERE device_id = $1", device_id)
    assert count == 0  # the poisoned entry was never stored
    await _close(conn, task)


async def test_a_windows_exit_code_over_int32_range_is_stored_after_the_migration(pool):
    """The actual bug, fixed, with no monkeypatch: novad sent 0x80070005
    (2147942405) as exit_code — migration 037 widened the column, so this is
    now an ordinary value that stores and reads back exactly. P27 (Task 13)
    extends this pin with the top of the uint32 DWORD range a Windows exit
    code can ever carry, 0xFFFFFFFF, stored right beside it."""
    device_id, _device = await _enroll(pool, name="dell", platform="windows")
    e0 = _entry(0, "", exit_code=0x80070005)
    e1 = _entry(1, e0["hash"], exit_code=0xFFFFFFFF)
    res = await devices_ws.ingest_audit(pool, device_id, [e0, e1])
    assert res == {"stored": 2, "break": None}
    rows = await pool.fetch(
        "SELECT exit_code FROM device_audit WHERE device_id = $1 ORDER BY seq", device_id
    )
    assert [r["exit_code"] for r in rows] == [0x80070005, 0xFFFFFFFF]


# -- S42a: facts on the socket ------------------------------------------------

AUTH_FACTS = {
    "v": 2,
    "agent": {"version": "0.2.0", "mode": "foreground", "session_interactive": True},
    "os": {
        "goos": "windows",
        "arch": "amd64",
        "version": "Windows 11 Pro 24H2 (build 26100)",
        "wsl": None,
    },
    "hostname": "PC-ONE",
    "machine_uid": "c" * 64,
}


async def _facts_of(pool, device_id):
    return await pool.fetchrow("SELECT facts, facts_at FROM devices WHERE id = $1", device_id)


async def _auth_with(
    pool, device_id, device: FakeDevice, facts: dict | None, *, key: FakeDevice | None = None
) -> tuple[FakeWSConn, asyncio.Task, dict]:
    """Drive one connection through serve()'s challenge/auth/reply using
    `FakeDevice.handshake`, so the exchange is written exactly once and every
    test below walks the same real path `_connect` does.

    `key`, when given, signs as a DIFFERENT device — its own key — while
    claiming `device_id`: the shape of a bad signature (the right id, the
    wrong key), produced by pointing that fake's own `device_id` at the real
    target rather than re-implementing a second signing path to keep honest
    against `handshake`."""
    signer = key or device
    signer.device_id = str(device_id)
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    reply = await asyncio.wait_for(signer.handshake(conn, facts), 2)
    return conn, task, reply


async def test_auth_facts_are_recorded_after_the_signature_verifies(pool):
    device_id, device = await _enroll(pool, name="pc", platform="windows")
    conn, task, reply = await _auth_with(pool, device_id, device, AUTH_FACTS)
    assert reply["type"] == "ready"
    row = await _facts_of(pool, device_id)
    assert row["facts"] == AUTH_FACTS and row["facts_at"] is not None
    await _close(conn, task)


async def test_the_gateway_plant_reads_agents_from_the_rows_and_the_hub(pool):
    device_id, device = await _enroll(pool, name="pc", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    views = await machines.GatewayPlant().agents(None)
    [pc] = [v for v in views if v["name"] == "pc"]
    assert pc["connected"] is True and pc["os"] == "Windows 11 Pro 24H2 (build 26100)"
    assert pc["machine"] == "c" * 64 and pc["roles"]["hands"]["state"] == "available"
    await _close(conn, task)


async def test_each_devices_last_update_rides_the_one_lateral_join(pool):
    """Task 16 fix round 1, I3: devices.list_devices and
    machines.GatewayPlant.agents both read devices.rows_with_last_update —
    one source, never duplicated — actually run here against a real
    agent_updates row (nothing had before). One device has an older
    DECIDED row and a newer SENT one; the newer one is what rides along.
    The other device has no rows at all."""
    updated_id, _ = await _enroll(pool, name="updated")
    await _enroll(pool, name="quiet")  # the second device: enrolled, never updated
    older, newer = "a" * 12, "b" * 12
    sha = "c" * 64
    await pool.execute(
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by, "
        "sent_at, outcome, outcome_at, reason) VALUES "
        "($1, $2, $3, 'capability', 'owner', now() - interval '1 hour', 'confirmed', "
        "now() - interval '50 minutes', 'ok')",
        updated_id,
        older,
        sha,
    )
    await pool.execute(
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by, sent_at) "
        "VALUES ($1, $2, $3, 'capability', 'owner', now())",
        updated_id,
        newer,
        sha,
    )
    sent_at = await pool.fetchval(
        "SELECT sent_at FROM agent_updates WHERE device_id = $1 AND version = $2",
        updated_id,
        newer,
    )

    specs = await devices.list_devices(pool)
    assert len(specs) == 2
    by_name = {s["name"]: s for s in specs}
    last = by_name["updated"]["last_update"]
    assert last["version"] == newer and last["outcome"] == "sent"
    assert last["at"] == sent_at.isoformat()
    assert by_name["quiet"]["last_update"] is None

    views = await machines.GatewayPlant().agents(None)
    by_name_view = {v["name"]: v for v in views}
    assert by_name_view["updated"]["last_update"] == last
    assert by_name_view["quiet"]["last_update"] is None


async def test_a_bad_signature_records_no_facts(pool):
    device_id, device = await _enroll(pool, name="pc")
    conn, task, reply = await _auth_with(pool, device_id, device, AUTH_FACTS, key=FakeDevice())
    # Fix round 1: pinned exactly — a live row's bad signature carries no
    # proof and no sig, unlike a revoked row's auth_error.
    assert reply == {"type": "auth_error", "reason": "the challenge signature did not verify"}
    assert (await _facts_of(pool, device_id))["facts"] is None
    await asyncio.wait_for(task, 2)


async def test_facts_that_do_not_validate_never_refuse_the_socket(pool):
    device_id, device = await _enroll(pool, name="pc")
    conn, task, reply = await _auth_with(pool, device_id, device, {"v": 1})
    assert reply["type"] == "ready"
    assert (await _facts_of(pool, device_id))["facts"] is None
    await _close(conn, task)


async def _until(predicate, within: float = 2.0):
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        if await predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met in time")


async def test_a_facts_frame_merges_and_a_new_connection_replaces(pool):
    device_id, device = await _enroll(pool, name="pc", platform="windows")
    conn, task, _ready = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed(
        {"type": "facts", "net": {"ifaces": []}, "unreadable": [{"item": "x", "reason": "y"}]}
    )

    async def merged():
        facts = (await _facts_of(pool, device_id))["facts"]
        return facts is not None and "net" in facts

    await _until(merged)
    facts = (await _facts_of(pool, device_id))["facts"]
    assert facts["machine_uid"] == "c" * 64  # the auth facts survived the merge
    await _close(conn, task)
    renamed = {**AUTH_FACTS, "hostname": "PC-ONE-RENAMED"}
    conn2, task2, _ = await _auth_with(pool, device_id, device, renamed)
    assert (await _facts_of(pool, device_id))[
        "facts"
    ] == renamed  # net is gone until the next frame
    await _close(conn2, task2)


async def test_a_revoked_device_is_told_revoked_and_an_unknown_one_is_not(pool):
    """P5 + the Task 9 security ruling: a revoked row gets `REVOKED_REASON`
    paired with a proof CORE ITSELF signed — {kind, v, device_id, nonce} over
    the nonce THIS connection's own challenge carried — so the agent
    (wire.VerifyRevokedProof) can tell a genuine revoke from anyone who can
    merely terminate the socket. An unknown id gets a different reason and no
    proof at all: core must never sign a proof for a device it does not know,
    or a restored database that forgot a device would make it wipe itself."""
    device_id, device = await _enroll(pool, name="pc")
    person = await _person(pool)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    core_pubkey_hex = await devices.core_public_key_hex(pool)

    conn, task, reply = await _auth_with(pool, device_id, device, None)
    assert set(reply) == {"type", "reason", "proof", "sig"}
    assert reply["type"] == "auth_error"
    assert reply["reason"] == devices_ws.REVOKED_REASON
    challenge_nonce = conn.sent[0]["nonce"]  # this connection's own challenge, nothing else's
    assert reply["proof"] == {
        "kind": "revoked",
        "v": 1,
        "device_id": str(device_id),
        "nonce": challenge_nonce,
    }
    assert envelopes.verify(core_pubkey_hex, reply["proof"], reply["sig"]) is True
    await asyncio.wait_for(task, 2)

    conn2, task2, reply2 = await _auth_with(pool, uuid.uuid4(), device, None)
    assert reply2 == {"type": "auth_error", "reason": devices_ws.UNKNOWN_DEVICE_REASON}
    assert devices_ws.UNKNOWN_DEVICE_REASON != devices_ws.REVOKED_REASON
    await asyncio.wait_for(task2, 2)


async def test_device_list_names_the_os_and_says_inside_wsl(pool):
    device_id, device = await _enroll(pool, name="pc-wsl")
    wsl = {
        **AUTH_FACTS,
        "os": {
            "goos": "linux",
            "arch": "amd64",
            "version": "Ubuntu 26.04 LTS",
            "wsl": {"distro": "Ubuntu-26.04"},
        },
    }
    conn, task, _ = await _auth_with(pool, device_id, device, wsl)
    person = await _person(pool)
    result, ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert ok is True
    # S42a: device_list now shares device_facts.place() with _describe_agent,
    # which also names the distro rather than just "inside WSL".
    assert "- pc-wsl (Ubuntu 26.04 LTS, inside WSL Ubuntu-26.04) — connected" in result
    await _close(conn, task)


# -- Fix round 1: malformed facts must never take the socket down -----------
#
# device_facts._text/_encoded_size now refuse a NUL byte and a lone UTF-16
# surrogate as FactsRejected (tested directly in test_device_facts.py); these
# prove the SOCKET path stays up when a device sends one, exactly like any
# other FactsRejected shape.


async def test_auth_facts_with_a_nul_byte_still_get_ready_and_record_nothing(pool):
    device_id, device = await _enroll(pool, name="pc")
    bad = {**AUTH_FACTS, "os": {**AUTH_FACTS["os"], "version": "Windows 11 Pro\x00"}}
    conn, task, reply = await _auth_with(pool, device_id, device, bad)
    assert reply["type"] == "ready"
    assert (await _facts_of(pool, device_id))["facts"] is None
    await _close(conn, task)


async def test_auth_facts_with_a_lone_surrogate_still_get_ready_and_record_nothing(pool):
    device_id, device = await _enroll(pool, name="pc")
    bad = {**AUTH_FACTS, "hostname": "PC-ONE\ud800"}
    conn, task, reply = await _auth_with(pool, device_id, device, bad)
    assert reply["type"] == "ready"
    assert (await _facts_of(pool, device_id))["facts"] is None
    await _close(conn, task)


async def test_a_facts_frame_with_a_nul_byte_leaves_the_device_connected_and_records_nothing(
    pool,
):
    """device_facts.validate_frame now refuses the NUL byte itself
    (FactsRejected, from _net's _text call), so this no longer even
    reaches postgres — but the OBSERVABLE property is the same one that was
    broken: the socket stays up and nothing is recorded. A heartbeat fed
    right after the bad frame proves serve()'s loop is still alive to process
    it (before either fix, this and the DataError-injection tests below both
    hung this same way: the agent resets its backoff after any authenticated
    session and resends facts immediately, so the crash-reconnect-crash loop
    was ~1s).

    The NUL byte rides in `net.ifaces[].name`, not `unreadable[].item` as it
    used to: the Task 16b review moved a malformed `unreadable` ENTRY to
    drop just that entry rather than reject the whole frame (see
    test_a_malformed_unreadable_entrys_nul_byte_still_lets_the_rest_of_the_
    frame_record, below), so a NUL byte there no longer demonstrates this
    property — `net`'s validator is untouched and still rejects the whole
    frame, which is what this test is about."""
    device_id, device, conn, task = await _connect(pool, name="pc")
    conn.feed(
        {
            "type": "facts",
            "net": {"ifaces": [{"name": "eth0\x00", "mac": "", "ipv4_cidr": [], "up": True}]},
        }
    )
    conn.feed({"type": "heartbeat", "ts": int(time.time())})

    async def heartbeat_landed():
        seen = await pool.fetchval("SELECT last_seen FROM devices WHERE id = $1", device_id)
        return seen is not None

    await _until(heartbeat_landed)
    assert devices_ws.hub.is_connected(device_id)
    assert (await _facts_of(pool, device_id))["facts"] is None
    await _close(conn, task)


async def test_a_malformed_unreadable_entrys_nul_byte_still_lets_the_rest_of_the_frame_record(
    pool,
):
    """Task 16b review, the opposite of the test above: one malformed
    unreadable entry is dropped on its own, so a frame that ALSO carries a
    NUL byte in `unreadable[].item` still records everything else the frame
    sent — net.ifaces, and unreadable itself, minus the one bad entry."""
    device_id, device, conn, task = await _connect(pool, name="pc")
    conn.feed(
        {
            "type": "facts",
            "net": {"ifaces": []},
            "unreadable": [{"item": "x\x00", "reason": "y"}],
        }
    )

    async def recorded():
        row = await _facts_of(pool, device_id)
        return row["facts"] is not None

    await _until(recorded)
    facts = (await _facts_of(pool, device_id))["facts"]
    assert facts["net"] == {"ifaces": []}
    assert facts["unreadable"] == []
    assert devices_ws.hub.is_connected(device_id)
    await _close(conn, task)


# device_facts now catches the two KNOWN postgres-hostile shapes before the
# write, so the belt-and-suspenders asyncpg.DataError catch in the `_record_*`
# functions themselves needs an INJECTED failure to exercise at all — proving
# the catch works for whatever postgres refuses next, not just these two.


async def test_an_injected_data_error_never_takes_the_auth_socket_down(pool, monkeypatch):
    # asyncpg.Pool.execute is a read-only INSTANCE attribute (it can only be
    # overridden on the class), so the patch targets type(pool) — reverted by
    # `monkeypatch` at teardown, and the pool fixture builds a fresh pool
    # (and thus this patch has no chance to leak) per test regardless.
    device_id, device = await _enroll(pool, name="pc")
    real_execute = type(pool).execute

    async def _boom(self, query, *args, **kwargs):
        if "SET facts = $2, facts_at = now()" in query:
            raise asyncpg.DataError("simulated: postgres refused this value")
        return await real_execute(self, query, *args, **kwargs)

    monkeypatch.setattr(type(pool), "execute", _boom)
    conn, task, reply = await _auth_with(pool, device_id, device, AUTH_FACTS)
    assert reply["type"] == "ready"
    # The catch falls through to the same fresh-truth clear as a rejection —
    # a half-written UPDATE must not leave the OLD facts silently in place.
    row = await _facts_of(pool, device_id)
    assert row["facts"] is None and row["facts_at"] is None
    await _close(conn, task)


async def test_an_injected_data_error_never_takes_a_connected_socket_down(pool, monkeypatch):
    # Pin moved (Task 21, probe freshness): the frame's write is no longer a
    # pool-level `facts || $2` UPDATE but a read-and-write in one transaction
    # on a pooled CONNECTION (device_facts.merge_frame keeps a probe as one
    # unit), so the injection targets that statement on the Connection class
    # — which a pool's own execute calls too, so the heartbeat still lands.
    device_id, device, conn, task = await _connect(pool, name="pc")
    real_execute = asyncpg.connection.Connection.execute

    async def _boom(self, query, *args, **kwargs):
        if "SET facts = $2::jsonb, facts_at = now()" in query:
            raise asyncpg.DataError("simulated: postgres refused this value")
        return await real_execute(self, query, *args, **kwargs)

    monkeypatch.setattr(asyncpg.connection.Connection, "execute", _boom)
    conn.feed({"type": "facts", "net": {"ifaces": []}, "unreadable": []})
    conn.feed({"type": "heartbeat", "ts": int(time.time())})

    async def heartbeat_landed():
        seen = await pool.fetchval("SELECT last_seen FROM devices WHERE id = $1", device_id)
        return seen is not None

    await _until(heartbeat_landed)
    assert devices_ws.hub.is_connected(device_id)
    assert (await _facts_of(pool, device_id))["facts"] is None
    await _close(conn, task)


# -- Fix round 1: stale identity facts must not survive under a fresh date --
#
# Controller ruling revising P2: a VERIFIED auth whose facts are absent or
# rejected clears facts/facts_at to NULL/NULL rather than leaving a PREVIOUS
# connection's facts in the row for the next facts frame to re-date "reported
# just now" — a misstatement exactly during an agent/core version skew.


async def test_a_reconnect_with_no_facts_clears_a_previously_stored_row(pool):
    device_id, device = await _enroll(pool, name="pc", platform="windows")
    conn, task, ready = await _auth_with(pool, device_id, device, AUTH_FACTS)
    assert ready["type"] == "ready"
    await _close(conn, task)
    assert (await _facts_of(pool, device_id))["facts"] is not None  # sanity: it was stored

    conn2, task2, reply2 = await _auth_with(pool, device_id, device, None)
    assert reply2["type"] == "ready"
    row = await _facts_of(pool, device_id)
    assert row["facts"] is None and row["facts_at"] is None
    await _close(conn2, task2)


async def test_a_reconnect_with_rejected_facts_clears_a_previously_stored_row(pool):
    device_id, device = await _enroll(pool, name="pc", platform="windows")
    conn, task, ready = await _auth_with(pool, device_id, device, AUTH_FACTS)
    assert ready["type"] == "ready"
    await _close(conn, task)
    assert (await _facts_of(pool, device_id))["facts"] is not None  # sanity: it was stored

    conn2, task2, reply2 = await _auth_with(pool, device_id, device, {"v": 1})
    assert reply2["type"] == "ready"
    row = await _facts_of(pool, device_id)
    assert row["facts"] is None and row["facts_at"] is None
    await _close(conn2, task2)


async def test_a_facts_frame_still_merges_into_a_cleared_row(pool):
    """The clear is never a reason to stop taking a facts frame's net section
    — an agent's MACs must survive for wake even without identity facts."""
    device_id, device = await _enroll(pool, name="pc", platform="windows")
    conn, task, ready1 = await _auth_with(pool, device_id, device, AUTH_FACTS)
    assert ready1["type"] == "ready"
    await _close(conn, task)

    conn2, task2, reply2 = await _auth_with(pool, device_id, device, None)  # clears the row
    assert reply2["type"] == "ready"
    assert (await _facts_of(pool, device_id))["facts"] is None  # confirmed cleared

    conn2.feed({"type": "facts", "net": {"ifaces": []}, "unreadable": []})

    async def merged():
        row = await _facts_of(pool, device_id)
        return row["facts"] is not None and "net" in row["facts"]

    await _until(merged)
    row = await _facts_of(pool, device_id)
    assert row["facts"] == {"net": {"ifaces": []}, "unreadable": []}
    await _close(conn2, task2)


# -- S42a Task 13: a path check for the device's own OS -----------------------

# Review focus 2: a Windows path however it is typed, normalized once, and the
# spellings that name no file refused before the wire.
WINDOWS_PATHS_SENT = [
    ("C:\\Users\\owner\\Desktop", "C:\\Users\\owner\\Desktop"),
    ("c:/users/owner/desktop", "c:\\users\\owner\\desktop"),
    ("C:\\Users\\owner\\..\\..\\Windows\\System32", "C:\\Windows\\System32"),
    (
        "\\\\wsl.localhost\\Ubuntu-26.04\\home\\owner",
        "\\\\wsl.localhost\\Ubuntu-26.04\\home\\owner",
    ),
    ("\\\\wsl.localhost\\Ubuntu-26.04\\..\\etc", "\\\\wsl.localhost\\Ubuntu-26.04\\etc"),
]
WINDOWS_PATHS_REFUSED = [
    ("notes.txt", "must be absolute on Windows"),
    ("\\foo", "must be absolute on Windows"),  # rooted, no drive: 3.12's ntpath.isabs says True
    ("C:foo", "must be absolute on Windows"),  # drive-relative
    ("/home/owner", "must be absolute on Windows"),  # a POSIX path on a Windows machine
    ("\\\\?\\C:\\x", "device path"),
    ("\\\\.\\PhysicalDrive0", "device path"),
]


async def test_windows_paths_are_normalized_and_device_paths_refused(pool):
    device_id, device, conn, task = await _connect(pool, name="pc", platform="windows")
    person = await _person(pool)
    for given, sent in WINDOWS_PATHS_SENT:

        async def answer(expected=sent):
            frame = await asyncio.wait_for(conn.next_sent(), 2)
            assert frame["envelope"]["args"]["path"] == expected
            conn.feed(device.result(frame["envelope"], ok=True, output="listing", exit_code=0))

        ans = asyncio.create_task(answer())
        _r, ok = await tools.dispatch(
            "device_list_files", {"device": "pc", "path": given}, _ctx(person)
        )
        await asyncio.wait_for(ans, 2)
        assert ok is True, given
    for given, words in WINDOWS_PATHS_REFUSED:
        result, ok = await tools.dispatch(
            "device_list_files", {"device": "pc", "path": given}, _ctx(person)
        )
        assert ok is False and words in result, (given, result)
    await _close(conn, task)


async def test_a_device_whose_platform_is_unknown_cannot_have_a_path_checked(pool):
    device_id, _device = await _enroll(pool, name="old-box")
    await pool.execute("UPDATE devices SET platform = 'unknown' WHERE id = $1", device_id)
    devices_ws.hub.register(device_id, FakeWSConn())
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_read_file", {"device": "old-box", "path": "/etc/hosts"}, _ctx(person)
    )
    assert ok is False and "cannot: platform unknown" in result


# -- P27: a frame core cannot handle never ends the session --------------------
#
# 2026-09-28: Windows' sudo exited 0x80070005, the audit insert overflowed an
# int4, and the exception ended the Dell agent's session — which reconnected,
# replayed the same entry, and crash-looped. The hotfix widened the column;
# these pin the class: one test per frame type.


def _chain(*overrides: dict) -> list[dict]:
    """A hash-chained audit batch from seq 0, each entry overridden as given, so
    a value core cannot store sits inside an otherwise valid chain."""
    prev, out = "", []
    for seq, over in enumerate(overrides):
        entry = {
            "seq": seq,
            "prev_hash": prev,
            "ts": 1_790_000_000,
            "envelope_id": f"e{seq}",
            "capability": "shell.exec",
            "summary": "ran, exit 0",
            "ok": True,
            "exit_code": 0,
            **over,
        }
        entry["hash"] = devices_ws.chain_hash(prev, {k: v for k, v in entry.items() if k != "hash"})
        out.append(entry)
        prev = entry["hash"]
    return out


async def _still_up(pool, conn: FakeWSConn, device_id) -> None:
    """A heartbeat after the bad frame lands: the session is still serving."""
    await pool.execute("UPDATE devices SET last_seen = NULL WHERE id = $1", device_id)
    conn.feed({"type": "heartbeat", "ts": int(time.time())})

    async def landed():
        return (
            await pool.fetchval("SELECT last_seen FROM devices WHERE id = $1", device_id)
            is not None
        )

    await _until(landed)
    assert devices_ws.hub.is_connected(device_id)


@pytest.mark.parametrize(
    "override,named",
    [
        ({"exit_code": 2**64}, "exit_code"),
        ({"ts": 10**20}, "ts"),
        ({"ok": "yes"}, "ok"),
        ({"summary": "ran\x00"}, "summary"),
        # Fix round 1 (review of 2c1fbef0): prev_hash is the field whose raw
        # value _audit_break used to echo straight into its own governance
        # event and ERROR line — these are the two shapes the reviewer's
        # probe found postgres refuses there (a NUL byte, and a value that
        # is not text at all, which a NaN float demonstrates cheaply).
        ({"prev_hash": "x\x00"}, "prev_hash"),
        ({"prev_hash": float("nan")}, "prev_hash"),
        # Fix round 2 (re-review of faabe935): a lone UTF-16 surrogate is
        # valid JSON off the wire and a valid Python str, so it passed round
        # 1's isinstance/NUL/length checks in _entry_problem untouched and
        # reached a call site round 1 did not fix. Now caught here too (the
        # same _text_problem both _entry_problem and _echoable_text share).
        ({"prev_hash": "\ud800"}, "prev_hash"),
        ({"summary": "\ud800"}, "summary"),
    ],
)
async def test_an_audit_entry_core_cannot_store_is_a_stated_break_and_the_session_stays_up(
    pool, override, named
):
    device_id, _device, conn, task = await _connect(pool, name="pc")
    conn.feed({"type": "audit", "entries": _chain({}, override)})
    await _still_up(pool, conn, device_id)
    assert (
        await pool.fetchval("SELECT count(*) FROM device_audit WHERE device_id = $1", device_id)
        == 1
    )
    event = await pool.fetchrow(
        "SELECT meta FROM governance_events WHERE kind = $1 AND subject_ref = $2",
        governance.DEVICE_AUDIT_BREAK,
        device_id,
    )
    assert event is not None and named in event["meta"]["reason"]
    await _close(conn, task)


async def test_a_mismatch_breaks_got_prev_is_never_echoed_when_it_is_a_lone_surrogate(
    pool, monkeypatch
):
    """Fix round 2, direct test of the mismatch call site specifically.

    In the real flow, _entry_problem (now fixed) catches a lone-surrogate
    prev_hash before the mismatch branch is ever reached, which is exactly
    why fix round 1's call-site fix alone did not show up as a reachable
    gap in the normal path — only the re-reviewer's reachability probe,
    which built the entry directly, found it. Monkeypatching _entry_problem
    to pass everything through isolates the mismatch branch's OWN
    _echoable_text filtering, so this test stays red if a future change
    (to _entry_problem's field list, or any other new path into this
    branch) ever revives the gap this round closes — the ruling's "no
    future path can echo" made testable on its own, not only as a
    byproduct of round 1's fix."""
    device_id, _device = await _enroll(pool, name="pc")
    monkeypatch.setattr(devices_ws, "_entry_problem", lambda entry: None)
    # Built by hand, not via _entry(): that helper computes a real
    # chain_hash over the entry, and chain_hash concatenates prev_hash as a
    # raw Python string rather than JSON-escaping it, so a raw surrogate in
    # prev_hash crashes hash construction itself — before ingest_audit ever
    # sees it. The mismatch branch returns before this entry's own "hash"
    # is ever read, so its value here is unchecked and arbitrary.
    entry = {
        "seq": 0,
        "prev_hash": "\ud800",  # seq 0: expected_prev is "", so this mismatches
        "ts": 1_790_000_000,
        "envelope_id": "e0",
        "capability": "shell.exec",
        "summary": "ran, exit 0",
        "ok": True,
        "exit_code": 0,
        "hash": "unchecked-the-mismatch-branch-returns-first",
    }
    res = await devices_ws.ingest_audit(pool, device_id, [entry])
    assert res == {"stored": 0, "break": 0}
    event = await pool.fetchrow(
        "SELECT meta FROM governance_events WHERE kind = $1 AND subject_ref = $2",
        governance.DEVICE_AUDIT_BREAK,
        device_id,
    )
    assert event is not None
    assert event["meta"]["got_prev"] is None


async def test_a_batch_with_any_malformed_seq_stores_nothing_from_it(pool):
    """The top-of-batch check rejects the WHOLE replayed batch when even one
    entry has no integer seq — never a silent per-entry filter that lets a
    good entry land while quietly dropping the bad one beside it. A stated
    break says why nothing from the batch was stored."""
    device_id, _device = await _enroll(pool, name="pc")
    e0 = _entry(0, "")
    res = await devices_ws.ingest_audit(pool, device_id, [e0, {"seq": "one"}])
    assert res == {"stored": 0, "break": None}
    count = await pool.fetchval("SELECT count(*) FROM device_audit WHERE device_id = $1", device_id)
    assert count == 0
    event = await pool.fetchrow(
        "SELECT meta FROM governance_events WHERE kind = $1 AND subject_ref = $2",
        governance.DEVICE_AUDIT_BREAK,
        device_id,
    )
    assert event is not None and "no integer seq" in event["meta"]["reason"]


# Controller ruling (2026-10-01): as written, a result frame for an envelope
# nobody is waiting on was ALREADY a no-op before this task — hub.resolve pops
# nothing for an unknown envelope_id and simply returns, so a bare "absurd
# exit_code" case never exercised anything new and was green before this
# change. This case is the one that is actually red beforehand: it makes the
# result path itself raise, the same shape test_a_facts_frame_... below uses
# on validate_frame, so the `result` frame type has one genuine proof the new
# per-frame guard (not pre-existing no-op behavior) is what keeps it up.
async def test_a_result_frame_that_cannot_be_handled_does_not_end_the_session(pool, monkeypatch):
    device_id, _device, conn, task = await _connect(pool, name="pc")

    def _boom(device_id, envelope_id, payload):
        raise RuntimeError("simulated: a fault in the result reader")

    monkeypatch.setattr(devices_ws.hub, "resolve", _boom)
    conn.feed(
        {
            "type": "result",
            "envelope_id": "nobody-waits",
            "ok": True,
            "exit_code": 0,
            "output": "",
            "error": "",
        }
    )
    await _still_up(pool, conn, device_id)
    await _close(conn, task)


async def test_a_result_frame_with_an_absurd_exit_code_does_not_end_the_session(pool):
    """A pin, not a red case — see the test above for the one that is
    actually red before this task's change. A result frame for an envelope
    nobody is awaiting was already a silent no-op for any exit_code, absurd
    or not; kept so an absurd value in THIS frame type stays covered too."""
    device_id, _device, conn, task = await _connect(pool, name="pc")
    conn.feed(
        {
            "type": "result",
            "envelope_id": "nobody-waits",
            "ok": True,
            "exit_code": 10**30,
            "output": "",
            "error": "",
        }
    )
    await _still_up(pool, conn, device_id)
    await _close(conn, task)


async def test_a_facts_frame_that_cannot_be_handled_does_not_end_the_session(pool, monkeypatch):
    device_id, _device, conn, task = await _connect(pool, name="pc")

    def _boom(frame):
        raise RuntimeError("simulated: a fault in the facts reader")

    monkeypatch.setattr(devices_ws.device_facts, "validate_frame", _boom)
    conn.feed({"type": "facts", "net": {"ifaces": []}})
    await _still_up(pool, conn, device_id)
    await _close(conn, task)


async def test_a_malformed_heartbeat_does_not_end_the_session(pool, monkeypatch):
    device_id, _device, conn, task = await _connect(pool, name="pc")
    real_execute = type(pool).execute
    failed: list[bool] = []

    async def _once(self, query, *args, **kwargs):
        if "SET last_seen = now()" in query and not failed:
            failed.append(True)
            raise asyncpg.DataError("simulated: postgres refused the heartbeat")
        return await real_execute(self, query, *args, **kwargs)

    monkeypatch.setattr(type(pool), "execute", _once)
    conn.feed({"type": "heartbeat", "ts": "not a number"})
    await _still_up(pool, conn, device_id)
    assert failed == [True]
    await _close(conn, task)


async def test_an_unreadable_frame_is_dropped_and_the_session_stays_up(pool):
    device_id, _device, conn, task = await _connect(pool, name="pc")
    conn.feed([1, 2, 3])
    conn.feed({"type": devices_ws.UNREADABLE_FRAME})
    conn.feed({"type": "audit", "entries": [{"seq": "zero"}]})
    await _still_up(pool, conn, device_id)
    await _close(conn, task)


async def test_the_adapter_turns_unparseable_json_into_one_unreadable_frame():
    class _Stub:
        def __init__(self, exc):
            self.exc = exc

        async def receive_json(self):
            raise self.exc

    for exc in (json.JSONDecodeError("bad", "{", 0), RecursionError(), KeyError("text")):
        assert await devices_ws.WebSocketConn(_Stub(exc)).receive() == {
            "type": devices_ws.UNREADABLE_FRAME
        }


# -- S42b: the door (P15) and a revoked agent's knocks (P28) -------------------


async def _connect_through(pool, door, *, name="minipc"):
    device_id, device = await _enroll(pool, name=name)
    device.device_id = str(device_id)
    conn = FakeWSConn(door=door)
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    ready = await asyncio.wait_for(device.handshake(conn, None), 2)
    assert ready["type"] == "ready"
    return device_id, device, conn, task


async def test_the_hubs_own_door_is_recorded_on_connect(pool):
    device_id, _device, conn, task = await _connect_through(pool, "host")
    assert (
        await pool.fetchval("SELECT last_transport FROM devices WHERE id = $1", device_id) == "host"
    )
    await _close(conn, task)


async def test_a_connect_through_no_known_door_records_none(pool):
    device_id, device, conn, task = await _connect_through(pool, "host")
    await _close(conn, task)
    conn = FakeWSConn(door=None)
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    await asyncio.wait_for(device.handshake(conn, None), 2)
    assert (
        await pool.fetchval("SELECT last_transport FROM devices WHERE id = $1", device_id) is None
    )
    await _close(conn, task)


async def test_a_revoked_devices_verified_knock_is_recorded_and_answered_with_the_proof(pool):
    device_id, device = await _enroll(pool, name="old-wsl")
    person = await _person(pool)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    _conn, task, reply = await _auth_with(pool, device_id, device, None)
    assert (
        reply["type"] == "auth_error"
        and reply["reason"] == devices_ws.REVOKED_REASON
        and "proof" in reply
    )
    assert (
        await pool.fetchval("SELECT last_refused_at FROM devices WHERE id = $1", device_id)
        is not None
    )
    await asyncio.wait_for(task, 2)


async def test_an_unverified_knock_for_a_revoked_id_gets_no_proof_and_records_nothing(pool):
    device_id, device = await _enroll(pool, name="old-wsl")
    person = await _person(pool)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    _conn, task, reply = await _auth_with(pool, device_id, device, None, key=FakeDevice())
    assert reply["type"] == "auth_error" and "proof" not in reply
    assert reply["reason"] != devices_ws.REVOKED_REASON
    assert (
        await pool.fetchval("SELECT last_refused_at FROM devices WHERE id = $1", device_id) is None
    )
    await asyncio.wait_for(task, 2)


# -- S42b Task 21: device_list from the plant, the knocks, the facts she acts on


async def _wait_for_facts_key(pool, device_id, key: str, value=None) -> None:
    for _ in range(100):
        facts = await pool.fetchval("SELECT facts FROM devices WHERE id = $1", device_id)
        if facts and key in facts and (value is None or facts[key] == value):
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"the facts frame's {key!r} never landed")


async def test_device_list_says_what_she_needs_to_act_on_a_windows_agent(pool):
    """P29, Review Focus 14: the Windows agent's own look at itself and at WSL,
    in device_list's words — the facts turn 01faf3b7 did not have. (The brief's
    "how it runs: service HKCU…" predates Task 16b fix round 2, M2: a Run-key
    value is never called a service.)"""
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed(PROBED)
    await _wait_for_facts_key(pool, device_id, "wsl_distros")
    person = await _person(pool)
    sink: list[dict] = []
    result, ok = await tools.dispatch("device_list", {}, _ctx(person, facts=sink))
    assert ok is True
    assert "- dell (Windows 11 Pro 24H2 (build 26100)) — connected" in result
    assert (
        "\n    how it runs: the Run-key value "
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Nova agent" in result
    )
    assert (
        "sam's systemd user unit novad.service is active (enabled, Restart=always, main pid 412)"
        in result
    )
    assert "\n    (probed 2026-09-28T17:40:00Z; device_info probes again" in result
    assert sink == [{"device": "dell", "connected": True}]
    await _close(conn, task)


async def test_device_list_says_an_agent_inside_wsl_gives_way_to_the_windows_build(pool):
    device_id, device = await _enroll(pool, name="pc-wsl")
    wsl = {
        **AUTH_FACTS,
        "os": {
            "goos": "linux",
            "arch": "amd64",
            "version": "Ubuntu 26.04 LTS",
            "wsl": {"distro": "Ubuntu-26.04"},
        },
    }
    conn, task, _ = await _auth_with(pool, device_id, device, wsl)
    person = await _person(pool)
    result, _ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert (
        "hands: cannot: this machine's Windows agent owns it — on Windows, Nova's agent is the "
        "Windows build, which reaches WSL through wsl.exe" in result
    )
    await _close(conn, task)


async def test_device_list_says_each_agents_build_and_folders_only_as_recorded(pool, monkeypatch):
    """Its build against the hub's (a hash has no order: "behind the hub's
    build", never "older"), the hub's own machine only by the door it came
    through, and the folders only as its agent reported them."""
    monkeypatch.setattr(machines.GatewayPlant, "hub_version", _hub_build("0f1e2d3c4b5a"))
    hub_id, hub_device = await _enroll(pool, name="minipc")
    conn, task, _ = await _auth_with(
        pool,
        hub_id,
        hub_device,
        {**AUTH_FACTS, "agent": {**AUTH_FACTS["agent"], "version": "0f1e2d3c4b5a"}},
    )
    await pool.execute("UPDATE devices SET last_transport = 'host' WHERE id = $1", hub_id)
    conn.feed({"type": "facts", "folders": {"desktop": "C:\\Users\\sam\\OneDrive\\Desktop"}})
    await _wait_for_facts_key(pool, hub_id, "folders")
    await _enroll(pool, name="laptop")  # paired, never connected: no facts at all
    person = await _person(pool)
    result, ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert ok is True
    lines = {line.split(" (")[0][2:]: line for line in result.splitlines() if line.startswith("- ")}
    assert (
        "; the hub's own machine; agent 0f1e2d3c4b5a (the hub's build); folders: @desktop"
        in (lines["minipc"])
    )
    assert lines["laptop"].endswith(
        "— offline, last seen never; agent version unknown (none on record); "
        "hands: cannot: not connected (last seen never)"
    )
    await pool.execute(
        "UPDATE devices SET facts = jsonb_set(facts, '{agent,version}', '\"aaaaaaaaaaaa\"') "
        "WHERE id = $1",
        hub_id,
    )
    result, _ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert "agent aaaaaaaaaaaa (behind the hub's build 0f1e2d3c4b5a)" in result
    assert re.search(r"\bolder\b", result) is None
    await _close(conn, task)


def _hub_build(version):
    async def hub_version(self):
        return version

    return hub_version


async def test_device_list_says_a_revoked_agent_is_still_knocking_and_when_it_stopped(pool):
    """P28, Review Focus 10: the knock record is the check that it stopped —
    and a knock that stopped is said as what is known: the agent stopped then,
    or can no longer reach Nova (an asleep machine knocks no more than a
    stopped agent does)."""
    old_id, _ = await _enroll(pool, name="old-wsl")
    gone_id, _ = await _enroll(pool, name="older")
    await pool.execute(
        "UPDATE devices SET revoked_at = now() - interval '1 hour', "
        "last_refused_at = now() - interval '20 seconds' WHERE id = $1",
        old_id,
    )
    await pool.execute(
        "UPDATE devices SET revoked_at = now() - interval '2 hours', "
        "last_refused_at = now() - interval '30 minutes' WHERE id = $1",
        gone_id,
    )
    person = await _person(pool)
    result, ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert ok is True and "Revoked, but their agents knocked in the last day:" in result
    lines = result.splitlines()
    old = next(line for line in lines if line.startswith("- old-wsl (revoked "))
    assert "still knocking (last " in old
    assert "the README's systemd user unit novad" in old and "wsl.exe -d <distro> --" in old
    assert (
        "how it runs: not reported" in old
    )  # the README is how one was installed, not a fact of it
    older = next(line for line in lines if line.startswith("- older (revoked "))
    assert "no knock since " in older and "it stopped then, or can no longer reach Nova" in older


async def test_a_revoked_agent_that_reported_how_it_runs_is_said_as_it_reported_it(pool):
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed(PROBED)
    await _wait_for_facts_key(pool, device_id, "probed_at")
    await _close(conn, task)
    await pool.execute(
        "UPDATE devices SET revoked_at = now(), last_refused_at = now() WHERE id = $1", device_id
    )
    person = await _person(pool)
    result, _ok = await tools.dispatch("device_list", {}, _ctx(person))
    (line,) = [line for line in result.splitlines() if line.startswith("- dell (revoked ")]
    assert "; how it runs: the Run-key value HKCU\\" in line
    assert line.endswith("(as probed at 2026-09-28T17:40:00Z)")
    assert "README" not in line


async def test_a_device_list_that_fails_after_reading_the_hub_backs_no_claim(pool, monkeypatch):
    """Its {device, connected} records are left only once the whole listing
    is built: a call that fails after reading the hub was shown no line, and
    an ok=False span carrying them would still back "the laptop is online"
    (guards._checked_a_device reads a determined fact on a failed device span)."""
    device_id, _device = await _enroll(pool, name="laptop")
    devices_ws.hub.register(device_id, FakeWSConn())

    async def _broken(pool):
        raise RuntimeError("the knock record could not be read")

    monkeypatch.setattr(device_tools, "_knocks", _broken)
    person = await _person(pool)
    sink: list[dict] = []
    result, ok = await tools.dispatch("device_list", {}, _ctx(person, facts=sink))
    assert ok is False and "the knock record could not be read" in result
    assert sink == []


async def test_device_list_with_nothing_paired_says_so_and_hands_no_step(pool):
    person = await _person(pool)
    result, ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert ok is True
    assert result == "No device is paired with Nova (show_setup_qr's add_machine card pairs one)."


async def test_a_folder_token_for_an_agent_that_reports_no_folders_is_a_stated_cannot(pool):
    """Review Focus 8: an S42a agent reports no folders, so @desktop cannot be sent."""
    _id, _device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_list_files", {"device": "laptop", "path": "@desktop"}, _ctx(person)
    )
    assert ok is False and "cannot: laptop's agent did not report its desktop folder" in result
    assert "(it has reported no folders — an agent from before S42b reports none)" in result
    assert _command_frames(conn) == []
    await _close(conn, task)


async def test_a_folder_the_agent_could_not_read_is_refused_in_its_own_words(pool):
    device_id, device = await _enroll(pool, name="minipc")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed(
        {
            "type": "facts",
            "net": {"ifaces": []},
            "unreadable": [
                {"item": "folders.desktop", "reason": "this machine names no desktop folder"}
            ],
        }
    )
    await _wait_for_facts_key(pool, device_id, "unreadable")
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_read_file", {"device": "minipc", "path": "@desktop/todo.txt"}, _ctx(person)
    )
    assert ok is False
    assert (
        "cannot: minipc's agent did not report its desktop folder (it said: this machine names "
        "no desktop folder)" in result
    )
    assert _command_frames(conn) == []
    await _close(conn, task)


@pytest.mark.parametrize("path", ["@Desktop", "@pictures/a.png", "@", "@desk top"])
async def test_a_folder_token_that_names_no_known_folder_is_refused_before_the_wire(pool, path):
    _id, _device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_list_files", {"device": "laptop", "path": path}, _ctx(person)
    )
    assert ok is False
    assert f"cannot: path {path!r} names no known folder — a folder is one of @home, " in result
    assert "@desktop, @documents, @downloads, then an optional /rest" in result
    assert _command_frames(conn) == []
    await _close(conn, task)


async def test_a_folder_the_agent_left_out_without_a_reason_is_said_as_that(pool):
    """It reported other folders and filed nothing about this one: said as
    exactly that, never as an agent that reports no folders at all."""
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed({"type": "facts", "folders": {"desktop": "C:\\Users\\sam\\Desktop"}})
    await _wait_for_facts_key(pool, device_id, "folders")
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_list_files", {"device": "dell", "path": "@downloads"}, _ctx(person)
    )
    assert ok is False
    assert result == (
        "Error: cannot: dell's agent did not report its downloads folder (it reported others, "
        "and filed no reason for this one) — give an absolute path instead"
    )
    assert _command_frames(conn) == []
    await _close(conn, task)


async def test_a_folder_token_reaches_the_agent_unresolved_when_it_reported_the_folder(pool):
    """P16: resolved ON the machine, as its OS names it."""
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed({"type": "facts", "folders": {"desktop": "C:\\Users\\sam\\OneDrive\\Desktop"}})
    await _wait_for_facts_key(pool, device_id, "folders")
    person = await _person(pool)
    ans = asyncio.create_task(
        device.answer_command(conn, output="entries in C:\\Users\\sam\\OneDrive\\Desktop\\notes")
    )
    result, ok = await tools.dispatch(
        "device_list_files", {"device": "dell", "path": "@desktop/notes"}, _ctx(person)
    )
    frame = await asyncio.wait_for(ans, 2)
    assert ok is True and frame["envelope"]["args"] == {"path": "@desktop/notes"}
    await _close(conn, task)


async def test_device_info_probes_again_and_says_how_the_agent_runs(pool):
    """P29, Review Focus 14: device_info asks for a fresh look first — its
    facts frame lands before its result — so the lines are the agent's look now."""
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    person = await _person(pool)

    async def answer():
        refresh = await asyncio.wait_for(conn.next_sent(), 2)
        assert refresh["envelope"]["capability"] == "facts.refresh"
        conn.feed(PROBED)
        conn.feed(device.result(refresh["envelope"]))
        info = await asyncio.wait_for(conn.next_sent(), 2)
        assert info["envelope"]["capability"] == "system.info"
        conn.feed(device.result(info["envelope"], output="host=PC-ONE; os=Windows 11 Pro"))

    ans = asyncio.create_task(answer())
    result, ok = await tools.dispatch("device_info", {"device": "dell"}, _ctx(person))
    await asyncio.wait_for(ans, 2)
    assert ok is True
    assert result.startswith(
        "dell system info:\nhost=PC-ONE; os=Windows 11 Pro\nhow it runs: the Run-key value "
    )
    assert "WSL on it, reached through this agent's wsl.exe: Ubuntu-26.04 (default" in result
    # The look landed, so nothing says otherwise: the last line is its time.
    assert result.endswith(
        "(probed 2026-09-28T17:40:00Z; device_info probes again — "
        "on Windows with WSL this can take up to about 45 seconds)"
    )
    await _close(conn, task)


async def test_device_info_says_the_agent_did_not_answer_the_refresh_and_what_the_lines_are(
    pool, monkeypatch
):
    """Controller ruling: a refresh with no answer is said as a fact, and the
    lines are said to be the last probe's — never presented as a look now."""
    monkeypatch.setattr(device_tools, "REFRESH_TIMEOUT_SECONDS", 1)
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed(PROBED)
    await _wait_for_facts_key(pool, device_id, "probed_at")
    person = await _person(pool)

    async def answer():
        refresh = await asyncio.wait_for(conn.next_sent(), 2)
        assert refresh["envelope"]["capability"] == "facts.refresh"  # and never answered
        info = await asyncio.wait_for(conn.next_sent(), 3)
        assert info["envelope"]["capability"] == "system.info"
        conn.feed(device.result(info["envelope"], output="host=PC-ONE"))

    ans = asyncio.create_task(answer())
    result, ok = await tools.dispatch("device_info", {"device": "dell"}, _ctx(person))
    await asyncio.wait_for(ans, 3)
    assert ok is True and "how it runs: the Run-key value " in result
    assert result.endswith(
        "\n(the refresh got no answer: device 'dell' did not answer within 1s — so the lines "
        "above on how it runs are as probed at 2026-09-28T17:40:00Z, not now)"
    )
    await _close(conn, task)


async def test_device_info_says_the_agent_could_not_look_again_in_its_own_words(pool):
    """An agent that cannot take the refresh (one from before facts.refresh
    answers `unknown capability`) is said in its words — and system.info
    still answers."""
    device_id, device = await _enroll(pool, name="laptop")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    person = await _person(pool)

    async def answer():
        refresh = await asyncio.wait_for(conn.next_sent(), 2)
        conn.feed(
            device.result(
                refresh["envelope"],
                ok=False,
                exit_code=None,
                error='unknown capability "facts.refresh"',
            )
        )
        info = await asyncio.wait_for(conn.next_sent(), 2)
        conn.feed(device.result(info["envelope"], output="host=laptop"))

    ans = asyncio.create_task(answer())
    result, ok = await tools.dispatch("device_info", {"device": "laptop"}, _ctx(person))
    await asyncio.wait_for(ans, 2)
    assert ok is True
    assert result == (
        "laptop system info:\nhost=laptop\n"
        "how it runs: unknown — this agent has not reported it\n"
        '(the agent could not look again: unknown capability "facts.refresh" — and no probe of '
        "it is on record)"
    )
    await _close(conn, task)


async def test_device_info_never_calls_an_old_probe_fresh_when_no_new_one_landed(pool):
    """The agent answers the refresh, but no new probe reaches core (its
    findings did not fit the frame, or an agent from before S42b probes
    nothing): the lines are the last probe's, and the result says so."""
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed(PROBED)
    await _wait_for_facts_key(pool, device_id, "probed_at")
    person = await _person(pool)
    too_big = "the probe's findings would make the frame 17000 bytes, over the 16384-byte cap"

    async def answer():
        refresh = await asyncio.wait_for(conn.next_sent(), 2)
        conn.feed(
            {
                "type": "facts",
                "net": {"ifaces": []},
                "unreadable": [{"item": "probe", "reason": too_big}],
            }
        )
        conn.feed(device.result(refresh["envelope"], output="facts sent"))
        info = await asyncio.wait_for(conn.next_sent(), 2)
        conn.feed(device.result(info["envelope"], output="host=PC-ONE"))

    ans = asyncio.create_task(answer())
    result, ok = await tools.dispatch("device_info", {"device": "dell"}, _ctx(person))
    await asyncio.wait_for(ans, 2)
    assert ok is True and "how it runs: the Run-key value " in result
    assert result.endswith(
        "\n(the agent answered the refresh, but no newer probe of it reached Nova — so the lines "
        "above on how it runs are as probed at 2026-09-28T17:40:00Z, not now)"
    )
    await _close(conn, task)


async def test_a_later_probe_that_omits_a_section_removes_it_never_keeps_the_older_one(pool):
    """The probe-freshness ruling through the socket: the second probe could
    not read WSL's list, so the first probe's distributions must not show
    under the second probe's time."""
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed(PROBED)
    await _wait_for_facts_key(pool, device_id, "wsl_distros")
    later = {
        "type": "facts",
        "net": {"ifaces": []},
        "unreadable": [{"item": "wsl_distros", "reason": "WSL's list could not be read: denied"}],
        "service": PROBED["service"],
        "elevation": PROBED["elevation"],
        "probed_at": "2026-09-29T08:00:00Z",
    }
    conn.feed(later)
    await _wait_for_facts_key(pool, device_id, "probed_at", "2026-09-29T08:00:00Z")
    facts = (await _facts_of(pool, device_id))["facts"]
    assert "wsl_distros" not in facts and facts["machine_uid"] == "c" * 64
    person = await _person(pool)
    result, _ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert "Ubuntu-26.04" not in result
    assert (
        "WSL: the list of distributions could not be read (WSL's list could not be read" in result
    )
    await _close(conn, task)


async def test_a_frame_without_probed_at_leaves_the_probe_and_its_reasons_alone(pool):
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    reason = {"item": "wsl_distros", "reason": "a key under Lxss could not be opened: denied"}
    conn.feed({**PROBED, "unreadable": [reason]})
    await _wait_for_facts_key(pool, device_id, "probed_at")
    probe = {k: v for k, v in (await _facts_of(pool, device_id))["facts"].items()}
    conn.feed({"type": "facts", "net": {"ifaces": []}, "unreadable": []})
    await _wait_for_facts_key(pool, device_id, "net")
    facts = (await _facts_of(pool, device_id))["facts"]
    for key in ("service", "elevation", "wsl_distros", "probed_at"):
        assert facts[key] == probe[key]
    assert facts["unreadable"] == [reason]
    await _close(conn, task)


def test_device_run_states_the_argv_contract_and_that_nothing_gets_a_terminal():
    """P29/P30: how a command runs is stated where she reads the tool — and
    only what is known: Task 1's Dell readings (whether wsl.exe hands what
    follows -- to the distro's shell; whether a prompt fails at once on
    Windows) are not in yet, so neither is said as fact."""
    description = tools.REGISTRY["device_run"].description
    assert "no shell" in description and "$(…)" in description and '["sh", "-c"' in description
    assert "no terminal and empty input" in description and "fails at once" in description
    assert '"--exec"' in description
    assert "has not been measured yet" in description
    for fs_tool in ("device_list_files", "device_read_file", "device_write_file"):
        tool = tools.REGISTRY[fs_tool]
        assert "@home, @desktop, @documents or @downloads" in tool.description
        assert "@desktop" in tool.parameters["properties"]["path"]["description"]
