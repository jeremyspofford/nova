"""Nova-managed updates (S42b decision 2): sent signed, confirmed ONLY by the
agent's reconnect on the new build, rolled back when its supervisor says so,
one machine at a time, the hub's own agent first — and an older agent updated
through its own hands, or told cannot."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import UTC, datetime

import pytest

from app import agent_dist, agent_updates, device_facts, devices, devices_ws, timers
from app.checks import devices as device_checks
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn

# `dist` is the fake build fixture (pytestmark below).
from tests.test_agent_dist import VERSION, _manifest_of, _write_manifest, dist  # noqa: F401
from tests.test_devices_ws import _close, _enroll, _person

# Every test runs beside the hub's fake build (test_agent_dist's fixture).
pytestmark = [requires_db, pytest.mark.usefixtures("dist")]
OLD = "000000000000"
UNKNOWN = 'unknown capability "daemon.update"'


@pytest.fixture(autouse=True)
def _clean_hub():
    hub = devices_ws.hub
    for registry in (hub._conns, hub._pending, hub._last_command, hub._epochs):
        registry.clear()
    yield
    for registry in (hub._conns, hub._pending, hub._last_command, hub._epochs):
        registry.clear()


@pytest.fixture
def tailnet(tmp_path, monkeypatch):
    path = tmp_path / "tailscale.json"
    monkeypatch.setenv("NOVA_STATUS_FILE", str(path))
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "backend_state": "Running",
                "dns_name": "nova.fake-tailnet.ts.net",
                "serve_ok": True,
                "https_cert": True,
                "written_at": now,
            }
        )
    )


def _facts(
    version: str,
    *,
    mode: str = "systemd-user",
    update: dict | None = None,
    goos: str = "linux",
    arch: str = "amd64",
) -> dict:
    agent = {"version": version, "mode": mode, "session_interactive": False}
    if update:
        agent["update"] = update
    return {
        "v": 2,
        "agent": agent,
        "os": {"goos": goos, "arch": arch, "version": "Test OS", "wsl": None},
        "hostname": "box",
        "machine_uid": "d" * 64,
    }


def _now_rfc3339() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _online(
    pool, name: str, facts: dict | None, *, door: str | None = None, platform: str = "linux"
):
    device_id, device = await _enroll(pool, name=name, platform=platform)
    device.device_id = str(device_id)
    conn = FakeWSConn(door=door)
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    ready = await asyncio.wait_for(device.handshake(conn, facts), 2)
    assert ready["type"] == "ready", ready
    return device_id, device, conn, task


async def _reconnect(pool, device: FakeDevice, facts: dict):
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    await asyncio.wait_for(device.handshake(conn, facts), 2)
    return conn, task


async def _repair(pool, device_id: uuid.UUID, new: FakeDevice) -> None:
    """A re-pair code for this machine, enrolled by a new key (decision 4)."""
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    await devices.enroll(
        pool,
        code=code["code"],
        pubkey=new.pubkey_hex,
        name="ignored",
        platform="linux",
        hostname="NEW-HOST",
    )


def _commands(conn: FakeWSConn) -> list[dict]:
    return [f for f in conn.sent if isinstance(f, dict) and f.get("type") == "command"]


async def _outcome_of(pool, device_id) -> str:
    return await pool.fetchval("SELECT outcome FROM agent_updates WHERE device_id = $1", device_id)


# -- the brief's pins ----------------------------------------------------------


async def test_an_update_is_sent_signed_and_confirmed_only_by_the_reconnect(pool):
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=5)
    )
    frame = await device.answer_command(conn, output="staged; restarting")
    sha = agent_dist.current().file_for("linux", "amd64")["sha256"]
    assert frame["envelope"]["capability"] == "daemon.update"
    assert frame["envelope"]["args"] == {
        "version": VERSION,
        "sha256": sha,
        "path": "/api/v1/agent/dist/novad-linux-amd64",
    }
    await asyncio.sleep(0.3)
    assert not run.done(), "a reply is a claim: nothing is confirmed until the agent reconnects"
    await _close(conn, task)
    conn2, task2 = await _reconnect(pool, device, _facts(VERSION))
    outcome = await asyncio.wait_for(run, 6)
    assert (outcome.outcome, outcome.version, outcome.from_version) == ("confirmed", VERSION, OLD)
    assert await _outcome_of(pool, device_id) == "confirmed"
    await _close(conn2, task2)


async def test_a_reconnect_reporting_a_rollback_marks_the_attempt_rolled_back(pool):
    _id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=5)
    )
    await device.answer_command(conn)
    await _close(conn, task)
    # Dated now, not a fixed past day: only a record written after the send
    # decides this attempt (the test below says why).
    rolled = {
        "version": VERSION,
        "outcome": "rolled_back",
        "reason": "the new build did not connect within 2m0s",
        "at": _now_rfc3339(),
    }
    conn2, task2 = await _reconnect(pool, device, _facts(OLD, update=rolled))
    outcome = await asyncio.wait_for(run, 6)
    assert outcome.outcome == "rolled_back" and "did not connect" in outcome.reason
    await _close(conn2, task2)


async def test_no_reconnect_within_ten_minutes_is_not_confirmed(pool):
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    await pool.execute(
        "UPDATE agent_updates SET sent_at = now() - interval '11 minutes' WHERE device_id = $1",
        device_id,
    )
    assert await agent_updates.expire_stale(pool) == 1
    assert await _outcome_of(pool, device_id) == "not_confirmed"
    await _close(conn, task)


async def test_one_update_in_flight_at_a_time(pool):
    _a, first, conn_a, task_a = await _online(pool, "box-a", _facts(OLD))
    _b, _second, conn_b, task_b = await _online(pool, "box-b", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box-a", requested_by="nova", wait_s=0.2)
    )
    await first.answer_command(conn_a)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    second = await agent_updates.update_now(pool, name="box-b", requested_by="owner", wait_s=0)
    assert second.outcome == "cannot" and "box-a is still in flight" in second.reason
    assert _commands(conn_b) == []
    await _close(conn_a, task_a)
    await _close(conn_b, task_b)


async def test_an_agent_on_the_hubs_build_is_left_alone(pool):
    _id, _device, conn, task = await _online(pool, "box", _facts(VERSION))
    outcome = await agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0)
    assert outcome.outcome == "current" and _commands(conn) == []
    await _close(conn, task)


async def test_a_hand_started_agent_is_a_stated_cannot(pool):
    _id, _device, conn, task = await _online(pool, "box", _facts(OLD, mode="foreground"))
    outcome = await agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0)
    assert (
        outcome.outcome == "cannot" and outcome.needs_card and "started by hand" in outcome.reason
    )
    assert _commands(conn) == []
    await _close(conn, task)


async def test_an_offline_agent_is_a_stated_cannot(pool):
    _id, _device, conn, task = await _online(pool, "box", _facts(OLD))
    await _close(conn, task)
    outcome = await agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0)
    assert outcome.outcome == "cannot" and "not connected" in outcome.reason


async def test_an_agent_without_the_capability_on_a_systemd_unit_is_bootstrapped_through_its_hands(
    pool, tailnet
):
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    entry = agent_dist.current().file_for("linux", "amd64")
    target = f"/home/sam/.cache/nova-update/{VERSION}/novad"
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=UNKNOWN)
    info = await device.answer_command(conn, output="host=box; os=Test OS; home=/home/sam")
    assert info["envelope"]["capability"] == "system.info"
    argvs = []
    for output in (
        "",
        f"{entry['sha256']}  {target}\n",
        "",
        "installed; the service restarts into it in 5 s",
    ):
        frame = await device.answer_command(conn, output=output)
        argvs.append(frame["envelope"]["args"]["argv"])
    assert argvs == [
        [
            "curl",
            "-fsSL",
            "--create-dirs",
            "-o",
            target,
            "https://nova.fake-tailnet.ts.net/api/v1/agent/dist/novad-linux-amd64",
        ],
        ["sha256sum", target],
        ["chmod", "0755", target],
        [target, "install", "--restart-later"],
    ]
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    path = await pool.fetchval("SELECT path FROM agent_updates WHERE device_id = $1", device_id)
    assert path == "bootstrap"
    await _close(conn, task)


async def test_a_bootstrap_whose_hash_does_not_match_runs_nothing(pool, tailnet):
    _id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=UNKNOWN)
    await device.answer_command(conn, output="host=box; home=/home/sam")
    await device.answer_command(conn)  # curl
    await device.answer_command(conn, output=f"{'0' * 64}  /x\n")  # sha256sum: not the hub's
    outcome = await asyncio.wait_for(run, 3)
    assert outcome.outcome == "refused" and "nothing was run" in outcome.reason
    assert len(_commands(conn)) == 4, "no chmod and no install after a mismatch"
    await _close(conn, task)


async def test_the_reconciler_sends_the_hubs_agent_first(pool):
    _a, _laptop, conn_a, task_a = await _online(pool, "aaa-laptop", _facts(OLD))
    _h, hub_device, conn_h, task_h = await _online(pool, "minipc", _facts(OLD), door="host")
    job = asyncio.create_task(agent_updates.reconcile(pool))
    await hub_device.answer_command(conn_h)
    words = await asyncio.wait_for(job, 5)
    assert "to minipc — the hub's own agent first" in words and _commands(conn_a) == []
    await _close(conn_a, task_a)
    await _close(conn_h, task_h)


async def test_the_reconciler_waits_while_an_update_is_in_flight(pool):
    device_id, _device = await _enroll(pool, name="box")
    await pool.execute(
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by) "
        "VALUES ($1, $2, $3, 'capability', 'nova')",
        device_id,
        VERSION,
        "c" * 64,
    )
    assert (await agent_updates.reconcile(pool)).startswith("waiting on box")


async def test_the_reconciler_never_resends_a_version_that_failed(pool):
    device_id, _device = await _enroll(pool, name="box")
    await pool.execute(
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by, outcome, "
        "outcome_at, reason) VALUES ($1, $2, $3, 'capability', 'reconciler', 'rolled_back', "
        "now(), 'did not connect')",
        device_id,
        VERSION,
        "c" * 64,
    )
    words = await agent_updates.reconcile(pool)
    assert words.startswith(f"halted: the hub's build {VERSION} rolled_back on box")


async def test_the_reconciler_skips_a_busy_machine(pool):
    device_id, _device, conn, task = await _online(pool, "box", _facts(OLD))
    devices_ws.hub._last_command[str(device_id)] = time.monotonic()
    words = await agent_updates.reconcile(pool)
    assert "box (busy" in words and _commands(conn) == []
    await _close(conn, task)


async def test_the_job_is_seeded_every_fifteen_minutes(pool):
    assert "agent_updates" in await timers.ensure_jobs(pool)
    row = await pool.fetchrow(
        "SELECT schedule FROM timers WHERE payload->>'handler' = 'agent_updates'"
    )
    assert row["schedule"] == {"kind": "minutes", "every": 15}


async def test_the_check_names_a_hand_started_agent_that_is_behind(pool):
    _id, _device, conn, task = await _online(pool, "box", _facts(OLD, mode="foreground"))
    findings = await device_checks.agents_behind(None, pool)
    assert len(findings) == 1 and "started by hand" in findings[0].title
    assert findings[0].facts == {"device": "box", "hub_version": VERSION, "why": "by_hand"}
    await _close(conn, task)


async def test_the_update_route_answers_with_the_outcome(owner_client, pool):
    device_id, _device = await _enroll(pool, name="box")
    resp = await owner_client.post(f"/api/v1/devices/{device_id}/update")
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "cannot" and "not connected" in body["reason"]


# -- re-pair and epochs (controller rulings) -------------------------------------


async def test_a_repair_ends_an_update_sent_to_the_old_agent_and_the_new_one_never_decides_it(pool):
    """The update went to the agent holding the OLD key. A re-pair moves the
    row on, and that agent can never authenticate again — so the attempt is
    decided as what is true (not confirmed) in the re-pair's own commit, and
    the new key's first connection, on the hub's build, decides nothing."""
    device_id, old, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="owner", wait_s=5)
    )
    await old.answer_command(conn)  # the old agent staged it
    new = FakeDevice()
    await _repair(pool, device_id, new)
    row = await pool.fetchrow(
        "SELECT outcome, reason FROM agent_updates WHERE device_id = $1", device_id
    )
    assert row["outcome"] == "not_confirmed" and row["reason"] == agent_updates.REPAIRED_REASON
    await devices_ws.hub.disconnect(device_id, "re-paired")  # what the enroll route does
    await asyncio.wait_for(task, 2)
    new.device_id = str(device_id)
    conn2, task2 = await _reconnect(pool, new, _facts(VERSION))
    outcome = await asyncio.wait_for(run, 6)
    assert outcome.outcome == "not_confirmed" and "re-paired" in outcome.reason
    assert await _outcome_of(pool, device_id) == "not_confirmed"
    await _close(conn2, task2)


async def test_a_connection_the_row_has_moved_past_decides_nothing(pool):
    """observe_connect decides only at the socket's own epoch — isolated here
    from the re-pair's own ending of the attempt."""
    device_id, _device = await _enroll(pool, name="box")
    await pool.execute(
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by) "
        "VALUES ($1, $2, $3, 'capability', 'owner')",
        device_id,
        VERSION,
        "c" * 64,
    )
    await pool.execute("UPDATE devices SET audit_epoch = 1 WHERE id = $1", device_id)
    facts = device_facts.validate_auth(_facts(VERSION))
    assert await agent_updates.observe_connect(pool, device_id, facts, epoch=0) is None
    assert await _outcome_of(pool, device_id) == "sent"
    assert await agent_updates.observe_connect(pool, device_id, facts, epoch=1) == "confirmed"


