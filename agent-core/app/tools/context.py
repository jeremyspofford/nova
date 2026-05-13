from __future__ import annotations
from dataclasses import dataclass
from typing import Callable, Optional
from uuid import UUID


@dataclass(frozen=True)
class ToolContext:
    idempotency_key: str
    task_id: UUID
    call_id: UUID
    caller_role: str
    caller_caps: list[str]
    pool: object
    snapshot: Optional[Callable]
    request_approval: Callable
    cancel_requested: bool = False
