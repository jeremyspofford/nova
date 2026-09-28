"""Routing by ROLE: which model answers a call, and why (S10-2).

A call that names a role (`X-Nova-Role: chat | scheduled | judge`) walks
that role's chain — an ordered list of `provider:model` ids the owner set.
For `chat` the request's own model (core sends chat.model, the owner's
explicit pick) is link 1 and the chain holds the fallbacks; a role with
an empty chain uses the chat chain. Each link is judged LIVE, before any
call is made (rail 9 — refuse before the act):

  * the provider must exist;
  * it must not be WALLED (a refusal — 401/402/403/429/5xx before the
    stream — walls the provider for 1h, then 6h, then 24h; a clean
    completion clears it; the owner can clear it from the page);
  * a cloud provider must be under its monthly cap and the total cap
    (usage.over_cap — recorded spend only; a local provider is never
    capped in USD);
  * an ENGINE (a row on the ollama adapter) must be SERVING — its
    owner's switch, engines.serving — and must list the model
    (engines.observe: a listing cached 30 s, a failure 10 s).

The first runnable link serves. When nothing in the chain can and the
chain has no local link, a CROSS-TIER STANDBY is derived (a serving
engine's default model if installed, else the best-fitting installed
curated pick, else its first installed chat model — never an embedding
model) and stated as such — never a cloud model the owner did not
name (that would spend money nobody chose). Nothing runnable at all is a
503 that lists every verdict. Every decision that is not link 1 carries
its reason on the response (`X-Nova-Route`) and in the usage chunk, so
the reply can say it (rail 20 — no silent fallback).

Roles are BUILT-INS ∪ any name the ledger's own usage.ROLE_RE accepts
(S12-2): a core-side agent's role is DERIVED from its name (`agent_<name>`)
and the ledger already meters it under that role, so the same rule lets
it own a chain — one with no chain (or an empty one) walks the chat chain,
exactly as scheduled/judge do. Nothing here keeps a second list of roles.

THE PROTOCOL (decision-role spec §1). A role's calls speak ONE protocol,
and the endpoint decides which: /v1/chat/completions is `chat`,
/v1/systemone is `systemone` — typed questions, the decision role's. A
link is runnable only on a provider whose adapter carries the role's
protocol (Adapter.protocols), and a systemone role never borrows the chat
chain and never falls to the local standby: a chat model has nothing to
answer a typed question with.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import asyncpg

from app import curated as curated_mod
from app import engines, providers, usage
from app import fit as fit_mod
from app.adapters import ProviderRefused, for_row, ollama

logger = logging.getLogger("gateway")

BUILTIN_ROLES = ("chat", "scheduled", "judge", "decisions", "coding", "vision")
# Roles nothing calls yet — shown on the page as "no user yet".
RESERVED_ROLES = frozenset({"coding", "vision"})
#: The decision role (decision-role spec §1): typed questions at
#: POST /v1/systemone, answered by a decision model, never a chat completion.
DECISIONS_ROLE = "decisions"
#: The two protocols a role's calls can speak (see the module docstring).
CHAT = "chat"
SYSTEMONE = "systemone"
SYSTEMONE_ROLES = frozenset({DECISIONS_ROLE})
# How a protocol is said to the owner, in a verdict's reason.
_ANSWERS = {CHAT: "chat", SYSTEMONE: "typed questions"}


def protocol_of(role: str) -> str:
    """The protocol a role's calls speak: systemone for the decision role,
    chat for every other role — built-in or an agent's derived one."""
    return SYSTEMONE if role in SYSTEMONE_ROLES else CHAT


def borrows_chat_chain(role: str, chain: Sequence[str]) -> bool:
    """Does `role` walk chat's chain? A role whose calls speak chat and that
    has no chain of its own does — the one rule the walk (resolve) and the
    Jev Router switch both read. Chat's chain is chat's own, and a systemone
    role never borrows: chat's links answer chat."""
    return not chain and role != "chat" and protocol_of(role) == CHAT


def speaks(row: dict, protocol: str) -> bool:
    """Can a link on this provider carry `protocol`? Read off the provider's
    own adapter (Adapter.protocols), never a list of vendors kept here."""
    return protocol in for_row(row).protocols


def cannot_serve(provider_name: str, row: dict, protocol: str) -> str:
    """Why a link on `row` cannot serve a role that speaks `protocol`."""
    carries = " and ".join(_ANSWERS[p] for p in sorted(for_row(row).protocols))
    return f"{provider_name} answers {carries} — this role needs {_ANSWERS[protocol]}"


# The statuses that are about the ACCOUNT rather than about one model: a key
# with no credit, a key that is not allowed, a key being rate-limited. Another
# model on the same key refuses identically, so these wall the whole provider.
WALL_STATUSES = frozenset({401, 402, 403, 429})
# An account refusal genuinely lasts — nothing about "out of credit" changes in
# a minute — so it escalates over hours.
WALL_STEPS_S = (3600, 6 * 3600, 24 * 3600)
# A 5xx is one model saying "not right now", and on this box that is usually a
# model still loading into VRAM. An hour of that is how one slow start costs
# every question for the rest of the hour, so an outage starts at a minute and
# only climbs if it keeps happening. It walls THAT MODEL, never its siblings.
OUTAGE_STEPS_S = (60, 5 * 60, 30 * 60)
# The `model` value that means "every model on this provider". Not NULL: it is
# half of the primary key, and a NULL there is a row you cannot address.
WHOLE_PROVIDER = ""


class NothingRunnable(RuntimeError):
    def __init__(self, role: str, verdicts: list[dict], *, why: str | None = None) -> None:
        said = f"no model in the {role!r} chain can serve right now"
        super().__init__(f"{said} — {why}" if why else said)
        self.role = role
        self.verdicts = verdicts