async def test_auth_facts_stored_nowhere_are_never_handed_on(pool):
    """_record_auth_facts hands observe_connect what it STORED: valid facts a
    re-pair kept off the row are not handed on as though they landed."""
    device_id, _device = await _enroll(pool, name="box")
    raw = _facts(VERSION)
    assert await devices_ws._record_auth_facts(pool, device_id, raw, epoch=1) is None
    assert (await devices.get(pool, device_id))["facts"] is None
    stored = await devices_ws._record_auth_facts(pool, device_id, raw, epoch=0)
    assert stored == device_facts.validate_auth(raw)
    assert (await devices.get(pool, device_id))["facts"] == stored


async def test_an_update_prepared_before_a_repair_is_never_opened_for_the_new_key(
    pool, monkeypatch
):
    """The attempt opens only while the row is at the epoch it was read at: a
    re-pair landing between the read and the open leaves nothing to open."""
    device_id, _old, conn, task = await _online(pool, "box", _facts(OLD))
    real_read = agent_dist.read

    async def read_then_repair():
        build = await real_read()
        await _repair(pool, device_id, FakeDevice())
        return build

    monkeypatch.setattr(agent_dist, "read", read_then_repair)
    outcome = await agent_updates.update_now(pool, name="box", requested_by="owner", wait_s=0)
    assert outcome.outcome == "cannot" and "re-paired or revoked" in outcome.reason
    assert await pool.fetchval("SELECT count(*) FROM agent_updates") == 0
    assert _commands(conn) == []
    await _close(conn, task)


