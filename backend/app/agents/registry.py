"""Agent registry — CRUD over the agents table.

is_system agents can be disabled but never deleted (there is deliberately no
delete operation at all; disable is the only off-switch).
"""

import logging
import uuid
from typing import Optional

from app import db

log = logging.getLogger(__name__)

_FIELDS = ("id", "name", "description", "system_prompt", "model", "allowed_tools",
           "routing_keywords", "enabled", "is_system", "created_at")

_UPDATABLE = {"name", "description", "system_prompt", "model",
              "allowed_tools", "routing_keywords", "enabled"}


def _row_to_dict(row) -> dict:
    d = {k: row[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    d["created_at"] = str(d["created_at"]) if d["created_at"] else None
    return d


async def list_agents(enabled_only: bool = True) -> list[dict]:
    q = "SELECT * FROM agents"
    if enabled_only:
        q += " WHERE enabled = true"
    q += " ORDER BY name"
    async with db.acquire() as conn:
        return [_row_to_dict(r) for r in await conn.fetch(q)]


async def get_agent(agent_id: str) -> Optional[dict]:
    async with db.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM agents WHERE id = $1", uuid.UUID(agent_id))
        return _row_to_dict(row) if row else None


async def get_agent_by_name(name: str) -> Optional[dict]:
    async with db.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM agents WHERE name = $1", name)
        return _row_to_dict(row) if row else None


async def create_agent(name: str, description: str, system_prompt: str, model: str,
                       allowed_tools: Optional[list[str]] = None,
                       routing_keywords: Optional[list[str]] = None) -> str:
    agent_id = uuid.uuid4()
    async with db.acquire() as conn:
        await conn.execute(
            """INSERT INTO agents (id, name, description, system_prompt, model,
                                   allowed_tools, routing_keywords)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            agent_id, name, description, system_prompt, model,
            allowed_tools, routing_keywords)
    log.info("Agent created: %s", name)
    return str(agent_id)


async def update_agent(agent_id: str, **updates) -> bool:
    updates = {k: v for k, v in updates.items() if k in _UPDATABLE}
    if not updates:
        return False
    set_clauses, params = [], [uuid.UUID(agent_id)]
    for i, (key, value) in enumerate(updates.items(), start=2):
        set_clauses.append(f"{key} = ${i}")
        params.append(value)
    async with db.acquire() as conn:
        result = await conn.execute(
            f"UPDATE agents SET {', '.join(set_clauses)}, updated_at = now() WHERE id = $1",
            *params)
    return result.endswith("1")


async def disable_agent(agent_id: str) -> bool:
    return await update_agent(agent_id, enabled=False)
