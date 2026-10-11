"""T7 (S30b, 2026-10-11): device_admin_path — Nova installs and removes a
machine's standing admin path herself.

Owner ruling 2026-09-03 binds: nothing asks and nothing refuses. The one OS
prompt per machine (Windows' UAC click) is the operating system's, answered by
the owner at that machine's screen — not a gate of ours. Success is only ever
what the agent's own read-back proved (its result meta); anything else is a
stated failure.

Criteria (tracker .epics/s30b.md, T7):
  C1 registered; schema {device, action: install|uninstall}; not reads_only;
     the description names the one prompt per OS, device_info for status and
     the surface.
  C2 one admin.install / admin.uninstall frame, args {}, sent with
     COMMAND_TIMEOUT_SECONDS (over the agent's own 110 s command bound); the
     fact {"admin_path", "machine", "installed"} on every result frame.
  C3 ok words only from meta (installed + proof / installed false +
     pending_restart); an ok frame without that meta is not confirmed.
  C4 the agent's cannot / declined words restated with the machine's name,
     the owner's one step kept verbatim; no admin path to remove; an old agent
     -> machine_update; no answer -> not known, device_info.
  C5 (pins elsewhere) test_tools_registry +1, test_capability_coverage
     EXCUSED, test_live_facts refuses it unasked, test_no_approvals unchanged.
"""

from __future__ import annotations

import asyncio

import pytest

from app import devices_ws, tools
from app.tools import devices as device_tools
from tests.conftest import requires_db
from tests.test_devices_ws import _close, _command_frames, _connect, _ctx, _person

TOOL = "device_admin_path"

INSTALLED_SUDO = {
    "installed": True,
    "kind": "sudoers",
    "route": "sudo -n",
    "proof": "an elevated round trip through the path ran as root (euid 0)",
}
INSTALLED_UAC = {
    "installed": True,
    "kind": "task",
    "route": "uac",
    "proof": (
        "an elevated round trip through the path ran as DELL\\owner, elevated (integrity High)"
    ),
}
REMOVED = {"installed": False, "kind": "none", "route": "path"}
ASIDE = "C:\\Program Files\\Nova\\novad-admin-removed-1a2b3c4d.exe"
SUDO_CANNOT = (
    "cannot: installing the admin path needs root once and sudo here asks for a password — "
    "the owner runs this once on this machine: sudo '/home/u/.local/bin/novad' admin install "
    "--user u"
)
DECLINED = (
    "the UAC prompt on this machine was declined — nothing was installed; the owner clicks "
    "Yes on it to install the admin path"
)
NOBODY = (
    "cannot: nobody is signed in on this machine to answer the UAC prompt — the owner signs "
    "in at its screen, then clicks Yes on the one UAC prompt"
)
NO_PATH = "cannot: no admin path on this machine"


@pytest.fixture(autouse=True)
def _no_checkout(monkeypatch):
    monkeypatch.delenv("NOVA_CHECKOUT", raising=False)
    monkeypatch.delenv("NOVA_REPO_HOST", raising=False)


def _frame(device, envelope, *, ok=True, output="", error=None, meta=None):
    frame = device.result(envelope, ok=ok, output=output, exit_code=None, error=error)
    if meta is not None:
        frame["meta"] = meta
    return frame


async def _call(pool, conn, device, args, **answer):
    """Dispatch device_admin_path, answer its one command frame; returns
    (result, ok, facts, the command frames sent)."""
    person = await _person(pool)
    facts: list[dict] = []

    async def reply():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command"
        conn.feed(_frame(device, frame["envelope"], **answer))

    task = asyncio.create_task(reply())
    result, ok = await tools.dispatch(TOOL, args, _ctx(person, facts=facts))
    if not _command_frames(conn):
        task.cancel()
        pytest.fail(f"{TOOL} sent no command frame; it said: {result}")
    await asyncio.wait_for(task, 2)
    return result, ok, facts, _command_frames(conn)


def _admin_facts(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "admin_path" in f]


# -- C1: registered, schema, description ----------------------------------------


def test_c1_it_is_registered_and_advertised():
    assert TOOL in tools.REGISTRY
    assert TOOL in {entry["function"]["name"] for entry in tools.advertised_tools()}


def test_c1_the_schema_takes_a_device_and_install_or_uninstall():
    params = tools.REGISTRY[TOOL].parameters
    assert set(params["properties"]) == {"device", "action"}
    assert params["properties"]["action"]["enum"] == ["install", "uninstall"]
    assert sorted(params["required"]) == ["action", "device"]
    assert params.get("additionalProperties") is False


def test_c1_it_changes_something():
    tool = tools.REGISTRY[TOOL]
    assert tool.reads_only is False
    assert tool.ephemeral is False


def test_c1_the_description_names_the_one_prompt_status_and_the_surface():
    text = tools.REGISTRY[TOOL].description
    assert "UAC" in text
    assert "passwordless sudo" in text
    assert "device_info" in text
    assert "root/admin" in text
    assert "approval" not in text.casefold()


