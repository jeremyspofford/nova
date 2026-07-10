"""
Pipeline API router — async task submission, status polling, pod + agent management.

Endpoints:
  POST   /api/v1/pipeline/tasks                  Submit a task to the async queue
  GET    /api/v1/pipeline/tasks                  List recent tasks (with filters)
  GET    /api/v1/pipeline/tasks/{task_id}        Get task status + output
  POST   /api/v1/pipeline/tasks/{task_id}/cancel Cancel a queued/pending task
  GET    /api/v1/pipeline/tasks/{task_id}/findings  Guardrail findings for a task
  GET    /api/v1/pipeline/tasks/{task_id}/reviews   Code review verdicts for a task
  GET    /api/v1/pipeline/tasks/{task_id}/sessions  Agent sessions for a task
  GET    /api/v1/pipeline/tasks/{task_id}/artifacts Artifacts produced by a task

  GET    /api/v1/pods                            List all pods
  POST   /api/v1/pods                            Create a new pod (admin)
  GET    /api/v1/pods/{pod_id}                   Get pod details + agents
  PATCH  /api/v1/pods/{pod_id}                   Update pod settings (admin)
  DELETE /api/v1/pods/{pod_id}                   Delete pod and its agents (admin)

  GET    /api/v1/pods/{pod_id}/agents            List agents in a pod
  POST   /api/v1/pods/{pod_id}/agents            Add agent to pod (admin)
  PATCH  /api/v1/pods/{pod_id}/agents/{agent_id} Update agent config (admin)
  DELETE /api/v1/pods/{pod_id}/agents/{agent_id} Remove agent from pod (admin)

  GET    /api/v1/pipeline/dead-letter            Inspect dead-letter queue (admin)

  GET    /api/v1/pipeline/notifications/stream  SSE stream for pipeline notifications
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from app.auth import AdminDep, ApiKeyDep
from app.config import settings
from app.db import get_pool
from app.queue import (
    clear_dead_letter,
    dead_letter_depth,
    dead_letter_items,
    enqueue_task,
    queue_depth,
)
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter(tags=["pipeline"])


# ── Pydantic models ────────────────────────────────────────────────────────────

class SubmitPipelineTaskRequest(BaseModel):
    user_input: str
    pod_name: str | None = None     # None → settings.default_pod_name
    goal_id: str | None = None      # Link task to a goal (Cortex uses this)
    metadata: dict[str, Any] = {}


class PipelineTaskResponse(BaseModel):
    task_id: str
    status: str
    pod_id: str | None
    queued_at: datetime | None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    current_stage: str | None = None
    output: str | None = None
    error: str | None = None
    retry_count: int
    metadata: dict[str, Any]


class PodRequest(BaseModel):
    name: str
    description: str = ""
    enabled: bool = True
    routing_keywords: list[str] = []
    default_model: str | None = None
    max_cost_usd: float | None = None
    max_execution_seconds: int = 300
    require_human_review: str = "on_escalation"   # always | never | on_escalation
    escalation_threshold: str = "medium"          # low | medium | high | critical
    sandbox: str = "workspace"                    # workspace | home | isolated (root removed per SEC-001)
    metadata: dict[str, Any] = {}


class PodResponse(BaseModel):
    id: str
    name: str
    description: str
    enabled: bool
    routing_keywords: list[str]
    default_model: str | None
    max_cost_usd: float | None
    max_execution_seconds: int
    require_human_review: str
    escalation_threshold: str
    sandbox: str
    metadata: dict[str, Any]
    created_at: datetime


class AgentRequest(BaseModel):
    name: str
    role: str                          # context | task | guardrail | code_review | decision
    enabled: bool = True
    position: int = 0                  # lower = runs first
    model: str | None = None           # None → pod default → service default
    fallback_models: list[str] = []    # tried in order when primary model fails
    temperature: float = 0.3
    max_tokens: int = 4096
    timeout_seconds: int = 120
    max_retries: int = 2
    system_prompt: str | None = None
    allowed_tools: list[str] | None = None   # None → all tools
    on_failure: str = "abort"          # abort | skip | escalate
    run_condition: dict[str, Any] = {"type": "always"}
    artifact_type: str | None = None
    parallel_group: str | None = None


class AgentResponse(AgentRequest):
    id: str
    pod_id: str
    created_at: datetime


# ── Pipeline task endpoints ────────────────────────────────────────────────────

@router.post("/api/v1/pipeline/tasks", status_code=202)
async def submit_pipeline_task(
    req: SubmitPipelineTaskRequest,
    key: ApiKeyDep,
) -> dict:
    """
    Submit a task to the async pipeline queue.
    Returns immediately with task_id — use GET /api/v1/pipeline/tasks/{task_id} to poll.
    """
    pod_name = req.pod_name or settings.default_pod_name
    pool = get_pool()

    async with pool.acquire() as conn:
        # Resolve pod_id from name (optional — executor falls back to default if NULL)
        pod_row = await conn.fetchrow(
            "SELECT id FROM pods WHERE name = $1 AND enabled = true", pod_name
        )
        pod_id = str(pod_row["id"]) if pod_row else None

        # Create task row
        task_row = await conn.fetchrow(
            """
            INSERT INTO tasks
                (user_input, pod_id, goal_id, status, metadata,
                 retry_count, max_retries, queued_at, checkpoint)
            VALUES
                ($1, $2::uuid, $3::uuid, 'queued', $4::jsonb,
                 0, $5, now(), '{}')
            RETURNING id, queued_at
            """,
            req.user_input,
            pod_id,
            req.goal_id,
            {**req.metadata, "api_key_id": str(key.id) if key.id else None},  # dict → codec handles JSONB
            settings.task_default_max_retries,
        )

    task_id = str(task_row["id"])
    await enqueue_task(task_id)

    log.info("Task %s submitted (pod=%s)", task_id, pod_name)
    return {
        "task_id": task_id,
        "status": "queued",
        "pod_name": pod_name,
        "queued_at": task_row["queued_at"].isoformat(),
    }


@router.get("/api/v1/pipeline/tasks")
async def list_pipeline_tasks(
    _key: ApiKeyDep,
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0, ge=0),
    status: str | None = Query(default=None),
    pod_id: str | None = Query(default=None),
    goal_id: str | None = Query(default=None),
) -> list[dict]:
    """List recent pipeline tasks, newest first. Optionally filter by status, pod, or goal."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT t.id, t.status, t.pod_id, t.goal_id, p.name AS pod_name,
                   t.user_input, t.output, t.error, t.current_stage,
                   t.retry_count, t.max_retries,
                   t.queued_at, t.started_at, t.completed_at, t.metadata,
                   t.summary
            FROM tasks t
            LEFT JOIN pods p ON p.id = t.pod_id
            WHERE ($1::text IS NULL OR t.status = $1)
              AND ($2::uuid IS NULL OR t.pod_id = $2::uuid)
              AND ($3::uuid IS NULL OR t.goal_id = $3::uuid)
            ORDER BY t.queued_at DESC
            LIMIT $4 OFFSET $5
            """,
            status, pod_id, goal_id, limit, offset,
        )
    return [_task_dict(r) for r in rows]


@router.get("/api/v1/pipeline/tasks/{task_id}")
async def get_pipeline_task(task_id: str, _key: ApiKeyDep) -> dict:
    """Get the full status and output of a pipeline task, including record counts."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT t.id, t.status, t.pod_id, p.name AS pod_name,
                   t.user_input, t.output, t.error, t.current_stage,
                   t.retry_count, t.max_retries,
                   t.queued_at, t.started_at, t.completed_at, t.metadata,
                   t.total_cost_usd,
                   t.checkpoint,
                   (SELECT COUNT(*) FROM guardrail_findings gf WHERE gf.task_id = t.id) AS findings_count,
                   (SELECT COUNT(*) FROM code_reviews cr WHERE cr.task_id = t.id) AS reviews_count,
                   (SELECT COUNT(*) FROM artifacts a WHERE a.task_id = t.id) AS artifacts_count
            FROM tasks t
            LEFT JOIN pods p ON p.id = t.pod_id
            WHERE t.id = $1::uuid
            """,
            task_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    d = _task_dict(row)
    d["findings_count"] = row["findings_count"]
    d["reviews_count"] = row["reviews_count"]
    d["artifacts_count"] = row["artifacts_count"]
    return d


@router.post("/api/v1/pipeline/tasks/{task_id}/cancel", status_code=200)
async def cancel_pipeline_task(task_id: str, _key: ApiKeyDep) -> dict:
    """Cancel a task. Only effective if still queued or pending human review."""
    from .pipeline.state_machine import transition_task_status

    ok = await transition_task_status(
        task_id, "cancelled",
        extra_sets=", completed_at = now()",
    )
    if not ok:
        raise HTTPException(
            status_code=409,
            detail="Task cannot be cancelled in its current state",
        )
    return {"task_id": task_id, "status": "cancelled"}


class ClarifyRequest(BaseModel):
    answers: list[str]


@router.post("/api/v1/pipeline/tasks/{task_id}/clarify", status_code=200)
async def clarify_pipeline_task(
    task_id: str,
    req: ClarifyRequest,
    _admin: AdminDep,
) -> dict:
    """Answer clarification questions for a paused pipeline task and re-queue it."""
    if not req.answers:
        raise HTTPException(status_code=400, detail="answers list required")

    import json as _json

    from .pipeline.state_machine import transition_task_status

    pool = get_pool()
    async with pool.acquire() as conn:
        task = await conn.fetchrow(
            "SELECT id, status, metadata FROM tasks WHERE id = $1::uuid",
            task_id,
        )
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        if task["status"] != "clarification_needed":
            raise HTTPException(
                status_code=409,
                detail=f"Task is in '{task['status']}' state, not 'clarification_needed'",
            )

        metadata = task["metadata"] if isinstance(task["metadata"], dict) else {}
        metadata["clarification_answers"] = req.answers
        metadata["clarification_round"] = metadata.get("clarification_round", 0) + 1

    ok = await transition_task_status(
        task_id, "queued",
        extra_sets=", metadata = $4::jsonb, queued_at = now()",
        extra_args=[_json.dumps(metadata)],
    )
    if not ok:
        raise HTTPException(
            status_code=409,
            detail="Task status changed before clarification could be applied",
        )

    await enqueue_task(task_id)
    log.info("Task %s re-queued after clarification (round=%d)", task_id, metadata["clarification_round"])
    return {"status": "re-queued", "task_id": task_id}


@router.delete("/api/v1/pipeline/tasks/{task_id}", status_code=204)
async def delete_pipeline_task(
    task_id: str,
    _admin: AdminDep,
    force: bool = Query(default=False, description="Cancel active task before deleting"),
) -> None:
    """
    Delete a task and all related records.
    FK CASCADE handles guardrail_findings, code_reviews, artifacts, agent_sessions.
    With force=true, cancels active tasks first. Admin-only.
    """
    pool = get_pool()
    async with pool.acquire() as conn:
        if force:
            await conn.execute(
                """
                UPDATE tasks SET status = 'cancelled', completed_at = now()
                WHERE id = $1::uuid
                  AND status NOT IN ('complete', 'failed', 'cancelled')
                """,
                task_id,
            )
        result = await conn.execute(
            "DELETE FROM tasks WHERE id = $1::uuid",
            task_id,
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Task not found")


@router.delete("/api/v1/pipeline/tasks")
async def bulk_delete_pipeline_tasks(
    _admin: AdminDep,
    status: str = Query(
        default="",
        description="Comma-separated terminal statuses to delete",
    ),
    ids: str = Query(
        default="",
        description="Comma-separated task UUIDs to delete",
    ),
    all_: bool = Query(
        default=False,
        alias="all",
        description="Clear history: delete every task that isn't actively running",
    ),
    force: bool = Query(
        default=False,
        description="Cancel active tasks before deleting",
    ),
) -> dict:
    """
    Bulk delete tasks — by all-non-running (clear history), status filter, or IDs.
    With force=true, active tasks are cancelled first then deleted. Admin-only.
    """
    TERMINAL = {"complete", "failed", "cancelled", "pending_human_review", "clarification_needed", "waiting_human"}
    pool = get_pool()

    # Mode 0: clear history — delete everything that isn't actively in-flight.
    # Keeps queued / completing / *_running; removes submitted orphans, terminal,
    # and human-waiting tasks. Status-agnostic so new terminal states are covered.
    if all_:
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                DELETE FROM tasks
                WHERE status NOT IN ('queued', 'completing')
                  AND status NOT LIKE '%running'
                """
            )
        deleted = int(result.split()[-1])
        log.info("Cleared task history: deleted %d non-running tasks", deleted)
        return {"deleted": deleted, "mode": "all"}

    # Mode 1: delete by specific IDs
    if ids:
        task_ids = [i.strip() for i in ids.split(",") if i.strip()]
        if not task_ids:
            raise HTTPException(status_code=400, detail="No valid IDs provided")
        async with pool.acquire() as conn:
            if force:
                # Cancel any active tasks first
                await conn.execute(
                    """
                    UPDATE tasks
                    SET status = 'cancelled', completed_at = now()
                    WHERE id = ANY($1::uuid[])
                      AND status NOT IN ('complete', 'failed', 'cancelled')
                    """,
                    task_ids,
                )
            result = await conn.execute(
                "DELETE FROM tasks WHERE id = ANY($1::uuid[])",
                task_ids,
            )
        deleted = int(result.split()[-1])
        log.info("Bulk deleted %d tasks by IDs (%d requested, force=%s)", deleted, len(task_ids), force)
        return {"deleted": deleted, "ids": task_ids}

    # Mode 2: delete by status filter (original behavior)
    requested = {s.strip() for s in status.split(",") if s.strip()}
    if not requested:
        requested = {"complete", "failed", "cancelled"}
    if not force:
        invalid = requested - TERMINAL
        if invalid:
            raise HTTPException(
                status_code=400,
                detail=f"Can only bulk-delete terminal statuses without force=true. Invalid: {invalid}",
            )

    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            DELETE FROM tasks
            WHERE status = ANY($1::text[])
            """,
            list(requested),
        )
    deleted = int(result.split()[-1])
    log.info("Bulk deleted %d tasks (statuses=%s)", deleted, requested)
    return {"deleted": deleted, "statuses": list(requested)}


@router.get("/api/v1/pipeline/tasks/{task_id}/findings")
async def list_task_findings(task_id: str, _key: ApiKeyDep) -> list[dict]:
    """List guardrail findings for a pipeline task."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, task_id, agent_session_id, finding_type, severity,
                   description, evidence, status, resolved_by,
                   resolution_notes, created_at, resolved_at
            FROM guardrail_findings
            WHERE task_id = $1::uuid
            ORDER BY created_at
            """,
            task_id,
        )
    return [
        _row_to_dict(r, uuid_fields=("id", "task_id", "agent_session_id"),
                     dt_fields=("created_at", "resolved_at"))
        for r in rows
    ]


@router.get("/api/v1/pipeline/tasks/{task_id}/reviews")
async def list_task_reviews(task_id: str, _key: ApiKeyDep) -> list[dict]:
    """List code review verdicts for a pipeline task, ordered by iteration."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, task_id, agent_session_id, iteration, verdict,
                   issues, summary, created_at
            FROM code_reviews
            WHERE task_id = $1::uuid
            ORDER BY iteration
            """,
            task_id,
        )
    return [
        _row_to_dict(r, uuid_fields=("id", "task_id", "agent_session_id"),
                     dt_fields=("created_at",))
        for r in rows
    ]


@router.get("/api/v1/pipeline/tasks/{task_id}/sessions")
async def list_task_sessions(task_id: str, _key: ApiKeyDep) -> list[dict]:
    """List agent sessions for a pipeline task, ordered by execution sequence."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT ON (role)
                   id, task_id, role, status, error, traceback,
                   duration_ms, model_used, cost_usd, started_at
            FROM agent_sessions
            WHERE task_id = $1::uuid
            ORDER BY role, started_at DESC
            """,
            task_id,
        )
    return [
        _row_to_dict(r, uuid_fields=("id", "task_id"),
                     dt_fields=("started_at",))
        for r in rows
    ]


@router.get("/api/v1/pipeline/tasks/{task_id}/artifacts")
async def list_task_artifacts(task_id: str, _key: ApiKeyDep) -> list[dict]:
    """List artifacts produced during a pipeline task."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, task_id, agent_session_id, artifact_type, name,
                   content, content_hash, file_path, metadata, created_at
            FROM artifacts
            WHERE task_id = $1::uuid
            ORDER BY created_at
            """,
            task_id,
        )
    return [
        _row_to_dict(r, uuid_fields=("id", "task_id", "agent_session_id"),
                     dt_fields=("created_at",))
        for r in rows
    ]


class ReviewDecisionRequest(BaseModel):
    decision: str           # "approve" | "reject"
    comment: str | None = None


@router.post("/api/v1/pipeline/tasks/{task_id}/review", status_code=200)
async def review_pending_task(
    task_id: str,
    req: ReviewDecisionRequest,
    _admin: AdminDep,
) -> dict:
    """
    Approve or reject a task paused in pending_human_review.

    approve — re-queues the task so it resumes from checkpoint and completes.
              Because all pipeline stages were checkpointed before pausing, the
              executor skips every agent and completes immediately at zero LLM cost.

    reject  — marks the task cancelled and records the reviewer's comment.

    Both paths write an audit log entry for the decision trail.
    """
    if req.decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="decision must be 'approve' or 'reject'")

    pool = get_pool()

    if req.decision == "approve":
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE tasks
                SET status    = 'queued',
                    metadata  = metadata || jsonb_build_object(
                        'human_approved_at', now()::text,
                        'human_comment',     $2::text
                    )
                WHERE id = $1::uuid AND status = 'pending_human_review'
                """,
                task_id, req.comment or "",
            )
        if result == "UPDATE 0":
            raise HTTPException(
                status_code=409,
                detail="Task is not in pending_human_review state",
            )
        await enqueue_task(task_id)
        log.info("Task %s approved by human reviewer — re-queued", task_id)

        # Audit trail
        from app.audit import write_audit_log
        async with get_pool().acquire() as conn:
            await write_audit_log(
                conn,
                event_type="human_review_approved",
                severity="info",
                task_id=task_id,
                message="Human reviewer approved task — resuming from checkpoint",
                data={"comment": req.comment},
            )

        return {"task_id": task_id, "status": "queued", "decision": "approve"}

    else:  # reject
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE tasks
                SET status       = 'cancelled',
                    completed_at = now(),
                    error        = $2,
                    metadata     = metadata || jsonb_build_object(
                        'human_rejected_at', now()::text,
                        'human_comment',     $2::text
                    )
                WHERE id = $1::uuid AND status = 'pending_human_review'
                """,
                task_id, req.comment or "Rejected by human reviewer",
            )
        if result == "UPDATE 0":
            raise HTTPException(
                status_code=409,
                detail="Task is not in pending_human_review state",
            )
        log.info("Task %s rejected by human reviewer", task_id)

        from app.audit import write_audit_log
        async with get_pool().acquire() as conn:
            await write_audit_log(
                conn,
                event_type="human_review_rejected",
                severity="warning",
                task_id=task_id,
                message="Human reviewer rejected task — cancelled",
                data={"comment": req.comment},
            )

        return {"task_id": task_id, "status": "cancelled", "decision": "reject"}


@router.get("/api/v1/pipeline/queue-stats")
async def queue_stats(_admin: AdminDep) -> dict:
    """Queue depth, dead-letter depth for ops visibility."""
    return {
        "queue_depth": await queue_depth(),
        "dead_letter_depth": await dead_letter_depth(),
    }


@router.get("/api/v1/pipeline/dead-letter")
async def get_dead_letter_tasks(
    _admin: AdminDep,
    limit: int = Query(default=100, le=200),
) -> list[dict]:
    """List entries in the dead-letter queue (tasks that exhausted all retries).

    Reads the Redis dead-letter list — the same source as the `dead_letter_depth`
    counter — and enriches each entry with the task's input/status from Postgres
    when the row still exists.
    """
    entries = await dead_letter_items(limit)
    if not entries:
        return []

    task_ids = [e["task_id"] for e in entries if e.get("task_id")]
    detail_by_id: dict[str, dict] = {}
    if task_ids:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, status, user_input, error,
                       retry_count, max_retries, queued_at, completed_at
                FROM tasks
                WHERE id = ANY($1::uuid[])
                """,
                task_ids,
            )
        detail_by_id = {str(r["id"]): dict(r) for r in rows}

    result: list[dict] = []
    for e in entries:
        detail = detail_by_id.get(str(e.get("task_id")), {})
        result.append({
            "task_id": e.get("task_id"),
            "reason": e.get("reason"),
            "timestamp": e.get("timestamp"),
            "exists": bool(detail),
            "status": detail.get("status"),
            "user_input": detail.get("user_input"),
            "error": detail.get("error"),
            "retry_count": detail.get("retry_count"),
            "max_retries": detail.get("max_retries"),
        })
    return result


