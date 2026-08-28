"""The turn ledger: what a turn did, written once, at the end.

A `turns` row opens when the work starts and carries status NULL until it
closes, so an abandoned turn reads as unfinished rather than as success.
Every span and the final status land in ONE transaction — a half-written
trace is worse than no trace, because it looks complete.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import asyncpg

VALID_STATUSES = ("ok", "error", "interrupted")


@dataclass
class Span:
    kind: str
    name: str | None
    started_at: datetime
    duration_ms: int
    meta: dict[str, Any] = field(default_factory=dict)


class SpanRecorder:
    """Times a block and files the span on the turn, exception or not."""

    def __init__(self, turn: Turn, kind: str, name: str | None) -> None:
        self._turn = turn
        self._kind = kind
        self._name = name
        self.meta: dict[str, Any] = {}

    def __enter__(self) -> SpanRecorder:
        self._started_at = datetime.now(UTC)
        self._t0 = time.perf_counter()
        return self

    def __exit__(self, *exc_info) -> bool:
        self._turn.spans.append(
            Span(
                kind=self._kind,
                name=self._name,
                started_at=self._started_at,
                duration_ms=int((time.perf_counter() - self._t0) * 1000),
                meta=self.meta,
            )
        )
        return False


@dataclass
class Turn:
    id: uuid.UUID
    started_at: datetime
    conversation_id: uuid.UUID | None = None
    model: str | None = None
    spans: list[Span] = field(default_factory=list)

    def span(self, kind: str, name: str | None = None) -> SpanRecorder:
        return SpanRecorder(self, kind, name)


async def open_turn(
    pool: asyncpg.Pool,
    *,
    kind: str = "chat",
    conversation_id: uuid.UUID | None = None,
    model: str | None = None,
) -> Turn:
    row = await pool.fetchrow(
        "INSERT INTO turns (kind, conversation_id, model) VALUES ($1, $2, $3) "
        "RETURNING id, started_at",
        kind,
        conversation_id,
        model,
    )
    return Turn(
        id=row["id"],
        started_at=row["started_at"],
        conversation_id=conversation_id,
        model=model,
    )


async def close_turn(pool: asyncpg.Pool, turn: Turn, status: str) -> None:
    """All the spans and the final status, in one transaction or not at all."""
    if status not in VALID_STATUSES:
        raise ValueError(f"turn status must be one of {VALID_STATUSES}, got {status!r}")
    async with pool.acquire() as conn, conn.transaction():
        for span in turn.spans:
            await conn.execute(
                "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
                "VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
                turn.id,
                span.kind,
                span.name,
                span.started_at,
                span.duration_ms,
                span.meta,
            )
        await conn.execute(
            "UPDATE turns SET status = $2, ended_at = now() WHERE id = $1", turn.id, status
        )
