"""The nine device tools — ordinary tools that happen to reach a second machine.

The model never talks to a daemon. It calls these like any other tool, and what
each envelope-backed tool establishes before it sends is a matter of FACT,
never of permission (owner ruling 2026-09-03: v4 makes no authorization
decisions). In order (`_admit`):

  1. paired (identity) — resolve the device by name, through the plant
     (machines.plant().paired_device: the live registry; in an eval replay,
     its declared machines, none of which a command can reach — so no
     command reaches a real agent during an eval, Task 22 fix round 1). A
     revoked or unknown name is a stated ToolFailure naming the live devices,
     never a silent no-op. Core signs only for a key it bound at pairing.
  2. reachable (transport) — the device's socket is live in the hub. An
     offline machine is the stated "not connected — its tile is stale" refusal.
  3. for fs.* tools, the path is absolute ON THE DEVICE'S OS — posix on Linux
     and macOS; a drive or a share on Windows — and normalized once with that
     OS's own rules. A relative path would resolve against the daemon's cwd,
     so it cannot be sent as asked. This is a shape check, not a boundary:
     there are no filesystem roots, and any absolute path is sent.

Then core signs the envelope and sends it (`_command`), and only the device's
own `result` frame comes back as success: a timeout, a dropped socket or a
device-reported failure is a ToolFailure, so nothing reads as done that the
device did not actually do. Every refusal above states that the call CANNOT
run; none says it MAY not — there is no grant, no root, no card, and nothing
here refuses on the owner's behalf.

Reads are ephemeral (a live point-in-time answer, like fetch_url); writes,
launches and shell runs are not.
"""

from __future__ import annotations

import logging
import ntpath
import posixpath
import re
from contextvars import ContextVar

from app import (
    code_repo,
    code_repos,
    db,
    device_facts,
    devices,
    devices_ws,
    envelopes,
    guards,
    machines,
    model_machines,
    network,
)
from app.tools import machines as machine_tools
from app.tools.base import (
    RESULT_KIND_LISTING,
    Tool,
    ToolContext,
    ToolFailure,
    listing_line_shown,
)

# How long core waits for a device to answer one command. Bounded (<=120s per
# the plan) because a command with no answer must become a STATED failure, not
# a hang — "accepted by transport" is never "received".
COMMAND_TIMEOUT_SECONDS = 120

# How long device_info waits for the agent's fresh look (facts.refresh). The
# agent bounds a whole probe at 45 s (P29; apps/novad client.ProbeBudget),
# then writes its facts frame — a write it bounds at 10 s (PingTimeout),
# possibly behind one other facts write bounded the same — and only then
# answers. Past this the refresh is said to have had no answer, and the lines
# are said to be the last probe's; it is never waited on to the command bound.
REFRESH_TIMEOUT_SECONDS = 70

# device_read_file's cap. Enforced ON THE DEVICE (T3) — stated here so the model
# knows the boundary before it asks, not after a truncation it cannot see.
READ_FILE_CAP_KIB = 256

# device_write_file's cap — the same 256 KiB fs domain as the read cap and the
# roadmap's "no v1 capability moves >256 KiB". Enforced HERE, mechanically,
# BEFORE the envelope reaches the transport: an oversize write would otherwise
# blow past the socket read limit and flap the connection into a command
# timeout — a hang, not the stated refusal the rail requires. The device caps it
# too (defence in depth).
WRITE_FILE_CAP_KIB = 256

# device_edit_file's cap: the agent's EditCap (apps/novad/internal/caps/
# fs_edit.go). Enforced ON THE DEVICE — stated here so the model knows it.
EDIT_FILE_CAP_MIB = 16

log = logging.getLogger(__name__)

# The KIND of turn (traces.purpose_of) a device call is serving, set by the
# one place a turn runs — chat._run_turn, for the turn's duration. Unset
# (None) is no turn at all: a push without a turn, or a call outside the loop.
# Read only by _names_armed: a fact's `known_as` costs a gateway providers
# read, and the one reader of those names is the stack-claim guard, armed
# only in guards.STACK_CLAIM_KINDS — so a beat, a reminder or an agent turn
# (no stack-claim guard) makes no providers read. A ContextVar, not a
# ToolContext field: the context's fields are pinned by test_no_approvals, and
# this is not a principal either — nothing reads it to refuse a call, only to
# skip recording names nobody will read.
TURN_PURPOSE: ContextVar[str | None] = ContextVar("device_tools_turn_purpose", default=None)

_DEVICE_ARG = {
    "type": "string",
    "description": "The name of the paired device, as shown in Settings → Devices.",
}


# -- the per-device layer ----------------------------------------------------


async def _resolve(app, name: object):
    """The live row for a device named `name`, or a ToolFailure that names it.
    A revoked device has no live row, so it is refused here by absence.

    Resolved through the plant (Task 22 fix round 1, 6): in an eval replay
    the plant holds the declared machines alone and resolves NO row — a real
    machine's name is not a paired device there, a declared one has no agent
    a command could reach — so the real registry is never read and nothing
    is ever sent to a real agent from inside a replay."""
    if not isinstance(name, str):
        raise ToolFailure("the 'device' argument must be the device's name")
    try:
        return await machines.plant().paired_device(app, name)
    except machines.UnknownMachine as exc:
        raise ToolFailure(str(exc)) from exc


async def _known_as(row, ctx: ToolContext) -> list[str]:
    """The names a reply may call this device by (stack-claim epic T3): its
    paired name, its row's hostname, then every remote model provider whose
    URL model_machines.device_of maps to THIS device — the gateway's
    providers (tools/machines._remotes: on a machine, never the bundled
    engine) matched against Nova's agents and the tailnet peers, the read
    machine_status makes. A provider that maps to another device, or to none,
    adds nothing. A providers or agents read that fails drops the provider
    names only — said in the log, never raised: the call still runs, and the
    guard reading these names then fails toward firing."""
    known = [row["name"]]
    hostname = row["hostname"] if "hostname" in row.keys() else None
    if isinstance(hostname, str) and hostname.strip():
        known.append(hostname.strip())
    reader = machines.plant()
    remotes, error = await machine_tools._remotes(reader, ctx)
    if error is not None:
        log.info("device %s: remote provider names not read — %s", row["name"], error)
        return known
    if not remotes:
        return known
    # Through machine_status's own agents read (tools/machines._agents), the
    # one named place an agents listing reaches a reply or a guard; only the
    # names it maps to are kept here, never its connectivity.
    agents, agents_error = await machine_tools._agents(reader, ctx)
    if agents_error is not None:
        log.info(
            "device %s: agents not read, provider names dropped — %s", row["name"], agents_error
        )
        return known
    peers = network.tailnet_peers()
    for remote in remotes:
        found = model_machines.device_of(remote["base_url"], agents, peers)
        if found["device"] == row["name"] and isinstance(remote["name"], str):
            known.append(remote["name"])
    return known


def _names_armed(ctx: ToolContext | None) -> bool:
    """Whether a device call's connectivity fact carries `known_as`: only with
    a sink to record it on, and only in a turn whose kind arms the guard that
    reads it (guards.STACK_CLAIM_KINDS — the guard's own set, never a second
    list). An unstated purpose is no turn's, so nothing reads the names."""
    if ctx is None or ctx.facts_sink is None:
        return False
    return TURN_PURPOSE.get() in guards.STACK_CLAIM_KINDS


def _require_connected(
    row,
    ctx: ToolContext | None = None,
    known_as: list[str] | None = None,
    replay: machines.ReplayAgent | None = None,
) -> None:
    """Refuse unless the device's socket is live in the hub right now. The same
    words hub.command uses for a socket that is gone by the time it sends, so
    the model reads one refusal for one fact whichever layer states it.

    This is also the ONE place core DETERMINES a device's connectivity, so it is
    where that fact is recorded on `ctx.facts_sink` — for BOTH outcomes, before
    the refusal is raised. A refusal is still a check: "I ran it and it came back
    not connected" is a TRUE report of a live read, and without this record the
    state-claim guard would correct it (a false correction of an honest reply is
    the worst thing that guard can do). Structured, so nothing downstream ever
    has to read a refusal string to learn what happened.

    Runs exactly once per call, so every call's span carries its own record —
    the chat loop slices the sink per call, and a record suppressed here would
    leave a later call on the same device looking unchecked.

    In an eval replay a declared device's connectivity is its declaration's
    (`replay`, machines.ReplayAgent — S29b T5), never the hub's: recorded and
    refused here in the same words, so the replay reads as a real call does.
    """
    connected = replay.connected if replay is not None else devices_ws.hub.is_connected(row["id"])
    if ctx is not None and ctx.facts_sink is not None:
        fact = {"device": row["name"], "connected": connected}
        if known_as is not None:
            fact["known_as"] = list(known_as)
        ctx.facts_sink.append(fact)
    if not connected:
        raise ToolFailure(
            f"device {row['name']!r} is not connected — its tile is stale; check it is "
            "powered on and online"
        )