@requires_db
async def test_c1_an_unknown_action_runs_nothing(pool):
    _id, _device, conn, task = await _connect(pool, name="mini")
    person = await _person(pool)
    result, ok = await tools.dispatch(
        TOOL, {"device": "mini", "action": "reinstall"}, _ctx(person, facts=[])
    )
    assert ok is False
    # the schema check refuses it before the executor: nothing is resolved or sent
    assert 'must be one of "install", "uninstall", got "reinstall"' in result
    assert _command_frames(conn) == []
    await _close(conn, task)


# -- C2: the frame, the timeout, the fact ---------------------------------------


@requires_db
@pytest.mark.parametrize(
    ("action", "capability", "meta"),
    [("install", "admin.install", INSTALLED_SUDO), ("uninstall", "admin.uninstall", REMOVED)],
)
async def test_c2_one_frame_with_the_actions_capability_and_no_args(pool, action, capability, meta):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, _facts, frames = await _call(
        pool, conn, device, {"device": "mini", "action": action}, meta=meta
    )
    assert ok is True, result
    (frame,) = frames
    assert frame["envelope"]["capability"] == capability
    assert frame["envelope"]["args"] == {}
    await _close(conn, task)


@requires_db
async def test_c2_it_waits_past_the_agents_own_command_bound(pool, monkeypatch):
    """The agent bounds a command at 110 s (apps/novad client.CommandTimeout)
    and its UAC wait inside that; core waits the full command bound for its
    answer — never a shorter wait that would call a pending click a failure."""
    seen: list[float] = []
    real = devices_ws.hub.command

    async def spy(pool_, **kw):
        seen.append(kw["timeout"])
        return await real(pool_, **kw)

    monkeypatch.setattr(devices_ws.hub, "command", spy)
    _id, device, conn, task = await _connect(pool, name="DELL-XPS-8950")
    result, ok, _f, _fr = await _call(
        pool, conn, device, {"device": "DELL-XPS-8950", "action": "install"}, meta=INSTALLED_UAC
    )
    assert ok is True, result
    assert seen == [device_tools.COMMAND_TIMEOUT_SECONDS]
    assert device_tools.COMMAND_TIMEOUT_SECONDS > 110
    await _close(conn, task)