@router.delete("/api/v1/pipeline/dead-letter")
async def clear_dead_letter_queue(_admin: AdminDep) -> dict:
    """Flush the dead-letter queue. Admin-only."""
    removed = await clear_dead_letter()
    log.info("Cleared dead-letter queue: removed %d entries", removed)
    return {"cleared": removed}


# ── Pod endpoints ──────────────────────────────────────────────────────────────

@router.get("/api/v1/pods")
async def list_pods(_key: ApiKeyDep) -> list[dict]:
    """List all pods (enabled and disabled)."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT p.*,
                   COUNT(pa.id) FILTER (WHERE pa.enabled) AS active_agent_count
            FROM pods p
            LEFT JOIN pod_agents pa ON pa.pod_id = p.id
            GROUP BY p.id
            ORDER BY p.name
            """
        )
    return [dict(r) for r in rows]


@router.post("/api/v1/pods", status_code=201)
async def create_pod(req: PodRequest, _admin: AdminDep) -> dict:
    """Create a new pod configuration. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO pods
                (name, description, enabled, routing_keywords, default_model,
                 max_cost_usd, max_execution_seconds, require_human_review,
                 escalation_threshold, sandbox, metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
            RETURNING *
            """,
            req.name, req.description, req.enabled,
            req.routing_keywords, req.default_model,
            req.max_cost_usd, req.max_execution_seconds,
            req.require_human_review, req.escalation_threshold,
            req.sandbox, req.metadata,
        )
    return dict(row)


