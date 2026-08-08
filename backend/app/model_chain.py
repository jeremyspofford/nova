"""Where an agent's turn can go when its model will not answer.

The chain used to be three links and every one of them could be on the same
tier. For `main` — the agent every chat turn uses — that meant:

    ollama:ornith:9b  ->  (no per-agent standby)  ->  ollama:qwen3:8b
                                                  ->  ollama:ornith:9b (seen)

all local. So when ollama itself is unreachable, `_fallback_target` correctly
refuses every remaining link as "on the local server that could not be
reached", returns None, and the turn dies — with capable cloud models
configured and idle. That is the exact inverse of the 2026-07-28 incident the
feature is named after, where the OpenRouter budget lapsed and Nova stopped
answering with four local models installed.

This module adds a fourth, DERIVED link: whatever tier the agent is not on.
It is deliberately last, below both operator choices, and it recomputes every
turn from live state — the curated catalogue, provider health, and what ollama
actually has installed. Nothing here is a maintained list of model names, so
registering a provider or pulling a model changes the answer with no edit.

It short-circuits when the chain already crosses tiers, which is the common
case: the eleven cloud-primary agents already reach a local standby through
the install-wide setting, so they never pay for the probe.
"""

from __future__ import annotations

import logging
from typing import Optional

from app import settings_store
from app.llm import providers
from app.llm import router as llm_router

log = logging.getLogger(__name__)

LINK_AGENT = "agent"
LINK_INSTALL = "install"
LINK_MAIN = "main"
LINK_CROSS = "cross_tier"

MAIN_AGENT = "main"

# Tool support ranking from the curated catalogue. C means "no usable tool
# calling" — offering it to an agent that holds tools produces the confident
# answer-having-called-nothing that capability_claims.py exists to catch.
_TIER_RANK = {"A": 0, "B": 1, "C": 2}


def needs_tools(agent: dict) -> bool:
    """Whether this agent's job requires tool calling.

    Same expression `_fit_for` passes to model_fitness (runner.py), lifted so
    the derivation and the fitness gate cannot disagree: allowed_tools=None
    means unrestricted, which is every tool, not none.
    """
    grants = agent.get("allowed_tools")
    return grants is None or bool(grants)


def standby_setting() -> str:
    """The install-wide standby, provider-qualified.

    "qwen2.5:3b" already contains a colon — its TAG separator, not a provider
    prefix. Testing for ":" read it as fully qualified and handed back a bare
    name, which only worked because effective_model then failed to resolve
    "qwen2.5" as a provider and fell back a second time. This setting names a
    local model by definition, so the prefix is not a guess.
    """
    name = str(settings_store.get("inference.local_fallback_model") or "").strip()
    if not name:
        return ""
    return name if name.startswith("ollama:") else f"ollama:{name}"


def _usable_cloud(row: dict, want_tools: bool,
                  catalog_ids: Optional[set] = None) -> bool:
    """Is this curated row something we could actually route a turn to?

    `catalog_ids` is the full live catalog (models_catalog), and membership
    in it is THE validity truth — the same set the pin guard in model_recs
    judges `current_valid` by. This used to be a hardcoded `"~" in model`
    refusal, which disagreed silently with that guard: two modules answering
    "does this id resolve?" from different evidence. Now the write paths
    refuse or normalise unresolvable ids (models_catalog.resolve_id) and this
    reads the same catalog they checked against.

    Membership is judged PER SLUG: it only decides for a provider that
    contributed at least one catalog entry. This runs while a turn is
    already failing, and the realistic outage is PARTIAL — a cloud
    provider's /models fetch times out (models_catalog logs and yields
    nothing for it) while ollama's /api/tags answers, so the set arrives
    non-empty but cloud-blind. Judging such a row by global membership
    would refuse every cloud standby because a catalog fetch failed —
    recreating the outage the chain exists to survive. For any slug with
    zero entries (or when the whole catalog is None/empty), membership is
    unknowable and only the one id shape KNOWN to be a paste artifact
    ('~author/model', the 2026-08-07 incident) is still refused: a standby
    that 404s is worse than no standby, it consumes the last link and the
    turn still dies.
    """
    model = str(row.get("model") or "")
    slug = model.split(":", 1)[0]
    if not model or slug == "ollama":
        return False
    if catalog_ids and any(i.split(":", 1)[0] == slug for i in catalog_ids):
        if model not in catalog_ids:
            return False
    elif "~" in model:
        return False
    if not providers.is_configured(slug):
        return False
    row_p = providers.get(slug) or {}
    if row_p.get("last_ok") is False:      # NULL = never checked, allow it
        return False
    tier = str(row.get("tool_tier") or "")
    roles = set(row.get("roles") or ())
    if want_tools and (tier == "C" or not roles):
        return False
    # An empty roles set is an operator row nobody has classified; chat/tools
    # is the minimum claim that this model can hold a turn at all.
    return bool(roles & {"chat", "tools"})


