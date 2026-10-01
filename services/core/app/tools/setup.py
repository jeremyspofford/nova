"""Her setup QR codes (S47): Nova's address for another device, and a card that
puts a QR code for one of four setups in the chat.

nova_address READS: the address core's one reader states now (app/network.py),
what another device needs first, and whether a native app exists. It changes
nothing and takes no argument, which is why the backend may run it unasked
(live_facts.AUTO_RUN).

show_setup_qr SENDS a card (ToolContext.card) — a QR code, its link and the
steps — for putting Nova on a phone, getting the app, pairing a machine she
controls, or pairing a model server. For the two machine setups it mints a
pairing code, and the code goes to the card ONLY: never into her result, the
span, the messages table or a log (spec s47 §7). Her result names the expiry and
says plainly that she does not have the code.

A machine card (S42b, send_machine_card) carries one command per OS for the
hub's own agent build (agent_card), filled with that code — so the commands
ride the card only too. The build is read BEFORE the code is minted: no code
is ever made for a card that cannot carry a command. `machine` makes it a
re-pair card — the code is bound to that paired machine's row, which keeps
its name and history — and `for_os` opens it on one OS; her result says
where that OS has been walked on real hardware (platform_walks), never more.

Inside an eval replay a card reads nothing real: the build comes through
BUILD (runner._fixture_build, the replay's one hub build) beside PAIRING
(runner._fixture_mint), and `machine` is resolved through machines.plant(),
whose replay overlay answers with the case's declared devices alone.

Neither is an approval of anything (owner ruling 2026-09-03). A setup that
cannot be shown — no address another device can reach, no chat to show it in,
a mint that failed — says it cannot and why, and sends nothing.

Imports stay off app.chat and app.agents: a cold `import app.tools` must not
load them (tests/test_tools_agents.py).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from contextvars import ContextVar

from app import agent_card, agent_dist, db, devices, machines, native_app, network, platform_walks
from app.tools.base import Tool, ToolContext, ToolFailure

logger = logging.getLogger("core")

SETUPS = ("install_pwa", "get_app", "add_machine", "add_model_server")
MACHINE_SETUPS = frozenset({"add_machine", "add_model_server"})
_PAGE = {
    "install_pwa": "/install",
    "get_app": "/app",
    "add_machine": "/add",
    "add_model_server": "/add",
}

TAILSCALE_STEP = (
    "The other device needs Tailscale (https://tailscale.com/download), signed in to the "
    "same tailnet as Nova."
)
MODEL_SERVER_NOTE = (
    "Serving its models needs the models role (S44), which is not built: today it pairs as a "
    "machine Nova controls."
)

# S42b: the OS a machine card opens on. wsl is a Windows PC — the Windows
# command covers it.
FOR_OS = ("linux", "macos", "windows", "wsl")
_PLATFORM_TO_OS = {"linux": "linux", "darwin": "macos", "windows": "windows"}
_OS_TO_GOOS = {"linux": "linux", "macos": "darwin", "windows": "windows", "wsl": "windows"}

# Called (person, device_id=...): device_id set makes it a re-pair code.
Mint = Callable[..., Awaitable[dict]]


async def _mint_for(person, *, device_id=None) -> dict:
    """The real mint: one single-use code for this person, stored as its hash —
    a re-pair code when device_id names a machine (decision 4)."""
    pool = await db.get_pool()
    return await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)


# The seam an eval replay swaps (machines.PLANT's pattern): a turn inside a case
# must never mint a code that could enroll a real machine.
PAIRING: ContextVar[Mint] = ContextVar("setup_pairing", default=_mint_for)


async def _read_build() -> agent_dist.Build:
    """The real reader: the hub's current agent build, every file checked."""
    return await agent_dist.read()


# The build a machine card is made from — the seam an eval replay swaps
# beside PAIRING (S42b fix round 1): a card made inside a case reads the
# replay's own build (runner._fixture_build), never the hub's, so one replay
# names one hub build (F11) and a hub with no build still makes its card.
BUILD: ContextVar[Callable[[], Awaitable[agent_dist.Build]]] = ContextVar(
    "setup_build", default=_read_build
)


def _dashed(code: str) -> str:
    clean = devices.normalize_code(code)
    return f"{clean[:4]}-{clean[4:]}" if len(clean) == 8 else clean


async def nova_address(args: dict, ctx: ToolContext) -> str:
    got = network.address()
    if ctx.facts_sink is not None:
        ctx.facts_sink.append(
            {"nova_address": got.origin, "checked_now": True, "at": got.read_at.isoformat()}
        )
    if got.origin is None:
        return f"Nova has no address another device can reach: {got.reason}. {native_app.stated()}"
    return (
        f"Nova's address for another device: {got.origin} (read from the tailnet just now). "
        f"{TAILSCALE_STEP} {got.origin}/install shows each phone its own install steps. "
        f"{native_app.stated()}"
    )


