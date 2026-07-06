"""
Orchestrator FastAPI router — agent lifecycle, task routing, key management, usage reporting.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time as _time
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from app.agents.runner import run_agent_turn, run_agent_turn_streaming
from app.auth import AdminDep, ApiKeyDep, UserDep
from app.db import (
    create_api_key_record,
    generate_api_key,
    get_pool,
    list_api_keys,
    revoke_api_key,
)
from app.rules import (
    RuleCreate,
    RuleUpdate,
    list_rules,
)
from app.rules import (
    create_rule as _create_rule,
)
from app.rules import (
    delete_rule as _delete_rule,
)
from app.rules import (
    update_rule as _update_rule,
)
from app.skills import (
    SkillCreate,
    SkillUpdate,
    list_skills,
)
from app.skills import (
    create_skill as _create_skill,
)
from app.skills import (
    delete_skill as _delete_skill,
)
from app.skills import (
    update_skill as _update_skill,
)
from app.store import (
    create_agent,
    delete_agent,
    get_agent,
    get_task_result,
    list_agents,
    store_task_result,
    update_agent_config,
    update_agent_status,
)
from app.tools.sandbox import (
    SandboxTier,
    read_self_modification_config,
    reset_sandbox,
    reset_self_modification,
    set_sandbox,
    set_self_modification,
)
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from nova_contracts import (
    AgentInfo,
    AgentStatus,
    CreateAgentRequest,
    SubmitTaskRequest,
    TaskResult,
)
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter(tags=["orchestrator"])


async def _sse_stream(agent_id: str, stream_gen, error_label: str = "stream", sandbox_token=None,
                      conversation_id: str | None = None, user_message: str | None = None,
                      session_id: str | None = None, message_metadata: dict | None = None):
    """SSE-formatted wrapper: yields deltas from run_agent_turn_streaming, handles errors, resets agent status.

    Emits a heartbeat every ``_HB_INTERVAL_S`` seconds while the generator is
    producing nothing (slow model turn, long tool call). The heartbeat keeps
    proxies from closing an idle connection AND lets the UI show elapsed time
    so a user never mistakes "working" for "crashed".
    """
    accumulated = ""
    model_used = None
    _HB_INTERVAL_S = 3.0
    started = _time.monotonic()

    # Drain the inner generator in a background task that feeds a queue. This is
    # the ONLY safe way to interleave heartbeats: awaiting anext() directly with
    # asyncio.wait_for cancels the generator on every timeout, which corrupts a
    # slow turn (a tool loop mid-flight gets cancelled and produces nothing).
    # The pump owns the generator; the SSE loop only reads the queue.
    _SENTINEL = object()
    queue: asyncio.Queue = asyncio.Queue()

    async def _pump():
        try:
            async for delta in stream_gen:
                await queue.put(("delta", delta))
        except Exception as e:  # noqa: BLE001 — surfaced to the client below
            await queue.put(("error", e))
        finally:
            await queue.put(("done", _SENTINEL))

    pump_task = asyncio.create_task(_pump())
    try:
        while True:
            try:
                kind, payload = await asyncio.wait_for(queue.get(), timeout=_HB_INTERVAL_S)
            except asyncio.TimeoutError:
                elapsed_ms = int((_time.monotonic() - started) * 1000)
                yield f"data: {json.dumps({'hb': elapsed_ms})}\n\n".encode()
                continue

            if kind == "done":
                break
            if kind == "error":
                raise payload

            delta = payload
            # JSON events (status/meta) from the runner — pass through as-is
            if isinstance(delta, str) and delta.startswith("{"):
                try:
                    parsed = json.loads(delta)
                    if isinstance(parsed, dict) and "meta" in parsed:
                        model_used = parsed["meta"].get("model")
                    yield f"data: {delta}\n\n".encode()
                    continue
                except (json.JSONDecodeError, KeyError):
                    pass  # Not valid JSON — treat as text delta below
            # Text deltas: wrap in JSON so newlines can't break SSE framing
            accumulated += delta
            yield f"data: {json.dumps({'t': delta})}\n\n".encode()
        yield b"data: [DONE]\n\n"
    except Exception as e:
        log.error("%s error (agent=%s): %s", error_label, agent_id, e)
        yield f"data: {json.dumps({'error': str(e)})}\n\n".encode()
        yield b"data: [DONE]\n\n"
    finally:
        if not pump_task.done():
            pump_task.cancel()
            try:
                await pump_task
            except (asyncio.CancelledError, Exception):
                pass
        await update_agent_status(agent_id, AgentStatus.idle)
        if sandbox_token is not None:
            try:
                reset_sandbox(sandbox_token)
            except ValueError:
                pass  # Token from copied async context — var expires naturally
        # Persist messages to the conversation. The user message is saved even
        # when the assistant response is empty — otherwise a failed/empty turn
        # silently drops the user's message too, and it vanishes on refresh.
        if conversation_id and (user_message or accumulated):
            try:
                from app.conversations import add_message, generate_title
                if user_message:
                    await add_message(conversation_id, "user", user_message, metadata=message_metadata)
                if accumulated:
                    await add_message(conversation_id, "assistant", accumulated, model_used=model_used)
                # Auto-title: check if conversation still has no title
                from app.db import get_pool
                pool = get_pool()
                async with pool.acquire() as conn:
                    title = await conn.fetchval(
                        "SELECT title FROM conversations WHERE id = $1",
                        UUID(conversation_id),
                    )
                if not title and user_message:
                    asyncio.create_task(generate_title(conversation_id, user_message))
            except Exception as e:
                log.warning("Failed to persist conversation messages: %s", e)
        # Release concurrent stream lock
        try:
            from app.store import get_redis
            _redis = get_redis()
            lock_key = f"nova:chat:streaming:{conversation_id or session_id}"
            await _redis.delete(lock_key)
        except Exception:
            pass  # Lock auto-expires via TTL if cleanup fails


# ── Sandbox tier (runtime from DB) ────────────────────────────────────────────

async def _get_sandbox_tier() -> SandboxTier:
    """Read the sandbox tier from platform_config (DB), falling back to env var.

    SEC-001 policy: the `home` tier requires an explicit admin opt-in
    (`sandbox.home_enabled` in platform_config). If the stored tier is `home`
    but the toggle is off, the effective tier is forced to `workspace`. This
    makes the dashboard's "Home" card a no-op until the operator also
    toggles the enable switch on the same screen.
    """
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value #>> '{}' AS val FROM platform_config WHERE key = 'shell.sandbox'"
            )
            home_enabled_row = await conn.fetchrow(
                "SELECT value #>> '{}' AS val FROM platform_config WHERE key = 'sandbox.home_enabled'"
            )
        if row:
            try:
                tier = SandboxTier(row["val"])
                # Gate: reject home tier unless admin has opted in explicitly.
                if tier == SandboxTier.home and (home_enabled_row is None or home_enabled_row["val"] != "true"):
                    log.warning("sandbox tier 'home' requested but sandbox.home_enabled is off — using workspace")
                    return SandboxTier.workspace
                return tier
            except ValueError:
                pass
    except Exception:
        pass
    from app.config import settings as _s
    try:
        return SandboxTier(_s.shell_sandbox)
    except ValueError:
        return SandboxTier.workspace


# ── Agent lifecycle ───────────────────────────────────────────────────────────

@router.post("/api/v1/agents", response_model=AgentInfo, status_code=201)
async def create_new_agent(req: CreateAgentRequest, _key: ApiKeyDep):
    return await create_agent(req.config)


@router.get("/api/v1/agents", response_model=list[AgentInfo])
async def get_agents(_key: ApiKeyDep):
    return await list_agents()


@router.get("/api/v1/agents/{agent_id}", response_model=AgentInfo)
async def get_agent_info(agent_id: str, _key: ApiKeyDep):
    agent = await get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


class UpdateAgentConfigRequest(BaseModel):
    model: str | None = None
    system_prompt: str | None = None
    fallback_models: list[str] = []


@router.patch("/api/v1/agents/{agent_id}/config", response_model=AgentInfo)
async def patch_agent_config(
    agent_id: str, req: UpdateAgentConfigRequest, _admin: AdminDep
):
    """Update model, system prompt, and fallback model list for a Redis agent. Admin-only."""
    agent = await update_agent_config(
        agent_id,
        model=req.model,
        system_prompt=req.system_prompt,
        fallback_models=req.fallback_models,
    )
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.delete("/api/v1/agents/{agent_id}", status_code=204)
async def delete_agent_endpoint(agent_id: str, _key: ApiKeyDep):
    """Permanently delete an agent. Use ?soft=true to only mark it stopped."""
    existed = await delete_agent(agent_id)
    if not existed:
        raise HTTPException(status_code=404, detail="Agent not found")


@router.delete("/api/v1/agents", status_code=200)
async def bulk_delete_agents(_admin: AdminDep, confirm: bool = Query(default=False)):
    """Delete all agents. Admin-only. Requires ?confirm=true to prevent accidents."""
    if not confirm:
        raise HTTPException(
            status_code=400,
            detail="Pass ?confirm=true to delete all agents. This cannot be undone.",
        )
    agents = await list_agents()
    for agent in agents:
        await delete_agent(str(agent.id))
    return {"deleted": len(agents)}


# ── Task routing ──────────────────────────────────────────────────────────────

@router.post("/api/v1/tasks", response_model=TaskResult, status_code=202)
async def submit_task(req: SubmitTaskRequest, key: ApiKeyDep):

    agent = await get_agent(str(req.agent_id))
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.status == AgentStatus.stopped:
        raise HTTPException(status_code=409, detail="Agent is stopped")

    task_id = uuid4()
    session_id = req.session_id or str(uuid4())
    await update_agent_status(str(req.agent_id), AgentStatus.running)

    # Set sandbox tier and self-modification flag from DB config
    tier = await _get_sandbox_tier()
    sandbox_token = set_sandbox(tier)
    self_mod = await read_self_modification_config()
    self_mod_token = set_self_modification(self_mod)
    try:
        result = await run_agent_turn(
            agent_id=str(req.agent_id),
            task_id=task_id,
            session_id=session_id,
            messages=req.messages,
            model=agent.config.model,
            system_prompt=agent.config.system_prompt,
            api_key_id=key.id,
            agent_name=agent.config.name,
            tenant_id=key.tenant_id,
        )
        await store_task_result(result)
        await update_agent_status(str(req.agent_id), AgentStatus.idle)
        return result
    finally:
        reset_self_modification(self_mod_token)
        reset_sandbox(sandbox_token)


@router.post("/api/v1/tasks/stream")
async def submit_task_streaming(req: SubmitTaskRequest, key: ApiKeyDep):

    agent = await get_agent(str(req.agent_id))
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    task_id = uuid4()
    session_id = req.session_id or str(uuid4())
    await update_agent_status(str(req.agent_id), AgentStatus.running)

    # Set sandbox tier and self-modification flag from DB config
    tier = await _get_sandbox_tier()
    sandbox_token = set_sandbox(tier)
    self_mod = await read_self_modification_config()
    self_mod_token = set_self_modification(self_mod)

    return StreamingResponse(
        _sse_stream(
            str(req.agent_id),
            run_agent_turn_streaming(
                agent_id=str(req.agent_id),
                task_id=task_id,
                session_id=session_id,
                messages=req.messages,
                model=agent.config.model,
                system_prompt=agent.config.system_prompt,
                api_key_id=key.id,
                skip_tool_preresolution=True,
                agent_name=agent.config.name,
                tenant_id=key.tenant_id,
            ),
            error_label="Streaming",
            sandbox_token=sandbox_token,
        ),
        media_type="text/event-stream",
    )


@router.get("/api/v1/tasks/{task_id}", response_model=TaskResult)
async def get_task(task_id: str, _key: ApiKeyDep):
    result = await get_task_result(task_id)
    if not result:
        raise HTTPException(status_code=404, detail="Task not found")
    return result


# ── Direct chat (admin dashboard) ────────────────────────────────────────────

BASE_FORMAT_PROMPT = (
    "IMPORTANT — Response formatting rules:\n"
    "- Always use markdown. Start sections with ## headings.\n"
    "- Use bullet points for lists, bold for key terms.\n"
    "- Keep paragraphs to 2-3 sentences max, separated by blank lines.\n"
    "- Never write walls of text. Break every response into clear sections.\n"
    "- Example structure:\n"
    "  ## Overview\n"
    "  Brief summary here.\n\n"
    "  ## Details\n"
    "  - Point one\n"
    "  - Point two"
)

TOOL_USE_PROMPT = (
    "IMPORTANT — Tool use rules:\n"
    "- When the user asks you to DO something (list, read, run, call, search, "
    "look up, show me, find, check, open, execute, fetch, etc.) against the "
    "real world, you MUST invoke the matching tool via a structured tool call. "
    "Do NOT describe what the tool would do. Do NOT emit the JSON shape of a "
    "tool call inside your text response. Do NOT explain the command you "
    "would run. Either call the tool, or (only if no tool applies) say so "
    "explicitly and ask for clarification.\n"
    "- After a tool returns a result, answer based on that result. Never "
    "fabricate tool output or continue as if a tool call succeeded when it "
    "did not appear in your tool_calls.\n"
    "- NEVER invent URLs, links, article titles, dates, or 'search results'. "
    "You have no web access unless you actually call web_search or web_fetch "
    "and see a result. If you did not call a web tool this turn, do not cite "
    "links or claim you looked something up — answer from your own knowledge "
    "and say it may be out of date, or offer to search.\n"
    "- If an earlier turn in the conversation described a tool action in "
    "prose instead of calling it, do not mimic that pattern now. Call the "
    "tool."
)

STYLE_PROMPTS = {
    "concise": "Be concise and brief. Give short, direct answers without unnecessary elaboration.",
    "detailed": "Give thorough, detailed answers with examples and explanations.",
    "technical": "Use precise technical language. Include code examples, specifications, and implementation details where relevant.",
    "creative": "Be creative and expressive. Use metaphors, analogies, and engaging language.",
    "eli5": "Explain like I'm 5. Use simple words, analogies, and avoid jargon.",
}


class ChatRequest(BaseModel):
    messages: list[dict]
    model: str | None = None
    session_id: str | None = None
    conversation_id: str | None = None
    output_style: str | None = None
    custom_instructions: str | None = None
    web_search: bool = False
    deep_research: bool = False
    metadata: dict | None = None  # channel tagging from bridge


# ── Chat pod config cache ─────────────────────────────────────────────────────
# Pod config is loaded from DB on first chat request, then cached with a short
# TTL to avoid per-message queries. Config changes take effect within the TTL.

_chat_pod_cache: dict | None = None
_chat_pod_cache_at: float = 0.0
_CHAT_POD_TTL = 8.0  # seconds


async def _get_chat_pod_config() -> dict | None:
    """Load the chat pod and its first agent config. Returns None if no chat pod."""
    global _chat_pod_cache, _chat_pod_cache_at
    now = _time.monotonic()
    if _chat_pod_cache is not None and (now - _chat_pod_cache_at) < _CHAT_POD_TTL:
        return _chat_pod_cache

    from app.db import get_pool
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT p.id AS pod_id, p.name AS pod_name,
                   pa.model, pa.system_prompt, pa.allowed_tools,
                   pa.temperature, pa.max_tokens
            FROM pods p
            JOIN pod_agents pa ON pa.pod_id = p.id
            WHERE p.is_chat_default = true AND p.enabled = true
            ORDER BY pa.position ASC
            LIMIT 1
            """
        )
    if row:
        _chat_pod_cache = dict(row)
    else:
        _chat_pod_cache = None
    _chat_pod_cache_at = now
    return _chat_pod_cache