@dataclass
class Decision:
    row: dict
    model: str
    link: int
    reason: str | None
    role: str
    verdicts: list[dict] = field(default_factory=list)
    standby: bool = False

    def header(self) -> str:
        from urllib.parse import quote

        parts = [f"role={self.role}", f"link={self.link}"]
        if self.reason:
            parts.append(f"reason={quote(self.reason, safe='')}")
        if self.standby:
            parts.append("standby=1")
        return ";".join(parts)

    def as_route(self) -> dict:
        return {
            "role": self.role,
            "link": self.link,
            "reason": self.reason,
            "served_by": providers.served_by(self.row, self.model),
            "standby": self.standby,
        }


# ── routes ─────────────────────────────────────────────────────────────────


def validate_role(role: str) -> str:
    """A built-in, or any name the ledger's ROLE_RE accepts — the one rule
    usage.Attribution applies to X-Nova-Role, so whatever can be metered
    under a role can be routed by it."""
    if role in BUILTIN_ROLES or usage.ROLE_RE.fullmatch(role):
        return role
    raise ValueError(
        f"role must be a built-in ({', '.join(BUILTIN_ROLES)}) or a lowercase [a-z_] name "
        f"of at most 32 chars — got {role!r}"
    )


async def chains(pool: asyncpg.Pool) -> dict[str, list[str]]:
    rows = await pool.fetch("SELECT role, chain FROM routes")
    out = {r["role"]: list(json.loads(r["chain"])) for r in rows}
    for role in BUILTIN_ROLES:
        out.setdefault(role, [])
    return out


def _clean_chain(role: str, chain: object, by_name: dict[str, dict]) -> list[str]:
    """The chain as it would be stored, or ValueError naming the first bad
    link. Every link is `provider:model` on a registered provider whose
    adapter carries the role's protocol — a typo, or a link on an adapter
    that cannot carry the role's protocol, is refused by name before
    anything is stored. A repeated link is kept once, where it first
    appears."""
    if not isinstance(chain, list):
        raise ValueError("chain must be a list of provider:model ids")
    protocol = protocol_of(role)
    names = set(by_name)
    cleaned: list[str] = []
    for link in chain:
        if not isinstance(link, str) or not link.strip():
            raise ValueError("every link must be a non-empty provider:model string")
        link = link.strip()
        provider, model = providers.split_model_id(link, names)
        if provider is None or not model:
            raise ValueError(
                f"link {link!r} does not name a registered provider — write it as "
                f"<provider>:<model> (providers: {', '.join(sorted(names))})"
            )
        if not speaks(by_name[provider], protocol):
            raise ValueError(
                f"link {link!r} cannot serve the {role} role — "
                f"{cannot_serve(provider, by_name[provider], protocol)}"
            )
        if link in cleaned:
            continue
        cleaned.append(link)
    return cleaned


async def set_chain(
    pool: asyncpg.Pool, role: str, chain: list, by_name: dict[str, dict]
) -> list[str]:
    """Store a role's chain. `by_name` is the live provider rows by name — a
    link is judged against its provider's adapter, not only its name (see
    _clean_chain for everything that is refused).

    A hand edit is the chain speaking (plan decision 16): an edit that
    REMOVES the Jev Router link the switch placed in the stored chain turns
    the switch off, and the link it kept is forgotten with its slot, so
    nothing stale can come back later. An edit that removes no router link,
    or one the switch did not place there, leaves them alone: on chat the
    router can be the chat model, link 1, which no chain edit touches, and
    switching off must still hand the pick back."""
    validate_role(role)
    cleaned = _clean_chain(role, chain, by_name)
    async with pool.acquire() as conn, conn.transaction():
        await _lock_role(conn, role)
        before = await conn.fetchrow(
            "SELECT chain, router_kept_slot FROM routes WHERE role = $1", role
        )
        forgets = (
            before is not None
            and before["router_kept_slot"] == CHAIN_SLOT
            and router_link(json.loads(before["chain"])) is not None
            and router_link(cleaned) is None
        )
        await conn.execute(
            "INSERT INTO routes (role, chain) VALUES ($1, $2::jsonb) "
            "ON CONFLICT (role) DO UPDATE SET chain = EXCLUDED.chain, "
            "router_kept = CASE WHEN $3 THEN NULL ELSE routes.router_kept END, "
            "router_kept_slot = CASE WHEN $3 THEN NULL ELSE routes.router_kept_slot END, "
            "updated_at = now()",
            role,
            json.dumps(cleaned),
            forgets,
        )
    return cleaned


async def delete_chain(pool: asyncpg.Pool, role: str) -> bool:
    """Drop a role's row. True only when a row was actually deleted — the
    command tag is read, never assumed (role is the primary key: 0 or 1).
    Under the role's lock, like every other write of the row, so a switch
    that read it before the delete never writes it back after."""
    async with pool.acquire() as conn, conn.transaction():
        await _lock_role(conn, role)
        result = await conn.execute("DELETE FROM routes WHERE role = $1", role)
    return result == "DELETE 1"


# ── the Jev Router switch (decision-role spec §4) ─────────────────────────

#: Jev Router on OpenRouter: it picks a model and reasoning effort for each
#: request, and the owner pays for the model it picks. Its listing states no
#: parameters (checked 2026-09-28), so there is no quality-first setting to set.
JEV_ROUTER_MODEL = "typesafe/jev-router"
#: (plan decision 18) The chat-kind roles the switch is offered on — the spec's
#: "(chat, scheduled, agents)". Not judge (a one-word verdict), never a
#: systemone role (it has no cloud chat link), never a reserved one. Which
#: roles' turns send chat.model as link 1 is core's to say — it passes the
#: chat model for them — so the gateway keeps no list of those.
ROUTER_BUILTINS = ("chat", "scheduled")
#: Where the router sits, and so where its kept link goes back
#: (routes.router_kept_slot): the stored chain, or the chat model.
CHAIN_SLOT = "chain"
CHAT_MODEL_SLOT = "chat_model"


