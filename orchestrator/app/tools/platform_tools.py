"""
Platform Tools — what the Nova agent can DO inside the platform.

These are the LLM's eyes and hands into the Nova system. Each ToolDefinition
is what the LLM sees when deciding to call a tool; each execute_* function
is what actually runs when the LLM's request lands.

Adding a new tool:
  1. Add a ToolDefinition to PLATFORM_TOOLS (the LLM sees this description)
  2. Add a case in execute_tool()
  3. Implement the async execute_* function

Tool results are always returned as plain strings — the LLM receives them as
the content of a role="tool" message in the next turn.
"""
from __future__ import annotations

import logging

from nova_contracts import BlastRadius, ToolDefinition

log = logging.getLogger(__name__)

# ─── Tool definitions (what the LLM sees) ────────────────────────────────────

PLATFORM_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="list_agents",
        description=(
            "List all agents currently registered in the Nova platform. "
            "Returns each agent's ID, name, model, status, and creation time."
        ),
        parameters={"type": "object", "properties": {}, "required": []},
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="get_agent_info",
        description="Get detailed configuration and status for a specific Nova agent.",
        parameters={
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": "string",
                    "description": "UUID of the agent to look up",
                }
            },
            "required": ["agent_id"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="create_agent",
        description=(
            "Create a new agent in the Nova platform with a given model and system prompt. "
            "Returns the new agent's ID. Use list_available_models to pick a model."
        ),
        parameters={
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Human-readable name for the agent (e.g. 'Research Assistant')",
                },
                "model": {
                    "type": "string",
                    "description": (
                        "Model ID, e.g. 'qwen2.5:7b' or 'groq/llama-3.3-70b-versatile'. "
                        "Call list_available_models to see all options."
                    ),
                },
                "system_prompt": {
                    "type": "string",
                    "description": "System prompt defining the agent's role and behaviour",
                },
            },
            "required": ["name", "model", "system_prompt"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="list_available_models",
        description=(
            "List all LLM model IDs available in the Nova gateway, grouped by provider. "
            "Use this to pick a model when creating agents or switching models."
        ),
        parameters={"type": "object", "properties": {}, "required": []},
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="send_message_to_agent",
        description=(
            "Send a message to another Nova agent and receive its response. "
            "Useful for delegating subtasks, getting specialist opinions, or "
            "orchestrating multi-agent workflows."
        ),
        parameters={
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": "string",
                    "description": "UUID of the target agent",
                },
                "message": {
                    "type": "string",
                    "description": "The message to send to the agent",
                },
            },
            "required": ["agent_id", "message"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="create_task",
        description=(
            "Submit a task to a pipeline pod for autonomous execution. Use this when the user's "
            "request requires multi-step code changes, thorough analysis, or work that benefits "
            "from the full pipeline (context gathering, guardrails, code review). Returns a task "
            "ID — the user will be notified when it completes."
        ),
        parameters={
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "Clear description of what to accomplish",
                },
                "pod_name": {
                    "type": "string",
                    "description": "Target pod name (default: system default pod, usually 'Quartet')",
                },
                "context": {
                    "type": "string",
                    "description": "Additional context to include (code snippets, file paths, constraints)",
                },
            },
            "required": ["description"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="create_goal",
        description=(
            "Create a strategic goal for Cortex to pursue autonomously over time. Goals are "
            "ongoing objectives that Cortex re-evaluates and acts on repeatedly — use create_task "
            "for one-shot work instead. "
            "If the platform's autonomy level requires confirmation, the first call without "
            "confirmed=true returns a DRAFT for the user to review. Only set confirmed=true after "
            "the user explicitly approves the draft."
        ),
        parameters={
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short name for the goal",
                },
                "description": {
                    "type": "string",
                    "description": "What Cortex should accomplish and why",
                },
                "success_criteria": {
                    "type": "string",
                    "description": "How to determine the goal has been achieved",
                },
                "priority": {
                    "type": "integer",
                    "enum": [1, 2, 3, 4],
                    "description": "Priority level: 1=critical, 2=high, 3=normal, 4=low",
                },
                "max_cost_usd": {
                    "type": "number",
                    "description": "Maximum spend in USD before Cortex pauses the goal",
                },
                "max_iterations": {
                    "type": "integer",
                    "description": "Maximum number of Cortex think-cycles for this goal",
                },
                "check_interval_seconds": {
                    "type": "integer",
                    "description": "How often (in seconds) Cortex should revisit this goal",
                },
                "schedule_cron": {
                    "type": "string",
                    "description": "Cron expression for scheduled re-evaluation (e.g. '0 9 * * 1' for Monday 9am)",
                },
                "parent_goal_id": {
                    "type": "string",
                    "description": "UUID of a parent goal to nest this under",
                },
                "max_completions": {
                    "type": "integer",
                    "description": "Stop after completing this many times (useful with schedule_cron)",
                },
                "confirmed": {
                    "type": "boolean",
                    "description": "Set to true only after the user has reviewed and approved the draft",
                },
            },
            "required": ["title", "description"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
]