@router.post("/api/v1/chat/stream")
async def chat_stream(req: ChatRequest, user: UserDep):
    """
    Streaming chat directly with the primary Nova agent. Admin-only.

    This endpoint is for the dashboard chat UI — it uses the admin secret
    so no API key is needed. External API consumers should use
    POST /v1/chat/completions with an API key instead.

    Chat is backed by the "chat pod" — a pod marked is_chat_default=true in
    the pods table. The pod's agent config controls model, system_prompt, and
    allowed tools. Falls back to legacy behavior if no chat pod is configured.

    - model: override the agent's configured model for this turn only
    - session_id: pass back the X-Session-Id header value to continue a conversation
    """
    agents = await list_agents()
    if not agents:
        raise HTTPException(
            status_code=503,
            detail="No agents available — Nova is still starting up",
        )

    # Use the primary agent (Nova) — first in the list by creation time
    agent = agents[0]
    is_guest = user.role == "guest"

    # Load chat pod config (cached, ~8s TTL)
    chat_pod = await _get_chat_pod_config()
    allowed_tools: list[str] | None = None
    if chat_pod and chat_pod.get("allowed_tools"):
        allowed_tools = list(chat_pod["allowed_tools"])

    # Guest isolation: validate model against allowlist
    if is_guest:
        from app.guest import validate_guest_model
        try:
            model = await validate_guest_model(req.model)
        except ValueError as e:
            raise HTTPException(status_code=403, detail=str(e))
        explicit_model = True  # prevent intelligent routing from overriding
    else:
        from app.model_resolver import is_auto_resolved, resolve_default_model
        # Pod model takes precedence over global default, request model overrides both
        pod_model = chat_pod["model"] if chat_pod and chat_pod.get("model") else None
        model = req.model or pod_model or await resolve_default_model()
        # Treat as explicit if user sent a model, pod has a model, or admin configured a specific default
        explicit_model = bool(req.model) or bool(pod_model) or not await is_auto_resolved()
    task_id = uuid4()
    # Use conversation_id as session_id when available (for memory-service compatibility)
    session_id = req.conversation_id or req.session_id or str(uuid4())

    # If conversation_id provided, verify ownership
    conversation_id = req.conversation_id
    if conversation_id:
        from app.conversations import get_conversation
        conv = await get_conversation(conversation_id, user.id)
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")

    # Concurrent stream lock — one stream per conversation at a time
    from app.store import get_redis
    lock_key = f"nova:chat:streaming:{conversation_id or session_id}"
    _redis = get_redis()
    if await _redis.exists(lock_key):
        raise HTTPException(
            status_code=409,
            detail="Nova is currently responding. Try again in a moment."
        )
    await _redis.set(lock_key, "1", ex=120)

    # Extract last user message for persistence
    user_message = None
    if conversation_id and req.messages:
        last_user = [m for m in req.messages if m.get("role") == "user"]
        if last_user:
            content = last_user[-1].get("content", "")
            user_message = content if isinstance(content, str) else str(content)

    # Guest isolation: use stripped-down system prompt with no context injection
    if is_guest:
        from app.guest import GUEST_SYSTEM_PROMPT
        system_prompt = GUEST_SYSTEM_PROMPT
    else:
        # Pod system prompt takes precedence over agent config default
        base_prompt = (chat_pod["system_prompt"] if chat_pod and chat_pod.get("system_prompt") else None) or agent.config.system_prompt
        # Build style/research modifiers for system prompt
        system_prompt = base_prompt
        modifiers: list[str] = [BASE_FORMAT_PROMPT, TOOL_USE_PROMPT]
        if req.output_style and req.output_style in STYLE_PROMPTS:
            modifiers.append(STYLE_PROMPTS[req.output_style])
        if req.custom_instructions:
            modifiers.append(req.custom_instructions.strip())
        if req.web_search:
            modifiers.append("You have web search available. Use it when the question benefits from current information.")
        if req.deep_research:
            modifiers.append("Perform thorough multi-step research. Search multiple queries, cross-reference sources, synthesize findings, and cite sources.")
        if modifiers:
            system_prompt = (system_prompt or "") + "\n\n" + "\n\n".join(modifiers)

    await update_agent_status(str(agent.id), AgentStatus.running)

    # Set sandbox tier and self-modification flag from DB config
    tier = await _get_sandbox_tier()
    sandbox_token = set_sandbox(tier)
    self_mod = await read_self_modification_config()
    self_mod_token = set_self_modification(self_mod)

    return StreamingResponse(
        _sse_stream(
            str(agent.id),
            run_agent_turn_streaming(
                agent_id=str(agent.id),
                task_id=task_id,
                session_id=session_id,
                messages=req.messages,
                model=model,
                system_prompt=system_prompt,
                api_key_id=None,
                # Run tool pre-resolution before the streaming final answer, so
                # the model can actually invoke tools mid-chat. Earlier this was
                # True as a first-token-latency optimization, but that path
                # sends tools=[] to the streaming call and the model has no way
                # to act — it only describes what it "would" do.
                skip_tool_preresolution=False,
                explicit_model=explicit_model,
                guest_mode=is_guest,
                allowed_tools=allowed_tools,
                agent_name=agent.config.name,
                tenant_id=user.tenant_id,
            ),
            error_label="Chat stream",
            sandbox_token=sandbox_token,
            conversation_id=conversation_id,
            user_message=user_message,
            session_id=session_id,
            message_metadata=req.metadata,
        ),
        media_type="text/event-stream",
        headers={
            "X-Session-Id": session_id,
            "Cache-Control": "no-cache",
        },
    )


