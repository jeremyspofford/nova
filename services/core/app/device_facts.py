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
from collections.abc import Mapping
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
FRAME_SECTIONS: tuple[str, ...] = (
    "net",
    "unreadable",
    "folders",
    "service",
    "elevation",
    "wsl_distros",
    "probed_at",
)
# S42b P16: the folders a fs path may name as @<name>, as the agent's OS names them.
FOLDER_NAMES: tuple[str, ...] = ("home", "desktop", "documents", "downloads")
# S42b P8: what an agent's supervisor records about its last update.
UPDATE_OUTCOMES: tuple[str, ...] = ("applied", "rolled_back")
# The modes in which a supervisor started the agent: the ones Nova can restart.
SERVICE_MODES: tuple[str, ...] = ("systemd-user", "launch-agent", "run-key")
_STARTS = {
    "run-key": "by itself at sign-in (the Windows Run key)",
    "systemd-user": "by itself (a systemd user service)",
    "launch-agent": "by itself at login (a LaunchAgent)",
    "foreground": "by hand — Nova cannot restart it or update it",
}
# S42b P29: what `sudo -n true` did on Linux and macOS, or Windows sudo's setting.
SUDO_STATES: tuple[str, ...] = (
    "no_password",
    "refused",
    "absent",
    "off",
    "new_window",
    "input_off",
    "inline",
    "unknown",
)
# What Windows sudo does when Nova's agent runs it, with no console attached
# to answer a prompt. Task 1 named two possible outcomes but has not yet
# MEASURED which one is true — the Dell reading is pending (Task 16b review:
# "no unmeasured fact" — asserting either one here would be a guess). These
# two stay as named constants for when that measurement lands and picks one;
# the ACTIVE sentence (WINDOWS_SUDO_FROM_AGENT, below) states only that it
# is not yet known, never either branch.
_WINDOWS_SUDO_FROM_AGENT_S_FAILS = (
    " — and from Nova's agent it fails at once: nobody is at a console to approve it"
)
_WINDOWS_SUDO_FROM_AGENT_S_PROMPTS = (
    " — and from Nova's agent it puts a UAC prompt on the desktop that a command cannot answer"
)
WINDOWS_SUDO_FROM_AGENT = (
    " — whether this works when Nova's agent runs it, with no console attached, "
    "has not been measured yet"
)
# The only states where "does this work headlessly" is a live, unmeasured
# question (Task 16b fix round 1, M1): "refused" already has a DEFINITE
# outcome regardless of console (no password, no admin access, full stop)
# and "off"/"absent"/"unknown" have nothing to measure in the first place.
# WINDOWS_SUDO_FROM_AGENT is appended only for these three, never
# contradicting a state that already says what happens — "…a command using
# sudo fails — whether this works…" was exactly that contradiction.
_SUDO_NEEDS_MEASUREMENT: tuple[str, ...] = ("inline", "new_window", "input_off")
_MAX_DISTROS = 8
_MAX_PIDS = 8
_PID_MAX = 2**31 - 1
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# S42b P29: Windows' sudo has run-modes (off/new_window/input_off/inline)
# native sudo does not — this table is WINDOWS' words. A WSL distro's own
# account, and a native Linux/macOS agent, never run "Windows sudo", so
# _sudo_words (below) overrides EVERY word that would otherwise claim that —
# not just "unknown" (Task 16b fix round 1, M1: "off"/"new_window"/
# "input_off"/"inline" still read "Windows sudo is on (inline)" etc. on
# Linux and inside a WSL distro before this).
_SUDO_WORDS = {
    "no_password": "sudo runs without a password",
    "refused": (
        "sudo needs a password here, and nothing can type one into Nova's commands — "
        "a command using sudo fails"
    ),
    # Windows' sudo.exe ships off by default (elevation_windows.go) —
    # "absent" there means never turned on, not "no sudo" (Task 16b fix
    # round 1, I2/M1); _SUDO_WORDS_NOT_WINDOWS restores "no sudo" for a
    # platform where sudo really can just not exist.
    "absent": "sudo has never been turned on",
    "off": "Windows sudo is off",
    "new_window": "Windows sudo is on (a new window)",
    "input_off": "Windows sudo is on (input closed)",
    "inline": "Windows sudo is on (inline)",
    # "unknown" is a FAILED READ (sudo -n gave no answer in time or never
    # started; on Windows, a failed registry read) — never "a mode Nova
    # does not know", which reads as an exotic-but-REPORTED value (Task
    # 16b fix round 1, I4).
    "unknown": "whether Windows sudo could be used could not be read",
}
_SUDO_WORDS_NOT_WINDOWS = {
    "absent": "no sudo",
    "unknown": "whether sudo could be used could not be read",
    "off": "sudo reports a Windows-only state (off) here",
    "new_window": "sudo reports a Windows-only state (new_window) here",
    "input_off": "sudo reports a Windows-only state (input_off) here",
    "inline": "sudo reports a Windows-only state (inline) here",
}
# Not "predates S42b and does not say" (Task 16b fix round 1, I1): service
# can be absent for reasons that have nothing to do with the agent's age —
# see runs_line.
_UNKNOWN_RUNS = "how it runs: unknown — this agent has not reported it"

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
    """The byte size a cap compares against — and, incidentally, the one place
    every field in `raw` gets encoded to UTF-8 at once. json.loads happily
    accepts a lone UTF-16 surrogate (`"\\ud800"`) inside a JSON string escape;
    `.encode("utf-8")` on the resulting str cannot represent it and raises
    UnicodeEncodeError. That is not this core's problem to crash on — it is
    exactly the shape of facts this function exists to reject."""
    try:
        return len(json.dumps(raw, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise FactsRejected(f"facts contain an unpaired UTF-16 surrogate ({exc})") from exc


def _object(value: object, where: str) -> dict:
    if not isinstance(value, dict):
        raise FactsRejected(f"{where} must be an object, got {type(value).__name__}")
    return value


def _text(value: object, where: str) -> str:
    if not isinstance(value, str):
        raise FactsRejected(f"{where} must be text, got {type(value).__name__}")
    if "\x00" in value:
        # Postgres cannot store a NUL byte in text/jsonb at all (it fails the
        # UPDATE with UntranslatableCharacterError) — refuse it here, naming
        # the field, rather than let the database be where this is found out.
        raise FactsRejected(f"{where} contains a NUL byte, which postgres cannot store")
    if len(value) > _MAX_TEXT:
        raise FactsRejected(f"{where} is longer than {_MAX_TEXT} characters")
    return value


def _bool(value: object, where: str) -> bool:
    if not isinstance(value, bool):
        raise FactsRejected(f"{where} must be true or false")
    return value


def _line(value: object, where: str) -> str:
    """Text core renders INTO a line: one line. A newline in an agent-reported
    name would split the line tools.machines.device_line_shown reads back —
    it fails closed, and her facts would be dropped (Review Focus 13).

    Promoted to sit beside `_text`/`_object`/`_bool` (Task 16 fix round 1,
    I2): `validate_auth`'s `agent.update.*` fields need it too — Task 22
    renders `reason` into machine_status's one-line agent line, and a
    newline there would make `device_line_shown` fail closed (dropping
    that agent's connected fact) or let a crafted reason print a line that
    reads as another agent's."""
    text = _text(value, where)
    if _CONTROL.search(text):
        raise FactsRejected(f"{where} contains a control character")
    return text


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
    update = agent.get("update")
    clean_update: dict | None = None
    if update is not None:
        u = _object(update, "facts.agent.update")
        # Every agent.update.* text field goes through _line, not _text
        # (Task 16 fix round 1, I2): Task 20 stores `reason`, and Task 22
        # renders it into machine_status's one-line agent line — a control
        # character there is never just cosmetic.
        outcome = _line(u.get("outcome"), "facts.agent.update.outcome")
        if outcome not in UPDATE_OUTCOMES:
            raise FactsRejected(
                f"facts.agent.update.outcome {outcome!r} is not one of {', '.join(UPDATE_OUTCOMES)}"
            )
        clean_update = {
            "version": _line(u.get("version"), "facts.agent.update.version"),
            "outcome": outcome,
            "reason": _line(u.get("reason", ""), "facts.agent.update.reason"),
            "at": _line(u.get("at", ""), "facts.agent.update.at"),
        }
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
            **({"update": clean_update} if clean_update else {}),
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
        try:
            entry = _object(item, where)
            clean_item = _text(entry.get("item"), f"{where}.item")
        except FactsRejected:
            # The entry itself (not an object), or its `item`, is
            # unreadable — nothing to anchor a placeholder to, so the
            # whole entry is dropped on its own; it must never take the
            # whole facts frame down with it, since net/service/
            # elevation/… rode in on the same frame and said nothing
            # wrong (Task 16b review, "F3, core side").
            continue
        try:
            reason = _text(entry.get("reason", ""), f"{where}.reason")
        except FactsRejected:
            # The item IS readable; only its reason is not — kept, with a
            # placeholder, rather than losing the entry's existence (Task
            # 16b fix round 1, I3a): an item like "wsl_distros" must still
            # be told apart from never having been reported at all.
            reason = "(reason unreadable)"
        out.append({"item": clean_item, "reason": reason})
    return out


def _folders(raw: object) -> dict:
    folders = _object(raw, "facts.folders")
    out = {}
    for name in FOLDER_NAMES:
        if name in folders:
            path = _text(folders[name], f"facts.folders.{name}")
            if not path:
                raise FactsRejected(
                    f"facts.folders.{name} is empty — an unnamed folder is left "
                    "out, never sent empty"
                )
            out[name] = path
    return out


def _sanitized_line(text: str) -> str:
    """The RENDER-time twin of `_line`, for text `_unreadable` already
    accepted and stored under S42a's looser `_text`-only check (no control-
    character refusal there — tightening it would throw out an existing
    fact over a byte that only matters once it reaches a line). Every
    `unreadable[].reason` this module interpolates into a sentence goes
    through this one function first: control characters stripped, never
    rejected, and the result bounded to `_MAX_TEXT` (Task 16b review, "F3,
    core side")."""
    clean = _CONTROL.sub("", text)
    return clean if len(clean) <= _MAX_TEXT else clean[: _MAX_TEXT - 1] + "…"


def _count(value: object, where: str, most: int = _PID_MAX) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= most:
        raise FactsRejected(f"{where} must be a whole number from 0 to {most}")
    return value


def _state(value: object, where: str) -> str:
    state = _line(value, where)
    if state not in SUDO_STATES:
        raise FactsRejected(f"{where} {state!r} is not one of {', '.join(SUDO_STATES)}")
    return state


def _service(raw: object) -> dict:
    s = _object(raw, "facts.service")
    out = {
        k: _line(s.get(k, ""), f"facts.service.{k}")
        for k in ("name", "binary", "config", "process", "user")
    }
    out["pid"] = _count(s.get("pid", 0), "facts.service.pid")
    out["supervisor_pid"] = _count(s.get("supervisor_pid", 0), "facts.service.supervisor_pid")
    return out


def _elevation(raw: object) -> dict:
    e = _object(raw, "facts.elevation")
    out = {
        "elevated": _bool(e.get("elevated"), "facts.elevation.elevated"),
        "sudo": _state(e.get("sudo"), "facts.elevation.sudo"),
        "sudo_said": _line(e.get("sudo_said", ""), "facts.elevation.sudo_said"),
    }
    if e.get("admin") is not None:
        out["admin"] = _bool(e["admin"], "facts.elevation.admin")
    return out


def _unit(raw: object, where: str) -> dict:
    u = _object(raw, where)
    out = {k: _line(u.get(k, ""), f"{where}.{k}") for k in ("active", "file", "restart")}
    out["main_pid"] = _count(u.get("main_pid", 0), f"{where}.main_pid")
    out["said"] = _line(u.get("said", ""), f"{where}.said")
    return out


def _distro(raw: object, where: str) -> dict:
    d = _object(raw, where)
    raw_pids = d.get("novad_pids")
    if raw_pids is None:
        # Absent or explicit null: UNKNOWN whether a novad process runs
        # there — never collapsed into "none found" (Task 16b review,
        # "unknown is never none"). Only an explicit [] means the agent
        # looked and found none.
        pids: list[int] | None = None
    elif not isinstance(raw_pids, list) or len(raw_pids) > _MAX_PIDS:
        raise FactsRejected(
            f"{where}.novad_pids must be a list of at most {_MAX_PIDS} — more than "
            f"{_MAX_PIDS} is refused"
        )
    else:
        pids = [_count(p, f"{where}.novad_pids[{i}]") for i, p in enumerate(raw_pids)]
    sudo = d.get("sudo", "")
    return {
        "name": _line(d.get("name"), f"{where}.name"),
        "default": _bool(d.get("default", False), f"{where}.default"),
        "version": _count(d.get("version", 0), f"{where}.version", 2),
        "running": _bool(d.get("running", False), f"{where}.running"),
        "looked": _bool(d.get("looked", False), f"{where}.looked"),
        "root": _bool(d.get("root", False), f"{where}.root"),
        "pid1": _line(d.get("pid1", ""), f"{where}.pid1"),
        "user": _line(d.get("user", ""), f"{where}.user"),
        "sudo": _state(sudo, f"{where}.sudo") if sudo else "",
        # Task 16b fix round 1, M3: a distro's sudo_said was silently
        # dropped — only `sudo` (the state) was ever read, unlike
        # _elevation's top-level sudo_said, which explains an "unknown" or
        # "refused" reading in the agent's own words.
        "sudo_said": _line(d.get("sudo_said", ""), f"{where}.sudo_said"),
        "novad_unit": None
        if d.get("novad_unit") is None
        else _unit(d["novad_unit"], f"{where}.novad_unit"),
        "novad_pids": pids,
    }


def _wsl_distros(raw: object) -> dict:
    w = _object(raw, "facts.wsl_distros")
    items = w.get("distros")
    if not isinstance(items, list):
        raise FactsRejected("facts.wsl_distros.distros must be a list")
    if len(items) > _MAX_DISTROS:
        raise FactsRejected(f"facts.wsl_distros lists more than {_MAX_DISTROS} distributions")
    return {
        "distros": [
            _distro(item, f"facts.wsl_distros.distros[{i}]") for i, item in enumerate(items)
        ],
        "running_said": _line(w.get("running_said", ""), "facts.wsl_distros.running_said"),
    }


def _probed_at(raw: object) -> str:
    text = _line(raw, "facts.probed_at")
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FactsRejected(f"facts.probed_at {text!r} is not a time") from exc
    return text


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
    if "folders" in frame:
        out["folders"] = _folders(frame["folders"])
    if "service" in frame:
        out["service"] = _service(frame["service"])
    if "elevation" in frame:
        out["elevation"] = _elevation(frame["elevation"])
    if "wsl_distros" in frame:
        out["wsl_distros"] = _wsl_distros(frame["wsl_distros"])
    if "probed_at" in frame:
        out["probed_at"] = _probed_at(frame["probed_at"])
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


def place(d: Mapping) -> str:
    """Where a device or its agent runs, as one clause for a line of prose:
    its OS version when one was reported (else its bare platform), plus
    ", inside WSL" and the distro name when it runs inside WSL — the one
    composition device_list (app/tools/devices.py) and _describe_agent
    (app/tools/machines.py) both need (S42a). One source here, rather than
    two copies in those callers, is what keeps them saying the same thing
    the day only one of them is edited. `d["wsl"]` is None outside WSL, ""
    inside an unnamed one, or the distro name."""
    where = d["os"] or d["platform"]
    if d["wsl"] is not None:
        where += f", inside WSL{' ' + d['wsl'] if d['wsl'] else ''}"
    return where


def starts(facts: dict | None) -> str:
    """How this agent starts, for a person — from the mode its supervisor
    gave it (S42b P4), never assumed.

    `facts` is None far more often than "predates S42a" (Task 16 fix round
    1, I1): a paired agent that has not connected yet (enroll writes no
    facts), one that never came up, every device between a re-pair and its
    new agent's first connect, and a connection whose auth facts were
    refused all leave it None too — machine_status (Task 22) and the tile
    (Task 29) would otherwise give a wrong diagnosis. A facts dict with no
    "agent" key (so `mode` resolves to None) reads the same way, never a
    Python repr: `unknown (mode None)` would have been exactly that leak."""
    mode = (facts.get("agent") or {}).get("mode") if isinstance(facts, dict) else None
    if mode is None:
        return "unknown — it has reported no facts"
    return _STARTS.get(mode, f"unknown (mode {mode})")


def build_state(agent_version: str | None, hub_version: str | None) -> dict:
    """current | behind | unknown, against the hub's build. A version is a
    hash with no order: behind means "not the hub's build", never "older"."""
    if not hub_version or not agent_version:
        return {"state": "unknown", "hub_version": hub_version}
    return {
        "state": "current" if agent_version == hub_version else "behind",
        "hub_version": hub_version,
    }


def folders_of(facts: dict | None) -> tuple[str, ...]:
    """The known folders this agent reported (P16) — an @folder path is
    admitted only for these."""
    folders = facts.get("folders") if isinstance(facts, dict) else None
    return tuple(name for name in FOLDER_NAMES if isinstance(folders, dict) and folders.get(name))


# -- what she needs to act (S42b P29) ----------------------------------------


def _reasons_by_item(facts: dict | None) -> dict[str, str]:
    """Every unreadable reason, grouped by item and joined with "; " — a
    repeated item keeps ALL its reasons, not just the last one a naive
    dict comprehension would leave (Task 16b fix round 1, M3). Sanitized
    once here (Task 16b review, "F3, core side") — every reason text this
    module renders into a line reads from this, never a raw unreadable
    entry. Membership (`"x" in result`), not truthiness, is how a caller
    tells "the agent said something about x, even if it sanitized to
    empty" apart from "the agent never mentioned x at all" (Task 16b fix
    round 1, I3a)."""
    by_item: dict[str, list[str]] = {}
    for u in (facts.get("unreadable") or []) if isinstance(facts, dict) else []:
        if isinstance(u, dict) and isinstance(u.get("item"), str):
            by_item.setdefault(u["item"], []).append(_sanitized_line(u.get("reason", "")))
    return {item: "; ".join(r for r in reasons if r) for item, reasons in by_item.items()}


def _reason_for(facts: dict | None, item: str) -> str:
    """One item's joined, sanitized reason — "" when the agent said
    nothing about it."""
    return _reasons_by_item(facts).get(item, "")


def _service_field(value: str | int, facts: dict | None, item: str) -> str:
    """One service field, as "unknown" (with the agent's own reason, when
    given) rather than a bare blank — "binary ; config ;" and "process
    pid 0" were exactly this bug, the sentence breaking around a field
    the agent left out (Task 16b fix round 1, M2). `item` matches the
    agent's own unreadable item name, e.g. "service.binary"."""
    if value:
        return str(value)
    reason = _reason_for(facts, item)
    return f"unknown ({reason})" if reason else "unknown"


def runs_line(facts: dict | None) -> str:
    """How this agent runs, from what it probed about itself."""
    s = facts.get("service") if isinstance(facts, dict) else None
    if not isinstance(s, dict):
        # service can be missing for reasons that have nothing to do with
        # the agent's age (Task 16b fix round 1, I1): the probe frame has
        # not landed yet (up to ~45s after every fresh connect — auth
        # REPLACES facts, and the probe is a separate, later frame), a
        # probe too big for one frame (the agent says why under
        # unreadable item "probe"), a probe frame core refused, or facts
        # is None outright. Never guessed which.
        reason = _reason_for(facts, "probe")
        return f"{_UNKNOWN_RUNS} ({reason})" if reason else _UNKNOWN_RUNS
    mode = (facts.get("agent") or {}).get("mode") if isinstance(facts, dict) else None
    if not s["name"]:
        by = "no service — started by hand"
    elif mode == "run-key":
        # A Windows Run-key value is not a service (Task 16b fix round 1,
        # M2) — it is a registry value under HKCU\...\Run, read at
        # sign-in by the shell, with none of a real service's lifecycle.
        by = f"the Windows Run key {s['name']}"
    else:
        by = f"service {s['name']}"
    binary = _service_field(s["binary"], facts, "service.binary")
    config = _service_field(s["config"], facts, "service.config")
    process = _service_field(s["process"], facts, "service.process")
    user = _service_field(s["user"], facts, "service.user")
    pid = _service_field(s["pid"], facts, "service.pid")
    sup = f", supervisor pid {s['supervisor_pid']}" if s["supervisor_pid"] else ""
    return (
        f"how it runs: {by}; binary {binary}; config {config}; "
        f"process {process} pid {pid}{sup}; as {user}"
    )


def _sudo_words(state: str, *, windows: bool) -> str:
    """The words for a sudo/elevation state. `_SUDO_WORDS` is Windows'
    table; on anything else — a native Linux or macOS agent, or a WSL
    distro's own account, which is never "Windows sudo" however the
    Windows host beside it is configured — EVERY word that would claim
    that is overridden (Task 16b fix round 1, M1), not just "unknown"."""
    table = _SUDO_WORDS if windows else {**_SUDO_WORDS, **_SUDO_WORDS_NOT_WINDOWS}
    return table.get(state, state)


def _said_suffix(e: dict, *, windows: bool) -> str:
    """The agent's own words for why a sudo state reads as it does —
    "refused" (needs a password) and "unknown" (could not be read) both
    carry one, on every platform (Task 16b fix round 1, I4: Windows
    dropped sudo_said entirely; Linux/macOS only showed it for
    "refused"). The mechanism differs by platform — `sudo -n` on
    Linux/macOS and inside a WSL distro, a registry read on Windows — so
    the words naming it do too."""
    if e["sudo"] not in ("refused", "unknown") or not e["sudo_said"]:
        return ""
    if windows:
        return f" (it said: {e['sudo_said']})"
    return f" (sudo -n said: {e['sudo_said']})"


def elevation_line(facts: dict | None, platform: str) -> str | None:
    """Whether elevating from this agent would need a person right now —
    and why. States only the present: it is never a promise, or a ruling
    out, of some other admin path (Task 16b review). States only what the
    agent actually READ, never an inferred UAC prompt behavior the agent
    never checked (Task 16b fix round 1, M7)."""
    e = facts.get("elevation") if isinstance(facts, dict) else None
    if not isinstance(e, dict):
        return None
    windows = platform == "windows"
    sudo = _sudo_words(e["sudo"], windows=windows) + _said_suffix(e, windows=windows)
    if windows:
        if e["elevated"]:
            head = "the agent runs with admin rights (an elevated token)"
        else:
            admin = e.get("admin")
            if admin is True:
                # Not "asks for consent at a UAC prompt": the agent reads
                # whether the account IS an administrator and whether its
                # OWN token is elevated — never
                # ConsentPromptBehaviorAdmin, the registry value that
                # actually decides what a UAC prompt looks like, or
                # whether there is one at all (Task 16b fix round 1, M7 —
                # say only what the agent read).
                head = (
                    "the agent runs without admin rights; the account it runs as is an "
                    "administrator, but its own token is not elevated (UAC) — admin work "
                    "needs elevating first, which a command cannot do for itself"
                )
            elif admin is False:
                head = (
                    "the agent runs without admin rights, and this account is not an "
                    "administrator: admin work needs an administrator's password at a UAC "
                    "prompt, which a command cannot answer"
                )
            else:
                # admin is nil exactly when the membership read failed
                # (elevation_windows.go) — never read as "no" (Task 16b
                # fix round 1, I2).
                head = (
                    "the agent runs without admin rights, and whether the account it runs "
                    "as is an administrator could not be read"
                )
        if e["sudo"] in _SUDO_NEEDS_MEASUREMENT:
            sudo += WINDOWS_SUDO_FROM_AGENT
        return f"elevation: {head}; {sudo}"
    if e["elevated"]:
        return "elevation: the agent runs as root"
    return f"elevation: {sudo}"


def _nova_agent_in(d: dict, why: dict[str, str]) -> str:
    pids = d["novad_pids"]
    if pids is None:
        # Absent or null, never collapsed into "none" (Task 16b review,
        # "unknown is never none") — only an explicit [] means confirmed
        # empty, handled by the `elif pids` branch below.
        procs = "whether a novad process runs there could not be read"
    elif pids:
        procs = f"novad process pid {', '.join(map(str, pids))}"
        cut_off = why.get("wsl_distros." + d["name"] + ".novad_pids")
        if cut_off is not None:
            # More than 8 novad processes were found (probe.go); the
            # agent lists only the first 8 and says so (Task 16b fix
            # round 1, M3) — never silently as if that were all of them.
            procs += f" (more may be running: {cut_off or 'no reason given'})"
    else:
        procs = "no novad process"
    unit = d["novad_unit"]
    if unit is None:
        return procs
    if not unit["active"]:
        return f"its user units could not be read ({unit['said'] or 'no answer'}); {procs}"
    if not unit["file"] and unit["active"] == "inactive":
        return f"no novad.service user unit; {procs}"
    # A failed unit's main_pid is 0 — not a pid (Task 16b fix round 1, M6).
    main_pid = f"main pid {unit['main_pid']}" if unit["main_pid"] else "not running"
    return (
        f"{d['user'] or 'its default user'}'s systemd user unit novad.service is {unit['active']} "
        f"({unit['file'] or 'no unit file'}, Restart={unit['restart'] or 'unknown'}, "
        f"{main_pid}) — a user unit is managed with systemctl --user as that "
        f"user, without sudo (a command Nova runs may need XDG_RUNTIME_DIR=/run/user/<uid> set "
        f"— the agent's own look set it); {procs}"
    )


def _distro_words(d: dict, why: dict[str, str], running_said: str) -> str:
    bits = ["default"] if d["default"] else []
    bits.append(f"WSL {d['version']}" if d["version"] else "WSL version unknown")
    if not d["running"]:
        if running_said:
            # The list that says who is running could not itself be read
            # (below) — this distro's own `running: false` is only as good
            # as that list, so it is never read as a confirmed "not
            # running" (Task 16b review).
            bits.append("whether it runs could not be read")
        else:
            bits.append("not running — not looked inside, since looking would start it")
    elif not d["looked"]:
        reason = why.get("wsl_distros." + d["name"], "no reason given")
        bits.append(f"running; could not look inside: {reason}")
    else:
        bits.append("running")
        if d["pid1"] == "systemd":
            bits.append("systemd")
        elif d["pid1"]:
            bits.append(f"no systemd (PID 1 is {d['pid1']})")
        else:
            # An empty pid1 is a FAILED /proc/1/comm read, never a
            # confirmed "no systemd" (Task 16b fix round 1, I2).
            bits.append("whether systemd runs could not be read")
        if d["user"]:
            bits.append(f"default user {d['user']}")
        if d["sudo"]:
            bits.append(_sudo_words(d["sudo"], windows=False) + _said_suffix(d, windows=False))
        # wsl.exe -u root with no -d targets the DEFAULT distro — right
        # only for one of them (Task 16b fix round 1, M6).
        wsl_cmd = "wsl.exe -u root" if d["default"] else f"wsl.exe -d {d['name']} -u root"
        bits.append(
            f"root through {wsl_cmd} without a password" if d["root"] else f"{wsl_cmd} did not run"
        )
        bits.append(_nova_agent_in(d, why))
    return f"{d['name']} ({', '.join(bits)})"


def _wsl_unreadable_line(why: dict[str, str]) -> str | None:
    """The one place "the distribution list could not be read" is
    composed — used whether wsl_distros was omitted entirely (the agent's
    own failed-probe shape) or sent with an empty distros list (Task 16b
    fix round 1, I3)."""
    if "wsl_distros" not in why:
        return None
    reason = why["wsl_distros"] or "no reason given"
    return f"WSL: the list of distributions could not be read ({reason})"


def wsl_line(facts: dict | None) -> str | None:
    """The WSL distributions beside a Windows agent, as it looked at them."""
    if not isinstance(facts, dict):
        return None
    why = _reasons_by_item(facts)
    w = facts.get("wsl_distros")
    if not isinstance(w, dict):
        # The agent's own failed-probe shape omits wsl_distros entirely
        # and says why under unreadable item "wsl_distros" (Task 16b fix
        # round 1, I3b) — still a WSL line, never silence.
        return _wsl_unreadable_line(why)
    if not w["distros"]:
        # An empty list is not the same claim as a list that could not be
        # read at all (Task 16b review) — the agent never confirmed zero
        # distros, so this never reads as "none installed" (I3a: tests
        # the entry's EXISTENCE via `in`, not its reason's truthiness, so
        # an empty or all-control-character reason still counts).
        return _wsl_unreadable_line(why) or "WSL: no distribution is installed for this account"
    running_said = w.get("running_said", "")
    said = f" (wsl.exe --list --running said: {running_said})" if running_said else ""
    # More than 8 distros were found; the agent lists only the first 8 and
    # says so under the same item (Task 16b fix round 1, M3) — a
    # non-empty list is not proof it is the WHOLE list.
    cut_off = (
        f" (not every distribution is shown: {why['wsl_distros'] or 'no reason given'})"
        if "wsl_distros" in why
        else ""
    )
    return (
        "WSL on it, reached through this agent's wsl.exe: "
        + "; ".join(_distro_words(d, why, running_said) for d in w["distros"])
        + cut_off
        + said
    )


def _has_probed(facts: dict | None) -> bool:
    """Whether this agent has reported ANY S42b probe data — as opposed to
    genuinely never having probed (predates S42b, has not connected since,
    or the probe frame has not landed, likeliest right after a fresh
    connect: auth REPLACES facts, and the probe frame follows separately,
    up to ~45s later). Gates only the trailing "(probed ...)" line — the
    how-it-runs, elevation and WSL lines each render independently off
    their own section, never off this (Task 16b fix round 1, I1)."""
    if not isinstance(facts, dict):
        return False
    return (
        "service" in facts
        or "elevation" in facts
        or "wsl_distros" in facts
        or "probed_at" in facts
        or bool(_reason_for(facts, "probe"))
    )


def acting_lines(facts: dict | None, platform: str) -> list[str]:
    """What she needs to act on this machine without being told (S42b P29),
    as sentences for device_info, device_list and machine_status — derived
    from what the agent probed, with when; never a prompt list.

    Each line is independent (Task 16b fix round 1, I1): a probe that is
    too big for one frame, one that core refused, or simply one that has
    not landed yet can leave `service` absent while `elevation` or
    `wsl_distros` are present, or the reverse — so the elevation and WSL
    lines are never gated on `service`'s presence, only on their own
    section's."""
    lines = [runs_line(facts)]
    lines.extend(line for line in (elevation_line(facts, platform), wsl_line(facts)) if line)
    if not _has_probed(facts):
        return lines
    # A Windows probe also walks the WSL distributions beside it (P29), the
    # slow part — bounded at 45s (global constraint), worth saying so here
    # rather than leaving a 45-second wait unexplained (Task 16b review).
    takes = (
        " — on Windows with WSL this can take up to about 45 seconds"
        if platform == "windows"
        else ""
    )
    when = facts.get("probed_at") or "at an unknown time"
    lines.append(f"(probed {when}; device_info probes again{takes})")
    return lines


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
            # The OS is written only at pairing (enroll); 'unknown' is what
            # migration 036 made of a value outside the known ones, and no
            # newer agent rewrites it — only a new pairing does.
            "reason": (
                "cannot: platform unknown — its pairing recorded no OS Nova knows, and the "
                "OS is recorded only at pairing; revoke it and pair it again"
            ),
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
    hub_version: str | None = None,
    last_transport: str | None = None,
    last_update: dict | None = None,
) -> dict:
    """One machine's agent, as the plant, machine_status and an eval fixture
    all see it. `machine` is the agent's machine_uid (None when it said
    none) — what "grouped by machine" groups on. `hub_version`, the door
    (`last_transport`) and `last_update` are core's own records, not facts
    the agent reported, so they ride in as arguments rather than being read
    out of `facts` (S42b)."""
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
        "mode": (facts.get("agent") or {}).get("mode") if isinstance(facts, dict) else None,
        "starts": starts(facts),
        "build": build_state(agent_version(facts), hub_version),
        "hub": last_transport == "host",
        "last_update": last_update,
        "folders": folders_of(facts),
        "acting": acting_lines(facts, platform),
    }