def router_switchable(role: str) -> bool:
    """Is the switch offered on this role? chat, scheduled, and every agent's
    derived role (the non-built-ins)."""
    return role in ROUTER_BUILTINS or role not in BUILTIN_ROLES


def is_router_link(link: str) -> bool:
    """Is this link Jev Router? Read off the link's own text — the bare model,
    or the model after the FIRST colon — never off the provider list:
    deleting the provider that served it must never make the switch read off
    or lose what it kept. A bare id (a chat.model with no provider) is a
    model on the default provider, and Jev Router all the same."""
    _provider, colon, model = link.partition(":")
    return link == JEV_ROUTER_MODEL or (bool(colon) and model == JEV_ROUTER_MODEL)


def router_link(chain: Sequence[str]) -> str | None:
    """The chain's first Jev Router link, if it holds one."""
    return next((link for link in chain if is_router_link(link)), None)


def _is_cloud(link: str, by_name: dict[str, dict]) -> bool:
    provider_name, _model = _provider_of(link, by_name)
    row = by_name.get(provider_name) if provider_name else None
    return row is not None and not row.get("local")


def _cloud_slot(
    chain: Sequence[str], by_name: dict[str, dict], chat_model: str | None
) -> tuple[str, int | None] | None:
    """Where the role's cloud link sits in its EFFECTIVE chain — `chat_model`,
    the chat model core passes for a role whose turns send it as link 1, then
    `chain`, the stored chain those turns walk: the first link that is Jev
    Router or on a cloud provider. (CHAT_MODEL_SLOT, None), (CHAIN_SLOT, its
    index in `chain`), or None when every link is local."""
    if chat_model and (is_router_link(chat_model) or _is_cloud(chat_model, by_name)):
        return CHAT_MODEL_SLOT, None
    for index, link in enumerate(chain):
        if is_router_link(link) or _is_cloud(link, by_name):
            return CHAIN_SLOT, index
    return None


def _router_at(
    chain: Sequence[str], by_name: dict[str, dict], chat_model: str | None
) -> tuple[str, int | None] | None:
    """The cloud slot when it holds Jev Router — the switch is on — else None."""
    slot = _cloud_slot(chain, by_name, chat_model)
    if slot is None:
        return None
    link = chat_model if slot[0] == CHAT_MODEL_SLOT else chain[slot[1]]
    return slot if is_router_link(link) else None


def router_state(
    chain: Sequence[str],
    by_name: dict[str, dict],
    kept: str | None,
    kept_slot: str | None,
    chat_model: str | None = None,
) -> dict:
    """What the routes page says of the switch on one role: on exactly when
    the cloud slot of its effective chain holds Jev Router. `kept` shows only
    while on, and only when it was kept for the slot the router sits in."""
    at = _router_at(chain, by_name, chat_model)
    if at is None:
        return {"on": False, "kept": None}
    return {"on": True, "kept": kept if kept_slot == at[0] else None}


def role_state(
    role: str,
    chain: Sequence[str],
    chat_chain: Sequence[str],
    by_name: dict[str, dict],
    kept: str | None,
    kept_slot: str | None,
    chat_model: str | None = None,
) -> dict:
    """The switch's state on `role`, read off the chain its turns walk: its
    own stored `chain`, or chat's when it has none of its own
    (borrows_chat_chain). There the router, and the link it kept, are
    chat's, so no kept link is shown."""
    if borrows_chat_chain(role, chain):
        return router_state(chat_chain, by_name, None, None, chat_model)
    return router_state(chain, by_name, kept, kept_slot, chat_model)


async def router_kept(pool: asyncpg.Pool) -> dict[str, tuple[str | None, str | None]]:
    """Each routes row's kept link and the slot it was kept for, by role."""
    rows = await pool.fetch("SELECT role, router_kept, router_kept_slot FROM routes")
    return {r["role"]: (r["router_kept"], r["router_kept_slot"]) for r in rows}


def _names_a_provider(link: str, names: set[str]) -> bool:
    """Does a kept link still name a registered provider? One whose provider
    the owner has since deleted names nothing to put back."""
    return providers.split_model_id(link, names)[0] is not None


async def _lock_role(conn, role: str) -> None:
    """Hold this role's routes row for the rest of the transaction, so a
    chain edit and a switch never interleave. An advisory lock keyed by role:
    FOR UPDATE locks nothing on a row that does not exist yet."""
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext('routes:' || $1::text))", role)


async def _store(
    conn, role: str, chain: list[str], kept: str | None, kept_slot: str | None
) -> None:
    await conn.execute(
        "INSERT INTO routes (role, chain, router_kept, router_kept_slot) "
        "VALUES ($1, $2::jsonb, $3, $4) ON CONFLICT (role) DO UPDATE SET "
        "chain = EXCLUDED.chain, router_kept = EXCLUDED.router_kept, "
        "router_kept_slot = EXCLUDED.router_kept_slot, updated_at = now()",
        role,
        json.dumps(chain),
        kept,
        kept_slot,
    )


def _put_back(
    role: str, chain: list[str], index: int, kept: str | None, names: set[str]
) -> tuple[list[str], str | None]:
    """`chain` with the router at `index` replaced by the link it kept, and a
    note when something could not be. The router is removed instead when it
    kept nothing (''), when the kept link is already elsewhere in the chain
    (a link is never doubled), or when the kept link's provider no longer
    exists — said in the note. Only the link put back is judged: the rest is
    as the owner stored it, and a link there whose provider has since gone
    must not stop the switch going off."""
    out = list(chain)
    if kept and not _names_a_provider(kept, names):
        note = (
            f"the link Jev Router replaced, {kept}, names a provider that no longer exists, "
            "so it was not put back"
        )
        logger.warning("jev router %s: %s", role, note)
        del out[index]
        return out, note
    if kept and kept not in out:
        out[index] = kept
    else:
        del out[index]
    return out, None