# ── Key management (admin-only) ───────────────────────────────────────────────

class CreateKeyRequest(BaseModel):
    name: str
    rate_limit_rpm: int = 60
    metadata: dict = {}


class KeyResponse(BaseModel):
    id: UUID
    name: str
    key_prefix: str
    is_active: bool
    rate_limit_rpm: int
    created_at: datetime
    last_used_at: datetime | None = None
    metadata: dict = {}


class CreateKeyResponse(KeyResponse):
    raw_key: str  # Returned ONCE at creation — never stored, never retrievable again


@router.post("/api/v1/keys", response_model=CreateKeyResponse, status_code=201)
async def create_key(req: CreateKeyRequest, _admin: AdminDep):
    """Create a new API key. Save raw_key immediately — it will not be shown again."""
    raw_key, key_hash, key_prefix = generate_api_key()
    row = await create_api_key_record(
        name=req.name,
        key_hash=key_hash,
        key_prefix=key_prefix,
        rate_limit_rpm=req.rate_limit_rpm,
        metadata=req.metadata,
    )
    return CreateKeyResponse(**row, raw_key=raw_key)


@router.get("/api/v1/keys", response_model=list[KeyResponse])
async def list_keys(_admin: AdminDep):
    """List all API keys. Raw keys are never returned — prefix and metadata only."""
    rows = await list_api_keys()
    return [KeyResponse(**r) for r in rows]


