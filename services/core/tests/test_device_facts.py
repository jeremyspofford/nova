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
    }
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