# -- the old agent's hands (P11) ------------------------------------------------


@pytest.mark.parametrize(
    "mode, goos, arch",
    [
        ("launch-agent", "darwin", "arm64"),
        ("run-key", "windows", "amd64"),
        # Pairs no real agent reports, but the validator accepts: the gate is
        # the MODE (and the OS), never one standing in for the other.
        ("launch-agent", "linux", "amd64"),
        ("run-key", "linux", "amd64"),
        ("systemd-user", "darwin", "arm64"),
    ],
    ids=[
        "launch-agent",
        "run-key",
        "launch-agent-on-linux",
        "run-key-on-linux",
        "systemd-user-on-darwin",
    ],
)
async def test_an_old_agent_under_a_run_key_or_a_launch_agent_is_never_bootstrapped(
    pool, tailnet, mode, goos, arch
):
    """`install --restart-later` fails after place and register outside a
    systemd user unit (Task 12): the bootstrap is never sent there."""
    device_id, device, conn, task = await _online(
        pool, "box", _facts(OLD, mode=mode, goos=goos, arch=arch), platform=goos
    )
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=UNKNOWN)
    outcome = await asyncio.wait_for(run, 3)
    assert outcome.outcome == "cannot" and outcome.needs_card
    assert "setup card" in outcome.reason and mode in outcome.reason
    await asyncio.sleep(0.2)
    assert [f["envelope"]["capability"] for f in _commands(conn)] == ["daemon.update"]
    row = await pool.fetchrow(
        "SELECT outcome, path FROM agent_updates WHERE device_id = $1", device_id
    )
    assert (row["outcome"], row["path"]) == ("refused", "capability")
    await _close(conn, task)


async def test_a_bootstrap_whose_install_reply_is_cut_off_stays_open_for_the_reconnect(
    pool, tailnet
):
    """The install step's own restart can cut its reply off: unanswered is not
    refused — only the reconnect can say what happened."""
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    entry = agent_dist.current().file_for("linux", "amd64")
    target = f"/home/sam/.cache/nova-update/{VERSION}/novad"
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=UNKNOWN)
    await device.answer_command(conn, output="home=/home/sam")
    for output in ("", f"{entry['sha256']}  {target}\n", ""):
        await device.answer_command(conn, output=output)
    install = await asyncio.wait_for(conn.next_sent(), 2)
    assert install["envelope"]["args"]["argv"] == [target, "install", "--restart-later"]
    await _close(conn, task)  # the unit restarted before the reply got out
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    assert await _outcome_of(pool, device_id) == "sent"


async def test_a_bootstrap_install_that_ran_and_failed_is_refused_in_its_words(pool, tailnet):
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    entry = agent_dist.current().file_for("linux", "amd64")
    target = f"/home/sam/.cache/nova-update/{VERSION}/novad"
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=UNKNOWN)
    await device.answer_command(conn, output="home=/home/sam")
    for output in ("", f"{entry['sha256']}  {target}\n", ""):
        await device.answer_command(conn, output=output)
    await device.answer_command(conn, exit_code=1, output="cannot: linger is off\n")
    outcome = await asyncio.wait_for(run, 3)
    assert outcome.outcome == "refused"
    assert outcome.reason == "the install step failed on box (exit 1): cannot: linger is off"
    assert await _outcome_of(pool, device_id) == "refused"
    await _close(conn, task)


async def test_a_bootstrap_with_no_absolute_home_runs_nothing(pool, tailnet):
    _id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=UNKNOWN)
    await device.answer_command(conn, output="host=box; home=-rf/x")
    outcome = await asyncio.wait_for(run, 3)
    assert outcome.outcome == "refused" and "absolute home folder" in outcome.reason
    assert len(_commands(conn)) == 2, "nothing past system.info"
    await _close(conn, task)


# -- what an update says, and what it counts ------------------------------------


async def test_the_update_counts_the_commands_its_restart_will_cancel(pool):
    """F15: the count of commands in flight when it was sent — the hub keeps
    futures, not capability names."""
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    pending = asyncio.create_task(
        devices_ws.hub.command(
            pool, device_id=device_id, name="box", capability="system.info", args={}, timeout=5
        )
    )
    held = await asyncio.wait_for(conn.next_sent(), 2)  # never answered
    assert held["envelope"]["capability"] == "system.info"
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="owner", wait_s=0)
    )
    await device.answer_command(conn)
    outcome = await asyncio.wait_for(run, 3)
    assert outcome.outcome == "sent" and outcome.in_flight == 1
    await _close(conn, task)
    with pytest.raises(devices.DeviceRefused):
        await pending


async def test_a_refusal_is_stored_as_one_bounded_line(pool):
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    said = "cannot: not supervised\nbox: connected\r\x00\x1b[2J\x7f\x9b\u2028 tail " + "x" * 1000
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="owner", wait_s=0)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=said)
    outcome = await asyncio.wait_for(run, 3)
    stored = await pool.fetchval("SELECT reason FROM agent_updates WHERE device_id = $1", device_id)
    assert outcome.outcome == "refused" and outcome.reason == stored
    assert stored.startswith("cannot: not supervised box: connected")
    assert not any(ch in stored for ch in "\n\r\x00\x1b\x7f\x9b\u2028")
    assert len(stored) == agent_updates.REASON_MAX and stored.endswith("…")
    await _close(conn, task)


