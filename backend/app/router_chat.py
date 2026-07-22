"""Chat + platform API router.

SSE contract for POST /api/v1/chat/stream:
    data: {"meta": {"conversation_id": ..., "model": ...}}
    data: {"t": "text delta"}
    data: {"activity": {"kind": "tool_start|tool_result|dispatch|agent_reply", "name": ..., "agent": ..., "detail": ...}}
    data: {"error": "..."}
    data: [DONE]
"""

import asyncio
import json
import logging
import time
import uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app import automations, compaction, consents, conversations, db, recommendations, rules, settings_store, trace
from app.agents import registry as agent_registry
from app.agents import runner as agent_runner
from app.tools import registry as tool_registry
from app.config import settings
from app.llm.router import effective_model
from app.memory.memory import memory
from app.schemas import ChatRequest

log = logging.getLogger(__name__)

# Capability/platform nodes (core, user, agents, tools, automations, rules) are
# live structure, not dated memories. Stamping them with a per-request time
# churned the brain-graph fingerprint on every 20s poll — rebuilding the whole
# universe view and snapping the camera back to the selected node — and tripped
# the "freshly learned" 24h flare on every capability. One stable value (they
# came online with this instance) keeps the payload identical across polls.
_CAP_MTIME = time.time()

router = APIRouter()

# Appended LAST to the assembled system prompt for voice-initiated turns (via
# run_agent's system_suffix) — the reply is read aloud, so it must be short and
# speakable. Last position matters: patched into the front of the agent prompt
# this got buried mid-prompt and the 8b voice model ignored the emoji ban.
_VOICE_BREVITY = (
    "## This reply will be spoken aloud\n"
    "Answer in one or two short, natural sentences — the way you'd say it "
    "out loud across the room. ABSOLUTELY no tables, lists, headers, "
    "markdown, emoji, or emoticons — none of that can be spoken. Never "
    "speak instruction text or explain where a fact (like the time) came "
    "from. No sign-offs and no offers of more help, even on greetings and "
    "goodbyes: \"goodnight\" gets \"Night — sleep well.\", never "
    "\"Goodnight! If you need anything else, just say the word!\". Give "
    "the answer and stop; if they want more they'll ask."
)


def _sse(obj) -> str:
    return f"data: {json.dumps(obj)}\n\n"