@router.get("/api/v1/pods/{pod_id}")
async def get_pod(pod_id: str, _key: ApiKeyDep) -> dict:
    """Get pod details including its agent list."""
    pool = get_pool()
    async with pool.acquire() as conn:
        pod = await conn.fetchrow("SELECT * FROM pods WHERE id = $1::uuid", pod_id)
        if not pod:
            raise HTTPException(status_code=404, detail="Pod not found")
        agents = await conn.fetch(
            "SELECT * FROM pod_agents WHERE pod_id = $1::uuid ORDER BY position",
            pod_id,
        )
    return {**dict(pod), "agents": [dict(a) for a in agents]}


@router.patch("/api/v1/pods/{pod_id}")
async def update_pod(pod_id: str, req: PodRequest, _admin: AdminDep) -> dict:
    """Update pod configuration. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE pods SET
                name                 = $2,
                description          = $3,
                enabled              = $4,
                routing_keywords     = $5,
                default_model        = $6,
                max_cost_usd         = $7,
                max_execution_seconds = $8,
                require_human_review = $9,
                escalation_threshold = $10,
                sandbox              = $11,
                metadata             = $12::jsonb
            WHERE id = $1::uuid
            RETURNING *
            """,
            pod_id, req.name, req.description, req.enabled,
            req.routing_keywords, req.default_model,
            req.max_cost_usd, req.max_execution_seconds,
            req.require_human_review, req.escalation_threshold,
            req.sandbox, req.metadata,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Pod not found")
    return dict(row)


