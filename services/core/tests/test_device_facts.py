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
        # A NUL byte in an unreadable entry's `item` used to reject the
        # whole frame here — moved deliberately (Task 16b review, "F3, core
        # side"): one bad entry is now dropped on its own, and that case now
        # lives in test_a_malformed_unreadable_entry_is_dropped_not_the_
        # whole_frame, proving the opposite of what it asserted here. A
        # surrogate STAYS here, unmoved: it is caught by _encoded_size's
        # frame-wide UTF-8 encode, before any per-entry check runs, for ANY
        # field anywhere in the frame — never just dropping one entry.
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
    # Pin moved deliberately (Task 16b fix round 1, I1): "predates S42b and
    # does not say" claimed a cause the agent never reported — the probe
    # frame can simply not have landed yet (up to ~45s), among others.
    assert view["acting"] == ["how it runs: unknown — this agent has not reported it"]
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


@pytest.mark.parametrize("field", ["version", "outcome", "reason", "at"])
def test_an_update_fields_control_character_is_refused(field):
    """Task 16 fix round 1, I2: Task 20 stores agent.update.reason, and
    Task 22 renders it into machine_status's one-line agent line — a
    newline there would make device_line_shown fail closed (dropping that
    agent's connected fact), and a crafted reason could print a line that
    reads as another agent's."""
    update = {
        "version": "aaaaaaaaaaaa",
        "outcome": "rolled_back",
        "reason": "did not connect",
        "at": "2026-09-28T12:00:00Z",
    }
    update[field] = update[field] + "\nfake (Windows): connected"
    with pytest.raises(df.FactsRejected, match="control character"):
        df.validate_auth(_with(WINDOWS, "agent.update", update))


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


def test_how_an_agent_starts_is_unknown_without_guessing_a_cause():
    """Task 16 fix round 1, I1: facts is None far more often than "predates
    S42a" — a paired agent that has not connected yet, one that never came
    up, every device between a re-pair and its new agent's first connect,
    and a connection whose auth facts were refused all leave it None too.
    machine_status (Task 22) and the tile (Task 29) would otherwise give a
    wrong diagnosis. Pin moved: was "unknown — it reports no facts (it
    predates S42a)"."""
    assert df.starts(None) == "unknown — it has reported no facts"
    # A facts dict with no "agent" key must never leak a Python repr
    # ("unknown (mode None)") — the same honest "no facts" message.
    assert df.starts({}) == "unknown — it has reported no facts"
    assert "None" not in df.starts({})


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
    # Pin moved deliberately (Task 16b review, "do not gender the account"):
    # "he is an administrator" / "for his consent" -> "the account it runs
    # as is an administrator" / "for consent" — a device can belong to
    # someone other than the owner.
    # Pin moved again (Task 16b fix round 1, M7): "so admin work asks for
    # consent at a UAC prompt on the desktop, which a command cannot
    # answer" inferred a specific prompt BEHAVIOR (ConsentPromptBehaviorAdmin)
    # the agent never reads — now states only what it read: the account IS
    # an administrator, and its own token is NOT elevated.
    assert lines[1].startswith(
        "elevation: the agent runs without admin rights; the account it runs as is an "
        "administrator, but its own token is not elevated (UAC) — admin work needs "
        "elevating first, which a command cannot do for itself; Windows sudo is on (inline)"
    )
    # Pin moved deliberately (Task 16b review, "probes take time"): the
    # final line now notes the ~45s Windows-with-WSL probe bound.
    assert lines[2].startswith("WSL on it") and lines[3] == (
        "(probed 2026-09-28T17:40:00Z; device_info probes again — "
        "on Windows with WSL this can take up to about 45 seconds)"
    )
    assert all("\n" not in line for line in lines)


def test_an_agent_that_has_not_reported_any_probe_says_so():
    """Renamed and its pin moved (Task 16b fix round 1, I1): "predates
    S42b" was a guessed cause — an S42b agent that has simply not probed
    yet (auth-only facts, no service/elevation/wsl_distros/probed_at at
    all) reads identically, and claiming "predates" for it would be a
    wrong diagnosis once this is rendered into machine_status (Task 22)
    and the tile (Task 29)."""
    said = ["how it runs: unknown — this agent has not reported it"]
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


# -- S42b Task 16b amendment (controller review, post-dispatch) --------------


