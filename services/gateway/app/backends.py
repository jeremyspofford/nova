"""The S1 "single backend" surface, kept as a VIEW over the provider registry.

`PUT /admin/backend` (the wizard's engine step) still takes S1's
{kind: ollama|remote|cloud, url, provider, model, api_key} and
`GET /admin/backend` still answers in that shape — but the truth underneath
is `providers` (S10-pre): the kind is DERIVED from the default provider's
row, and saving a kind upserts a provider row and makes it the default.
Nothing here is a second store. The names below are the ones admin.py and
the probe path call; the registry itself lives in app/providers.py.
"""
from __future__ import annotations

import asyncpg
from fastapi import HTTPException

from app import providers
from app.adapters import ProviderRefused, for_row, http_client, reason  # re-exported
from app.adapters.base import VerifyResult

KINDS = ("ollama", "remote", "cloud")


class VerificationFailed(RuntimeError):
    """The backend did not answer a liveness check — the reason is the message."""


mask_api_key = providers.mask_api_key


def kind_of(row: dict) -> str:
    """S1's kind, derived from the row: the builtin ollama is `ollama`; an
    OpenAI-shaped endpoint with no auth is `remote`; anything with a key is
    `cloud`."""
    if row["adapter"] == "ollama":
        return "ollama"
    if row.get("auth_shape") == "none":
        return "remote"
    return "cloud"


def _origin(base_url: str) -> str:
    """S1 stored the ORIGIN and appended `/v1` itself; registry base URLs
    include the version path. The legacy view hands back the origin so the
    wizard sees what it typed and the probe path's `{url}/v1/...` joins
    stay right."""
    url = base_url.rstrip("/")
    return url[: -len("/v1")] if url.endswith("/v1") else url


def legacy_view(row: dict) -> dict:
    """The default provider row in the S1 backend_config shape (unmasked —
    callers that go over the wire use to_public)."""
    return {
        "kind": kind_of(row),
        "url": _origin(providers.base_url_of(row)),
        "provider": None if row["adapter"] == "ollama" else row["name"],
        "model": row.get("default_model"),
        "api_key": row.get("api_key"),
        "adapter": row["adapter"],
        "name": row["name"],
        "updated_at": row.get("updated_at"),
    }


def to_public(view: dict) -> dict:
    public = dict(view)
    public["api_key"] = mask_api_key(public.get("api_key"))
    stamp = public.get("updated_at")
    if stamp is not None and not isinstance(stamp, str):
        public["updated_at"] = stamp.isoformat()
    return public


def resolve_base_url(view: dict) -> str:
    """Where the default backend's calls go — the ollama kind always resolves
    to the live OLLAMA_URL (never a stored column)."""
    if view["kind"] == "ollama":
        return providers.base_url_of({"adapter": "ollama"})
    return (view.get("url") or "").rstrip("/")


def auth_headers(view: dict) -> dict[str, str]:
    if view["kind"] == "cloud" and view.get("api_key"):
        return {"Authorization": f"Bearer {view['api_key']}"}
    return {}


def validate_shape(payload: dict) -> None:
    """400s with a stated reason; never silently coerces a bad shape."""
    kind = payload.get("kind")
    if kind not in KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"kind must be one of {', '.join(KINDS)} — got {kind!r}",
        )
    if kind in ("remote", "cloud") and not payload.get("url"):
        raise HTTPException(status_code=400, detail=f"url is required for kind={kind}")
    if kind == "cloud":
        if not payload.get("api_key"):
            raise HTTPException(status_code=400, detail="api_key is required for kind=cloud")
        if not payload.get("model"):
            raise HTTPException(status_code=400, detail="model is required for kind=cloud")


def _slug_for(payload: dict) -> str:
    kind = payload["kind"]
    if kind == "ollama":
        return "ollama"
    if kind == "remote":
        return "remote"
    raw = (payload.get("provider") or "cloud").strip().lower()
    slug = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in raw).strip("-_")
    if not slug or slug == "ollama" or not providers.NAME_RE.match(slug):
        slug = "cloud"
    return slug


def _row_for(payload: dict) -> dict:
    """The provider row an S1 payload describes. S1 URLs are the ORIGIN
    (`https://host`); registry base URLs include the version path, the
    OPENAI_BASE_URL convention — so `/v1` is appended, exactly as the
    migration did for the row it converted."""
    kind = payload["kind"]
    if kind == "ollama":
        return {"adapter": "ollama", "base_url": "", "auth_shape": "none", "name": "ollama"}
    url = payload["url"].rstrip("/")
    if not url.endswith("/v1"):
        url = f"{url}/v1"
    return {
        "name": _slug_for(payload),
        "adapter": "openai-chat",
        "base_url": url,
        "auth_shape": "static-bearer" if kind == "cloud" else "none",
        "api_key": payload.get("api_key") if kind == "cloud" else None,
        "default_model": payload.get("model"),
    }


async def verify_live(app, payload: dict) -> VerifyResult:
    """Raises VerificationFailed with a stated reason if the backend named
    in `payload` cannot be reached right now. Called before saving, never
    after — a config that fails this check never lands. Returns what was
    proven, so the wizard's save carries the same verdict a registry save
    does."""
    row = _row_for(payload)
    try:
        return await for_row(row).verify(app, row)
    except ProviderRefused as exc:
        raise VerificationFailed(
            f"could not verify the {payload['kind']} backend is live — {exc.detail}"
        ) from exc


async def read_config(pool: asyncpg.Pool) -> dict:
    """The active backend in S1's shape, derived from the default provider."""
    return legacy_view(await providers.default_row(pool))


async def save_config(
    pool: asyncpg.Pool, payload: dict, *, verdict: VerifyResult | None = None
) -> dict:
    """Upsert the provider row an S1 payload describes and make it the
    default. Returns the legacy view of what is now active. `verdict` is
    what verify_live proved; without one the row records that nothing was
    (key_proven NULL, no note) rather than a verdict it never had."""
    row = _row_for(payload)
    name = row["name"]
    if name == "ollama":
        await providers.ensure_builtin(pool)
        await providers.set_default_model(pool, "ollama", payload.get("model"))
    else:
        try:
            existing = await providers.get_row(pool, name)
        except providers.UnknownProvider:
            existing = None
        shape = providers.validate_shape(row, existing=existing)
        if verdict is not None:
            shape.update(
                listing=verdict.listing,
                listing_note=verdict.note,
                key_proven=verdict.key_proven,
                verify_note=verdict.note,
            )
        else:
            shape.update(key_proven=None, verify_note=None)
        if existing is None:
            await providers.insert_row(pool, name, shape)
        else:
            await providers.update_row(pool, name, shape)
    active = await providers.set_default(pool, name)
    return legacy_view(active)


async def ensure_default_row(pool: asyncpg.Pool) -> None:
    """The startup seed, S1's name kept: the bundled ollama row exists and
    something is the default."""
    await providers.ensure_builtin(pool)


__all__ = [
    "KINDS",
    "VerificationFailed",
    "auth_headers",
    "ensure_default_row",
    "http_client",
    "kind_of",
    "legacy_view",
    "mask_api_key",
    "read_config",
    "reason",
    "resolve_base_url",
    "save_config",
    "to_public",
    "validate_shape",
    "verify_live",
]
