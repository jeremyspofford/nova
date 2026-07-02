"""
Orchestrator contracts — agent lifecycle and task routing.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class AgentStatus(str, Enum):
    idle = "idle"
    running = "running"
    paused = "paused"
    stopped = "stopped"
    error = "error"


class AgentConfig(BaseModel):
    name: str
    system_prompt: str
    model: str = "claude-sonnet-4-6"
    tools: list[str] = Field(default_factory=list)
    max_context_tokens: int = 8192
    fallback_models: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class CreateAgentRequest(BaseModel):
    config: AgentConfig


class AgentInfo(BaseModel):
    id: UUID
    config: AgentConfig
    status: AgentStatus
    created_at: datetime
    last_active: datetime | None = None


class TaskType(str, Enum):
    chat = "chat"
    tool_use = "tool_use"
    memory_consolidation = "memory_consolidation"


class SubmitTaskRequest(BaseModel):
    agent_id: UUID
    task_type: TaskType = TaskType.chat
    messages: list[dict[str, Any]]
    session_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class TaskStatus(str, Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"


class TaskResult(BaseModel):
    task_id: UUID
    agent_id: UUID
    status: TaskStatus
    response: str | None = None
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    input_tokens: int = 0
    output_tokens: int = 0