@requires_db
async def test_c2_the_fact_says_what_was_read_back(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    _r, _ok, facts, _fr = await _call(
        pool, conn, device, {"device": "mini", "action": "install"}, meta=INSTALLED_SUDO
    )
    assert _admin_facts(facts) == [{"admin_path": "install", "machine": "mini", "installed": True}]
    await _close(conn, task)


@requires_db
async def test_c2_a_failed_frame_files_installed_none_never_a_guess(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    _r, ok, facts, _fr = await _call(
        pool, conn, device, {"device": "mini", "action": "install"}, ok=False, error=SUDO_CANNOT
    )
    assert ok is False
    assert _admin_facts(facts) == [{"admin_path": "install", "machine": "mini", "installed": None}]
    assert all("device" not in f for f in _admin_facts(facts))
    await _close(conn, task)


# -- C3: success only from the read-back ----------------------------------------


@requires_db
async def test_c3_install_ok_states_the_read_back_proof(pool):
    _id, device, conn, task = await _connect(pool, name="Beelink Mini S")
    result, ok, _f, _fr = await _call(
        pool,
        conn,
        device,
        {"device": "Beelink Mini S", "action": "install"},
        output="admin path installed (a sudoers rule) through sudo -n, with no prompt; proven: …",
        meta=INSTALLED_SUDO,
    )
    assert ok is True
    first = result.splitlines()[0]
    assert first.startswith("Beelink Mini S: admin path installed (a sudoers rule)")
    assert "through sudo -n, with no prompt" in first
    assert "proven by the agent's read-back: " + INSTALLED_SUDO["proof"] in first
    await _close(conn, task)


@requires_db
async def test_c3_install_over_uac_states_the_owners_click_and_who_it_ran_as(pool):
    _id, device, conn, task = await _connect(pool, name="DELL-XPS-8950")
    result, ok, _f, _fr = await _call(
        pool, conn, device, {"device": "DELL-XPS-8950", "action": "install"}, meta=INSTALLED_UAC
    )
    assert ok is True
    assert "(an elevated scheduled task)" in result
    assert "after the owner's Yes on the UAC prompt" in result
    assert "DELL\\owner, elevated" in result
    await _close(conn, task)


@requires_db
@pytest.mark.parametrize(
    "meta",
    [
        None,
        {},
        {"installed": False, "kind": "none"},
        {"installed": "yes", "kind": "sudoers", "proof": "x"},
        {"installed": True, "kind": "sudoers", "route": "sudo -n"},
        {"installed": True, "kind": "sudoers", "route": "sudo -n", "proof": "  "},
    ],
)
async def test_c3_an_install_ok_without_the_read_back_is_not_confirmed(pool, meta):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, _fr = await _call(
        pool,
        conn,
        device,
        {"device": "mini", "action": "install"},
        output="admin path installed",
        meta=meta,
    )
    assert ok is False
    assert "not confirmed" in result
    assert "admin path installed (" not in result
    assert _admin_facts(facts)[0]["installed"] is None
    await _close(conn, task)


@requires_db
async def test_c3_uninstall_ok_says_none_of_it_is_left(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, _fr = await _call(
        pool, conn, device, {"device": "mini", "action": "uninstall"}, meta=REMOVED
    )
    assert ok is True
    first = result.splitlines()[0]
    assert first.startswith("mini: admin path removed")
    assert "the agent's read-back found none of it left" in first
    assert _admin_facts(facts) == [
        {"admin_path": "uninstall", "machine": "mini", "installed": False}
    ]
    await _close(conn, task)


@requires_db
async def test_c3_uninstall_with_a_pending_aside_names_it_and_never_says_none_left(pool):
    _id, device, conn, task = await _connect(pool, name="DELL-XPS-8950")
    result, ok, _f, _fr = await _call(
        pool,
        conn,
        device,
        {"device": "DELL-XPS-8950", "action": "uninstall"},
        meta={**REMOVED, "pending_restart": [ASIDE]},
    )
    assert ok is True
    assert ASIDE in result
    assert "deleted at the next restart" in result
    assert "scheduled, not proven" in result
    assert "none of it left" not in result
    await _close(conn, task)


@requires_db
@pytest.mark.parametrize("meta", [None, {}, {"installed": True, "kind": "sudoers"}])
async def test_c3_an_uninstall_ok_without_the_read_back_is_not_confirmed(pool, meta):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, _f, _fr = await _call(
        pool, conn, device, {"device": "mini", "action": "uninstall"}, meta=meta
    )
    assert ok is False
    assert "not confirmed" in result
    assert "admin path removed" not in result
    await _close(conn, task)


# -- C4: failures restated --------------------------------------------------------


@requires_db
async def test_c4_the_sudo_cannot_names_the_machine_and_keeps_the_command(pool):
    _id, device, conn, task = await _connect(pool, name="Beelink Mini S")
    result, ok, _f, _fr = await _call(
        pool,
        conn,
        device,
        {"device": "Beelink Mini S", "action": "install"},
        ok=False,
        error=SUDO_CANNOT,
    )
    assert ok is False
    assert "sudo '/home/u/.local/bin/novad' admin install --user u" in result
    assert "on Beelink Mini S" in result
    assert "this machine" not in result
    await _close(conn, task)


@requires_db
@pytest.mark.parametrize("error", [DECLINED, NOBODY])
async def test_c4_the_uac_words_name_the_machine_and_the_owners_click(pool, error):
    _id, device, conn, task = await _connect(pool, name="DELL-XPS-8950")
    result, ok, _f, _fr = await _call(
        pool,
        conn,
        device,
        {"device": "DELL-XPS-8950", "action": "install"},
        ok=False,
        error=error,
    )
    assert ok is False
    assert "DELL-XPS-8950" in result
    assert "clicks Yes" in result
    assert "this machine" not in result
    await _close(conn, task)


@requires_db
async def test_c4_uninstall_with_no_path_says_nothing_to_remove(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, _f, _fr = await _call(
        pool, conn, device, {"device": "mini", "action": "uninstall"}, ok=False, error=NO_PATH
    )
    assert ok is False
    assert result.startswith("Error: cannot: no admin path on mini — nothing to remove")
    await _close(conn, task)


@requires_db
@pytest.mark.parametrize("action", ["install", "uninstall"])
async def test_c4_an_agent_before_the_admin_path_needs_machine_update(pool, action):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, _f, frames = await _call(
        pool,
        conn,
        device,
        {"device": "mini", "action": action},
        ok=False,
        error=f'unknown capability "admin.{action}"',
    )
    assert ok is False
    assert "mini's agent predates the admin path" in result
    assert "machine_update" in result
    assert len(frames) == 1
    await _close(conn, task)


@requires_db
async def test_c4_no_answer_is_stated_as_not_known(pool, monkeypatch):
    async def silent(pool_, **kw):
        raise device_tools.devices.DeviceRefused("DELL-XPS-8950 did not answer within 120s")

    monkeypatch.setattr(devices_ws.hub, "command", silent)
    _id, _device, conn, task = await _connect(pool, name="DELL-XPS-8950")
    person = await _person(pool)
    result, ok = await tools.dispatch(
        TOOL, {"device": "DELL-XPS-8950", "action": "install"}, _ctx(person, facts=[])
    )
    assert ok is False
    assert "did not answer" in result
    assert "whether the admin path is installed on DELL-XPS-8950 is not known" in result
    assert "device_info" in result
    await _close(conn, task)