# A Windows path the agent can open: a drive (C:\ or C:/) or a share
# (\\server\share\..., which is how \\wsl.localhost\<distro>\... reaches WSL).
_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")
_WINDOWS_SHARE = re.compile(r"^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+")
_WINDOWS_DEVICE = ("\\\\?\\", "\\\\.\\", "//?/", "//./")
# A known folder (S42b P16): @<name>, then optionally one "/" or "\" and the
# rest — the agent's own grammar (apps/novad internal/caps/fs.go resolvePath),
# which resolves it ON the machine, as its OS names the folder. Matched with
# fullmatch, never a `$` anchor, which also matches before a trailing newline
# and so passed "@desktop\n" on with it (Task 21 fix round 1). A line break a
# call's argument ENDS in is dropped before the match (_check_fs_path; Task 32,
# L452): "@desktop/notes\n" read the rest as "notes\n" and sent the agent a
# file name with a newline in it. One inside the token still names no folder.
_FOLDER_TOKEN = re.compile(r"@([a-z]+)(?:[\\/](.*))?", re.S)


def _check_fs_path(
    path: object,
    platform: str,
    folders: tuple[str, ...] = (),
    name: str = "this device",
    unread: dict[str, str] | None = None,
    predates_folders: bool = False,
) -> str:
    """The requested path must be absolute ON THE DEVICE'S OS; it is returned
    normalized. Lexical on purpose: the path names a file on the REMOTE
    machine, so it cannot be resolved here. A relative path would resolve
    against the daemon's cwd — a different file from the one asked for — so it
    is refused as malformed. `..` and `.` collapse under the OS's own normpath
    so the daemon receives one spelling.

    Or it names a known folder, @desktop/notes.txt (P16): passed through
    UNRESOLVED — less a line break it ends in — when the device's agent
    reported that folder (`folders`,
    device_facts.folders_of) — the machine resolves it as its OS names it,
    never core — and otherwise a stated cannot, in the agent's own words
    when it said why it could not read the folder (`unread`,
    device_facts.folders_unread). That the agent is from before S42b is said
    only when its own facts show it (`predates_folders`,
    device_facts.predates_folders); otherwise only that it reported none —
    an S42b agent whose frames core refused was told it was older
    (fix/facts-unreadable-null).

    linux/darwin: posix, a leading "/". windows: a drive or a share, checked
    EXPLICITLY — Python 3.12's ntpath.isabs also accepts a rooted path with
    no drive ("\\foo"), which names no file — then ntpath.normpath. Device
    paths (\\\\?\\, \\\\.\\) are refused: ntpath leaves them unnormalized, which
    would break the one-spelling rule. An unknown platform cannot be checked,
    and says so."""
    if isinstance(path, str) and path.startswith("@"):
        # The token is read without the line break the argument ends in, and
        # passed on without it: never a file named "notes\n" (Task 32, L452).
        path = path.rstrip("\r\n")
        m = _FOLDER_TOKEN.fullmatch(path)
        if m is None or m.group(1) not in device_facts.FOLDER_NAMES:
            known = ", ".join(f"@{n}" for n in device_facts.FOLDER_NAMES)
            raise ToolFailure(
                f"cannot: path {path!r} names no known folder — a folder is one of {known}, "
                "then an optional /rest"
            )
        folder = m.group(1)
        if folder not in folders:
            said = (unread or {}).get(folder)
            if said is not None:
                why = f"it said: {said or 'no reason given'}"
            elif folders:
                why = "it reported others, and filed no reason for this one"
            elif predates_folders:
                why = "it has reported no folders — an agent from before S42b reports none"
            else:
                why = "it has reported no folders"
            raise ToolFailure(
                f"cannot: {name}'s agent did not report its {folder} folder ({why}) — give an "
                "absolute path instead"
            )
        # Resolved on the machine (S42b P16): its OS names the folder, not core.
        return path
    if not isinstance(path, str):
        raise ToolFailure(f"path {path!r} must be text")
    if platform in ("linux", "darwin"):
        if not path.startswith("/"):
            raise ToolFailure(f"path {path!r} must be absolute — start it with /")
        return posixpath.normpath(path)
    if platform == "windows":
        if path.startswith(_WINDOWS_DEVICE):
            raise ToolFailure(
                f"path {path!r} is a Windows device path — give a drive path (C:\\...) or a "
                "share (\\\\server\\share\\...)"
            )
        if not (_WINDOWS_DRIVE.match(path) or _WINDOWS_SHARE.match(path)):
            raise ToolFailure(
                f"path {path!r} must be absolute on Windows — start it with a drive (C:\\) or a "
                "share (\\\\wsl.localhost\\<distro>\\ reaches WSL)"
            )
        return ntpath.normpath(path)
    raise ToolFailure(
        "cannot: platform unknown — this device's pairing recorded no OS Nova knows, and the "
        "OS is recorded only at pairing, so a path on it cannot be checked; revoke it and "
        "pair it again"
    )


async def admit_row(row, ctx: ToolContext | None = None):
    """The connected check for a row already resolved (by _resolve, or by
    code_repo.repo_machine for start_change): records the connectivity fact
    and refuses when the socket is not live. Returns the pool to send with.
    _admit runs it for every named-device tool, so the order still lives in
    one place.

    A replay's declared device (machines.ReplayAgent, S29b T5) has no pool to
    send with: its command is answered by the plant (_command), so None is
    returned and the pool is never opened."""
    replay = machines.plant().replay_agent(row["name"])
    pool = None if replay is not None else await db.get_pool()
    # The names the device is known by ride its connectivity fact (stack-claim
    # epic T3) — read only when there is a sink to record them on AND the
    # turn's kind arms the guard that reads them (_names_armed).
    known_as = await _known_as(row, ctx) if _names_armed(ctx) else None
    _require_connected(row, ctx, known_as, replay)
    return pool


async def _admit(args: dict, *, ctx: ToolContext | None = None, fs_path: bool = False):
    """The per-device layer, in order: paired (not revoked) -> connected ->
    (fs tools) absolute path on its OS. Returns (pool, row, normalized path or
    None) for an executor to send with; raises ToolFailure to refuse. This is
    the ONLY place the order lives.

    `ctx` is threaded through only so `_require_connected` can record the
    connectivity it determined on the turn's facts_sink; nothing here reads it
    to DECIDE anything. An unknown/revoked name refuses at `_resolve`, before
    connectivity is looked at, so it records nothing — it determined nothing.
    """
    # Resolved first, through the plant: a replay refuses here, before the
    # pool, the registry or the hub is touched.
    row = await _resolve(ctx.app if ctx is not None else None, args["device"])
    pool = await admit_row(row, ctx)
    path = (
        _check_fs_path(
            args["path"],
            row["platform"],
            device_facts.folders_of(row["facts"]),
            row["name"],
            device_facts.folders_unread(row["facts"]),
            device_facts.predates_folders(row["facts"]),
        )
        if fs_path
        else None
    )
    return pool, row, path


async def _command(
    pool,
    row,
    capability: str,
    args: dict,
    *,
    ctx: ToolContext | None = None,
    timeout: float | None = None,
) -> dict:
    """Send one command through the hub, restating a DeviceRefused as the
    ToolFailure the model reads. Only a `result` frame gets here as a return.

    The single funnel every envelope-backed device tool passes through, so the
    lone-surrogate guard lives here: an arg carrying an unpaired UTF-16
    surrogate cannot be canonicalized identically on the daemon (Go decodes it
    to U+FFFD), so it would surface as an opaque "signature did not verify". We
    refuse it BEFORE signing, naming the bad input, rather than shipping a
    mystery signature failure to the edge.

    `ctx` is threaded through only so hub.command can record the ONE gap
    `_require_connected` cannot see: a device present at `_admit` time whose
    socket is gone by the time this actually sends (review N3). Passing None
    is fine — every caller in this module has a ctx, but the sink is optional
    the same way `_require_connected`'s is.

    `timeout` None is COMMAND_TIMEOUT_SECONDS, read HERE, at call time — never
    bound as the default at import, which a patched constant would not reach.

    In an eval replay a declared device that declares run answers is answered
    by its machines.ReplayAgent (S29b T5) — the declared result frame, or a
    stated cannot — and nothing is signed or sent: the hub is never reached."""
    if envelopes.contains_lone_surrogate(args):
        raise ToolFailure(
            "an argument contains an unpaired UTF-16 surrogate, which cannot be signed "
            "for the device — remove the malformed character and try again"
        )
    try:
        replay = machines.plant().replay_agent(row["name"])
        if replay is not None:
            return replay.answer(capability, args)
        return await devices_ws.hub.command(
            pool,
            device_id=row["id"],
            name=row["name"],
            capability=capability,
            args=args,
            timeout=COMMAND_TIMEOUT_SECONDS if timeout is None else timeout,
            facts_sink=ctx.facts_sink if ctx is not None else None,
        )
    except devices.DeviceRefused as exc:
        raise ToolFailure(exc.reason) from exc


_NO_REASON = "the device reported a failure with no reason"


def _require_ok(result: dict, row) -> dict:
    """A device that reports ok=False did NOT do the thing — surface that as a
    failure rather than dressing an error as success. `ok` is the device's own
    judgment, carried in its result frame."""
    if not result.get("ok"):
        error = result.get("error") or _NO_REASON
        raise ToolFailure(f"{row['name']}: {error}")
    return result


