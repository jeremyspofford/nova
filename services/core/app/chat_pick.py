"""The one write behind every "chat answers with this model".

The chat switcher, Models, Providers, Settings → Routing and her own tool
(`set_chat_model`) all make this write (2026-10-05). Each of the four pages
used to write chat.model alone, so a pick replaced link 1 and the model it
replaced was in no chain at all: one pick in chat dropped the Dell's model,
and nothing anywhere showed it was gone.

The picked model becomes chat.model — link 1 of every chain chat.model leads
— and the model it replaces becomes chat's FIRST fallback. A model that is
already a fallback leaves the fallbacks, so no chain names one model twice.

The old pick is carried as the gateway reads it: a bare id (onboarding writes
`qwen3:8b`) means the DEFAULT provider's model, and the gateway refuses a bare
link in a chain, so it is carried qualified — once that provider was seen to
list it. A provider-qualified id whose provider is gone looks the same, and
is never made up into `hub:dell:…`. When the chain still cannot be stored, the
pick is made anyway, as before this write existed, and `note` says what was
not kept: a stale chain must never make every pick fail.

While Jev Router holds chat's cloud link the switch owns that link, so a pick
cannot run until it is off. The chain is read the way chat's turns walk it —
with chat.model stated, as GET /routes reads it — so the switch reads true
when it sits in the chat-model slot. A router picked BY HAND (on, nothing
kept) is a pick like any other, and replacing it is what a pick is for.

The answer is what was STORED: chat.model as written, and the chain as the
gateway answered its own write — never the list that was sent.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import httpx

from app import db, peers, settings_store

logger = logging.getLogger("core")

ADMIN_TIMEOUT = httpx.Timeout(5.0)

# Every write that moves chat.model together with a chain — a pick, and the
# Jev Router switch on a role whose turns send chat.model (proxies) — runs one
# at a time: each reads chat.model and the chain, then writes, and two of them
# interleaving would each write from a read the other had already made stale.
LOCK = asyncio.Lock()


class PickFailed(Exception):
    """The pick could not run, with its status and its words. `body` is the
    gateway's own answer when it was the one that refused, carried so the HTTP
    route can return it verbatim."""

    def __init__(
        self, status: int, detail: str, *, body: bytes | None = None, media_type: str | None = None
    ) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.body = body
        self.media_type = media_type


@dataclass(frozen=True)
class Picked:
    chat_model: str
    # Chat's fallbacks as stored after the pick.
    chain: list[str]
    # What the pick could not keep, when something was not kept.
    note: str | None
    # chat.model before the pick ('' when none was set).
    previous: str

    def as_dict(self) -> dict:
        answer: dict = {"chat_model": self.chat_model, "chain": self.chain}
        if self.note:
            answer["note"] = self.note
        return answer


async def _chat_model() -> str:
    return str(await settings_store.read_value(await db.get_pool(), "chat.model") or "")


def _words(resp: httpx.Response) -> str:
    """A gateway refusal's own words."""
    try:
        said = resp.json()
    except ValueError:
        said = None
    if isinstance(said, dict):
        words = said.get("error") or said.get("detail")
        if words:
            return str(words)
    return f"the gateway answered {resp.status_code}"


async def _call(app, method: str, path: str, **kwargs) -> httpx.Response:
    """One gateway admin call; a gateway that cannot be reached is a stated
    502, never an exception a caller would have to know the shape of."""
    try:
        async with peers.client(app, peers.GATEWAY, ADMIN_TIMEOUT) as client:
            return await client.request(method, path, **kwargs)
    except httpx.ReadTimeout as exc:
        raise PickFailed(
            502, f"the gateway timed out — {path} did not answer within {ADMIN_TIMEOUT.read:g}s"
        ) from exc
    except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
        raise PickFailed(502, f"the gateway is unreachable — {peers.reason(exc)}") from exc


async def _lists(app, provider: str, model: str) -> bool:
    """Does `provider`'s own listing name `model`? False on any failure to
    read it — an unconfirmed model is never carried as a fallback."""
    try:
        resp = await _call(app, "GET", f"/admin/providers/{provider}/models")
    except PickFailed:
        return False
    if resp.status_code != 200:
        return False
    try:
        models = resp.json().get("models")
    except (ValueError, AttributeError):
        return False
    return any(isinstance(m, dict) and m.get("id") == model for m in models or [])