@router.delete("/api/v1/pods/{pod_id}", status_code=204)
async def delete_pod(pod_id: str, _admin: AdminDep) -> None:
    """Delete a pod and all its agents. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM pods WHERE id = $1::uuid", pod_id
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Pod not found")


# ── Pod agent endpoints ────────────────────────────────────────────────────────

@router.get("/api/v1/pods/{pod_id}/agents")
async def list_pod_agents(pod_id: str, _key: ApiKeyDep) -> list[dict]:
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM pod_agents WHERE pod_id = $1::uuid ORDER BY position",
            pod_id,
        )
    return [dict(r) for r in rows]


@router.post("/api/v1/pods/{pod_id}/agents", status_code=201)
async def add_pod_agent(pod_id: str, req: AgentRequest, _admin: AdminDep) -> dict:
    """Add an agent to a pod. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        # Verify pod exists
        exists = await conn.fetchval(
            "SELECT 1 FROM pods WHERE id = $1::uuid", pod_id
        )
        if not exists:
            raise HTTPException(status_code=404, detail="Pod not found")

        row = await conn.fetchrow(
            """
            INSERT INTO pod_agents
                (pod_id, name, role, enabled, position, parallel_group,
                 model, fallback_models, temperature, max_tokens, timeout_seconds,
                 max_retries, system_prompt, allowed_tools, on_failure,
                 run_condition, artifact_type)
            VALUES
                ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
            RETURNING *
            """,
            pod_id, req.name, req.role, req.enabled, req.position,
            req.parallel_group, req.model, req.fallback_models,
            req.temperature, req.max_tokens,
            req.timeout_seconds, req.max_retries, req.system_prompt,
            req.allowed_tools, req.on_failure,
            req.run_condition, req.artifact_type,
        )
    return dict(row)


