"""Chat + platform API router.

SSE contract for POST /api/v1/chat/stream:
    data: {"meta": {"conversation_id": ..., "model": ...}}
    data: {"t": "text delta"}
    data: {"activity": {"kind": "tool_start|tool_result|dispatch", "name": ..., "agent": ..., "detail": ...}}
    data: {"error": "..."}
    data: [DONE]
"""

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app import automations, compaction, conversations, rules, settings_store
from app.agents import registry as agent_registry
from app.agents import runner as agent_runner
from app.config import settings
from app.llm.router import effective_model
from app.memory.memory import memory
from app.schemas import ChatRequest

log = logging.getLogger(__name__)

router = APIRouter()


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
        yield _sse({"meta": {"conversation_id": conversation_id,
                             "model": effective_model(main_agent["model"])}})
        final_text = ""
        try:
            async for event in agent_runner.run_agent(
                    main_agent, turn_messages,
                    conversation_summary=conversation.get("summary")):
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
                    yield _sse({"error": event["error"]})
        except Exception as e:
            log.exception("chat stream failed")
            yield _sse({"error": str(e)})

        if final_text.strip():
            try:
                await conversations.append_message(
                    conversation_id, "assistant", final_text,
                    effective_model(main_agent["model"]))
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
    history = await conversations.load_history(conversation_id, limit=100)
    return [m for m in history if m["role"] in ("user", "assistant") and m["content"]]


@router.get("/api/v1/agents")
async def list_agents_endpoint():
    return await agent_registry.list_agents(enabled_only=False)


@router.patch("/api/v1/agents/{agent_id}")
async def patch_agent_endpoint(agent_id: str, body: dict):
    # operator-editable subset; model changes apply on the next turn
    allowed = {k: v for k, v in body.items()
               if k in ("model", "enabled", "description")}
    if not allowed:
        raise HTTPException(status_code=422, detail="no editable fields provided")
    if "model" in allowed and ":" not in str(allowed["model"]):
        raise HTTPException(status_code=422,
                            detail="model must be 'openrouter:<id>' or 'ollama:<name>'")
    ok = await agent_registry.update_agent(agent_id, **allowed)
    if not ok:
        raise HTTPException(status_code=404, detail="agent not found")
    return {"status": "updated"}


@router.get("/api/v1/models")
async def list_models_endpoint():
    from app import models_catalog
    return await models_catalog.list_models()


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


# ── automations ──────────────────────────────────────────────────────────

@router.get("/api/v1/automations")
async def list_automations_endpoint():
    return await automations.list_automations()


@router.post("/api/v1/automations", status_code=201)
async def create_automation_endpoint(body: dict):
    try:
        return await automations.create(
            name=str(body.get("name", "")).strip(),
            instruction=str(body.get("instruction", "")).strip(),
            agent_name=str(body.get("agent_name", "")).strip(),
            interval_minutes=int(body.get("interval_minutes", 0)),
            description=str(body.get("description", "")))
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