async def test_an_update_that_never_reached_the_socket_is_a_cannot_and_leaves_no_attempt(
    pool, monkeypatch
):
    _id, _device, conn, task = await _online(pool, "box", _facts(OLD))

    async def dead_send(frame):
        raise ConnectionResetError("the socket is gone")

    monkeypatch.setattr(conn, "send", dead_send)
    outcome = await agent_updates.update_now(pool, name="box", requested_by="owner", wait_s=0)
    assert outcome.outcome == "cannot" and "nothing was sent" in outcome.reason
    assert await pool.fetchval("SELECT count(*) FROM agent_updates") == 0
    await _close(conn, task)


async def test_an_update_the_agent_never_answers_stays_open_for_its_reconnect(pool, monkeypatch):
    monkeypatch.setattr(agent_updates, "COMMAND_TIMEOUT_S", 0.3)
    device_id, _device, conn, task = await _online(pool, "box", _facts(OLD))
    outcome = await agent_updates.update_now(pool, name="box", requested_by="owner", wait_s=0)
    assert outcome.outcome == "sent" and len(_commands(conn)) == 1
    assert await _outcome_of(pool, device_id) == "sent"
    await _close(conn, task)


async def test_a_rollback_recorded_before_this_attempt_was_sent_never_decides_it(pool):
    """An agent keeps reporting its LAST supervisor record. After a rollback,
    "update it now" may retry the same build; a reconnect that still carries
    the earlier rollback is not this attempt's outcome."""
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="owner", wait_s=0.6)
    )
    await device.answer_command(conn)
    await _close(conn, task)
    earlier = {
        "version": VERSION,
        "outcome": "rolled_back",
        "reason": "an earlier attempt's rollback",
        "at": "2026-09-28T12:00:00Z",
    }
    conn2, task2 = await _reconnect(pool, device, _facts(OLD, update=earlier))
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    assert await _outcome_of(pool, device_id) == "sent"
    await _close(conn2, task2)


def test_a_supervisor_record_counts_only_from_the_second_the_attempt_was_sent():
    sent_at = datetime(2026, 10, 2, 12, 0, 0, 500_000, tzinfo=UTC)
    # The agent dates its record to the second (RFC 3339): the same second counts.
    assert agent_updates._recorded_after("2026-10-02T12:00:00Z", sent_at)
    assert agent_updates._recorded_after("2026-10-02T12:00:01+00:00", sent_at)
    assert not agent_updates._recorded_after("2026-10-02T11:59:59Z", sent_at)
    for unreadable in ("", "yesterday", "2026-10-02T12:00:00", None, 1_790_000_000):
        assert not agent_updates._recorded_after(unreadable, sent_at), unreadable


async def test_auth_facts_core_refused_decide_nothing(pool):
    """Only facts this connection STORED decide an update: a version inside
    facts core refused is not a version anyone recorded."""
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.6)
    )
    await device.answer_command(conn)
    await _close(conn, task)
    conn2, task2 = await _reconnect(pool, device, _facts(VERSION, mode="no-such-mode"))
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    assert (await devices.get(pool, device_id))["facts"] is None
    await _close(conn2, task2)


async def test_an_agent_that_never_said_how_it_runs_is_never_called_hand_started(pool):
    """No agent block — no auth facts, and a facts frame merged into the empty
    row — says nothing about how it runs: never "by hand"."""
    device_id, _device, conn, task = await _online(pool, "box", None)
    await pool.execute(
        "UPDATE devices SET facts = $2, facts_at = now() WHERE id = $1",
        device_id,
        {"folders": {"home": "/h"}},
    )
    outcome = await agent_updates.update_now(pool, name="box", requested_by="owner", wait_s=0)
    assert outcome.outcome == "cannot" and outcome.needs_card
    assert "has not reported how it runs" in outcome.reason and "by hand" not in outcome.reason
    assert _commands(conn) == []
    await _close(conn, task)


async def test_update_now_records_what_it_determined_about_the_connection(pool):
    _id, _device, conn, task = await _online(pool, "box", _facts(OLD))
    await _close(conn, task)
    sink: list[dict] = []
    await agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0, facts_sink=sink)
    assert sink == [{"device": "box", "connected": False}]


# -- the job's order (P10) ------------------------------------------------------


async def test_the_others_wait_while_the_hubs_own_agent_cannot_be_updated(pool):
    _h, _hub, conn_h, task_h = await _online(
        pool, "minipc", _facts(OLD, mode="foreground"), door="host"
    )
    _l, _laptop, conn_l, task_l = await _online(pool, "laptop", _facts(OLD))
    words = await agent_updates.reconcile(pool)
    assert words == (
        "nothing sent: minipc (started by hand); the others wait for the hub's own agent"
    )
    assert _commands(conn_h) == [] and _commands(conn_l) == []
    await _close(conn_h, task_h)
    await _close(conn_l, task_l)


# -- the check (devices_agents_behind) ------------------------------------------


async def test_the_check_says_what_it_knows_and_never_more(pool):
    root = agent_dist.dist_dir()  # the fake build: its manifest says built just now
    _write_manifest(root, {**_manifest_of(root), "built_at": _now_rfc3339()})
    await _enroll(pool, name="quiet")  # never connected: no facts at all
    _c, _cd, conn_c, task_c = await _online(pool, "current", _facts(VERSION))
    failed_id, _fd, conn_f, task_f = await _online(pool, "failed", _facts(OLD))
    await pool.execute(
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by, outcome, "
        "outcome_at, reason) VALUES ($1, $2, $3, 'capability', 'reconciler', 'rolled_back', "
        "now(), 'the new build did not connect within 2m0s')",
        failed_id,
        VERSION,
        "c" * 64,
    )
    _b, _bd, conn_b, task_b = await _online(pool, "behind", _facts(OLD))  # the job's to update
    findings = {f.facts["device"]: f for f in await device_checks.agents_behind(None, pool)}
    assert set(findings) == {"quiet", "failed"}
    quiet = findings["quiet"]
    assert quiet.key.startswith("agent_behind:") and quiet.facts["why"] == "no_facts"
    assert "behind" not in quiet.title and "has not said which build it runs" in quiet.title
    failed = findings["failed"]
    assert failed.facts == {"device": "failed", "hub_version": VERSION, "why": "failed:rolled_back"}
    assert "was rolled back: the new build did not connect within 2m0s" in failed.title
    for conn, task in ((conn_c, task_c), (conn_f, task_f), (conn_b, task_b)):
        await _close(conn, task)