@router.patch("/api/v1/pods/{pod_id}/agents/{agent_id}")
async def update_pod_agent(
    pod_id: str, agent_id: str, req: AgentRequest, _admin: AdminDep
) -> dict:
    """Update an agent's configuration. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE pod_agents SET
                name            = $3,
                role            = $4,
                enabled         = $5,
                position        = $6,
                parallel_group  = $7,
                model           = $8,
                fallback_models = $9,
                temperature     = $10,
                max_tokens      = $11,
                timeout_seconds = $12,
                max_retries     = $13,
                system_prompt   = $14,
                allowed_tools   = $15,
                on_failure      = $16,
                run_condition   = $17::jsonb,
                artifact_type   = $18
            WHERE id = $1::uuid AND pod_id = $2::uuid
            RETURNING *
            """,
            agent_id, pod_id, req.name, req.role, req.enabled, req.position,
            req.parallel_group, req.model, req.fallback_models,
            req.temperature, req.max_tokens,
            req.timeout_seconds, req.max_retries, req.system_prompt,
            req.allowed_tools, req.on_failure,
            req.run_condition, req.artifact_type,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found in this pod")
    return dict(row)


@router.delete("/api/v1/pods/{pod_id}/agents/{agent_id}", status_code=204)
async def delete_pod_agent(pod_id: str, agent_id: str, _admin: AdminDep) -> None:
    """Remove an agent from a pod. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM pod_agents WHERE id = $1::uuid AND pod_id = $2::uuid",
            agent_id, pod_id,
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Agent not found in this pod")


# ── MCP server management (admin-only) ────────────────────────────────────────

class MCPServerRequest(BaseModel):
    name: str
    description: str = ""
    transport: str = "stdio"          # "stdio" | "http"
    command: str | None = None        # stdio: executable to spawn
    args: list[str] = []              # stdio: argument list
    env: dict[str, str] = {}          # stdio: extra environment variables
    url: str | None = None            # http: server base URL
    enabled: bool = True
    metadata: dict[str, Any] = {}


def _row_to_dict(
    row,
    *,
    uuid_fields: tuple[str, ...] = ("id",),
    dt_fields: tuple[str, ...] = ("created_at",),
) -> dict:
    """Convert an asyncpg Record to a JSON-safe dict."""
    d = dict(row)
    for f in uuid_fields:
        if f in d and d[f] is not None:
            d[f] = str(d[f])
    for f in dt_fields:
        if f in d and d[f] is not None:
            d[f] = d[f].isoformat()
    return d


def _mcp_row_to_dict(row) -> dict:
    d = _row_to_dict(row)
    d["args"] = list(d.get("args") or [])
    d["env"] = dict(d.get("env") or {})
    d["metadata"] = dict(d.get("metadata") or {})
    return d


@router.get("/api/v1/mcp-servers")
async def list_mcp_servers(_admin: AdminDep) -> list[dict]:
    """List all registered MCP servers with live connection status. Admin-only."""
    from app.pipeline.tools.registry import list_connected_servers

    connected_map = {s["name"]: s for s in list_connected_servers()}
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM mcp_servers ORDER BY name")

    result = []
    for row in rows:
        d = _mcp_row_to_dict(row)
        status = connected_map.get(d["name"])
        d["connected"]    = status["connected"]   if status else False
        d["tool_count"]   = status["tool_count"]  if status else 0
        d["active_tools"] = status["tools"]        if status else []
        result.append(d)
    return result


class MCPInstallRequest(BaseModel):
    template_id: str
    name: str | None = None           # display name; slugified for mcp_servers.name
    fields: dict[str, str] = {}        # user-supplied values keyed by catalog field key
    enabled: bool = True


@router.get("/api/v1/mcp-servers/catalog")
async def mcp_integration_catalog(_admin: AdminDep) -> list[dict]:
    """Curated one-click MCP integration templates (Home Assistant, n8n, Pi-hole, …). Admin-only."""
    from app.mcp_catalog import list_catalog
    return list_catalog()


@router.post("/api/v1/mcp-servers/install", status_code=201)
async def install_mcp_server(req: MCPInstallRequest, _admin: AdminDep) -> dict:
    """Install an MCP server from a catalog template.

    Secret fields are stored in platform_secrets (encrypted); mcp_servers.env holds
    only ``${secret:...}`` references, resolved at connect time. Admin-only.
    """
    from app.mcp_catalog import get_template, render_install, slugify
    from app.secrets_store import set_secret

    tpl = get_template(req.template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail=f"Unknown integration template '{req.template_id}'")

    server_name = slugify(req.name or tpl["name"])
    try:
        payload, secrets = render_install(tpl, server_name, req.fields)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    pool = get_pool()
    async with pool.acquire() as conn:
        if await conn.fetchval("SELECT 1 FROM mcp_servers WHERE name=$1", server_name):
            raise HTTPException(
                status_code=409,
                detail=f"An MCP server named '{server_name}' already exists",
            )

    # Persist secrets (encrypted) before inserting the row that references them.
    for skey, sval in secrets:
        await set_secret(pool, skey, sval)

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO mcp_servers
                (name, description, transport, command, args, env, url, enabled, metadata)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb)
            RETURNING *
            """,
            payload["name"], payload["description"], payload["transport"],
            payload["command"], payload["args"], payload["env"], payload["url"],
            req.enabled, payload["metadata"],
        )
    d = _mcp_row_to_dict(row)

    if req.enabled:
        from app.pipeline.tools.registry import reload_mcp_server
        d["connected"] = await reload_mcp_server(server_name)
    else:
        d["connected"] = False
    d["tool_count"] = 0
    d["active_tools"] = []
    return d


