"""Config tools — let Nova manage skills and rules via chat."""
from __future__ import annotations

import logging

from app.db import get_pool
from nova_contracts import BlastRadius, ToolDefinition

log = logging.getLogger(__name__)

CONFIG_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="list_rules",
        description="List all behavior rules. Returns name, what it prevents, action (block/warn), "
                    "target tools, and whether it's enabled.",
        parameters={"type": "object", "properties": {}},
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="create_rule",
        description="Create a new behavior rule that constrains agent tool calls. "
                    "Describe what should be prevented in plain language. "
                    "If you know the regex pattern, provide it; otherwise leave pattern empty.",
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Short kebab-case name (e.g. no-production-deletes)"},
                "rule_text": {"type": "string", "description": "Plain language description of what to prevent"},
                "action": {"type": "string", "enum": ["block", "warn"], "description": "block = prevent, warn = allow but log"},
                "target_tools": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Tool names this applies to. Omit for all tools.",
                },
                "pattern": {"type": "string", "description": "Regex pattern to match. Leave empty if unsure."},
            },
            "required": ["name", "rule_text", "action"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="update_rule",
        description="Update an existing rule. Can change what it prevents, its action, target tools, "
                    "pattern, or enable/disable it. Cannot modify system rules.",
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Name of the rule to update"},
                "updates": {
                    "type": "object",
                    "description": "Fields to update: rule_text, action, target_tools, pattern, enabled",
                },
            },
            "required": ["name", "updates"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="delete_rule",
        description="Delete a behavior rule by name. Cannot delete system rules.",
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Name of the rule to delete"},
            },
            "required": ["name"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=False,
    ),
    ToolDefinition(
        name="list_skills",
        description="List all prompt skills. Returns name, content preview, priority, and enabled status.",
        parameters={"type": "object", "properties": {}},
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="create_skill",
        description="Create a reusable prompt skill that gets injected into agent conversations. "
                    "Skills shape how Nova responds — coding style, review focus, communication tone, etc.",
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Short name for the skill"},
                "content": {"type": "string", "description": "The prompt text to inject"},
                "description": {"type": "string", "description": "What this skill does"},
                "priority": {"type": "integer", "description": "Higher priority = injected earlier (default 0)"},
            },
            "required": ["name", "content"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="update_skill",
        description="Update an existing skill. Can change content, description, priority, or enable/disable.",
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Name of the skill to update"},
                "updates": {
                    "type": "object",
                    "description": "Fields to update: content, description, priority, enabled",
                },
            },
            "required": ["name", "updates"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="delete_skill",
        description="Delete a prompt skill by name. Cannot delete system skills.",
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Name of the skill to delete"},
            },
            "required": ["name"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=False,
    ),
]


