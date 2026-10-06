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
# The sections ONE run of the probes carries (S42b P29), and with its time the
# keys that run is recorded under — always as one unit (merge_frame).
PROBE_SECTIONS: tuple[str, ...] = ("service", "elevation", "wsl_distros")
PROBE_KEYS: tuple[str, ...] = (*PROBE_SECTIONS, "probed_at")
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
# outcome regardless of console (sudo -n true was run, and failed) and
# "off"/"absent"/"unknown" have nothing to measure in the first place.
# WINDOWS_SUDO_FROM_AGENT is appended only for these three, never
# contradicting a state that already says what happens — "…a command using
# sudo fails — whether this works…" was exactly that contradiction.
_SUDO_NEEDS_MEASUREMENT: tuple[str, ...] = ("inline", "new_window", "input_off")
_MAX_DISTROS = 8
_MAX_PIDS = 8
_PID_MAX = 2**31 - 1
# What breaks one line wherever core renders text a machine sent: the C0
# controls (newline among them), DEL, the C1 controls (U+0085 NEL among them)
# and the line and paragraph separators str.splitlines() also splits on —
# the class agent_updates' reason rule (_BREAKS) uses. ONE predicate: P29's
# facts lines refuse a field it matches (_line), the unreadable reasons are
# stripped of it (_sanitized_line), and enroll refuses a hostname or a name
# it matches (devices._sent_text, Task 26 fix round 1, I2). Before that round
# it was C0 and DEL only.
LINE_BREAKS = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
# S42b P29: Windows' sudo has run-modes (off/new_window/input_off/inline)
# native sudo does not — this table is WINDOWS' words. A WSL distro's own
# account, and a native Linux/macOS agent, never run "Windows sudo", so
# _sudo_words (below) overrides EVERY word that would otherwise claim that —
# not just "unknown" (Task 16b fix round 1, M1: "off"/"new_window"/
# "input_off"/"inline" still read "Windows sudo is on (inline)" etc. on
# Linux and inside a WSL distro before this).
_SUDO_WORDS = {
    "no_password": "sudo runs without a password",
    # The agent files EVERY failure of `sudo -n true` as "refused" —
    # elevation_unix.go's default branch, the look's `else echo
    # sudo=refused` — "not in sudoers" as well as a password required. So
    # the words say only that it failed; sudo's own words (_said_suffix)
    # say why (Task 16b fix round 2, finding 7).
    "refused": "sudo -n true failed here",
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
# A command-line argument that reads the same, unquoted, in cmd.exe,
# PowerShell, a POSIX shell and a Windows program's own argv parser.
_BARE_ARG = re.compile(r"[A-Za-z0-9._-]+")
# A Windows registry path, as probe.go names a Run-key entry: HKCU\...
_REGISTRY_PATH = re.compile(r"HK[A-Z_]+\\", re.IGNORECASE)

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
    if LINE_BREAKS.search(text):
        raise FactsRejected(f"{where} contains a control character or a line separator")
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
    through this one function first: LINE_BREAKS stripped, never
    rejected, and the result bounded to `_MAX_TEXT` (Task 16b review, "F3,
    core side")."""
    clean = LINE_BREAKS.sub("", text)
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


def probe_owned(entry: object) -> bool:
    """Whether an unreadable entry is one a probe filed about its own
    sections ("service.binary", "elevation", "wsl_distros.<name>.root"):
    the item's head names a probe section. Everything else ("folders.…",
    "net.…", the auth-frame items, "probe" itself — the frame saying a
    probe's findings did not fit) is the frame's own."""
    item = entry.get("item") if isinstance(entry, dict) else None
    return isinstance(item, str) and item.split(".", 1)[0] in PROBE_SECTIONS


def merge_frame(stored: dict | None, sections: dict) -> dict:
    """What devices.facts holds once a facts frame's sections (validate_frame)
    land on what the device said before. A section the frame does not carry
    is kept, so the auth facts survive a frame of net/unreadable alone.

    A PROBE is one unit, keyed on its time (Task 21 ruling, probe
    freshness): a frame that carries probed_at replaces every probe section —
    service, elevation, wsl_distros, probed_at and the probe's own
    unreadable entries (probe_owned) — and a section that probe omits is
    removed, never kept from an older probe: a merged older WSL list would
    read as fresh under the newer time. A frame without probed_at leaves the
    probe alone, its reasons included — and a probe section such a frame
    carries is not recorded, since no time says when it was read."""
    old = dict(stored) if isinstance(stored, dict) else {}
    new = dict(sections)
    held = old.get("unreadable")
    held = held if isinstance(held, list) else None
    if "probed_at" in new:
        for key in PROBE_KEYS:
            old.pop(key, None)
        if "unreadable" not in new and held is not None:
            old["unreadable"] = [u for u in held if not probe_owned(u)]
    else:
        for key in PROBE_SECTIONS:
            new.pop(key, None)
        if "unreadable" in new:
            new["unreadable"] = [u for u in new["unreadable"] if not probe_owned(u)] + [
                u for u in held or [] if probe_owned(u)
            ]
    return {**old, **new}


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


def folders_unread(facts: dict | None) -> dict[str, str]:
    """Why the agent could not report each known folder it filed under
    "folders.<name>" (Task 7: a folder its OS does not name, or a path too
    long to send whole), in its own words, sanitized — "" when it gave none.
    A folder it said nothing about is absent."""
    why = _reasons_by_item(facts)
    return {name: why[f"folders.{name}"] for name in FOLDER_NAMES if f"folders.{name}" in why}


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


def _clip(text: str) -> str:
    """The agent's clip (facts.go): at most _MAX_TEXT BYTES of UTF-8, cut
    back to the start of a character. probe.go clips every unreadable item it
    files after a distribution — "wsl_distros.<name>", then that clipped
    item plus ".root" or ".novad_pids" — so core builds its lookup keys the
    same way, or never finds a long name's reason (Task 16b fix round 2,
    M3). Text core holds is valid UTF-8: _encoded_size refused a surrogate."""
    raw = text.encode("utf-8")
    if len(raw) <= _MAX_TEXT:
        return text
    cut = _MAX_TEXT
    while cut > 0 and raw[cut] & 0xC0 == 0x80:  # a continuation byte
        cut -= 1
    return raw[:cut].decode("utf-8")


def _distro_item(name: str, part: str = "") -> str:
    """The unreadable item probe.go files for a distribution (its look), or
    for one part of it ("root", "novad_pids") — clipped exactly as the agent
    clips it. From 242 bytes of name up, the agent's clip makes the root and
    pids items one string; a caller reads which one a reason is from the
    distro's own fields."""
    item = _clip("wsl_distros." + name)
    return _clip(f"{item}.{part}") if part else item


def _windows_arg(text: str) -> str:
    """One argument of a Windows command line, written so the command runs
    as written: bare when it is only letters, digits, '.', '_' and '-',
    else in double quotes by the rule a Windows program's argv parser reads
    back (CommandLineToArgvW — what wsl.exe reads its own -d with): a quote
    inside is \\", and the backslashes just before a quote, or before the
    closing one, double (Task 16b fix round 2, M6)."""
    if _BARE_ARG.fullmatch(text):
        return text
    out: list[str] = []
    slashes = 0
    for ch in text:
        if ch == "\\":
            slashes += 1
            continue
        if ch == '"':
            out.append("\\" * (2 * slashes + 1) + '"')
        else:
            out.append("\\" * slashes + ch)
        slashes = 0
    return '"' + "".join(out) + "\\" * (2 * slashes) + '"'


def _service_kind(name: str) -> str:
    """What the agent's service is, read from the name its probe gives it
    (Task 16b fix round 2, M2) — never from facts.agent.mode, which the row
    lacks whenever its auth facts were refused (the row is cleared to NULL,
    and the next facts frame merges into {}). probe.go's serviceOf names a
    systemd unit or a LaunchAgent by the name its manager knows it by, and a
    Run-key entry by its registry path, HKCU\\<RunKeyPath>\\<RunKeyValue>: a
    registry path is a registry value, never a service. "" is the agent's
    own word for started by hand (Service.Name in probe.go)."""
    if not name:
        return "no service — started by hand"
    if not _REGISTRY_PATH.match(name):
        return f"service {name}"
    key = name.rpartition("\\")[0]
    if key.rpartition("\\")[2].lower() == "run":
        return f"the Run-key value {name}"
    return f"the registry value {name}"


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
    by = _service_kind(s["name"])
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
    """The words behind a sudo state — "refused" and "unknown" both carry
    them, on every platform (Task 16b fix round 1, I4), each labelled as
    whose words they are (Task 16b fix round 2, finding 10). A refusal's
    sudo_said is sudo's own first line (elevation_unix.go, the look's
    sudo.said). An "unknown" one is the AGENT's: probe.go's failed(err) for
    a sudo that gave no answer or never started — sudo said nothing — and
    windowsSudo's read on Windows, where no sudo -n ever runs."""
    if e["sudo"] not in ("refused", "unknown") or not e["sudo_said"]:
        return ""
    if e["sudo"] == "unknown" or windows:
        return f" (the agent said: {e['sudo_said']})"
    return f" (sudo -n said: {e['sudo_said']})"


def _windows_head(facts: dict, e: dict) -> str:
    """What elevation_windows.go read: whether the agent's own token is
    elevated, and whether the account is in Administrators — never
    ConsentPromptBehaviorAdmin or ConsentPromptBehaviorUser, which decide
    whether admin work meets a UAC prompt. So the head says those two
    things and nothing about prompts but that, for an administrator, it is
    not measured yet — Task 1's Dell reading settles it, as it settles
    Windows sudo — and it never answers what the sudo tail on the same line
    says is open (Task 16b fix round 2, M7)."""
    if e["elevated"]:
        return "the agent runs with admin rights (an elevated token)"
    head = "the agent runs without admin rights (its token is not elevated); "
    admin = e.get("admin")
    if admin is True:
        return head + (
            "the account it runs as is an administrator; whether admin work from Nova's "
            "commands would stop at a UAC prompt has not been measured yet"
        )
    if admin is False:
        return head + "the account it runs as is not an administrator"
    # admin is nil exactly when the token or membership read failed, and the
    # agent says why under unreadable item "elevation" (elevation_windows.go,
    # probe.go) — never read as "no" (Task 16b fix round 1, I2).
    reason = _reason_for(facts, "elevation") or "no reason given"
    return head + f"whether the account it runs as is an administrator could not be read ({reason})"


def elevation_line(facts: dict | None, platform: str) -> str | None:
    """Whether elevating from this agent would need a person right now —
    and why. States only the present: it is never a promise, or a ruling
    out, of some other admin path (Task 16b review). States only what the
    agent actually READ, never an inferred UAC prompt behavior the agent
    never checked (Task 16b fix round 1, M7; round 2, M7)."""
    e = facts.get("elevation") if isinstance(facts, dict) else None
    if not isinstance(e, dict):
        return None
    windows = platform == "windows"
    sudo = _sudo_words(e["sudo"], windows=windows) + _said_suffix(e, windows=windows)
    if windows:
        if e["sudo"] in _SUDO_NEEDS_MEASUREMENT:
            sudo += WINDOWS_SUDO_FROM_AGENT
        return f"elevation: {_windows_head(facts, e)}; {sudo}"
    if e["elevated"]:
        # elevated is geteuid() == 0 on Linux and macOS, an elevated token
        # on Windows: a row whose platform is 'unknown' (migration 036)
        # cannot say which (Task 16b fix round 2, finding 8).
        root = platform in PLATFORMS
        return f"elevation: the agent runs {'as root' if root else 'elevated'}"
    return f"elevation: {sudo}"


def _nova_agent_in(d: dict, why: dict[str, str]) -> str:
    pids = d["novad_pids"]
    pids_said = why.get(_distro_item(d["name"], "novad_pids"))
    if pids is None:
        # Absent or null, never collapsed into "none" (Task 16b review,
        # "unknown is never none") — only an explicit [] means confirmed
        # empty, handled by the `elif pids` branch below. probe.go says
        # why under the pids item (pgrep missing, or failed).
        procs = "whether a novad process runs there could not be read"
        if pids_said is not None:
            procs += f" ({pids_said or 'no reason given'})"
    elif pids:
        procs = f"novad process pid {', '.join(map(str, pids))}"
        if len(pids) == _MAX_PIDS and pids_said is not None:
            # More than 8 novad processes were found (probe.go); the
            # agent lists only the first 8 and says so (Task 16b fix
            # round 1, M3) — never silently as if that were all of them.
            # It cuts only at eight, so a reason beside fewer is not this
            # one: from 242 bytes of name up the pids item IS the root
            # item, and a root check's reason is never a cut-off list.
            procs += f" (more may be running: {pids_said or 'no reason given'})"
    else:
        procs = "no novad process"
    unit = d["novad_unit"]
    if unit is None:
        return procs
    if not unit["active"]:
        return f"its user units could not be read ({unit['said'] or 'no answer'}); {procs}"
    if not unit["file"] and unit["active"] == "inactive":
        return f"no novad.service user unit; {procs}"
    # A main_pid of 0 is not a pid (Task 16b fix round 1, M6), and not "not
    # running" either: systemd says 0 for a unit with no main process it
    # tracks, and the agent's parse leaves 0 when the line is missing — an
    # active unit read "active (…, not running)" (Task 16b fix round 2,
    # finding 11). Left out; the unit's own state says whether it runs.
    main_pid = f", main pid {unit['main_pid']}" if unit["main_pid"] else ""
    return (
        f"{d['user'] or 'its default user'}'s systemd user unit novad.service is {unit['active']} "
        f"({unit['file'] or 'no unit file'}, Restart={unit['restart'] or 'unknown'}"
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
        # An empty reason is no reason, never "could not look inside: )"
        # (Task 16b fix round 2, finding 9).
        reason = why.get(_distro_item(d["name"])) or "no reason given"
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
        # Always -d <name> (Task 16b fix round 2, M6): the agent ran
        # `wsl.exe -d <name> -u root` (probe.go), and which distro is the
        # default may have changed since — so the default one is named too.
        wsl_cmd = f"wsl.exe -d {_windows_arg(d['name'])} -u root"
        if d["root"]:
            bits.append(f"root through {wsl_cmd} without a password")
        else:
            # The check failed, gave no answer in time, or never started —
            # the agent says which under the root item, and never claims a
            # program it stopped waiting for stopped (bounded.go). Not
            # confirmed, never "did not run" (Task 16b fix round 2, finding 6).
            said = why.get(_distro_item(d["name"], "root")) or "no reason given"
            bits.append(f"root through {wsl_cmd} not confirmed ({said})")
        bits.append(_nova_agent_in(d, why))
    return f"{d['name']} ({', '.join(bits)})"


def wsl_line(facts: dict | None) -> str | None:
    """The WSL distributions beside a Windows agent, as it looked at them.

    Under unreadable item "wsl_distros" probe.go files several things: the
    whole list it could not read (and then wsl_distros is left out), and,
    beside a list it did read, a DefaultDistribution it could not read, a
    key under Lxss it could not open (which may not be a distribution at
    all), a name it could not read, or "more than 8 distributions; the rest
    are not listed". Only the shape tells the first apart; the rest are said
    by a wording true of all of them — part of WSL's list could not be read
    — in the agent's own words, never "not every distribution is shown"
    (Task 16b fix round 2, finding 5). Membership (`in`), never a reason's
    truthiness, says whether the agent filed one (Task 16b fix round 1, I3a)."""
    if not isinstance(facts, dict):
        return None
    why = _reasons_by_item(facts)
    filed = why.get("wsl_distros")
    w = facts.get("wsl_distros")
    if not isinstance(w, dict):
        # The agent's own failed-list shape omits wsl_distros entirely and
        # says why under "wsl_distros" (Task 16b fix round 1, I3b) — still a
        # WSL line, never silence.
        if filed is None:
            return None
        return f"WSL: the list of distributions could not be read ({filed or 'no reason given'})"
    part = None
    if filed is not None:
        part = f"part of WSL's list could not be read: {filed or 'no reason given'}"
    if not w["distros"]:
        # Read, and empty — but beside a reason it is not "none installed"
        # (Task 16b review): the key it could not open may be one.
        if part is not None:
            return f"WSL: no distribution is listed; {part}"
        return "WSL: no distribution is installed for this account"
    running_said = w.get("running_said", "")
    # running_said is failed(listErr): the agent's words about the list
    # command, which may never have answered — not wsl.exe's (Task 16b fix
    # round 2, finding 10).
    said = f" (wsl.exe --list --running failed: {running_said})" if running_said else ""
    return (
        "WSL on it, reached through this agent's wsl.exe: "
        + "; ".join(_distro_words(d, why, running_said) for d in w["distros"])
        + ("" if part is None else f" ({part})")
        + said
    )


def _has_probed(facts: dict | None) -> bool:
    """Whether this agent has reported ANY S42b probe data — as opposed to
    genuinely never having probed (predates S42b, has not connected since,
    or the probe frame has not landed, likeliest right after a fresh
    connect: auth REPLACES facts, and the probe frame follows separately,
    up to ~45s later). Gates only the leading "as probed at …" line — the
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
    section's.

    When the agent has probed, the probe's time comes FIRST, before every
    line it dates (Task 21 fix round 1, I2): an unasked check hands her a
    result cut at 600 characters, and a time said last was cut away from the
    lines above it — "how it runs: … pid 812" from a probe of any age, read
    as current. Said first, any line she is shown has its time before it."""
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
    when = facts.get("probed_at") or "an unknown time"
    return [f"as probed at {when} (device_info probes again{takes})", *lines]


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
