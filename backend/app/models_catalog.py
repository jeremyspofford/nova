"""Available-models catalog — feeds model dropdowns in the UI.

Combines installed Ollama models (local truth) with the catalog of every
configured provider in the registry (`llm/providers.py`). Cached 5 minutes;
each source fails soft so an offline local-only user still gets their Ollama
list.
"""

import logging
import time

import httpx

from app import bg, settings_store

log = logging.getLogger(__name__)

_CACHE_TTL = 300
_cache: dict = {"at": 0.0, "models": []}


async def _ollama_models() -> list[dict]:
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{base}/api/tags")
            resp.raise_for_status()
        return [{"id": f"ollama:{m['name']}", "provider": "ollama",
                 "name": m["name"]}
                for m in resp.json().get("models", [])]
    except Exception as e:
        log.warning("ollama model list unavailable: %s", e)
        return []


def _price_per_million(v) -> float | None:
    """OpenAI-compat pricing is per-token as a string; show it per-million."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f * 1_000_000, 2) if f > 0 else None


def _model_meta(m: dict) -> dict:
    """The provider's OWN 'what is this good for' facts, when it supplies them.

    This is the honest source for catalog models we have no curated row for:
    the provider's description, context window, input modalities (vision), and
    price — surfaced verbatim, never invented. Providers whose /models endpoint
    returns only ids (most OpenAI-compat servers) yield an empty dict. OpenRouter
    is the rich case.
    """
    meta: dict = {}
    desc = (m.get("description") or "").strip()
    if desc:
        meta["description"] = desc[:500]
    ctx = m.get("context_length") or (m.get("top_provider") or {}).get("context_length")
    if isinstance(ctx, int) and ctx > 0:
        meta["context_length"] = ctx
    arch = m.get("architecture") or {}
    mods = arch.get("input_modalities") or []
    if "image" in mods or "image" in (arch.get("modality") or ""):
        meta["vision"] = True
    pricing = m.get("pricing") or {}
    pin = _price_per_million(pricing.get("prompt"))
    pout = _price_per_million(pricing.get("completion"))
    if pin is not None:
        meta["price_in"] = pin
    if pout is not None:
        meta["price_out"] = pout
    return meta


async def _provider_models() -> list[dict]:
    """Every configured registry provider's catalog, as `slug:id` entries.

    Auth gate per provider: an unconfigured provider (no key, or disabled)
    contributes nothing. One provider failing — offline, or no /models endpoint
    — never sinks the rest; it just logs and yields nothing. Providers with an
    empty catalog_path can't list, so the operator approves their models by id.
    Each entry carries whatever `_model_meta` the provider supplied (description,
    context window, vision, price) so the full-catalog browser can say what a
    model is good for, not just its name.
    """
    from app.llm import providers
    out: list[dict] = []
    for slug in sorted(providers.known_slugs()):
        row = providers.get(slug)
        if not row or not row["catalog_path"] or not providers.is_configured(slug):
            continue
        headers = dict(row["extra_headers"])
        key = providers.resolve_key(row)
        if key:
            headers["Authorization"] = f"Bearer {key}"
        url = f"{row['base_url'].rstrip('/')}{row['catalog_path']}"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
            models = [{"id": f"{slug}:{m['id']}", "provider": slug, "name": m["id"],
                       **_model_meta(m)}
                      for m in resp.json().get("data", []) if m.get("id")]
            models.sort(key=lambda m: m["name"])
            out.extend(models)
        except Exception as e:
            log.warning("provider '%s' model list unavailable: %s", slug, e)
    return out


def invalidate():
    _cache["at"] = 0.0


# ── id canonicalisation: THE one rule for every model-id write path ───────
#
# Born from a real failure (2026-08-07): asked for "the latest DeepSeek
# flash", Nova had no way to touch the curated table, so the operator
# inserted the row by hand and repointed `main` at it 21 seconds later.
#
# THE ID HE PASTED WAS FINE, and the first version of this comment said
# otherwise. 'openrouter:~deepseek/deepseek-v4-flash-latest' is a real
# OpenRouter id — one of eleven `~vendor/model-latest` FLOATING ALIASES the
# live catalog serves — and the de-tilded spelling of it does not exist.
# Checked against the running catalog, after asserting the opposite.
#
# What was actually wrong was smaller and more interesting: the row carried
# column defaults (tool_tier C, roles {}) rather than researched values, and
# two modules disagreed silently about the id — `model_chain` refused ANY '~'
# id from standby chains on the theory that the shape was untrustworthy,
# while the pin guard judged by catalog membership. That hardcoded shape test
# quietly barred every floating alias in the catalog, including the operator's
# own chat model, from ever backing anything up.
#
# One rule, applied wherever a model id is written (curated add, agents.model
# via the tool layer, the model.assign executor): the id must resolve against
# the LIVE provider catalog. A '~author/model' form whose canonical form is
# in the catalog is NORMALISED to it; anything a listable provider does not
# serve is REFUSED. Membership is the single truth — the same set the pin
# guard (model_recs) and the standby derivation (model_chain) read.

def canonical_form(model: str) -> str:
    """Strip the '~' prefix from each path segment of the id.

    NOT an artifact — see `resolve_id`. OpenRouter uses `~vendor/model-latest`
    for floating aliases and serves eleven of them. This is the de-tilded
    SPELLING, offered as a candidate when the tilde form is not listed; it is
    never assumed to be the more correct one.

    Pure and syntactic — it says what the id WOULD be, never whether it
    exists. Only `resolve_id` may promote the answer to a fact.
    """
    slug, sep, rest = model.partition(":")
    if not sep:
        return model
    rest = "/".join(p[1:] if p.startswith("~") else p
                    for p in rest.split("/"))
    return f"{slug}:{rest}"


async def resolve_id(model: str, *, strict: bool = True
                     ) -> tuple[str | None, str]:
    """Canonicalise a 'provider:id' against the live catalog.

    WHAT '~' ACTUALLY IS — corrected 2026-08-07 against the live catalog,
    because the first version of this module (and the report that prompted
    it) both had it wrong. `~author/model-latest` is NOT a profile-URL
    artifact pasted out of a search result. It is OpenRouter's own convention
    for a FLOATING ALIAS, and the live catalog serves eleven of them:
    `~anthropic/claude-fable-latest`, `~openai/gpt-latest`,
    `~google/gemini-pro-latest`, `~deepseek/deepseek-v4-flash-latest` and so
    on. The de-tilded spelling of that last one does not exist at all.

    This does not change the RULE — membership decides, so a '~' id the
    catalog lists is accepted and one it does not is refused — but it does
    change what the refusals should say, and it is why treating '~' as a
    shape to distrust (which `model_chain` did, and which cost every floating
    alias its place in the standby chain) was wrong rather than merely
    strict.

    `strict` governs ONE case: a listable provider whose catalog cannot be
    read right now. Strict refuses, because writing an id nothing checked is
    what this function exists to prevent. The OPERATOR's own path passes
    strict=False, and the reason is recovery: with strict everywhere, an
    OpenRouter outage would stop Jeremy changing his model — including
    changing it AWAY from the model that is failing. An escape hatch that
    depends on the thing being escaped is not an escape hatch. A model absent
    from a catalog that READ fine is still refused either way; only "I could
    not look" softens.

    Returns (canonical_id, why). canonical_id is None when the id cannot be
    used, and `why` then names exactly what was tried — the text is surfaced
    verbatim to whoever asked (tool result, 422 detail, blocked card).

    The rule, per provider class:
      * ollama — ids name models to pull, which the catalog only lists once
        installed; accepted as typed ('~' still refused: the artifact shape
        is never a local tag), verified later by pull/probe.
      * a provider that cannot list (no key, or no catalog endpoint) — a
        plain id is accepted UNVERIFIED and says so; a '~' form is refused,
        because nothing could ever confirm either spelling.
      * a listable provider — membership decides. In the catalog: accepted.
        '~' form whose canonical form is in the catalog: normalised. Absent,
        or the catalog unreadable right now: REFUSED, because writing an id
        nothing has checked is the exact failure this function exists for.
    """
    model = (model or "").strip()
    if ":" not in model:
        return None, ("model must be '<provider>:<id>', e.g. "
                      "'openrouter:deepseek/deepseek-v4-flash-latest' or "
                      "'ollama:qwen3:8b'")
    slug = model.split(":", 1)[0]
    canonical = canonical_form(model)

    if slug == "ollama":
        if canonical != model:
            return None, (f"'{model}' contains '~' — a hosted provider's "
                          f"floating-alias prefix, never a local model tag")
        return model, ("local model — existence is verified at pull/probe "
                       "time, not against a catalog")

    from app.llm import providers
    if slug not in providers.known_slugs():
        return None, (f"unknown provider '{slug}' — register it in Settings "
                      f"→ Models → Providers first")
    row = providers.get(slug) or {}
    if not row.get("catalog_path") or not providers.is_configured(slug):
        if canonical != model:
            return None, (f"'{model}' contains '~' — a floating-alias "
                          f"prefix — and provider '{slug}' cannot list its "
                          f"catalog to confirm any spelling. Use the exact "
                          f"API id.")
        return model, (f"provider '{slug}' cannot list its models (no key or "
                       f"no catalog endpoint) — id taken as given, UNVERIFIED")

    ids = {m["id"] for m in await list_models(full=True)
           if m.get("provider") == slug}
    if not ids:
        if not strict:
            return model, (f"could not read provider '{slug}'s catalog just "
                           f"now, so '{model}' is UNVERIFIED — accepted "
                           f"because you asked for it directly and you must "
                           f"be able to change models while a provider is "
                           f"down")
        return None, (f"could not read provider '{slug}'s catalog just now, "
                      f"so '{model}' cannot be verified — refusing rather "
                      f"than writing an id nothing has checked. Try again "
                      f"shortly.")
    if model in ids:
        return model, f"listed by '{slug}'"
    if canonical != model and canonical in ids:
        return canonical, (f"normalised '{model}' → '{canonical}' — the "
                           f"'~author/model' form is the provider's "
                           f"floating-alias prefix, and this catalog lists "
                           f"the id without it")
    tried = (f" (also tried '{canonical}')" if canonical != model else "")
    return None, (f"'{model}' is not served by '{slug}' ({len(ids)} models "
                  f"listed){tried}. Use list_models with full=true to find "
                  f"the exact id.")


# ── background pulls (only Ollama exposes a pull API; LM Studio / llama.cpp
#    / vLLM manage their own downloads — future named-endpoint backends will
#    surface as list-only) ─────────────────────────────────────────────────

_active_pulls: set[str] = set()


def active_pulls() -> list[str]:
    return sorted(_active_pulls)


async def start_pull(name: str) -> str:
    """Kick off a background Ollama pull. Returns a status string immediately."""

    if name in _active_pulls:
        return f"'{name}' is already being pulled."
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    _active_pulls.add(name)

    async def run():
        from app.memory.memory import memory
        try:
            last_status = ""
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", f"{base}/api/pull",
                                         json={"name": name}) as resp:
                    if resp.status_code != 200:
                        detail = (await resp.aread()).decode(errors="replace")[:200]
                        log.warning("model pull '%s' failed: %s", name, detail)
                        return
                    async for line in resp.aiter_lines():
                        if line.strip():
                            last_status = line
            if '"success"' in last_status:
                invalidate()
                log.info("model pull complete: %s", name)
                await memory.write(
                    f"Pulled new local model '{name}' — now available for agents.",
                    type="journal", source_type="tool")
            else:
                log.warning("model pull '%s' ended without success: %.200s",
                            name, last_status)
        except Exception:
            log.exception("model pull '%s' crashed", name)
        finally:
            _active_pulls.discard(name)

    bg.spawn(run(), name="model-pull")
    return (f"Pull of '{name}' started in the background. It will appear in "
            f"list_models when complete (check back in a bit — larger models "
            f"take minutes).")


async def list_models(force: bool = False, full: bool = False) -> list[dict]:
    """The models this install can actually use.

    Default (filtered) view = what dropdowns should offer: models INSTALLED
    on running local backends + cloud models the operator has approved (the
    enabled curated rows). full=True = everything served by authenticated
    providers — the validity universe for the pin guard and for operators
    who ask to see the whole catalog. Either way, unauthenticated providers
    contribute nothing.
    """
    if not force and time.monotonic() - _cache["at"] < _CACHE_TTL and _cache["models"]:
        models = _cache["models"]
    else:
        ollama = await _ollama_models()
        provider_models = await _provider_models()
        models = ollama + provider_models
        if models:
            _cache.update(at=time.monotonic(), models=models)
    if full:
        return models
    from app import curated_models
    curated = await curated_models.list_all(enabled_only=True)
    approved_cloud = {r["model"] for r in curated if r["provider"] != "ollama"}
    return [m for m in models
            if m["provider"] == "ollama" or m["id"] in approved_cloud]
