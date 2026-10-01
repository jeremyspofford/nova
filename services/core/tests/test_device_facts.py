"""device_facts (S42a): what an agent says about its machine, checked, and
the roles derived from it. Pure — no database — so this is the fast corpus
that pins the shapes both sides of the wire agree on."""

from __future__ import annotations

import copy
from datetime import UTC, datetime

import pytest

from app import device_facts as df

AT = datetime(2026, 9, 26, 10, 0, tzinfo=UTC)

WINDOWS = {
    "v": 2,
    "agent": {"version": "0.2.0", "mode": "foreground", "session_interactive": True},
    "os": {
        "goos": "windows",
        "arch": "amd64",
        "version": "Windows 11 Pro 24H2 (build 26100)",
        "wsl": None,
    },
    "hostname": "PC-ONE",
    "machine_uid": "a" * 64,
}
WSL = {
    "v": 2,
    "agent": {"version": "0.2.0", "mode": "systemd-user", "session_interactive": False},
    "os": {
        "goos": "linux",
        "arch": "amd64",
        "version": "Ubuntu 26.04 LTS",
        "wsl": {"distro": "Ubuntu-26.04"},
    },
    "hostname": "PC-ONE",
    "machine_uid": "b" * 64,
}


def _with(base: dict, path: str, value) -> dict:
    out = copy.deepcopy(base)
    node = out
    *heads, last = path.split(".")
    for head in heads:
        node = node[head]
    node[last] = value
    return out


def test_valid_auth_facts_are_kept_in_their_shape():
    assert df.validate_auth(WINDOWS) == WINDOWS
    assert df.validate_auth(WSL) == WSL


def test_unknown_keys_are_dropped_never_stored():
    assert df.validate_auth({**WINDOWS, "build": "abc", "extra": 1}) == WINDOWS


@pytest.mark.parametrize(
    "facts,reason",
    [
        ({**WINDOWS, "pad": "x" * 5000}, "over the 4096-byte cap"),
        (_with(WINDOWS, "v", 1), "version"),
        (_with(WINDOWS, "agent.mode", "daemon"), "mode"),
        (_with(WINDOWS, "agent.session_interactive", "yes"), "session_interactive"),
        (_with(WINDOWS, "os.goos", "freebsd"), "goos"),
        (_with(WINDOWS, "os.wsl", {"distro": "Ubuntu"}), "only possible on linux"),
        (_with(WINDOWS, "machine_uid", "ABC"), "machine_uid"),
        (_with(WINDOWS, "hostname", "h" * 256), "longer than 255"),
        ("not an object", "must be an object"),
        # Fix round 1: a NUL byte is accepted by json.loads and by a bare
        # isinstance/length check, but postgres refuses it in text/jsonb
        # outright (UntranslatableCharacterError) — caught here, naming the
        # field, so the database is never where this is found out.
        (_with(WINDOWS, "os.version", "Windows 11 Pro\x00"), "facts.os.version"),
        # A lone UTF-16 surrogate is likewise accepted by json.loads (it is a
        # valid string escape) but has no UTF-8 encoding; _encoded_size must
        # turn the UnicodeEncodeError it would otherwise raise into a named
        # FactsRejected rather than let it escape uncaught.
        (_with(WINDOWS, "hostname", "PC-ONE\ud800"), "surrogate"),
    ],
)
def test_facts_an_agent_could_not_send_are_refused_with_the_reason(facts, reason):
    with pytest.raises(df.FactsRejected) as exc:
        df.validate_auth(facts)
    assert reason in exc.value.reason


def test_an_empty_machine_uid_is_unknown_not_refused():
    assert df.validate_auth(_with(WINDOWS, "machine_uid", ""))["machine_uid"] == ""
    assert df.machine_uid(_with(WINDOWS, "machine_uid", "")) is None


