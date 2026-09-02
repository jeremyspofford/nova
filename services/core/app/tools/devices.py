"""The nine device tools — ordinary tools that happen to reach a second machine.

The model never talks to a daemon. It calls these like any other tool; they
ride the one authorizer (dispatch -> policy.authorize) exactly as web_search
does, and only AFTER the kernel allows does core sign an envelope and send it
over the hub. There is no new authorizer here and there must never be — the
kernel gates by action-class DISPOSITION (auto vs consent), read live from the
seeded rows.

What each envelope-backed tool adds, in code and before it ever sends, is the
PER-DEVICE layer the kernel does not know about (`_admit`):

  1. resolve the device by name (get_live_by_name) — a revoked or unknown name
     is a stated ToolFailure naming the live devices, never a silent no-op;
  2. the device is connected in the hub — an offline machine is the stated
     "not connected — its tile is stale" refusal;
  3. the live grant check — the capability this tool needs must be in the row's
     granted `capabilities`, read fresh per call, else refuse naming Settings ->
     Devices. This is the tool's OWN check, separate from the kernel's;
  4. for fs.* tools, a path prefix check against the row's fs_roots — the grant
     BOUNDARY. (The device enforces its own deny-roots regardless of what core
     signed; that is the mechanical backstop, this is the boundary — both exist
     by design.)

That layer runs TWICE per call, on purpose. First as the tool's `precheck`,
which dispatch runs BEFORE policy.authorize: a call that can never execute is
refused before the kernel can raise a card for it or burn an approval on it
(the owner's walk approved a device_run that was then burned and refused as
ungranted, and approved a card raised for a device name that was leaked XML).
Then again inside the executor, AFTER the kernel allowed: a grant, a revoke or
a disconnect can land between the two, and the executor is the last line
before the wire. Neither run decides anything — both only refuse (D-012).

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


def _require_connected(row) -> None:
    """Refuse unless the device's socket is live in the hub right now. The same
    words hub.command uses for a socket that is gone by the time it sends, so
    the model reads one refusal for one fact whichever layer states it."""
    if not devices_ws.hub.is_connected(row["id"]):
        raise ToolFailure(
            f"device {row['name']!r} is not connected — its tile is stale; check it is "
            "powered on and online"
        )


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


async def _admit(args: dict, capability: str, *, fs_path: bool = False):
    """The per-device layer, in order: paired (not revoked) -> connected ->
    granted `capability` -> (fs tools) path inside a granted root. Returns
    (pool, row, normalized path or None) for an executor to send with; raises
    ToolFailure to refuse. This is the ONLY place the order lives, so the
    precheck and the executor cannot drift apart."""
    pool = await db.get_pool()
    row = await _resolve(pool, args["device"])
    _require_connected(row)
    _require_grant(row, capability)
    path = _check_fs_path(row, args["path"]) if fs_path else None
    return pool, row, path


def _precheck(capability: str, *, fs_path: bool = False):
    """The refusal-only hook dispatch runs BEFORE the kernel for one device
    tool: `_admit` for its capability, result discarded. See the module
    docstring for why it runs here as well as in the executor."""

    async def precheck(args: dict, ctx: ToolContext) -> None:
        await _admit(args, capability, fs_path=fs_path)

    return precheck


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
    pool, row, _ = await _admit(args, "system.info")
    result = _require_ok(await _command(pool, row, "system.info", {}), row)
    detail = result.get("output") or "(the device returned no detail)"
    return f"{row['name']} system info:\n{detail}"


async def device_list_files(args: dict, ctx: ToolContext) -> str:
    pool, row, path = await _admit(args, "fs.list", fs_path=True)
    result = _require_ok(await _command(pool, row, "fs.list", {"path": path}), row)
    return f"{row['name']} {path}:\n{result.get('output') or '(empty)'}"


async def device_read_file(args: dict, ctx: ToolContext) -> str:
    pool, row, path = await _admit(args, "fs.read", fs_path=True)
    result = _require_ok(await _command(pool, row, "fs.read", {"path": path}), row)
    return f"{row['name']}:{path}\n{result.get('output') or '(empty file)'}"


async def device_list_apps(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await _admit(args, "apps.list")
    result = _require_ok(await _command(pool, row, "apps.list", {}), row)
    return f"Apps on {row['name']}:\n{result.get('output') or '(none reported)'}"


async def device_notify(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await _admit(args, "system.notify")
    _require_ok(await _command(pool, row, "system.notify", {"message": args["message"]}), row)
    return f"Sent a notification to {row['name']}."


async def device_run(args: dict, ctx: ToolContext) -> str:
    pool, row, _ = await _admit(args, "shell.exec")
    argv = args["argv"]
    result = _require_ok(await _command(pool, row, "shell.exec", {"argv": argv}), row)
    exit_code = result.get("exit_code")
    output = result.get("output") or "(no output)"
    return f"{row['name']} ran {argv} — exit {exit_code}\n{output}"


async def device_write_file(args: dict, ctx: ToolContext) -> str:
    pool, row, path = await _admit(args, "fs.write", fs_path=True)
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
    pool, row, _ = await _admit(args, "apps.launch")
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
        precheck=_precheck("system.info"),
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
        precheck=_precheck("fs.list", fs_path=True),
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
        precheck=_precheck("fs.read", fs_path=True),
        ephemeral=True,
    ),
    Tool(
        name="device_list_apps",
        description="List the applications installed on a paired device.",
        parameters=_obj({"device": _DEVICE_ARG}, ["device"]),
        executor=device_list_apps,
        precheck=_precheck("apps.list"),
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
        precheck=_precheck("system.notify"),
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
        precheck=_precheck("shell.exec"),
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
        precheck=_precheck("fs.write", fs_path=True),
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
        precheck=_precheck("apps.launch"),
        ephemeral=False,
    ),
)