def _result(setup: str, link: str) -> str:
    """Her result for a phone setup (a machine card's is _machine_result)."""
    if setup == "install_pwa":
        return (
            f"Sent a QR card to the chat. It opens {link}, which shows the phone its own steps "
            f"for adding Nova to its home screen. {TAILSCALE_STEP}"
        )
    return (
        f"Sent a QR card to the chat. It opens {link}, which sends an iPhone to the App "
        f"Store and an Android phone to Google Play once a Nova app exists. "
        f"{native_app.stated()} Until there is one, that page shows the web app's install "
        f"steps instead. {TAILSCALE_STEP}"
    )


def _machine_result(setup: str, fact: dict) -> str:
    """Her result for a machine card, from its span fact — which never holds
    the code. Relative, never a clock time (S47 final review): the card shows
    the expiry in the browser's own local time, and a UTC clock time here
    would disagree with it. Read from the real TTL, never a copy of it."""
    minutes = devices.PAIRING_CODE_TTL_SECONDS // 60
    who = (
        f"re-pairs {fact['machine']} (its name and history stay)"
        if fact["machine"]
        else "adds a new machine"
    )
    walk = fact["walk"] or "; ".join(platform_walks.statuses().values())
    said = (
        f"Sent a pairing card to the chat: a QR code, a short link ({fact['url']}) and a "
        f"one-time code that expires in {minutes} minutes. The card {who}: its command for "
        f"each OS downloads Nova's agent, checks its sha256, installs it in the user's own "
        f"folder and starts it. {walk}. You do not have the code — it is only on the card."
    )
    if fact["for_os"] == "wsl":
        said += (
            " On a Windows PC the Windows command covers WSL: Nova's agent runs on Windows "
            "itself and reaches WSL through wsl.exe."
        )
    return f"{said} {MODEL_SERVER_NOTE}" if setup == "add_model_server" else said


async def send_machine_card(
    ctx: ToolContext, *, setup: str, machine_row=None, for_os: str | None = None
) -> dict:
    """Read the hub's agent build, THEN mint a code (a re-pair code for
    machine_row), build the per-OS commands, send the card, and return the
    span's fact — which never holds the code or the commands that carry it.
    Anything that stops the card stops it before a code exists or before
    anything is sent: a card that cannot be shown sends nothing."""
    got = network.address()
    if got.origin is None:
        raise ToolFailure(
            f"cannot show a setup QR: Nova has no address another device can reach — {got.reason}"
        )
    if ctx.card is None:
        raise ToolFailure("cannot show a setup QR: this turn has no chat to show it in")
    # The build first (F4): a card that cannot carry a command mints no code.
    try:
        build = await BUILD.get()()
    except agent_dist.DistUnavailable as exc:
        raise ToolFailure(
            f"cannot show a pairing card: the hub has no agent build to install — {exc}"
        ) from exc
    # ...and the commands themselves, made with the code's slot before any
    # code exists: whatever refuses a command (agent_card refuses a value it
    # cannot carry as it stands) refuses it here, never after a code is made.
    agent_card.commands(build, origin=got.origin, code=agent_card.CODE_SLOT)
    try:
        minted = await PAIRING.get()(
            ctx.person, device_id=machine_row["id"] if machine_row is not None else None
        )
    except devices.DeviceRefused as exc:
        # The registry's stated refusal (a machine revoked, or found to carry
        # the engine's name, since it was looked up), in its own words — none
        # of which is ever a code: it refuses before one is made.
        raise ToolFailure(f"cannot show a pairing card: {exc.reason}") from exc
    except Exception as exc:
        # Only the TYPE reaches her: dispatch's own log call (app/tools/
        # __init__.py) fires for an unlabeled bug, never for a raised
        # ToolFailure, so this call is the only place the cause is ever
        # recorded — `from exc` alone is read by nothing. Logging it in
        # full is safe: mint_pairing_code hands Postgres only the code's
        # HASH, a uuid and an int TTL (devices.py) — the plaintext code
        # itself is never given to anything that could raise with it in
        # the message, so nothing caught here can carry it into the log.
        logger.exception("show_setup_qr: minting a pairing code failed")
        raise ToolFailure(
            f"cannot show a pairing card: the pairing code could not be made ({type(exc).__name__})"
        ) from exc
    code = _dashed(minted["code"])
    link = f"{got.origin}{_PAGE[setup]}"
    machine = machine_row["name"] if machine_row is not None else None
    os_key = for_os or (
        _PLATFORM_TO_OS.get(machine_row["platform"]) if machine_row is not None else None
    )
    ctx.card(
        {
            "kind": "setup_qr",
            "setup": setup,
            "address": got.origin,
            "url": f"{link}#{code}",
            "code": code,
            "expires_at": minted["expires_at"],
            "machine": machine,
            "for_os": os_key,
            "commands": agent_card.commands(build, origin=got.origin, code=code),
            "walks": platform_walks.statuses(),
            "notes": agent_card.notes(),
            "version": build.version,
        }
    )
    return {
        "setup": setup,
        "address": got.origin,
        "url": link,
        "expires_at": minted["expires_at"],
        "code_shown": True,
        "machine": machine,
        "for_os": os_key,
        "walk": platform_walks.status(_OS_TO_GOOS[os_key]) if os_key else None,
    }


