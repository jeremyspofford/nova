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
from datetime import UTC, datetime

from app import db, devices, native_app, network
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

Mint = Callable[[object], Awaitable[dict]]


async def _mint_for(person) -> dict:
    """The real mint: one single-use code for this person, stored as its hash."""
    pool = await db.get_pool()
    return await devices.mint_pairing_code(pool, created_by=person.id)


# The seam an eval replay swaps (machines.PLANT's pattern): a turn inside a case
# must never mint a code that could enroll a real machine.
PAIRING: ContextVar[Mint] = ContextVar("setup_pairing", default=_mint_for)


def _dashed(code: str) -> str:
    clean = devices.normalize_code(code)
    return f"{clean[:4]}-{clean[4:]}" if len(clean) == 8 else clean


def _clock(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).astimezone(UTC).strftime("%H:%M UTC")
    except ValueError:
        return iso


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


def _result(setup: str, link: str, expires_at: str | None) -> str:
    if setup == "install_pwa":
        return (
            f"Sent a QR card to the chat. It opens {link}, which shows the phone its own steps "
            f"for adding Nova to its home screen. {TAILSCALE_STEP}"
        )
    if setup == "get_app":
        return (
            f"Sent a QR card to the chat. It opens {link}, which sends an iPhone to the App "
            f"Store and an Android phone to Google Play once a Nova app exists. "
            f"{native_app.stated()} Until there is one, that page shows the web app's install "
            f"steps instead. {TAILSCALE_STEP}"
        )
    minutes = devices.PAIRING_CODE_TTL_SECONDS // 60
    said = (
        f"Sent a pairing card to the chat: a QR code, a short link ({link}) and a one-time "
        f"code that expires in {minutes} minutes, at {_clock(expires_at or '')}. The machine "
        f"needs Nova's agent, novad (Linux today); the card shows the command to run on it. "
        f"You do not have the code — it is only on the card."
    )
    return f"{said} {MODEL_SERVER_NOTE}" if setup == "add_model_server" else said


async def show_setup_qr(args: dict, ctx: ToolContext) -> str:
    setup = str(args.get("setup") or "")
    if setup not in SETUPS:
        raise ToolFailure(f"setup must be one of {', '.join(SETUPS)}")
    got = network.address()
    if got.origin is None:
        raise ToolFailure(
            f"cannot show a setup QR: Nova has no address another device can reach — {got.reason}"
        )
    if ctx.card is None:
        raise ToolFailure("cannot show a setup QR: this turn has no chat to show it in")
    link = f"{got.origin}{_PAGE[setup]}"
    card: dict = {"kind": "setup_qr", "setup": setup, "address": got.origin, "url": link}
    expires_at: str | None = None
    if setup in MACHINE_SETUPS:
        try:
            minted = await PAIRING.get()(ctx.person)
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
                f"cannot show a pairing card: the pairing code could not be made "
                f"({type(exc).__name__})"
            ) from exc
        code = _dashed(minted["code"])
        expires_at = minted["expires_at"]
        card.update(url=f"{link}#{code}", code=code, expires_at=expires_at)
    ctx.card(card)
    if ctx.facts_sink is not None:
        ctx.facts_sink.append(
            {
                "setup": setup,
                "address": got.origin,
                "url": link,
                "expires_at": expires_at,
                "code_shown": setup in MACHINE_SETUPS,
            }
        )
    return _result(setup, link, expires_at)


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
        "one-time pairing code that you never see. Say only what the result says was sent."
    ),
    parameters={
        "type": "object",
        "properties": {
            "setup": {
                "type": "string",
                "enum": list(SETUPS),
                "description": "Which setup the QR code is for.",
            },
        },
        "required": ["setup"],
        "additionalProperties": False,
    },
    executor=show_setup_qr,
)

TOOLS: tuple[Tool, ...] = (NOVA_ADDRESS, SHOW_SETUP_QR)