async def test_the_check_names_an_agent_behind_a_build_over_a_day_old_without_guessing_why(pool):
    _b, _bd, conn, task = await _online(pool, "behind", _facts(OLD))  # built 2026-09-28
    (finding,) = await device_checks.agents_behind(None, pool)
    assert finding.facts == {"device": "behind", "hub_version": VERSION, "why": "stale"}
    assert "over a day ago" in finding.title
    assert "offline" not in finding.title and "idle" not in finding.title
    await _close(conn, task)


async def test_the_route_refuses_a_device_it_does_not_know(owner_client, pool):
    resp = await owner_client.post(f"/api/v1/devices/{uuid.uuid4()}/update")
    assert resp.status_code == 404


# -- controller rulings (amendment): a refusal halts nothing; a revoke ends it ---


async def _decided(pool, device_id, outcome: str, reason: str) -> None:
    """An attempt at the hub's build, already decided on this machine."""
    await pool.execute(
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by, outcome, "
        "outcome_at, reason) VALUES ($1, $2, $3, 'capability', 'reconciler', $4, now(), $5)",
        device_id,
        VERSION,
        "c" * 64,
        outcome,
        reason,
    )


def _old_mac(version: str = OLD) -> dict:
    return _facts(version, mode="launch-agent", goos="darwin", arch="arm64")


async def test_a_machine_that_cannot_take_the_build_halts_nothing_for_the_others(pool, monkeypatch):
    """Ruling 1 (a): a refusal is the MACHINE's — an old Mac's agent answers
    `unknown capability` — not the build failing, so the next pass still
    sends the same build to another machine."""
    monkeypatch.setattr(agent_updates, "COMMAND_TIMEOUT_S", 2)
    mac_id, mac, conn_m, task_m = await _online(pool, "a-mac", _old_mac(), platform="darwin")
    _b, box, conn_b, task_b = await _online(pool, "b-box", _facts(OLD))
    first = asyncio.create_task(agent_updates.reconcile(pool))
    await asyncio.wait_for(mac.answer_command(conn_m, ok=False, exit_code=None, error=UNKNOWN), 3)
    # Fix round 1, M2 (pin moved): only the update command went out, and the
    # machine cannot take the build — never "sent …; cannot — cannot: …".
    assert (await asyncio.wait_for(first, 5)).startswith(
        f"a-mac cannot take the hub's build {VERSION}: a-mac's agent predates Nova-managed updates"
    )
    assert await _outcome_of(pool, mac_id) == "refused"
    second = asyncio.create_task(agent_updates.reconcile(pool))
    frame = await asyncio.wait_for(box.answer_command(conn_b), 3)
    assert frame["envelope"]["capability"] == "daemon.update"
    assert (await asyncio.wait_for(second, 5)).startswith(
        f"sent the hub's build {VERSION} to b-box"
    )
    await _close(conn_m, task_m)
    await _close(conn_b, task_b)


@pytest.mark.parametrize("outcome", ["rolled_back", "not_confirmed"])
async def test_a_build_that_may_not_run_still_halts_the_job_for_every_other_machine(
    pool, monkeypatch, outcome
):
    """Ruling 1 (b): rolled back or never confirmed means the build may not
    run — that still halts it for everyone (P10)."""
    monkeypatch.setattr(agent_updates, "COMMAND_TIMEOUT_S", 0.5)
    a_id, _a = await _enroll(pool, name="a-box")
    await _decided(pool, a_id, outcome, "the new build did not connect within 2m0s")
    _b, _box, conn, task = await _online(pool, "b-box", _facts(OLD))
    words = await agent_updates.reconcile(pool)
    assert words.startswith(f"halted: the hub's build {VERSION} {outcome} on a-box")
    assert _commands(conn) == []
    await _close(conn, task)


async def test_the_job_never_resends_a_build_to_a_machine_that_refused_it(pool, monkeypatch):
    """Ruling 1 (c): a machine already tried with this build is skipped, so
    the job never loops on one that cannot take it."""
    monkeypatch.setattr(agent_updates, "COMMAND_TIMEOUT_S", 0.5)
    mac_id, _mac, conn, task = await _online(pool, "a-mac", _old_mac(), platform="darwin")
    await _decided(pool, mac_id, "refused", "cannot: a-mac's agent predates Nova-managed updates")
    words = await agent_updates.reconcile(pool)
    assert words == "nothing sent: a-mac (this build was already tried there: refused)"
    assert _commands(conn) == []
    await _close(conn, task)


@pytest.mark.parametrize("outcome", ["refused", "rolled_back"])
async def test_update_it_now_still_retries_a_build_already_tried_there(pool, outcome):
    """Ruling 1 (d): "update it now" can still retry (P10)."""
    box_id, box, conn, task = await _online(pool, "box", _facts(OLD))
    await _decided(pool, box_id, outcome, "an earlier attempt")
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="owner", wait_s=0)
    )
    frame = await asyncio.wait_for(box.answer_command(conn), 3)
    assert frame["envelope"]["capability"] == "daemon.update"
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    count = await pool.fetchval("SELECT count(*) FROM agent_updates WHERE device_id = $1", box_id)
    assert count == 2
    await _close(conn, task)


async def test_a_hub_agent_that_cannot_take_the_build_does_not_hold_the_others(pool):
    """A refusal halts nothing for other machines — the hub's own agent's
    included: once it has been tried with this build, the others go on."""
    hub_id, _hub, conn_h, task_h = await _online(pool, "minipc", _facts(OLD), door="host")
    await _decided(
        pool, hub_id, "refused", "the download step failed on minipc (exit 127): curl: not found"
    )
    _l, laptop, conn_l, task_l = await _online(pool, "laptop", _facts(OLD))
    job = asyncio.create_task(agent_updates.reconcile(pool))
    await asyncio.wait_for(laptop.answer_command(conn_l), 3)
    assert (await asyncio.wait_for(job, 5)).startswith(f"sent the hub's build {VERSION} to laptop")
    assert _commands(conn_h) == []
    await _close(conn_h, task_h)
    await _close(conn_l, task_l)


async def test_the_check_says_a_refused_machine_cannot_take_the_build_never_that_it_failed(pool):
    root = agent_dist.dist_dir()
    _write_manifest(root, {**_manifest_of(root), "built_at": _now_rfc3339()})
    mac_id, _mac, conn, task = await _online(pool, "a-mac", _old_mac(), platform="darwin")
    await _decided(pool, mac_id, "refused", "cannot: a-mac's agent predates Nova-managed updates")
    (finding,) = await device_checks.agents_behind(None, pool)
    assert finding.facts == {"device": "a-mac", "hub_version": VERSION, "why": "refused"}
    assert "cannot take it: a-mac's agent predates Nova-managed updates" in finding.title
    assert "fail" not in finding.title and "rolled" not in finding.title
    await _close(conn, task)