# -- the outside-worktree flag (worktrees epic T4) ---------------------------
#
# Owner ruling 2026-10-08 ("Worktree by default + flag"), under the 09-03
# no-approvals ruling: a run or a write on the machine that holds her own
# repository which touches the checkout OUTSIDE her .worktrees/nova-<id> STILL
# RUNS — then its result ends with this stated warning and the turn's facts
# carry {"outside_worktree": <repo>, "tool": <name>}, which chat._run_tool lifts
# to span.meta["outside_worktree"]. Nothing here refuses or waits. The fact has
# no "device" key: that key is read as a connectivity record (the state guard).
#
# Reads (device_read_file, device_list_files) never flag: they change nothing in
# the checkout, and reading the live code is how she learns it. device_run
# cannot tell a read from a write, so any reference to the checkout flags.
#
# Known gap: an @folder cwd or path (e.g. @home/workspace/nova) is resolved on
# the machine, not here, so it is not classified and does not flag.


def outside_worktree_warning(repo: str) -> str:
    return (
        f"Warning: this touched the live checkout {repo}, not a worktree of yours — start a "
        "change with start_change and work inside its .worktrees/nova-<id>."
    )


def _on_repo_machine(row) -> bool:
    """True when this admitted row is the machine that holds her repository
    (its hostname is NOVA_REPO_HOST, case-insensitive) — read live, never a
    second device-table read."""
    host = code_repo.repo_host()
    if host is None:
        return False
    hostname = row["hostname"] if "hostname" in row.keys() else None
    return isinstance(hostname, str) and hostname.strip().lower() == host.lower()


def _outside_checkout(
    row, *, cwd: str | None = None, argv: list | None = None, path: str | None = None
) -> str | None:
    """The checkout's path when this call, on THIS admitted row, touches it
    outside her worktrees; None otherwise. Derived live from NOVA_REPO_HOST and
    NOVA_CHECKOUT (app/code_repo.py) and the row's own hostname — never a
    second device-table read. Linear in the argv: code_repo scans each element
    with str.find and a one-character boundary check, no backtracking regex."""
    if not _on_repo_machine(row):
        return None
    repo = code_repo.repo_dir()
    if repo is None:
        return None
    if cwd is not None and code_repo.checkout_scope(cwd, repo) == "outside":
        return repo
    if path is not None and code_repo.checkout_scope(path, repo) == "outside":
        return repo
    if argv is not None:
        strings = [element for element in argv if isinstance(element, str)]
        if code_repo.argv_scope(strings, repo) == "outside":
            return repo
    return None


def _file_fact(ctx: ToolContext | None, fact: dict) -> None:
    """Record a structured fact from the agent's own result frame (S29 T1).
    A run fact {"run": {...}, "target": <argv joined>} or a file fact
    {"file": {...}, "target": <checked path>}. Neither has a top-level
    "device" key: that key is read as a connectivity record (the state guard),
    so the device sits inside the kind's own dict."""
    if ctx is not None and ctx.facts_sink is not None:
        ctx.facts_sink.append(fact)


def _flag_outside(ctx: ToolContext | None, repo: str, tool: str) -> str:
    """Record the fact for this call and return the warning line."""
    if ctx is not None and ctx.facts_sink is not None:
        ctx.facts_sink.append({"outside_worktree": repo, "tool": tool})
    return outside_worktree_warning(repo)


# -- the current-change warning (own-tool-handback T3, turn c9ba8d70) --------
#
# After start_change returned .worktrees/nova-3ff482 she edited README.md in
# .worktrees/nova-3e8ab0 — an older change's worktree. Under the 09-03
# no-approvals ruling the call STILL RUNS; then its result ends with this
# stated warning and the turn's facts carry {"other_change_worktree": <other>,
# "tool": <name>}, which chat._run_tool lifts to span.meta (the same seam as
# outside_worktree). "The change started this turn" is the LAST facts_sink
# fact with "started": True (start_change's); list_changes' facts carry no
# marker — a listed change is an old one. "Other" is derived from the current
# path alone: its <repo>/.worktrees/nova- prefix followed by a different id.
# Reads never warn.

OTHER_CHANGE_WORKTREE = "other_change_worktree"


def _started_worktree(ctx: ToolContext | None) -> str | None:
    started = None
    for fact in (ctx.facts_sink if ctx is not None else None) or ():
        if isinstance(fact, dict) and fact.get("started") is True and "change" in fact:
            path = fact.get("worktree_path")
            if isinstance(path, str) and path:
                started = path
    return started


def _other_worktree_in(text: str, current: str) -> str | None:
    """The first <repo>/.worktrees/nova-<id> in `text` whose id is not the
    current one's. Linear: str.find walks forward, each id read once."""
    cut = current.rstrip("/")
    slash = cut.rfind("/")
    name = cut[slash + 1 :]
    if slash < 0 or not name.startswith(code_repo.WORKTREE_PREFIX):
        return None
    prefix = cut[: slash + 1] + code_repo.WORKTREE_PREFIX
    start = 0
    while (at := text.find(prefix, start)) != -1:
        end = at + len(prefix)
        tail = end
        while tail < len(text) and text[tail] not in "/ \t\n'\";&|)":
            tail += 1
        start = max(tail, at + 1)
        found = text[at:tail]
        if tail > end and found != cut:
            return found
    return None


def _flag_other_change(
    ctx: ToolContext | None,
    tool: str,
    *,
    cwd: str | None = None,
    argv: list | None = None,
    path: str | None = None,
) -> str | None:
    """Record the fact and return the warning line when this call aims inside a
    worktree other than the change started this turn; None otherwise."""
    current = _started_worktree(ctx)
    if current is None:
        return None
    targets = [t for t in (cwd, path) if isinstance(t, str)]
    targets += [element for element in argv or () if isinstance(element, str)]
    for target in targets:
        other = _other_worktree_in(target, current)
        if other is not None:
            ctx.facts_sink.append({OTHER_CHANGE_WORKTREE: other, "tool": tool})
            return (
                f"Warning: the change you started this turn is {current.rstrip('/')}; "
                f"this touched {other}."
            )
    return None


def _join_warnings(*lines: str | None) -> str | None:
    kept = [line for line in lines if line]
    return "\n".join(kept) if kept else None


# -- the executors -----------------------------------------------------------


# How each line of device_list's listing begins: a device (an agent, or a
# revoked one that knocked), the lines under an agent (what she needs to act
# on it), and the knock section's header. device_line_shown reads a listing
# back by these, so both the writer and the reader take them from here.
_DEVICE_LINE = "- "
_ACTING_INDENT = "    "
_KNOCKS_HEADER = "Revoked, but their agents knocked in the last day:"


async def device_list(args: dict, ctx: ToolContext) -> str:
    """Nova's agents as the plant lists them (S42b P17 — in an eval replay,
    its declared devices alone), each with what she needs to act on it
    without being told (P29), then any revoked agent that knocked in the
    last day (P28), read through the plant too (Task 22: a replay reports
    none of the real table's). Every agent listed leaves {device, connected}
    on the turn — the record every device tool leaves, so what she says
    about its connection is backed — and only once the whole listing is
    built: a call that fails after reading the hub was shown no line, and
    must back no claim. Run unasked, a listing clipped short keeps only the
    facts of agents whose lines it kept (device_line_shown)."""
    agents = await machines.plant().agents(ctx.app)
    lines: list[str] = []
    for agent in agents:
        lines.append(_agent_line(agent))
        lines.extend(f"{_ACTING_INDENT}{line}" for line in agent["acting"])
    knocks = await _knocks(ctx.app)
    out = (
        ["Paired devices:", *lines]
        if lines
        else ["No device is paired with Nova (show_setup_qr's add_machine card pairs one)."]
    )
    if knocks:
        out += [_KNOCKS_HEADER, *knocks]
    if ctx.facts_sink is not None:
        for agent in agents:
            ctx.facts_sink.append({"device": agent["name"], "connected": agent["connected"]})
    return "\n".join(out)


def _build_words(agent: dict) -> str:
    """Its agent's build against the hub's — a hash has no order, so "behind
    the hub's build", never "older" (P2) — and unknown said as unknown."""
    version, build = agent["agent_version"], agent["build"]
    if version is None:
        return "agent version unknown (none on record)"
    if build["state"] == "current":
        return f"agent {version} (the hub's build)"
    if build["state"] == "behind":
        return f"agent {version} (behind the hub's build {build['hub_version']})"
    return f"agent {version} (no hub build could be read to compare it with)"


def _agent_line(agent: dict) -> str:
    status = "connected" if agent["connected"] else "offline"
    line = (
        f"{_DEVICE_LINE}{agent['name']} ({device_facts.place(agent)}) — {status}, "
        f"last seen {agent['last_seen'] or 'never'}"
    )
    if agent["hub"]:
        # The door is not identity (the controller's ruling): a relay on the
        # hub — the owner's tunnel, an ssh -L — comes in through the same
        # loopback door, so this says the door, never "the hub's own machine".
        line += "; its agent came in through the hub machine's own door"
    line += f"; {_build_words(agent)}"
    hands = agent["roles"]["hands"]
    if hands["state"] == "cannot":
        line += f"; hands: {hands['reason']}"
        if agent["wsl"] is not None:
            line += (
                " — on Windows, Nova's agent is the Windows build, which reaches WSL through "
                "wsl.exe"
            )
    if agent["folders"]:
        line += "; folders: " + ", ".join(f"@{name}" for name in agent["folders"])
    return line


# How a Linux agent from before S42b was installed — the README's, said only
# as a condition: a row with no service section may as well be an S42b
# agent whose probe never landed (Task 21 fix round 1).
_BEFORE_S42B_LINUX = (
    "how it runs: not reported — if it is an agent from before S42b, it runs as the README's "
    "systemd user unit novad (binary ~/.local/bin/novad), and inside WSL it is reached through "
    "that PC's Windows agent with wsl.exe -d <distro> -- …, whose WSL facts say where it runs"
)