@router.post("/api/v1/mcp-servers", status_code=201)
async def create_mcp_server(req: MCPServerRequest, _admin: AdminDep) -> dict:
    """Register a new MCP server and immediately attempt to connect if enabled. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO mcp_servers
                (name, description, transport, command, args, env, url, enabled, metadata)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb)
            RETURNING *
            """,
            req.name, req.description, req.transport, req.command,
            req.args, req.env, req.url, req.enabled, req.metadata,
        )
    d = _mcp_row_to_dict(row)

    # Immediately attempt connection if enabled stdio server
    if req.enabled and req.transport == "stdio" and req.command:
        from app.pipeline.tools.registry import reload_mcp_server
        d["connected"] = await reload_mcp_server(req.name)
    else:
        d["connected"] = False
    d["tool_count"]   = 0
    d["active_tools"] = []
    return d


@router.patch("/api/v1/mcp-servers/{server_id}")
async def update_mcp_server(
    server_id: str, req: MCPServerRequest, _admin: AdminDep
) -> dict:
    """Update an MCP server's configuration. Triggers a reconnect. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE mcp_servers SET
                name        = $2,
                description = $3,
                transport   = $4,
                command     = $5,
                args        = $6::jsonb,
                env         = $7::jsonb,
                url         = $8,
                enabled     = $9,
                metadata    = $10::jsonb
            WHERE id = $1::uuid
            RETURNING *
            """,
            server_id, req.name, req.description, req.transport,
            req.command, req.args, req.env, req.url, req.enabled, req.metadata,
        )
    if not row:
        raise HTTPException(status_code=404, detail="MCP server not found")
    d = _mcp_row_to_dict(row)

    # Reconnect with new config
    if req.enabled and req.transport == "stdio" and req.command:
        from app.pipeline.tools.registry import reload_mcp_server
        d["connected"] = await reload_mcp_server(req.name)
    else:
        from app.pipeline.tools.registry import disconnect_server
        await disconnect_server(req.name)
        d["connected"] = False
    return d