async def test_a_revoke_ends_the_machines_open_update_and_frees_the_slot(pool):
    """Ruling 2: a revoked agent can never connect to confirm its update, so
    the revoke decides it — not confirmed, and why — in its own commit, and
    P9's one slot is free for another machine at once."""
    a_id, a_dev, conn_a, task_a = await _online(pool, "box-a", _facts(OLD))
    _b, b_dev, conn_b, task_b = await _online(pool, "box-b", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box-a", requested_by="owner", wait_s=5)
    )
    await a_dev.answer_command(conn_a)
    await devices.revoke(pool, device_id=a_id, actor="tester")
    row = await pool.fetchrow(
        "SELECT outcome, reason FROM agent_updates WHERE device_id = $1", a_id
    )
    assert row["outcome"] == "not_confirmed" and row["reason"] == agent_updates.REVOKED_REASON
    assert (await asyncio.wait_for(run, 6)).outcome == "not_confirmed"
    run_b = asyncio.create_task(
        agent_updates.update_now(pool, name="box-b", requested_by="owner", wait_s=0)
    )
    await asyncio.wait_for(b_dev.answer_command(conn_b), 3)
    assert (await asyncio.wait_for(run_b, 3)).outcome == "sent"
    await devices_ws.hub.disconnect(a_id, "revoked")  # what the revoke route does
    await asyncio.wait_for(task_a, 2)
    await _close(conn_b, task_b)


# -- fix round 1 ----------------------------------------------------------------


async def test_a_revoke_during_an_update_halts_nothing_for_the_others(pool):
    """I1: an attempt a revoke ended is not the build failing."""
    a_id, a_dev, conn_a, task_a = await _online(pool, "box-a", _facts(OLD))
    _b, b_dev, conn_b, task_b = await _online(pool, "box-b", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box-a", requested_by="reconciler", wait_s=0)
    )
    await a_dev.answer_command(conn_a)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    await devices.revoke(pool, device_id=a_id, actor="tester")
    await devices_ws.hub.disconnect(a_id, "revoked")
    await asyncio.wait_for(task_a, 2)
    job = asyncio.create_task(agent_updates.reconcile(pool))
    await asyncio.wait_for(b_dev.answer_command(conn_b), 3)
    assert (await asyncio.wait_for(job, 5)).startswith(f"sent the hub's build {VERSION} to box-b")
    await _close(conn_b, task_b)


async def test_a_repair_during_an_update_halts_nothing_for_the_others(pool):
    """I1: an attempt a re-pair ended is not the build failing."""
    a_id, a_dev, conn_a, task_a = await _online(pool, "box-a", _facts(OLD))
    _b, b_dev, conn_b, task_b = await _online(pool, "box-b", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box-a", requested_by="reconciler", wait_s=0)
    )
    await a_dev.answer_command(conn_a)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    await _repair(pool, a_id, FakeDevice())  # its new agent has not connected yet
    await devices_ws.hub.disconnect(a_id, "re-paired")
    await asyncio.wait_for(task_a, 2)
    job = asyncio.create_task(agent_updates.reconcile(pool))
    await asyncio.wait_for(b_dev.answer_command(conn_b), 3)
    assert (await asyncio.wait_for(job, 5)).startswith(f"sent the hub's build {VERSION} to box-b")
    await _close(conn_b, task_b)


async def test_the_job_updates_a_repaired_machines_new_agent(pool):
    """An attempt a re-pair ended was the OLD agent's: the new one was never
    tried with this build, so the job does not pass it by as tried."""
    device_id, old, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="reconciler", wait_s=0)
    )
    await old.answer_command(conn)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    new = FakeDevice()
    await _repair(pool, device_id, new)
    await devices_ws.hub.disconnect(device_id, "re-paired")
    await asyncio.wait_for(task, 2)
    new.device_id = str(device_id)
    conn2, task2 = await _reconnect(pool, new, _facts(OLD))  # the new agent is behind too
    # Five minutes on: the old agent's update command no longer makes the
    # machine busy (P10's quiet window) — this test is about "tried".
    devices_ws.hub._last_command.pop(str(device_id), None)
    job = asyncio.create_task(agent_updates.reconcile(pool))
    frame = await asyncio.wait_for(new.answer_command(conn2), 3)
    assert frame["envelope"]["capability"] == "daemon.update"
    assert (await asyncio.wait_for(job, 5)).startswith(f"sent the hub's build {VERSION} to box")
    await _close(conn2, task2)


async def test_the_check_never_calls_an_attempt_a_repair_ended_a_failed_build(pool):
    root = agent_dist.dist_dir()
    _write_manifest(root, {**_manifest_of(root), "built_at": _now_rfc3339()})
    device_id, old, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="reconciler", wait_s=0)
    )
    await old.answer_command(conn)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    new = FakeDevice()
    await _repair(pool, device_id, new)
    await devices_ws.hub.disconnect(device_id, "re-paired")
    await asyncio.wait_for(task, 2)
    new.device_id = str(device_id)
    conn2, task2 = await _reconnect(pool, new, _facts(OLD))
    assert await device_checks.agents_behind(None, pool) == []  # the job's to update
    await _close(conn2, task2)


async def test_an_update_a_revoke_kept_from_being_sent_leaves_no_attempt(pool, monkeypatch):
    """I2: the revoke commits between the open and Hub.command's first read.
    Nothing left core, so the call's own attempt is withdrawn whatever the
    revoke decided it as — never a ledger row for a command never sent."""
    a_id, _a_dev, conn_a, task_a = await _online(pool, "box-a", _facts(OLD))
    real_get_live = devices.get_live
    fired: list[bool] = []

    async def revoke_then_read(p, device_id):
        if not fired:
            fired.append(True)
            await devices.revoke(pool, device_id=a_id, actor="tester")
        return await real_get_live(p, device_id)

    monkeypatch.setattr(devices, "get_live", revoke_then_read)
    outcome = await agent_updates.update_now(pool, name="box-a", requested_by="owner", wait_s=0)
    monkeypatch.setattr(devices, "get_live", real_get_live)
    assert fired and outcome.outcome == "cannot" and "nothing was sent" in outcome.reason
    assert _commands(conn_a) == []
    count = await pool.fetchval("SELECT count(*) FROM agent_updates WHERE device_id = $1", a_id)
    assert count == 0
    await devices_ws.hub.disconnect(a_id, "revoked")
    await asyncio.wait_for(task_a, 2)


def _steps_of(timeouts: dict):
    real_command = devices_ws.hub.command

    async def recording(pool_, **kw):
        argv = kw["args"].get("argv") if kw["capability"] == "shell.exec" else None
        step = (
            kw["capability"]
            if argv is None
            else ("install" if argv[1:2] == ["install"] else argv[0])
        )
        timeouts[step] = kw["timeout"]
        return await real_command(pool_, **kw)

    return recording