@pytest.mark.parametrize(
    "novad_pids,said",
    [
        (None, "whether a novad process runs there could not be read"),
        ([], "no novad process"),
        ([412], "novad process pid 412"),
    ],
    ids=["absent-is-unknown", "empty-is-none-found", "listed-pids"],
)
def test_novad_pids_distinguishes_unknown_none_and_listed(novad_pids, said):
    probe = copy.deepcopy(PROBED)
    probe["wsl_distros"]["distros"][0]["novad_unit"] = None
    if novad_pids is None:
        del probe["wsl_distros"]["distros"][0]["novad_pids"]
    else:
        probe["wsl_distros"]["distros"][0]["novad_pids"] = novad_pids
    assert said in df.wsl_line(_merged(probe))


def test_an_absent_novad_pids_never_reads_as_none_found():
    probe = copy.deepcopy(PROBED)
    probe["wsl_distros"]["distros"][0]["novad_unit"] = None
    del probe["wsl_distros"]["distros"][0]["novad_pids"]
    assert "no novad process" not in df.wsl_line(_merged(probe))


def test_when_the_running_list_itself_failed_a_distro_never_says_not_running():
    said = _set(PROBED, ("wsl_distros", "running_said"), "wsl.exe --list --running: access denied")
    line = df.wsl_line(_merged(said))
    assert "whether it runs could not be read" in line
    assert "not running —" not in line


def test_an_unreadable_distro_list_never_reads_as_none_installed():
    frame = {
        "type": "facts",
        "wsl_distros": {"distros": []},
        "unreadable": [
            {"item": "wsl_distros", "reason": "wsl.exe --list --verbose: exit status 1"}
        ],
    }
    merged = {**df.validate_auth(WINDOWS), **df.validate_frame(frame)}
    line = df.wsl_line(merged)
    assert "could not be read" in line
    assert "no distribution is installed" not in line


def test_an_empty_and_truly_readable_distro_list_still_says_none_installed():
    merged = {
        **df.validate_auth(WINDOWS),
        **df.validate_frame({"type": "facts", "wsl_distros": {"distros": []}}),
    }
    assert df.wsl_line(merged) == "WSL: no distribution is installed for this account"


def test_an_unreadable_reasons_control_characters_are_sanitized_not_rejected():
    frame = {
        "type": "facts",
        "wsl_distros": {
            "distros": [
                {
                    "name": "Ubuntu-26.04",
                    "default": True,
                    "version": 2,
                    "running": True,
                    "looked": False,
                }
            ]
        },
        "unreadable": [
            {"item": "wsl_distros.Ubuntu-26.04", "reason": "exit 1\n  fake (Windows): connected"}
        ],
    }
    got = df.validate_frame(frame)  # never rejected over a control character in `reason`
    assert "\n" in got["unreadable"][0]["reason"]  # stored exactly as the agent sent it
    line = df.wsl_line({**df.validate_auth(WINDOWS), **got})
    assert "\n" not in line
    assert "exit 1" in line and "fake (Windows): connected" in line


@pytest.mark.parametrize(
    "entry",
    [
        "not an object",
        {"item": 5},
        {"item": "x\x00", "reason": "y"},
    ],
    ids=["not-an-object", "item-not-text", "item-has-a-nul-byte"],
)
def test_a_malformed_unreadable_entry_is_dropped_not_the_whole_frame(entry):
    """The NUL-byte case used to be pinned in test_a_frame_that_does_not_fit_
    is_refused_with_the_reason as a frame-level refusal — moved here,
    proving the opposite, now that one bad entry is dropped on its own. (A
    surrogate is NOT one of these cases: it is caught by _encoded_size's
    frame-wide UTF-8 encode before any per-entry check runs, and still
    rejects the whole frame — see the other test, unmoved.)"""
    frame = {
        "type": "facts",
        "net": {"ifaces": []},
        "unreadable": [{"item": "ok", "reason": "fine"}, entry],
    }
    got = df.validate_frame(frame)
    assert got["unreadable"] == [{"item": "ok", "reason": "fine"}]
    assert got["net"] == {"ifaces": []}


def test_elevation_lines_never_gender_the_account():
    admin = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": False, "admin": True, "sudo": "off"}}
    )
    line = df.elevation_line(admin, "windows")
    for word in (" he ", " his ", " him ", " she ", " her "):
        assert word not in f" {line} "
    assert "the account it runs as is an administrator" in line