def test_a_frame_keeps_its_known_sections_and_drops_the_rest():
    frame = {
        "type": "facts",
        "net": {
            "ifaces": [
                {
                    "name": "wlp2s0",
                    "mac": "AA:BB:CC:DD:EE:FF",
                    "ipv4_cidr": ["192.0.2.10/24"],
                    "up": True,
                }
            ]
        },
        "unreadable": [{"item": "machine_uid", "reason": "no id"}],
        "power": {"womp": True},
    }
    assert df.validate_frame(frame) == {
        "net": {
            "ifaces": [
                {
                    "name": "wlp2s0",
                    "mac": "aa:bb:cc:dd:ee:ff",
                    "ipv4_cidr": ["192.0.2.10/24"],
                    "up": True,
                }
            ]
        },
        "unreadable": [{"item": "machine_uid", "reason": "no id"}],
    }


@pytest.mark.parametrize(
    "frame,reason",
    [
        ({"type": "facts"}, "carries none of"),
        ({"type": "facts", "net": {"ifaces": "x"}}, "must be a list"),
        (
            {
                "type": "facts",
                "net": {"ifaces": [{"name": "e", "mac": "zz", "ipv4_cidr": [], "up": True}]},
            },
            "hardware address",
        ),
        (
            {
                "type": "facts",
                "net": {
                    "ifaces": [{"name": "e", "mac": "", "ipv4_cidr": ["300.1.1.1/24"], "up": True}]
                },
            },
            "not an IPv4",
        ),
        ({"type": "facts", "unreadable": [{"item": "x"}] * 33}, "more than 32"),
        ({"type": "facts", "unreadable": [], "pad": "x" * 17000}, "over the 16384-byte cap"),
        (
            {"type": "facts", "unreadable": [{"item": "x\x00", "reason": "y"}]},
            "unreadable[0].item",
        ),
        (
            {"type": "facts", "unreadable": [{"item": "x", "reason": "y\ud800"}]},
            "surrogate",
        ),
    ],
)
def test_a_frame_that_does_not_fit_is_refused_with_the_reason(frame, reason):
    with pytest.raises(df.FactsRejected) as exc:
        df.validate_frame(frame)
    assert reason in exc.value.reason


def _roles(**kw) -> dict:
    base = {
        "platform": "windows",
        "facts": WINDOWS,
        "facts_at": AT,
        "connected": True,
        "last_seen": AT,
    }
    base.update(kw)
    return df.derive_roles(**base)


def test_a_connected_native_agent_has_its_hands_and_its_facts():
    roles = _roles()
    assert roles["hands"] == {"state": "available", "reason": "connected now"}
    assert roles["facts"]["state"] == "available" and AT.isoformat() in roles["facts"]["reason"]


def test_every_role_on_an_agent_inside_wsl_says_the_windows_agent_owns_it():
    roles = _roles(platform="linux", facts=WSL)
    assert roles["hands"] == {"state": "cannot", "reason": df.WSL_REASON}
    assert roles["facts"] == {"state": "cannot", "reason": df.WSL_REASON}
    assert df.WSL_REASON == "cannot: this machine's Windows agent owns it"


# Review focus 1: the Dell's WSL agent on the day S42a deploys is exactly this.
def test_an_agent_without_facts_keeps_its_hands_and_says_why_facts_are_unknown():
    roles = _roles(platform="linux", facts=None, facts_at=None)
    assert roles["hands"]["state"] == "available"
    assert roles["facts"]["state"] == "unknown" and "predates S42a" in roles["facts"]["reason"]


def test_an_offline_agent_cannot_use_its_hands_and_says_when_it_was_seen():
    roles = _roles(connected=False)
    assert roles["hands"]["state"] == "cannot"
    assert roles["hands"]["reason"] == f"cannot: not connected (last seen {AT.isoformat()})"
    assert (
        _roles(connected=False, last_seen=None)["hands"]["reason"]
        == "cannot: not connected (last seen never)"
    )


def test_an_unknown_platform_cannot_use_its_hands():
    assert _roles(platform="unknown", facts=None, facts_at=None)["hands"]["state"] == "cannot"


