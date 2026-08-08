"""Curated model table — the knowledge behind model recommendations.

Seeded by migration 018; edited by the operator (Settings → Models) and by
the model-manager through `manage_curated_models` (system rows toggle-only,
like rules/tools). Probe results are stamped onto rows so "verified on your
hardware" survives restarts.

Every write here is gated and audited IN THIS MODULE, so no caller can skip
either: `create` refuses an id the live provider catalog does not resolve
(see models_catalog.resolve_id — the 2026-08-07 tilde slug is the incident),
and every create/update/delete records a capability_events row whoever the
actor is.
"""

import json
import logging

from app import db

log = logging.getLogger(__name__)

_FIELDS = ("id", "model", "provider", "min_ram_gb", "min_vram_gb", "tool_tier",
           "speed", "roles", "use_cases", "notes", "is_system", "enabled",
           "last_probe", "probed_at", "created_at")
_EDIT_FIELDS = {"min_ram_gb", "min_vram_gb", "tool_tier", "speed", "roles",
                "use_cases", "notes"}
_TIERS = ("A", "B", "C")
_SPEEDS = ("fast", "medium", "slow")
_ROLES = ("chat", "tools", "guard", "compaction", "voice", "ingestion")
# "what is this good for" — a task-fit vocabulary distinct from the internal
# agent-profile `roles`. The filter and the per-model chips draw from this set.
_USE_CASES = ("coding", "agentic-tools", "reasoning", "writing", "chat",
              "vision", "long-context", "multilingual", "summarization")


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    d["roles"] = list(d["roles"] or [])
    d["use_cases"] = list(d["use_cases"] or [])
    if isinstance(d["last_probe"], str):
        d["last_probe"] = json.loads(d["last_probe"])
    for k in ("probed_at", "created_at"):
        d[k] = str(d[k]) if d[k] else None
    return d


# The audit kind for curated writes. The hand-inserted row of 2026-08-07
# logged nothing while the agent-model change 21 seconds later did — the
# trail covered assignments but not the pool they are drawn from. Every
# write below records one of these, whoever the actor is.
#
# A literal rather than a capability_events constant only because that
# module is owned elsewhere this round; the constant belongs there
# (follow-up noted in the lane report).
_EVENT_KIND = "model"


def edit_field_schema() -> dict:
    """JSON-schema properties for the editable fields, built from the SAME
    tuples `_validate` enforces — one source, two readers, so the tool that
    describes these fields to a model can never advertise a value the
    validator refuses. The assert below keeps the two views locked.
    """
    return {
        "tool_tier": {"type": "string", "enum": list(_TIERS),
                      "description": "tool-calling reliability: A best, "
                                     "C = no usable tool calling"},
        "speed": {"type": "string", "enum": list(_SPEEDS)},
        "roles": {"type": "array",
                  "items": {"type": "string", "enum": list(_ROLES)},
                  "description": "which agent-profile roles this model can "
                                 "hold; empty means unclassified and it will "
                                 "never be recommended or used as a standby"},
        "use_cases": {"type": "array",
                      "items": {"type": "string", "enum": list(_USE_CASES)},
                      "description": "task-fit chips shown in the UI"},
        "min_ram_gb": {"type": "integer",
                       "description": "for local models: RAM needed (null "
                                      "for cloud)"},
        "min_vram_gb": {"type": "integer",
                        "description": "for local models: VRAM needed (null "
                                       "for cloud)"},
        "notes": {"type": "string",
                  "description": "why this row exists — price, context "
                                 "window, what it is good at"},
    }


assert set(edit_field_schema()) == _EDIT_FIELDS, \
    "edit_field_schema() and _EDIT_FIELDS disagree — one source, two readers"


def _record(subject: str, action: str, actor: str, detail: dict) -> None:
    from app import capability_events
    capability_events.record(_EVENT_KIND, subject, action,
                             actor=actor or "operator", detail=detail)