def test_the_sudo_unknown_wording_never_says_windows_on_linux_or_macos():
    """Pin moved (Task 16b fix round 1, I4): "unknown" is a FAILED READ —
    sudo -n gave no answer in time or never started — never "a mode Nova
    does not know", which reads as an exotic-but-reported value."""
    facts = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": False, "sudo": "unknown"}}
    )
    for plat in ("linux", "darwin"):
        line = df.elevation_line(facts, plat)
        assert "Windows" not in line
        assert "whether sudo could be used could not be read" in line
    win_facts = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": False, "admin": True, "sudo": "unknown"}}
    )
    assert "whether Windows sudo could be used could not be read" in df.elevation_line(
        win_facts, "windows"
    )


def test_a_wsl_distros_own_sudo_unknown_never_says_windows():
    said = _set(PROBED, ("wsl_distros", "distros", 0, "sudo"), "unknown")
    line = df.wsl_line(_merged(said))
    assert "whether sudo could be used could not be read" in line
    assert "Windows" not in line


def test_windows_sudo_from_nova_states_it_has_not_been_measured_yet():
    facts = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": False, "admin": True, "sudo": "inline"}}
    )
    line = df.elevation_line(facts, "windows")
    assert "has not been measured yet" in line
    assert "fails at once" not in line
    assert "puts a UAC prompt" not in line
    # Both measured outcomes stay as named constants for when Task 1's Dell
    # reading lands — neither is asserted as true yet.
    assert "fails at once" in df._WINDOWS_SUDO_FROM_AGENT_S_FAILS
    assert "UAC prompt" in df._WINDOWS_SUDO_FROM_AGENT_S_PROMPTS


def test_the_unit_sentence_notes_xdg_runtime_dir_for_a_command_nova_runs():
    line = df.wsl_line(_merged())
    assert "XDG_RUNTIME_DIR=/run/user/<uid>" in line
    # The existing substring this sentence was already pinned on still holds
    # — the note is appended after it, not spliced into the middle:
    assert "managed with systemctl --user as that user, without sudo" in line


def test_the_probed_again_line_notes_45_seconds_on_windows_never_elsewhere():
    lines = df.acting_lines(_merged(), "windows")
    assert lines[-1] == (
        "(probed 2026-09-28T17:40:00Z; device_info probes again — "
        "on Windows with WSL this can take up to about 45 seconds)"
    )
    linux_frame = {
        "type": "facts",
        "service": {
            "name": "",
            "binary": "/usr/bin/novad",
            "config": "/etc/novad/config.json",
            "process": "novad",
            "pid": 500,
            "supervisor_pid": 1,
            "user": "sam",
        },
        "probed_at": "2026-09-28T17:40:00Z",
    }
    linux_facts = {**df.validate_auth(WSL), **df.validate_frame(linux_frame)}
    assert df.acting_lines(linux_facts, "linux")[-1] == (
        "(probed 2026-09-28T17:40:00Z; device_info probes again)"
    )


def test_elevation_lines_never_promise_or_rule_out_a_future_admin_path():
    cases = [
        (
            df.validate_frame(
                {"type": "facts", "elevation": {"elevated": False, "admin": True, "sudo": "off"}}
            ),
            "windows",
        ),
        (
            df.validate_frame(
                {
                    "type": "facts",
                    "elevation": {"elevated": False, "admin": False, "sudo": "absent"},
                }
            ),
            "windows",
        ),
        (
            df.validate_frame(
                {"type": "facts", "elevation": {"elevated": True, "sudo": "no_password"}}
            ),
            "windows",
        ),
        (
            df.validate_frame(
                {
                    "type": "facts",
                    "elevation": {"elevated": False, "sudo": "refused", "sudo_said": "x"},
                }
            ),
            "linux",
        ),
        (
            df.validate_frame(
                {"type": "facts", "elevation": {"elevated": True, "sudo": "no_password"}}
            ),
            "linux",
        ),
    ]
    banned = (
        "will never",
        "cannot ever",
        "permanently",
        "forever",
        "always will",
        "going forward",
        "in the future",
        "not yet supported",
    )
    for facts, platform in cases:
        line = df.elevation_line(facts, platform).lower()
        for word in banned:
            assert word not in line