async def test_the_bootstrap_has_one_deadline_and_each_step_gets_what_remains(
    pool, tailnet, monkeypatch
):
    """I3: one deadline for the whole bootstrap. A step that answers slowly
    leaves the next steps only what remains of COMMAND_TIMEOUT_S."""
    now = [1000.0]
    monkeypatch.setattr(agent_updates, "_clock", lambda: now[0])
    timeouts: dict[str, float] = {}
    monkeypatch.setattr(devices_ws.hub, "command", _steps_of(timeouts))
    _id, device, conn, task = await _online(pool, "box", _facts(OLD))
    entry = agent_dist.current().file_for("linux", "amd64")
    target = f"/home/sam/.cache/nova-update/{VERSION}/novad"
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=UNKNOWN)
    info = await asyncio.wait_for(conn.next_sent(), 2)  # sent: the deadline is set
    assert info["envelope"]["capability"] == "system.info"
    now[0] += 100  # it took 100 of the update's 120 s
    conn.feed(device.result(info["envelope"], output="home=/home/sam"))
    for output in ("", f"{entry['sha256']}  {target}\n", "", "installed"):
        await device.answer_command(conn, output=output)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    total = agent_updates.COMMAND_TIMEOUT_S
    assert timeouts["daemon.update"] == total and timeouts["system.info"] == total
    for step in ("curl", "sha256sum", "chmod", "install"):
        assert timeouts[step] == pytest.approx(total - 100), step
    await _close(conn, task)


async def test_a_bootstrap_whose_time_runs_out_says_which_step_was_not_sent(
    pool, tailnet, monkeypatch
):
    now = [1000.0]
    monkeypatch.setattr(agent_updates, "_clock", lambda: now[0])
    _id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=UNKNOWN)
    info = await asyncio.wait_for(conn.next_sent(), 2)
    now[0] += 130  # it answered, but the update's whole 120 s had gone
    conn.feed(device.result(info["envelope"], output="home=/home/sam"))
    outcome = await asyncio.wait_for(run, 3)
    assert outcome.outcome == "refused"
    assert outcome.reason == (
        "the update's 120 s ran out before its download step was sent — nothing past it was run"
    )
    assert len(_commands(conn)) == 2, "daemon.update and system.info only"
    await _close(conn, task)


async def test_a_bootstrap_step_that_does_not_finish_in_time_is_named(pool, tailnet, monkeypatch):
    monkeypatch.setattr(agent_updates, "COMMAND_TIMEOUT_S", 0.5)
    _id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=UNKNOWN)
    await device.answer_command(conn, output="home=/home/sam")
    outcome = await asyncio.wait_for(run, 3)  # the download is never answered
    assert outcome.outcome == "refused"
    assert outcome.reason == (
        "the download step did not finish on box within the update's 0.5 s — nothing past it "
        "was run"
    )
    await _close(conn, task)


async def test_a_machine_the_hub_has_no_build_for_never_holds_the_job(pool):
    """M1: whether the hub has a build for its platform is part of the one
    eligibility decision, so the job passes such a machine by."""
    _arm, _a, conn_arm, task_arm = await _online(pool, "a-arm", _facts(OLD, arch="arm"))
    _b, box, conn_b, task_b = await _online(pool, "b-box", _facts(OLD))
    job = asyncio.create_task(agent_updates.reconcile(pool))
    await asyncio.wait_for(box.answer_command(conn_b), 3)
    assert (await asyncio.wait_for(job, 5)).startswith(f"sent the hub's build {VERSION} to b-box")
    assert _commands(conn_arm) == []
    out = await agent_updates.update_now(pool, name="a-arm", requested_by="owner", wait_s=0)
    assert out.outcome == "cannot" and "linux/arm" in out.reason and not out.needs_card
    behind = {
        f.facts["device"]: f.facts["why"] for f in await device_checks.agents_behind(None, pool)
    }
    assert behind["a-arm"] == "no_build"
    await _close(conn_arm, task_arm)
    await _close(conn_b, task_b)


async def test_an_expired_attempt_whose_agent_reported_the_build_is_confirmed_not_failed(
    pool, monkeypatch
):
    """M6: a decision a swallowed observe_connect error missed is read from
    the stored facts at expiry — never turned into a false halt."""
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0)
    )
    await device.answer_command(conn)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    await _close(conn, task)

    async def broken(*args, **kwargs):
        raise RuntimeError("observe_connect failed")

    monkeypatch.setattr(agent_updates, "observe_connect", broken)
    conn2, task2 = await _reconnect(pool, device, _facts(VERSION))  # stored; the decision was not
    assert await _outcome_of(pool, device_id) == "sent"
    await pool.execute(
        "UPDATE agent_updates SET sent_at = now() - interval '11 minutes' WHERE device_id = $1",
        device_id,
    )
    assert await agent_updates.expire_stale(pool) == 1
    assert await _outcome_of(pool, device_id) == "confirmed"
    assert not (await agent_updates.reconcile(pool)).startswith("halted")
    await _close(conn2, task2)


async def test_an_expired_attempt_whose_agent_reported_a_rollback_is_rolled_back(pool, monkeypatch):
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0)
    )
    await device.answer_command(conn)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    await _close(conn, task)

    async def broken(*args, **kwargs):
        raise RuntimeError("observe_connect failed")

    monkeypatch.setattr(agent_updates, "observe_connect", broken)
    rolled = {
        "version": VERSION,
        "outcome": "rolled_back",
        "reason": "the new build did not connect within 2m0s",
        "at": _now_rfc3339(),
    }
    conn2, task2 = await _reconnect(pool, device, _facts(OLD, update=rolled))
    await pool.execute(
        "UPDATE agent_updates SET sent_at = now() - interval '11 minutes' WHERE device_id = $1",
        device_id,
    )
    assert await agent_updates.expire_stale(pool) == 1
    row = await pool.fetchrow(
        "SELECT outcome, reason FROM agent_updates WHERE device_id = $1", device_id
    )
    assert (row["outcome"], row["reason"]) == (
        "rolled_back",
        "the new build did not connect within 2m0s",
    )
    await _close(conn2, task2)


async def test_a_bootstrap_whose_system_info_fails_says_the_agents_own_error(pool, tailnet):
    """M7: the agent's own words, never "did not name an absolute home"."""
    _id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=UNKNOWN)
    await device.answer_command(conn, ok=False, exit_code=None, error="home: permission denied")
    outcome = await asyncio.wait_for(run, 3)
    assert outcome.outcome == "refused"
    assert outcome.reason == (
        "the system.info step failed on box: home: permission denied — nothing was run"
    )
    assert len(_commands(conn)) == 2
    await _close(conn, task)


