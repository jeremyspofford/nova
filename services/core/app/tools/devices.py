"""The nine device tools — ordinary tools that happen to reach a second machine.

The model never talks to a daemon. It calls these like any other tool, and what
each envelope-backed tool establishes before it sends is a matter of FACT,
never of permission (owner ruling 2026-09-03: v4 makes no authorization
decisions). In order (`_admit`):

  1. paired (identity) — resolve the device by name (get_live_by_name). A
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

import ntpath
import posixpath
import re
from datetime import timedelta

from app import db, device_facts, devices, devices_ws, envelopes, machines
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

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

_DEVICE_ARG = {
    "type": "string",
    "description": "The name of the paired device, as shown in Settings → Devices.",
}


# -- the per-device layer ----------------------------------------------------


async def _resolve(pool, name: object):
    """The live row for a device named `name`, or a ToolFailure that names it.
    A revoked device has no live row, so it is refused here by absence."""
    if not isinstance(name, str):
        raise ToolFailure("the 'device' argument must be the device's name")
    row = await devices.get_live_by_name(pool, name)
    if row is None:
        live = sorted(
            d["name"] for d in await devices.list_devices(pool) if d["revoked_at"] is None
        )
        known = f"the paired devices are: {', '.join(live)}" if live else "no device is paired"
        raise ToolFailure(
            f"no paired device named {name!r} — {known}; check the name in Settings → "
            "Devices (a revoked device is gone until it is paired again)"
        )
    return row


def _require_connected(row, ctx: ToolContext | None = None) -> None:
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
    """
    connected = devices_ws.hub.is_connected(row["id"])
    if ctx is not None and ctx.facts_sink is not None:
        ctx.facts_sink.append({"device": row["name"], "connected": connected})
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
# which resolves it ON the machine, as its OS names the folder.
_FOLDER_TOKEN = re.compile(r"^@([a-z]+)(?:[\\/](.*))?$", re.S)