@router.delete("/api/v1/keys/{key_id}", status_code=204)
async def revoke_key(key_id: UUID, _admin: AdminDep):
    """Deactivate an API key. Row is preserved in the DB for audit trail."""
    existed = await revoke_api_key(key_id)
    if not existed:
        raise HTTPException(status_code=404, detail="Key not found or already revoked")


@router.get("/api/v1/keys/validate")
async def validate_key(key: ApiKeyDep):
    """Validate an API key. Returns 200 if valid, 401 if not.

    Used internally by chat-api to authenticate WebSocket connections.
    """
    return {"valid": True, "name": key.name}


def _unwrap_jsonb_str(val: str | None) -> str:
    """Strip one layer of JSON string quoting if present.

    platform_config stores JSONB.  The dashboard sends values pre-encoded
    (e.g. '"Nova"') which becomes a JSONB *string*.  Extracting with
    ``#>> '{}'`` gives the text content, but values that were double-encoded
    arrive here with literal surrounding quotes — strip them.
    """
    if val and len(val) >= 2 and val[0] == '"' and val[-1] == '"':
        try:
            return json.loads(val)
        except Exception:
            pass
    return val or ""


# ── Identity (public) ─────────────────────────────────────────────────────────

@router.get("/api/v1/identity")
async def get_identity() -> dict:
    """Public endpoint returning the AI's display name and greeting.
    No auth required - used by the dashboard UI."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, value #>> '{}' AS val FROM platform_config "
            "WHERE key IN ('nova.name', 'nova.greeting')"
        )
    config = {r["key"]: _unwrap_jsonb_str(r["val"]) for r in rows}
    name = config.get("nova.name") or "Nova"
    greeting_template = config.get("nova.greeting") or ""
    greeting = greeting_template.replace("{name}", name) if greeting_template else ""
    return {"name": name, "greeting": greeting}


# ── Platform configuration (admin-only) ──────────────────────────────────────

class ConfigUpdateRequest(BaseModel):
    value: str              # JSON-encoded value (Python side handles parsing)
    description: str | None = None


def _config_row(row: dict) -> dict:
    """Decode JSONB value back to a Python scalar for the API response.

    Also labels the value's source so the UI can show where truth comes from:
      - "env_override": present when this DB-owned key ALSO has a stale .env
        variable set (dead weight the operator should remove); the DB value
        wins regardless. Lets Settings badge "also set in .env (ignored)".
    """
    from app.config_demotion import CONFIG_KEY_TO_ENV, explicit_env_value

    d = dict(row)
    d["updated_at"] = d["updated_at"].isoformat() if d.get("updated_at") else None
    # Decode the JSONB value so the frontend receives a plain string/number/null
    raw = d.get("value")
    try:
        d["value"] = json.loads(raw) if raw is not None else None
    except Exception:
        d["value"] = raw

    env_var = CONFIG_KEY_TO_ENV.get(d.get("key"))
    if env_var:
        # Read the .env FILE (not os.environ): a compose default doesn't count
        # as an operator override.
        env_val = explicit_env_value(env_var)
        if env_val:
            d["env_override"] = {
                "var": env_var,
                "value": env_val,
                # True when .env disagrees with the effective DB value.
                "ignored": env_val != d.get("value"),
            }
    return d


@router.get("/api/v1/config")
async def list_platform_config(_admin: AdminDep) -> list[dict]:
    """Return all platform config entries. Values are decoded from JSONB. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, value, description, is_secret, updated_at "
            "FROM platform_config ORDER BY key"
        )
    return [_config_row(dict(r)) for r in rows]


