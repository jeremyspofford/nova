# nova-contracts/nova_contracts/models.py
from __future__ import annotations
from datetime import datetime
from enum import Enum
from typing import Any
from pydantic import BaseModel, Field
import uuid


class Tier(str, Enum):
    READ = "READ"
    PROPOSE = "PROPOSE"
    MUTATE = "MUTATE"
    DESTRUCT = "DESTRUCT"


class TaskStatus(str, Enum):
    pending = "pending"
    running = "running"
    awaiting_approval = "awaiting_approval"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class Task(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    prompt: str
    status: TaskStatus = TaskStatus.pending
    source: str = "user"
    created_at: datetime = Field(default_factory=datetime.utcnow)
    parent_task_id: str | None = None


class TaskEvent(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    task_id: str
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    hash: str = ""
    prev_hash: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Message(BaseModel):
    role: str  # "user" | "assistant" | "system"
    content: str
    task_id: str | None = None


class ToolCallRequest(BaseModel):
    tool_name: str
    tier: Tier
    args: dict[str, Any]
    task_id: str
    idempotency_key: str = Field(default_factory=lambda: str(uuid.uuid4()))


class HealthStatus(BaseModel):
    status: str  # "ok" | "degraded" | "error"
    service: str
    version: str = "2.0.0"
    checks: dict[str, bool] = Field(default_factory=dict)