@router.post("/api/v1/chat/stream")
async def chat_stream(request: ChatRequest):
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="message is empty")

    conversation = await conversations.get_or_create_active_conversation()
    conversation_id = conversation["id"]

    main_agent = await agent_registry.get_agent_by_name("main")
    if not main_agent:
        raise HTTPException(status_code=500, detail="main agent missing from registry")

    # Voice-initiated turns: (1) may answer with a dedicated model (Settings →
    # Voice → "Voice reply model"); (2) get the brevity block appended at the
    # END of the assembled prompt (system_suffix), since the reply is read
    # ALOUD. Shallow-copy so the registry dict is never mutated.
    voice_suffix = None
    if request.source == "voice":
        voice_suffix = _VOICE_BREVITY
        override = settings_store.get("voice.model_override")
        if override:
            main_agent = {**main_agent, "model": override}

    model_eff = effective_model(main_agent["model"])
    total_budget = settings_store.get(
        "context.budget_ollama" if model_eff.startswith("ollama:")
        else "context.budget_openrouter")
    # Reserve for system prompt + memory + skills + summary + response headroom.
    overhead = (settings.memory_context_max_chars // 4) + 2500
    history_budget = max(1500, total_budget - overhead)

    history = await conversations.load_history(conversation_id)
    window, _aged = conversations.window_history(history, history_budget)
    window_oldest_at = window[0]["created_at"] if window else None
    turn_messages = conversations.to_llm_history(window) + [
        {"role": "user", "content": request.message}]

    await conversations.append_message(conversation_id, "user", request.message)

    async def generate():
        final_text = ""
        # one ledger trace per chat turn — spans land from run_agent's
        # instrumentation; the assistant message is stamped with the trace id,
        # and meta carries it so the live turn's inspector chip needs no lookup
        async with trace.turn("chat", conversation_id=conversation_id,
                              model=model_eff) as turn:
            yield _sse({"meta": {"conversation_id": conversation_id,
                                 "model": model_eff,
                                 "trace_id": str(turn.id)}})
            try:
                async for event in agent_runner.run_agent(
                        main_agent, turn_messages,
                        conversation_summary=conversation.get("summary"),
                        system_suffix=voice_suffix):
                    etype = event["type"]
                    if etype == "text":
                        yield _sse({"t": event["text"]})
                    elif etype == "activity":
                        yield _sse({"activity": {k: event.get(k) for k in
                                                 ("kind", "name", "agent", "detail")}})
                        # persist tool activity as an audit row (fire and forget)
                        asyncio.ensure_future(conversations.append_message(
                            conversation_id, "tool",
                            content=(event.get("detail") or "")[:2000],
                            tool_calls={"kind": event.get("kind"),
                                        "name": event.get("name"),
                                        "agent": event.get("agent")}))
                    elif etype == "final":
                        final_text = event["text"]
                    elif etype == "error":
                        turn.set_error(event["error"])
                        yield _sse({"error": event["error"]})
            except Exception as e:
                log.exception("chat stream failed")
                turn.set_error(str(e))
                yield _sse({"error": str(e)})

        if final_text.strip():
            try:
                await conversations.append_message(
                    conversation_id, "assistant", final_text,
                    effective_model(main_agent["model"]),
                    metadata={"trace_id": str(turn.id)})
                await memory.write(
                    f"User: {request.message}\n\nNova: {final_text}",
                    type="journal", source_type="chat")
            except Exception:
                log.exception("failed to persist assistant turn")
            asyncio.ensure_future(compaction.maybe_compact(
                conversation_id, main_agent["model"], window_oldest_at))

        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@router.get("/api/v1/conversations/active")
async def get_active_conversation():
    return await conversations.get_or_create_active_conversation()


@router.get("/api/v1/conversations/{conversation_id}/messages")
async def get_messages(conversation_id: str):
    """User/assistant turns plus the persisted activity trail (tool rows) —
    the UI shows past turns' actions as a dim, collapsible trace. Assistant
    rows carry their turn-ledger summary (duration, tool count) when one
    exists, feeding the duration chip → Turn Inspector."""
    history = await conversations.load_history(conversation_id, limit=100)
    out = []
    trace_ids: dict[str, list[dict]] = {}   # trace_id -> messages wearing it
    for m in history:
        if m["role"] in ("user", "assistant") and m["content"]:
            row = {"id": m["id"], "role": m["role"], "content": m["content"],
                   "created_at": m["created_at"]}
            meta = m.get("metadata")
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except ValueError:
                    meta = {}
            tid = (meta or {}).get("trace_id")
            if m["role"] == "assistant" and tid:
                trace_ids.setdefault(tid, []).append(row)
            out.append(row)
        elif m["role"] == "tool" and m["tool_calls"]:
            tc = m["tool_calls"]
            if isinstance(tc, str):
                try:
                    tc = json.loads(tc)
                except ValueError:
                    continue
            out.append({"id": m["id"], "role": "tool", "content": m["content"] or "",
                        "created_at": m["created_at"], "tool_calls": tc})
    if trace_ids:
        async with db.acquire() as conn:
            rows = await conn.fetch(
                """SELECT t.id, t.status,
                          extract(epoch FROM t.finished_at - t.started_at) AS secs,
                          count(s.id) FILTER (WHERE s.kind = 'tool')     AS tools,
                          count(s.id) FILTER (WHERE s.kind = 'dispatch') AS dispatches
                   FROM turn_traces t
                   LEFT JOIN turn_spans s ON s.trace_id = t.id
                   WHERE t.id = ANY($1::uuid[])
                   GROUP BY t.id""",
                list(trace_ids.keys()))
        for r in rows:
            summary = {"id": str(r["id"]), "status": r["status"],
                       "secs": round(float(r["secs"]), 2) if r["secs"] is not None else None,
                       "tools": r["tools"], "dispatches": r["dispatches"]}
            for row in trace_ids[str(r["id"])]:
                row["trace"] = summary
    return out


@router.get("/api/v1/traces")
async def list_traces(limit: int = 50):
    """Recent turn traces across ALL sources (chat, automations,
    compaction) — the Settings → Observability "Recent turns" list.
    Automations show up here with no chat message to click."""
    limit = max(1, min(200, limit))
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT t.id, t.source, t.automation, t.model, t.status,
                      t.started_at,
                      extract(epoch FROM t.finished_at - t.started_at) AS secs,
                      count(s.id) FILTER (WHERE s.kind = 'tool')     AS tools,
                      count(s.id) FILTER (WHERE s.kind = 'dispatch') AS dispatches,
                      count(s.id) FILTER (WHERE s.kind = 'llm_call') AS llm_calls
               FROM turn_traces t
               LEFT JOIN turn_spans s ON s.trace_id = t.id
               GROUP BY t.id
               ORDER BY t.started_at DESC
               LIMIT $1""", limit)
    return [{
        "id": str(r["id"]), "source": r["source"], "automation": r["automation"],
        "model": r["model"], "status": r["status"],
        "started_at": r["started_at"].isoformat(),
        "secs": round(float(r["secs"]), 2) if r["secs"] is not None else None,
        "tools": r["tools"], "dispatches": r["dispatches"],
        "llm_calls": r["llm_calls"],
    } for r in rows]


@router.get("/api/v1/traces/{trace_id}")
async def get_trace(trace_id: str):
    """One turn's full ledger: the trace row + its spans in order — the
    Turn Inspector's data source."""
    try:
        tid = uuid.UUID(trace_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="trace not found")
    async with db.acquire() as conn:
        t = await conn.fetchrow("SELECT * FROM turn_traces WHERE id = $1", tid)
        if not t:
            raise HTTPException(status_code=404, detail="trace not found")
        spans = await conn.fetch(
            "SELECT * FROM turn_spans WHERE trace_id = $1 ORDER BY seq", tid)
    return {
        "trace": {
            "id": str(t["id"]), "source": t["source"],
            "automation": t["automation"],
            "conversation_id": str(t["conversation_id"]) if t["conversation_id"] else None,
            "model": t["model"], "status": t["status"], "error": t["error"],
            "started_at": t["started_at"].isoformat(),
            "finished_at": t["finished_at"].isoformat() if t["finished_at"] else None,
        },
        "spans": [{
            "id": str(s["id"]),
            "parent_span_id": str(s["parent_span_id"]) if s["parent_span_id"] else None,
            "seq": s["seq"], "kind": s["kind"], "name": s["name"],
            "status": s["status"],
            "started_at": s["started_at"].isoformat(),
            "finished_at": s["finished_at"].isoformat() if s["finished_at"] else None,
            "detail": json.loads(s["detail"]) if isinstance(s["detail"], str)
                      else (s["detail"] or {}),
        } for s in spans],
    }


@router.get("/api/v1/agents")
async def list_agents_endpoint():
    return await agent_registry.list_agents(enabled_only=False)


_AGENT_EDITABLE_FIELDS = {"model", "enabled", "description", "system_prompt",
                          "allowed_tools", "routing_keywords"}


@router.patch("/api/v1/agents/{agent_id}")
async def patch_agent_endpoint(agent_id: str, body: dict):
    allowed = {k: v for k, v in body.items() if k in _AGENT_EDITABLE_FIELDS}
    if not allowed:
        raise HTTPException(status_code=422, detail="no editable fields provided")
    if allowed.get("enabled") is False:
        target = next((a for a in await agent_registry.list_agents(enabled_only=False)
                       if a["id"] == agent_id), None)
        if target and target["is_system"]:
            raise HTTPException(
                status_code=403,
                detail="system agents are always active — constrain them with "
                       "rules and tool grants instead")
    if "model" in allowed and ":" not in str(allowed["model"]):
        raise HTTPException(status_code=422,
                            detail="model must be 'openrouter:<id>' or 'ollama:<name>'")
    for k in ("allowed_tools", "routing_keywords"):
        if k in allowed and allowed[k] is not None and not isinstance(allowed[k], list):
            raise HTTPException(status_code=422, detail=f"{k} must be a list or null")
    ok = await agent_registry.update_agent(agent_id, **allowed)
    if not ok:
        raise HTTPException(status_code=404, detail="agent not found")
    return {"status": "updated"}


@router.post("/api/v1/agents", status_code=201)
async def create_agent_endpoint(body: dict):
    name = str(body.get("name", "")).strip()
    description = str(body.get("description", "")).strip()
    system_prompt = str(body.get("system_prompt", "")).strip()
    model = str(body.get("model", "")).strip()
    if not name or not system_prompt or not model:
        raise HTTPException(status_code=422,
                            detail="name, system_prompt, and model are required")
    if ":" not in model:
        raise HTTPException(status_code=422,
                            detail="model must be 'openrouter:<id>' or 'ollama:<name>'")
    try:
        agent_id = await agent_registry.create_agent(
            name=name, description=description, system_prompt=system_prompt,
            model=model, allowed_tools=body.get("allowed_tools"),
            routing_keywords=body.get("routing_keywords"))
    except Exception as e:  # duplicate name etc.
        raise HTTPException(status_code=422, detail=str(e))
    return {"id": agent_id, "name": name}


@router.delete("/api/v1/agents/{agent_id}")
async def delete_agent_endpoint(agent_id: str):
    result = await agent_registry.delete_agent(agent_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="agent not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="system agents can be disabled but never deleted")
    return {"status": "deleted"}


@router.get("/api/v1/models")
async def list_models_endpoint(full: bool = False):
    """Filtered (default): installed local models + approved (curated) cloud
    models. full=true: everything from authenticated providers. Providers
    without credentials never appear in either view."""
    from app import models_catalog
    return await models_catalog.list_models(full=full)


@router.post("/api/v1/models/pull")
async def pull_model_endpoint(body: dict):
    """Pull a new Ollama model — proxies Ollama's native /api/pull, streaming
    progress as SSE. Nova downloads its own local models; no CLI needed."""
    import httpx
    from app import models_catalog

    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=422, detail="model name is required")
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")

    async def generate():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", f"{base}/api/pull",
                                         json={"name": name}) as resp:
                    if resp.status_code != 200:
                        detail = (await resp.aread()).decode(errors="replace")[:200]
                        yield _sse({"error": f"pull failed: {detail}"})
                        return
                    async for line in resp.aiter_lines():
                        if line.strip():
                            yield f"data: {line}\n\n"
        except httpx.HTTPError as e:
            yield _sse({"error": f"cannot reach Ollama at {base}: {e}"})
            return
        models_catalog.invalidate()
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ── model recommendations (designed 2026-07-14) ──────────────────────────