@router.get("/api/v1/config/{key}")
async def get_platform_config(key: str, _admin: AdminDep) -> dict:
    """Return a single platform config entry by key. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT key, value, description, is_secret, updated_at "
            "FROM platform_config WHERE key = $1", key
        )
    if not row:
        raise HTTPException(status_code=404, detail=f"Config key '{key}' not found")
    return _config_row(dict(row))


@router.get("/api/v1/config/{key}/history")
async def get_platform_config_history(
    key: str, _admin: AdminDep, limit: int = 50
) -> list[dict]:
    """Return the change history for a single config key, newest first.

    Reads platform_config_audit (populated in the same transaction as every
    write). Values are decoded from JSONB so the UI shows plain scalars.
    Admin-only.
    """
    limit = max(1, min(limit, 200))
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT old_value, new_value, changed_by, changed_at "
            "FROM platform_config_audit WHERE config_key = $1 "
            "ORDER BY changed_at DESC LIMIT $2",
            key, limit,
        )
        # Redact the actual before/after values for secret-flagged keys — the
        # rotation history of a secret shouldn't be readable even to admins.
        is_secret = await conn.fetchval(
            "SELECT is_secret FROM platform_config WHERE key = $1", key
        )

    def _decode(v):
        if v is None:
            return None
        try:
            return json.loads(v)
        except Exception:
            return v

    def _value(v):
        if is_secret:
            return None if v is None else "••••••"
        return _decode(v)

    return [
        {
            "old_value": _value(r["old_value"]),
            "new_value": _value(r["new_value"]),
            "changed_by": str(r["changed_by"]) if r["changed_by"] else None,
            "changed_at": r["changed_at"].isoformat() if r["changed_at"] else None,
        }
        for r in rows
    ]


@router.patch("/api/v1/config/{key}")
async def update_platform_config(
    key: str, req: ConfigUpdateRequest, _admin: AdminDep
) -> dict:
    """
    Update a single platform config entry. Admin-only.

    req.value must be a JSON-encoded string, e.g.:
      '"My persona text"'  →  stores the string  My persona text
      'null'               →  clears the value
      '42'                 →  stores the integer 42
    """
    # Validate that req.value is valid JSON before storing
    try:
        json.loads(req.value)
    except json.JSONDecodeError:
        # Treat as a bare string if it's not valid JSON — wrap it
        req.value = json.dumps(req.value)

    pool = get_pool()
    async with pool.acquire() as conn:
        # Upsert + audit in a single atomic statement. The audit CTE reads the
        # prior value directly as jsonb (no ::text round-trip and re-cast, which
        # would add an extra JSON-encoding layer), so old_value and new_value are
        # stored at the same encoding depth as platform_config.value itself.
        # A NULL old_value records a creation; IS DISTINCT FROM skips no-op writes.
        desc = req.description or ''
        row = await conn.fetchrow(
            """
            WITH audit AS (
                INSERT INTO platform_config_audit (config_key, old_value, new_value)
                SELECT $1,
                       (SELECT value FROM platform_config WHERE key = $1),
                       $2::jsonb
                WHERE (SELECT value FROM platform_config WHERE key = $1)
                      IS DISTINCT FROM $2::jsonb
            )
            INSERT INTO platform_config (key, value, description, updated_at)
            VALUES ($1, $2::jsonb, $3, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                description = CASE WHEN $3 = '' THEN platform_config.description ELSE EXCLUDED.description END,
                updated_at = NOW()
            RETURNING key, value, description, is_secret, updated_at
            """,
            key, req.value, desc,
        )

    # Publish llm.* config changes to Redis db1 (llm-gateway's db) for runtime pickup
    if key.startswith("llm."):
        try:
            from app.config_sync import push_config_to_redis
            await push_config_to_redis(key, req.value)
        except Exception as e:
            log.warning("Failed to publish config %s to Redis: %s", key, e)

    # Publish inference.* config changes to Redis for gateway pickup
    if key.startswith("inference."):
        try:
            from app.config_sync import push_config_to_redis
            await push_config_to_redis(key, req.value)
        except Exception as e:
            log.warning("Failed to publish config %s to Redis: %s", key, e)

    # Publish memory.* config changes to Redis for runtime provider switching
    if key.startswith("memory."):
        try:
            from app.config_sync import push_config_to_redis
            await push_config_to_redis(key, req.value)
        except Exception as e:
            log.warning("Failed to publish config %s to Redis: %s", key, e)

    # Publish voice.* config changes to Redis for voice-service pickup
    if key.startswith("voice."):
        try:
            from app.config_sync import push_config_to_redis
            await push_config_to_redis(key, req.value)
        except Exception as e:
            log.warning("Failed to publish config %s to Redis: %s", key, e)

    # Emit activity event for config changes
    try:
        from app.activity import emit_activity
        pool = get_pool()
        await emit_activity(
            pool, "config_updated", "orchestrator",
            f"Config '{key}' updated",
            metadata={"key": key},
        )
    except Exception:
        pass

    return _config_row(dict(row))


# ── Tool catalog (admin-only) ─────────────────────────────────────────────────

@router.get("/api/v1/tools")
async def list_available_tools(_admin: AdminDep):
    """Return all available tools grouped by category. Admin-only.

    Derived from the tool registry so new groups appear here automatically —
    this endpoint used to hand-list categories and silently drifted (Browser,
    Checkpoint, Notify, GitHub were missing).
    """
    from app.pipeline.tools.registry import get_tools_by_server
    from app.tools import get_registry

    categories = [
        {
            "category": g.display_name,
            "source": "builtin",
            "tools": [{"name": t.name, "description": t.description} for t in g.tools],
        }
        for g in get_registry()
    ]
    categories.extend(get_tools_by_server())
    return categories


# ── Tool permissions ──────────────────────────────────────────────────────────


class ToolPermissionUpdate(BaseModel):
    groups: dict[str, bool]  # {"Web": false, "Git": true}


@router.get("/api/v1/tool-permissions")
async def get_tool_permissions(_admin: AdminDep):
    """Return all tool groups with their enabled/disabled status."""
    from app.tool_permissions import get_tool_groups_with_status
    return await get_tool_groups_with_status()


@router.patch("/api/v1/tool-permissions")
async def update_tool_permissions(req: ToolPermissionUpdate, _admin: AdminDep):
    """Toggle tool groups on/off. Accepts {"groups": {"Web": false, "Git": true}}."""
    from app.tool_permissions import (
        get_disabled_tool_groups,
        get_tool_groups_with_status,
        get_valid_group_names,
        set_disabled_groups,
    )

    # Validate group names against registry
    valid = get_valid_group_names()
    unknown = set(req.groups.keys()) - valid
    if unknown:
        raise HTTPException(422, f"Unknown tool groups: {sorted(unknown)}")

    old_disabled = await get_disabled_tool_groups()
    new_disabled = set(old_disabled)
    for group, enabled in req.groups.items():
        if enabled:
            new_disabled.discard(group)
        else:
            new_disabled.add(group)
    await set_disabled_groups(new_disabled)

    # Audit log — record what changed
    if old_disabled != new_disabled:
        try:
            import json as _json
            pool = get_pool()
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO platform_config_audit
                        (config_key, old_value, new_value)
                    VALUES ($1, $2::jsonb, $3::jsonb)
                    """,
                    "tool_permissions",
                    _json.dumps({"disabled_groups": sorted(old_disabled)}),
                    _json.dumps({"disabled_groups": sorted(new_disabled)}),
                )
        except Exception as e:
            log.warning(f"Audit log write failed (non-critical): {e}")

    return await get_tool_groups_with_status()


