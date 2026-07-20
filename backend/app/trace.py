"""Turn ledger — one trace per agent turn, spans for everything inside it
(docs/plans/observability-turn-tracing.md).

Usage:
    async with trace.turn("chat", conversation_id=cid, model=model) as t:
        ...                                   # t.id is the trace id
    async with trace.span("tool", name) as sp:
        sp["args"] = trace.redact_args(args)  # sp is the detail JSONB dict

Spans buffer in memory during the turn and flush in ONE fire-and-forget
write at turn end — the ledger must never add latency or a failure mode to
the chat path (on DB error: log and drop). Both context managers are no-ops
when no turn is active, so instrumented code paths (run_agent) stay safe for
callers that don't trace (automations until phase 3). Nesting rides
contextvars: a span opened inside another span records it as parent, which
is what makes dispatch subtrees possible without threading ids around.

Redaction (settled policy in the plan): tool args are scrubbed by key name
and value shape before storage, truncated at 2 KB; results store size +
first 500 chars, scrubbed. Full prompt/completion text is never stored —
counts only.
"""

import asyncio
import contextvars
import json
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Optional

from app import db

log = logging.getLogger(__name__)

_turn_var: contextvars.ContextVar[Optional["_Turn"]] = contextvars.ContextVar(
    "trace_turn", default=None)
_parent_var: contextvars.ContextVar[Optional[uuid.UUID]] = contextvars.ContextVar(
    "trace_parent", default=None)

ARG_LIMIT = 2000     # chars of redacted-args JSON kept per span
RESULT_HEAD = 500    # chars of a tool result kept (plus its full size)

# key-name redaction: any dict key that smells like a credential
_SECRET_KEY = re.compile(
    r"token|secret|password|passwd|api[_-]?key|apikey|authorization|bearer|"
    r"credential|private[_-]?key", re.IGNORECASE)
# value-shape redaction: bearer headers, sk-style keys, JWTs
_SECRET_VAL = re.compile(
    r"Bearer\s+\S+|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{20,}")

_MASK = "•••"


def redact_text(text: str, limit: int = RESULT_HEAD) -> str:
    """Scrub secret-shaped values out of free text and truncate."""
    return _SECRET_VAL.sub(_MASK, text or "")[:limit]


def _redact_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: (_MASK if _SECRET_KEY.search(k) else _redact_value(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    if isinstance(value, str):
        return _SECRET_VAL.sub(_MASK, value)
    return value


def redact_args(args: dict) -> str:
    """Tool args as a scrubbed, truncated JSON string (empty dict on failure)."""
    try:
        return json.dumps(_redact_value(args))[:ARG_LIMIT]
    except Exception:
        return "{}"


class _Turn:
    __slots__ = ("id", "source", "automation", "conversation_id", "model",
                 "status", "error", "started_at", "finished_at", "spans", "_seq")

    def __init__(self, source: str, automation: str | None,
                 conversation_id: str | None, model: str | None):
        self.id = uuid.uuid4()
        self.source = source
        self.automation = automation
        self.conversation_id = conversation_id
        self.model = model
        self.status = "ok"
        self.error: str | None = None
        self.started_at = datetime.now(timezone.utc)
        self.finished_at: datetime | None = None
        self.spans: list[dict] = []
        self._seq = 0

    def next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def set_error(self, error: str):
        """Mark the turn failed (first error wins) without leaving the context."""
        if self.status == "ok":
            self.status = "error"
            self.error = (error or "")[:2000]


def current() -> Optional[_Turn]:
    """The active turn, if any — for stamping its id onto other records."""
    return _turn_var.get()


@asynccontextmanager
async def turn(source: str, *, conversation_id: str | None = None,
               model: str | None = None, automation: str | None = None):
    t = _Turn(source, automation, conversation_id, model)
    token = _turn_var.set(t)
    try:
        yield t
    except asyncio.CancelledError:
        t.status = "cancelled"
        raise
    except Exception as e:
        t.set_error(str(e))
        raise
    finally:
        t.finished_at = datetime.now(timezone.utc)
        _turn_var.reset(token)
        asyncio.ensure_future(_flush(t))


@asynccontextmanager
async def span(kind: str, name: str):
    t = _turn_var.get()
    if t is None:
        yield {}  # not tracing — instrumented code needs no guard of its own
        return
    span_id = uuid.uuid4()
    row = {
        "id": span_id,
        "parent_span_id": _parent_var.get(),
        "seq": t.next_seq(),
        "kind": kind,
        "name": name,
        "status": "ok",
        "started_at": datetime.now(timezone.utc),
        "finished_at": None,
        "detail": {},
    }
    t.spans.append(row)
    token = _parent_var.set(span_id)
    try:
        yield row["detail"]
    except asyncio.CancelledError:
        row["status"] = "cancelled"
        raise
    except Exception as e:
        row["status"] = "error"
        row["detail"].setdefault("error", str(e)[:500])
        raise
    finally:
        row["finished_at"] = datetime.now(timezone.utc)
        # LLM/tool failures arrive as events, not exceptions — a caller that
        # records detail["error"] marks the span failed without raising
        if row["status"] == "ok" and row["detail"].get("error"):
            row["status"] = "error"
        _parent_var.reset(token)


_last_prune = 0.0
_PRUNE_EVERY_S = 24 * 3600


async def maybe_prune():
    """Delete traces older than trace.retention_days. Piggybacks the
    scheduler tick; actually runs at most once a day (first tick after
    startup, then daily). Traces are diagnostics — nothing may depend on
    them, so pruning is always safe."""
    global _last_prune
    now = time.monotonic()
    if _last_prune and now - _last_prune < _PRUNE_EVERY_S:
        return
    _last_prune = now
    from app import settings_store  # late: keeps trace importable everywhere
    days = int(settings_store.get("trace.retention_days") or 14)
    try:
        async with db.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM turn_traces WHERE started_at < "
                "now() - ($1 || ' days')::interval", str(days))
        log.info("Trace retention: %s (older than %d days)", result, days)
    except Exception:
        log.exception("trace retention prune failed; will retry tomorrow")


async def _flush(t: _Turn):
    try:
        async with db.acquire() as conn:
            await conn.execute(
                """INSERT INTO turn_traces
                       (id, source, automation, conversation_id, model,
                        status, error, started_at, finished_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)""",
                t.id, t.source, t.automation,
                uuid.UUID(t.conversation_id) if t.conversation_id else None,
                t.model, t.status, t.error, t.started_at, t.finished_at)
            if t.spans:
                await conn.executemany(
                    """INSERT INTO turn_spans
                           (id, trace_id, parent_span_id, seq, kind, name,
                            status, started_at, finished_at, detail)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)""",
                    [(s["id"], t.id, s["parent_span_id"], s["seq"], s["kind"],
                      s["name"], s["status"], s["started_at"], s["finished_at"],
                      json.dumps(s["detail"])) for s in t.spans])
    except Exception:
        log.exception("turn-ledger flush failed; trace %s dropped", t.id)