def _answer(
    role: str,
    chain: list[str],
    by_name: dict[str, dict],
    kept: str | None,
    kept_slot: str | None,
    chat_model: str,
    *,
    writes: bool = False,
    note: str | None = None,
) -> dict:
    """The switch's answer, its `router` read off the result (router_state),
    never assumed. `chat_model` is the chat model once core has written what
    the answer asks for; `writes` puts it in the answer as that request."""
    answer = {
        "role": role,
        "chain": chain,
        "router": router_state(chain, by_name, kept, kept_slot, chat_model or None),
    }
    if writes:
        answer["chat_model"] = chat_model
    if note:
        answer["note"] = note
    return answer


async def set_router(
    pool: asyncpg.Pool,
    role: str,
    on: bool,
    link: object,
    by_name: dict[str, dict],
    chat_model: str | None = None,
) -> dict:
    """Switch Jev Router on or off for `role` — an EDIT to the role's chain,
    which stays the one source of truth (decision-role spec §4).

    The state is read off the role's EFFECTIVE chain: `chat_model` — the chat
    model core passes for a role whose turns send it as link 1 (None or '' is
    no pick) — then the stored chain those turns walk. The cloud slot is the
    first link there that is Jev Router or on a cloud provider, and the
    switch is on exactly when that slot holds Jev Router.

    A non-chat role with no chain of its own walks chat's, so its switch is
    read there and nothing is written for it: asked for the state it reads,
    it answers with that state; asked for the other, it is refused in words
    pointing at chat's switch (a one-link chain of its own would silently
    stop it walking chat's).

    ON while on changes nothing. ON puts `link`
    (`<provider>:typesafe/jev-router`) in the cloud slot and keeps what it
    replaced, with the slot it was kept for. On the chat model (chat only)
    the stored chain is not touched: the pick is kept as provider:model, and
    the answer's `chat_model` is what chat.model must become — core writes
    it; chat.model has one writer. In the stored chain the link is replaced
    in place; with no cloud slot the router goes after the local links, kept
    ''. A router the switch placed in the stored chain and a cloud chat model
    has since displaced gets what it replaced back first: a role never holds
    two routers the switch placed.

    OFF puts the kept link back in the router's slot. On the chat model it
    answers with the pick and keeps it until core has written it, so OFF can
    be asked again. A link is never doubled, and a kept link whose provider
    no longer exists is not put back — the answer's `note` says so. OFF while
    off puts back what a displaced router replaced, as ON does, and forgets
    any other kept link: its slot does not hold the router.

    Refused, in words (ValueError): a role the switch is not offered on; a
    link that is not Jev Router, or whose provider cannot carry the role's
    calls; a role sharing chat's cloud chat model (its switch is chat's); a
    role with no chain of its own, as above; chat with neither a chain nor a
    chat model (it answers with the gateway's default model); and OFF on a
    chat model the switch did not replace."""
    validate_role(role)
    if not router_switchable(role):
        raise ValueError(
            f"the Jev Router switch is for the chat, scheduled and agent roles — not {role}"
        )
    pick = (chat_model or "").strip()
    async with pool.acquire() as conn, conn.transaction():
        await _lock_role(conn, role)
        row = await conn.fetchrow(
            "SELECT chain, router_kept, router_kept_slot FROM routes WHERE role = $1", role
        )
        chain = list(json.loads(row["chain"])) if row else []
        kept = row["router_kept"] if row else None
        kept_slot = row["router_kept_slot"] if row else None
        if borrows_chat_chain(role, chain):
            chat_chain = json.loads(
                await conn.fetchval("SELECT chain FROM routes WHERE role = 'chat'") or "[]"
            )
            return _walks_chat(role, on, chat_chain, pick, by_name)
        at = _router_at(chain, by_name, pick)
        if on and at is not None:
            return _answer(role, chain, by_name, kept, kept_slot, pick)
        if on:
            return await _switch_on(conn, role, chain, kept, kept_slot, pick, link, by_name)
        if at is not None:
            return await _switch_off(conn, role, chain, kept, kept_slot, pick, at, by_name)
        return await _off_while_off(conn, role, chain, kept, kept_slot, pick, by_name)


def _walks_chat(
    role: str, on: bool, chat_chain: list[str], pick: str, by_name: dict[str, dict]
) -> dict:
    """ON or OFF on a role with no chain of its own. Its turns walk chat's
    chain, so its switch is read there (role_state), and nothing there is
    this role's to change: asked for the state it reads, it answers with it;
    asked for the other, it is refused in words pointing at chat's switch."""
    router = role_state(role, [], chat_chain, by_name, None, None, pick)
    if on and not router["on"]:
        raise ValueError(
            f"{role} has no chain of its own — it walks the chat chain; switch Jev Router "
            f"on for chat, or give {role} its own chain first"
        )
    if router["on"] and not on:
        raise ValueError(
            f"{role} has no chain of its own — it walks the chat chain; switch Jev Router "
            "off for chat"
        )
    return {"role": role, "chain": [], "router": router}