async def set_primary(app, model: str) -> Picked:
    """Make `model` chat's pick, keeping the one it replaces as the first
    fallback (the module docstring has the rules). Raises PickFailed."""
    # Function-local: a cold `import app.tools` must not load app.chat
    # (tests/test_tools_agents.py), and her tool imports this module.
    from app import chat

    model = model.strip()
    if not model:
        raise PickFailed(400, "name the model to pick: provider:model")
    async with LOCK:
        # chat.model is read ONCE: the switch state below and the pick carried
        # are judged against the same value.
        current = await _chat_model()
        params = (
            {"chat_model": current, "chat_model_roles": ",".join(chat.CHAT_MODEL_ROLES)}
            if current
            else {}
        )
        listed = await _call(app, "GET", "/admin/routes", params=params)
        if listed.status_code != 200:
            raise PickFailed(
                listed.status_code,
                _words(listed),
                body=listed.content,
                media_type=listed.headers.get("content-type"),
            )
        try:
            roles = listed.json().get("roles")
        except (ValueError, AttributeError):
            roles = None
        chat_row = next(
            (r for r in roles or [] if isinstance(r, dict) and r.get("role") == "chat"), None
        )
        if chat_row is None:
            raise PickFailed(502, "the gateway listed no chat route")
        router_state = chat_row.get("router") or {}
        if router_state.get("on") is True and router_state.get("kept") is not None:
            raise PickFailed(
                409,
                "Jev Router is picking chat's cloud model — switch it off in Settings → "
                "Models → Routing to pick one yourself",
            )
        known = await _call(app, "GET", "/admin/providers")
        try:
            rows = known.json().get("providers") if known.status_code == 200 else None
        except (ValueError, AttributeError):
            rows = None
        names = {
            r["name"] for r in rows or [] if isinstance(r, dict) and isinstance(r.get("name"), str)
        }
        default = next(
            (r["name"] for r in rows or [] if isinstance(r, dict) and r.get("is_default") is True),
            None,
        )

        def qualified(link: str) -> str:
            """`link` as the gateway resolves it (providers.split_model_id): a
            prefix naming a registered provider stays; anything else is the
            default provider's model."""
            prefix, colon, _ = link.partition(":")
            if colon and prefix in names:
                return link
            return f"{default}:{link}" if default else link

        stored = [link for link in chat_row.get("chain") or [] if isinstance(link, str)]
        note = None
        carry = None
        if current and qualified(current) != qualified(model):
            prefix, colon, _ = current.partition(":")
            if colon and prefix in names:
                carry = current
            elif default and await _lists(app, default, current):
                carry = qualified(current)
            else:
                note = (
                    f"{current} names no registered provider"
                    + (f" and is not a model {default} lists" if default else "")
                    + ", so it was not kept as a fallback"
                )
        dropped = {qualified(model)} | ({carry} if carry else set())
        chain = [link for link in stored if qualified(link) not in dropped]
        if carry:
            chain = [carry, *chain]
        # chat.model FIRST. A turn already under way reads the pick at every
        # call (chat._round_model), and between these two writes it must find
        # the new pick ahead of the chain as it was — never the old pick ahead
        # of a chain already rewritten around it, which walks that one model
        # alone. A pick that cannot be written leaves the chain as it was, too.
        if current != model:
            try:
                await settings_store.write_setting(
                    settings_store.SettingWrite(key="chat.model", value=model)
                )
            except Exception as exc:  # noqa: BLE001 - the reason is the answer
                reason = peers.reason(exc)
                logger.warning("chat primary: chat.model could not be written — %s", reason)
                raise PickFailed(502, f"chat.model could not be written — {reason}") from exc
            # Read back: what is stored is the answer, never what was asked for.
            written_model = await _chat_model()
            if written_model != model:
                raise PickFailed(502, f"chat.model reads {written_model!r} after writing {model!r}")
        if chain != stored:
            # The pick is made by now, so a chain that cannot be stored is a
            # note on it — refused or unreachable alike — never a failed pick.
            try:
                written = await _call(app, "PUT", "/admin/routes/chat", json={"chain": chain})
                refused = None if written.status_code == 200 else _words(written)
            except PickFailed as exc:
                written, refused = None, exc.detail
            if refused is None:
                try:
                    answered = written.json().get("chain")
                except (ValueError, AttributeError):
                    answered = None
                if isinstance(answered, list):
                    chain = [link for link in answered if isinstance(link, str)]
            else:
                already = carry is not None and any(qualified(link) == carry for link in stored)
                kept_out = (
                    f"{current} was not kept as a fallback"
                    if carry and not already
                    else "the fallbacks are unchanged"
                )
                note = f"chat's fallbacks could not be saved — {refused}; {kept_out}"
                logger.warning("chat primary: %s", note)
                chain = stored
    return Picked(chat_model=model, chain=chain, note=note, previous=current)