@router.delete("/api/v1/mcp-servers/{server_id}", status_code=204)
async def delete_mcp_server(server_id: str, _admin: AdminDep) -> None:
    """Remove an MCP server from the registry and disconnect it. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "DELETE FROM mcp_servers WHERE id = $1::uuid RETURNING name",
            server_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="MCP server not found")

    from app.pipeline.tools.registry import disconnect_server
    await disconnect_server(row["name"])


@router.post("/api/v1/mcp-servers/{server_id}/reload", status_code=200)
async def reload_mcp_server_endpoint(server_id: str, _admin: AdminDep) -> dict:
    """Reload (reconnect) an MCP server without restarting the orchestrator. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT name FROM mcp_servers WHERE id = $1::uuid", server_id
        )
    if not row:
        raise HTTPException(status_code=404, detail="MCP server not found")

    from app.pipeline.tools.registry import list_connected_servers, reload_mcp_server
    connected = await reload_mcp_server(row["name"])
    status = next(
        (s for s in list_connected_servers() if s["name"] == row["name"]),
        None,
    )
    return {
        "name": row["name"],
        "connected": connected,
        "tool_count": status["tool_count"] if status else 0,
        "tools": status["tools"] if status else [],
    }


# ── Agent Endpoints (ACP/A2A outbound delegation) ─────────────────────────────

class AgentEndpointRequest(BaseModel):
    name: str
    description: str = ""
    url: str
    auth_token: str | None = None
    protocol: str = "a2a"            # 'a2a' | 'acp' | 'generic'
    input_schema: dict[str, Any] = {}
    output_schema: dict[str, Any] = {}
    enabled: bool = True
    metadata: dict[str, Any] = {}


def _endpoint_row_to_dict(row) -> dict:
    d = _row_to_dict(row)
    d["input_schema"] = dict(d.get("input_schema") or {})
    d["output_schema"] = dict(d.get("output_schema") or {})
    d["metadata"] = dict(d.get("metadata") or {})
    # Never expose the raw auth token in list responses
    d.pop("auth_token", None)
    return d


@router.get("/api/v1/agent-endpoints")
async def list_agent_endpoints(_admin: AdminDep) -> list[dict]:
    """List all registered agent endpoints. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM agent_endpoints ORDER BY name"
        )
    return [_endpoint_row_to_dict(r) for r in rows]


@router.post("/api/v1/agent-endpoints", status_code=201)
async def create_agent_endpoint(
    req: AgentEndpointRequest, _admin: AdminDep
) -> dict:
    """Register a new external agent endpoint. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO agent_endpoints
                (name, description, url, auth_token, protocol,
                 input_schema, output_schema, enabled, metadata)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb)
            RETURNING *
            """,
            req.name, req.description, req.url, req.auth_token,
            req.protocol, req.input_schema, req.output_schema,
            req.enabled, req.metadata,
        )
    return _endpoint_row_to_dict(row)


@router.get("/api/v1/agent-endpoints/{endpoint_id}")
async def get_agent_endpoint(endpoint_id: str, _admin: AdminDep) -> dict:
    """Get a single agent endpoint by ID. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM agent_endpoints WHERE id = $1::uuid", endpoint_id
        )
    if not row:
        raise HTTPException(status_code=404, detail="Agent endpoint not found")
    return _endpoint_row_to_dict(row)


@router.patch("/api/v1/agent-endpoints/{endpoint_id}")
async def update_agent_endpoint(
    endpoint_id: str, req: AgentEndpointRequest, _admin: AdminDep
) -> dict:
    """Update an agent endpoint configuration. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE agent_endpoints SET
                name          = $2,
                description   = $3,
                url           = $4,
                auth_token    = $5,
                protocol      = $6,
                input_schema  = $7::jsonb,
                output_schema = $8::jsonb,
                enabled       = $9,
                metadata      = $10::jsonb
            WHERE id = $1::uuid
            RETURNING *
            """,
            endpoint_id, req.name, req.description, req.url,
            req.auth_token, req.protocol,
            req.input_schema, req.output_schema,
            req.enabled, req.metadata,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Agent endpoint not found")
    return _endpoint_row_to_dict(row)


@router.delete("/api/v1/agent-endpoints/{endpoint_id}", status_code=204)
async def delete_agent_endpoint_route(
    endpoint_id: str, _admin: AdminDep
) -> None:
    """Remove an agent endpoint. Admin-only."""
    pool = get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM agent_endpoints WHERE id = $1::uuid", endpoint_id
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Agent endpoint not found")


# ── Pipeline Stats ─────────────────────────────────────────────────────────────

