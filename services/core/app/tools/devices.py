"""The nine device tools — ordinary tools that happen to reach a second machine.

The model never talks to a daemon. It calls these like any other tool; they
ride the one authorizer (dispatch -> policy.authorize) exactly as web_search
does, and only AFTER the kernel allows does core sign an envelope and send it
over the hub. There is no new authorizer here and there must never be — the
kernel gates by action-class DISPOSITION (auto vs consent), read live from the
seeded rows.

What each envelope-backed tool adds, in code and before it ever sends, is the
PER-DEVICE layer the kernel does not know about:

  1. resolve the device by name (get_live_by_name) — a revoked or unknown name
     is a stated ToolFailure, never a silent no-op;
  2. the live grant check — the capability this tool needs must be in the row's
     granted `capabilities`, read fresh per call, else refuse naming Settings ->
     Devices. This is the tool's OWN check, separate from the kernel's;
  3. for fs.* tools, a path prefix check against the row's fs_roots — the grant
     BOUNDARY. (The device enforces its own deny-roots regardless of what core
     signed; that is the mechanical backstop, this is the boundary — both exist
     by design.)

Only then hub.command, and only the device's own `result` frame comes back as
success: a timeout, a dropped socket or a device-reported failure is a
ToolFailure, so nothing reads as done that the device did not actually do.
Reads are ephemeral (a live point-in-time answer, like fetch_url); writes,
launches and shell runs are not.
"""
from __future__ import annotations

import posixpath

from app import db, devices, devices_ws, envelopes
from app.tools.base import Tool, ToolContext, ToolFailure

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
        raise ToolFailure(
            f"no paired device named {name!r} — check the name in Settings → Devices "
            "(a revoked device is gone until it is paired again)"
        )
    return row


def _require_grant(row, capability: str) -> None:
    """Refuse unless this device has been granted `capability`, read live off the
    row. Separate from the kernel: the kernel decides the tool's disposition,
    this decides whether THIS machine may do it."""
    if capability not in (row["capabilities"] or []):
        raise ToolFailure(
            f"{row['name']} has not been granted {capability} — grant it in Settings → Devices"
        )


def _check_fs_path(row, path: object) -> str:
    """The requested path must be absolute and lie under one of the device's
    granted fs_roots. Lexical on purpose: the path names a file on the REMOTE
    machine, so it cannot be resolved here — this is the grant boundary, and the
    device's own deny-roots is the mechanical backstop. `..` collapses under
    normpath so it cannot climb out of a root lexically."""
    if not isinstance(path, str) or not path.startswith("/"):
        raise ToolFailure(f"path {path!r} must be absolute — start it with /")
    normalized = posixpath.normpath(path)
    roots = row["fs_roots"] or []
    if not roots:
        raise ToolFailure(
            f"{row['name']} has no filesystem roots granted — add one in Settings → Devices"
        )
    for root in roots:
        root_norm = posixpath.normpath(root)
        if normalized == root_norm or normalized.startswith(root_norm.rstrip("/") + "/"):
            return normalized
    raise ToolFailure(
        f"path {path!r} is outside the roots granted to {row['name']} "
        f"({', '.join(roots)}) — widen them in Settings → Devices"
    )


async def _command(pool, row, capability: str, args: dict) -> dict:
    """Send one command through the hub, restating a DeviceRefused as the
    ToolFailure the model reads. Only a `result` frame gets here as a return.

    The single funnel every envelope-backed device tool passes through, so the
    lone-surrogate guard lives here: an arg carrying an unpaired UTF-16
    surrogate cannot be canonicalized identically on the daemon (Go decodes it
    to U+FFFD), so it would surface as an opaque "signature did not verify". We
    refuse it BEFORE signing, naming the bad input, rather than shipping a
    mystery signature failure to the edge."""
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
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_grant(row, "system.info")
    result = _require_ok(await _command(pool, row, "system.info", {}), row)
    detail = result.get("output") or "(the device returned no detail)"
    return f"{row['name']} system info:\n{detail}"


async def device_list_files(args: dict, ctx: ToolContext) -> str:
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_grant(row, "fs.list")
    path = _check_fs_path(row, args["path"])
    result = _require_ok(await _command(pool, row, "fs.list", {"path": path}), row)
    return f"{row['name']} {path}:\n{result.get('output') or '(empty)'}"


async def device_read_file(args: dict, ctx: ToolContext) -> str:
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_grant(row, "fs.read")
    path = _check_fs_path(row, args["path"])
    result = _require_ok(await _command(pool, row, "fs.read", {"path": path}), row)
    return f"{row['name']}:{path}\n{result.get('output') or '(empty file)'}"


async def device_list_apps(args: dict, ctx: ToolContext) -> str:
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_grant(row, "apps.list")
    result = _require_ok(await _command(pool, row, "apps.list", {}), row)
    return f"Apps on {row['name']}:\n{result.get('output') or '(none reported)'}"


async def device_notify(args: dict, ctx: ToolContext) -> str:
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_grant(row, "system.notify")
    _require_ok(await _command(pool, row, "system.notify", {"message": args["message"]}), row)
    return f"Sent a notification to {row['name']}."


async def device_run(args: dict, ctx: ToolContext) -> str:
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_grant(row, "shell.exec")
    argv = args["argv"]
    result = _require_ok(await _command(pool, row, "shell.exec", {"argv": argv}), row)
    exit_code = result.get("exit_code")
    output = result.get("output") or "(no output)"
    return f"{row['name']} ran {argv} — exit {exit_code}\n{output}"


async def device_write_file(args: dict, ctx: ToolContext) -> str:
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_grant(row, "fs.write")
    path = _check_fs_path(row, args["path"])
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
        await _command(pool, row, "fs.write", {"path": path, "content": content}), row
    )
    return f"Wrote {path} on {row['name']}."


async def device_launch_app(args: dict, ctx: ToolContext) -> str:
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_grant(row, "apps.launch")
    _require_ok(await _command(pool, row, "apps.launch", {"app": args["app"]}), row)
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
            "List the contents of a directory on a paired device. The path must be "
            "absolute and inside a folder that device has granted."
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
    ),
    Tool(
        name="device_read_file",
        description=(
            "Read a text file on a paired device. The path must be absolute and inside a "
            f"granted folder; files larger than {READ_FILE_CAP_KIB} KiB are refused by the device."
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
            "Write a text file on a paired device. The path must be absolute and inside a "
            f"granted folder; content larger than {WRITE_FILE_CAP_KIB} KiB is refused."
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
