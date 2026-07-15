"""Pydantic schemas for API requests/responses."""

from pydantic import BaseModel
from typing import Optional


class ChatRequest(BaseModel):
    """Chat request payload."""
    message: str
    conversation_id: Optional[str] = None
    # "voice" = the turn was initiated by speaking (phase 2+); lets the main
    # agent answer with the voice.model_override LLM. Typed chat leaves it None.
    source: Optional[str] = None


class ConversationInfo(BaseModel):
    """Conversation metadata."""
    id: str
    title: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    last_message_at: Optional[str] = None


class MessageInfo(BaseModel):
    """Message metadata."""
    id: str
    role: str
    content: Optional[str] = None
    model_used: Optional[str] = None
    created_at: str


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    db: str