async def _knocks(app) -> list[str]:
    """Each revoked agent that knocked in the last day (P28: a verified knock
    stamps devices.last_refused_at), as the plant reports them
    (devices.revoked_knocks; none in an eval replay). The knock record is the
    check that it stopped — but no knock is only that: it stopped, or it
    cannot reach Nova (an asleep machine knocks no more than a stopped
    agent)."""
    out = []
    for r in await machines.plant().knocks(app):
        knocked = r["last_refused_at"].isoformat()
        state = (
            f"still knocking (last {knocked})"
            if r["knocking"]
            else f"no knock since {knocked}: it stopped then, or can no longer reach Nova"
        )
        line = f"{_DEVICE_LINE}{r['name']} (revoked {r['revoked_at'].isoformat()}): {state}"
        facts = r["facts"] if isinstance(r["facts"], dict) else None
        if facts is not None and isinstance(facts.get("service"), dict):
            when = facts.get("probed_at") or "an unknown time"
            line += f"; {device_facts.runs_line(facts)} (as probed at {when})"
        elif r["platform"] == "linux":
            line += f"; {_BEFORE_S42B_LINUX}"
        out.append(line)
    return out


def device_line_shown(name: str, result: str, shown: int) -> bool:
    """Did the first `shown` characters of device_list's `result` hold agent
    `name`'s WHOLE line — "- <name> (<place>) — connected|offline, …", the
    line that states its connection? device_list's Tool.device_line_shown:
    an unasked check keeps that agent's {"device", "connected"} fact only
    when this says yes (live_facts._shown_facts) — S42a's I2 class, carried
    from Task 21's re-review once device_list grew past the 600 characters
    a check hands her. The lines under it (how it runs, elevation, WSL)
    state no connection, so a cut among them costs its fact nothing.

    The scan machine_status's reader uses (tools.base.listing_line_shown),
    so it fails closed the same ways: no such line, a line that runs on past
    a newline this format never writes, or ANY line with that head ending
    past `shown` — and a revoked agent's knock line with the same name
    ("- <name> (revoked …)") is one more such line."""
    return listing_line_shown(
        f"{_DEVICE_LINE}{name} (",
        result,
        shown,
        (_DEVICE_LINE, _ACTING_INDENT, _KNOCKS_HEADER),
    )


async def device_info(args: dict, ctx: ToolContext) -> str:
    """HER call: system.info, then what she needs to act on the machine (P29)
    — after asking the agent to look again (facts.refresh), so the lines are
    its look now. When no newer look is on record — the refresh got no
    answer, the agent could not take it, or its answer left no newer probe —
    a line before them says so, and that they are its last probe's: old facts
    are never presented as a look just taken."""
    pool, row, _ = await _admit(args, ctx=ctx)
    before = _probed_at(row["facts"])
    missed = await _look_again(pool, row, ctx)
    now = await devices.get(pool, row["id"])
    facts = now["facts"] if now is not None else None
    platform = now["platform"] if now is not None else row["platform"]
    after = _probed_at(facts)
    # A probe whose time differs from the one held when this call began
    # landed during it. The agent's own clock stamps probed_at, so it is
    # compared only with the agent's earlier stamp, never with core's clock;
    # and "newer" is all it can say — two probes begun in one second carry
    # one stamp (RFC 3339 seconds), so the second is never called new. "On
    # record", never "reached": core can refuse a frame that did arrive
    # (FactsRejected, a DataError), and nothing here can tell which (Task 21
    # fix round 1, I3).
    landed = after is not None and after != before
    if missed is None and not landed:
        missed = "the agent answered the refresh, but no newer probe of it is on record"
    note = None if missed is None else f"({missed} — {_last_probe(facts, landed)})"
    return await _info(pool, row, ctx, facts, platform, note)


async def device_info_on_record(args: dict, ctx: ToolContext) -> str:
    """device_info as an UNASKED check runs it (live_facts.UNASKED_READERS;
    Task 21 fix round 1, I1): system.info, then the lines from the probe on
    record, dated — never a refresh. The look again belongs to her call: on
    Windows with WSL it takes up to 45 s, past the check's own 8 s bound, so
    an unasked check would come back "NOT checked" while the cancelled
    refresh still set the agent probing for nobody. Not a tool of its own —
    nothing advertises it and she never calls it; device_info cannot tell an
    unasked call from hers, so the backend's check chooses this instead."""
    pool, row, _ = await _admit(args, ctx=ctx)
    note = (
        "(the agent was not asked to look again — an unasked check never makes it probe — "
        f"{_last_probe(row['facts'], landed=False)})"
    )
    return await _info(pool, row, ctx, row["facts"], row["platform"], note)


async def _info(pool, row, ctx: ToolContext, facts, platform: str, note: str | None) -> str:
    """system.info's own answer, then — before the lines on how it runs, so
    a result cut short never shows a line without what dates it (Task 21 fix
    round 1, I2) — the note on how old they are, when there is one, then
    the lines themselves, each probe's time first (device_facts.acting_lines)."""
    result = _require_ok(await _command(pool, row, "system.info", {}, ctx=ctx), row)
    detail = result.get("output") or "(the device returned no detail)"
    lines = [f"{row['name']} system info:", detail]
    if note is not None:
        lines.append(note)
    lines.extend(device_facts.acting_lines(facts, platform))
    return "\n".join(lines)


async def _look_again(pool, row, ctx: ToolContext) -> str | None:
    """Ask the agent for a fresh look (facts.refresh). Its probe frame is on
    the wire before its result (apps/novad caps/table.go factsRefresh) and
    core handles a socket's frames in order, so the look has landed by the
    time this returns. None when the agent answered ok; otherwise what
    happened, in words. A refresh that was never SENT (NotSent — no socket,
    or a revoke) is that refusal, raised: system.info would meet it too."""
    try:
        result = await _command(
            pool, row, "facts.refresh", {}, ctx=ctx, timeout=REFRESH_TIMEOUT_SECONDS
        )
    except ToolFailure as exc:
        if isinstance(exc.__cause__, devices_ws.NotSent):
            raise
        return f"the refresh got no answer: {exc}"
    if not result.get("ok"):
        return f"the agent could not look again: {result.get('error') or 'no reason given'}"
    return None


def _probed_at(facts: dict | None) -> str | None:
    when = facts.get("probed_at") if isinstance(facts, dict) else None
    return when if isinstance(when, str) and when else None


def _last_probe(facts: dict | None, landed: bool) -> str:
    """What the lines on how it runs were read from, when this call brought
    no look of its own: the probe held before it (not now) — or, when a
    probe landed during the call all the same, that one, by its time."""
    when = _probed_at(facts)
    if landed:
        return f"the lines below on how it runs are as probed at {when}"
    if when is not None:
        return f"so the lines below on how it runs are as probed at {when}, not now"
    if isinstance(facts, dict) and any(key in facts for key in device_facts.PROBE_SECTIONS):
        return "so the lines below on how it runs are from a probe at an unknown time, not now"
    return "and no probe of it is on record"


async def device_list_files(args: dict, ctx: ToolContext) -> str:
    pool, row, path = await _admit(args, ctx=ctx, fs_path=True)
    result = _require_ok(await _command(pool, row, "fs.list", {"path": path}, ctx=ctx), row)
    return f"{row['name']} {path}:\n{result.get('output') or '(empty)'}"


# The range arguments device_read_file forwards to fs.read (S30a T3): a line
# range or a byte range; the agent (apps/novad caps/fs_range.go) checks that
# they come in pairs and are not mixed, and states it when they are not.
_RANGE_KEYS = ("start_line", "end_line", "offset", "length")

# Every released pre-S30a agent's whole-file cap refusal (fsRead on main
# bd6bcfb7: "file is N bytes, over the 256 KiB read cap"). Those builds cannot
# change, so the wording is frozen; a new agent's range refusals never say it.
_OLD_AGENT_CAP_REFUSAL = re.compile(r"^file is \d+ bytes, over the ")


def _predates_ranges(row) -> ToolFailure:
    return ToolFailure(
        f"{row['name']}: this agent predates range reads — it cannot read part of a "
        "file, so nothing of the range was read. Update it with machine_update, "
        "then read the range again."
    )


async def device_read_file(args: dict, ctx: ToolContext) -> str:
    pool, row, path = await _admit(args, ctx=ctx, fs_path=True)
    read_args: dict = {"path": path}
    for key in _RANGE_KEYS:
        if key in args:
            read_args[key] = int(args[key])
    ranged = len(read_args) > 1
    result = await _command(pool, row, "fs.read", read_args, ctx=ctx)
    if not ranged:
        _require_ok(result, row)
        _file_fact(ctx, {"file": {"op": "read", "device": row["name"]}, "target": path})
        return f"{row['name']}:{path}\n{result.get('output') or '(empty file)'}"
    # A ranged read. Only the agent's own range echo says the range was read:
    # an agent that predates S30a ignores the range and sends the whole file
    # (or its whole-file cap refusal), and that is never passed off as the range.
    # Only range/bytes_total/lines_total/eof are read from meta (T1 VERIFY).
    meta = result.get("meta")
    meta = meta if isinstance(meta, dict) else {}
    if not result.get("ok"):
        if _OLD_AGENT_CAP_REFUSAL.match(str(result.get("error") or "")):
            raise _predates_ranges(row)
        _require_ok(result, row)
    if "range" not in meta:
        raise _predates_ranges(row)
    bytes_total = meta.get("bytes_total")
    _file_fact(
        ctx,
        {
            "file": {
                "op": "read",
                "device": row["name"],
                "range": meta["range"],
                "bytes_total": bytes_total,
            },
            "target": path,
        },
    )
    size = f"the file is {bytes_total} bytes"
    if meta.get("lines_total") is not None:
        size += f", {meta['lines_total']} lines"
    if meta.get("eof"):
        size += "; the range runs past the end of the file"
    return f"{row['name']}:{path} ({size})\n{result.get('output') or '(nothing in the range)'}"