def _given(args: dict, key: str) -> str | None:
    """An optional argument as given, or None when it is absent or blank."""
    value = args.get(key)
    if value is None:
        return None
    return str(value).strip() or None


async def _paired_machine(app, name: str) -> dict:
    """The paired machine named `name` (as device_list shows it), read through
    machines.plant(): core's live device rows — or, inside an eval replay, the
    case's declared devices alone, never a real one. Else a stated refusal
    naming the ones there are, which is what she needs to try again herself."""
    paired = await machines.plant().paired_machines(app)
    for machine in paired:
        if machine["name"] == name:
            return machine
    names = [machine["name"] for machine in paired]
    listing = (
        f"the paired machines are: {', '.join(names)}" if names else "no machine is paired yet"
    )
    raise ToolFailure(
        f"no paired machine named {name!r} — {listing}; a re-pair card is for a paired "
        "machine — omit machine and the card adds a new one"
    )


async def show_setup_qr(args: dict, ctx: ToolContext) -> str:
    setup = str(args.get("setup") or "")
    if setup not in SETUPS:
        raise ToolFailure(f"setup must be one of {', '.join(SETUPS)}")
    machine, for_os = _given(args, "machine"), _given(args, "for_os")
    if setup not in MACHINE_SETUPS and (machine is not None or for_os is not None):
        raise ToolFailure(
            f"machine and for_os go with a machine setup ({', '.join(sorted(MACHINE_SETUPS))}), "
            f"not {setup}"
        )
    if for_os is not None and for_os not in FOR_OS:
        raise ToolFailure(f"for_os must be one of {', '.join(FOR_OS)}")
    if setup in MACHINE_SETUPS:
        machine_row = await _paired_machine(ctx.app, machine) if machine is not None else None
        fact = await send_machine_card(ctx, setup=setup, machine_row=machine_row, for_os=for_os)
        if ctx.facts_sink is not None:
            ctx.facts_sink.append(fact)
        return _machine_result(setup, fact)
    got = network.address()
    if got.origin is None:
        raise ToolFailure(
            f"cannot show a setup QR: Nova has no address another device can reach — {got.reason}"
        )
    if ctx.card is None:
        raise ToolFailure("cannot show a setup QR: this turn has no chat to show it in")
    link = f"{got.origin}{_PAGE[setup]}"
    ctx.card({"kind": "setup_qr", "setup": setup, "address": got.origin, "url": link})
    if ctx.facts_sink is not None:
        ctx.facts_sink.append(
            {
                "setup": setup,
                "address": got.origin,
                "url": link,
                "expires_at": None,
                "code_shown": False,
            }
        )
    return _result(setup, link)


NOVA_ADDRESS = Tool(
    name="nova_address",
    description=(
        "Nova's address for another device (a phone, a tablet, another computer), read from "
        "the tailnet now, or why there is none; what that device needs first; and whether a "
        "native Nova app exists. Use it before giving anyone an address for Nova. Reads only."
    ),
    parameters={"type": "object", "properties": {}, "additionalProperties": False},
    executor=nova_address,
    # A reading of this moment: an address recalled from last week is exactly
    # the stale present `ephemeral` exists to stop.
    ephemeral=True,
    reads_only=True,
)

SHOW_SETUP_QR = Tool(
    name="show_setup_qr",
    description=(
        "Send a QR code card to the chat for one setup: install_pwa (put Nova on a phone's "
        "home screen), get_app (send a phone to its app store), add_machine (pair a computer "
        "Nova controls), add_model_server (pair a machine whose models Nova will use). The "
        "card shows the QR code, its link and the steps; the machine setups also show a "
        "one-time pairing code that you never see. The machine card's command installs "
        "Nova's agent (download, sha256 check, install, start) on Linux, macOS or Windows; "
        "the result says where it has been walked on real hardware. Say only what the result "
        "says was sent."
    ),
    parameters={
        "type": "object",
        "properties": {
            "setup": {
                "type": "string",
                "enum": list(SETUPS),
                "description": "Which setup the QR code is for.",
            },
            "machine": {
                "type": "string",
                "description": (
                    "A paired machine to RE-PAIR (its name, as device_list shows it): the "
                    "card's code rebinds that machine. Omit to add a new one."
                ),
            },
            "for_os": {
                "type": "string",
                "enum": list(FOR_OS),
                "description": (
                    "The machine's OS, when you know it: the card opens on that command. wsl "
                    "means a Windows PC (the Windows command covers WSL)."
                ),
            },
        },
        "required": ["setup"],
        "additionalProperties": False,
    },
    executor=show_setup_qr,
)

TOOLS: tuple[Tool, ...] = (NOVA_ADDRESS, SHOW_SETUP_QR)
