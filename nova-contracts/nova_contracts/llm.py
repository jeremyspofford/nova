"""
LLM Gateway contracts — ModelProvider interface.
Any provider implementing these contracts can be swapped without touching consumers.
"""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class ModelCapability(str, Enum):
    chat = "chat"
    streaming = "streaming"
    function_calling = "function_calling"
    vision = "vision"
    embeddings = "embeddings"
    structured_output = "structured_output"


class BlastRadius(str, Enum):
    """Security posture of a tool call — how much damage it can do.

    READ     — no external mutation (reads, queries, GETs, listings)
    PROPOSE  — generates output, no external side effects
    MUTATE   — writes, commits, creates, sends, modifies state
    DESTRUCT — deletes, wipes, force-pushes, irreversibly destroys
    """
    READ = "read"
    PROPOSE = "propose"
    MUTATE = "mutate"
    DESTRUCT = "destruct"


class ToolCallRef(BaseModel):
    """Tool invocation embedded in an assistant message.
    Separate from ToolCall (which is used in CompleteResponse) so that
    message history can carry the LLM's tool-call requests forward."""
    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ContentBlock(BaseModel):
    """A single block within a multimodal message content array."""
    type: str  # "text" | "image_url"
    text: str | None = None
    image_url: dict[str, str] | None = None  # {"url": "data:image/...;base64,..."}


class Message(BaseModel):
    role: str  # system | user | assistant | tool
    content: str | list[ContentBlock] = ""  # Union: str for text-only, list for multimodal
    name: str | None = None    # identifies which tool produced a result (role=tool)
    tool_call_id: str | None = None   # ties a tool result back to a ToolCallRef
    tool_calls: list[ToolCallRef] | None = None  # present on assistant turns that invoke tools


def extract_text_content(content: str | list) -> str:
    """Extract plain text from content (string or content blocks).

    Handles both Pydantic ContentBlock instances and raw dicts,
    since messages flow as dicts through the orchestrator before parsing.
    """
    if isinstance(content, str):
        return content
    parts = []
    for b in content:
        if isinstance(b, dict):
            if b.get("type") == "text":
                parts.append(b.get("text", ""))
        elif hasattr(b, "type") and b.type == "text":
            parts.append(b.text or "")
    return " ".join(parts)


class ToolDefinition(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema
    # Security posture — defaults are safe-fail (unclassified = MUTATE, never under-protected)
    blast_radius: BlastRadius = BlastRadius.MUTATE
    reversible: bool = True
    rate_limit_per_hour: int | None = None


class CompleteRequest(BaseModel):
    model: str | None = None  # None = tier resolver picks the model
    messages: list[Message]
    tools: list[ToolDefinition] = Field(default_factory=list)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = None
    stream: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)  # agent_id, task_id for cost tracking
    tier: str | None = None       # "best", "mid", "cheap" — advisory hint for tier resolver
    task_type: str | None = None  # from RoutingTaskType enum — for outcome tracking


class ToolCall(BaseModel):
    id: str
    name: str
    arguments: dict[str, Any]


class CompleteResponse(BaseModel):
    content: str
    model: str
    tool_calls: list[ToolCall] = Field(default_factory=list)
    input_tokens: int
    output_tokens: int
    cost_usd: float | None = None
    finish_reason: str  # stop | tool_calls | length | content_filter


class StreamChunk(BaseModel):
    delta: str
    tool_calls: list[ToolCall] = Field(default_factory=list)
    finish_reason: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None


class EmbedRequest(BaseModel):
    model: str
    texts: list[str]
    dimensions: int = 768  # Default per Part 3 recommendation


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    input_tokens: int


class ModelInfo(BaseModel):
    id: str
    provider: str
    capabilities: list[ModelCapability]
    context_window: int
    max_output_tokens: int
    cost_per_input_token: float | None = None
    cost_per_output_token: float | None = None