@router.get("/api/v1/hardware")
async def hardware_endpoint():
    from app import hardware
    return await hardware.detect()


@router.get("/api/v1/models/recommendations")
async def model_recommendations_endpoint(mode: str = "hybrid"):
    """mode = hybrid (default) | local (self-hosted only) | cloud (prefer cloud,
    local fallback only where no configured provider serves a role)."""
    from app import model_recs
    return await model_recs.recommendations(mode=mode)


@router.get("/api/v1/models/budget")
async def model_budget_endpoint():
    """Concurrent-load math for the CURRENT assignments — what memory looks
    like if every assigned local model is loaded at once."""
    from app import model_recs
    return await model_recs.current_budget()


@router.post("/api/v1/models/test")
async def model_test_endpoint(body: dict):
    """Probe a model on this machine: TTFT/tok_s plus a mechanically verified
    tool call. Never pulls — an uninstalled model comes back as an error."""
    from app import model_recs
    model = str(body.get("model", "")).strip()
    if ":" not in model:
        raise HTTPException(status_code=422,
                            detail="model must be 'openrouter:<id>' or 'ollama:<name>'")
    return await model_recs.probe(model)


@router.get("/api/v1/models/curated")
async def list_curated_endpoint():
    from app import curated_models
    return await curated_models.list_all()


