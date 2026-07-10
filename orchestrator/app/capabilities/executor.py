"""Capability platform executor — every external tool call passes through here.

Pipeline:
  1. Resolve credential (if credential_id provided)
  2. Run consent gate (READ/PROPOSE auto-allow; MUTATE/DESTRUCT may pend)
  3. If allowed, call underlying tool
  4. Write capability_audit row for the outcome (success / rejected / error / pending)

Plus execute_approved() — bypasses the consent gate (already decided) and
re-hydrates a previously-pended call from approval_requests.tool_context.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Awaitable, Callable
from uuid import UUID

import asyncpg
from app.capabilities import audit, consent
from nova_contracts import BlastRadius

logger = logging.getLogger(__name__)


# Type for the underlying tool callable: takes (args_dict, secret_or_None) → result_dict
ToolCallable = Callable[[dict, str | None], Awaitable[dict]]


async def execute_tool(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    user_id: UUID | None,
    task_id: UUID | None,
    actor_kind: str,
    actor_id: str,
    tool_name: str,
    tool_kind: str,                 # 'native' | 'mcp_http' | 'mcp_stdio'
    blast_radius: BlastRadius,
    reversible: bool,
    provider_kind: str | None,
    target: str | None,
    credential_id: UUID | None,
    args: dict,
    underlying: ToolCallable,
) -> dict:
    """Single boundary for every external tool call.

    Returns one of:
      - {"status": "consent_pending", "approval_id": "..."}  (MUTATE awaiting human)
      - {"status": "user_rejected"}                           (consent rejected)
      - <result dict>                                         (executed successfully)

    Re-raises tool exceptions; the audit log records error_class + summary.
    """
    # Assemble the routing envelope for the approval-worker's re-hydration
    # path. None of these fields are user-secret — they're routing identifiers.
    # JSON-serialise UUIDs as strings so the JSONB column stores them
    # losslessly without needing a custom decoder on the worker side.
    tool_context: dict = {
        "tenant_id": str(tenant_id) if tenant_id else None,
        "user_id": str(user_id) if user_id else None,
        "task_id": str(task_id) if task_id else None,
        "credential_id": str(credential_id) if credential_id else None,
        "actor_kind": actor_kind,
        "actor_id": actor_id,
        "provider_kind": provider_kind,
        "target": target,
    }

    decision = await consent.gate(
        pool,
        tenant_id=tenant_id, user_id=user_id, task_id=task_id,
        tool_name=tool_name, tool_kind=tool_kind,
        blast_radius=blast_radius, args=args,
        provider_kind=provider_kind, target=target,
        reversible=reversible,
        actor_kind=actor_kind, actor_id=actor_id,
        tool_context=tool_context,
    )

    if decision.action == "pending":
        await audit.write_audit_event(
            pool,
            tenant_id=tenant_id, user_id=user_id, task_id=task_id,
            actor_kind=actor_kind, actor_id=actor_id,
            event_type="consent_request",
            tool_name=tool_name, tool_kind=tool_kind,
            blast_radius=blast_radius.value,
            provider_kind=provider_kind, target=target,
            credential_id=credential_id, args_redacted=args,
            response_status="pending",
            response_summary=f"approval_id={decision.approval_id}",
        )
        return {"status": "consent_pending", "approval_id": str(decision.approval_id)}

    if decision.action == "deny":
        await audit.write_audit_event(
            pool,
            tenant_id=tenant_id, user_id=user_id, task_id=task_id,
            actor_kind=actor_kind, actor_id=actor_id,
            event_type="tool_call",
            tool_name=tool_name, tool_kind=tool_kind,
            blast_radius=blast_radius.value,
            provider_kind=provider_kind, target=target,
            credential_id=credential_id, args_redacted=args,
            response_status="rejected",
        )
        return {"status": "user_rejected"}

    # If allowed via auto-approve rule, audit that
    if decision.rule_id is not None:
        await audit.write_audit_event(
            pool,
            tenant_id=tenant_id, user_id=user_id, task_id=task_id,
            actor_kind=actor_kind, actor_id=actor_id,
            event_type="rule_apply",
            tool_name=tool_name, tool_kind=tool_kind,
            blast_radius=blast_radius.value,
            provider_kind=provider_kind, target=target,
            credential_id=credential_id, args_redacted=args,
            response_status="success",
            response_summary=f"rule_id={decision.rule_id}",
        )

    # Resolve secret (if credential needed)
    secret: str | None = None
    if credential_id is not None:
        # Lazy import — credentials.py depends on nova_worker_common which is not
        # available in every environment (e.g. lightweight test installs).
        from app.capabilities import credentials as cred_db  # noqa: PLC0415
        secret = await cred_db.get_secret(
            pool, tenant_id=tenant_id, cred_id=credential_id, actor=actor_id,
        )

    # Run the underlying tool
    started = time.monotonic()
    try:
        result = await underlying(args, secret)
        duration_ms = int((time.monotonic() - started) * 1000)
        # Compose a redacted summary — never include the raw secret here
        summary = _summarize(result)
        await audit.write_audit_event(
            pool,
            tenant_id=tenant_id, user_id=user_id, task_id=task_id,
            actor_kind=actor_kind, actor_id=actor_id,
            event_type="tool_call",
            tool_name=tool_name, tool_kind=tool_kind,
            blast_radius=blast_radius.value,
            provider_kind=provider_kind, target=target,
            credential_id=credential_id, args_redacted=args,
            response_status="success",
            response_summary=summary,
            duration_ms=duration_ms,
        )
        return result
    except Exception as e:
        duration_ms = int((time.monotonic() - started) * 1000)
        await audit.write_audit_event(
            pool,
            tenant_id=tenant_id, user_id=user_id, task_id=task_id,
            actor_kind=actor_kind, actor_id=actor_id,
            event_type="tool_call",
            tool_name=tool_name, tool_kind=tool_kind,
            blast_radius=blast_radius.value,
            provider_kind=provider_kind, target=target,
            credential_id=credential_id, args_redacted=args,
            response_status="error",
            error_class=type(e).__name__,
            response_summary=str(e)[:500],
            duration_ms=duration_ms,
        )
        raise


def _summarize(result: dict | str | None) -> str | None:
    """Best-effort one-line summary; keys/types only, never values that might contain secrets."""
    if result is None:
        return None
    if isinstance(result, str):
        return result[:300]
    if isinstance(result, dict):
        keys = list(result.keys())
        return f"keys={keys[:6]}"
    return str(type(result).__name__)


def _coerce_uuid(value) -> UUID | None:
    """Best-effort UUID coercion. Returns None for empty/invalid values."""
    if value is None or value == "":
        return None
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


async def execute_approved(pool: asyncpg.Pool, approval_id: UUID) -> dict:
    """Execute a previously-approved tool call. Bypasses the consent gate.

    Looks up approval_requests for the routing envelope (tool_name, tool_kind,
    args, task_id, tool_context with credential_id/api_base/etc.), resolves
    the credential's secret from the vault, and dispatches the underlying
    tool callable. Writes a capability_audit row tagged to the original
    task_id so the consent_request row and the tool_call row form a chain.

    Idempotent on status:
      - 'approved' → execute, then mark 'completed' (we don't reuse status
        for state because approval_requests.status only allows the original
        decision lifecycle. We don't re-mutate status — a second invocation
        with the same approval_id will short-circuit on status != approved
        if a sibling worker advances it. We reserve 'timeout' for expiry.)
      - any other status → log and return early.

    On expiry (now() >= expires_at) → set status='timeout', emit audit with
    response_status='timeout', and skip execution.

    On underlying tool exception → emit audit with response_status='error'
    and re-raise so the caller (approval_worker_loop) can dead-letter.

    Returns a small dict describing the outcome — used by tests and the worker.
    """
    # 1. Fetch the approval row
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM approval_requests WHERE id=$1",
            approval_id,
        )
    if row is None:
        logger.warning("execute_approved: approval %s not found", approval_id)
        return {"status": "not_found", "approval_id": str(approval_id)}

    # Checkpoints resume the parked task on approve AND reject — route before
    # the approved-only guard. No expiry refusal here either: the operator DID
    # respond, and staleness of the parked task is the reaper's call (a swept
    # task simply fails the waiting_human → queued transition below).
    if row["kind"] == "checkpoint":
        return await _resume_checkpoint_task(pool, row)

    if row["status"] != "approved":
        logger.info(
            "execute_approved: approval %s status=%s — skipping",
            approval_id, row["status"],
        )
        return {"status": "skipped", "reason": row["status"]}

    # 2. Expiry check — refuse to execute approvals past their deadline.
    expires_at = row["expires_at"]
    now = datetime.now(timezone.utc)
    if expires_at is not None and now >= expires_at:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE approval_requests SET status='timeout' WHERE id=$1",
                approval_id,
            )
        logger.warning(
            "execute_approved: approval %s expired at %s — marking timeout",
            approval_id, expires_at,
        )
        await audit.write_audit_event(
            pool,
            tenant_id=row["tenant_id"],
            actor_kind="system",
            actor_id="approval-worker",
            event_type="tool_call",
            tool_name=row["tool_name"],
            tool_kind=row["tool_kind"],
            blast_radius=row["blast_radius"],
            task_id=row["task_id"],
            args_redacted=row["args_redacted"]
                if isinstance(row["args_redacted"], dict)
                else (json.loads(row["args_redacted"]) if row["args_redacted"] else None),
            response_status="timeout",
            response_summary=f"approval expired at {expires_at.isoformat()}",
        )
        return {"status": "timeout", "approval_id": str(approval_id)}

    # 3. Re-hydrate the routing envelope
    tool_name = row["tool_name"]
    tool_kind = row["tool_kind"]
    blast_radius = row["blast_radius"]
    tenant_id = row["tenant_id"]
    task_id = row["task_id"]
    args = row["args_redacted"]
    if isinstance(args, str):
        # asyncpg can return str when the JSONB codec isn't registered for
        # this connection — defensive fallback.
        args = json.loads(args)
    elif args is None:
        args = {}

    ctx_raw = row["tool_context"]
    if isinstance(ctx_raw, str):
        try:
            ctx = json.loads(ctx_raw) if ctx_raw else {}
        except json.JSONDecodeError:
            ctx = {}
    elif ctx_raw is None:
        ctx = {}
    else:
        ctx = ctx_raw

    credential_id = _coerce_uuid(ctx.get("credential_id"))
    user_id = _coerce_uuid(ctx.get("user_id"))
    actor_kind = ctx.get("actor_kind", "agent")
    actor_id = ctx.get("actor_id", "approval-worker")
    provider_kind = ctx.get("provider_kind") or row["provider_kind"]
    target = ctx.get("target")
    # Optional admin override for tests pointing at fake-github. Never set
    # in production — the underlying tool falls back to settings.github_api_base_url.
    api_base_override = ctx.get("_test_api_base")

    # 4. Resolve the secret from the vault (best-effort — some tools don't need one)
    secret: str | None = None
    if credential_id is not None:
        from app.capabilities import credentials as cred_db  # noqa: PLC0415
        try:
            secret = await cred_db.get_secret(
                pool, tenant_id=tenant_id, cred_id=credential_id, actor=actor_id,
            )
        except Exception as exc:
            logger.exception(
                "execute_approved: failed to resolve credential %s: %s",
                credential_id, exc,
            )
            await audit.write_audit_event(
                pool,
                tenant_id=tenant_id,
                user_id=user_id,
                task_id=task_id,
                actor_kind=actor_kind,
                actor_id=actor_id,
                event_type="tool_call",
                tool_name=tool_name,
                tool_kind=tool_kind,
                blast_radius=blast_radius,
                provider_kind=provider_kind,
                target=target,
                credential_id=credential_id,
                args_redacted=args,
                response_status="error",
                error_class=type(exc).__name__,
                response_summary=str(exc)[:500],
            )
            raise

    # 5. Resolve the underlying tool callable. v1 only ships github_external
    # tools through the consent gate, so route those directly to the
    # github_external module's dispatcher. Future providers add an elif here.
    started = time.monotonic()
    try:
        if provider_kind == "github" or tool_name in _github_external_names():
            from app.config import settings as _settings
            from app.tools.github_external_tools import (
                execute_tool as _github_external_execute,
            )

            api_base = api_base_override or _settings.github_api_base_url
            if secret is None:
                raise RuntimeError(
                    f"approval {approval_id} for tool {tool_name} has no resolved secret"
                )
            result = await _github_external_execute(
                tool_name, args, secret=secret, api_base=api_base,
            )
            if not isinstance(result, dict):
                result = {"result": result}
        elif tool_kind in ("mcp_http", "mcp_stdio") or tool_name.startswith("mcp__"):
            # Re-execute the originally-pended MCP call now that it's approved.
            # Runs in the orchestrator process where the MCP client is connected.
            from app.pipeline.tools.registry import execute_mcp_tool
            result = {"result": await execute_mcp_tool(tool_name, args)}
        else:
            raise NotImplementedError(
                f"execute_approved does not yet route tool {tool_name!r} "
                f"(provider_kind={provider_kind!r})"
            )

        duration_ms = int((time.monotonic() - started) * 1000)
        await audit.write_audit_event(
            pool,
            tenant_id=tenant_id,
            user_id=user_id,
            task_id=task_id,
            actor_kind=actor_kind,
            actor_id=actor_id,
            event_type="tool_call",
            tool_name=tool_name,
            tool_kind=tool_kind,
            blast_radius=blast_radius,
            provider_kind=provider_kind,
            target=target,
            credential_id=credential_id,
            args_redacted=args,
            response_status="success",
            response_summary=_summarize(result),
            duration_ms=duration_ms,
        )
        return {"status": "executed", "approval_id": str(approval_id), "result": result}
    except Exception as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        await audit.write_audit_event(
            pool,
            tenant_id=tenant_id,
            user_id=user_id,
            task_id=task_id,
            actor_kind=actor_kind,
            actor_id=actor_id,
            event_type="tool_call",
            tool_name=tool_name,
            tool_kind=tool_kind,
            blast_radius=blast_radius,
            provider_kind=provider_kind,
            target=target,
            credential_id=credential_id,
            args_redacted=args,
            response_status="error",
            error_class=type(exc).__name__,
            response_summary=str(exc)[:500],
            duration_ms=duration_ms,
        )
        raise


async def _resume_checkpoint_task(pool: asyncpg.Pool, row: asyncpg.Record) -> dict:
    """Resume a task parked on a human checkpoint (task #8 milestone B).

    Injects the operator's decision + reply into the task's saved
    checkpoint['_human_checkpoint'] snapshot, flips waiting_human → queued,
    and re-enqueues. The Task Agent replays its saved conversation with the
    reply as the checkpoint tool's result.

    Idempotent / stale-safe:
      - task not in waiting_human (already resumed, swept, or cancelled) → skip
      - approval_id doesn't match the task's current park (the task parked
        again on a newer checkpoint) → skip
    """
    approval_id = row["id"]
    task_id = row["task_id"]
    status = row["status"]

    if task_id is None:
        logger.warning("checkpoint resume: approval %s has no task_id", approval_id)
        return {"status": "skipped", "reason": "no_task"}
    if status not in ("approved", "rejected"):
        logger.info(
            "checkpoint resume: approval %s status=%s — nothing to do",
            approval_id, status,
        )
        return {"status": "skipped", "reason": status}

    async with pool.acquire() as conn:
        trow = await conn.fetchrow(
            "SELECT status, checkpoint FROM tasks WHERE id=$1",
            task_id,
        )
    if trow is None:
        logger.warning("checkpoint resume: task %s not found", task_id)
        return {"status": "not_found", "task_id": str(task_id)}

    checkpoint = trow["checkpoint"]
    if isinstance(checkpoint, str):
        try:
            checkpoint = json.loads(checkpoint)
        except json.JSONDecodeError:
            checkpoint = {}
    hc = (checkpoint or {}).get("_human_checkpoint") or {}

    if hc.get("approval_id") != str(approval_id):
        logger.warning(
            "checkpoint resume: approval %s is stale for task %s (current park: %s)",
            approval_id, task_id, hc.get("approval_id"),
        )
        return {"status": "skipped", "reason": "stale_approval"}
    if trow["status"] != "waiting_human":
        logger.info(
            "checkpoint resume: task %s is '%s', not waiting_human — skipping",
            task_id, trow["status"],
        )
        return {"status": "skipped", "reason": trow["status"]}

    # What the agent sees as the checkpoint tool's result.
    human_response: dict = {
        "status": status,
        "operator_response": row["response_text"] or "",
    }
    if status == "rejected":
        human_response["note"] = (
            "The operator declined this checkpoint. Do not retry the blocked "
            "action — wrap up gracefully and report what was completed."
        )
    hc["human_response"] = human_response

    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE tasks
            SET checkpoint = checkpoint || jsonb_build_object('_human_checkpoint', $2::jsonb)
            WHERE id = $1
            """,
            task_id, hc,
        )

    from app.pipeline.state_machine import transition_task_status
    ok = await transition_task_status(
        str(task_id), "queued",
        extra_sets=", queued_at = now()",
    )
    if not ok:
        logger.warning(
            "checkpoint resume: waiting_human → queued transition failed for task %s",
            task_id,
        )
        return {"status": "skipped", "reason": "transition_failed"}

    from app.queue import enqueue_task
    await enqueue_task(str(task_id))

    await audit.write_audit_event(
        pool,
        tenant_id=row["tenant_id"],
        task_id=task_id,
        actor_kind="human",
        actor_id=row["decided_by"] or "operator",
        event_type="consent_decision",
        tool_name=row["tool_name"],
        tool_kind="native",
        blast_radius=row["blast_radius"],
        response_status="success",
        response_summary=f"checkpoint {status}; task {task_id} resumed",
    )
    logger.info(
        "checkpoint resume: task %s re-queued (%s, reply=%d chars)",
        task_id, status, len(row["response_text"] or ""),
    )
    return {"status": "resumed", "task_id": str(task_id), "decision": status}


def _github_external_names() -> set[str]:
    """Return the set of github_external tool names. Cached on first call."""
    global _GITHUB_EXTERNAL_NAMES_CACHE
    if _GITHUB_EXTERNAL_NAMES_CACHE is None:
        from app.tools.github_external_tools import GITHUB_EXTERNAL_TOOLS
        _GITHUB_EXTERNAL_NAMES_CACHE = {t.name for t in GITHUB_EXTERNAL_TOOLS}
    return _GITHUB_EXTERNAL_NAMES_CACHE


_GITHUB_EXTERNAL_NAMES_CACHE: set[str] | None = None