async def execute_tool(name: str, arguments: dict) -> str:
    """Execute a config tool."""
    pool = get_pool()

    if name == "list_rules":
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT name, rule_text, action, target_tools, enabled, is_system "
                "FROM rules ORDER BY name"
            )
        if not rows:
            return "No rules configured."
        items = []
        for r in rows:
            status = "enabled" if r["enabled"] else "disabled"
            tools = ", ".join(r["target_tools"]) if r["target_tools"] else "all tools"
            system = " [system]" if r["is_system"] else ""
            items.append(f"- **{r['name']}** ({r['action']}, {status}{system}): {r['rule_text']} [applies to: {tools}]")
        return "\n".join(items)

    elif name == "create_rule":
        rule_name = arguments.get("name", "")
        rule_text = arguments.get("rule_text", "")
        action = arguments.get("action", "block")
        target_tools = arguments.get("target_tools")
        pattern = arguments.get("pattern")

        if not rule_name or not rule_text:
            return "Error: name and rule_text are required."
        if action not in ("block", "warn"):
            return f"Error: action must be 'block' or 'warn', got '{action}'."

        async with pool.acquire() as conn:
            try:
                row = await conn.fetchrow(
                    """INSERT INTO rules (name, rule_text, enforcement, action, target_tools, pattern)
                       VALUES ($1, $2, 'hard', $3, $4, $5) RETURNING id, name""",
                    rule_name, rule_text, action, target_tools, pattern,
                )
                return f"Rule '{row['name']}' created (id: {row['id']}). Action: {action}."
            except Exception as e:
                if "unique" in str(e).lower():
                    return f"Error: a rule named '{rule_name}' already exists."
                return f"Error creating rule: {e}"

    elif name == "update_rule":
        rule_name = arguments.get("name", "")
        updates = arguments.get("updates", {})
        if not rule_name:
            return "Error: rule name is required."

        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, is_system FROM rules WHERE name = $1", rule_name
            )
            if not row:
                return f"Rule '{rule_name}' not found."
            if row["is_system"] and any(k != "enabled" for k in updates):
                return f"Cannot modify system rule '{rule_name}' (only enable/disable allowed)."

            allowed = {"rule_text", "action", "target_tools", "pattern", "enabled", "name"}
            set_clauses, params, idx = [], [], 1
            for k, v in updates.items():
                if k not in allowed:
                    continue
                set_clauses.append(f"{k} = ${idx}")
                params.append(v)
                idx += 1
            if not set_clauses:
                return "No valid fields to update."
            set_clauses.append("updated_at = NOW()")
            params.append(row["id"])
            await conn.execute(
                f"UPDATE rules SET {', '.join(set_clauses)} WHERE id = ${idx}",
                *params,
            )
        return f"Rule '{rule_name}' updated."

    elif name == "delete_rule":
        rule_name = arguments.get("name", "")
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, is_system FROM rules WHERE name = $1", rule_name
            )
            if not row:
                return f"Rule '{rule_name}' not found."
            if row["is_system"]:
                return f"Cannot delete system rule '{rule_name}'. You can disable it instead."
            await conn.execute("DELETE FROM rules WHERE id = $1", row["id"])
        return f"Rule '{rule_name}' deleted."

    elif name == "list_skills":
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT name, description, priority, enabled, is_system "
                "FROM skills ORDER BY priority DESC, name"
            )
        if not rows:
            return "No skills configured."
        items = []
        for r in rows:
            status = "enabled" if r["enabled"] else "disabled"
            system = " [system]" if r["is_system"] else ""
            desc = f": {r['description']}" if r["description"] else ""
            items.append(f"- **{r['name']}** (priority {r['priority']}, {status}{system}){desc}")
        return "\n".join(items)

    elif name == "create_skill":
        skill_name = arguments.get("name", "")
        content = arguments.get("content", "")
        description = arguments.get("description", "")
        priority = int(arguments.get("priority", 0))

        if not skill_name or not content:
            return "Error: name and content are required."

        async with pool.acquire() as conn:
            try:
                row = await conn.fetchrow(
                    """INSERT INTO skills (name, content, description, priority)
                       VALUES ($1, $2, $3, $4) RETURNING id, name""",
                    skill_name, content, description, priority,
                )
                return f"Skill '{row['name']}' created (id: {row['id']}). Priority: {priority}."
            except Exception as e:
                if "unique" in str(e).lower():
                    return f"Error: a skill named '{skill_name}' already exists."
                return f"Error creating skill: {e}"

    elif name == "update_skill":
        skill_name = arguments.get("name", "")
        updates = arguments.get("updates", {})
        if not skill_name:
            return "Error: skill name is required."

        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, is_system FROM skills WHERE name = $1", skill_name
            )
            if not row:
                return f"Skill '{skill_name}' not found."

            allowed = {"content", "description", "priority", "enabled", "name"}
            set_clauses, params, idx = [], [], 1
            for k, v in updates.items():
                if k not in allowed:
                    continue
                set_clauses.append(f"{k} = ${idx}")
                params.append(v)
                idx += 1
            if not set_clauses:
                return "No valid fields to update."
            set_clauses.append("updated_at = NOW()")
            params.append(row["id"])
            await conn.execute(
                f"UPDATE skills SET {', '.join(set_clauses)} WHERE id = ${idx}",
                *params,
            )
        return f"Skill '{skill_name}' updated."

    elif name == "delete_skill":
        skill_name = arguments.get("name", "")
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, is_system FROM skills WHERE name = $1", skill_name
            )
            if not row:
                return f"Skill '{skill_name}' not found."
            if row["is_system"]:
                return f"Cannot delete system skill '{skill_name}'."
            await conn.execute("DELETE FROM skills WHERE id = $1", row["id"])
        return f"Skill '{skill_name}' deleted."

    return f"Unknown config tool: {name}"