async def _switch_on(
    conn,
    role: str,
    chain: list[str],
    kept: str | None,
    kept_slot: str | None,
    pick: str,
    link: object,
    by_name: dict[str, dict],
) -> dict:
    names = set(by_name)
    if not isinstance(link, str) or not link.strip():
        raise ValueError(
            "link is required to switch Jev Router on — the provider:model that serves "
            f"{JEV_ROUTER_MODEL}"
        )
    link = link.strip()
    provider_name, model = providers.split_model_id(link, names)
    if provider_name is None or model != JEV_ROUTER_MODEL:
        raise ValueError(
            f"{link!r} is not Jev Router — the link must be <provider>:{JEV_ROUTER_MODEL} "
            "on a registered provider"
        )
    # From here the link is the role's chat link — on chat, the chat model
    # itself — so a provider that cannot carry the role's calls is refused
    # by name before anything is stored or handed to core.
    _clean_chain(role, [link], by_name)
    note = None
    placed = router_link(chain) if kept_slot == CHAIN_SLOT else None
    if placed is not None:
        # The switch is off, so this router is not the cloud slot: a cloud
        # link sits in front of it. What it replaced goes back first.
        chain, note = _put_back(role, chain, chain.index(placed), kept, names)
    slot = _cloud_slot(chain, by_name, pick)
    if slot is not None and slot[0] == CHAT_MODEL_SLOT:
        if role != "chat":
            raise ValueError(
                f"{role}'s first link is the chat model, {pick}, a cloud model it shares "
                "with chat — switch Jev Router on for chat"
            )
        # Kept qualified — the provider a bare pick reached — so OFF hands back
        # the link that served, and a bare id is never taken for a gone one.
        provider_name, model = _provider_of(pick, by_name)
        kept = f"{provider_name}:{model}"
        await _store(conn, role, chain, kept, CHAT_MODEL_SLOT)
        return _answer(role, chain, by_name, kept, CHAT_MODEL_SLOT, link, writes=True, note=note)
    if slot is not None:
        kept = chain[slot[1]]
        chain[slot[1]] = link
    else:
        if not chain and role != "chat":
            raise ValueError(
                f"{role} has no chain of its own — it walks the chat chain; switch Jev Router "
                f"on for chat, or give {role} its own chain first"
            )
        if not chain and not pick:
            raise ValueError(
                "chat has no chain and no chat model, so it answers with the gateway's default "
                "model — pick a chat model or give chat a chain first"
            )
        kept = ""
        chain.append(link)
    cleaned = _clean_chain(role, chain, by_name)
    await _store(conn, role, cleaned, kept, CHAIN_SLOT)
    return _answer(role, cleaned, by_name, kept, CHAIN_SLOT, pick, note=note)


async def _switch_off(
    conn,
    role: str,
    chain: list[str],
    kept: str | None,
    kept_slot: str | None,
    pick: str,
    at: tuple[str, int | None],
    by_name: dict[str, dict],
) -> dict:
    names = set(by_name)
    where, index = at
    if where == CHAT_MODEL_SLOT:
        if role != "chat":
            raise ValueError(
                f"{role}'s first link is the chat model, which is Jev Router — switch it off "
                "on chat"
            )
        if kept_slot != CHAT_MODEL_SLOT or not kept:
            raise ValueError(
                "Jev Router is the chat model, picked in chat — the switch replaced nothing "
                "there, so there is nothing to put back; pick a chat model in chat"
            )
        # The pick stays kept: until core has written it, the router is still
        # link 1 and the switch still reads on, so OFF can be asked again. The
        # next ON overwrites it.
        if not _names_a_provider(kept, names):
            note = (
                f"the chat model Jev Router replaced, {kept}, names a provider that no longer "
                "exists, so the chat model is cleared — pick one in chat"
            )
            logger.warning("jev router %s: %s", role, note)
            return _answer(role, chain, by_name, kept, kept_slot, "", writes=True, note=note)
        return _answer(role, chain, by_name, kept, kept_slot, kept, writes=True)
    chain, note = _put_back(role, chain, index, kept if kept_slot == CHAIN_SLOT else "", names)
    await _store(conn, role, chain, None, None)
    return _answer(role, chain, by_name, None, None, pick, note=note)


async def _off_while_off(
    conn,
    role: str,
    chain: list[str],
    kept: str | None,
    kept_slot: str | None,
    pick: str,
    by_name: dict[str, dict],
) -> dict:
    """OFF asked while off. A router the switch placed in the stored chain
    that a cloud chat model has since displaced gets what it replaced back;
    any other kept link is stale — its slot does not hold the router — and
    is forgotten."""
    note = None
    placed = router_link(chain) if kept_slot == CHAIN_SLOT else None
    if placed is not None:
        chain, note = _put_back(role, chain, chain.index(placed), kept, set(by_name))
    if kept is not None:
        await _store(conn, role, chain, None, None)
    return _answer(role, chain, by_name, None, None, pick, note=note)


# ── walls ──────────────────────────────────────────────────────────────────


async def walls(pool: asyncpg.Pool) -> dict[tuple[str, str], dict]:
    """Every live wall, keyed by (provider, model).

    `model` is WHOLE_PROVIDER for an account-level refusal and the model's own
    id for an outage, so a caller asks two questions of this map — is the
    provider walled, and is this model walled — and never confuses the two.
    """
    rows = await pool.fetch(
        "SELECT provider, model, walled_until, reason, status, strikes FROM provider_walls "
        "WHERE walled_until > now()"
    )
    return {(r["provider"], r["model"]): dict(r) for r in rows}


def wall_for(walled: dict[tuple[str, str], dict], provider: str, model: str) -> dict | None:
    """The wall that stops this link, if one does. The provider-wide wall wins:
    it is the broader fact and its reason is the one worth reading."""
    return walled.get((provider, WHOLE_PROVIDER)) or walled.get((provider, model))


