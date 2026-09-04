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
  3. for fs.* tools, the path is absolute, `posixpath.normpath`'d. A relative
     path would resolve against the daemon's cwd, so it cannot be sent as
     asked. This is a shape check, not a boundary: there are no filesystem
     roots, and any absolute path is sent.

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

import posixpath

from app import db, devices, devices_ws, envelopes
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

# How long core waits for a device to answer one command. Bounded (<=120s per
# the plan) because a command with no answer must become a STATED failure, not
# a hang — "accepted by transport" is never "received".
COMMAND_TIMEOUT_SECONDS = 120

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
        known = (
            f"the paired devices are: {', '.join(live)}" if live else "no device is paired"
        )
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


def _check_fs_path(path: object) -> str:
    """The requested path must be absolute; it is returned normalized. Lexical
    on purpose: the path names a file on the REMOTE machine, so it cannot be
    resolved here. A relative path would resolve against the daemon's cwd — a
    different file from the one asked for — so it is refused as malformed.
    `..` and `.` collapse under normpath so the daemon receives one spelling."""
    if not isinstance(path, str) or not path.startswith("/"):
        raise ToolFailure(f"path {path!r} must be absolute — start it with /")
    return posixpath.normpath(path)


async def _admit(args: dict, *, ctx: ToolContext | None = None, fs_path: bool = False):
    """The per-device layer, in order: paired (not revoked) -> connected ->
    (fs tools) absolute path. Returns (pool, row, normalized path or None) for
    an executor to send with; raises ToolFailure to refuse. This is the ONLY
    place the order lives.

    `ctx` is threaded through only so `_require_connected` can record the
    connectivity it determined on the turn's facts_sink; nothing here reads it
    to DECIDE anything. An unknown/revoked name refuses at `_resolve`, before
    connectivity is looked at, so it records nothing — it determined nothing.
    """
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_connected(row, ctx)
    path = _check_fs_path(args["path"]) if fs_path else None
    return pool, row, path


async def _command(
    pool, row, capability: str, args: dict, *, ctx: ToolContext | None = None
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
            timeout=COMMAND_TIMEOUT_SECONDS,
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
    pool = await db.get_pool()
    connected = devices_ws.hub.connected_ids()
    rows = await devices.list_devices(pool)
    live = [d for d in rows if d["revoked_at"] is None]
    if not live:
        return "No devices are paired. Pair one in Settings → Devices."
    lines = []
    for d in live:
        status = "connected" if d["id"] in connected else "offline"
        last = d["last_seen"] or "never"
        lines.append(f"- {d['name']} ({d['platform']}) — {status}, last seen {last}")
    return "Paired devices:\n" + "\n".join(lines)


async def device_info(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await _admit(args, ctx=ctx)
    result = _require_ok(await _command(pool, row, "system.info", {}, ctx=ctx), row)
    detail = result.get("output") or "(the device returned no detail)"
    return f"{row['name']} system info:\n{detail}"


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


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="device_list",
        description=(
            "List the computers paired with Nova (name, platform, whether they are "
            "connected right now, and when each was last seen). Reads Nova's own records."
        ),
        parameters=_obj({}, []),
        executor=device_list,
        ephemeral=True,
        # The three device_list* tools enumerate a container (paired devices,
        # a directory, installed apps): their result IS a listing, and the
        # presented-listing guard reads that declaration rather than a name.
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="device_info",
        description="Report a paired device's OS, disk and memory summary.",
        parameters=_obj({"device": _DEVICE_ARG}, ["device"]),
        executor=device_info,
        ephemeral=True,
    ),
    Tool(
        name="device_list_files",
        description=(
            "List the contents of a directory on a paired device. Give an absolute path "
            "on the device."
        ),
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "path": {"type": "string", "description": "Absolute directory path on the device."},
            },
            ["device", "path"],
        ),
        executor=device_list_files,
        ephemeral=True,
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="device_read_file",
        description=(
            "Read a text file on a paired device. Give an absolute path on the device; "
            f"files larger than {READ_FILE_CAP_KIB} KiB are refused by the device."
        ),
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "path": {"type": "string", "description": "Absolute file path on the device."},
            },
            ["device", "path"],
        ),
        executor=device_read_file,
        ephemeral=True,
    ),
    Tool(
        name="device_list_apps",
        description="List the applications installed on a paired device.",
        parameters=_obj({"device": _DEVICE_ARG}, ["device"]),
        executor=device_list_apps,
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
        description=(
            "Run a command on a paired device. Give the command as argv — a list of strings, "
            "the program first (e.g. [\"ls\", \"-la\", \"/tmp\"]) — never a shell string."
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
            "Write a text file on a paired device. Give an absolute path on the device; "
            f"content larger than {WRITE_FILE_CAP_KIB} KiB is refused."
        ),
        parameters=_obj(
            {
                "device": _DEVICE_ARG,
                "path": {"type": "string", "description": "Absolute file path on the device."},
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
