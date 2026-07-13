"""Agent registry - CRUD operations for agents."""

import logging
import uuid
from typing import Optional
from app import db

log = logging.getLogger(__name__)


async def list_agents(enabled_only: bool = True) -> list[dict]:
    """List all agents."""
    async with await db.get_connection() as conn:
        if enabled_only:
            rows = await conn.fetch("SELECT * FROM agents WHERE enabled = true ORDER BY name")
        else:
            rows = await conn.fetch("SELECT * FROM agents ORDER BY name")

        return [{
            "id": str(row["id"]),
            "name": row["name"],
            "description": row["description"],
            "system_prompt": row["system_prompt"],
            "model": row["model"],
            "allowed_tools": row["allowed_tools"],
            "routing_keywords": row["routing_keywords"],
            "enabled": row["enabled"],
            "is_system": row["is_system"],
            "created_at": str(row["created_at"]) if row["created_at"] else None,
        } for row in rows]


async def get_agent(agent_id: str) -> Optional[dict]:
    """Get a specific agent."""
    async with await db.get_connection() as conn:
        row = await conn.fetchrow("SELECT * FROM agents WHERE id = $1", uuid.UUID(agent_id))
        if row:
            return {
                "id": str(row["id"]),
                "name": row["name"],
                "description": row["description"],
                "system_prompt": row["system_prompt"],
                "model": row["model"],
                "allowed_tools": row["allowed_tools"],
                "routing_keywords": row["routing_keywords"],
                "enabled": row["enabled"],
                "is_system": row["is_system"],
                "created_at": str(row["created_at"]) if row["created_at"] else None,
            }
        return None


async def get_agent_by_name(name: str) -> Optional[dict]:
    """Get an agent by name."""
    async with await db.get_connection() as conn:
        row = await conn.fetchrow("SELECT * FROM agents WHERE name = $1", name)
        if row:
            return {
                "id": str(row["id"]),
                "name": row["name"],
                "description": row["description"],
                "system_prompt": row["system_prompt"],
                "model": row["model"],
                "allowed_tools": row["allowed_tools"],
                "routing_keywords": row["routing_keywords"],
                "enabled": row["enabled"],
                "is_system": row["is_system"],
                "created_at": str(row["created_at"]) if row["created_at"] else None,
            }
        return None


async def create_agent(name: str, description: str, system_prompt: str, model: str,
                       allowed_tools: Optional[list[str]] = None,
                       routing_keywords: Optional[list[str]] = None) -> str:
    """Create a new agent."""
    agent_id = uuid.uuid4()
    async with await db.get_connection() as conn:
        await conn.execute(
            """INSERT INTO agents (id, name, description, system_prompt, model, allowed_tools, routing_keywords)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            agent_id, name, description, system_prompt, model, allowed_tools, routing_keywords
        )
    log.info(f"Created agent: {name}")
    return str(agent_id)


async def update_agent(agent_id: str, **updates) -> bool:
    """Update an agent's settings."""
    if not updates:
        return False

    async with await db.get_connection() as conn:
        agent = await conn.fetchrow("SELECT * FROM agents WHERE id = $1", uuid.UUID(agent_id))
        if not agent:
            return False

        # Don't allow deletion of is_system agents via update
        if agent["is_system"] and updates.get("enabled") == False and agent["enabled"] == True:
            log.warning(f"Attempted to delete system agent {agent_id}")

        set_clauses = []
        params = [uuid.UUID(agent_id)]
        for i, (key, value) in enumerate(updates.items(), 2):
            if key in ["name", "description", "system_prompt", "model", "allowed_tools", "routing_keywords", "enabled"]:
                set_clauses.append(f"{key} = ${i}")
                params.append(value)

        if not set_clauses:
            return False

        set_clause = ", ".join(set_clauses)
        await conn.execute(f"UPDATE agents SET {set_clause}, updated_at = now() WHERE id = $1", *params)

    log.info(f"Updated agent: {agent_id}")
    return True


async def disable_agent(agent_id: str) -> bool:
    """Disable an agent (sets enabled = false)."""
    return await update_agent(agent_id, enabled=False)