# ── Usage reporting (admin-only) ──────────────────────────────────────────────

@router.get("/api/v1/training-data/export")
async def export_training_data(
    _admin: AdminDep,
    role: str | None = Query(default=None, description="Filter by pipeline role"),
    success_only: bool = Query(default=False, description="Only include successful pipelines"),
    format: str = Query(default="jsonl", description="Export format (jsonl)"),
):
    """Export pipeline training data as JSONL for fine-tuning. Admin-only."""
    import json as _json
    pool = get_pool()
    conditions = []
    params = []
    idx = 1

    if role:
        conditions.append(f"role = ${idx}")
        params.append(role)
        idx += 1
    if success_only:
        conditions.append(f"pipeline_success = ${idx}")
        params.append(True)
        idx += 1

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    async def _stream():
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                f"SELECT prompt, response, model, role, input_tokens, output_tokens, "
                f"cost_usd, complexity, pipeline_success, stage_verdict, was_fallback, "
                f"temperature, created_at "
                f"FROM pipeline_training_logs {where} "
                f"ORDER BY created_at ASC",
                *params,
            )
            for row in rows:
                entry = {
                    "messages": row["prompt"],
                    "response": row["response"],
                    "model": row["model"],
                    "role": row["role"],
                    "input_tokens": row["input_tokens"],
                    "output_tokens": row["output_tokens"],
                    "cost_usd": float(row["cost_usd"]) if row["cost_usd"] else None,
                    "complexity": row["complexity"],
                    "pipeline_success": row["pipeline_success"],
                    "stage_verdict": row["stage_verdict"],
                    "was_fallback": row["was_fallback"],
                }
                yield _json.dumps(entry, default=str) + "\n"

    return StreamingResponse(
        _stream(),
        media_type="application/x-ndjson",
        headers={"Content-Disposition": "attachment; filename=training-data.jsonl"},
    )


@router.get("/api/v1/training-data/count")
async def training_data_count(
    _admin: AdminDep,
    role: str | None = Query(default=None),
):
    """Count training data entries. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        if role:
            row = await conn.fetchrow(
                "SELECT count(*) AS cnt FROM pipeline_training_logs WHERE role = $1", role
            )
        else:
            row = await conn.fetchrow("SELECT count(*) AS cnt FROM pipeline_training_logs")
    return {"count": row["cnt"]}


@router.get("/api/v1/usage")
async def get_usage(
    _admin: AdminDep,
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    include_outcomes: bool = Query(default=False),
):
    """Recent usage events with key name join, newest first. Admin-only.

    By default, excludes zero-token outcome events (e.g. cortex scoring).
    Pass include_outcomes=true to include them.
    """
    pool = get_pool()
    outcome_filter = "" if include_outcomes else "WHERE (u.input_tokens > 0 OR u.output_tokens > 0)"
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT u.id, u.api_key_id, k.name AS key_name,
                   u.agent_id, u.session_id, u.model,
                   u.input_tokens, u.output_tokens, u.cost_usd,
                   u.duration_ms, u.created_at,
                   u.agent_name, u.pod_name
            FROM   usage_events u
            LEFT   JOIN api_keys k ON k.id = u.api_key_id
            {outcome_filter}
            ORDER  BY u.created_at DESC
            LIMIT  $1 OFFSET $2
            """,
            limit, offset,
        )
    return [dict(r) for r in rows]


class UsageEventRequest(BaseModel):
    model: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None
    duration_ms: int | None = None
    outcome_score: float | None = None
    outcome_confidence: float | None = None
    metadata: dict | None = None
    agent_name: str | None = None
    pod_name: str | None = None


@router.post("/api/v1/usage/events", status_code=201)
async def create_usage_event(req: UsageEventRequest, _key: ApiKeyDep):
    """Accept usage events from external services (e.g. cortex)."""
    from app.db import insert_usage_event
    await insert_usage_event(
        api_key_id=None,
        agent_id=None,
        session_id=None,
        model=req.model,
        input_tokens=req.input_tokens,
        output_tokens=req.output_tokens,
        cost_usd=req.cost_usd,
        duration_ms=req.duration_ms,
        metadata=req.metadata,
        outcome_score=req.outcome_score,
        outcome_confidence=req.outcome_confidence,
        agent_name=req.agent_name,
        pod_name=req.pod_name,
    )
    return {"status": "created"}


# ── Usage summary (dashboard overview) ────────────────────────────────────────

@router.get("/api/v1/usage/summary")
async def usage_summary(
    _admin: AdminDep,
    period: str = Query(default="week", regex="^(day|week|month|year)$"),
) -> dict:
    """Aggregated usage summary for a given period. Admin-only."""
    period_days = {"day": 1, "week": 7, "month": 30, "year": 365}
    days = period_days.get(period, 7)
    now = datetime.now(timezone.utc)
    current_start = now - timedelta(days=days)
    previous_start = current_start - timedelta(days=days)

    pool = get_pool()
    async with pool.acquire() as conn:
        # Current period totals
        totals = await conn.fetchrow(
            """
            SELECT COALESCE(SUM(cost_usd), 0)::float AS total_cost_usd,
                   COUNT(*) AS total_requests
            FROM usage_events
            WHERE created_at >= $1
            """,
            current_start,
        )
        # Previous period totals (for comparison)
        prev_totals = await conn.fetchrow(
            """
            SELECT COALESCE(SUM(cost_usd), 0)::float AS total_cost_usd
            FROM usage_events
            WHERE created_at >= $1 AND created_at < $2
            """,
            previous_start, current_start,
        )
        # By model
        by_model_rows = await conn.fetch(
            """
            SELECT model,
                   COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
                   COUNT(*) AS requests
            FROM usage_events
            WHERE created_at >= $1
            GROUP BY model
            ORDER BY requests DESC
            """,
            current_start,
        )
        # By day
        by_day_rows = await conn.fetch(
            """
            SELECT DATE(created_at) AS date,
                   COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
                   COUNT(*) AS requests
            FROM usage_events
            WHERE created_at >= $1
            GROUP BY DATE(created_at)
            ORDER BY date
            """,
            current_start,
        )

    prev_cost = float(prev_totals["total_cost_usd"]) if prev_totals else 0
    current_cost = float(totals["total_cost_usd"])
    vs_previous_pct = (
        round(((current_cost - prev_cost) / prev_cost) * 100, 1)
        if prev_cost > 0 else 0.0
    )

    return {
        "total_cost_usd": current_cost,
        "total_requests": totals["total_requests"],
        "by_model": [
            {"model": r["model"], "cost_usd": r["cost_usd"], "requests": r["requests"]}
            for r in by_model_rows
        ],
        "by_day": [
            {"date": r["date"].isoformat(), "cost_usd": r["cost_usd"], "requests": r["requests"]}
            for r in by_day_rows
        ],
        "vs_previous_period_pct": vs_previous_pct,
    }


