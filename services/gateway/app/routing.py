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
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import asyncpg

from app import curated as curated_mod
from app import engines, providers, usage
from app import fit as fit_mod
from app.adapters import ProviderRefused, ollama

logger = logging.getLogger("gateway")

BUILTIN_ROLES = ("chat", "scheduled", "judge", "coding", "vision")
# Roles nothing calls yet — shown on the page as "no user yet".
RESERVED_ROLES = frozenset({"coding", "vision"})
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
    def __init__(self, role: str, verdicts: list[dict]) -> None:
        super().__init__(f"no model in the {role!r} chain can serve right now")
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


async def set_chain(pool: asyncpg.Pool, role: str, chain: list, names: set[str]) -> list[str]:
    """Store a role's chain; every link must be `provider:model` with a
    registered provider (a typo is refused by name, before it is stored)."""
    validate_role(role)
    if not isinstance(chain, list):
        raise ValueError("chain must be a list of provider:model ids")
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
        if link in cleaned:
            continue
        cleaned.append(link)
    await pool.execute(
        "INSERT INTO routes (role, chain) VALUES ($1, $2::jsonb) "
        "ON CONFLICT (role) DO UPDATE SET chain = EXCLUDED.chain, updated_at = now()",
        role,
        json.dumps(cleaned),
    )
    return cleaned


async def delete_chain(pool: asyncpg.Pool, role: str) -> bool:
    """Drop a role's row. True only when a row was actually deleted — the
    command tag is read, never assumed (role is the primary key: 0 or 1)."""
    result = await pool.execute("DELETE FROM routes WHERE role = $1", role)
    return result == "DELETE 1"


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


async def installed_sizes(
    app, pool: asyncpg.Pool, engine: str = engines.BUILTIN
) -> dict[str, int | None] | None:
    """{tag -> download size in bytes} for what `engine` lists (the bundled
    engine unless one is named), or None when it could not be asked — read
    through engines.observe, whose per-engine cache holds a ready listing
    30 s and a failure 10 s. admin._fit_context sizes models from it until
    S40 T4 moves it onto engines directly."""
    try:
        return await engines.installed_sizes(app, pool, engine)
    except engines.UnknownEngine:
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
) -> dict:
    """One link's live verdict: runnable, or why not — in words.

    `seen` is this walk's observation of each engine the chain names
    (engines.observe), keyed by engine name. An engine its owner switched
    off is judged first, and nothing is asked of it."""
    provider_name, model = _provider_of(link, by_name)
    if provider_name is None or not model:
        return {
            "id": link,
            "verdict": "unknown",
            "reason": f"{link!r} names no registered provider",
        }
    row = by_name[provider_name]
    entry = {"id": link, "provider": provider_name, "model": model, "local": bool(row.get("local"))}
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
    wont_fit), else its first installed chat model."""
    curated = curated_mod.load_curated()
    ctx: dict | None = None
    probes: dict = {}
    for row in candidates:
        if switched_off(row) is not None:
            continue
        name = row["name"]
        view = seen.get(name) or await engines.observe(app, pool, row, live=False)
        if not view.tags:
            continue
        chat = await _chat_models(app, row, set(view.tags))
        if not chat:
            continue
        default = row.get("default_model")
        if default and _installed(chat, default):
            return row, default, f"{name}'s default model {default}"
        for entry in curated:
            slug = entry["slug"]
            if not _installed(chat, slug):
                continue
            if ctx is None:
                # Asked only when a curated pick is installed: the card is read
                # when a fit verdict is needed, never on the way past.
                ctx = await fit_context(app, pool)
                probes = await latest_probes(pool, [e["slug"] for e in curated])
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
    by_name = {r["name"]: r for r in await providers.list_rows(pool)}
    engine_names: list[str] = []
    for row in await engines.rows(pool):
        # The provider row plus its engines columns (serving, lifecycle, ...).
        by_name[row["name"]] = {**by_name.get(row["name"], {}), **row}
        engine_names.append(row["name"])
    all_chains = await chains(pool)
    chain = list(all_chains.get(role) or [])
    if not chain and role != "chat":
        chain = list(all_chains.get("chat") or [])
    if requested:
        # The explicit pick is link 1; the chain holds the fallbacks.
        chain = [requested] + [c for c in chain if c != requested]
    if not chain:
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
        ):
            seen[name] = await engines.observe(app, pool, row, live=False)
    verdicts: list[dict] = []
    has_local = False
    for index, link in enumerate(chain, 1):
        verdict = await judge_link(app, pool, link, by_name, walled, timezone, seen)
        verdict["link"] = index
        served_as = f"{verdict['provider']}:{verdict['model']}" if verdict.get("provider") else link
        if unreachable and served_as in unreachable:
            verdict["verdict"] = "unreachable"
            verdict["reason"] = unreachable[served_as]
        elif skip and served_as in skip:
            verdict["verdict"] = "refused"
            verdict["reason"] = f"{link} refused this request"
        verdicts.append(verdict)
        has_local = has_local or bool(verdict.get("local"))
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
    if not has_local:
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
    "Decision",
    "NothingRunnable",
    "resolve",
    "explain",
    "switched_off",
]
_ = time  # noqa: F841 — kept for callers that time the walk