@router.post("/api/v1/models/curated", status_code=201)
async def create_curated_endpoint(body: dict):
    from app import curated_models
    try:
        return await curated_models.create(
            model=str(body.get("model", "")),
            provider=str(body.get("provider", "")),
            **{k: body[k] for k in
               ("min_ram_gb", "min_vram_gb", "tool_tier", "speed", "roles",
                "use_cases", "notes")
               if k in body})
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:  # duplicate model etc.
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/models/curated/{row_id}")
async def patch_curated_endpoint(row_id: str, body: dict):
    from app import curated_models
    try:
        result = await curated_models.update(row_id, **body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if result == "not_found":
        raise HTTPException(status_code=404, detail="curated model not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="seeded rows can be toggled but not rewritten")
    return {"status": "updated"}


@router.delete("/api/v1/models/curated/{row_id}")
async def delete_curated_endpoint(row_id: str):
    from app import curated_models
    result = await curated_models.delete(row_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="curated model not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="seeded rows can be disabled but not deleted")
    return {"status": "deleted"}


# ── LLM providers (Settings → Models → Providers) — bring-your-own key /
#    endpoint registry. Operator-only; agents never touch provider config.
#    API keys are stored server-side and NEVER returned (the list is redacted
#    to key_set + last-4). ─────────────────────────────────────────────────

@router.get("/api/v1/providers")
async def list_providers_endpoint():
    from app.llm import providers
    return providers.list_public()


@router.get("/api/v1/providers/presets")
async def provider_presets_endpoint():
    from app.llm import providers
    return providers.PRESETS


@router.post("/api/v1/providers", status_code=201)
async def create_provider_endpoint(body: dict):
    from app.llm import providers
    try:
        return await providers.create(
            slug=str(body.get("slug", "")),
            label=str(body.get("label", "")),
            base_url=str(body.get("base_url", "")),
            **{k: body[k] for k in
               ("kind", "api_key", "extra_headers", "catalog_path",
                "needs_key", "enabled") if k in body})
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/providers/{provider_id}")
async def patch_provider_endpoint(provider_id: str, body: dict):
    from app.llm import providers
    try:
        result = await providers.update(provider_id, **body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if result == "not_found":
        raise HTTPException(status_code=404, detail="provider not found")
    if result == "no_fields":
        raise HTTPException(status_code=422, detail="no editable fields provided")
    return {"status": "updated"}


@router.delete("/api/v1/providers/{provider_id}")
async def delete_provider_endpoint(provider_id: str):
    from app.llm import providers
    result = await providers.delete(provider_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="provider not found")
    if result == "is_system":
        raise HTTPException(
            status_code=403,
            detail="the seeded OpenRouter provider can be edited or disabled "
                   "but not deleted")
    return {"status": "deleted"}


@router.post("/api/v1/providers/{provider_id}/test")
async def test_provider_endpoint(provider_id: str):
    from app.llm import providers
    return await providers.check(provider_id)  # reaches AND stamps the health dot


# ── MCP servers (docs/plans/mcp-client.md) — operator-only registry.
#    No agent-facing tool exists here on purpose: an agent that could
#    register a server could grant itself arbitrary capabilities. ───────

@router.get("/api/v1/mcp/servers")
async def list_mcp_servers_endpoint():
    from app import mcp_servers
    return await mcp_servers.list_all()


@router.get("/api/v1/mcp/servers/{server_id}/tools")
async def list_mcp_server_tools_endpoint(server_id: str):
    from app import mcp_servers
    return await mcp_servers.list_tools_for(server_id)


@router.post("/api/v1/mcp/servers", status_code=201)
async def create_mcp_server_endpoint(body: dict):
    from app import mcp_servers
    try:
        return await mcp_servers.create(
            name=str(body.get("name", "")),
            transport=str(body.get("transport", "")),
            **{k: body[k] for k in ("url", "command", "args", "headers") if k in body})
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:  # duplicate name etc.
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/mcp/servers/{server_id}")
async def patch_mcp_server_endpoint(server_id: str, body: dict):
    from app import mcp_servers
    try:
        result = await mcp_servers.update(server_id, **body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if result == "not_found":
        raise HTTPException(status_code=404, detail="MCP server not found")
    # a field change or an enable flip needs a fresh connect to take effect
    connection_fields = {"url", "command", "args", "headers", "enabled"}
    if connection_fields & set(body) and body.get("enabled", True):
        return await mcp_servers.refresh(server_id)
    return await mcp_servers.get(server_id)


@router.delete("/api/v1/mcp/servers/{server_id}")
async def delete_mcp_server_endpoint(server_id: str):
    from app import mcp_servers
    result = await mcp_servers.delete(server_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="MCP server not found")
    return {"status": "deleted"}


@router.post("/api/v1/mcp/servers/{server_id}/approve")
async def approve_mcp_server_endpoint(server_id: str):
    from app import mcp_servers
    try:
        return await mcp_servers.approve(server_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── skills (operator surface; agents use write_memory type='skill') ──────

@router.get("/api/v1/skills")
async def list_skills_endpoint():
    return await memory.list_skills()


@router.post("/api/v1/skills", status_code=201)
async def create_skill_endpoint(body: dict):
    title = str(body.get("title", "")).strip()
    content = str(body.get("content", "")).strip()
    if not title or not content:
        raise HTTPException(status_code=422, detail="title and content are required")
    result = await memory.write(
        content, type="skill", title=title,
        description=str(body.get("description", "")).strip() or None,
        category=str(body.get("category", "")).strip() or None,
        source_type="operator")
    if result.get("status") != "written":
        raise HTTPException(status_code=422, detail=result.get("error", "write failed"))
    return result


@router.put("/api/v1/skills/{skill_id:path}")
async def update_skill_endpoint(skill_id: str, body: dict):
    if not skill_id.startswith("skills/"):
        raise HTTPException(status_code=404, detail="not a skill")
    existing = await memory.read_item(skill_id)
    if not existing:
        raise HTTPException(status_code=404, detail="skill not found")
    title = str(body.get("title", "")).strip() \
        or existing["frontmatter"].get("title", skill_id)
    content = str(body.get("content", "")).strip() or existing["content"]
    result = await memory.write(
        content, type="skill", title=title, item_id=skill_id,
        description=str(body.get("description", "")).strip()
        or existing["frontmatter"].get("description"),
        category=existing["frontmatter"].get("category"),
        source_type="operator")
    if result.get("status") != "written":
        raise HTTPException(status_code=422, detail=result.get("error", "write failed"))
    return result


@router.delete("/api/v1/skills/{skill_id:path}")
async def delete_skill_endpoint(skill_id: str):
    if not skill_id.startswith("skills/"):
        raise HTTPException(status_code=404, detail="not a skill")
    if not await memory.delete_item(skill_id):
        raise HTTPException(status_code=404, detail="skill not found")
    return {"status": "deleted"}


@router.post("/api/v1/models/uninstall")
async def uninstall_model_endpoint(body: dict):
    """Remove an installed Ollama model (native /api/delete). Refuses while
    any agent or setting still points at it — uninstalling a model in use
    would break those turns at request time."""
    import httpx
    from app import models_catalog

    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=422, detail="model name is required")

    model_id = f"ollama:{name}"
    users = [a["name"] for a in await agent_registry.list_agents(enabled_only=False)
             if a["model"] == model_id]
    if settings_store.get("compaction.model") == model_id:
        users.append("compaction (setting)")
    if settings_store.get("inference.local_fallback_model") == name:
        users.append("local fallback (setting)")
    if users:
        raise HTTPException(
            status_code=409,
            detail=f"'{name}' is in use by: {', '.join(users)} — reassign first")

    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request("DELETE", f"{base}/api/delete",
                                        json={"name": name})
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"cannot reach Ollama: {e}")
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail=f"'{name}' is not installed")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code,
                            detail=resp.text[:200] or "uninstall failed")
    models_catalog.invalidate()
    return {"status": "uninstalled", "name": name}


@router.get("/api/v1/auth/token")
async def auth_token_endpoint():
    """The admin token, for the phone-setup QR. Reachable only by callers
    the middleware already trusts: this machine (which can read .env
    anyway) or a device that presented the token to get here."""
    return {"token": settings.nova_auth_token or ""}


@router.get("/api/v1/storage")
async def storage_info_endpoint():
    """Where memory and model weights physically live. Both are bind mounts
    resolved at container-create time — the UI can show and verify memory, but
    changing either is a deployment action by nature (.env + `docker compose
    up -d`). Model weights live on other containers, so we can only report the
    configured path, not verify it from here."""
    import os
    models_dir = _effective_models_dir()
    return {
        "host_path": os.environ.get("NOVA_MEMORY_DIR_HOST", "./data/memory"),
        "container_path": settings.okf_memory_dir,
        "writable": os.access(settings.okf_memory_dir, os.W_OK),
        "counts": await memory.stats(),
        # empty NOVA_MODELS_DIR = default docker-managed volumes; a set path
        # means the operator relocated the bundled model store (ollama/kokoro/
        # whisper subdirs) onto that host path via docker-compose.models.yml.
        "models": {
            "host_path": models_dir or None,
            "relocated": bool(models_dir),
        },
    }


# ── brain graph: memory + platform entities (the full map of what Nova IS) ─

@router.get("/api/v1/brain/graph")
async def brain_graph_endpoint(platform: bool = True):
    """Knowledge/experience (the memory graph) merged — when platform=true —
    with capabilities and behaviors as first-class nodes: agents, granted
    tools, automations, rules. Real edges only (grants, executors, guard
    targets), never decoration."""
    g = await memory.graph()
    if not platform:
        return g
    nodes, edges = g["nodes"], g["edges"]
    mem_nodes = list(nodes)   # snapshot before platform nodes join the list

    nodes.append({"id": "nova", "label": "Nova", "type": "core", "mtime": _CAP_MTIME,
                  "description": "The coordinating mind — main is the front "
                                 "door; every specialist hangs off it."})

    # The operator is a first-class node: Nova exists in relation to a person.
    # Universe draws the pair as a binary star; older themes get a color entry.
    user_name = str(settings_store.get("nova.user_name") or "").strip()
    nodes.append({"id": "user", "label": user_name or "You", "type": "user",
                  "mtime": _CAP_MTIME,
                  "description": "The operator — the human this mind works "
                                 "with. Everything here exists in orbit "
                                 "around this relationship."})
    edges.append({"source": "nova", "target": "user", "kind": "bond"})

    agents = await agent_registry.list_agents(enabled_only=False)
    catalog = await tool_registry.list_all_tools()
    db_tool_names = [t["name"] for t in catalog["db_tools"]]
    builtin_names = [b["name"] for b in catalog["builtins"]]
    tool_desc = {t["name"]: t["description"] for t in catalog["db_tools"]}
    tool_desc.update({b["name"]: b["description"] for b in catalog["builtins"]})

    granted: dict[str, list[str]] = {}  # tool name -> agent names using it
    for a in agents:
        names: list[str] = []
        for t in (a["allowed_tools"] or builtin_names):  # null grant = all builtins
            if t == "db:*":
                names.extend(db_tool_names)
            elif t.startswith("db:"):
                names.append(t[3:])
            else:
                names.append(t)
        for t in names:
            granted.setdefault(t, []).append(a["name"])

    for a in agents:
        nodes.append({"id": f"agent:{a['name']}", "label": a["name"],
                      "type": "agent", "mtime": _CAP_MTIME, "enabled": a["enabled"],
                      "description": a["description"]})
        edges.append({"source": "nova", "target": f"agent:{a['name']}",
                      "kind": "platform"})

    for tool_name, users in granted.items():
        nodes.append({"id": f"tool:{tool_name}", "label": tool_name,
                      "type": "tool", "mtime": _CAP_MTIME,
                      "description": tool_desc.get(tool_name, "")})
        for user in users:
            edges.append({"source": f"agent:{user}",
                          "target": f"tool:{tool_name}", "kind": "grant"})

    for auto in await automations.list_automations():
        nodes.append({"id": f"automation:{auto['name']}", "label": auto["name"],
                      "type": "automation", "mtime": _CAP_MTIME,
                      "enabled": auto["enabled"],
                      "interval_minutes": auto.get("interval_minutes"),
                      "description": auto.get("description")
                      or (auto.get("instruction") or "")[:200]})
        edges.append({"source": f"automation:{auto['name']}",
                      "target": f"agent:{auto['agent_name']}", "kind": "platform"})

    node_ids = {n["id"] for n in nodes}
    for r in await rules.list_rules():
        nodes.append({"id": f"rule:{r['name']}", "label": r["name"],
                      "type": "rule", "mtime": _CAP_MTIME, "enabled": r["enabled"],
                      "description": r.get("description", "")})
        for t in (r.get("target_tools") or []):
            if f"tool:{t}" in node_ids:
                edges.append({"source": f"rule:{r['name']}",
                              "target": f"tool:{t}", "kind": "guard"})
        for aname in (r.get("target_agents") or []):
            if f"agent:{aname}" in node_ids:
                edges.append({"source": f"rule:{r['name']}",
                              "target": f"agent:{aname}", "kind": "guard"})

    # relationship edges from memory frontmatter markers (#28). Personal
    # facts arc to the operator's star; automations arc to the documents
    # they maintain. Only edges whose platform endpoint actually exists —
    # a stale maintained_by (deleted automation) must not dangle.
    for n in mem_nodes:
        if n.get("about") == "user":
            edges.append({"source": n["id"], "target": "user", "kind": "about"})
        maintainer = n.get("maintained_by")
        if maintainer and f"automation:{maintainer}" in node_ids:
            edges.append({"source": f"automation:{maintainer}",
                          "target": n["id"], "kind": "writes"})

    return {"nodes": nodes, "edges": edges}


@router.get("/api/v1/memory/stats")
async def memory_stats():
    return await memory.stats()


@router.get("/api/v1/memory/graph")
async def memory_graph():
    return await memory.graph()


@router.get("/api/v1/memory/item/{item_id:path}")
async def memory_item(item_id: str):
    item = await memory.read_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="memory item not found")
    return item


@router.delete("/api/v1/memory/item/{item_id:path}")
async def delete_memory_item(item_id: str):
    if item_id == "soul.md":
        raise HTTPException(status_code=403, detail="the soul is not deletable")
    if not await memory.delete_item(item_id):
        raise HTTPException(status_code=404, detail="memory item not found")
    return {"status": "deleted"}


# ── bundled inference (docker control via the inference-control sidecar) ─

@router.get("/api/v1/inference/bundled")
async def bundled_inference_status():
    """Container state from the sidecar + a direct API probe. Fail-soft:
    without the sidecar the UI simply hides the toggle."""
    import httpx

    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            resp = await client.get(f"{settings.inference_control_url}/status")
            resp.raise_for_status()
            status = resp.json()
        except Exception as e:
            log.warning("inference-control unreachable: %s", e)
            return {"available": False}
        api_ok = False
        if status.get("running"):
            try:
                r = await client.get(f"{settings.bundled_ollama_url}/api/tags")
                api_ok = r.status_code == 200
            except httpx.HTTPError:
                pass
    return {"available": True, "api_ok": api_ok, **status}


@router.post("/api/v1/inference/bundled")
async def bundled_inference_action(body: dict):
    import httpx
    from app import models_catalog

    action = str(body.get("action", "")).strip()
    if action not in ("start", "stop"):
        raise HTTPException(status_code=422, detail="action must be 'start' or 'stop'")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{settings.inference_control_url}/{action}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502,
                            detail=f"inference-control sidecar unreachable: {e}")
    if resp.status_code not in (200, 202):
        try:
            detail = resp.json().get("error", resp.text)
        except ValueError:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    models_catalog.invalidate()  # the ollama model list is about to change
    return resp.json()