def test_agent_view_is_the_one_shape():
    view = df.agent_view(
        name="PC-ONE",
        platform="windows",
        hostname="PC-ONE",
        connected=True,
        last_seen=AT,
        facts=WINDOWS,
        facts_at=AT,
    )
    # Pin moved deliberately for S42b Task 16: mode, starts, build, hub,
    # last_update and folders are core's own reading of the agent's update
    # outcome, its folders, how it starts, and its build against the hub's.
    # Pin moved deliberately again for Task 16b: acting is what she needs to
    # act on this machine without being told (P29), said as sentences.
    assert set(view) == {
        "name",
        "platform",
        "hostname",
        "connected",
        "last_seen",
        "facts_at",
        "os",
        "wsl",
        "agent_version",
        "machine",
        "roles",
        "mode",
        "starts",
        "build",
        "hub",
        "last_update",
        "folders",
        "acting",
    }
    assert view["acting"] == ["how it runs: unknown — this agent predates S42b and does not say"]
    assert view["os"] == "Windows 11 Pro 24H2 (build 26100)"
    assert view["wsl"] is None and view["machine"] == "a" * 64 and view["agent_version"] == "0.2.0"
    wsl_view = df.agent_view(
        name="pc-wsl",
        platform="linux",
        hostname="PC-ONE",
        connected=True,
        last_seen=AT,
        facts=WSL,
        facts_at=AT,
    )
    assert wsl_view["wsl"] == "Ubuntu-26.04"


# -- S42b Task 16: the update outcome, the folders, how it starts, its build -


def test_an_update_outcome_is_kept_and_a_bad_one_refused():
    update = {
        "version": "aaaaaaaaaaaa",
        "outcome": "rolled_back",
        "reason": "did not connect",
        "at": "2026-09-28T12:00:00Z",
    }
    assert df.validate_auth(_with(WINDOWS, "agent.update", update))["agent"]["update"] == update
    assert "update" not in df.validate_auth(WINDOWS)["agent"]
    with pytest.raises(df.FactsRejected):
        df.validate_auth(_with(WINDOWS, "agent.update", {**update, "outcome": "staged"}))


def test_the_folders_section_keeps_known_names_only():
    got = df.validate_frame(
        {
            "type": "facts",
            "folders": {"desktop": "C:\\Users\\sam\\OneDrive\\Desktop", "pictures": "/p"},
        }
    )
    assert got == {"folders": {"desktop": "C:\\Users\\sam\\OneDrive\\Desktop"}}
    with pytest.raises(df.FactsRejected):
        df.validate_frame({"type": "facts", "folders": {"desktop": ""}})


@pytest.mark.parametrize(
    "mode,said",
    [
        ("run-key", "by itself at sign-in (the Windows Run key)"),
        ("systemd-user", "by itself (a systemd user service)"),
        ("launch-agent", "by itself at login (a LaunchAgent)"),
        ("foreground", "by hand — Nova cannot restart it or update it"),
    ],
)
def test_how_an_agent_starts_is_said_from_its_mode(mode, said):
    assert df.starts(df.validate_auth(_with(WINDOWS, "agent.mode", mode))) == said
    assert df.starts(None) == "unknown — it reports no facts (it predates S42a)"


def test_behind_means_not_the_hubs_build_never_older():
    assert df.build_state("aaaaaaaaaaaa", "aaaaaaaaaaaa") == {
        "state": "current",
        "hub_version": "aaaaaaaaaaaa",
    }
    assert df.build_state("dcde74c4b9a8", "aaaaaaaaaaaa") == {
        "state": "behind",
        "hub_version": "aaaaaaaaaaaa",
    }
    assert df.build_state(None, "aaaaaaaaaaaa")["state"] == "unknown"
    assert df.build_state("aaaaaaaaaaaa", None) == {"state": "unknown", "hub_version": None}