# -- S42b Task 16b fix round 1 (controller review of fa3658de..803da005) ----


def test_elevation_and_wsl_lines_render_even_when_service_has_not_landed():
    """I1: the probe frame can leave `service` absent while `elevation` or
    `wsl_distros` are present — too big for one frame, refused, or simply
    not landed yet (up to ~45s after every fresh connect) — so those lines
    must never be gated on `service`'s own presence."""
    frame = {
        "type": "facts",
        "elevation": {"elevated": False, "admin": True, "sudo": "off"},
        "wsl_distros": {"distros": []},
    }
    facts = {**df.validate_auth(WINDOWS), **df.validate_frame(frame)}
    lines = df.acting_lines(facts, "windows")
    assert lines[0] == "how it runs: unknown — this agent has not reported it"
    assert any(line.startswith("elevation:") for line in lines)
    assert any(line.startswith("WSL:") for line in lines)


def test_the_probe_unreadable_reason_is_said_when_service_is_absent():
    """I1: a probe too big for the frame — the agent leaves the sections
    out and says why under unreadable item "probe"."""
    frame = {
        "type": "facts",
        "unreadable": [{"item": "probe", "reason": "probe is 20000 bytes, over the 16384 cap"}],
    }
    facts = {**df.validate_auth(WINDOWS), **df.validate_frame(frame)}
    assert df.runs_line(facts) == (
        "how it runs: unknown — this agent has not reported it "
        "(probe is 20000 bytes, over the 16384 cap)"
    )


def test_admin_absent_is_never_read_as_not_an_administrator():
    """I2: Admin is nil exactly when the membership read failed
    (elevation_windows.go), never a confirmed "no"."""
    facts = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": False, "sudo": "off"}}
    )  # no "admin" key at all
    line = df.elevation_line(facts, "windows")
    assert "whether the account it runs as is an administrator could not be read" in line
    assert "is not an administrator" not in line


def test_an_empty_pid1_is_never_read_as_confirmed_no_systemd():
    """I2: the agent prints an empty pid1 when it cannot read
    /proc/1/comm — never a confirmed "no systemd"."""
    said = _set(PROBED, ("wsl_distros", "distros", 0, "pid1"), "")
    line = df.wsl_line(_merged(said))
    assert "whether systemd runs could not be read" in line
    assert "no systemd" not in line


def test_an_unreadable_entrys_empty_reason_still_counts_as_the_entry_existing():
    """I3a: `if unread:` tested the reason's truthiness, not the entry's
    existence — a "wsl_distros" entry with an empty reason still printed
    "no distribution is installed"."""
    frame = {
        "type": "facts",
        "wsl_distros": {"distros": []},
        "unreadable": [{"item": "wsl_distros", "reason": ""}],
    }
    merged = {**df.validate_auth(WINDOWS), **df.validate_frame(frame)}
    line = df.wsl_line(merged)
    assert "could not be read" in line
    assert "no distribution is installed" not in line
    assert "no reason given" in line


def test_an_unreadable_entrys_control_character_only_reason_still_counts():
    """I3a: an all-control-character reason sanitizes to empty, which must
    still count as the entry EXISTING, not as it never having been sent."""
    frame = {
        "type": "facts",
        "wsl_distros": {"distros": []},
        "unreadable": [{"item": "wsl_distros", "reason": "\x01\x02\x03"}],
    }
    merged = {**df.validate_auth(WINDOWS), **df.validate_frame(frame)}
    assert "could not be read" in df.wsl_line(merged)


def test_a_readable_item_with_an_unreadable_reason_is_kept_with_a_placeholder():
    """I3a: when the item is readable but its reason is bad (a NUL byte),
    the entry is kept with a placeholder reason, not dropped entirely —
    dropping it would make "wsl_distros" indistinguishable from never
    having been reported at all."""
    got = df.validate_frame(
        {"type": "facts", "unreadable": [{"item": "wsl_distros", "reason": "x\x00y"}]}
    )
    assert got["unreadable"] == [{"item": "wsl_distros", "reason": "(reason unreadable)"}]
    merged = {**df.validate_auth(WINDOWS), **got, "wsl_distros": {"distros": []}}
    assert "could not be read" in df.wsl_line(merged)