# ── Health overview (dashboard) ───────────────────────────────────────────────

@router.get("/api/v1/health/overview")
async def health_overview(_admin: AdminDep) -> dict:
    """Ping all services and report latency. Admin-only."""
    import httpx

    services_to_check = [
        ("llm-gateway", "http://llm-gateway:8001/health/ready"),
        ("memory-service", "http://memory-service:8002/health/ready"),
        ("cortex", "http://cortex:8100/health/ready"),
        ("recovery", "http://recovery:8888/health/ready"),
    ]

    results = []

    # Orchestrator is self — always up if this endpoint is responding
    results.append({"name": "orchestrator", "status": "healthy", "latency_ms": 0})

    # HTTP service checks
    async def _check_http(name: str, url: str) -> dict:
        start = _time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(url)
                latency = int((_time.monotonic() - start) * 1000)
                status = "healthy" if resp.status_code == 200 else "degraded"
                return {"name": name, "status": status, "latency_ms": latency}
        except Exception:
            latency = int((_time.monotonic() - start) * 1000)
            return {"name": name, "status": "down", "latency_ms": latency}

    http_tasks = [_check_http(name, url) for name, url in services_to_check]
    http_results = await asyncio.gather(*http_tasks)
    results.extend(http_results)

    # Postgres check
    start = _time.monotonic()
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        latency = int((_time.monotonic() - start) * 1000)
        results.append({"name": "postgres", "status": "healthy", "latency_ms": latency})
    except Exception:
        latency = int((_time.monotonic() - start) * 1000)
        results.append({"name": "postgres", "status": "down", "latency_ms": latency})

    # Redis check
    start = _time.monotonic()
    try:
        from app.store import get_redis as get_app_redis
        redis = get_app_redis()
        await redis.ping()
        latency = int((_time.monotonic() - start) * 1000)
        results.append({"name": "redis", "status": "healthy", "latency_ms": latency})
    except Exception:
        latency = int((_time.monotonic() - start) * 1000)
        results.append({"name": "redis", "status": "down", "latency_ms": latency})

    # Compute aggregate
    latencies = [r["latency_ms"] for r in results if r["latency_ms"] > 0]
    avg_latency = int(sum(latencies) / len(latencies)) if latencies else 0
    statuses = {r["status"] for r in results}
    if "down" in statuses:
        overall = "degraded"
    elif "degraded" in statuses:
        overall = "degraded"
    else:
        overall = "healthy"

    return {
        "services": results,
        "avg_latency_ms": avg_latency,
        "overall_status": overall,
    }


# ── Activity feed ──────────────────────────────────────────────────────────────

@router.get("/api/v1/activity")
async def activity_feed(
    _admin: AdminDep,
    limit: int = Query(default=20, le=100),
    offset: int = Query(default=0, ge=0),
) -> list[dict]:
    """Recent activity events for the dashboard feed. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, event_type, service, severity, summary, metadata, created_at
            FROM activity_events
            ORDER BY created_at DESC
            LIMIT $1 OFFSET $2
            """,
            limit, offset,
        )
    result = []
    for r in rows:
        d = dict(r)
        d["created_at"] = d["created_at"].isoformat()
        # metadata is stored as JSONB text — parse it
        meta = d.get("metadata")
        if isinstance(meta, str):
            try:
                d["metadata"] = json.loads(meta)
            except Exception:
                d["metadata"] = {}
        result.append(d)
    return result


# ── Model routing stats ───────────────────────────────────────────────────────

