"""LLM provider registry — the set of model backends Nova can reach.

One row per provider (OpenAI, Anthropic, a local vLLM box, …); the model-id
prefix `slug:model` selects it. Everything downstream — the model router
(`llm/router.py`), the catalog (`models_catalog.py`), curated-model validation,
and the recommendations engine — reads this registry instead of hardcoding a
fixed provider pair.

Cached in-process (mirrors `settings_store`) so `_resolve()` / `effective_model()`
stay synchronous. `warm()` at startup (after migrations); re-warmed on every write.

'ollama' is NOT a row here — it's the built-in local provider with its own pull
API and URL setting (Settings → Inference), handled specially by the router and
catalog. This registry is for OpenAI-compatible HTTP endpoints, which is every
mainstream provider today: OpenAI, Groq, Together, DeepSeek, Mistral, xAI,
HuggingFace, LM Studio, vLLM, llama.cpp — and Anthropic & Gemini through their
OpenAI-compatibility endpoints. `kind` is 'openai_compat' for all of them in v1;
it exists so native adapters can be added later without a schema change.
"""

import json
import logging
import re

from app import db
from app.config import settings

log = logging.getLogger(__name__)

_FIELDS = ("id", "slug", "label", "kind", "base_url", "api_key",
           "extra_headers", "catalog_path", "needs_key", "enabled",
           "is_system", "last_checked_at", "last_seen_at", "last_ok",
           "last_error", "created_at", "updated_at")
# slug is immutable (it's the model-id prefix; changing it orphans assignments)
_EDIT_FIELDS = {"label", "kind", "base_url", "api_key", "extra_headers",
                "catalog_path", "needs_key", "enabled"}
_KINDS = ("openai_compat",)
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

_cache: dict[str, dict] = {}  # slug -> full row (incl. api_key)


# ── known-provider presets: prefill the "add provider" form. All are
#    OpenAI-compatible, so they share the one client; the operator just picks
#    one and pastes a key (local servers need none). ────────────────────────
PRESETS: list[dict] = [
    {"slug": "openai", "label": "OpenAI",
     "base_url": "https://api.openai.com/v1", "needs_key": True},
    {"slug": "anthropic", "label": "Anthropic (Claude)",
     "base_url": "https://api.anthropic.com/v1", "needs_key": True},
    {"slug": "gemini", "label": "Google Gemini",
     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
     "needs_key": True},
    {"slug": "groq", "label": "Groq",
     "base_url": "https://api.groq.com/openai/v1", "needs_key": True},
    {"slug": "together", "label": "Together AI",
     "base_url": "https://api.together.xyz/v1", "needs_key": True},
    {"slug": "deepseek", "label": "DeepSeek",
     "base_url": "https://api.deepseek.com/v1", "needs_key": True},
    {"slug": "mistral", "label": "Mistral",
     "base_url": "https://api.mistral.ai/v1", "needs_key": True},
    {"slug": "xai", "label": "xAI (Grok)",
     "base_url": "https://api.x.ai/v1", "needs_key": True},
    {"slug": "huggingface", "label": "HuggingFace",
     "base_url": "https://router.huggingface.co/v1", "needs_key": True},
    {"slug": "lmstudio", "label": "LM Studio (local)",
     "base_url": "http://host.docker.internal:1234/v1", "needs_key": False},
    {"slug": "vllm", "label": "vLLM (local)",
     "base_url": "http://host.docker.internal:8000/v1", "needs_key": False},
    {"slug": "custom", "label": "Custom (OpenAI-compatible)",
     "base_url": "", "needs_key": True},
]


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    if isinstance(d["extra_headers"], str):
        d["extra_headers"] = json.loads(d["extra_headers"])
    d["extra_headers"] = d["extra_headers"] or {}
    for k in ("created_at", "updated_at", "last_checked_at", "last_seen_at"):
        d[k] = str(d[k]) if d[k] else None
    return d


async def warm():
    """Load all providers into the cache. Startup (after migrations) + on write."""
    global _cache
    async with db.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM llm_providers")
    _cache = {r["slug"]: _row(r) for r in rows}
    # a provider change alters the catalog's source list — drop its cache so
    # newly added / re-keyed providers surface on the next dropdown fetch
    from app import models_catalog
    models_catalog.invalidate()
    log.info("Providers warmed: %d", len(_cache))


# ── read side (sync, off the cache — safe for the router's hot path) ────────