def test_wsl_distros_omitted_with_an_unreadable_entry_still_produces_a_line():
    """I3b: the agent's own failed-probe shape omits wsl_distros entirely
    and adds unreadable "wsl_distros" instead of an empty distros list.
    wsl_line used to return None for this — no WSL line, the reason never
    said."""
    frame = {
        "type": "facts",
        "unreadable": [{"item": "wsl_distros", "reason": "wsl.exe --list --verbose: not found"}],
    }
    facts = {**df.validate_auth(WINDOWS), **df.validate_frame(frame)}
    line = df.wsl_line(facts)
    assert line is not None
    assert "could not be read (wsl.exe --list --verbose: not found)" in line


def test_sudo_unknown_appends_sudo_said_on_every_platform():
    """I4: Linux/macOS sends "unknown" when sudo -n true gave no answer in
    time or never started, with the reason in sudo_said — previously only
    "refused" showed it. Windows "unknown" also covers a failed registry
    read, and sudo_said was never rendered there at all."""
    linux_facts = df.validate_frame(
        {
            "type": "facts",
            "elevation": {"elevated": False, "sudo": "unknown", "sudo_said": "timed out"},
        }
    )
    assert "(sudo -n said: timed out)" in df.elevation_line(linux_facts, "linux")
    win_facts = df.validate_frame(
        {
            "type": "facts",
            "elevation": {
                "elevated": False,
                "admin": True,
                "sudo": "unknown",
                "sudo_said": "registry key not found",
            },
        }
    )
    assert "(it said: registry key not found)" in df.elevation_line(win_facts, "windows")


def test_windows_sudo_off_never_says_windows_on_linux_and_never_contradicts_itself():
    """M1: no "Windows sudo is on (inline)" for Linux "inline" — every
    Windows-only state (off/new_window/input_off/inline) is overridden on
    non-Windows, not just "unknown". Windows "refused" must not
    contradict itself with "...fails — whether this works...has not been
    measured yet"."""
    inline_facts = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": False, "sudo": "inline"}}
    )
    # The word "Windows" may still appear (acknowledging the reported value
    # NAMES a Windows-only state), but never "Windows sudo is on" — that
    # would claim actual Windows sudo behavior on a non-Windows platform.
    assert "Windows sudo is on" not in df.elevation_line(inline_facts, "linux")
    said = _set(PROBED, ("wsl_distros", "distros", 0, "sudo"), "inline")
    assert "Windows sudo is on" not in df.wsl_line(_merged(said))

    refused_win = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": False, "admin": True, "sudo": "refused"}}
    )
    line = df.elevation_line(refused_win, "windows")
    assert "fails" in line
    assert "has not been measured yet" not in line


def test_windows_sudo_absent_means_never_turned_on_not_no_sudo():
    """M1: Windows "absent" means sudo.exe was never turned on
    (elevation_windows.go), not "no sudo" (which stays accurate for
    Linux/macOS, where sudo really can just not exist)."""
    win_facts = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": False, "admin": True, "sudo": "absent"}}
    )
    assert "never been turned on" in df.elevation_line(win_facts, "windows")
    linux_facts = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": False, "sudo": "absent"}}
    )
    assert df.elevation_line(linux_facts, "linux") == "elevation: no sudo"


def test_blank_service_fields_say_unknown_not_a_broken_sentence():
    """M2: a blank service field used to render as a literal blank —
    "binary ; config ; process  pid 0; as " — never "unknown", and never
    its own unreadable reason."""
    frame = {
        "type": "facts",
        "service": {
            "name": "novad",
            "binary": "",
            "config": "",
            "process": "",
            "pid": 0,
            "supervisor_pid": 0,
            "user": "",
        },
        "unreadable": [{"item": "service.binary", "reason": "could not resolve argv[0]"}],
    }
    facts = {**df.validate_auth(WINDOWS), **df.validate_frame(frame)}
    line = df.runs_line(facts)
    assert "binary ;" not in line and "pid 0;" not in line and "as \n" not in line
    assert "binary unknown (could not resolve argv[0])" in line
    assert "config unknown; " in line
    assert "process unknown pid unknown" in line
    assert line.endswith("as unknown")