async def device_list_apps(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await _admit(args, ctx=ctx)
    result = _require_ok(await _command(pool, row, "apps.list", {}, ctx=ctx), row)
    return f"Apps on {row['name']}:\n{result.get('output') or '(none reported)'}"


async def device_notify(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await _admit(args, ctx=ctx)
    _require_ok(
        await _command(pool, row, "system.notify", {"message": args["message"]}, ctx=ctx), row
    )
    return f"Sent a notification to {row['name']}."


# -- the box (S32.2 T9; spec docs/plans/rebuild/s32/spec.md §4.4) -------------
#
# On the machine that holds her repository, a device_run whose cwd is inside
# one of her change worktrees (<checkout>/.worktrees/nova-<id>) is sent as the
# agent's `box.exec`: novad runs it by docker exec in nova-box-<id>, sealed,
# starting the box when it is stopped. Every other cwd runs on the host as
# today. The run fact says where (`ran_in`, + `box`), and chat._run_tool lifts
# both to the span.
#
# A box that cannot run it (cannot start, the CPU lock held, an agent from
# before the box) is an Error quoting the agent — NEVER a second send to the
# host: a fallback that quietly drops the seal is a success nobody checked.
#
# `branch` is the repository's DEFAULT branch (code_repos.default_branch, else
# the base start_change resolves) and never the change's own nova/<id>-*:
# novad reads suites.toml (which runs take the CPU lock) and the image tag
# from it, so the change's branch would let a change shape its own seal.
#
# Only the owner sets `environment` host (PUT /api/v1/code-repos/{name}); then
# the run goes to the host and says so. elevated=true is admin.exec on the
# host, as asked. outside_worktree is untouched: the checkout itself still runs
# on the host, flagged.

RAN_IN = "ran_in"
BOX_EXEC = "box.exec"
_CHANGE_ID = re.compile(r"[0-9a-f]{6}")
HOST_BY_OWNER_WORDS = "(on the host: this repo's environment is host, set by the owner)"
_HOST_BY_OWNER = "host"


def box_name(change: str) -> str:
    """The box a change runs in — the same rule as novad's box.Names."""
    return f"nova-box-{change}"


def _change_of(cwd: str, checkout: str) -> str | None:
    """The change id when cwd is <checkout>/.worktrees/nova-<id>[/...] with a
    6-hex id (start_change's shape); None otherwise."""
    if code_repo.checkout_scope(cwd, checkout) != "worktree":
        return None
    parts = posixpath.normpath(cwd)[len(checkout) :].strip("/").split("/")
    change = parts[1][len(code_repo.WORKTREE_PREFIX) :]
    return change if _CHANGE_ID.fullmatch(change) else None


async def _box_route(pool, row, ctx: ToolContext, cwd: str | None):
    """Where this (unelevated) run goes: None for the host as today,
    _HOST_BY_OWNER when the owner set the repository's environment to host,
    else (change, the box.exec args other than argv)."""
    if cwd is None or pool is None or not _on_repo_machine(row):
        # pool None is a replay's declared device: its plant answers only the
        # run capability, and it is never the machine that holds the repo.
        return None
    repo = code_repo.repo_dir()
    if repo is None:
        return None
    checkout = posixpath.normpath(repo)
    change = _change_of(cwd, checkout)
    if change is None:
        return None
    record = await pool.fetchrow(
        "SELECT environment, default_branch FROM code_repos WHERE name = $1", code_repos.NOVA
    )
    environment = record["environment"] if record is not None else code_repos.DEFAULT_ENVIRONMENT
    if environment == _HOST_BY_OWNER:
        return _HOST_BY_OWNER
    branch = record["default_branch"] if record is not None else None
    if branch is None:
        # Imported here: tools.changes imports this module.
        from app.tools import changes

        try:
            branch = await changes._base(pool, row, ctx, checkout)
        except ToolFailure as exc:
            raise ToolFailure(
                f"{exc} — so the branch the box is built from is not known; nothing was run"
            ) from exc
    return change, {
        "cwd": cwd,
        "change": change,
        "checkout": checkout,
        "branch": branch,
        "limits": await code_repos.box_limits(pool),
    }


def _box_failure(result: dict, row) -> str:
    error = str(result.get("error") or _NO_REASON)
    if error.startswith(_UNKNOWN_CAPABILITY):
        return (
            f"{row['name']}'s agent predates the box — update it with machine_update; "
            "nothing was run"
        )
    return f"{row['name']}: {error}"


# -- the elevated run (S30b T6) ---------------------------------------------
#
# device_run(elevated: true) sends the agent's "admin.exec" — a NEW capability
# name, so an agent from before S30b answers "unknown capability" and nothing is
# ever run unelevated in its place. Under the 09-03 no-approvals ruling nothing
# here asks or refuses: a machine without the admin path is the agent's stated
# cannot, restated with the machine's name and the tool that installs it. The
# fact {"elevated": True, "machine": <name>} is lifted by chat._run_tool to
# span.meta["elevated"] / ["machine"].

ELEVATED = "elevated"
_NO_ADMIN_PATH = "cannot: no admin path on this machine"


def _elevated_failure(result: dict, row) -> str:
    error = str(result.get("error") or _NO_REASON)
    name = row["name"]
    if error.startswith(_NO_ADMIN_PATH):
        rest = error[len(_NO_ADMIN_PATH) :]
        return (
            f"cannot: no admin path on {name}{rest} — nothing was run. Install it with "
            f"device_admin_path (action install) on {name}, then run this again."
        )
    if error.startswith(_UNKNOWN_CAPABILITY):
        return (
            f"{name}'s agent predates the admin path — it cannot run anything elevated, so "
            "nothing was run. Update it with machine_update, then run this again."
        )
    return f"{name}: {error}"


def _elevated_words(meta: object) -> str:
    """Who an elevated run ran as, from the agent's own meta only."""
    meta = meta if isinstance(meta, dict) else {}
    ran_as = meta.get("ran_as")
    user = meta.get("user")
    user = user.strip() if isinstance(user, str) and user.strip() else "the signed-in user"
    if meta.get(ELEVATED) is True:
        if ran_as == "root":
            return " elevated (as root)"
        if ran_as == "user_elevated":
            return f" elevated (as {user}, elevated)"
        if ran_as == "user_not_elevated":
            return f" NOT elevated (as {user}, without admin rights)"
    return " elevation not confirmed (the agent sent no elevated record)"


async def device_run(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await _admit(args, ctx=ctx)
    argv = args["argv"]
    exec_args: dict = {"argv": argv}
    cwd = None
    if "cwd" in args:
        # Checked exactly like an fs path (worktrees epic T3): absolute on the
        # device's OS, normalized, or a reported @folder passed on unresolved
        # for the machine to resolve. The agent (apps/novad caps/shell.go)
        # runs the program in it; without one it runs in the agent's home.
        cwd = _check_fs_path(
            args["cwd"],
            row["platform"],
            device_facts.folders_of(row["facts"]),
            row["name"],
            device_facts.folders_unread(row["facts"]),
            device_facts.predates_folders(row["facts"]),
        )
        exec_args["cwd"] = cwd
    outside = _outside_checkout(row, cwd=cwd, argv=argv)
    elevated = args.get("elevated") is True
    if elevated:
        # S30b T6: filed BEFORE the send, so every elevated call to a resolved
        # machine is marked on its span — an ok run, the agent's cannot, a
        # failed frame, a transport failure. No "device" key (connectivity).
        _file_fact(ctx, {ELEVATED: True, "machine": row["name"]})
    route = None if elevated else await _box_route(pool, row, ctx, cwd)
    boxed = isinstance(route, tuple)
    if boxed:
        change, box_args = route
        capability, exec_args = BOX_EXEC, {"argv": argv, **box_args}
    else:
        capability = "admin.exec" if elevated else "shell.exec"
    result = await _command(pool, row, capability, exec_args, ctx=ctx)
    # Past here the agent answered with a result frame: the command was sent
    # and ran or failed on the machine, so a flagged call is flagged either
    # way (a transport failure above sent nothing it could confirm, and says so).
    warning = _join_warnings(
        _flag_outside(ctx, outside, "device_run") if outside is not None else None,
        _flag_other_change(ctx, "device_run", cwd=cwd, argv=argv),
    )
    # The run fact (S29 T1), on EVERY result frame — a nonzero exit and a failed
    # frame included: the exit code is the agent's own, never read from prose.
    run_record = {
        "exit_code": result.get("exit_code"),
        "device": row["name"],
        "argv": list(argv),
        "cwd": cwd,
        RAN_IN: "box" if boxed else "host",
    }
    if boxed:
        run_record["box"] = box_name(change)
    if elevated:
        run_record[ELEVATED] = True
    _file_fact(
        ctx,
        {"run": run_record, "target": " ".join(str(element) for element in argv)},
    )
    if not result.get("ok"):
        if elevated:
            failure = _elevated_failure(result, row)
        elif boxed:
            failure = _box_failure(result, row)
        elif cwd is not None:
            # The agent's own words for a missing directory name only the
            # program ("could not run \"git\": fork/exec ...: no such file or
            # directory"), which reads as the binary missing — so the cwd is
            # named here too.
            error = result.get("error") or "the device reported a failure with no reason"
            failure = f"{row['name']}: could not run {argv} in {cwd}: {error}"
        else:
            failure = f"{row['name']}: {result.get('error') or _NO_REASON}"
        raise ToolFailure(failure if warning is None else f"{failure}\n{warning}")
    exit_code = result.get("exit_code")
    output = result.get("output") or "(no output)"
    # The "<name> ran <argv> — exit <code>" preamble is for the model; the
    # presented-listing guard no longer arms on it (S29b) — the run fact filed
    # above arms a bare-name `ls`. Its format stays pinned (_RUN_PREAMBLE).
    # The cwd goes AFTER the code so the preamble still matches.
    how = _elevated_words(result.get("meta")) if elevated else ""
    where = f" in {cwd}" if cwd is not None else ""
    if boxed:
        where += f" (in box {box_name(change)})"
    elif route == _HOST_BY_OWNER:
        where += f" {HOST_BY_OWNER_WORDS}"
    text = f"{row['name']} ran {argv} — exit {exit_code}{how}{where}\n{output}"
    return text if warning is None else f"{text}\n{warning}"


# -- the admin path itself (S30b T7) -------------------------------------------
#
# device_admin_path installs or removes a machine's standing admin path through
# the agent's admin.install / admin.uninstall. The agent picks how to elevate
# the installer (already elevated, through the path, sudo -n, or the owner's one
# UAC click) and reads the result back itself; success here is ONLY that
# read-back, carried in the result's meta — an ok frame without it is stated as
# not confirmed. Nothing here asks or refuses (owner ruling 2026-09-03): the UAC
# prompt is the operating system's, answered by the owner at that machine.
#
# Sent with COMMAND_TIMEOUT_SECONDS (120 s): the agent waits at most
# caps.UACWait (60 s) for the owner's Yes — over the WHOLE prompt — keeps
# caps.ReadBackReserve (40 s) after it for the read-back, and bounds every
# command at client.CommandTimeout (110 s), so its answer lands inside this
# wait with margin. ADMIN_UAC_WAIT_SECONDS mirrors caps.UACWait; both orderings
# are pinned against the Go source (tests/test_device_admin_path.py here,
# apps/novad/internal/client/uac_budget_test.go there), never copied by hand.
#
# No answer (uac-timeout, turn 153578ab): the result says what is known — the
# answer did not come back, the state is not known, device_info reads it — and
# for install the owner's one step if a prompt is still up. No cause is guessed:
# core cannot tell a prompt nobody answered from a hung agent or a lost socket.

ADMIN_PATH = "admin_path"
ADMIN_UAC_WAIT_SECONDS = 60
_ADMIN_ACTIONS = ("install", "uninstall")
_ADMIN_KIND_WORDS = {"sudoers": "a sudoers rule", "task": "an elevated scheduled task"}
_ADMIN_ROUTE_WORDS = {
    "direct": "by the agent, already elevated",
    "path": "through the admin path already there",
    "sudo -n": "through sudo -n, with no prompt",
    "uac": "after the owner's Yes on the UAC prompt",
}


def _admin_failure(error: str, row, action: str) -> str:
    name = row["name"]
    if error.startswith(_UNKNOWN_CAPABILITY):
        return (
            f"{name}'s agent predates the admin path — it cannot {action} it, so nothing was "
            "done. Update it with machine_update, then run this again."
        )
    if action == "uninstall" and error.startswith(_NO_ADMIN_PATH):
        rest = error[len(_NO_ADMIN_PATH) :].replace("this machine", name)
        return f"cannot: no admin path on {name} — nothing to remove{rest}"
    return f"{name}: {error.replace('this machine', name)}"


def _admin_installed_words(meta: dict, name: str) -> str | None:
    """The install's ok words from the agent's read-back, or None when the
    meta does not carry one."""
    proof = meta.get("proof")
    if meta.get("installed") is not True or not isinstance(proof, str) or not proof.strip():
        return None
    kind = meta.get("kind")
    route = meta.get("route")
    kind_words = _ADMIN_KIND_WORDS.get(kind, str(kind)) if isinstance(kind, str) else "kind unsaid"
    route_words = _ADMIN_ROUTE_WORDS.get(route, str(route)) if isinstance(route, str) else ""
    how = f" {route_words}" if route_words else ""
    return (
        f"{name}: admin path installed ({kind_words}){how}; proven by the agent's read-back: "
        f"{proof.strip()}"
    )


def _admin_removed_words(meta: dict, name: str) -> str | None:
    """The uninstall's ok words from the agent's read-back, or None."""
    if meta.get("installed") is not False:
        return None
    route = meta.get("route")
    route_words = _ADMIN_ROUTE_WORDS.get(route, str(route)) if isinstance(route, str) else ""
    how = f" ({route_words})" if route_words else ""
    pending = meta.get("pending_restart")
    paths = (
        [p for p in pending if isinstance(p, str) and p.strip()]
        if isinstance(pending, list)
        else []
    )
    if paths:
        moved = "; ".join(f"{p} is deleted at the next restart" for p in paths)
        return (
            f"{name}: admin path removed{how} — the agent's read-back found the task, the "
            f"request directory and the protected copy gone; {moved} — scheduled, not proven."
        )
    return f"{name}: admin path removed{how} — the agent's read-back found none of it left."


def _admin_no_answer(exc: ToolFailure, name: str, action: str, done: str) -> str:
    """The words when no result frame came back: what is known, nothing more.
    NotSent reached nothing (no prompt can be up); a timeout names the wait;
    a lost socket names no wait it did not run."""
    refused = exc.__cause__
    if isinstance(refused, devices_ws.NotSent):
        return f"{exc} — nothing was sent to {name}, so its admin path was not touched."
    if isinstance(getattr(refused, "__cause__", None), TimeoutError):
        head = (
            f"the {action}'s answer from {name} did not come back within "
            f"{COMMAND_TIMEOUT_SECONDS} s"
        )
    else:
        head = f"{exc} — the {action}'s answer from {name} did not come back"
    words = (
        f"{head}, so whether the admin path is {done} on {name} is not known; "
        "device_info reads it now."
    )
    if action == "install":
        words += f" If a UAC prompt is up on {name}, the owner clicks Yes on it, then asks again."
    return words


async def device_admin_path(args: dict, ctx: ToolContext) -> str:
    action = args["action"]
    if action not in _ADMIN_ACTIONS:
        # dispatch's schema check refuses this first (tools/schema.validate reads
        # `enum`); this stays so a caller that reaches the executor directly
        # still cannot send `admin.<anything>`.
        raise ToolFailure(f"action must be install or uninstall, got {action!r} — nothing was sent")
    pool, row, _ = await _admit(args, ctx=ctx)
    name = row["name"]
    done = "installed" if action == "install" else "removed"
    try:
        result = await _command(pool, row, f"admin.{action}", {}, ctx=ctx)
    except ToolFailure as exc:
        raise ToolFailure(_admin_no_answer(exc, name, action, done)) from exc
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    words = None
    if result.get("ok"):
        words = (
            _admin_installed_words(meta, name)
            if action == "install"
            else _admin_removed_words(meta, name)
        )
    _file_fact(
        ctx,
        {
            ADMIN_PATH: action,
            "machine": name,
            "installed": meta.get("installed") if words else None,
        },
    )
    said = str(result.get("output") or "").strip()
    if not result.get("ok"):
        raise ToolFailure(_admin_failure(str(result.get("error") or _NO_REASON), row, action))
    if words is None:
        raise ToolFailure(
            f"{name}: the agent answered ok but sent no read-back of the admin path, so whether "
            f"it is {done} is not confirmed; device_info reads it now."
            + (f" The agent said: {said}" if said else "")
        )
    return f"{words}\nThe agent said: {said}" if said else words


async def device_write_file(args: dict, ctx: ToolContext) -> str:
    pool, row, path = await _admit(args, ctx=ctx, fs_path=True)
    content = args["content"]
    if not isinstance(content, str):
        raise ToolFailure("the 'content' argument must be a string")
    # Mechanical, BEFORE the envelope reaches the transport: an oversize write
    # would flap the socket into a timeout (a hang), so it is a stated refusal
    # here instead. Byte length, matching the device's own byte-level cap.
    size = len(content.encode("utf-8"))
    if size > WRITE_FILE_CAP_KIB * 1024:
        raise ToolFailure(
            f"content is {size} bytes, over the {WRITE_FILE_CAP_KIB} KiB write cap for a "
            "device — no v1 device capability moves more than that; write a smaller file"
        )
    outside = _outside_checkout(row, path=path)
    result = await _command(pool, row, "fs.write", {"path": path, "content": content}, ctx=ctx)
    warning = _join_warnings(
        _flag_outside(ctx, outside, "device_write_file") if outside is not None else None,
        _flag_other_change(ctx, "device_write_file", path=path),
    )
    try:
        _require_ok(result, row)
    except ToolFailure as exc:
        if warning is None:
            raise
        raise ToolFailure(f"{exc}\n{warning}") from exc
    _file_fact(ctx, {"file": {"op": "write", "device": row["name"]}, "target": path})
    done = f"Wrote {path} on {row['name']}."
    return done if warning is None else f"{done}\n{warning}"


# The words every agent's dispatch answers a capability it does not have with
# (apps/novad/internal/caps/caps.go Dispatch): an agent that predates S30a.
_UNKNOWN_CAPABILITY = "unknown capability"

# The only keys read from an fs.edit result's meta (T1 VERIFY: never ok/exit_code).
_EDIT_META_KEYS = ("matches", "bytes_before", "bytes_after")


async def device_edit_file(args: dict, ctx: ToolContext) -> str:
    """Replace one exact snippet of a file on a device (S30a T5). The agent
    counts the matches and writes atomically; the fact's numbers are the
    agent's own (its result frame's meta), never computed or assumed here."""
    pool, row, path = await _admit(args, ctx=ctx, fs_path=True)
    old, new = args["old"], args["new"]
    if not isinstance(old, str) or not old:
        raise ToolFailure("the 'old' argument must be a non-empty string")
    if not isinstance(new, str):
        raise ToolFailure("the 'new' argument must be a string")
    outside = _outside_checkout(row, path=path)
    result = await _command(pool, row, "fs.edit", {"path": path, "old": old, "new": new}, ctx=ctx)
    warning = _join_warnings(
        _flag_outside(ctx, outside, "device_edit_file") if outside is not None else None,
        _flag_other_change(ctx, "device_edit_file", path=path),
    )

    def failure(text: str) -> ToolFailure:
        return ToolFailure(text if warning is None else f"{text}\n{warning}")

    if not result.get("ok"):
        if str(result.get("error") or "").startswith(_UNKNOWN_CAPABILITY):
            raise failure(
                f"{row['name']}: this agent predates part-file edits — it cannot edit part of "
                "a file, so nothing was changed. Update it with machine_update, then edit again."
            )
        try:
            _require_ok(result, row)
        except ToolFailure as exc:
            raise failure(str(exc)) from exc
    meta = result.get("meta")
    meta = meta if isinstance(meta, dict) else {}
    record = {key: meta.get(key) for key in _EDIT_META_KEYS}
    if not all(type(value) is int for value in record.values()):
        # An ok frame without the agent's edit record: whether it changed the
        # file is not confirmed, so no fact is filed and nothing is claimed.
        raise failure(
            f"{row['name']}: the agent answered ok but sent no edit record, so whether "
            f"{path} changed is not confirmed — read the file to check."
        )
    _file_fact(ctx, {"edit": {"device": row["name"], **record}, "target": path})
    done = (
        f"Edited {path} on {row['name']}: replaced {record['matches']} match "
        f"({record['bytes_before']} -> {record['bytes_after']} bytes)."
    )
    return done if warning is None else f"{done}\n{warning}"


# The optional fs.search arguments device_search forwards (S30a T7), each only
# when given; the agent (apps/novad caps/fs_search.go) checks their types and
# states a bad one. max_matches's bounds are the agent's (SearchMaxMatches).
_SEARCH_OPTIONAL_KEYS = ("literal", "ignore_case", "max_matches")
_SEARCH_DEFAULT_MATCHES = 200
_SEARCH_MAX_MATCHES = 2000


async def device_search(args: dict, ctx: ToolContext) -> str:
    """Search a directory tree on a device for a regex or literal (S30a T7).
    A read: no outside-worktree flag. The counts in the fact and the head line
    are the agent's own (its result frame's meta), never computed here; only
    matches/files_scanned/capped are read from meta (T1 VERIFY)."""
    pool, row, path = await _admit(args, ctx=ctx, fs_path=True)
    pattern = args["pattern"]
    if not isinstance(pattern, str) or not pattern:
        raise ToolFailure("the 'pattern' argument must be a non-empty string")
    search_args: dict = {"path": path, "pattern": pattern}
    for key in _SEARCH_OPTIONAL_KEYS:
        if key in args:
            search_args[key] = args[key]
    result = await _command(pool, row, "fs.search", search_args, ctx=ctx)
    if not result.get("ok"):
        if str(result.get("error") or "").startswith(_UNKNOWN_CAPABILITY):
            raise ToolFailure(
                f"{row['name']}: this agent predates code search — it cannot search files, "
                "so nothing was searched. Update it with machine_update, then search again."
            )
        _require_ok(result, row)
    meta = result.get("meta")
    meta = meta if isinstance(meta, dict) else {}
    matches, scanned, capped = (meta.get(k) for k in ("matches", "files_scanned", "capped"))
    if not (type(matches) is int and type(scanned) is int and type(capped) is bool):
        # An ok frame without the agent's search record: what it found is not
        # confirmed, so no fact is filed and no list is presented as complete.
        raise ToolFailure(
            f"{row['name']}: the agent answered ok but sent no search record, so what a "
            f"search of {path} found is not confirmed — search again."
        )
    _file_fact(
        ctx,
        {"search": {"device": row["name"], "matches": matches, "capped": capped}, "target": path},
    )
    head = (
        f"{row['name']}: searched {path} for {pattern!r}: {matches} matches in {scanned} files "
        f"(paths relative to {path})"
    )
    if capped:
        head += "; more matches exist — narrow the pattern or raise max_matches"
    return f"{head}\n{result.get('output') or ''}".rstrip("\n")


# What no agent's apps.launch result carries, on any OS: whether a window
# appeared. Each agent reports what IT did — handed the request to the shell,
# started a process — and "the visible window is the human's confirmation"
# (docs/plans/rebuild/slice-05-carries.md). The result says so, every time, so
# an accepted hand-off never reads as a running app.
LAUNCH_UNCONFIRMED = "whether a window opened is not confirmed"


async def device_launch_app(args: dict, ctx: ToolContext) -> str:
    """The agent's OWN outcome words, never a sentence written here.

    The owner's test, 2026-09-28 (turn fe7e3198): the Windows agent hands a
    launch to explorer.exe, which proves only that the shell accepted it, and
    it answered "asked Windows to launch brave". This returned "Launched brave
    on DELL-XPS-8950." instead, she told him "Brave is now running", and he saw
    no Brave. Each OS's words stay the agent's (apps_*.go), so nothing here is
    written per OS; what is added is only what none of them says."""
    pool, row, _ = await _admit(args, ctx=ctx)
    result = _require_ok(
        await _command(pool, row, "apps.launch", {"app": args["app"]}, ctx=ctx), row
    )
    said = str(result.get("output") or "").strip()
    if not said:
        said = f"answered ok to launching {args['app']} and said nothing more"
    return f"{row['name']}: {said} — {LAUNCH_UNCONFIRMED}."


def _obj(properties: dict, required: list[str]) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


# A known folder in a fs tool's words (P16) — one sentence, so the three tools
# say it alike.
_FOLDERS_SENTENCE = (
    "Or name a known folder — @home, @desktop, @documents or @downloads, optionally followed "
    "by /the/rest — which the machine resolves as its own OS names it (on Windows, the "
    "Desktop OneDrive may have moved)."
)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="device_list",
        description=(
            "List the computers paired with Nova: the OS each runs, whether it is connected "
            "now and when it was last seen, whether its agent came in through the hub machine's "
            "own door, its agent's build against the hub's, the folders its agent reported, and "
            "what its agent reported about how it runs, elevating and WSL — plus any revoked "
            "agent that knocked in the last day, and whether it still is. Reads Nova's own "
            "records and live connections."
        ),
        parameters=_obj({}, []),
        executor=device_list,
        reads_only=True,
        ephemeral=True,
        # The three device_list* tools enumerate a container (paired devices,
        # a directory, installed apps): their result IS a listing, and the
        # presented-listing guard reads that declaration rather than a name.
        result_kind=RESULT_KIND_LISTING,
        # One result, one line per agent, each leaving a connectivity fact: a
        # live check keeps an agent's fact only when its line was shown (S42b
        # Task 22, the S42a I2 class carried from Task 21's re-review).
        device_line_shown=device_line_shown,
    ),
    Tool(
        name="device_info",
        description=(
            "Report a paired device's OS, disk, memory and uptime and its home folder (on "
            "Windows also its Desktop folder, which OneDrive may move), and what Nova needs to "
            "act on it without being told: how its agent runs (the service, binary, config, "
            "process and account), what the agent read about elevating there, and on Windows "
            "the WSL distributions beside it and what runs in them. It asks the agent to look "
            "again first — on Windows with WSL that can take up to about 45 seconds — and says "
            "when what it shows was read."
        ),
        parameters=_obj({"device": _DEVICE_ARG}, ["device"]),
        executor=device_info,
        reads_only=True,
        ephemeral=True,
    ),
    Tool(
        name="device_list_files",
        description=(
            "List the contents of a directory on a paired device. Give an absolute path "
            "in the device's own OS: /home/… on Linux and macOS; C:\\Users\\… or a share "
            f"such as \\\\wsl.localhost\\<distro>\\… on Windows. {_FOLDERS_SENTENCE}"
        ),
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "path": {
                    "type": "string",
                    "description": (
                        "Absolute directory path in the device's own OS, or a known folder "
                        "such as @desktop."
                    ),
                },
            },
            ["device", "path"],
        ),
        executor=device_list_files,
        reads_only=True,
        ephemeral=True,
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="device_read_file",
        description=(
            "Read a text file on a paired device. Give an absolute path in the device's "
            "own OS: /home/… on Linux and macOS; C:\\Users\\… or a share such as "
            f"\\\\wsl.localhost\\<distro>\\… on Windows. {_FOLDERS_SENTENCE} "
            "To read part of a file of any size, give start_line and end_line (1-based, "
            "inclusive) or offset and length (bytes); the result states the file's total "
            f"size. The device refuses a read over {READ_FILE_CAP_KIB} KiB — of the range "
            "when one is given, of the whole file otherwise."
        ),
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "path": {
                    "type": "string",
                    "description": (
                        "Absolute file path in the device's own OS, or a known folder such as "
                        "@desktop/notes.txt."
                    ),
                },
                "start_line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "First line to read (1-based); give end_line with it.",
                },
                "end_line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Last line to read (inclusive); give start_line with it.",
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Byte offset to start reading at; give length with it.",
                },
                "length": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Number of bytes to read from offset; give offset with it.",
                },
            },
            ["device", "path"],
        ),
        executor=device_read_file,
        backs=frozenset({"file_contents", "read_file"}),
        reads_only=True,
        ephemeral=True,
    ),
    Tool(
        name="device_search",
        description=(
            "Search the text files under a directory on a paired device for a pattern (an RE2 "
            "regular expression, or exact text with literal true; ignore_case for either). "
            "Each hit is one line, relpath:line: text — the path relative to the directory "
            "searched, the 1-based line number, the line itself. Files .gitignore excludes, "
            ".git, binary files and symlinks are skipped. At most max_matches hits come back "
            f"(default {_SEARCH_DEFAULT_MATCHES}, up to {_SEARCH_MAX_MATCHES}); the result says "
            "when more exist. To read around a hit, use device_read_file with start_line and "
            "end_line. Give an absolute directory path in the device's own OS. "
            f"{_FOLDERS_SENTENCE}"
        ),
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "path": {
                    "type": "string",
                    "description": (
                        "Absolute directory path in the device's own OS, or a known folder "
                        "such as @home/project."
                    ),
                },
                "pattern": {
                    "type": "string",
                    "description": "What to find: an RE2 regular expression, or exact text "
                    "with literal true.",
                },
                "literal": {
                    "type": "boolean",
                    "description": "Match the pattern as exact text, not a regex.",
                },
                "ignore_case": {
                    "type": "boolean",
                    "description": "Match regardless of letter case.",
                },
                "max_matches": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": _SEARCH_MAX_MATCHES,
                    "description": (
                        f"Most hits to return (default {_SEARCH_DEFAULT_MATCHES}, "
                        f"up to {_SEARCH_MAX_MATCHES})."
                    ),
                },
            },
            ["device", "path", "pattern"],
        ),
        executor=device_search,
        reads_only=True,
        ephemeral=True,
    ),
    Tool(
        name="device_list_apps",
        description="List the applications installed on a paired device.",
        parameters=_obj({"device": _DEVICE_ARG}, ["device"]),
        executor=device_list_apps,
        reads_only=True,
        ephemeral=True,
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="device_notify",
        description="Show a desktop notification on a paired device.",
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "message": {"type": "string", "description": "The notification text."},
            },
            ["device", "message"],
        ),
        executor=device_notify,
        ephemeral=True,
    ),
    Tool(
        name="device_run",
        # The argv contract (P29/P30), stated where she reads the tool — and
        # only what is known: Task 1's Dell readings (does wsl.exe hand what
        # follows -- to the distro's shell; does a prompt fail at once on
        # Windows) are not in, so neither is said as fact (the Task 10c
        # ruling: "no terminal and empty input" would overstate Windows).
        description=(
            "Run a command on a paired device. Give the command as argv — a list of strings, "
            'the program first (e.g. ["ls", "-la", "/tmp"]) — never a shell string. Nova\'s '
            "agent runs it with no shell: $(…), pipes, &&, globs and redirects reach the "
            "program exactly as written. To use them, run a shell yourself: "
            '["sh", "-c", "…"] on Linux and macOS, ["powershell", "-NoProfile", "-Command", '
            '"…"] on Windows. On Windows a built-in command runs through cmd: '
            '["cmd", "/c", "dir", "C:\\\\Users"]; WSL is reached through wsl.exe, and '
            '["wsl.exe", "-d", "<distro>", "--exec", "uname", "-a"] runs a program there with '
            "no shell (whether wsl.exe hands what follows -- to the distro's shell has not been "
            "measured yet). On Linux and macOS a command runs with no terminal and empty "
            "input: anything that asks for input (a sudo password, a yes/no question) gets no "
            "answer and fails at once with its own message. On Windows, whether a command "
            "that asks for input fails at once has not been measured yet. Give `cwd` to run "
            "in a directory: relative paths and git then run from it. Give `elevated` true "
            "to run it elevated — as root on Linux and macOS, as the signed-in user with admin "
            "rights on Windows — through the machine's admin path: nothing asks and nothing "
            "prompts on the machine, and the result says who it ran as. A machine without the "
            "admin path says so; device_admin_path installs it there."
        ),
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "argv": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "description": "The program and its arguments, as separate strings.",
                },
                "cwd": {
                    "type": "string",
                    "description": (
                        "The directory to run the command in, absolute in the device's own "
                        "OS (or a known @folder). Relative paths in argv, and git, run from "
                        "it — give the repository or worktree here instead of cd in a shell. "
                        "Without it the command runs in the agent's home directory. A cwd that "
                        "does not exist fails, naming it."
                    ),
                },
                ELEVATED: {
                    "type": "boolean",
                    "description": (
                        "true runs the command elevated through the machine's admin path: as "
                        "root on Linux and macOS, as the signed-in user with admin rights on "
                        "Windows. Default false."
                    ),
                },
            },
            ["device", "argv"],
        ),
        executor=device_run,
        ephemeral=False,
    ),
    Tool(
        name="device_admin_path",
        description=(
            "Install or remove a paired machine's admin path — what lets device_run with "
            "`elevated` true run commands as root (Linux, macOS) or as the signed-in user with "
            "admin rights (Windows), with no prompt. Installing asks the operating system at "
            "most once per machine: on Windows the owner clicks Yes on one UAC prompt at that "
            "machine's screen (he must be signed in there); on Linux and macOS there is no "
            "prompt when the agent's user has passwordless sudo, and otherwise the result names "
            "the one sudo command the owner runs there. Install and uninstall each prove "
            "themselves: the result states the agent's read-back, or says exactly what it "
            "could not confirm. Whether a machine has the path is device_info's to read. The "
            "surface: with the path installed, a compromise of Nova's core is root/admin on "
            "that machine."
        ),
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "action": {
                    "type": "string",
                    "enum": list(_ADMIN_ACTIONS),
                    "description": "install sets the admin path up; uninstall removes it.",
                },
            },
            ["device", "action"],
        ),
        executor=device_admin_path,
        ephemeral=False,
    ),
    Tool(
        name="device_write_file",
        description=(
            "Write a text file on a paired device. Give an absolute path in the device's "
            "own OS: /home/… on Linux and macOS; C:\\Users\\… or a share such as "
            f"\\\\wsl.localhost\\<distro>\\… on Windows. {_FOLDERS_SENTENCE} "
            f"Content larger than {WRITE_FILE_CAP_KIB} KiB is refused."
        ),
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "path": {
                    "type": "string",
                    "description": (
                        "Absolute file path in the device's own OS, or a known folder such as "
                        "@desktop/notes.txt."
                    ),
                },
                "content": {
                    "type": "string",
                    "description": f"The full new file contents (up to {WRITE_FILE_CAP_KIB} KiB).",
                },
            },
            ["device", "path", "content"],
        ),
        executor=device_write_file,
        backs=frozenset({"wrote_file"}),
        ephemeral=False,
    ),
    Tool(
        name="device_edit_file",
        description=(
            "Edit part of a text file on a paired device: replace exactly one occurrence of "
            "`old` (exact bytes, whitespace and line endings included) with `new`. If `old` "
            "matches zero times or more than once nothing changes and the agent says how many "
            "it found — include more surrounding text to make it unique. Works on files of any "
            f"size up to the {EDIT_FILE_CAP_MIB} MiB edit cap (read the part first with "
            "device_read_file's start_line/end_line). The file is replaced atomically by a new "
            "file that keeps the original's permission bits; the owner, setuid/setgid/sticky "
            "bits, hard links (another name for the file keeps the old bytes) and extended "
            "attributes or ACLs are not kept. Give an absolute path in the device's own OS. "
            f"{_FOLDERS_SENTENCE}"
        ),
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "path": {
                    "type": "string",
                    "description": (
                        "Absolute file path in the device's own OS, or a known folder such as "
                        "@home/notes.txt."
                    ),
                },
                "old": {
                    "type": "string",
                    "description": "The exact text to replace; must occur exactly once.",
                },
                "new": {
                    "type": "string",
                    "description": "The text to put in its place (may be empty).",
                },
            },
            ["device", "path", "old", "new"],
        ),
        executor=device_edit_file,
        backs=frozenset({"edited_file", "wrote_file"}),
        ephemeral=False,
    ),
    Tool(
        name="device_launch_app",
        description="Launch an application on a paired device.",
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "app": {"type": "string", "description": "The application to launch."},
            },
            ["device", "app"],
        ),
        executor=device_launch_app,
        ephemeral=False,
    ),
)
