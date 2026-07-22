"""Curated model table — the knowledge behind model recommendations.

Seeded by migration 018, editable by the operator (edit mode; system rows
toggle-only, like rules/tools). Probe results are stamped onto rows so
"verified on your hardware" survives restarts.
"""

import json
import logging

from app import db

log = logging.getLogger(__name__)

_FIELDS = ("id", "model", "provider", "min_ram_gb", "min_vram_gb", "tool_tier",
           "speed", "roles", "notes", "is_system", "enabled", "last_probe",
           "probed_at", "created_at")
_EDIT_FIELDS = {"min_ram_gb", "min_vram_gb", "tool_tier", "speed", "roles", "notes"}
_TIERS = ("A", "B", "C")
_SPEEDS = ("fast", "medium", "slow")
_ROLES = ("chat", "tools", "guard", "compaction", "voice", "ingestion")


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    d["roles"] = list(d["roles"] or [])
    if isinstance(d["last_probe"], str):
        d["last_probe"] = json.loads(d["last_probe"])
    for k in ("probed_at", "created_at"):
        d[k] = str(d[k]) if d[k] else None
    return d


def _validate(fields: dict):
    if "tool_tier" in fields and fields["tool_tier"] not in _TIERS:
        raise ValueError(f"tool_tier must be one of {_TIERS}")
    if "speed" in fields and fields["speed"] not in _SPEEDS:
        raise ValueError(f"speed must be one of {_SPEEDS}")
    if "roles" in fields:
        if not isinstance(fields["roles"], list) or \
                any(r not in _ROLES for r in fields["roles"]):
            raise ValueError(f"roles must be a list drawn from {_ROLES}")
    for k in ("min_ram_gb", "min_vram_gb"):
        if k in fields and fields[k] is not None and (
                not isinstance(fields[k], int) or fields[k] < 0):
            raise ValueError(f"{k} must be a non-negative integer or null")


async def list_all(enabled_only: bool = False) -> list[dict]:
    q = "SELECT * FROM curated_models"
    if enabled_only:
        q += " WHERE enabled = true"
    q += " ORDER BY provider, min_ram_gb NULLS LAST, model"
    async with db.acquire() as conn:
        rows = await conn.fetch(q)
    return [_row(r) for r in rows]


async def create(model: str, provider: str, **fields) -> dict:
    model = model.strip()
    if ":" not in model:
        raise ValueError("model must be 'openrouter:<id>' or 'ollama:<name>'")
    if provider not in ("ollama", "openrouter"):
        raise ValueError("provider must be 'ollama' or 'openrouter'")
    fields = {k: v for k, v in fields.items() if k in _EDIT_FIELDS}
    _validate(fields)
    cols = ["model", "provider"] + list(fields)
    vals = [model, provider] + list(fields.values())
    placeholders = ", ".join(f"${i + 1}" for i in range(len(vals)))
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            f"INSERT INTO curated_models ({', '.join(cols)}) "
            f"VALUES ({placeholders}) RETURNING *", *vals)
    return _row(r)


async def update(row_id: str, **fields) -> str:
    """Returns 'updated' | 'not_found' | 'is_system'. System rows accept only
    'enabled' — curation seeds are knowledge, toggle them off rather than
    rewrite them in place."""
    async with db.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT is_system FROM curated_models WHERE id = $1::uuid", row_id)
        if not existing:
            return "not_found"
        allowed = _EDIT_FIELDS | {"enabled"}
        if existing["is_system"]:
            allowed = {"enabled"}
        fields = {k: v for k, v in fields.items() if k in allowed}
        if not fields:
            return "is_system" if existing["is_system"] else "not_found"
        _validate(fields)
        sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
        await conn.execute(
            f"UPDATE curated_models SET {sets}, updated_at = now() "
            f"WHERE id = $1::uuid", row_id, *fields.values())
    return "updated"


async def delete(row_id: str) -> str:
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "SELECT is_system FROM curated_models WHERE id = $1::uuid", row_id)
        if not r:
            return "not_found"
        if r["is_system"]:
            return "is_system"
        await conn.execute("DELETE FROM curated_models WHERE id = $1::uuid", row_id)
    return "deleted"


async def stamp_probe(model: str, result: dict):
    """Attach the latest probe result to the curated row, if one exists."""
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE curated_models SET last_probe = $2, probed_at = now(), "
            "updated_at = now() WHERE model = $1",
            model, json.dumps(result))