def test_a_run_key_is_never_called_a_service():
    """M2: a Run-key value is not a service — it is a registry value under
    HKCU\\...\\Run, read at sign-in by the shell."""
    frame = {
        "type": "facts",
        "service": {
            "name": "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Nova agent",
            "binary": "novad.exe",
            "config": "config.json",
            "process": "novad.exe",
            "pid": 1,
            "supervisor_pid": 0,
            "user": "sam",
        },
    }
    run_key_auth = _with(WINDOWS, "agent.mode", "run-key")
    facts = {**df.validate_auth(run_key_auth), **df.validate_frame(frame)}
    line = df.runs_line(facts)
    assert line.startswith(
        "how it runs: the Windows Run key "
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Nova agent"
    )
    assert "service HKCU" not in line


def test_why_keeps_every_reason_of_a_repeated_item_not_only_the_last():
    """M3: a naive dict comprehension keeps only the LAST reason for a
    repeated item — every reason must be kept."""
    frame = {
        "type": "facts",
        "wsl_distros": {"distros": []},
        "unreadable": [
            {"item": "wsl_distros", "reason": "first attempt: access denied"},
            {"item": "wsl_distros", "reason": "retry: timed out"},
        ],
    }
    merged = {**df.validate_auth(WINDOWS), **df.validate_frame(frame)}
    line = df.wsl_line(merged)
    assert "first attempt: access denied" in line
    assert "retry: timed out" in line


def test_a_distros_sudo_said_is_kept_and_rendered_not_dropped():
    """M3: a distro's sudo_said used to be silently dropped — only `sudo`
    (the state) was ever read."""
    with_said = _set(PROBED, ("wsl_distros", "distros", 0, "sudo"), "refused")
    with_said = _set(
        with_said, ("wsl_distros", "distros", 0, "sudo_said"), "sudo: a password is required"
    )
    got = df.validate_frame(with_said)
    assert got["wsl_distros"]["distros"][0]["sudo_said"] == "sudo: a password is required"
    line = df.wsl_line(_merged(with_said))
    assert "(sudo -n said: sudo: a password is required)" in line


def test_more_than_eight_distros_or_pids_says_the_list_is_cut_off():
    """M3: a cut-off or partial list says so — a non-empty distros list
    is not proof it is the WHOLE list, and neither is a non-empty pids
    list."""
    said = _set(
        PROBED,
        ("unreadable",),
        [{"item": "wsl_distros", "reason": "12 distributions found, 8 shown"}],
    )
    line = df.wsl_line(_merged(said))
    assert "not every distribution is shown: 12 distributions found, 8 shown" in line

    pids_said = _set(
        PROBED,
        ("unreadable",),
        [{"item": "wsl_distros.Ubuntu-26.04.novad_pids", "reason": "14 processes found, 8 shown"}],
    )
    pids_line = df.wsl_line(_merged(pids_said))
    assert "more may be running: 14 processes found, 8 shown" in pids_line


def test_the_root_path_names_a_non_default_distro():
    """M6: wsl.exe -u root with no -d targets the DEFAULT distro — right
    only for one of them."""
    non_default = copy.deepcopy(PROBED)
    non_default["wsl_distros"]["distros"][0]["default"] = False
    line = df.wsl_line(_merged(non_default))
    assert "root through wsl.exe -d Ubuntu-26.04 -u root without a password" in line
    assert "wsl.exe -u root without a password" not in line.split("Ubuntu-26.04 (")[1].split(")")[0]


def test_a_failed_units_zero_main_pid_is_not_said_as_a_pid():
    """M6: a failed unit's main_pid is 0 — not a pid."""
    failed = _set(
        PROBED,
        ("wsl_distros", "distros", 0, "novad_unit"),
        {"active": "failed", "file": "enabled", "restart": "always", "main_pid": 0},
    )
    line = df.wsl_line(_merged(failed))
    assert "main pid 0" not in line
    assert "not running)" in line


def test_elevation_states_only_what_was_read_never_an_inferred_uac_prompt():
    """M7: "admin work asks for consent at a UAC prompt" was inferred from
    the DEFAULT UAC policy — the agent never reads
    ConsentPromptBehaviorAdmin. Say only what it read: admin behind UAC,
    limited token."""
    facts = df.validate_frame(
        {"type": "facts", "elevation": {"elevated": False, "admin": True, "sudo": "off"}}
    )
    line = df.elevation_line(facts, "windows")
    assert "is an administrator, but its own token is not elevated (UAC)" in line
    assert "asks for consent" not in line
    assert "UAC prompt" not in line