async def record_refusal(
    pool: asyncpg.Pool, row: dict, status: int, detail: str, *, model: str | None = None
) -> dict | None:
    """Something refused before serving: wall it (escalating) — ONE transaction
    with nothing else, so a wall never half-writes. The ledger row for the
    refusal is written by usage.observe / record_probe on the same path.
    Statuses outside WALL_STATUSES and below 500 wall nothing (a 400 is about
    THIS request, not the provider).

    WHAT gets walled is derived from what the status is ABOUT, never from a list
    of providers anyone maintains. An account-level status (WALL_STATUSES) is the
    provider talking about your key, so it walls the provider and every model on
    it; a 5xx is one model failing to serve, so it walls that model and leaves
    its siblings runnable. On 2026-09-10 one model's read timeout walled its own
    fallback for an hour and the owner's next question had nowhere to go.

    `model` is optional only so an account-level refusal need not name one.
    """
    if status not in WALL_STATUSES and status < 500:
        return None
    account_level = status in WALL_STATUSES
    scope = WHOLE_PROVIDER if account_level or not model else model
    steps = WALL_STEPS_S if account_level else OUTAGE_STEPS_S
    async with pool.acquire() as conn, conn.transaction():
        prior = await conn.fetchrow(
            "SELECT strikes FROM provider_walls WHERE provider = $1 AND model = $2",
            row["name"],
            scope,
        )
        strikes = (prior["strikes"] if prior else 0) + 1
        wait = steps[min(strikes, len(steps)) - 1]
        recorded_at = datetime.now(UTC)
        until = recorded_at + timedelta(seconds=wait)
        who = row["name"] if scope == WHOLE_PROVIDER else f"{row['name']}:{scope}"
        reason = f"{who} refused ({status}): {detail[:200]}"
        await conn.execute(
            "INSERT INTO provider_walls (provider, model, walled_until, reason, status, strikes) "
            "VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider, model) DO UPDATE SET "
            "walled_until = EXCLUDED.walled_until, reason = EXCLUDED.reason, "
            "status = EXCLUDED.status, strikes = EXCLUDED.strikes, updated_at = now()",
            row["name"],
            scope,
            until,
            reason,
            status,
            strikes,
        )
    logger.warning("walled: %s until %s (strike %d)", who, until, strikes)
    return {
        "provider": row["name"],
        "model": scope,
        "walled_until": until,
        "recorded_at": recorded_at,
        "reason": reason,
        "strikes": strikes,
    }


async def clear_wall(pool: asyncpg.Pool, provider: str) -> bool:
    """The owner saying "try this provider again" — so it clears the
    provider-wide wall AND every model wall under it, which is what "unwall
    openrouter" means to the person clicking it."""
    result = await pool.execute("DELETE FROM provider_walls WHERE provider = $1", provider)
    return not result.endswith(" 0")


async def note_success(pool: asyncpg.Pool, provider: str, model: str) -> None:
    """A clean completion clears the provider's wall and THIS model's.

    Not every model's: an outage wall says a particular model would not serve,
    and one of its siblings answering is no evidence about it. Clearing them all
    would send the next turn straight back into the model that just failed.
    """
    await pool.execute(
        "DELETE FROM provider_walls WHERE provider = $1 AND model = ANY($2::text[])",
        provider,
        [WHOLE_PROVIDER, model],
    )


# ── the walk ───────────────────────────────────────────────────────────────

# How long the standby waits on ollama's own /api/show answers before it
# passes over an engine: a stalled engine costs its candidates, never the
# turn (catalog.SHOW_DEADLINE_S's reasoning, sized for a turn in flight).
STANDBY_SHOW_DEADLINE_S = 5.0


def _provider_of(link: str, by_name: dict[str, dict]) -> tuple[str | None, str]:
    """(provider name or None, model) for one chain link. A bare id is a
    model on the DEFAULT provider — the same rule providers.resolve applies
    to every request (a local tag like qwen3.8:27b has a colon of its own
    and no provider prefix)."""
    provider_name, model = providers.split_model_id(link, set(by_name))
    if provider_name is None and model:
        default = next((r for r in by_name.values() if r.get("is_default")), None)
        if default is not None:
            provider_name = default["name"]
    return provider_name, model


def switched_off(row: dict) -> str | None:
    """Why this engine serves nothing right now, or None. `serving` is the
    owner's switch (engines.serving; PUT /admin/engines/{name}) — installed
    is not the same as used. A row that is not an engine has no switch. The
    words are engines.switched_off_reason, the one sentence observe states
    too (S40 ruling C10)."""
    if engines.is_engine(row) and row.get("serving") is False:
        return engines.switched_off_reason(row["name"])
    return None


def _installed(names: set[str] | None, model: str) -> bool | None:
    if names is None:
        return None
    return model in names or f"{model}:latest" in names