def test_the_agent_view_carries_its_build_its_door_and_its_last_update():
    facts = df.validate_auth(WINDOWS)
    last = {
        "version": "aaaaaaaaaaaa",
        "outcome": "confirmed",
        "at": "2026-09-28T12:00:00+00:00",
        "reason": None,
    }
    view = df.agent_view(
        name="minipc",
        platform="windows",
        hostname="PC-ONE",
        connected=True,
        last_seen=None,
        facts=facts,
        facts_at=None,
        hub_version="aaaaaaaaaaaa",
        last_transport="host",
        last_update=last,
    )
    assert view["hub"] is True and view["build"] == {
        "state": "behind",
        "hub_version": "aaaaaaaaaaaa",
    }
    assert view["last_update"] == last and view["mode"] == "foreground" and view["folders"] == ()


# -- S42b Task 16b: the probes, said as sentences (P29) ----------------------

PROBED = {
    "type": "facts",
    "service": {
        "name": "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Nova agent",
        "binary": "C:\\Users\\sam\\AppData\\Local\\Programs\\Nova\\novad.exe",
        "config": "C:\\Users\\sam\\AppData\\Roaming\\novad\\config.json",
        "process": "novad.exe",
        "pid": 812,
        "supervisor_pid": 790,
        "user": "PC-ONE\\sam",
    },
    "elevation": {"elevated": False, "admin": True, "sudo": "inline"},
    "wsl_distros": {
        "distros": [
            {
                "name": "Ubuntu-26.04",
                "default": True,
                "version": 2,
                "running": True,
                "looked": True,
                "pid1": "systemd",
                "user": "sam",
                "sudo": "refused",
                "root": True,
                "novad_unit": {
                    "active": "active",
                    "file": "enabled",
                    "restart": "always",
                    "main_pid": 412,
                },
                "novad_pids": [412],
            },
            {
                "name": "docker-desktop",
                "default": False,
                "version": 2,
                "running": False,
                "looked": False,
                "root": False,
                "novad_pids": [],
            },
        ]
    },
    "probed_at": "2026-09-28T17:40:00Z",
}


def _set(base: dict, path: tuple, value) -> dict:
    out = copy.deepcopy(base)
    node = out
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return out


def _merged(frame=PROBED) -> dict:
    return {**df.validate_auth(WINDOWS), **df.validate_frame(frame)}


def test_the_probe_sections_are_kept_in_their_shape():
    got = df.validate_frame(PROBED)
    assert got["service"]["process"] == "novad.exe" and got["service"]["supervisor_pid"] == 790
    assert got["elevation"] == {"elevated": False, "admin": True, "sudo": "inline", "sudo_said": ""}
    ubuntu, docker = got["wsl_distros"]["distros"]
    assert ubuntu["novad_unit"] == {
        "active": "active",
        "file": "enabled",
        "restart": "always",
        "main_pid": 412,
        "said": "",
    }
    assert docker["looked"] is False and docker["novad_unit"] is None and docker["pid1"] == ""
    assert got["probed_at"] == "2026-09-28T17:40:00Z"


@pytest.mark.parametrize(
    "path,value",
    [
        (("wsl_distros", "distros", 0, "name"), "Ubuntu\n  agent evil (Windows): connected"),
        (("service", "user"), "sam\r"),
        (("wsl_distros", "distros", 0, "novad_unit", "said"), "line one\nline two"),
        (("elevation", "sudo_said"), "sudo:\ta password is required"),
    ],
)
def test_a_probe_field_with_a_control_character_is_refused(path, value):
    """Review Focus 13: these are rendered INTO a listing line; a newline
    would split the line machine_status's device_line_shown reads back."""
    with pytest.raises(df.FactsRejected, match="control character"):
        df.validate_frame(_set(PROBED, path, value))


