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

from app import conversations
from app.agents import registry as agent_registry
from app.agents import runner as agent_runner
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

    history = await conversations.load_history(conversation_id)
    turn_messages = conversations.to_llm_history(history) + [
        {"role": "user", "content": request.message}]

    await conversations.append_message(conversation_id, "user", request.message)

    async def generate():
        yield _sse({"meta": {"conversation_id": conversation_id,
                             "model": effective_model(main_agent["model"])}})
        final_text = ""
        try:
            async for event in agent_runner.run_agent(main_agent, turn_messages):
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


@router.get("/api/v1/memory/stats")
async def memory_stats():
    return await memory.stats()


@router.get("/api/v1/memory/graph")
async def memory_graph():
    return await memory.graph()