async def judge_link(
    app,
    pool,
    link: str,
    by_name: dict[str, dict],
    walled: dict,
    timezone: str,
    seen: dict[str, engines.EngineView],
    *,
    protocol: str = CHAT,
) -> dict:
    """One link's live verdict: runnable, or why not — in words.

    `seen` is this walk's observation of each engine the chain names
    (engines.observe), keyed by engine name. An engine its owner switched
    off is judged first, and nothing is asked of it. A link whose provider
    cannot carry the role's `protocol` is judged `wrong_protocol` first, and
    nothing is asked of it."""
    provider_name, model = _provider_of(link, by_name)
    if provider_name is None or not model:
        return {
            "id": link,
            "verdict": "unknown",
            "reason": f"{link!r} names no registered provider",
        }
    row = by_name[provider_name]
    entry = {"id": link, "provider": provider_name, "model": model, "local": bool(row.get("local"))}
    if not speaks(row, protocol):
        return {
            **entry,
            "verdict": "wrong_protocol",
            "reason": cannot_serve(provider_name, row, protocol),
        }
    off = switched_off(row)
    if off is not None:
        return {**entry, "verdict": "switched_off", "reason": off}
    wall = wall_for(walled, provider_name, model)
    if wall is not None:
        left = int((wall["walled_until"] - datetime.now(UTC)).total_seconds() // 60) + 1
        return {
            **entry,
            "verdict": "walled",
            "reason": f"{wall['reason']} — walled for another {left} min",
            "walled_until": wall["walled_until"].isoformat(),
        }
    capped = await usage.over_cap(pool, row, timezone)
    if capped:
        return {**entry, "verdict": "over_cap", "reason": capped}
    if engines.is_engine(row):
        view = seen.get(provider_name)
        names = None if view is None or view.tags is None else set(view.tags)
        installed = _installed(names, model)
        if installed is False:
            return {
                **entry,
                "verdict": "not_installed",
                "reason": f"{model} is not installed on {provider_name}",
            }
        if installed is None:
            # The engine's own words when it gave any (they already say it
            # "could not be asked what is installed" and why) — never both
            # (S40 ruling E5).
            reason = (view.reason if view is not None else None) or (
                f"{provider_name} could not be asked what is installed"
            )
            return {**entry, "verdict": "unreachable", "reason": reason}
    return {**entry, "verdict": "runnable", "reason": None}


async def _chat_models(app, row: dict, names: set[str]) -> set[str]:
    """The models among `names` that ollama's own /api/show declares fit for
    a chat turn (ollama.suits_chat: completion without embedding). A model
    whose show could not be read declares nothing and is left out — never
    guessed into a chat.

    The answers are content-addressed (ollama.SHOW_CACHE, keyed by the
    /api/tags digest — which is why the listing is read here rather than
    taken from the engine's cached name→size map), so once they are cached
    this costs one /api/tags read."""
    try:
        listing = await ollama.ADAPTER.list_models(app, row)
        rows = [m for m in listing.models if m["id"] in names]
        shown = await asyncio.wait_for(
            ollama.facts_for_installed(app, providers.base_url_of(row), rows),
            STANDBY_SHOW_DEADLINE_S,
        )
    except (ProviderRefused, TimeoutError) as exc:
        logger.warning("standby: %s could not say which models chat — %s", row["name"], exc)
        return set()
    return {
        name for name, facts in shown.items() if ollama.suits_chat(facts.get("capabilities") or {})
    }


async def standby(
    app,
    pool,
    fit_context,
    latest_probes,
    candidates: list[dict],
    seen: dict[str, engines.EngineView],
) -> tuple[dict, str, str] | None:
    """(row, model, why) — the local model to fall to when a chain has no
    runnable link and names no local model.

    Only an engine that is SERVING (its owner's switch) and whose listing
    could be read is considered, in engines.rows' order (the builtin
    first), and only a model ollama declares fit for chat: the bundled
    engine is also the embedder (D8), and the old last resort — the first
    tag in sorted order — would hand a chat turn to whichever embedder
    sorted first. On each engine: its default model if installed, else the
    best-fitting installed curated pick (curated order, first that is not
    wont_fit), else its first installed chat model. A curated pick's fit is
    THIS engine's (`fit_context(app, pool, row)`), read by the compute its
    card has now (S40 ruling C13)."""
    curated = curated_mod.load_curated()
    for row in candidates:
        ctx: dict | None = None
        probes: dict = {}
        if switched_off(row) is not None:
            continue
        name = row["name"]
        view = seen.get(name) or await engines.observe(app, pool, row, live=False)
        if not view.tags:
            continue
        default = row.get("default_model")
        # The default alone first (S40 fix wave C1): after a restart the show
        # cache is empty, and asking about every installed model under one
        # deadline let a single slow show 503 a standby whose default was
        # installed and chats. The rest are asked about only when it is not.
        mine = {tag for tag in view.tags if default and _installed({tag}, default)}
        if mine and _installed(await _chat_models(app, row, mine), default):
            return row, default, f"{name}'s default model {default}"
        chat = await _chat_models(app, row, set(view.tags) - mine)
        if not chat:
            continue
        for entry in curated:
            slug = entry["slug"]
            if not _installed(chat, slug):
                continue
            if ctx is None:
                # Asked only when a curated pick is installed: the card is read
                # when a fit verdict is needed, never on the way past.
                ctx = await fit_context(app, pool, row)
                probes = await latest_probes(
                    pool, [e["slug"] for e in curated], compute=ctx["compute"]
                )
            needed_gb, source = fit_mod.needed_gb_for(entry, probes.get(slug))
            verdict = fit_mod.compute_fit(
                needed_gb, ctx["free_gb"], ctx["total_gb"], source=source, reason=ctx["reason"]
            )
            if verdict.get("verdict") != "wont_fit":
                return (
                    row,
                    slug,
                    f"the best-fitting installed curated pick {slug} on {name} "
                    f"({verdict.get('verdict')})",
                )
        first = sorted(chat)[0]
        return row, first, f"the first installed chat model on {name}, {first}"
    return None


async def resolve(
    app,
    pool: asyncpg.Pool,
    *,
    role: str,
    requested: str | None,
    timezone: str,
    fit_context,
    latest_probes,
    skip: set[str] | None = None,
    unreachable: dict[str, str] | None = None,
) -> Decision:
    """The link that serves this call, decided BEFORE any provider is
    called. `skip` names links already refused in this request (the
    in-request fallback after a live refusal); `unreachable` maps links this
    request could not reach at all to the words why. Both are keyed by the
    served id (`provider:model`), so a bare link in the chain matches too,
    and neither is asked again in the same request."""
    validate_role(role)
    protocol = protocol_of(role)
    by_name = {r["name"]: r for r in await providers.list_rows(pool)}
    engine_names: list[str] = []
    for row in await engines.rows(pool):
        # The provider row plus its engines columns (serving, lifecycle, ...).
        by_name[row["name"]] = {**by_name.get(row["name"], {}), **row}
        engine_names.append(row["name"])
    all_chains = await chains(pool)
    chain = list(all_chains.get(role) or [])
    if borrows_chat_chain(role, chain):
        # A chat role with no chain of its own walks chat's. A systemone role
        # never does: chat's links answer chat, and a chat model asked a typed
        # question at /systemone has nothing to say (decision-role spec §1).
        chain = list(all_chains.get("chat") or [])
    if requested:
        # The explicit pick is link 1; the chain holds the fallbacks.
        chain = [requested] + [c for c in chain if c != requested]
    if not chain:
        if protocol == SYSTEMONE:
            # (plan decision 10) Empty is "no decision model", stated — never
            # the default provider's chat model below.
            raise NothingRunnable(
                role,
                [],
                why=f"the {role} chain is empty, so no decision model is set "
                "(add one in Settings → Routing)",
            )
        # No pick and no chain: today's rule — the default provider's model,
        # unless the default is an engine its owner switched off.
        default = await providers.default_row(pool)
        model = default.get("default_model") or ""
        link_id = f"{default['name']}:{model}"
        off = switched_off(by_name.get(default["name"], default))
        if off is not None:
            raise NothingRunnable(
                role,
                [
                    {
                        "id": link_id,
                        "provider": default["name"],
                        "model": model,
                        "local": bool(default.get("local")),
                        "verdict": "switched_off",
                        "reason": off,
                        "link": 1,
                    }
                ],
            )
        return Decision(
            row=default,
            model=model,
            link=1,
            reason=None,
            role=role,
            verdicts=[
                {
                    "id": link_id,
                    "verdict": "runnable",
                    "reason": "no chain; the default provider's model",
                }
            ],
        )
    walled = await walls(pool)
    # Observe only the engines this chain names, once each, and never one
    # its owner switched off.
    seen: dict[str, engines.EngineView] = {}
    for link in chain:
        name, _model = _provider_of(link, by_name)
        row = by_name.get(name) if name else None
        if (
            row is not None
            and name not in seen
            and engines.is_engine(row)
            and switched_off(row) is None
            and speaks(row, protocol)
        ):
            seen[name] = await engines.observe(app, pool, row, live=False)
    verdicts: list[dict] = []
    has_local = False
    for index, link in enumerate(chain, 1):
        verdict = await judge_link(
            app, pool, link, by_name, walled, timezone, seen, protocol=protocol
        )
        verdict["link"] = index
        served_as = f"{verdict['provider']}:{verdict['model']}" if verdict.get("provider") else link
        if unreachable and served_as in unreachable:
            verdict["verdict"] = "unreachable"
            verdict["reason"] = unreachable[served_as]
        elif skip and served_as in skip:
            verdict["verdict"] = "refused"
            verdict["reason"] = f"{link} refused this request"
        verdicts.append(verdict)
        # F7 (decision-role spec, Task 2 rulings): a wrong_protocol link never
        # served anything and never will on this role — its `local` says only
        # where the PROVIDER sits, so counting it would let a local decision
        # server (Kev, marked local) sitting in chat.model by mistake block
        # the cross-tier standby it can never itself become.
        has_local = has_local or (
            bool(verdict.get("local")) and verdict["verdict"] != "wrong_protocol"
        )
        if verdict["verdict"] == "runnable":
            reason = None
            if index > 1:
                skipped = "; ".join(f"{v['id']}: {v['reason']}" for v in verdicts[:-1])
                reason = f"fell back to link {index} ({link}) — {skipped}"
            return Decision(
                row=by_name[verdict["provider"]],
                model=verdict["model"],
                link=index,
                reason=reason,
                role=role,
                verdicts=verdicts,
            )
    if not has_local and protocol == CHAT:
        candidates = [by_name[name] for name in engine_names]
        fallback = await standby(app, pool, fit_context, latest_probes, candidates, seen)
        if fallback is not None:
            row, model, why = fallback
            standby_id = f"{row['name']}:{model}"
            entry = {
                "id": standby_id,
                "provider": row["name"],
                "model": model,
                "local": True,
                "link": len(verdicts) + 1,
            }
            if unreachable and standby_id in unreachable:
                reason = f"standby: {unreachable[standby_id]}"
                verdicts.append({**entry, "verdict": "unreachable", "reason": reason})
            elif skip and standby_id in skip:
                reason = f"standby: {standby_id} refused this request"
                verdicts.append({**entry, "verdict": "refused", "reason": reason})
            else:
                skipped = "; ".join(f"{v['id']}: {v['reason']}" for v in verdicts)
                verdicts.append({**entry, "verdict": "runnable", "reason": f"standby: {why}"})
                return Decision(
                    row=row,
                    model=model,
                    link=len(verdicts),
                    reason=f"fell back to local standby {standby_id} ({why}) — {skipped}",
                    role=role,
                    verdicts=verdicts,
                    standby=True,
                )
    raise NothingRunnable(role, verdicts)


async def explain(
    app, pool, *, role: str, requested: str | None, timezone: str, fit_context, latest_probes
) -> dict:
    """The same walk without serving: every link's verdict and what would serve."""
    try:
        decision = await resolve(
            app,
            pool,
            role=role,
            requested=requested,
            timezone=timezone,
            fit_context=fit_context,
            latest_probes=latest_probes,
        )
    except NothingRunnable as exc:
        return {"role": role, "chain": exc.verdicts, "would_serve": None, "reason": str(exc)}
    return {
        "role": role,
        "chain": decision.verdicts,
        "would_serve": decision.as_route(),
        "reason": decision.reason,
    }


__all__ = [
    "BUILTIN_ROLES",
    "RESERVED_ROLES",
    "CHAT",
    "DECISIONS_ROLE",
    "JEV_ROUTER_MODEL",
    "SYSTEMONE",
    "SYSTEMONE_ROLES",
    "Decision",
    "NothingRunnable",
    "cannot_serve",
    "protocol_of",
    "resolve",
    "explain",
    "router_state",
    "router_switchable",
    "set_router",
    "speaks",
    "switched_off",
]
_ = time  # noqa: F841 — kept for callers that time the walk