@router.get("/api/v1/models/routing-stats")
async def model_routing_stats(
    _admin: AdminDep,
    period: str = Query(default="7d"),
) -> dict:
    """Per-model usage aggregation for routing analytics. Admin-only."""
    # Parse period string (e.g. "7d", "30d", "1d")
    try:
        days = int(period.rstrip("d"))
    except (ValueError, AttributeError):
        days = 7

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT model,
              COUNT(*) AS requests,
              COALESCE(AVG(input_tokens + output_tokens), 0)::int AS avg_tokens,
              COALESCE(AVG(duration_ms), 0)::int AS avg_latency_ms,
              COALESCE(SUM(cost_usd), 0)::float AS cost_usd
            FROM usage_events
            WHERE created_at >= $1
            GROUP BY model
            ORDER BY requests DESC
            """,
            cutoff,
        )
        # Fallback rate: count events where metadata has 'was_fallback' = true
        fallback_row = await conn.fetchrow(
            """
            SELECT
              COUNT(*) FILTER (WHERE metadata->>'was_fallback' = 'true') AS fallback_count,
              COUNT(*) AS total
            FROM usage_events
            WHERE created_at >= $1
            """,
            cutoff,
        )
        # Category distribution from metadata
        cat_rows = await conn.fetch(
            """
            SELECT metadata->>'category' AS category, COUNT(*) AS cnt
            FROM usage_events
            WHERE created_at >= $1
              AND metadata->>'category' IS NOT NULL
            GROUP BY metadata->>'category'
            """,
            cutoff,
        )

    total = fallback_row["total"] if fallback_row else 0
    fallback_count = fallback_row["fallback_count"] if fallback_row else 0
    fallback_rate = round((fallback_count / total) * 100, 1) if total > 0 else 0.0

    return {
        "by_model": [
            {
                "model": r["model"],
                "requests": r["requests"],
                "avg_tokens": r["avg_tokens"],
                "avg_latency_ms": r["avg_latency_ms"],
                "cost_usd": r["cost_usd"],
            }
            for r in rows
        ],
        "fallback_rate_pct": fallback_rate,
        "category_distribution": {r["category"]: r["cnt"] for r in cat_rows},
    }


# ── Skills CRUD ──────────────────────────────────────────────────────────────


@router.get("/api/v1/skills")
async def get_skills(_admin: AdminDep):
    return await list_skills()


@router.post("/api/v1/skills", status_code=201)
async def create_skill_endpoint(req: SkillCreate, _admin: AdminDep):
    return await _create_skill(req)


@router.patch("/api/v1/skills/{skill_id}")
async def update_skill_endpoint(skill_id: UUID, req: SkillUpdate, _admin: AdminDep):
    result = await _update_skill(skill_id, req)
    if result is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return result


@router.delete("/api/v1/skills/{skill_id}", status_code=204)
async def delete_skill_endpoint(skill_id: UUID, _admin: AdminDep):
    ok = await _delete_skill(skill_id)
    if not ok:
        raise HTTPException(status_code=400, detail="Cannot delete system skill")


# ── Rules ────────────────────────────────────────────────────────────────────


@router.get("/api/v1/rules")
async def get_rules(_admin: AdminDep):
    return await list_rules()


@router.post("/api/v1/rules", status_code=201)
async def create_rule_endpoint(req: RuleCreate, _admin: AdminDep):
    return await _create_rule(req)


@router.patch("/api/v1/rules/{rule_id}")
async def update_rule_endpoint(rule_id: UUID, req: RuleUpdate, _admin: AdminDep):
    result = await _update_rule(rule_id, req)
    if result is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    return result


@router.delete("/api/v1/rules/{rule_id}", status_code=204)
async def delete_rule_endpoint(rule_id: UUID, _admin: AdminDep):
    ok = await _delete_rule(rule_id)
    if not ok:
        raise HTTPException(status_code=400, detail="Cannot delete system rule")


# ── Benchmark Results ─────────────────────────────────────────────────────────

@router.get("/api/v1/benchmarks/results")
async def get_benchmark_results(_admin: AdminDep):
    """Return parsed benchmark results for the dashboard."""
    import glob
    from pathlib import Path

    # Inside container: /app/benchmarks/results; local dev: ./benchmarks/results
    results_dir = (
        Path("/app/benchmarks/results")
        if Path("/app/benchmarks/results").exists()
        else Path("benchmarks/results")
    )
    if not results_dir.exists():
        return {"runs": [], "latest": None}

    files = sorted(glob.glob(str(results_dir / "*.jsonl")), reverse=True)
    if not files:
        return {"runs": [], "latest": None}

    runs = []
    for f in files[:10]:  # Last 10 runs
        try:
            lines = Path(f).read_text().strip().split("\n")
            entries = []
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            summaries = [e for e in entries if e.get("type") == "summary"]
            per_query = [e for e in entries if e.get("type") != "summary"]
            runs.append({
                "file": Path(f).name,
                "summaries": summaries,
                "per_query": per_query,
            })
        except Exception as exc:
            log.warning("Failed to parse benchmark file %s: %s", f, exc)
            continue

    return {"runs": runs, "latest": runs[0] if runs else None}


# ── Self-Modification ────────────────────────────────────────────────────────

@router.get("/api/v1/selfmod/status")
async def selfmod_status(request: Request):
    """Self-modification configuration status."""
    import time

    from app.config import settings
    from app.store import get_redis

    # Count PRs this hour
    redis = get_redis()
    window = int(time.time() / 3600)
    rkey = f"nova:selfmod:ratelimit:{window}"
    prs_this_hour = int(await redis.get(rkey) or 0)

    return {
        "enabled": settings.selfmod_enabled,
        "pat_configured": bool(settings.nova_github_pat),
        "repo": settings.nova_github_repo,
        "rate_limit_per_hour": settings.selfmod_rate_limit_per_hour,
        "prs_this_hour": prs_this_hour,
    }


@router.get("/api/v1/selfmod/prs")
async def selfmod_list_prs(
    request: Request,
    status: str = "all",
    limit: int = 20,
):
    """List self-modification PRs from audit trail."""
    pool = get_pool()
    query = "SELECT * FROM selfmod_prs"
    params = []
    if status != "all":
        query += " WHERE status = $1"
        params.append(status)
    query += " ORDER BY created_at DESC LIMIT $" + str(len(params) + 1)
    params.append(min(limit, 100))

    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *params)
    return [dict(r) for r in rows]


@router.get("/api/v1/selfmod/prs/{pr_id}")
async def selfmod_pr_detail(request: Request, pr_id: str):
    """Get PR detail with fresh GitHub status."""
    import uuid as _uuid
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM selfmod_prs WHERE id = $1",
            _uuid.UUID(pr_id),
        )
    if not row:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="PR not found")
    return dict(row)


# ── Reaper admin ─────────────────────────────────────────────────────────────

@router.post("/api/v1/admin/reaper/tick")
async def reaper_tick(_admin: AdminDep):
    """Run one reaper cycle on demand (admin/test use)."""
    from .reaper import _reap_stale_running_tasks
    await _reap_stale_running_tasks()
    return {"status": "ok"}


# ── Admin secret rotation ────────────────────────────────────────────────────

@router.post("/api/v1/admin/rotate-secret")
async def rotate_admin_secret(request: Request, _admin: AdminDep):
    """Rotate the platform admin secret. Returns the new value once.

    Writes a fresh 32-byte hex string to `nova:config:auth.admin_secret` in
    Redis db 1. All validator services read that key with a 30s cache, so the
    new secret becomes valid cluster-wide within one cache window.

    Recovery: if the stored value ever becomes unusable, operators can run
    `redis-cli -n 1 DEL nova:config:auth.admin_secret` to fall back to the
    bootstrap env value in `NOVA_ADMIN_SECRET`.
    """
    import secrets as _secrets

    import redis.asyncio as aioredis
    from app.auth import _admin_secret_cache, _config_redis_url

    new_secret = _secrets.token_hex(32)  # 64-char hex
    r = aioredis.from_url(_config_redis_url(), decode_responses=True)
    try:
        await r.set("nova:config:auth.admin_secret", new_secret)
    finally:
        await r.aclose()

    # Invalidate local cache so this orchestrator picks up the new value
    # immediately rather than waiting up to 30s.
    _admin_secret_cache["value"] = new_secret
    _admin_secret_cache["ts"] = _time.monotonic()

    client_ip = request.client.host if request.client else "unknown"
    log.warning("Admin secret rotated (ip=%s)", client_ip)

    return {"secret": new_secret}


# ── Startup-task observability ────────────────────────────────────────────────

@router.get("/api/v1/admin/startup-tasks")
async def get_startup_tasks(request: Request, _admin: AdminDep):
    """Background-task status for observability. Used by tests + dashboard.
    Status values: in_progress | complete | failed | unknown."""
    state = request.app.state
    return {
        "mcp_load": getattr(state, "mcp_load_status", {"status": "unknown"}),
    }