def get(slug: str) -> dict | None:
    """Full cached row (incl. key) for the router."""
    return _cache.get(slug)


def get_by_id(provider_id: str) -> dict | None:
    return next((r for r in _cache.values() if r["id"] == provider_id), None)


def known_slugs() -> set[str]:
    return set(_cache)


def resolve_key(row: dict) -> str:
    """The API key to send. The stored key, or for OpenRouter the
    OPENROUTER_API_KEY env fallback (so existing .env installs keep working).
    The .env placeholder counts as no key."""
    key = (row.get("api_key") or "").strip()
    if not key and row["slug"] == "openrouter":
        key = (settings.openrouter_api_key or "").strip()
    if key.startswith("sk-or-v1-your"):  # the .env placeholder
        return ""
    return key


def is_configured(slug: str) -> bool:
    """Usable right now: enabled, and either has a key or doesn't need one
    (local servers like LM Studio / vLLM)."""
    row = get(slug)
    if not row or not row["enabled"]:
        return False
    return bool(resolve_key(row)) or not row["needs_key"]


def _public(row: dict) -> dict:
    """Redacted shape for the API — the key never leaves the server."""
    key = row.get("api_key") or ""
    d = {k: row[k] for k in _FIELDS if k != "api_key"}
    d["key_set"] = bool(key)
    d["key_hint"] = key[-4:] if len(key) >= 4 else ""
    d["configured"] = is_configured(row["slug"])
    return d


def list_public() -> list[dict]:
    return [_public(_cache[s]) for s in sorted(_cache)]


# ── write side ──────────────────────────────────────────────────────────────

def _validate(fields: dict, *, creating: bool):
    if "kind" in fields and fields["kind"] not in _KINDS:
        raise ValueError(f"kind must be one of {_KINDS}")
    if "extra_headers" in fields and not isinstance(fields["extra_headers"], dict):
        raise ValueError("extra_headers must be an object")
    for k in ("needs_key", "enabled"):
        if k in fields and not isinstance(fields[k], bool):
            raise ValueError(f"{k} must be true/false")
    if creating and not str(fields.get("base_url", "")).strip():
        raise ValueError("base_url is required")


async def create(slug: str, label: str, base_url: str, **fields) -> dict:
    slug = (slug or "").strip().lower()
    if not _SLUG_RE.match(slug):
        raise ValueError("slug must be lowercase letters, digits, or hyphens")
    if slug == "ollama":
        raise ValueError("'ollama' is the built-in local provider — pick another slug")
    if slug in _cache:
        raise ValueError(f"provider '{slug}' already exists")
    data = {k: v for k, v in fields.items() if k in _EDIT_FIELDS}
    data["slug"] = slug
    data["label"] = (label or slug).strip()
    data["base_url"] = (base_url or "").strip()
    _validate(data, creating=True)
    if "extra_headers" in data:
        data["extra_headers"] = json.dumps(data["extra_headers"])
    cols = list(data)
    vals = list(data.values())
    placeholders = ", ".join(f"${i + 1}" for i in range(len(vals)))
    async with db.acquire() as conn:
        await conn.execute(
            f"INSERT INTO llm_providers ({', '.join(cols)}) "
            f"VALUES ({placeholders})", *vals)
    await warm()
    if is_configured(slug):  # stamp an immediate reachability dot
        await check(get(slug)["id"])
    return _public(get(slug))


async def update(provider_id: str, **fields) -> str:
    """Returns 'updated' | 'not_found' | 'no_fields'. slug is immutable."""
    async with db.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT slug FROM llm_providers WHERE id = $1::uuid", provider_id)
        if not existing:
            return "not_found"
        data = {k: v for k, v in fields.items() if k in _EDIT_FIELDS}
        if not data:
            return "no_fields"
        _validate(data, creating=False)
        if "extra_headers" in data:
            data["extra_headers"] = json.dumps(data["extra_headers"])
        sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(data))
        await conn.execute(
            f"UPDATE llm_providers SET {sets}, updated_at = now() "
            f"WHERE id = $1::uuid", provider_id, *data.values())
    await warm()
    row = get_by_id(provider_id)  # re-check reachability after an edit
    if row and is_configured(row["slug"]):
        await check(provider_id)
    return "updated"


async def delete(provider_id: str) -> str:
    """Returns 'deleted' | 'not_found' | 'is_system'. Seeded rows (OpenRouter)
    can be edited/disabled but not deleted."""
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "SELECT is_system FROM llm_providers WHERE id = $1::uuid", provider_id)
        if not r:
            return "not_found"
        if r["is_system"]:
            return "is_system"
        await conn.execute("DELETE FROM llm_providers WHERE id = $1::uuid", provider_id)
    await warm()
    return "deleted"


