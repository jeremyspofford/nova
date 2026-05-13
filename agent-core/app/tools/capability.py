"""Tier check, consent cache, and asyncio approval-hold flow."""
import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

from .registry import Tier

logger = logging.getLogger(__name__)

_consent_cache: dict[tuple[str, str], dict] = {}
_approval_events: dict[str, asyncio.Event] = {}
_approval_results: dict[str, bool] = {}

# Per-task queues that receive approval-request dicts before the approval blocks.
# Registered by streaming endpoints (e.g. post_message) so they can forward
# approval events to the client while dispatch() is suspended.
_approval_notifiers: dict[str, asyncio.Queue] = {}


def register_approval_notifier(task_id: str, queue: asyncio.Queue) -> None:
    _approval_notifiers[task_id] = queue


def deregister_approval_notifier(task_id: str) -> None:
    _approval_notifiers.pop(task_id, None)

APPROVAL_TIMEOUT_S = 300


async def gate(tool_def, args: dict, task_id: str, call_id: str, pool) -> None:
    """Check permission. Raises PermissionError if denied or timed out."""
    tier = tool_def.tier

    if tier in (Tier.READ, Tier.PROPOSE, Tier.SPECIAL):
        return

    scope = _resolve_scope(tool_def.cap_scope_template, args)

    if tier == Tier.MUTATE:
        key = (tool_def.name, scope)
        cached = _consent_cache.get(key)
        if cached is not None:
            exp = cached.get("expires_at")
            if exp is None or datetime.now(timezone.utc).timestamp() < exp:
                return
            del _consent_cache[key]
        if not await _request_approval(tool_def, scope, args, task_id, call_id, pool):
            raise PermissionError(f"Denied: {tool_def.name} ({scope})")

    elif tier == Tier.DESTRUCT:
        if not await _request_approval(tool_def, scope, args, task_id, call_id, pool):
            raise PermissionError(f"Denied: {tool_def.name} ({scope})")


def _resolve_scope(template: str, args: dict) -> str:
    try:
        return template.format(**args)
    except (KeyError, IndexError):
        return template


async def _request_approval(tool_def, scope: str, args: dict, task_id: str, call_id: str, pool) -> bool:
    approval_id = str(uuid.uuid4())

    # Register event BEFORE DB insert so any concurrent resolve() always finds it
    event = asyncio.Event()
    _approval_events[approval_id] = event

    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO approvals
                (id, task_id, tool_call_id, tool_name, scope, args, tier)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            approval_id, task_id, call_id,
            tool_def.name, scope, json.dumps(args), tool_def.tier.value,
        )

    logger.info("approval_requested id=%s tool=%s scope=%s", approval_id[:8], tool_def.name, scope)

    # Notify any streaming endpoint watching this task so it can forward the
    # approval request to the client before we block on the event below.
    notifier = _approval_notifiers.get(task_id)
    if notifier is not None:
        notifier.put_nowait({
            "type": "tool_approval_request",
            "tool_call_id": approval_id,
            "name": tool_def.name,
            "tier": tool_def.tier.value,
            "args": args,
        })

    try:
        await asyncio.wait_for(event.wait(), timeout=APPROVAL_TIMEOUT_S)
    except asyncio.TimeoutError:
        _approval_events.pop(approval_id, None)
        _approval_results.pop(approval_id, None)
        logger.warning("approval timed out id=%s", approval_id[:8])
        return False

    result = _approval_results.pop(approval_id, False)
    _approval_events.pop(approval_id, None)
    return result


def resolve_approval(approval_id: str, granted: bool) -> None:
    """Called by approvals_router when the user grants or denies."""
    _approval_results[approval_id] = granted
    ev = _approval_events.get(approval_id)
    if ev:
        ev.set()
    else:
        logger.warning("resolve_approval: no in-flight event for %s", approval_id[:8])


def cache_consent(tool_name: str, scope: str, ttl_seconds: int | None = None) -> None:
    entry: dict = {}
    if ttl_seconds:
        entry["expires_at"] = datetime.now(timezone.utc).timestamp() + ttl_seconds
    _consent_cache[(tool_name, scope)] = entry
    logger.info("consent cached tool=%s scope=%s ttl=%s", tool_name, scope, ttl_seconds)
