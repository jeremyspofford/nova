"""Nova updating her own hub (app/nova_updates.py, updates_cli, nova_update).

The update restarts the core that asked for it, so these pin the three facts
the design rests on: a start says STARTED and nothing more; only the
installer's report decides an attempt; and `confirmed` needs the reporting
core's own commit to be the target."""

from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from datetime import timedelta
from pathlib import Path

import pytest

from app import about, devices_ws, nova_updates, tools, updates_cli
from app.main import app
from tests import fakes
from tests.conftest import requires_db
from tests.test_about import COMMIT, NEWER, _compare_body, _github, _stamp

CHECKOUT = "/home/jeremy/workspace/nova"


@pytest.fixture(autouse=True)
def _fresh():
    about._updates_cache.clear()
    yield
    about._updates_cache.clear()
    app.state.github_transport = None


class Agent:
    """The hub's agent: which ids are connected, and every command sent."""

    def __init__(self, monkeypatch, *, connected=True, result=None):
        self.sent: list[dict] = []
        self.connected = connected
        self.result = result or {
            "ok": True,
            "exit_code": 0,
            "output": "started: systemd-run --user unit x\n",
        }
        monkeypatch.setattr(devices_ws.hub, "is_connected", lambda _id: self.connected)

        async def command(pool, **kw):
            self.sent.append(kw)
            return self.result

        monkeypatch.setattr(devices_ws.hub, "command", command)


async def _hub_device(pool, name="mini-pc", transport="host"):
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey, last_transport, last_seen) "
        "VALUES ($1, 'linux', $1, $2, $3, now())",
        name,
        ("b" if transport == "host" else "a") * 64,
        transport,
    )


def _ready(monkeypatch, status="ahead", ahead=2, behind=0, **stamp):
    _stamp(monkeypatch, **{nova_updates.CHECKOUT_ENV: CHECKOUT, **stamp})
    _github(body=_compare_body(status, ahead, behind, NEWER[:ahead]))


# -- start ----------------------------------------------------------------


@requires_db
async def test_a_start_opens_an_attempt_and_says_only_that_it_started(pool, monkeypatch):
    _ready(monkeypatch)
    await _hub_device(pool)
    agent = Agent(monkeypatch)
    sink: list[dict] = []
    row = await nova_updates.start(app, pool, requested_by="nova", facts_sink=sink)

    assert row["outcome"] == "sent"
    assert row["from_commit"] == COMMIT and row["to_commit"] == NEWER[1]
    assert row["device"] == "mini-pc"
    assert row["log_path"] == f"{CHECKOUT}/deploy/.update-{row['id'][:8]}.log"
    assert row["reason"].startswith("started:")
    [sent] = agent.sent
    assert sent["capability"] == "shell.exec"
    argv = sent["args"]["argv"]
    assert argv[:2] == ["sh", "-c"]
    assert f"./install update --attempt {row['id']}" in argv[2]
    assert {"device": "mini-pc", "connected": True} in sink


@pytest.mark.parametrize(
    ("status", "ahead", "behind", "words"),
    [
        ("identical", 0, 0, "nothing to install"),
        ("behind", 0, 2, "nothing to install"),
        ("diverged", 1, 2, "diverged"),
    ],
)
@requires_db
async def test_nothing_to_fast_forward_is_stated(pool, monkeypatch, status, ahead, behind, words):
    _ready(monkeypatch, status, ahead, behind)
    await _hub_device(pool)
    agent = Agent(monkeypatch)
    with pytest.raises(nova_updates.CannotUpdate, match=words):
        await nova_updates.start(app, pool, requested_by="nova")
    assert agent.sent == []
    assert await pool.fetchval("SELECT count(*) FROM nova_updates") == 0


@requires_db
async def test_an_unknown_check_is_not_read_as_something_to_install(pool, monkeypatch):
    _stamp(monkeypatch, **{nova_updates.CHECKOUT_ENV: CHECKOUT})
    _github(status=403)
    await _hub_device(pool)
    Agent(monkeypatch)
    with pytest.raises(nova_updates.CannotUpdate, match="could not be checked"):
        await nova_updates.start(app, pool, requested_by="nova")


