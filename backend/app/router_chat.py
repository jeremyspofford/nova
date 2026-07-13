"""Chat API router."""

import logging
import json
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse
from app import conversations, db
from app.llm import router as llm_router
from app.config import settings
from app.schemas import ChatRequest
from app.memory.memory import memory

log = logging.getLogger(__name__)

router = APIRouter()

# Hardcoded main agent prompt for Phase 1
MAIN_SYSTEM_PROMPT = """You are Nova, a helpful AI assistant. Answer questions directly from your knowledge and memory.
You have access to tools to help you, and you'll use them when needed.
Be concise and helpful."""


@router.post("/api/v1/chat/stream")
async def chat_stream(request: ChatRequest):
    """Stream chat responses."""
    try:
        # Get or create active conversation
        conversation_info = await conversations.get_or_create_active_conversation()
        conversation_id = conversation_info["id"]

        # Append user message
        await conversations.append_message(conversation_id, "user", request.message)

        # Load conversation history
        history = await conversations.load_history(conversation_id)

        # Retrieve memory context
        memory_context = await memory.context(request.message, max_chars=2000)

        # Build message list for LLM
        messages = []
        system_prompt = MAIN_SYSTEM_PROMPT
        if memory_context.get("context"):
            system_prompt += f"\n\n## Relevant Memories\n{memory_context['context']}"

        messages.append({"role": "system", "content": system_prompt})

        for msg in history:
            messages.append({
                "role": msg["role"],
                "content": msg["content"] or "",
            })

        async def response_generator():
            """Stream the LLM response."""
            # Emit conversation metadata
            yield f'data: {json.dumps({"meta": {"conversation_id": conversation_id, "model": settings.log_level}})}\n\n'

            full_response = ""
            model = "openrouter:anthropic/claude-3.5-haiku" if settings.openrouter_api_key else "ollama:llama2"

            try:
                async for chunk in llm_router.stream_chat(messages, model):
                    if chunk.get("type") == "text":
                        text = chunk["text"]
                        full_response += text
                        yield f'data: {json.dumps({"t": text})}\n\n'
                    elif chunk.get("type") == "done":
                        yield 'data: [DONE]\n\n'
                    elif chunk.get("error"):
                        log.error(f"LLM streaming error: {chunk['error']}")
                        yield f'data: {json.dumps({"error": chunk["error"]})}\n\n'
            except Exception as e:
                log.error(f"Error during streaming: {e}")
                yield f'data: {json.dumps({"error": str(e)})}\n\n'

            # Save assistant response and write to memory
            try:
                await conversations.append_message(conversation_id, "assistant", full_response, model)
                # Write exchange to memory
                exchange = f"User: {request.message}\n\nAssistant: {full_response}"
                await memory.write(exchange, source_type="chat")
            except Exception as e:
                log.error(f"Failed to save message or write to memory: {e}")

        return StreamingResponse(response_generator(), media_type="text/event-stream")

    except Exception as e:
        log.error(f"Error in chat stream: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/conversations/active")
async def get_active_conversation():
    """Get active conversation metadata."""
    try:
        info = await conversations.get_or_create_active_conversation()
        return info
    except Exception as e:
        log.error(f"Error getting active conversation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/conversations/{conversation_id}/messages")
async def get_messages(conversation_id: str):
    """Get messages for a conversation."""
    try:
        history = await conversations.load_history(conversation_id, limit=100)
        return history
    except Exception as e:
        log.error(f"Error getting messages: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/memory/stats")
async def get_memory_stats():
    """Get memory statistics."""
    try:
        stats = await memory.stats()
        return stats
    except Exception as e:
        log.error(f"Error getting memory stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/memory/graph")
async def get_memory_graph():
    """Get memory graph for visualization (simplified for Phase 2)."""
    try:
        stats = await memory.stats()

        # For Phase 2, return a simple node/edge structure
        # In later phases, this will be enhanced with actual memory graph structure
        nodes = []
        edges = []

        # Add topic nodes
        for i in range(stats.get("topics", 0)):
            nodes.append({
                "id": f"topic-{i}",
                "label": f"Topic {i+1}",
                "type": "topic",
                "size": 1.0,
            })

        # Add skill nodes
        for i in range(stats.get("skills", 0)):
            nodes.append({
                "id": f"skill-{i}",
                "label": f"Skill {i+1}",
                "type": "skill",
                "size": 0.8,
            })

        # Add some simple edges
        for i in range(min(3, len(nodes) - 1)):
            edges.append({
                "source": nodes[i]["id"],
                "target": nodes[i + 1]["id"],
                "weight": 0.5,
            })

        return {
            "nodes": nodes,
            "edges": edges,
            "stats": stats,
        }
    except Exception as e:
        log.error(f"Error getting memory graph: {e}")
        raise HTTPException(status_code=500, detail=str(e))
