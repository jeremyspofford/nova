"""Agent registry — CRUD over the agents table.

is_system agents can never be deleted, and the tool layer can change neither
their identity nor their capabilities (_SYSTEM_PROTECTED) — only the operator
can, via operator=True from the authenticated HTTP route. Non-system agents
are deletable via the operator API and stay create/update-only at the tool
layer (manage_agents has no delete action).
"""

import logging
import uuid
from typing import Optional

from app import db

log = logging.getLogger(__name__)

_FIELDS = ("id", "name", "description", "system_prompt", "model", "allowed_tools",
           "routing_keywords", "enabled", "is_system", "created_at", "thinking",
           "fallback_model")

_UPDATABLE = {"name", "description", "system_prompt", "model",
              "allowed_tools", "routing_keywords", "enabled", "thinking",
              "fallback_model"}

# Fields NO model may set, on ANY agent — not just system ones.
#
# _SYSTEM_PROTECTED below is about which agents a tool call may rewrite;
# this is about which FIELDS, and it holds even for an agent the model
# legitimately created. A model that picks its own standby can route itself
# onto one with no tool support and then answer confidently having called
# nothing — the failure capability_claims.py exists to catch, arranged by
# the model rather than by an outage. The standby is the operator's choice.
_OPERATOR_ONLY = {"fallback_model"}

# What a system agent IS and what it CAN DO. Changing any of these on main,
# guardian or a manager rewrites the security model itself, so the tool layer
# may never touch them — only the operator, via operator=True.
#
# This used to be guarded in router_chat.py alone (and only for enabled=False),
# so the model-facing path went straight round it: main dispatches to
# agent-manager, agent-manager calls manage_agents(action="update",
# allowed_tools=[...]), and any agent grants itself delete_memory_item — or
# disables guardian and with it the consent gate. Migration 020 recorded
# "system agents are always active" as an operator decision; it is enforced
# here now, where every caller inherits it.
#
# description/routing_keywords stay open: they change how an agent is
# described and matched, not what it is permitted to do.
_SYSTEM_PROTECTED = {"name", "system_prompt", "model", "allowed_tools", "enabled"}


class SystemAgentProtected(Exception):
    """Raised when a non-operator caller tries to change a system agent's
    identity or capabilities. Carries the field names for the error message."""

    def __init__(self, name: str, fields: set[str]):
        self.agent_name = name
        self.fields = sorted(fields)
        super().__init__(
            f"'{name}' is a system agent — {', '.join(self.fields)} cannot be "
            f"changed from a chat turn. Constrain system agents with rules and "
            f"tool grants, or edit them in Settings.")


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
                       routing_keywords: Optional[list[str]] = None,
                       actor: str | None = None) -> str:
    agent_id = uuid.uuid4()
    async with db.acquire() as conn:
        await conn.execute(
            """INSERT INTO agents (id, name, description, system_prompt, model,
                                   allowed_tools, routing_keywords)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            agent_id, name, description, system_prompt, model,
            allowed_tools, routing_keywords)
    log.info("Agent created: %s", name)
    from app import capability_events as ce
    ce.record(ce.AGENT, name, "created", actor=actor or "operator",
              detail={"model": model, "granted": sorted(allowed_tools or [])})
    return str(agent_id)


async def update_agent(agent_id: str, *, operator: bool = False,
                       actor: str | None = None, **updates) -> bool:
    """`operator=True` is the human at the Settings UI, reached only through
    the authenticated HTTP route. Everything else — every tool call, every
    dispatch — is a model and gets the _SYSTEM_PROTECTED guard."""
    updates = {k: v for k, v in updates.items() if k in _UPDATABLE}
    if not operator:
        # dropped silently on purpose: the tool layer's contract is "update
        # what you may", and refusing the whole call would let a model learn
        # the field exists by probing for the error.
        for field in _OPERATOR_ONLY & set(updates):
            log.warning("refusing to set %s from a non-operator caller (%s)",
                        field, actor or "an agent")
            updates.pop(field)
    if not updates:
        return False
    if not operator:
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT name, is_system FROM agents WHERE id = $1", uuid.UUID(agent_id))
        if row and row["is_system"]:
            blocked = _SYSTEM_PROTECTED & set(updates)
            if blocked:
                raise SystemAgentProtected(row["name"], blocked)
    set_clauses, params = [], [uuid.UUID(agent_id)]
    for i, (key, value) in enumerate(updates.items(), start=2):
        set_clauses.append(f"{key} = ${i}")
        params.append(value)
    async with db.acquire() as conn:
        # read BEFORE the write: an allowed_tools change is only meaningful
        # as a delta, and afterwards the previous value is gone
        prev = await conn.fetchrow(
            "SELECT name, enabled, model, allowed_tools FROM agents WHERE id = $1",
            uuid.UUID(agent_id))
        result = await conn.execute(
            f"UPDATE agents SET {', '.join(set_clauses)}, updated_at = now() WHERE id = $1",
            *params)
    ok = result.endswith("1")
    if ok and prev:
        _record_update(dict(prev), updates, operator, actor)
    return ok


def _record_update(prev: dict, updates: dict, operator: bool, actor: str | None) -> None:
    """Turn an UPDATE into the smallest true statement about it."""
    from app import capability_events as ce
    who = actor or ("operator" if operator else "an agent")
    detail = {}
    if "allowed_tools" in updates:
        detail.update(ce.diff_grants(prev.get("allowed_tools"),
                                     updates["allowed_tools"]))
    if "model" in updates and updates["model"] != prev.get("model"):
        detail["model"] = updates["model"]
    # enabled is its own verb, because "disabled" is the change an operator
    # most needs Nova to notice and "updated" would bury it
    if "enabled" in updates and updates["enabled"] != prev.get("enabled"):
        ce.record(ce.AGENT, prev["name"],
                  "enabled" if updates["enabled"] else "disabled",
                  actor=who, detail=detail)
        return
    if detail or set(updates) - {"enabled"}:
        ce.record(ce.AGENT, prev["name"], "updated", actor=who, detail=detail)


async def disable_agent(agent_id: str, *, operator: bool = False,
                        actor: str | None = None) -> bool:
    return await update_agent(agent_id, operator=operator, actor=actor,
                              enabled=False)


async def delete_agent(agent_id: str, *, actor: str | None = None) -> str:
    """Returns 'deleted' | 'not_found' | 'is_system'. System agents (main,
    the managers, guardian) can never be deleted — disable is their only
    off-switch."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT name, is_system FROM agents WHERE id = $1", uuid.UUID(agent_id))
        if not row:
            return "not_found"
        if row["is_system"]:
            return "is_system"
        await conn.execute("DELETE FROM agents WHERE id = $1", uuid.UUID(agent_id))
    log.info("Agent deleted: %s", row["name"])
    from app import capability_events as ce
    ce.record(ce.AGENT, row["name"], "deleted", actor=actor or "operator")
    return "deleted"
