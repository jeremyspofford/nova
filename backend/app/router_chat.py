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
from app.tools import registry as tool_registry
from app.config import settings
from app.llm.router import effective_model
from app.memory.memory import memory
from app.schemas import ChatRequest

log = logging.getLogger(__name__)

router = APIRouter()


def _sse(obj) -> str:
    return f"data: {json.dumps(obj)}\n\n"


def _require_edit_mode():
    """Gate for manual create/edit/delete from the UI, enforced at the API so
    hiding buttons isn't the only defense. Reads and enable/disable stay open.
    The agents' manage_* tools never pass through these endpoints, so Nova's
    own management powers are unaffected."""
    if not settings_store.get("ui.edit_mode"):
        raise HTTPException(
            status_code=403,
            detail="Edit mode is off — enable it in Settings → Operator to "
                   "create, edit, or delete manually.")


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


# operational knobs (always editable) vs structural fields (edit mode only)
_AGENT_SAFE_FIELDS = {"model", "enabled"}
_AGENT_EDIT_FIELDS = {"description", "system_prompt", "allowed_tools", "routing_keywords"}


@router.patch("/api/v1/agents/{agent_id}")
async def patch_agent_endpoint(agent_id: str, body: dict):
    allowed = {k: v for k, v in body.items()
               if k in _AGENT_SAFE_FIELDS | _AGENT_EDIT_FIELDS}
    if not allowed:
        raise HTTPException(status_code=422, detail="no editable fields provided")
    if any(k in _AGENT_EDIT_FIELDS for k in allowed):
        _require_edit_mode()
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
    _require_edit_mode()
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
    _require_edit_mode()
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
async def model_recommendations_endpoint():
    from app import model_recs
    return await model_recs.recommendations()


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
    _require_edit_mode()
    try:
        return await curated_models.create(
            model=str(body.get("model", "")),
            provider=str(body.get("provider", "")),
            **{k: body[k] for k in
               ("min_ram_gb", "min_vram_gb", "tool_tier", "speed", "roles", "notes")
               if k in body})
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:  # duplicate model etc.
        raise HTTPException(status_code=422, detail=str(e))


@router.patch("/api/v1/models/curated/{row_id}")
async def patch_curated_endpoint(row_id: str, body: dict):
    from app import curated_models
    if any(k != "enabled" for k in body):  # enable/disable is always allowed
        _require_edit_mode()
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
    _require_edit_mode()
    result = await curated_models.delete(row_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="curated model not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="seeded rows can be disabled but not deleted")
    return {"status": "deleted"}


# ── skills (operator surface; agents use write_memory type='skill') ──────

@router.get("/api/v1/skills")
async def list_skills_endpoint():
    return await memory.list_skills()


@router.post("/api/v1/skills", status_code=201)
async def create_skill_endpoint(body: dict):
    _require_edit_mode()
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
    _require_edit_mode()
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
    _require_edit_mode()
    if not skill_id.startswith("skills/"):
        raise HTTPException(status_code=404, detail="not a skill")
    if not await memory.delete_item(skill_id):
        raise HTTPException(status_code=404, detail="skill not found")
    return {"status": "deleted"}


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


# ── tools (operator surface; agents use the manage_tools builtin) ────────

@router.get("/api/v1/tools")
async def list_tools_endpoint():
    return await tool_registry.list_all_tools()


@router.post("/api/v1/tools", status_code=201)
async def create_tool_endpoint(body: dict):
    _require_edit_mode()
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
    _require_edit_mode()
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


# ── automations ──────────────────────────────────────────────────────────

@router.get("/api/v1/automations")
async def list_automations_endpoint():
    return await automations.list_automations()


@router.post("/api/v1/automations", status_code=201)
async def create_automation_endpoint(body: dict):
    _require_edit_mode()
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
    if any(k != "enabled" for k in body):  # enable/disable is always allowed
        _require_edit_mode()
    ok = await automations.update(automation_id, **body)
    if not ok:
        raise HTTPException(status_code=404, detail="automation not found or no valid fields")
    return {"status": "updated"}


@router.delete("/api/v1/automations/{automation_id}")
async def delete_automation_endpoint(automation_id: str):
    _require_edit_mode()
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
    _require_edit_mode()
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
    if any(k != "enabled" for k in body):  # enable/disable is always allowed
        _require_edit_mode()
    try:
        ok = await rules.update(rule_id, **body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="rule not found or no valid fields")
    return {"status": "updated"}


@router.delete("/api/v1/rules/{rule_id}")
async def delete_rule_endpoint(rule_id: str):
    _require_edit_mode()
    result = await rules.delete(rule_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="rule not found")
    if result == "is_system":
        raise HTTPException(status_code=403,
                            detail="system protections can be disabled but not deleted")
    return {"status": "deleted"}