async def test_end_open_attempt_records_only_the_reasons_the_halt_keys_on(pool):
    """The halt and the job's skip leave out exactly ENDED_REASONS: any other
    reason recorded through end_open_attempt would read as a failed build."""
    device_id, _device = await _enroll(pool, name="box")
    async with pool.acquire() as conn:
        with pytest.raises(ValueError, match="ENDED_REASONS"):
            await agent_updates.end_open_attempt(conn, device_id, reason="the box was moved")
        for reason in agent_updates.ENDED_REASONS:
            assert await agent_updates.end_open_attempt(conn, device_id, reason=reason) == 0


# -- S42b Task 22: her machine_update, through the real plant ---------------------


def _her_ctx(sink: list[dict] | None = None):
    from pathlib import Path

    from app.tools.base import ToolContext

    return ToolContext(app=None, person=None, workspace_root=Path("/tmp"), facts_sink=sink)


async def _machine_update(name: str, sink: list[dict] | None = None) -> str:
    from app import tools

    return await tools.REGISTRY["machine_update"].executor({"machine": name}, _her_ctx(sink))


async def test_machine_update_of_an_offline_machine_is_a_cannot_that_records_its_fact(pool):
    """The tool's facts_sink reaches update_now (controller ruling): a
    machine_update that finds the machine offline records the connectivity
    fact it determined, then its own outcome — and raises the stated cannot."""
    from app.tools.base import ToolFailure

    await _enroll(pool, name="box")
    sink: list[dict] = []
    with pytest.raises(ToolFailure, match=r"^cannot: box is not connected \(last seen never\)"):
        await _machine_update("box", sink)
    assert sink == [
        {"device": "box", "connected": False},
        {
            "machine_update": "box",
            "hub": False,
            "outcome": "cannot",
            "version": VERSION,
            "confirmed": False,
        },
    ]


async def test_machine_update_is_confirmed_only_by_the_agents_reconnect(pool):
    """P8 through her tool: the agent's ok is a send; the tool waits, and says
    confirmed only once the agent reconnected on the hub's build — what the
    ledger holds, never what it meant to write."""
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD), door="host")
    sink: list[dict] = []
    run = asyncio.create_task(_machine_update("box", sink))
    frame = await device.answer_command(conn, output="staged; restarting")
    assert frame["envelope"]["capability"] == "daemon.update"
    await asyncio.sleep(0.3)
    assert not run.done(), "a reply is a claim: nothing is confirmed until the agent reconnects"
    assert await _outcome_of(pool, device_id) == "sent"
    await _close(conn, task)
    conn2, task2 = await _reconnect(pool, device, _facts(VERSION))
    said = await asyncio.wait_for(run, 6)
    assert f"box's agent reconnected on the hub's build {VERSION} (it ran {OLD})" in said
    assert sink[0] == {"device": "box", "connected": True}
    assert sink[-1] == {
        "machine_update": "box",
        "hub": True,  # it came in through the hub machine's own door
        "outcome": "confirmed",
        "version": VERSION,
        "confirmed": True,
    }
    await _close(conn2, task2)


async def test_machine_update_says_sent_when_no_reconnect_came_within_its_wait(pool, monkeypatch):
    monkeypatch.setattr(agent_updates, "WAIT_S", 0.2)
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    sink: list[dict] = []
    run = asyncio.create_task(_machine_update("box", sink))
    await device.answer_command(conn)
    said = await asyncio.wait_for(run, 3)
    assert said.startswith(f"Sent the hub's build {VERSION} to box (its agent ran {OLD}).")
    assert "Not confirmed yet" in said and "is confirmed" not in said
    assert sink[-1]["outcome"] == "sent" and sink[-1]["confirmed"] is False
    assert await _outcome_of(pool, device_id) == "sent"
    await _close(conn, task)


async def test_machine_update_refuses_the_engines_name_naming_the_door_machine_as_such(pool):
    """'hub' is the bundled engine's name (D8). The door is not identity — a
    relay on the hub comes in through the same loopback door — so the
    refusal names the machine whose agent came in that way, as that, and
    sends nothing anywhere."""
    from app.tools.base import ToolFailure

    _a, _da, conn_a, task_a = await _online(pool, "minipc", _facts(OLD), door="host")
    _b, _db, conn_b, task_b = await _online(pool, "laptop", _facts(OLD), door="tailnet")
    sink: list[dict] = []
    with pytest.raises(ToolFailure) as exc:
        await _machine_update("hub", sink)
    said = str(exc.value)
    assert said.startswith("cannot: 'hub' is the bundled engine's name")
    assert "One paired machine's agent came in through the hub machine's own door: minipc." in said
    assert "laptop" not in said and "is the hub machine" not in said
    assert sink == []
    assert _commands(conn_a) == [] and _commands(conn_b) == []
    assert await pool.fetchval("SELECT count(*) FROM agent_updates") == 0
    await _close(conn_a, task_a)
    await _close(conn_b, task_b)


async def test_machine_update_of_an_unpaired_name_lists_the_paired_ones(pool):
    from app.tools.base import ToolFailure

    await _enroll(pool, name="box")
    await _enroll(pool, name="laptop")
    with pytest.raises(ToolFailure) as exc:
        await _machine_update("dell")
    assert str(exc.value) == (
        "cannot: no paired machine named 'dell' — the paired machines are: box, laptop"
    )
    assert await pool.fetchval("SELECT count(*) FROM agent_updates") == 0


async def test_the_update_route_says_how_many_commands_the_restart_cancels(owner_client, pool):
    """F15 for the tile: the route returns the count beside the outcome."""
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    pending = asyncio.create_task(
        devices_ws.hub.command(
            pool, device_id=device_id, name="box", capability="system.info", args={}, timeout=5
        )
    )
    held = await asyncio.wait_for(conn.next_sent(), 2)  # never answered
    assert held["envelope"]["capability"] == "system.info"
    post = asyncio.create_task(owner_client.post(f"/api/v1/devices/{device_id}/update"))
    await device.answer_command(conn)
    resp = await asyncio.wait_for(post, 5)
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "sent" and body["in_flight"] == 1
    await _close(conn, task)
    with pytest.raises(devices.DeviceRefused):
        await pending


async def test_machine_update_never_sends_to_a_row_named_hub_before_d8(pool):
    """A row named 'hub' before D8 reserved the name (none live today) is
    still not what her "hub" names: the reserved name is refused before any
    row is chosen, so nothing is sent to it and nothing is recorded."""
    from app.tools.base import ToolFailure

    device_id, _device, conn, task = await _online(pool, "pc", _facts(OLD))
    await pool.execute("UPDATE devices SET name = 'hub' WHERE id = $1", device_id)
    sink: list[dict] = []
    with pytest.raises(ToolFailure) as exc:
        await _machine_update("hub", sink)
    assert str(exc.value).startswith("cannot: 'hub' is the bundled engine's name")
    assert "No paired machine's agent came in through the hub machine's own door." in str(exc.value)
    assert sink == [] and _commands(conn) == []
    assert await pool.fetchval("SELECT count(*) FROM agent_updates") == 0
    await _close(conn, task)
