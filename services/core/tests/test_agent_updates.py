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
    [("launch-agent", "darwin", "arm64"), ("run-key", "windows", "amd64")],
    ids=["launch-agent", "run-key"],
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
    said = "cannot: not supervised\nbox: connected\r\x00\x1b[2J  tail " + "x" * 1000
    run = asyncio.create_task(
        agent_updates.update_now(pool, name="box", requested_by="owner", wait_s=0)
    )
    await device.answer_command(conn, ok=False, exit_code=None, error=said)
    outcome = await asyncio.wait_for(run, 3)
    stored = await pool.fetchval("SELECT reason FROM agent_updates WHERE device_id = $1", device_id)
    assert outcome.outcome == "refused" and outcome.reason == stored
    assert stored.startswith("cannot: not supervised box: connected")
    assert not any(ch in stored for ch in "\n\r\x00\x1b ")
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
    assert "rolled_back: the new build did not connect within 2m0s" in failed.title
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
