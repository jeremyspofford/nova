"""Resolves the single active backend and talks to it.

One row, one active backend (`kind` in ollama/remote/cloud) — S1 has no
routing intelligence, so everything in this module answers "what one URL
do we call, with what auth" and nothing more. Adding real routing (mode
switch, hybrid escalation) is explicitly later work per the slice plan.

Anthropic-native calls are also explicitly LATER work: S1's "cloud" kind
means any OpenAI-compatible endpoint reached at {url}/v1/..., not a
provider-specific adapter.
"""
from __future__ import annotations

import os

import asyncpg
import httpx
from fastapi import HTTPException

KINDS = ("ollama", "remote", "cloud")

_COLUMNS = "id, kind, url, provider, model, api_key, updated_at"


class VerificationFailed(RuntimeError):
    """The backend did not answer a liveness check — the reason is the message."""


def reason(exc: Exception) -> str:
    """A short, honest description of why an outbound call failed."""
    text = str(exc).strip()
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def http_client(
    app, timeout: httpx.Timeout, *, base_url: str, headers: dict[str, str] | None = None
) -> httpx.AsyncClient:
    """An httpx client for `base_url`.

    Mirrors core's peers.client(): tests mount a local ASGI fake on
    app.state.peer_transports keyed by base_url, so the exact client code
    under test (headers, streaming, error handling) runs against it with
    no socket anywhere. Nothing mounted means a real network transport.
    """
    transports = getattr(app.state, "peer_transports", {})
    return httpx.AsyncClient(
        base_url=base_url,
        timeout=timeout,
        transport=transports.get(base_url),
        headers=headers or {},
    )


def resolve_base_url(row: dict) -> str:
    """Where to send this backend's calls.

    ollama always resolves to the live OLLAMA_URL, never the stored
    column — the bundled sidecar's address is a fact of this host's
    compose file, not something a stale row should override.
    """
    if row["kind"] == "ollama":
        return os.environ.get("OLLAMA_URL", "").rstrip("/")
    return (row.get("url") or "").rstrip("/")


def auth_headers(row: dict) -> dict[str, str]:
    """Only cloud carries credentials — ollama and remote are unauthenticated
    in S1 (remote has no api_key column at all)."""
    if row["kind"] == "cloud" and row.get("api_key"):
        return {"Authorization": f"Bearer {row['api_key']}"}
    return {}


def mask_api_key(key: str | None) -> str | None:
    if not key:
        return None
    tail = key[-4:] if len(key) >= 4 else key
    return f"•••{tail}"


def to_public(row: dict) -> dict:
    """`row`, safe to return over the wire — the key is never unmasked."""
    public = dict(row)
    public["api_key"] = mask_api_key(public.get("api_key"))
    return public


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


async def verify_live(app, payload: dict) -> None:
    """Raises VerificationFailed with a stated reason if the backend named
    in `payload` cannot be reached right now.

    Called before saving, never after — a config that fails this check
    never lands (PUT /admin/backend's contract).
    """
    kind = payload["kind"]
    timeout = httpx.Timeout(5.0)
    headers: dict[str, str] = {}
    if kind == "ollama":
        url = os.environ.get("OLLAMA_URL", "").rstrip("/")
        if not url:
            raise VerificationFailed("OLLAMA_URL is unset — cannot verify the ollama backend")
        path = "/api/version"
    elif kind == "remote":
        url = payload["url"].rstrip("/")
        path = "/v1/models"
    else:
        url = payload["url"].rstrip("/")
        path = "/v1/models"
        headers = {"Authorization": f"Bearer {payload['api_key']}"}

    client = http_client(app, timeout, base_url=url, headers=headers)
    try:
        async with client as c:
            resp = await c.get(path)
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise VerificationFailed(
            f"could not verify the {kind} backend is live — {reason(exc)}"
        ) from exc


async def read_config(pool: asyncpg.Pool) -> dict:
    """The active backend row — self-healing: if startup's ensure_default_row
    never ran (or the row was somehow lost), this creates it rather than
    surfacing a bug that looks like a missing backend."""
    row = await pool.fetchrow(f"SELECT {_COLUMNS} FROM backend_config WHERE id = 1")
    if row is None:
        await ensure_default_row(pool)
        row = await pool.fetchrow(f"SELECT {_COLUMNS} FROM backend_config WHERE id = 1")
    return dict(row)


async def save_config(pool: asyncpg.Pool, payload: dict) -> dict:
    row = await pool.fetchrow(
        f"INSERT INTO backend_config (id, kind, url, provider, model, api_key, updated_at) "
        f"VALUES (1, $1, $2, $3, $4, $5, now()) "
        f"ON CONFLICT (id) DO UPDATE SET "
        f"kind = EXCLUDED.kind, url = EXCLUDED.url, provider = EXCLUDED.provider, "
        f"model = EXCLUDED.model, api_key = EXCLUDED.api_key, updated_at = now() "
        f"RETURNING {_COLUMNS}",
        payload["kind"],
        payload.get("url"),
        payload.get("provider"),
        payload.get("model"),
        payload.get("api_key"),
    )
    return dict(row)


async def ensure_default_row(pool: asyncpg.Pool) -> None:
    """The startup default: bundled ollama, at whatever OLLAMA_URL says.

    ON CONFLICT DO NOTHING, so this is a no-op every startup after an owner
    has chosen a backend through PUT /admin/backend.
    """
    await pool.execute(
        "INSERT INTO backend_config (id, kind, url) VALUES (1, 'ollama', $1) "
        "ON CONFLICT (id) DO NOTHING",
        os.environ.get("OLLAMA_URL", ""),
    )