def _check_fs_path(
    path: object,
    platform: str,
    folders: tuple[str, ...] = (),
    name: str = "this device",
    unread: dict[str, str] | None = None,
) -> str:
    """The requested path must be absolute ON THE DEVICE'S OS; it is returned
    normalized. Lexical on purpose: the path names a file on the REMOTE
    machine, so it cannot be resolved here. A relative path would resolve
    against the daemon's cwd — a different file from the one asked for — so it
    is refused as malformed. `..` and `.` collapse under the OS's own normpath
    so the daemon receives one spelling.

    Or it names a known folder, @desktop/notes.txt (P16): passed through
    UNRESOLVED when the device's agent reported that folder (`folders`,
    device_facts.folders_of) — the machine resolves it as its OS names it,
    never core — and otherwise a stated cannot, in the agent's own words
    when it said why it could not read the folder (`unread`,
    device_facts.folders_unread).

    linux/darwin: posix, a leading "/". windows: a drive or a share, checked
    EXPLICITLY — Python 3.12's ntpath.isabs also accepts a rooted path with
    no drive ("\\foo"), which names no file — then ntpath.normpath. Device
    paths (\\\\?\\, \\\\.\\) are refused: ntpath leaves them unnormalized, which
    would break the one-spelling rule. An unknown platform cannot be checked,
    and says so."""
    if isinstance(path, str) and path.startswith("@"):
        m = _FOLDER_TOKEN.match(path)
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
            else:
                why = "it has reported no folders — an agent from before S42b reports none"
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
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_connected(row, ctx)
    path = (
        _check_fs_path(
            args["path"],
            row["platform"],
            device_facts.folders_of(row["facts"]),
            row["name"],
            device_facts.folders_unread(row["facts"]),
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
    timeout: float = COMMAND_TIMEOUT_SECONDS,
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
    the same way `_require_connected`'s is."""
    if envelopes.contains_lone_surrogate(args):
        raise ToolFailure(
            "an argument contains an unpaired UTF-16 surrogate, which cannot be signed "
            "for the device — remove the malformed character and try again"
        )
    try:
        return await devices_ws.hub.command(
            pool,
            device_id=row["id"],
            name=row["name"],
            capability=capability,
            args=args,
            timeout=timeout,
            facts_sink=ctx.facts_sink if ctx is not None else None,
        )
    except devices.DeviceRefused as exc:
        raise ToolFailure(exc.reason) from exc


def _require_ok(result: dict, row) -> dict:
    """A device that reports ok=False did NOT do the thing — surface that as a
    failure rather than dressing an error as success. `ok` is the device's own
    judgment, carried in its result frame."""
    if not result.get("ok"):
        error = result.get("error") or "the device reported a failure with no reason"
        raise ToolFailure(f"{row['name']}: {error}")
    return result


# -- the executors -----------------------------------------------------------


async def device_list(args: dict, ctx: ToolContext) -> str:
    """Nova's agents as the plant lists them (S42b P17 — an eval's declared
    device too), each with what she needs to act on it without being told
    (P29), then any revoked agent that knocked in the last day (P28). Every
    agent listed leaves {device, connected} on the turn — the record every
    device tool leaves, so what she says about its connection is backed —
    and only once the whole listing is built: a call that fails after
    reading the hub was shown no line, and must back no claim."""
    pool = await db.get_pool()
    agents = await machines.plant().agents(ctx.app)
    lines: list[str] = []
    for agent in agents:
        lines.append(_agent_line(agent))
        lines.extend(f"    {line}" for line in agent["acting"])
    knocks = await _knocks(pool)
    out = (
        ["Paired devices:", *lines]
        if lines
        else ["No device is paired with Nova (show_setup_qr's add_machine card pairs one)."]
    )
    if knocks:
        out += ["Revoked, but their agents knocked in the last day:", *knocks]
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
        f"- {agent['name']} ({device_facts.place(agent)}) — {status}, "
        f"last seen {agent['last_seen'] or 'never'}"
    )
    if agent["hub"]:
        line += "; the hub's own machine"
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


# P28: a revoked agent that is still running knocks at least every 30 s (its
# reconnect ladder tops out there); within this of its last verified knock it
# is "still knocking".
_KNOCKING_WITHIN = timedelta(minutes=2)
# How a Linux agent from before S42b was installed — the README's, said as
# that, never as a fact of one that did not report how it runs.
_BEFORE_S42B_LINUX = (
    "how it runs: not reported — an agent from before S42b on Linux runs as the README's "
    "systemd user unit novad (binary ~/.local/bin/novad); inside WSL, one is reached through "
    "that PC's Windows agent with wsl.exe -d <distro> -- …, whose WSL facts say where it runs"
)


async def _knocks(pool) -> list[str]:
    """Each revoked agent that knocked in the last day (P28: a verified knock
    stamps devices.last_refused_at). The knock record is the check that it
    stopped — but no knock is only that: it stopped, or it cannot reach Nova
    (an asleep machine knocks no more than a stopped agent)."""
    # Both ages are taken on the database's clock, the one that stamped the
    # knock — never compared with core's.
    rows = await pool.fetch(
        "SELECT name, platform, facts, revoked_at, last_refused_at, "
        "last_refused_at > now() - $1::interval AS knocking FROM devices "
        "WHERE revoked_at IS NOT NULL AND last_refused_at > now() - interval '24 hours' "
        "ORDER BY last_refused_at DESC",
        _KNOCKING_WITHIN,
    )
    out = []
    for r in rows:
        knocked = r["last_refused_at"].isoformat()
        state = (
            f"still knocking (last {knocked})"
            if r["knocking"]
            else f"no knock since {knocked}: it stopped then, or can no longer reach Nova"
        )
        line = f"- {r['name']} (revoked {r['revoked_at'].isoformat()}): {state}"
        facts = r["facts"] if isinstance(r["facts"], dict) else None
        if facts is not None and isinstance(facts.get("service"), dict):
            when = facts.get("probed_at") or "an unknown time"
            line += f"; {device_facts.runs_line(facts)} (as probed at {when})"
        elif r["platform"] == "linux":
            line += f"; {_BEFORE_S42B_LINUX}"
        out.append(line)
    return out


async def device_info(args: dict, ctx: ToolContext) -> str:
    """system.info, then what she needs to act on the machine (P29) — after
    asking the agent to look again (facts.refresh), so the lines are its look
    now. When no new look reached core — the refresh got no answer, the agent
    could not take it, or its answer carried no new probe — the last line
    says so, and that the lines are its last probe's: old facts are never
    presented as a look just taken."""
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
    # one stamp (RFC 3339 seconds), so the second is never called new.
    landed = after is not None and after != before
    if missed is None and not landed:
        missed = "the agent answered the refresh, but no newer probe of it reached Nova"
    result = _require_ok(await _command(pool, row, "system.info", {}, ctx=ctx), row)
    detail = result.get("output") or "(the device returned no detail)"
    lines = [f"{row['name']} system info:", detail, *device_facts.acting_lines(facts, platform)]
    if missed is not None:
        lines.append(f"({missed} — {_last_probe(facts, landed)})")
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
    """What the lines on how it runs were read from, when the refresh did not
    bring this call's look: the probe held before it (not now) — or, when a
    probe landed during the call all the same, that one, by its time."""
    when = _probed_at(facts)
    if landed:
        return f"the lines above on how it runs are as probed at {when}"
    if when is not None:
        return f"so the lines above on how it runs are as probed at {when}, not now"
    if isinstance(facts, dict) and any(key in facts for key in device_facts.PROBE_SECTIONS):
        return "so the lines above on how it runs are from a probe at an unknown time, not now"
    return "and no probe of it is on record"


async def device_list_files(args: dict, ctx: ToolContext) -> str:
    pool, row, path = await _admit(args, ctx=ctx, fs_path=True)
    result = _require_ok(await _command(pool, row, "fs.list", {"path": path}, ctx=ctx), row)
    return f"{row['name']} {path}:\n{result.get('output') or '(empty)'}"


async def device_read_file(args: dict, ctx: ToolContext) -> str:
    pool, row, path = await _admit(args, ctx=ctx, fs_path=True)
    result = _require_ok(await _command(pool, row, "fs.read", {"path": path}, ctx=ctx), row)
    return f"{row['name']}:{path}\n{result.get('output') or '(empty file)'}"


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


async def device_run(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await _admit(args, ctx=ctx)
    argv = args["argv"]
    result = _require_ok(await _command(pool, row, "shell.exec", {"argv": argv}, ctx=ctx), row)
    exit_code = result.get("exit_code")
    output = result.get("output") or "(no output)"
    # The "<name> ran <argv> — exit <code>" preamble is READ by the presented-
    # listing guard (app/guards.py _RUN_PREAMBLE): under it, a run of bare names
    # in the output (a plain `ls`) counts as a listing. Pinned in its suite.
    return f"{row['name']} ran {argv} — exit {exit_code}\n{output}"


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
    _require_ok(
        await _command(pool, row, "fs.write", {"path": path, "content": content}, ctx=ctx), row
    )
    return f"Wrote {path} on {row['name']}."


async def device_launch_app(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await _admit(args, ctx=ctx)
    _require_ok(await _command(pool, row, "apps.launch", {"app": args["app"]}, ctx=ctx), row)
    return f"Launched {args['app']} on {row['name']}."


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
            "now and when it was last seen, which one is the hub's own machine, its agent's "
            "build against the hub's, the folders its agent reported, and what its agent "
            "reported about how it runs, elevating and WSL — plus any revoked agent that "
            "knocked in the last day, and whether it still is. Reads Nova's own records and "
            "live connections."
        ),
        parameters=_obj({}, []),
        executor=device_list,
        reads_only=True,
        ephemeral=True,
        # The three device_list* tools enumerate a container (paired devices,
        # a directory, installed apps): their result IS a listing, and the
        # presented-listing guard reads that declaration rather than a name.
        result_kind=RESULT_KIND_LISTING,
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
            f"Files larger than {READ_FILE_CAP_KIB} KiB are refused by the device."
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
            },
            ["device", "path"],
        ),
        executor=device_read_file,
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
            "that asks for input fails at once has not been measured yet."
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
            },
            ["device", "argv"],
        ),
        executor=device_run,
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
