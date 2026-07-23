"""Pydantic schemas for API requests/responses."""

from pydantic import BaseModel
from typing import Literal, Optional


class ChatAttachment(BaseModel):
    """One attachment riding a chat turn.

    kind "image": data is base64 (no data: prefix), mime like image/jpeg —
    forwarded to the model as an image_url content part this turn.
    kind "text": data is the file's decoded text — inlined into the message
    (and persisted with it, so it stays in the conversation window).
    """
    kind: Literal["image", "text"]
    name: str
    mime: str = ""
    data: str


class ChatRequest(BaseModel):
    """Chat request payload."""
    message: str
    conversation_id: Optional[str] = None
    # "voice" = the turn was initiated by speaking (phase 2+); lets the main
    # agent answer with the voice.model_override LLM. Typed chat leaves it None.
    source: Optional[str] = None
    attachments: Optional[list[ChatAttachment]] = None


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