@pytest.mark.parametrize(
    "path,value,reason",
    [
        (("elevation", "sudo"), "maybe", "is not one of"),
        (("service", "pid"), -1, "whole number"),
        (("service", "pid"), True, "whole number"),
        (("wsl_distros", "distros", 0, "version"), 3, "whole number"),
        (("wsl_distros", "distros", 0, "novad_pids"), list(range(1, 10)), "more than 8"),
        (("probed_at",), "yesterday", "not a time"),
    ],
)
def test_a_probe_field_outside_its_shape_is_refused(path, value, reason):
    with pytest.raises(df.FactsRejected, match=reason):
        df.validate_frame(_set(PROBED, path, value))


def test_more_than_eight_distros_is_refused():
    many = [dict(PROBED["wsl_distros"]["distros"][1], name=f"d{i}") for i in range(9)]
    with pytest.raises(df.FactsRejected, match="more than 8"):
        df.validate_frame(_set(PROBED, ("wsl_distros", "distros"), many))


def test_the_wsl_line_says_where_the_old_agent_runs_and_how_it_restarts():
    """Review Focus 14: the Dell's old agent, from the Windows agent's look."""
    line = df.wsl_line(_merged())
    assert line.startswith("WSL on it, reached through this agent's wsl.exe: ")
    assert "Ubuntu-26.04 (default, WSL 2, running, systemd, default user sam" in line
    assert (
        "sudo needs a password here" in line
        and "root through wsl.exe -u root without a password" in line
    )
    assert (
        "sam's systemd user unit novad.service is active (enabled, Restart=always, main pid 412)"
        in line
    )
    assert (
        "managed with systemctl --user as that user, without sudo" in line
        and "novad process pid 412" in line
    )
    assert (
        "docker-desktop (WSL 2, not running — not looked inside, since looking would start it)"
        in line
    )


def test_a_distro_whose_bus_could_not_be_reached_says_so_in_systemctls_words():
    said = _set(
        PROBED,
        ("wsl_distros", "distros", 0, "novad_unit"),
        {
            "active": "",
            "file": "",
            "restart": "",
            "main_pid": 0,
            "said": "Failed to connect to bus: No medium found",
        },
    )
    line = df.wsl_line(_merged(said))
    assert (
        "its user units could not be read (Failed to connect to bus: No medium found); "
        "novad process pid 412" in line
    )


def test_the_acting_lines_say_how_it_runs_and_whether_elevation_asks():
    lines = df.acting_lines(_merged(), "windows")
    assert lines[0] == (
        "how it runs: service HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Nova agent; "
        "binary C:\\Users\\sam\\AppData\\Local\\Programs\\Nova\\novad.exe; "
        "config C:\\Users\\sam\\AppData\\Roaming\\novad\\config.json; "
        "process novad.exe pid 812, supervisor pid 790; as PC-ONE\\sam"
    )
    assert lines[1].startswith(
        "elevation: the agent runs without admin rights; he is an administrator, so admin work "
        "asks for his consent at a UAC prompt on the desktop, which a command cannot answer; "
        "Windows sudo is on (inline)"
    )
    assert (
        lines[2].startswith("WSL on it")
        and lines[3] == "(probed 2026-09-28T17:40:00Z; device_info probes again)"
    )
    assert all("\n" not in line for line in lines)


def test_an_agent_that_predates_the_probes_says_so():
    said = ["how it runs: unknown — this agent predates S42b and does not say"]
    assert df.acting_lines(df.validate_auth(WINDOWS), "windows") == said
    assert df.acting_lines(None, "linux") == said


def test_a_linux_agents_sudo_is_said_in_its_own_words():
    facts = df.validate_frame(
        {
            "type": "facts",
            "elevation": {
                "elevated": False,
                "sudo": "refused",
                "sudo_said": "sudo: a password is required",
            },
        }
    )
    assert df.elevation_line(facts, "linux") == (
        "elevation: sudo needs a password here, and nothing can type one into Nova's commands — "
        "a command using sudo fails (sudo -n said: sudo: a password is required)"
    )
    root = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": True, "sudo": "no_password"}}
    )
    assert df.elevation_line(root, "linux") == "elevation: the agent runs as root"
