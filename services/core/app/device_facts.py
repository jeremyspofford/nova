"""What a paired machine's agent says about itself, checked — and what core
derives from it (S42a).

An agent reports RAW facts in two frames on the socket core authenticated:
a small block inside the auth frame (≤4 KiB, recorded only after the
signature verifies) and a larger `facts` frame (≤16 KiB, sent after ready,
on a change, every ten minutes and on facts.refresh). This module is core's
one reader of them:

  * validate_auth / validate_frame keep what this core understands, in the
    shape it understands, and refuse anything else by raising FactsRejected
    with the reason. A refusal never refuses the SOCKET — an agent that
    describes itself badly is still the device its key proves — so the
    caller logs it and records nothing.
  * derive_roles turns facts into ROLES: what the machine's agent is
    available for now, each with its reason. A role is AVAILABILITY, never
    permission (hub decision D2): no tool reads a role to refuse a call, and
    nothing here is stored — it is derived on every read, so it cannot go
    stale behind a fact that changed.
  * agent_view is the one shape the plant, machine_status and an eval
    fixture share.

Facts are not signed. They ride the authenticated socket over TLS or
WireGuard, exactly as a result frame does (r2-integration D11).
"""

from __future__ import annotations

import ipaddress
import json
import re
from datetime import datetime

# What an agent may say it runs: Go's runtime.GOOS for the three builds.
PLATFORMS: tuple[str, ...] = ("linux", "darwin", "windows")
# What devices.platform may hold (migration 036's CHECK): the three, plus
# 'unknown' for a row enrolled before S42a with something else in it.
STORED_PLATFORMS: tuple[str, ...] = (*PLATFORMS, "unknown")

AUTH_FACTS_MAX_BYTES = 4096
FRAME_MAX_BYTES = 16 * 1024
FACTS_VERSION = 2
AGENT_MODES: tuple[str, ...] = ("systemd-user", "launch-agent", "run-key", "foreground")
# The sections a facts frame may carry. A later slice adds its own (power,
# ollama, compute, hold, overlay) HERE, beside its validator.
FRAME_SECTIONS: tuple[str, ...] = ("net", "unreadable")

# Every role on an agent inside WSL (r2-integration S42a; the in-WSL agent is
# retired for the Windows one, which reaches WSL through wsl.exe).
WSL_REASON = "cannot: this machine's Windows agent owns it"

_UID = re.compile(r"^[0-9a-f]{64}$")
_MAC = re.compile(r"^(?:[0-9a-f]{2}(?::[0-9a-f]{2}){0,19})?$")
_MAX_TEXT = 255
_MAX_IFACES = 32
_MAX_ADDRS = 8
_MAX_UNREADABLE = 32