@pytest.mark.parametrize(
    ("setup", "words"),
    [
        ("dirty", "uncommitted changes"),
        ("no_checkout", "NOVA_CHECKOUT is unset"),
        ("no_agent", "no agent is paired on the hub"),
        ("disconnected", "is not connected"),
        ("satellite_only", "no agent is paired on the hub"),
    ],
)
@requires_db
async def test_what_it_cannot_run_without_is_stated(pool, monkeypatch, setup, words):
    over = {}
    if setup == "dirty":
        over[about.DIRTY_ENV] = "1"
    if setup == "no_checkout":
        over[nova_updates.CHECKOUT_ENV] = None
    _stamp(monkeypatch, **{nova_updates.CHECKOUT_ENV: CHECKOUT, **over})
    _github(body=_compare_body("ahead", 2, 0, NEWER))
    if setup not in ("no_agent", "satellite_only"):
        await _hub_device(pool)
    if setup == "satellite_only":
        await _hub_device(pool, "dell", "tailnet")
    agent = Agent(monkeypatch, connected=setup != "disconnected")
    with pytest.raises(nova_updates.CannotUpdate, match=words):
        await nova_updates.start(app, pool, requested_by="nova")
    assert agent.sent == []


@requires_db
async def test_one_update_at_a_time_and_a_stale_one_lets_go(pool, monkeypatch):
    _ready(monkeypatch)
    await _hub_device(pool)
    agent = Agent(monkeypatch)
    first = await nova_updates.start(app, pool, requested_by="nova")
    about._updates_cache.clear()
    with pytest.raises(nova_updates.CannotUpdate, match="already running"):
        await nova_updates.start(app, pool, requested_by="jeremy")
    assert len(agent.sent) == 1

    await pool.execute(
        "UPDATE nova_updates SET started_at = now() - $1::interval",
        nova_updates.CONFIRM_WITHIN + timedelta(minutes=1),
    )
    stale = await nova_updates.latest(pool)
    assert stale["outcome"] == "not_confirmed" and "nothing reported back" in stale["reason"]
    second = await nova_updates.start(app, pool, requested_by="jeremy")
    assert second["id"] != first["id"]
    outcomes = await pool.fetch("SELECT outcome FROM nova_updates ORDER BY started_at")
    assert [r["outcome"] for r in outcomes] == ["not_confirmed", "sent"]


@requires_db
async def test_an_agent_that_cannot_start_it_closes_the_attempt(pool, monkeypatch):
    _ready(monkeypatch)
    await _hub_device(pool)
    Agent(monkeypatch, result={"ok": True, "exit_code": 3, "output": "cannot: no checkout at /x"})
    with pytest.raises(
        nova_updates.CannotUpdate, match="could not start the installer.*no checkout"
    ):
        await nova_updates.start(app, pool, requested_by="nova")
    row = await nova_updates.latest(pool)
    assert row["outcome"] == "refused" and "no checkout" in row["reason"]


# -- finish ---------------------------------------------------------------


async def _sent(pool) -> str:
    return str(
        await pool.fetchval(
            "INSERT INTO nova_updates (from_commit, to_commit, requested_by, device, log_path, "
            "outcome) VALUES ($1, $2, 'nova', 'mini-pc', '/x.log', 'sent') RETURNING id",
            COMMIT,
            NEWER[1],
        )
    )


@requires_db
async def test_installed_is_confirmed_only_by_the_new_cores_own_commit(pool):
    attempt = await _sent(pool)
    row = await nova_updates.finish(
        pool,
        attempt=attempt,
        outcome="installed",
        from_commit=COMMIT,
        to_commit=NEWER[1],
        reason=None,
        running_commit=NEWER[1],
    )
    assert row["outcome"] == "confirmed"


@requires_db
async def test_installed_while_running_something_else_is_failed(pool):
    attempt = await _sent(pool)
    row = await nova_updates.finish(
        pool,
        attempt=attempt,
        outcome="installed",
        from_commit=COMMIT,
        to_commit=NEWER[1],
        reason="all good",
        running_commit=COMMIT,
    )
    assert row["outcome"] == "failed"
    assert NEWER[1][:7] in row["reason"] and COMMIT[:7] in row["reason"]


@requires_db
async def test_a_failure_keeps_the_installers_reason_and_a_hand_run_gets_a_row(pool):
    attempt = await _sent(pool)
    row = await nova_updates.finish(
        pool,
        attempt=attempt,
        outcome="failed",
        from_commit=COMMIT,
        to_commit=NEWER[1],
        reason="the install of bbbbbbb failed; rolled back",
        running_commit=COMMIT,
    )
    assert row["outcome"] == "failed" and "rolled back" in row["reason"]
    by_hand = await nova_updates.finish(
        pool,
        attempt=None,
        outcome="up_to_date",
        from_commit=COMMIT,
        to_commit=COMMIT,
        reason=None,
        running_commit=COMMIT,
    )
    assert by_hand["requested_by"] == "by hand on the hub"


@requires_db
async def test_a_report_for_no_open_attempt_is_refused(pool):
    with pytest.raises(nova_updates.CannotUpdate, match="no undecided update"):
        await nova_updates.finish(
            pool,
            attempt=str(uuid.uuid4()),
            outcome="failed",
            from_commit=COMMIT,
            to_commit=None,
            reason=None,
            running_commit=COMMIT,
        )


