"""Guardrail rules — pre-execution checks on tool calls.

Cached in-process with pre-compiled regexes; refreshed on every CRUD write.
Enforcement lives in tools/registry.py::execute_tool. Fail-open by design:
a broken rules engine logs ERROR but must never brick every tool call.
"""

import asyncio
import json
import logging
import re
import uuid
from typing import Any, Optional

from app import db

log = logging.getLogger(__name__)

_FIELDS = ("id", "name", "description", "pattern", "target_tools", "target_agents",
           "action", "enabled", "is_system", "hit_count", "last_hit_at", "created_at")
_UPDATABLE = {"description", "pattern", "target_tools", "target_agents",
              "action", "enabled"}

# cache: list of dicts with a pre-compiled 'regex' key (enabled rules only)
_cache: list[dict] = []


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    for k in ("last_hit_at", "created_at"):
        d[k] = str(d[k]) if d[k] else None
    return d


def _compile(pattern: str) -> re.Pattern:
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise ValueError(f"invalid regex pattern: {e}")


async def warm():
    """(Re)load enabled rules into the cache. Called at startup and after CRUD."""
    global _cache
    async with db.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM rules WHERE enabled = true")
    fresh = []
    for r in rows:
        try:
            fresh.append({**_row(r), "regex": _compile(r["pattern"])})
        except ValueError:
            log.error("Rule '%s' has an invalid pattern; skipping it", r["name"])
    _cache = fresh
    log.info("Rules cache warmed: %d active rules", len(_cache))


def check(tool_name: str, args: dict, agent_name: Optional[str]) -> Optional[tuple[str, dict]]:
    """Return ('block'|'warn', rule) on first match, else None. Blocks win over warns."""
    try:
        haystack = tool_name + " " + json.dumps(args, default=str)
    except Exception:
        haystack = tool_name + " " + str(args)

    matched_warn = None
    for rule in _cache:
        if rule["target_tools"] and tool_name not in rule["target_tools"]:
            continue
        if rule["target_agents"] and agent_name not in rule["target_agents"]:
            continue
        if not rule["regex"].search(haystack):
            continue
        _record_hit(rule["id"])
        if rule["action"] == "block":
            return ("block", rule)
        matched_warn = matched_warn or ("warn", rule)
    return matched_warn


def _record_hit(rule_id: str):
    async def bump():
        try:
            async with db.acquire() as conn:
                await conn.execute(
                    "UPDATE rules SET hit_count = hit_count + 1, last_hit_at = now() "
                    "WHERE id = $1", uuid.UUID(rule_id))
        except Exception:
            log.exception("rule hit accounting failed")
    asyncio.ensure_future(bump())


# ── CRUD ─────────────────────────────────────────────────────────────────

async def list_rules() -> list[dict]:
    async with db.acquire() as conn:
        return [_row(r) for r in await conn.fetch("SELECT * FROM rules ORDER BY name")]


async def get_by_name(name: str) -> Optional[dict]:
    async with db.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM rules WHERE name = $1", name)
        return _row(r) if r else None


async def create(name: str, pattern: str, action: str = "block", description: str = "",
                 target_tools: Optional[list[str]] = None,
                 target_agents: Optional[list[str]] = None) -> dict:
    if action not in ("block", "warn"):
        raise ValueError("action must be 'block' or 'warn'")
    _compile(pattern)  # raises ValueError on bad regex
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """INSERT INTO rules (name, description, pattern, target_tools,
                                  target_agents, action)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING *""",
            name, description, pattern, target_tools, target_agents, action)
    await warm()
    log.info("Rule created: %s (%s)", name, action)
    return _row(r)


async def update(rule_id: str, **updates) -> bool:
    updates = {k: v for k, v in updates.items() if k in _UPDATABLE}
    if not updates:
        return False
    if "pattern" in updates:
        _compile(updates["pattern"])
    if "action" in updates and updates["action"] not in ("block", "warn"):
        raise ValueError("action must be 'block' or 'warn'")
    clauses, params = [], [uuid.UUID(rule_id)]
    for i, (k, v) in enumerate(updates.items(), start=2):
        clauses.append(f"{k} = ${i}")
        params.append(v)
    async with db.acquire() as conn:
        result = await conn.execute(
            f"UPDATE rules SET {', '.join(clauses)}, updated_at = now() WHERE id = $1",
            *params)
    await warm()
    return result.endswith("1")


async def delete(rule_id: str) -> str:
    """'deleted' | 'not_found' | 'is_system' — system rules are undeletable."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT is_system, name FROM rules WHERE id = $1", uuid.UUID(rule_id))
        if not row:
            return "not_found"
        if row["is_system"]:
            return "is_system"
        await conn.execute("DELETE FROM rules WHERE id = $1", uuid.UUID(rule_id))
    await warm()
    log.info("Rule deleted: %s", row["name"])
    return "deleted"