@router.get("/api/v1/pipeline/stats")
async def pipeline_stats(_admin: AdminDep) -> dict:
    """Aggregate pipeline task stats for the dashboard overview."""
    pool = get_pool()
    async with pool.acquire() as conn:
        counts = await conn.fetchrow(
            """
            SELECT
              COUNT(*) FILTER (WHERE status IN ('running','context_running','task_running',
                                                'guardrail_running','review_running')) AS active_count,
              COUNT(*) FILTER (WHERE status = 'queued') AS queued_count,
              COUNT(*) FILTER (WHERE status = 'complete' AND completed_at >= CURRENT_DATE) AS completed_today,
              COUNT(*) FILTER (WHERE status = 'complete' AND completed_at >= NOW() - INTERVAL '7 days') AS completed_this_week,
              COUNT(*) FILTER (WHERE status = 'failed' AND completed_at >= CURRENT_DATE) AS failed_today,
              COUNT(*) FILTER (WHERE status = 'failed' AND completed_at >= NOW() - INTERVAL '7 days') AS failed_this_week,
              COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS submitted_today
            FROM tasks
            """
        )
        rate_row = await conn.fetchrow(
            """
            SELECT CASE WHEN (c + f) > 0 THEN c::float / (c + f) ELSE 0 END AS rate
            FROM (
              SELECT COUNT(*) FILTER (WHERE status = 'complete') AS c,
                     COUNT(*) FILTER (WHERE status = 'failed') AS f
              FROM tasks WHERE completed_at >= NOW() - INTERVAL '7 days'
            ) sub
            """
        )
        dur_row = await conn.fetchrow(
            """
            SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000), 0)::int AS avg_ms
            FROM tasks
            WHERE status = 'complete'
              AND completed_at >= NOW() - INTERVAL '7 days'
              AND started_at IS NOT NULL
            """
        )
    return {
        "active_count": counts["active_count"],
        "queued_count": counts["queued_count"],
        "completed_today": counts["completed_today"],
        "completed_this_week": counts["completed_this_week"],
        "failed_today": counts["failed_today"],
        "failed_this_week": counts["failed_this_week"],
        "submitted_today": counts["submitted_today"],
        "success_rate_7d": round(rate_row["rate"], 4),
        "avg_duration_ms": dur_row["avg_ms"],
    }


@router.post("/api/v1/pipeline/reap-now", tags=["pipeline-ops"])
async def trigger_reap_now(_admin: AdminDep) -> dict:
    """Admin-only: trigger one reaper cycle immediately (for testing)."""
    from .reaper import (
        _reap_stale_checkpoints,
        _reap_stale_clarifications,
        _reap_stale_running_tasks,
        _reap_stuck_queued_tasks,
        _reap_timed_out_sessions,
    )
    await _reap_stale_running_tasks()
    await _reap_stuck_queued_tasks()
    await _reap_timed_out_sessions()
    await _reap_stale_clarifications()
    await _reap_stale_checkpoints()
    return {"status": "reaped"}


@router.get("/api/v1/pipeline/stats/latency")
async def pipeline_latency_stats(_admin: AdminDep) -> dict:
    """Per-stage latency breakdown from the last 7 days of agent sessions."""
    pool = get_pool()
    async with pool.acquire() as conn:
        stage_rows = await conn.fetch(
            """
            SELECT role,
              AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::int AS avg_ms
            FROM agent_sessions
            WHERE completed_at IS NOT NULL
              AND started_at IS NOT NULL
              AND completed_at >= NOW() - INTERVAL '7 days'
            GROUP BY role
            """
        )
        overall = await conn.fetchrow(
            """
            SELECT
              COALESCE(AVG(dur), 0)::int AS avg_ms,
              COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dur), 0)::int AS p50_ms,
              COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY dur), 0)::int AS p95_ms
            FROM (
              SELECT EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS dur
              FROM agent_sessions
              WHERE completed_at IS NOT NULL
                AND started_at IS NOT NULL
                AND completed_at >= NOW() - INTERVAL '7 days'
            ) sub
            """
        )
    return {
        "avg_total_ms": overall["avg_ms"],
        "p50_ms": overall["p50_ms"],
        "p95_ms": overall["p95_ms"],
        "by_stage": [{"stage": r["role"], "avg_ms": r["avg_ms"]} for r in stage_rows],
    }


# ── SSE Notifications ──────────────────────────────────────────────────────────

@router.get("/api/v1/pipeline/notifications/stream", tags=["pipeline-notifications"])
async def notification_stream(request: Request):
    """SSE stream for pipeline notifications. No auth required — regular users need this."""
    import asyncio as _asyncio

    from app.store import get_redis

    async def event_generator():
        redis = get_redis()
        pubsub = redis.pubsub()
        await pubsub.subscribe("nova:notifications")
        try:
            while True:
                if await request.is_disconnected():
                    break
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message["type"] == "message":
                    data = message["data"]
                    if isinstance(data, bytes):
                        data = data.decode()
                    yield f"data: {data}\n\n"
                else:
                    # SSE heartbeat to keep connection alive
                    yield ": heartbeat\n\n"
                    await _asyncio.sleep(5)
        finally:
            await pubsub.unsubscribe("nova:notifications")
            await pubsub.close()

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ── Helpers ────────────────────────────────────────────────────────────────────

def _task_dict(row) -> dict:
    """Convert a task DB row to a JSON-serialisable dict."""
    return _row_to_dict(
        row,
        uuid_fields=("id", "pod_id", "goal_id"),
        dt_fields=("queued_at", "started_at", "completed_at"),
    )