# ─── Tool execution ───────────────────────────────────────────────────────────

async def execute_tool(name: str, arguments: dict) -> str:
    """Dispatch a tool call by name and return its string result.

    Results are fed back to the LLM as the content of a role=tool message,
    so always return a human-readable string even on errors.
    """
    log.info("Executing platform tool: %s  args=%s", name, arguments)
    try:
        if name == "list_agents":
            return await _execute_list_agents()
        elif name == "get_agent_info":
            return await _execute_get_agent_info(arguments.get("agent_id", ""))
        elif name == "create_agent":
            return await _execute_create_agent(
                name=arguments["name"],
                model=arguments["model"],
                system_prompt=arguments["system_prompt"],
            )
        elif name == "list_available_models":
            return _execute_list_available_models()
        elif name == "send_message_to_agent":
            return await _execute_send_message_to_agent(
                agent_id=arguments["agent_id"],
                message=arguments["message"],
            )
        elif name == "create_task":
            return await _execute_create_task(
                description=arguments["description"],
                pod_name=arguments.get("pod_name"),
                context=arguments.get("context"),
            )
        elif name == "create_goal":
            return await _execute_create_goal(arguments)
        else:
            return f"Unknown tool '{name}'. Available: {[t.name for t in PLATFORM_TOOLS]}"
    except Exception as e:
        log.error("Tool %s failed: %s", name, e, exc_info=True)
        return f"Tool '{name}' failed: {e}"


async def _execute_list_agents() -> str:
    from app.store import list_agents
    agents = await list_agents()
    if not agents:
        return "No agents currently registered in Nova."
    lines = ["Agents in Nova:"]
    for a in sorted(agents, key=lambda x: x.created_at):
        lines.append(
            f"  • {a.config.name}  id={a.id}  model={a.config.model}"
            f"  status={a.status.value}  created={a.created_at.strftime('%H:%M:%S')}"
        )
    return "\n".join(lines)


async def _execute_get_agent_info(agent_id: str) -> str:
    from app.store import get_agent
    agent = await get_agent(agent_id)
    if not agent:
        return f"Agent {agent_id!r} not found."
    return (
        f"Agent: {agent.config.name}\n"
        f"  ID:           {agent.id}\n"
        f"  Model:        {agent.config.model}\n"
        f"  Status:       {agent.status.value}\n"
        f"  Memory tiers: {', '.join(agent.config.memory_tiers)}\n"
        f"  Max tokens:   {agent.config.max_context_tokens}\n"
        f"  Tools:        {', '.join(agent.config.tools) or 'none'}\n"
        f"  System prompt (first 200 chars): {agent.config.system_prompt[:200]}"
    )


async def _execute_create_agent(name: str, model: str, system_prompt: str) -> str:
    from app.store import create_agent
    from nova_contracts import AgentConfig
    config = AgentConfig(name=name, model=model, system_prompt=system_prompt)
    agent = await create_agent(config)
    return (
        f"Created agent '{name}' successfully.\n"
        f"  ID:    {agent.id}\n"
        f"  Model: {model}\n"
        f"Use send_message_to_agent with id={agent.id} to interact with it."
    )