# ── reachability: an on-save check + a 60s background loop stamp last_ok /
#    last_error onto each configured provider, so the Providers panel shows a
#    live green/red dot with the WHY (operator-visible-outcomes rule). ───────

async def _approved_model(slug: str) -> str | None:
    """A model id (minus the `slug:` prefix) the operator has already approved
    for this provider — the fallback health check needs a real model name."""
    from app import curated_models
    prefix = f"{slug}:"
    for r in await curated_models.list_all(enabled_only=True):
        if r["provider"] == slug and r["model"].startswith(prefix):
            return r["model"].split(":", 1)[1]
    return None


async def _reach(row: dict) -> tuple[bool | None, str | None, int | None]:
    """Reachability probe. Returns (ok, error, model_count); ok is None when
    there's nothing to check yet ('unknown', not a failure). Short timeouts so
    a sleeping local server fails fast instead of hanging a save.

    Primary check is a cheap `GET /models`. Some providers — Anthropic most
    notably — don't serve /models to the same Bearer auth as chat, so a working
    provider would show a false red dot. When /models can't confirm, fall back
    to a 1-token completion against an already-approved model: that exercises
    the exact chat path Nova uses, so it's the real 'is this usable' answer."""
    import httpx
    key = resolve_key(row)
    if row["needs_key"] and not key:
        return False, "no API key set", None
    base = row["base_url"].rstrip("/")
    headers = dict(row["extra_headers"])
    if key:
        headers["Authorization"] = f"Bearer {key}"

    # 1) cheap path — list models
    models_err = "no model-list endpoint"
    if row["catalog_path"]:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(6.0, connect=3.0)) as client:
                resp = await client.get(f"{base}{row['catalog_path']}", headers=headers)
            if resp.status_code == 200:
                return True, None, len(resp.json().get("data", []))
            models_err = f"/models HTTP {resp.status_code}"
        except Exception as e:
            models_err = f"/models {e}"

    # 2) fallback — a 1-token completion against an approved model (real chat path)
    model = await _approved_model(row["slug"])
    if not model:
        return None, f"{models_err}; approve a model to enable the reachability check", None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=3.0)) as client:
            resp = await client.post(
                f"{base}/chat/completions", headers=headers,
                json={"model": model, "messages": [{"role": "user", "content": "hi"}],
                      "max_tokens": 1, "stream": False})
        if resp.status_code == 200:
            return True, None, None
        if resp.status_code in (401, 403):
            return False, f"auth rejected (HTTP {resp.status_code})", None
        return False, f"HTTP {resp.status_code}: {resp.text[:120]}", None
    except Exception as e:
        return False, str(e), None


async def stamp_health(provider_id: str, ok: bool, error: str | None):
    """Persist a reachability result and refresh just this row in the cache —
    no full warm(), so health polling never churns the model-catalog cache."""
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "UPDATE llm_providers SET last_checked_at = now(), last_ok = $2, "
            "last_error = $3, last_seen_at = CASE WHEN $2 THEN now() ELSE last_seen_at END "
            "WHERE id = $1::uuid RETURNING *", provider_id, ok, error)
    if r:
        _cache[r["slug"]] = _row(r)


async def check(provider_id: str) -> dict:
    """Reach the provider and stamp the result. Powers both the Test button and
    the background loop. {ok, error?, model_count?}."""
    row = get_by_id(provider_id)
    if not row:
        return {"ok": False, "error": "provider not found"}
    ok, error, count = await _reach(row)
    if ok is not None:
        await stamp_health(provider_id, ok, error)
    out: dict = {"ok": ok}
    if error:
        out["error"] = error
    if count is not None:
        out["model_count"] = count
    return out


async def check_all():
    """Stamp reachability for every configured provider — the 60s loop's body."""
    for row in list(_cache.values()):
        if not is_configured(row["slug"]) or not row["catalog_path"]:
            continue
        ok, error, _ = await _reach(row)
        if ok is not None:
            await stamp_health(row["id"], ok, error)


async def health_loop(interval: float = 60.0):
    """Background reachability poller — started from the app lifespan."""
    import asyncio
    while True:
        try:
            await check_all()
        except Exception:
            log.exception("provider health loop error")
        await asyncio.sleep(interval)
