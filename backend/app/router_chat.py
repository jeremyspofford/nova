"""Chat API router."""

import logging
import json
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse
from app import conversations, db
from app.llm import router as llm_router
from app.config import settings
from app.schemas import ChatRequest

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

        # Build message list for LLM
        messages = []
        messages.append({"role": "system", "content": MAIN_SYSTEM_PROMPT})

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

            # Save assistant response
            try:
                await conversations.append_message(conversation_id, "assistant", full_response, model)
            except Exception as e:
                log.error(f"Failed to save assistant message: {e}")

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
