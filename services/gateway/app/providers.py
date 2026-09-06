"""The provider registry: rows, resolution and the shapes the wire accepts.

A provider is DATA — a name, an adapter (wire protocol), a base URL, an auth
shape and a key. Nothing here knows a vendor; `providers_presets.json` is a
convenience that fills a form, never a gate. Model identity everywhere is
`provider:model`, split on the FIRST colon (a provider name can never
contain one — the CHECK on the table pins it), so an ollama tag like
`qwen3.8:27b` still reads as a bare model on the default provider.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

import asyncpg
from fastapi import HTTPException

ADAPTERS = ("ollama", "openai-chat", "anthropic-messages")
AUTH_SHAPES = ("none", "static-bearer", "api-key-header")
LISTING_STATES = ("available", "unavailable", "unknown")

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
PRESETS_PATH = Path(__file__).resolve().parent / "providers_presets.json"

_COLUMNS = (
    "name, adapter, base_url, auth_shape, api_key, default_model, model_note, preset, "
    "builtin, is_default, verified_at, listing, listing_note, created_at, updated_at"
)
_PUBLIC_FIELDS = (
    "name",
    "adapter",
    "base_url",
    "auth_shape",
    "api_key",
    "default_model",
    "model_note",
    "preset",
    "builtin",
    "is_default",
    "verified_at",
    "listing",
    "listing_note",
    "created_at",
    "updated_at",
)


class UnknownProvider(LookupError):
    """No row by that name."""


def mask_api_key(key: str | None) -> str | None:
    if not key:
        return None
    tail = key[-4:] if len(key) >= 4 else key
    return f"•••{tail}"


def to_public(row: dict) -> dict:
    """`row`, safe to return over the wire: the key is never unmasked, the
    builtin row reports the address it actually resolves to."""
    public = {field: row.get(field) for field in _PUBLIC_FIELDS}
    public["api_key"] = mask_api_key(row.get("api_key"))
    public["base_url"] = base_url_of(row)
    for stamp in ("verified_at", "created_at", "updated_at"):
        value = public.get(stamp)
        if value is not None and not isinstance(value, str):
            public[stamp] = value.isoformat()
    return public


def base_url_of(row: dict) -> str:
    """Where this provider's calls go.

    The builtin ollama row always resolves to the live OLLAMA_URL, never a
    stored column — the sidecar's address is a fact of this host's compose
    file (S1's rule, kept). Every other row is what the owner typed, with a
    trailing slash dropped so path joins are unambiguous.
    """
    if row["adapter"] == "ollama":
        return os.environ.get("OLLAMA_URL", "").rstrip("/")
    return (row.get("base_url") or "").rstrip("/")


def validate_name(name: object) -> str:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail=(
                "name must be a slug: lowercase letters, digits, '-' or '_', 1-64 chars, "
                f"starting with a letter or digit — got {name!r}"
            ),
        )
    return name


def validate_shape(payload: dict, *, existing: dict | None = None) -> dict:
    """The row a create/update would write, or a 400 with the stated reason.

    `existing` is the current row on an update: fields the payload omits keep
    their stored value (an update that omits `api_key` keeps the key, so the
    owner can change a URL without re-pasting the secret).
    """
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    merged = dict(existing or {})
    for field in ("adapter", "base_url", "auth_shape", "default_model", "model_note", "preset"):
        if field in payload:
            merged[field] = payload[field]
    if payload.get("api_key"):
        merged["api_key"] = payload["api_key"]
    adapter = merged.get("adapter")
    if adapter not in ADAPTERS:
        raise HTTPException(
            status_code=400,
            detail=f"adapter must be one of {', '.join(ADAPTERS)} — got {adapter!r}",
        )
    if adapter == "ollama" and not (existing or {}).get("builtin"):
        raise HTTPException(
            status_code=400,
            detail="the ollama adapter is the builtin row only — remote OpenAI-shaped "
            "servers (including another ollama's /v1) use adapter=openai-chat",
        )
    auth_shape = merged.get("auth_shape")
    if auth_shape not in AUTH_SHAPES:
        raise HTTPException(
            status_code=400,
            detail=f"auth_shape must be one of {', '.join(AUTH_SHAPES)} — got {auth_shape!r}",
        )
    if adapter == "anthropic-messages" and auth_shape != "api-key-header":
        raise HTTPException(
            status_code=400,
            detail="the anthropic-messages adapter authenticates with x-api-key — "
            "auth_shape must be api-key-header",
        )
    base_url = merged.get("base_url")
    if adapter != "ollama":
        if not isinstance(base_url, str) or not base_url.strip():
            raise HTTPException(status_code=400, detail="base_url is required")
        base_url = base_url.strip().rstrip("/")
        if not (base_url.startswith("http://") or base_url.startswith("https://")):
            raise HTTPException(
                status_code=400,
                detail=f"base_url must start with http:// or https:// — got {base_url!r}",
            )
        if "{" in base_url or "}" in base_url:
            raise HTTPException(
                status_code=400,
                detail=f"base_url still carries a placeholder to fill in — {base_url!r}",
            )
        if adapter == "anthropic-messages" and not urlsplit(base_url).path.strip("/"):
            # Every adapter's base URL includes the version path; a bare
            # origin for Anthropic means its one public version.
            base_url = f"{base_url}/v1"
        merged["base_url"] = base_url
    if auth_shape != "none" and not merged.get("api_key"):
        raise HTTPException(
            status_code=400, detail=f"api_key is required for auth_shape={auth_shape}"
        )
    if auth_shape == "none":
        merged["api_key"] = None
    for field in ("default_model", "model_note", "preset"):
        value = merged.get(field)
        if value is not None and not isinstance(value, str):
            raise HTTPException(status_code=400, detail=f"{field} must be a string")
        merged[field] = value or None
    return merged


def split_model_id(model: str, names: set[str]) -> tuple[str | None, str]:
    """(`provider` or None, `model`) for a wire model id.

    `names` is the LIVE set of registered provider names: a prefix that is
    one of them is a provider; anything else — including an ollama tag's own
    colon — leaves the whole string as the model for the default provider.
    """
    prefix, colon, rest = model.partition(":")
    if colon and prefix in names:
        # `openrouter:` names a provider and no model — returned as-is so the
        # caller refuses it; it must never fall through to another provider.
        return prefix, rest
    return None, model


def served_by(row: dict, model: str) -> str:
    return f"{row['name']}:{model}"


async def list_rows(pool: asyncpg.Pool) -> list[dict]:
    rows = await pool.fetch(f"SELECT {_COLUMNS} FROM providers ORDER BY builtin DESC, name")
    return [dict(row) for row in rows]


async def get_row(pool: asyncpg.Pool, name: str) -> dict:
    row = await pool.fetchrow(f"SELECT {_COLUMNS} FROM providers WHERE name = $1", name)
    if row is None:
        raise UnknownProvider(name)
    return dict(row)


async def default_row(pool: asyncpg.Pool) -> dict:
    """The default provider — self-healing: if the builtin row was somehow
    lost (or startup's seed never ran), it is recreated rather than
    surfacing a bug that looks like a missing backend."""
    row = await pool.fetchrow(f"SELECT {_COLUMNS} FROM providers WHERE is_default")
    if row is None:
        await ensure_builtin(pool)
        row = await pool.fetchrow(f"SELECT {_COLUMNS} FROM providers WHERE is_default")
    return dict(row)


async def ensure_builtin(pool: asyncpg.Pool) -> None:
    """The startup seed: the bundled ollama row exists, and SOMETHING is the
    default. ON CONFLICT DO NOTHING, so this is a no-op every startup after
    the first."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO providers (name, adapter, base_url, auth_shape, builtin, is_default) "
                "VALUES ('ollama', 'ollama', '', 'none', true, "
                "NOT EXISTS (SELECT 1 FROM providers WHERE is_default)) "
                "ON CONFLICT (name) DO NOTHING"
            )
            await conn.execute(
                "UPDATE providers SET is_default = true WHERE name = 'ollama' "
                "AND NOT EXISTS (SELECT 1 FROM providers WHERE is_default)"
            )


async def resolve(pool: asyncpg.Pool, model: str | None) -> tuple[dict, str]:
    """(provider row, model) for a request's model id — see split_model_id.

    A request naming no model at all gets the default provider's own
    `default_model` (possibly empty: the provider is then asked for "" and
    answers with its own refusal, which is relayed — never a guess).
    """
    rows = await list_rows(pool)
    by_name = {row["name"]: row for row in rows}
    default = next((row for row in rows if row["is_default"]), None)
    if default is None:
        default = await default_row(pool)
        by_name[default["name"]] = default
    if not model:
        return default, default.get("default_model") or ""
    name, bare = split_model_id(model, set(by_name))
    if name is None:
        return default, bare
    if not bare:
        raise HTTPException(
            status_code=400,
            detail=f"model id {model!r} names provider {name!r} but no model — "
            f"write it as {name}:<model>",
        )
    return by_name[name], bare


async def insert_row(pool: asyncpg.Pool, name: str, shape: dict) -> dict:
    try:
        row = await pool.fetchrow(
            "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, "
            "default_model, model_note, preset, verified_at, listing, listing_note) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10) "
            f"RETURNING {_COLUMNS}",
            name,
            shape["adapter"],
            shape.get("base_url") or "",
            shape["auth_shape"],
            shape.get("api_key"),
            shape.get("default_model"),
            shape.get("model_note"),
            shape.get("preset"),
            shape.get("listing", "unknown"),
            shape.get("listing_note"),
        )
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(
            status_code=409, detail=f"a provider named {name!r} already exists"
        ) from exc
    return dict(row)


async def update_row(pool: asyncpg.Pool, name: str, shape: dict) -> dict:
    row = await pool.fetchrow(
        "UPDATE providers SET adapter = $2, base_url = $3, auth_shape = $4, api_key = $5, "
        "default_model = $6, model_note = $7, preset = $8, verified_at = now(), "
        "listing = $9, listing_note = $10, updated_at = now() "
        f"WHERE name = $1 RETURNING {_COLUMNS}",
        name,
        shape["adapter"],
        shape.get("base_url") or "",
        shape["auth_shape"],
        shape.get("api_key"),
        shape.get("default_model"),
        shape.get("model_note"),
        shape.get("preset"),
        shape.get("listing", "unknown"),
        shape.get("listing_note"),
    )
    if row is None:
        raise UnknownProvider(name)
    return dict(row)


async def set_default_model(pool: asyncpg.Pool, name: str, model: str | None) -> None:
    """The model a request naming none gets on this provider."""
    await pool.execute(
        "UPDATE providers SET default_model = $2, updated_at = now() WHERE name = $1",
        name,
        model or None,
    )


async def record_listing(pool: asyncpg.Pool, name: str, state: str, note: str | None) -> None:
    """What a live listing just learned, on the row — DERIVED state the UI
    reads, never something an owner maintains by hand."""
    await pool.execute(
        "UPDATE providers SET listing = $2, listing_note = $3, updated_at = now() WHERE name = $1",
        name,
        state,
        note,
    )


async def delete_row(pool: asyncpg.Pool, name: str) -> None:
    row = await get_row(pool, name)
    if row["builtin"]:
        raise HTTPException(
            status_code=400, detail="the bundled ollama provider cannot be deleted"
        )
    if row["is_default"]:
        raise HTTPException(
            status_code=409,
            detail=f"{name!r} is the default provider — make another provider the default first",
        )
    await pool.execute("DELETE FROM providers WHERE name = $1", name)


async def set_default(pool: asyncpg.Pool, name: str) -> dict:
    async with pool.acquire() as conn:
        async with conn.transaction():
            exists = await conn.fetchval("SELECT 1 FROM providers WHERE name = $1", name)
            if not exists:
                raise UnknownProvider(name)
            await conn.execute("UPDATE providers SET is_default = false WHERE is_default")
            await conn.execute("UPDATE providers SET is_default = true WHERE name = $1", name)
    return await get_row(pool, name)


def load_presets() -> list[dict]:
    """The well-known presets — a form-filler. A malformed file is a stated
    error, never an empty list that reads as "no presets exist"."""
    try:
        data = json.loads(PRESETS_PATH.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"providers_presets.json unreadable: {exc}") from exc
    if not isinstance(data, list):
        raise RuntimeError("providers_presets.json must be a JSON array")
    return data
