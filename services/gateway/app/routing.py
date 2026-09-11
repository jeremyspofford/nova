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
  * a local model must be installed (ollama's /api/tags, cached 30 s).

The first runnable link serves. When nothing in the chain can and the
chain has no local link, a CROSS-TIER STANDBY is derived (the bundled
ollama's default model if installed, else the best-fitting installed
curated pick) and stated as such — never a cloud model the owner did not
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

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import asyncpg

from app import curated as curated_mod
from app import fit as fit_mod
from app import providers, usage
from app.adapters import ProviderRefused, ollama
from app.cache import TTLCache

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
TAGS_TTL_S = 30
TAGS_CACHE = TTLCache(ttl_s=TAGS_TTL_S, max_entries=4)


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


async def installed_tags(app, pool: asyncpg.Pool) -> set[str] | None:
    """What the bundled ollama lists, cached TAGS_TTL_S; None when it could
    not be asked (a local link is then judged 'ollama unreachable')."""
    hit = TAGS_CACHE.get("tags")
    if hit is not None:
        return hit[0]
    try:
        builtin = await providers.get_row(pool, "ollama")
        listing = await ollama.ADAPTER.list_models(app, builtin)
    except (ProviderRefused, providers.UnknownProvider):
        return None
    names = {m["id"] for m in listing.models}
    TAGS_CACHE.put("tags", names)
    return names


def _installed(names: set[str] | None, model: str) -> bool | None:
    if names is None:
        return None
    return model in names or f"{model}:latest" in names


async def judge_link(
    app, pool, link: str, by_name: dict[str, dict], walled: dict, timezone: str, tags
) -> dict:
    """One link's live verdict: runnable, or why not — in words."""
    provider_name, model = providers.split_model_id(link, set(by_name))
    if provider_name is None and model:
        # A bare id is a model on the DEFAULT provider — the same rule
        # providers.resolve applies to every request (a local tag like
        # qwen3.8:27b has a colon of its own and no provider prefix).
        default = next((r for r in by_name.values() if r.get("is_default")), None)
        if default is not None:
            provider_name = default["name"]
    if provider_name is None or not model:
        return {
            "id": link,
            "verdict": "unknown",
            "reason": f"{link!r} names no registered provider",
        }
    row = by_name[provider_name]
    entry = {"id": link, "provider": provider_name, "model": model, "local": bool(row.get("local"))}
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
    if row.get("local"):
        installed = _installed(tags, model)
        if installed is False:
            return {**entry, "verdict": "not_installed", "reason": f"{model} is not installed"}
        if installed is None:
            return {
                **entry,
                "verdict": "unreachable",
                "reason": "ollama could not be asked what is installed",
            }
    return {**entry, "verdict": "runnable", "reason": None}


async def standby(
    app, pool, fit_context, latest_probes, tags: set[str] | None
) -> tuple[dict, str, str] | None:
    """(row, model, why) — the local model to fall to when a chain has no
    runnable link and names no local model: the bundled ollama's default
    if installed, else the best-fitting installed curated pick (curated
    order, first that is not wont_fit), else the first installed tag."""
    if not tags:
        return None
    builtin = await providers.get_row(pool, "ollama")
    default = builtin.get("default_model")
    if default and _installed(tags, default):
        return builtin, default, f"the bundled ollama's default model {default}"
    curated = curated_mod.load_curated()
    ctx = await fit_context(app, pool)
    probes = await latest_probes(pool, [e["slug"] for e in curated])
    for entry in curated:
        slug = entry["slug"]
        if not _installed(tags, slug):
            continue
        needed_gb, source = fit_mod.needed_gb_for(entry, probes.get(slug))
        verdict = fit_mod.compute_fit(
            needed_gb, ctx["free_gb"], ctx["total_gb"], source=source, reason=ctx["reason"]
        )
        if verdict.get("verdict") != "wont_fit":
            return (
                builtin,
                slug,
                f"the best-fitting installed curated pick {slug} ({verdict.get('verdict')})",
            )
    first = sorted(tags)[0]
    return builtin, first, f"the first installed local model {first}"


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
) -> Decision:
    """The link that serves this call, decided BEFORE any provider is
    called. `skip` names links already refused in this request (the
    in-request fallback after a live refusal)."""
    validate_role(role)
    rows = await providers.list_rows(pool)
    by_name = {r["name"]: r for r in rows}
    all_chains = await chains(pool)
    chain = list(all_chains.get(role) or [])
    if not chain and role != "chat":
        chain = list(all_chains.get("chat") or [])
    if requested:
        # The explicit pick is link 1; the chain holds the fallbacks.
        chain = [requested] + [c for c in chain if c != requested]
    if not chain:
        # No pick and no chain: today's rule — the default provider's model.
        default = await providers.default_row(pool)
        model = default.get("default_model") or ""
        return Decision(
            row=default,
            model=model,
            link=1,
            reason=None,
            role=role,
            verdicts=[
                {
                    "id": f"{default['name']}:{model}",
                    "verdict": "runnable",
                    "reason": "no chain; the default provider's model",
                }
            ],
        )
    walled = await walls(pool)
    tags = await installed_tags(app, pool)
    verdicts: list[dict] = []
    has_local = False
    for index, link in enumerate(chain, 1):
        verdict = await judge_link(app, pool, link, by_name, walled, timezone, tags)
        verdict["link"] = index
        if skip and link in skip:
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
        fallback = await standby(app, pool, fit_context, latest_probes, tags)
        if fallback is not None:
            row, model, why = fallback
            skipped = "; ".join(f"{v['id']}: {v['reason']}" for v in verdicts)
            verdicts.append(
                {
                    "id": f"{row['name']}:{model}",
                    "provider": row["name"],
                    "model": model,
                    "local": True,
                    "verdict": "runnable",
                    "reason": f"standby: {why}",
                    "link": len(verdicts) + 1,
                }
            )
            return Decision(
                row=row,
                model=model,
                link=len(verdicts),
                reason=f"fell back to local standby {row['name']}:{model} ({why}) — {skipped}",
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


def clear_tags_cache() -> None:
    TAGS_CACHE.clear()


__all__ = ["BUILTIN_ROLES", "RESERVED_ROLES", "Decision", "NothingRunnable", "resolve", "explain"]
_ = time  # noqa: F841 — kept for callers that time the walk