# ── model storage location (relocate the bundled store from the UI) ──────

STATE_MODELS_FILE = "/state/models_dir"


def _effective_models_dir() -> str:
    """Operator-chosen host path for the bundled model store, or '' for the
    default docker volume. The UI state file is authoritative when present
    (even empty = an explicit "use the default"); otherwise the deployment-time
    NOVA_MODELS_DIR applies. Mirrors the sidecar's own resolution."""
    import os
    try:
        with open(STATE_MODELS_FILE) as f:
            return f.read().strip()
    except OSError:
        return os.environ.get("NOVA_MODELS_DIR", "").strip()


@router.get("/api/v1/inference/models-dir")
async def get_models_dir():
    """Where the bundled model weights live. Read-only view; POST to change."""
    path = _effective_models_dir()
    return {"path": path or None, "relocated": bool(path)}


@router.post("/api/v1/inference/models-dir")
async def set_models_dir(body: dict):
    """Relocate the bundled model store. Writes the chosen absolute host path to
    the shared control file and asks the sidecar to migrate + recreate ollama
    there (non-destructive: the old copy is kept). Empty path resets to the
    default docker volume. Operator surface only — agents never reach settings,
    and the socket-holding sidecar reads this file read-only, so a path can only
    be set here."""
    import os
    import httpx

    path = str(body.get("path", "")).strip()
    if path and not (path.startswith("/") and os.path.isabs(path)):
        raise HTTPException(status_code=422,
                            detail="path must be an absolute host path (e.g. /mnt/ssd/nova-models)")
    if ".." in path.split("/"):
        raise HTTPException(status_code=422, detail="path must not contain '..'")
    try:
        os.makedirs(os.path.dirname(STATE_MODELS_FILE), exist_ok=True)
        with open(STATE_MODELS_FILE, "w") as f:
            f.write(path)
    except OSError as e:
        raise HTTPException(status_code=500,
                            detail=f"could not write control file: {e}")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{settings.inference_control_url}/relocate")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502,
                            detail=f"inference-control sidecar unreachable: {e}")
    if resp.status_code not in (200, 202):
        try:
            detail = resp.json().get("error", resp.text)
        except ValueError:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return {"path": path or None, "relocated": bool(path), "status": "relocating"}