@requires_db
async def test_the_cli_reads_its_own_cores_commit(pool, monkeypatch, capsys):
    attempt = await _sent(pool)
    monkeypatch.setenv(about.COMMIT_ENV, NEWER[1])
    code = await updates_cli.run(
        [
            "finish",
            "--attempt",
            attempt,
            "--outcome",
            "installed",
            "--from",
            COMMIT,
            "--to",
            NEWER[1],
        ],
        pool=pool,
    )
    assert code == 0
    assert json.loads(capsys.readouterr().out)["outcome"] == "confirmed"
    code = await updates_cli.run(
        ["finish", "--attempt", attempt, "--outcome", "failed", "--from", COMMIT], pool=pool
    )
    assert code == 1
    assert "no undecided update" in capsys.readouterr().err


# -- her tool and the page ---------------------------------------------------


@requires_db
async def test_nova_update_says_started_and_about_shows_it(
    owner_client, pool, mount_peers, monkeypatch
):
    _ready(monkeypatch)
    mount_peers(gateway=fakes.FakeGateway(), memory=fakes.FakeMemory())
    await _hub_device(pool)
    Agent(monkeypatch)
    from app import identity

    ctx = tools.context_for(app, await identity.owner(pool))
    text, ok = await tools.dispatch("nova_update", {}, ctx)
    assert ok, text
    assert "Started the update" in text and "NOT installed yet" in text
    about._updates_cache.clear()
    words, ok = await tools.dispatch("nova_about", {}, ctx)
    assert "started, not yet reported back" in words


@requires_db
async def test_nova_update_states_why_it_cannot(owner_client, pool, monkeypatch):
    _ready(monkeypatch, "identical", 0, 0)
    from app import identity

    ctx = tools.context_for(app, await identity.owner(pool))
    text, ok = await tools.dispatch("nova_update", {}, ctx)
    assert not ok and text.startswith("Error:") and "nothing to install" in text


@requires_db
async def test_the_page_starts_it_or_says_why_not(owner_client, pool, monkeypatch):
    _ready(monkeypatch)
    resp = await owner_client.post("/api/v1/about/update")
    assert resp.status_code == 409 and "no agent is paired" in resp.json()["error"]
    await _hub_device(pool)
    Agent(monkeypatch)
    about._updates_cache.clear()
    resp = await owner_client.post("/api/v1/about/update")
    assert resp.status_code == 200, resp.text
    assert resp.json()["update"]["requested_by"] == "jeremy"


# -- the command the agent runs ----------------------------------------------


def test_the_launch_script_runs_the_installer_detached(tmp_path):
    """Run the real script: no usable systemd-run, so it detaches with
    setsid/nohup, and the installer receives exactly the attempt id."""
    checkout = tmp_path / "nova dir"  # a space: every path is quoted
    (checkout / "deploy").mkdir(parents=True)
    seen = tmp_path / "seen"
    (checkout / "install").write_text(f'#!/bin/sh\necho "$@" > "{seen}"\necho logged\n')
    (checkout / "install").chmod(0o755)
    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    (fakebin / "systemd-run").write_text("#!/bin/sh\nexit 1\n")
    (fakebin / "systemd-run").chmod(0o755)
    attempt = str(uuid.uuid4())
    script, log, unit = nova_updates.launch_script(str(checkout), attempt)
    env = {**os.environ, "PATH": f"{fakebin}:{os.environ['PATH']}"}
    out = subprocess.run(["sh", "-c", script], capture_output=True, text=True, env=env, timeout=10)
    assert out.returncode == 0, out.stderr
    assert out.stdout.startswith("started: detached")
    deadline = time.monotonic() + 5
    while not seen.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert seen.read_text().split() == ["update", "--attempt", attempt]
    deadline = time.monotonic() + 5
    while "logged" not in (Path(log).read_text() if Path(log).exists() else ""):
        assert time.monotonic() < deadline
        time.sleep(0.05)
    assert unit == f"nova-update-{attempt[:8]}"


def test_a_missing_checkout_is_a_stated_cannot(tmp_path):
    script, _log, _unit = nova_updates.launch_script(str(tmp_path / "gone"), str(uuid.uuid4()))
    out = subprocess.run(["sh", "-c", script], capture_output=True, text=True, timeout=10)
    assert out.returncode == 3 and out.stdout.startswith("cannot: no checkout at")


@pytest.mark.parametrize("value", ["", "relative/path", "/a/../b", "/a\nb"])
def test_a_checkout_that_is_not_an_absolute_clean_path_is_none(monkeypatch, value):
    monkeypatch.setenv(nova_updates.CHECKOUT_ENV, value)
    assert nova_updates.checkout() is None