class FactsRejected(ValueError):
    """Facts this core will not record, with the reason in words."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _encoded_size(raw: object) -> int:
    return len(json.dumps(raw, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def _object(value: object, where: str) -> dict:
    if not isinstance(value, dict):
        raise FactsRejected(f"{where} must be an object, got {type(value).__name__}")
    return value


def _text(value: object, where: str) -> str:
    if not isinstance(value, str):
        raise FactsRejected(f"{where} must be text, got {type(value).__name__}")
    if len(value) > _MAX_TEXT:
        raise FactsRejected(f"{where} is longer than {_MAX_TEXT} characters")
    return value


def _bool(value: object, where: str) -> bool:
    if not isinstance(value, bool):
        raise FactsRejected(f"{where} must be true or false")
    return value


def validate_auth(raw: object) -> dict:
    """The auth-frame facts as core records them, or FactsRejected.

    Shape (r2-integration, the auth frame): {v: 2, agent: {version, mode,
    session_interactive}, os: {goos, arch, version, wsl: null | {distro}},
    hostname, machine_uid}. The size cap applies to what was SENT; keys
    outside the shape are dropped, not stored."""
    facts = _object(raw, "facts")
    size = _encoded_size(facts)
    if size > AUTH_FACTS_MAX_BYTES:
        raise FactsRejected(
            f"auth-frame facts are {size} bytes, over the {AUTH_FACTS_MAX_BYTES}-byte cap"
        )
    if facts.get("v") != FACTS_VERSION:
        raise FactsRejected(f"facts version {facts.get('v')!r} is not {FACTS_VERSION}")
    agent = _object(facts.get("agent"), "facts.agent")
    mode = _text(agent.get("mode"), "facts.agent.mode")
    if mode not in AGENT_MODES:
        raise FactsRejected(f"facts.agent.mode {mode!r} is not one of {', '.join(AGENT_MODES)}")
    os_ = _object(facts.get("os"), "facts.os")
    goos = _text(os_.get("goos"), "facts.os.goos")
    if goos not in PLATFORMS:
        raise FactsRejected(f"facts.os.goos {goos!r} is not one of {', '.join(PLATFORMS)}")
    wsl: dict | None = None
    if os_.get("wsl") is not None:
        if goos != "linux":
            raise FactsRejected("facts.os.wsl is only possible on linux")
        distro = _object(os_["wsl"], "facts.os.wsl").get("distro", "")
        wsl = {"distro": _text(distro, "facts.os.wsl.distro")}
    uid = _text(facts.get("machine_uid", ""), "facts.machine_uid")
    if uid and not _UID.match(uid):
        raise FactsRejected("facts.machine_uid must be 64 lowercase hex characters, or empty")
    return {
        "v": FACTS_VERSION,
        "agent": {
            "version": _text(agent.get("version"), "facts.agent.version"),
            "mode": mode,
            "session_interactive": _bool(
                agent.get("session_interactive"), "facts.agent.session_interactive"
            ),
        },
        "os": {
            "goos": goos,
            "arch": _text(os_.get("arch"), "facts.os.arch"),
            "version": _text(os_.get("version"), "facts.os.version"),
            "wsl": wsl,
        },
        "hostname": _text(facts.get("hostname"), "facts.hostname"),
        "machine_uid": uid,
    }


def _cidr(value: object, where: str) -> str:
    text = _text(value, where)
    try:
        iface = ipaddress.ip_interface(text)
    except ValueError as exc:
        raise FactsRejected(f"{where} {text!r} is not an IPv4 address/prefix") from exc
    if iface.version != 4:
        raise FactsRejected(f"{where} {text!r} is not an IPv4 address/prefix")
    return str(iface)


def _net(raw: object) -> dict:
    net = _object(raw, "facts.net")
    ifaces_raw = net.get("ifaces")
    if not isinstance(ifaces_raw, list):
        raise FactsRejected("facts.net.ifaces must be a list")
    if len(ifaces_raw) > _MAX_IFACES:
        raise FactsRejected(f"facts.net.ifaces lists more than {_MAX_IFACES} interfaces")
    ifaces = []
    for index, item in enumerate(ifaces_raw):
        where = f"facts.net.ifaces[{index}]"
        iface = _object(item, where)
        mac = _text(iface.get("mac", ""), f"{where}.mac").lower()
        if not _MAC.match(mac):
            raise FactsRejected(f"{where}.mac {mac!r} is not a hardware address")
        cidrs = iface.get("ipv4_cidr", [])
        if not isinstance(cidrs, list) or len(cidrs) > _MAX_ADDRS:
            raise FactsRejected(f"{where}.ipv4_cidr must be a list of at most {_MAX_ADDRS}")
        ifaces.append(
            {
                "name": _text(iface.get("name"), f"{where}.name"),
                "mac": mac,
                "ipv4_cidr": [_cidr(c, f"{where}.ipv4_cidr") for c in cidrs],
                "up": _bool(iface.get("up"), f"{where}.up"),
            }
        )
    return {"ifaces": ifaces}


def _unreadable(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        raise FactsRejected("facts.unreadable must be a list")
    if len(raw) > _MAX_UNREADABLE:
        raise FactsRejected(f"facts.unreadable lists more than {_MAX_UNREADABLE} items")
    out = []
    for index, item in enumerate(raw):
        where = f"facts.unreadable[{index}]"
        entry = _object(item, where)
        out.append(
            {
                "item": _text(entry.get("item"), f"{where}.item"),
                "reason": _text(entry.get("reason", ""), f"{where}.reason"),
            }
        )
    return out


def validate_frame(raw: object) -> dict:
    """The SECTIONS of a facts frame, as core merges them into devices.facts,
    or FactsRejected. `type` is the frame's, not a fact, and is not returned;
    a section this core does not know is dropped."""
    frame = _object(raw, "the facts frame")
    size = _encoded_size(frame)
    if size > FRAME_MAX_BYTES:
        raise FactsRejected(f"the facts frame is {size} bytes, over the {FRAME_MAX_BYTES}-byte cap")
    out: dict = {}
    if "net" in frame:
        out["net"] = _net(frame["net"])
    if "unreadable" in frame:
        out["unreadable"] = _unreadable(frame["unreadable"])
    if not out:
        raise FactsRejected(f"the facts frame carries none of {', '.join(FRAME_SECTIONS)}")
    return out


# -- readers ---------------------------------------------------------------


def in_wsl(facts: dict | None) -> str | None:
    """The WSL distribution this agent runs inside ("" when unnamed), or None
    when it does not run inside WSL — or never said."""
    if not isinstance(facts, dict):
        return None
    wsl = (facts.get("os") or {}).get("wsl")
    if not isinstance(wsl, dict):
        return None
    distro = wsl.get("distro")
    return distro if isinstance(distro, str) else ""


def machine_uid(facts: dict | None) -> str | None:
    uid = facts.get("machine_uid") if isinstance(facts, dict) else None
    return uid if isinstance(uid, str) and _UID.match(uid) else None


def os_label(facts: dict | None) -> str | None:
    version = (facts.get("os") or {}).get("version") if isinstance(facts, dict) else None
    return version if isinstance(version, str) and version else None


def agent_version(facts: dict | None) -> str | None:
    version = (facts.get("agent") or {}).get("version") if isinstance(facts, dict) else None
    return version if isinstance(version, str) and version else None


# -- roles -----------------------------------------------------------------


def derive_roles(
    *,
    platform: str,
    facts: dict | None,
    facts_at: datetime | None,
    connected: bool,
    last_seen: datetime | None,
) -> dict[str, dict]:
    """The roles S42a speaks to — hands and facts — each {state, reason}.

    state is `available`, `cannot` or `unknown`. An agent that predates S42a
    sends no facts and still HAS its hands (the Dell's WSL agent on deploy
    day is exactly that); only its facts are unknown. Later slices add
    models, relay and hold beside these, each from its own facts."""
    wsl = in_wsl(facts)
    if wsl is not None:
        hands = {"state": "cannot", "reason": WSL_REASON}
    elif platform not in PLATFORMS:
        hands = {
            "state": "cannot",
            "reason": "cannot: platform unknown — this agent did not say which OS it runs",
        }
    elif not connected:
        seen = last_seen.isoformat() if last_seen else "never"
        hands = {"state": "cannot", "reason": f"cannot: not connected (last seen {seen})"}
    else:
        hands = {"state": "available", "reason": "connected now"}
    if facts is None:
        facts_role = {
            "state": "unknown",
            "reason": "this agent sends no facts — it predates S42a; update it",
        }
    elif wsl is not None:
        facts_role = {"state": "cannot", "reason": WSL_REASON}
    else:
        when = facts_at.isoformat() if facts_at else "at an unknown time"
        facts_role = {"state": "available", "reason": f"reported {when}"}
    return {"hands": hands, "facts": facts_role}


def agent_view(
    *,
    name: str,
    platform: str,
    hostname: str,
    connected: bool,
    last_seen: datetime | None,
    facts: dict | None,
    facts_at: datetime | None,
) -> dict:
    """One machine's agent, as the plant, machine_status and an eval fixture
    all see it. `machine` is the agent's machine_uid (None when it said
    none) — what "grouped by machine" groups on."""
    return {
        "name": name,
        "platform": platform,
        "hostname": hostname,
        "connected": connected,
        "last_seen": last_seen.isoformat() if last_seen else None,
        "facts_at": facts_at.isoformat() if facts_at else None,
        "os": os_label(facts),
        "wsl": in_wsl(facts),
        "agent_version": agent_version(facts),
        "machine": machine_uid(facts),
        "roles": derive_roles(
            platform=platform,
            facts=facts,
            facts_at=facts_at,
            connected=connected,
            last_seen=last_seen,
        ),
    }