# ── tools (operator surface; agents use the manage_tools builtin) ────────

@router.get("/api/v1/tools")
async def list_tools_endpoint():
    return await tool_registry.list_all_tools()


@router.post("/api/v1/tools", status_code=201)
async def create_tool_endpoint(body: dict):
    try:
        return await tool_registry.create_http_tool(
            name=str(body.get("name", "")),
            description=str(body.get("description", "")),
            url_template=str(body.get("url_template", "")),
            method=str(body.get("method", "GET")),
            parameters_schema=body.get("parameters_schema"))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/tools/{tool_id}")
async def patch_tool_endpoint(tool_id: str, body: dict):
    # enable/disable is the only patchable field — always allowed
    if set(body) != {"enabled"} or not isinstance(body["enabled"], bool):
        raise HTTPException(status_code=422, detail="only {'enabled': bool} is editable")
    ok = await tool_registry.set_tool_enabled(tool_id, body["enabled"])
    if not ok:
        raise HTTPException(status_code=404, detail="tool not found")
    return {"status": "updated"}


@router.delete("/api/v1/tools/{tool_id}")
async def delete_tool_endpoint(tool_id: str):
    result = await tool_registry.delete_tool(tool_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="tool not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="system tools can be disabled but not deleted")
    return {"status": "deleted"}


# ── settings (UI-configured runtime behavior) ────────────────────────────

@router.get("/api/v1/settings")
async def get_settings():
    return settings_store.all_settings()


@router.patch("/api/v1/settings")
async def patch_settings(changes: dict):
    applied = {}
    for key, value in changes.items():
        try:
            await settings_store.set_value(key, value)
            applied[key] = value
        except (KeyError, ValueError) as e:
            raise HTTPException(status_code=422, detail=str(e))
    return {"applied": applied}


@router.post("/api/v1/notify/test")
async def notify_test():
    """Send a real test notification through the configured provider, so the
    operator can confirm setup from Settings. Returns notify.send's honest
    result verbatim ({ok, id?, error?, provider?}) — server ACCEPTANCE, not
    proof it reached the device."""
    from app import notify
    return await notify.send(
        "Test notification from Nova — if this reached you, notifications are wired up.",
        title="Nova test", tags=["bell"])


@router.get("/api/v1/notify/reachability")
async def notify_reachability():
    """Read-only diagnostic of the notification delivery path (roadmap #21
    reachability, phase 1). Reports whether it's configured, whether the server
    is reachable from Nova, and the EXACT url + topic the operator's phone
    needs — honestly separating what Nova verifies from what only the operator
    can (the tailnet side). `ok: null` = Nova can't check this from here."""
    import re
    import httpx

    provider = settings_store.get("notify.provider")
    enabled = bool(settings_store.get("notify.enabled"))
    out: dict = {"provider": provider, "enabled": enabled, "checks": [], "phone": None}

    if provider == "webhook":
        url = (settings_store.get("notify.webhook.url") or "").strip()
        out["checks"] = [
            {"label": "Notifications enabled", "ok": enabled},
            {"label": "Webhook URL set", "ok": bool(url), "detail": url or "not set"},
        ]
        out["note"] = ("Webhook posts JSON to your URL — verify delivery on the "
                       "receiving end (Slack/Discord/Zapier/your endpoint).")
        return out

    # ── ntfy ──
    mode = settings_store.get("notify.ntfy.server_mode")
    topic = (settings_store.get("notify.ntfy.topic") or "").strip()
    if mode == "builtin":
        publish_url = settings.ntfy_builtin_url
        pub = (settings_store.get("ui.public_url") or "").strip().rstrip("/")
        host = re.sub(r":\d+$", "", pub) if pub else ""
        phone_url = f"{host}:8443" if host else ""
    elif mode == "custom":
        publish_url = (settings_store.get("notify.ntfy.custom_url") or "").strip()
        phone_url = publish_url
    else:
        publish_url = phone_url = "https://ntfy.sh"

    reachable, detail = False, "no server URL"
    if publish_url:
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(f"{publish_url.rstrip('/')}/v1/health")
            reachable = r.status_code == 200
            detail = (f"reached {publish_url}" if reachable
                      else f"{publish_url} returned HTTP {r.status_code}")
        except Exception as e:  # noqa: BLE001 — report, never raise
            detail = f"could not reach {publish_url} ({type(e).__name__})"

    checks = [
        {"label": "Notifications enabled", "ok": enabled},
        {"label": "Topic set", "ok": bool(topic),
         "detail": topic or "no topic yet — use Randomize"},
        {"label": "ntfy server reachable from Nova", "ok": reachable, "detail": detail},
    ]
    if mode == "builtin":
        checks.append({"label": "Phone URL derived from your public URL",
                       "ok": bool(phone_url),
                       "detail": phone_url or "set your public URL (Phone setup) first"})
        # real tailnet-route status from the sidecar (live `tailscale serve`
        # read); neutral only when the control sidecar isn't present
        route_ok, route_detail = None, "control sidecar unavailable — can't check the route"
        try:
            async with httpx.AsyncClient(timeout=8.0) as c:
                r = await c.get(f"{settings.inference_control_url}/notify/status")
            if r.status_code == 200:
                route_ok = bool(r.json().get("tailnet_route"))
                route_detail = ("served on your tailnet at :8443" if route_ok
                                else "not served — Start the self-hosted server below "
                                     "(or bring up the tailscale profile)")
        except Exception:  # noqa: BLE001
            pass
        checks.append({"label": "Exposed on your tailnet (:8443)",
                       "ok": route_ok, "detail": route_detail})
    out["checks"] = checks
    out["phone"] = {"server_url": phone_url, "topic": topic}
    return out


STATE_NTFY_BASE_URL_FILE = "/state/ntfy_base_url"


def _ntfy_phone_url() -> str:
    """The URL a phone must subscribe to for the current ntfy server mode. For
    builtin it's DERIVED from Nova's own public URL (host + the ntfy tailnet
    port), so it can't drift out of sync with ntfy's base-url — the mismatch
    that silently breaks iOS background push. Empty when not derivable."""
    import re
    mode = settings_store.get("notify.ntfy.server_mode")
    if mode == "builtin":
        pub = (settings_store.get("ui.public_url") or "").strip().rstrip("/")
        host = re.sub(r":\d+$", "", pub) if pub else ""
        return f"{host}:8443" if host else ""
    if mode == "custom":
        return (settings_store.get("notify.ntfy.custom_url") or "").strip()
    return "https://ntfy.sh"


@router.get("/api/v1/notify/service")
async def notify_service_status():
    """State of the self-hosted notification services (ntfy + tailscale), via the
    socket-holding inference-control sidecar. {available:false} when the sidecar
    isn't present, so the UI can hide the controls."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{settings.inference_control_url}/notify/status")
            resp.raise_for_status()
            status = resp.json()
    except Exception as e:  # noqa: BLE001
        log.warning("inference-control unreachable: %s", e)
        return {"available": False}
    return {"available": True, "phone_url": _ntfy_phone_url(), **status}


@router.post("/api/v1/notify/service")
async def notify_service_action(body: dict):
    """Start/stop the self-hosted ntfy service from the UI (roadmap #21
    reachability, phases 2-3). On 'up', Nova derives the correct base-url from
    its own public URL and writes it to the shared control file so the sidecar
    recreates ntfy with it — the phone-URL vs base-url mismatch that breaks iOS
    background push can no longer happen. Operator surface only; the socket
    -holding sidecar reads the control file read-only."""
    import os
    import httpx

    action = str(body.get("action", "")).strip()
    if action not in ("up", "down", "expose"):
        raise HTTPException(status_code=422,
                            detail="action must be 'up', 'down', or 'expose'")

    if action == "up":
        # only the self-hosted (builtin) server's base-url is ours to set; for
        # public/custom we don't run the server, so clear the control file
        base_url = (_ntfy_phone_url()
                    if settings_store.get("notify.ntfy.server_mode") == "builtin" else "")
        try:
            os.makedirs(os.path.dirname(STATE_NTFY_BASE_URL_FILE), exist_ok=True)
            with open(STATE_NTFY_BASE_URL_FILE, "w") as f:
                f.write(base_url)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"could not write control file: {e}")

    path = {"up": "/notify/up", "down": "/notify/down", "expose": "/notify/expose"}[action]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{settings.inference_control_url}{path}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502,
                            detail=f"inference-control sidecar unreachable: {e}")
    if resp.status_code not in (200, 202):
        try:
            detail = resp.json().get("error", resp.text)
        except ValueError:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return resp.json()


# ── automations ──────────────────────────────────────────────────────────

@router.get("/api/v1/automations")
async def list_automations_endpoint():
    return await automations.list_automations()


@router.get("/api/v1/automations/{automation_id}/runs")
async def list_automation_runs_endpoint(automation_id: str, limit: int = 20):
    try:
        return await automations.list_runs(automation_id, limit=limit)
    except ValueError:
        raise HTTPException(status_code=404, detail="automation not found")


@router.post("/api/v1/automations", status_code=201)
async def create_automation_endpoint(body: dict):
    try:
        return await automations.create(
            name=str(body.get("name", "")).strip(),
            instruction=str(body.get("instruction", "")).strip(),
            agent_name=str(body.get("agent_name", "")).strip(),
            interval_minutes=int(body.get("interval_minutes", 0)),
            description=str(body.get("description", "")),
            timeout_seconds=(int(body["timeout_seconds"])
                             if body.get("timeout_seconds") else None))
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/automations/{automation_id}")
async def patch_automation_endpoint(automation_id: str, body: dict):
    ok = await automations.update(automation_id, **body)
    if not ok:
        raise HTTPException(status_code=404, detail="automation not found or no valid fields")
    return {"status": "updated"}


@router.delete("/api/v1/automations/{automation_id}")
async def delete_automation_endpoint(automation_id: str):
    result = await automations.delete(automation_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="automation not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="system automations can be disabled but not deleted")
    return {"status": "deleted"}


# ── guardrail rules ──────────────────────────────────────────────────────

@router.get("/api/v1/rules")
async def list_rules_endpoint():
    return await rules.list_rules()


@router.post("/api/v1/rules", status_code=201)
async def create_rule_endpoint(body: dict):
    try:
        return await rules.create(
            name=str(body.get("name", "")).strip(),
            pattern=str(body.get("pattern", "")),
            action=str(body.get("action", "block")),
            description=str(body.get("description", "")),
            target_tools=body.get("target_tools"),
            target_agents=body.get("target_agents"))
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/rules/{rule_id}")
async def patch_rule_endpoint(rule_id: str, body: dict):
    try:
        ok = await rules.update(rule_id, **body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="rule not found or no valid fields")
    return {"status": "updated"}


@router.delete("/api/v1/rules/{rule_id}")
async def delete_rule_endpoint(rule_id: str):
    result = await rules.delete(rule_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="rule not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="system protections can be disabled but not deleted")
    return {"status": "deleted"}


# ── operator consents (guarded destructive actions, roadmap #29) ─────────

@router.get("/api/v1/consents")
async def list_consents_endpoint(conversation_id: str | None = None):
    """Fresh pending consents — the chat UI renders these as decision cards.

    Each rule.* consent is enriched with the rule's AUTHORITATIVE facts from
    the database (2026-07-20 hardening): the card must show what approving
    actually touches, not the requesting agent's summary of it — an agent
    that read attacker-influenced content could word the question
    misleadingly, but it cannot forge this block."""
    rows = await consents.list_pending(conversation_id)
    for row in rows:
        if row["kind"].startswith("rule."):
            rule = await rules.get_by_name(row["subject"])
            row["rule"] = None if not rule else {
                k: rule[k] for k in ("description", "pattern", "action",
                                     "target_tools", "enabled", "is_system",
                                     "hit_count")}
    return rows


@router.post("/api/v1/consents/{consent_id}/decide")
async def decide_consent_endpoint(consent_id: str, body: dict):
    """The operator's authenticated click. This endpoint is the ONLY writer
    of approvals — agents can request consents but never decide them."""
    chosen = str(body.get("chosen", "")).lower()
    if chosen not in ("approve", "deny"):
        raise HTTPException(status_code=422, detail="chosen must be 'approve' or 'deny'")
    row = await consents.decide(consent_id, chosen)
    if not row:
        raise HTTPException(status_code=410,
                            detail="consent is no longer pending (expired or already decided)")
    return row


# ── ingestion queue: the durable background ingest lane (migration 041) ──────
#    follow_source / poll only ENQUEUE; ingest_worker drains this. These
#    endpoints are the operator's live, per-item view of that work — the
#    detailed trail the turn-ledger couldn't give (it died with a killed turn).

@router.get("/api/v1/ingest/summary")
async def ingest_summary_endpoint():
    """Counts by status + the most-recently-touched jobs — the Ingestion panel's
    one poll. queued/running = live work; done/failed/skipped = the trail."""
    from app import ingest_jobs
    return await ingest_jobs.summary()


@router.get("/api/v1/ingest/jobs")
async def ingest_jobs_endpoint(status: str | None = None, limit: int = 100):
    """Full job list, optionally filtered by status (queued|running|done|
    skipped|failed)."""
    from app import ingest_jobs
    limit = max(1, min(500, limit))
    async with db.acquire() as conn:
        if status:
            rows = await conn.fetch(
                "SELECT * FROM ingest_jobs WHERE status = $1 "
                "ORDER BY COALESCE(finished_at, started_at, enqueued_at) DESC "
                "LIMIT $2", status, limit)
        else:
            rows = await conn.fetch(
                "SELECT * FROM ingest_jobs "
                "ORDER BY COALESCE(finished_at, started_at, enqueued_at) DESC "
                "LIMIT $1", limit)
    return [dict(r) for r in rows]


@router.post("/api/v1/ingest/jobs/{job_id}/retry")
async def ingest_retry_endpoint(job_id: str):
    """Requeue a failed/skipped job so the worker tries it again — the 'continue'
    control for anything that didn't land."""
    from app import ingest_jobs
    try:
        jid = uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="job not found")
    row = await ingest_jobs.retry(jid)
    if not row:
        raise HTTPException(status_code=409,
                            detail="job is not in a retryable state (failed/skipped)")
    return dict(row)


# ── recommendations: Nova's proactive cards (docs/plans/recommendation-surface.md) ─

@router.get("/api/v1/recommendations")
async def list_recommendations_endpoint(status: str = "new"):
    """Proactive recommendations raised by Nova/automations. status=new is the
    live queue the chat banner shows; status=all is the inbox view (decided
    rows included, actionable first)."""
    return await recommendations.list_all("all" if status == "all" else "new")


@router.post("/api/v1/recommendations/{rec_id}/decide")
async def decide_recommendation_endpoint(rec_id: str, body: dict):
    """The operator's authenticated decision. Agents RAISE recommendations
    (raise_recommendation tool) but only the operator decides — this endpoint
    is the only writer of the outcome, never reachable by an agent."""
    choice = str(body.get("choice", "")).lower()
    if choice not in ("approve", "later", "dismiss"):
        raise HTTPException(status_code=422,
                            detail="choice must be 'approve', 'later', or 'dismiss'")
    row = await recommendations.decide(rec_id, choice)
    if not row:
        raise HTTPException(status_code=404, detail="recommendation not found")
    return row