async def cross_tier_standby(agent: dict, *, curated=None,
                             local_rank=None) -> Optional[str]:
    """A model on the tier this agent is NOT on, or None.

    Wrapped so it can never raise: this runs while a turn is already failing,
    and a derivation that crashes the failure path is worse than no link.
    """
    try:
        want_tools = needs_tools(agent)
        if llm_router.is_local(llm_router.effective_model(agent.get("model") or "")):
            rows = curated if curated is not None else await _curated()
            ids = await _catalog_ids()
            usable = [r for r in rows if _usable_cloud(r, want_tools, ids)]
            if not usable:
                return None
            usable.sort(key=lambda r: (
                _TIER_RANK.get(str(r.get("tool_tier") or ""), 9),
                0 if r.get("is_system") else 1,          # curated before ad-hoc
                str(r.get("model") or ""),               # deterministic
            ))
            return str(usable[0]["model"])

        ranked = local_rank if local_rank is not None else await _rank_local()
        for m in ranked:
            if want_tools and "tools" not in (m.get("capabilities") or []):
                continue
            return str(m["model"])
        return None
    except Exception:  # noqa: BLE001 — never crash a turn that is already failing
        # WARNING, not debug: this only runs when nothing else in the chain
        # crosses the tier, so losing it means the agent is back to dying with
        # its own tier. A silent None here looks identical to "no cross-tier
        # model exists", which is the one thing an operator must be able to
        # tell apart.
        log.warning("cross-tier standby derivation failed for %s; this agent "
                    "has no link off its own tier", agent.get("name"),
                    exc_info=True)
        return None


async def _curated():
    from app import curated_models
    return await curated_models.list_all(enabled_only=True)


async def _catalog_ids() -> Optional[set]:
    """The full live catalog's ids, or None when nothing could be read.

    None and empty are the same fact here — "membership is unknowable right
    now" — and so, per slug, is a non-empty set with no entries for a row's
    provider (`_usable_cloud` reads absence of a SLUG as "that provider's
    catalog was unreadable", not "it serves nothing"); in each case it
    degrades to refusing only the known paste-artifact shape. Module-level
    so tests inject it the way they inject `_curated`; cached upstream
    (models_catalog, 5 min), so the failing-turn path pays one dict
    comprehension, not a fetch per row.
    """
    try:
        from app import models_catalog
        models = await models_catalog.list_models(full=True)
    except Exception:  # noqa: BLE001 — this runs on a turn already failing
        log.warning("catalog unavailable while deriving a standby; falling "
                    "back to the '~'-shape refusal", exc_info=True)
        return None
    return {m["id"] for m in models} or None


async def _rank_local():
    from app import model_fitness
    return await model_fitness.rank_local()


async def chain(agent: dict, *, curated=None, local_rank=None) -> list[dict]:
    """This agent's standby order: [{model, source, why}], best first."""
    own = llm_router.effective_model(agent.get("model") or "")
    out: list[dict] = []
    seen = {own} if own else set()

    def add(model: str, source: str, why: str) -> None:
        if not model:
            return
        target = llm_router.effective_model(model)
        if not target or target in seen:
            return
        seen.add(target)
        out.append({"model": target, "source": source, "why": why})

    add(str(agent.get("fallback_model") or "").strip(), LINK_AGENT,
        "the standby you set on this agent")
    add(standby_setting(), LINK_INSTALL,
        "the install-wide standby (Settings -> Inference)")
    try:
        from app.agents import registry as agent_registry
        main = await agent_registry.get_agent_by_name(MAIN_AGENT)
        if main and main.get("model"):
            add(main["model"], LINK_MAIN, "the main agent's model")
    except Exception:
        # the last resort is the least important link; losing it must not
        # cost the operator the two they configured deliberately
        log.exception("main-agent lookup failed; standby chain is short")

    # Only probe when nothing so far crosses the tier. The eleven cloud-primary
    # agents already reach a local standby through the install setting, so this
    # costs them nothing.
    own_local = llm_router.is_local(own)
    if not any(llm_router.is_local(link["model"]) != own_local for link in out):
        derived = await cross_tier_standby(agent, curated=curated,
                                           local_rank=local_rank)
        if derived:
            add(derived, LINK_CROSS,
                "derived so this agent survives its whole tier going down. "
                "Picked for tool support and provider health, then "
                "deterministically — not for cost or quality. Set a standby "
                "on the agent to override it.")
    return out