def _validate(fields: dict):
    if "tool_tier" in fields and fields["tool_tier"] not in _TIERS:
        raise ValueError(f"tool_tier must be one of {_TIERS}")
    if "speed" in fields and fields["speed"] not in _SPEEDS:
        raise ValueError(f"speed must be one of {_SPEEDS}")
    if "roles" in fields:
        if not isinstance(fields["roles"], list) or \
                any(r not in _ROLES for r in fields["roles"]):
            raise ValueError(f"roles must be a list drawn from {_ROLES}")
    if "use_cases" in fields:
        if not isinstance(fields["use_cases"], list) or \
                any(u not in _USE_CASES for u in fields["use_cases"]):
            raise ValueError(f"use_cases must be a list drawn from {_USE_CASES}")
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


async def create(model: str, provider: str, *, actor: str = "operator",
                 **fields) -> dict:
    model = model.strip()
    if ":" not in model:
        raise ValueError("model must be '<provider>:<id>', e.g. 'ollama:gemma3:12b'")
    from app.llm import providers
    valid = {"ollama"} | providers.known_slugs()
    if provider not in valid:
        raise ValueError(f"unknown provider '{provider}' — add it in "
                         f"Settings → Models → Providers")
    if model.split(":", 1)[0] != provider:
        raise ValueError(f"model id must start with '{provider}:' to match its provider")
    # THE GATE, mechanical and in the module so every write path inherits it
    # — the tool, the operator POST route, anything future. This single check
    # is what would have stopped the 2026-08-07 tilde slug: the id must
    # resolve against the live provider catalog, and the '~' profile-URL form
    # is normalised to the canonical id or the whole insert is refused.
    from app import models_catalog
    canonical, why = await models_catalog.resolve_id(model)
    if canonical is None:
        raise ValueError(why)
    model = canonical
    fields = {k: v for k, v in fields.items() if k in _EDIT_FIELDS}
    _validate(fields)
    cols = ["model", "provider"] + list(fields)
    vals = [model, provider] + list(fields.values())
    placeholders = ", ".join(f"${i + 1}" for i in range(len(vals)))
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            f"INSERT INTO curated_models ({', '.join(cols)}) "
            f"VALUES ({placeholders}) RETURNING *", *vals)
    _record(model, "added", actor,
            {"provider": provider, "verified": why,
             **({"roles": list(fields["roles"])} if fields.get("roles") else {})})
    return _row(r)


async def update(row_id: str, *, actor: str = "operator", **fields) -> str:
    """Returns 'updated' | 'not_found' | 'is_system'. System rows accept only
    'enabled' — curation seeds are knowledge, toggle them off rather than
    rewrite them in place. The `model` id itself is never updatable: a row IS
    its id, so a different model is a new row through `create` and its
    catalog check."""
    async with db.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT model, is_system FROM curated_models WHERE id = $1::uuid",
            row_id)
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
    # enabled is its own verb, same reasoning as agents: "who took this model
    # off the approved list" is the question the trail must answer.
    if set(fields) == {"enabled"}:
        _record(existing["model"], "enabled" if fields["enabled"] else "disabled",
                actor, {})
    else:
        detail = {k: v for k, v in fields.items() if k != "enabled"}
        if "enabled" in fields:
            detail["enabled"] = fields["enabled"]
        _record(existing["model"], "updated", actor, detail)
    return "updated"


async def delete(row_id: str, *, actor: str = "operator") -> str:
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "SELECT model, is_system FROM curated_models WHERE id = $1::uuid",
            row_id)
        if not r:
            return "not_found"
        if r["is_system"]:
            return "is_system"
        await conn.execute("DELETE FROM curated_models WHERE id = $1::uuid", row_id)
    _record(r["model"], "deleted", actor, {})
    return "deleted"


async def stamp_probe(model: str, result: dict):
    """Attach the latest probe result to the curated row, if one exists."""
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE curated_models SET last_probe = $2, probed_at = now(), "
            "updated_at = now() WHERE model = $1",
            model, json.dumps(result))