def _execute_list_available_models() -> str:
    """Return a curated list of model IDs from the gateway registry."""
    return """\
Available models by provider:

  Ollama (local, unlimited):
    qwen2.5:7b   ← recommended local default
    qwen2.5:1.5b, llama3.2, llama3.1, mistral, phi4, deepseek-r1, gemma3

  Anthropic API (paid):
    claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5-20251001

  OpenAI API (paid):
    gpt-4o, gpt-4o-mini

  ChatGPT Plus/Pro subscription (no API billing):
    chatgpt/gpt-4o, chatgpt/gpt-4o-mini, chatgpt/o3, chatgpt/o4-mini

  Groq (free API, 14 400 req/day):
    groq/llama-3.3-70b-versatile
    groq/llama-3.1-8b-instant

  Cerebras (free API, 1M tok/day):
    cerebras/llama3.1-8b

  Gemini (free API, 250 req/day):
    gemini/gemini-2.5-flash
    gemini/gemini-2.5-pro

  OpenRouter (free tier):
    openrouter/meta-llama/llama-3.1-8b-instruct:free

Use model IDs exactly as shown when calling create_agent."""


async def _execute_send_message_to_agent(agent_id: str, message: str) -> str:
    """Send one message to another agent and return its response.

    This is synchronous from the calling agent's perspective — it blocks until
    the target agent responds, which keeps the conversation coherent.
    Uses the orchestrator's own HTTP client so it goes through the full
    agent pipeline (memory retrieval, system prompt, etc.).
    """
    from uuid import uuid4

    from app.clients import get_orchestrator_client

    client = get_orchestrator_client()
    try:
        resp = await client.post(
            "/api/v1/tasks",
            json={
                "agent_id": agent_id,
                "session_id": f"cross-agent-{uuid4()}",
                "messages": [{"role": "user", "content": message}],
            },
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("status") == "failed":
            return f"Agent {agent_id} failed: {result.get('error', 'unknown error')}"
        return result.get("response", "(no response)")
    except Exception as e:
        return f"Failed to reach agent {agent_id}: {e}"


async def _get_creation_autonomy() -> str:
    """Read nova:config:creation.autonomy from Redis (db1). Default: auto_tasks."""
    from app.store import get_redis
    try:
        redis = get_redis()
        value = await redis.get("nova:config:creation.autonomy")
        return value.decode() if isinstance(value, bytes) else (value or "auto_tasks")
    except Exception:
        return "auto_tasks"


# Module-level rate-limit counter: tracks goal creations per session/run
_goal_creation_count: dict[str, int] = {}
_GOAL_RATE_LIMIT = 3


async def _execute_create_task(
    description: str,
    pod_name: str | None = None,
    context: str | None = None,
) -> str:
    """Submit a task to a pipeline pod for autonomous execution."""
    import json as _json
    from uuid import uuid4

    from app.db import get_pool
    from app.queue import enqueue_task

    pool = get_pool()

    # Resolve the target pod
    if pod_name:
        row = await pool.fetchrow(
            "SELECT id, name FROM pods WHERE name = $1 AND enabled = true",
            pod_name,
        )
        if not row:
            available = await pool.fetch(
                "SELECT name FROM pods WHERE enabled = true ORDER BY name"
            )
            names = [r["name"] for r in available]
            return (
                f"Pod '{pod_name}' not found or disabled. "
                f"Available pods: {', '.join(names) or 'none'}"
            )
    else:
        row = await pool.fetchrow(
            "SELECT id, name FROM pods WHERE is_system_default = true LIMIT 1"
        )
        if not row:
            return "No system default pod configured. Specify a pod_name explicitly."
        pod_name = row["name"]

    pod_id = str(row["id"])

    # Build task input
    user_input = description
    if context:
        user_input = f"{description}\n\nAdditional context:\n{context}"

    task_id = str(uuid4())
    metadata = _json.dumps({"source": "chat"})

    await pool.execute(
        """
        INSERT INTO tasks (id, user_input, pod_id, status, metadata, created_at)
        VALUES ($1::uuid, $2, $3::uuid, 'submitted', $4::jsonb, now())
        """,
        task_id,
        user_input,
        pod_id,
        metadata,
    )

    await enqueue_task(task_id)

    return (
        f"Task submitted to pod '{pod_name}' (ID: {task_id}). "
        f"The pipeline will execute this autonomously — you'll be notified when it completes."
    )


async def _execute_create_goal(args: dict) -> str:
    """Create a strategic goal for Cortex with autonomy check and rate limiting."""
    import uuid as _uuid
    from datetime import datetime, timezone

    from app.db import get_pool
    from app.stimulus import emit_stimulus

    title = (args.get("title") or "").strip()
    description = (args.get("description") or "").strip()

    if not title:
        return "Error: 'title' is required and must not be empty."
    if not description:
        return "Error: 'description' is required and must not be empty."

    # Rate limit: max 3 goal creations per process lifetime
    _goal_creation_count.setdefault("total", 0)
    if _goal_creation_count["total"] >= _GOAL_RATE_LIMIT:
        return (
            f"Rate limit reached: at most {_GOAL_RATE_LIMIT} goals may be created per session. "
            "Ask the user to create additional goals from the dashboard."
        )

    confirmed = bool(args.get("confirmed", False))
    autonomy = await _get_creation_autonomy()

    # Confirmation gate: require explicit approval unless autonomy is full_auto
    if not confirmed and autonomy in ("auto_tasks", "confirm_all"):
        success_criteria = args.get("success_criteria", "(none)")
        priority = args.get("priority", 3)
        max_cost_usd = args.get("max_cost_usd")
        max_iterations = args.get("max_iterations")
        check_interval_seconds = args.get("check_interval_seconds")
        schedule_cron = args.get("schedule_cron")
        parent_goal_id = args.get("parent_goal_id")
        max_completions = args.get("max_completions")

        lines = [
            "CONFIRMATION REQUIRED — Goal draft:",
            f"  Title:             {title}",
            f"  Description:       {description}",
            f"  Success criteria:  {success_criteria}",
            f"  Priority:          {priority}",
        ]
        if max_cost_usd is not None:
            lines.append(f"  Max cost (USD):    {max_cost_usd}")
        if max_iterations is not None:
            lines.append(f"  Max iterations:    {max_iterations}")
        if check_interval_seconds is not None:
            lines.append(f"  Check interval:    {check_interval_seconds}s")
        if schedule_cron:
            lines.append(f"  Schedule (cron):   {schedule_cron}")
        if parent_goal_id:
            lines.append(f"  Parent goal ID:    {parent_goal_id}")
        if max_completions is not None:
            lines.append(f"  Max completions:   {max_completions}")
        lines.append("")
        lines.append("Please confirm with the user before calling create_goal again with confirmed=true.")
        return "\n".join(lines)

    # Resolve optional fields
    success_criteria = args.get("success_criteria")
    priority = int(args.get("priority") or 3)
    max_cost_usd = args.get("max_cost_usd")
    max_iterations = args.get("max_iterations")
    check_interval_seconds = args.get("check_interval_seconds")
    schedule_cron = args.get("schedule_cron")
    parent_goal_id = args.get("parent_goal_id")
    max_completions = args.get("max_completions")

    # Compute schedule_next_at from cron expression if provided
    schedule_next_at = None
    if schedule_cron:
        try:
            from croniter import croniter
            if not croniter.is_valid(schedule_cron):
                return f"Error: invalid cron expression '{schedule_cron}'."
            schedule_next_at = croniter(schedule_cron, datetime.now(timezone.utc)).get_next(datetime)
        except Exception as exc:
            return f"Error parsing cron expression '{schedule_cron}': {exc}"

    # Parse parent_goal_id to UUID if provided
    parent_uuid = None
    if parent_goal_id:
        try:
            parent_uuid = _uuid.UUID(str(parent_goal_id))
        except ValueError:
            return f"Error: parent_goal_id '{parent_goal_id}' is not a valid UUID."

    goal_id = str(_uuid.uuid4())
    pool = get_pool()

    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO goals (
                id, title, description, success_criteria, priority,
                max_cost_usd, max_iterations, check_interval_seconds,
                schedule_cron, schedule_next_at, parent_goal_id,
                max_completions, created_via, created_by
            )
            VALUES (
                $1::uuid, $2, $3, $4, $5,
                $6, $7, $8,
                $9, $10, $11,
                $12, $13, $14
            )
            """,
            goal_id, title, description, success_criteria, priority,
            max_cost_usd, max_iterations, check_interval_seconds,
            schedule_cron, schedule_next_at, parent_uuid,
            max_completions, "chat_tool", "nova",
        )

    _goal_creation_count["total"] += 1

    await emit_stimulus("goal.created", {
        "goal_id": goal_id,
        "title": title,
        "schedule_cron": schedule_cron,
    })

    log.info("Goal created via chat tool: %s — %s", goal_id, title)
    return (
        f"Goal created successfully.\n"
        f"  ID:    {goal_id}\n"
        f"  Title: {title}\n"
        "Cortex will begin pursuing this goal on its next think cycle."
    )
