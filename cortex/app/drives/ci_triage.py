"""CI Triage drive — react to GitHub workflow_run.failure stimuli.

Triggered by the stimulus queue. For each pending failure event,
checks the watchlist + dedup + budget + active-hours window.
If accepted, dispatches a Goal that flows through cortex maturation
(scoping → speccing → triage → building → verifying) and ends up as
an orchestrator task with pod=ci_triage_agent.

This drive is reactive — its assess() always returns zero urgency.
Work happens via handle_stimulus() called from cycle.py.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from uuid import UUID, uuid4

from ..clients import get_orchestrator
from ..config import settings
from ..db import get_pool
from . import DriveContext, DriveResult

log = logging.getLogger(__name__)

_GENESIS_HASH = b'\x00' * 32


async def _write_budget_exceeded_audit(
    pool,
    *,
    tenant_id: str,
    repo: str,
    daily_budget: int,
    today_count: int,
) -> None:
    """Insert a budget_exceeded audit row into capability_audit.

    Mirrors the hash-chain logic from orchestrator/app/capabilities/audit.py
    so cortex can write audit events without importing the orchestrator package.
    """
    audit_id = uuid4()
    timestamp = datetime.now(timezone.utc)
    tenant_uuid = UUID(tenant_id)
    summary = f"daily_budget={daily_budget} reached (count={today_count}) for repo={repo}"

    def _canonical_json(obj) -> str:
        return json.dumps(obj, sort_keys=True, default=str, separators=(",", ":"))

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                f"capability_audit:{tenant_uuid}",
            )
            prev_hash_row = await conn.fetchval(
                "SELECT content_hash FROM capability_audit "
                "WHERE tenant_id=$1 ORDER BY timestamp DESC, id DESC LIMIT 1",
                tenant_uuid,
            )
            prev_hash: bytes = bytes(prev_hash_row) if prev_hash_row else _GENESIS_HASH

            content = _canonical_json({
                "id": str(audit_id),
                "tenant_id": str(tenant_uuid),
                "user_id": None,
                "timestamp": timestamp.isoformat(),
                "actor_kind": "cortex_drive",
                "actor_id": "ci_triage",
                "task_id": None,
                "event_type": "budget_exceeded",
                "tool_name": None,
                "tool_kind": None,
                "blast_radius": None,
                "provider_kind": "github",
                "target": repo,
                "credential_id": None,
                "args_redacted": None,
                "response_status": "rejected",
                "response_summary": summary,
                "error_class": None,
                "duration_ms": None,
                "prev_hash": prev_hash.hex(),
            })
            content_hash = hashlib.sha256(content.encode()).digest()

            await conn.execute(
                """
                INSERT INTO capability_audit (
                  id, tenant_id, user_id, timestamp,
                  actor_kind, actor_id, task_id,
                  event_type, tool_name, tool_kind, blast_radius,
                  provider_kind, target, credential_id,
                  args_redacted, response_status, response_summary,
                  error_class, duration_ms,
                  prev_hash, content_hash
                ) VALUES (
                  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                  $15,$16,$17,$18,$19,$20,$21
                )
                """,
                audit_id, tenant_uuid, None, timestamp,
                "cortex_drive", "ci_triage", None,
                "budget_exceeded", None, None, None,
                "github", repo, None,
                None, "rejected", summary,
                None, None,
                prev_hash, content_hash,
            )


async def handle_stimulus(stimulus: dict) -> dict:
    """Process one CI_WORKFLOW_RUN_FAILURE stimulus.

    Stimulus payload shape (from webhooks_router):
      {
        "type": "ci.workflow_run.failure",
        "tenant_id": "...",
        "credential_id": "...",
        "repo": "owner/name",
        "run_id": 12345,
        "head_sha": "abc",
        "head_branch": "feature-x",
        "workflow_name": "tests",
        "html_url": "https://github.com/.../runs/12345",
      }

    Steps:
      1. Validate required fields.
      2. Look up cortex_watched_repos for (tenant_id, repo).
         If absent OR enabled=false → skip.
      3. Dedup: have we already created a Goal for this run_id?
         (Check goals table by tag/metadata). If yes → skip.
      4. Daily budget check: count goals created today for this
         watched repo. If >= daily_budget → skip with audit log.
      5. Active hours check: if outside configured window → skip.
      6. Create a Goal via orchestrator /api/v1/goals.
         Tags the goal with run_id so future dedup works.
    """
    # Stimulus may arrive as flat dict or nested under "payload"
    payload = stimulus.get("payload") or stimulus
    repo = payload.get("repo") or stimulus.get("repo")
    run_id = payload.get("run_id") or stimulus.get("run_id")
    tenant_id = payload.get("tenant_id") or stimulus.get("tenant_id")

    if not repo or not run_id:
        log.warning("ci_triage stimulus missing repo or run_id: %s", stimulus)
        return {"status": "skipped", "reason": "invalid_stimulus"}

    pool = get_pool()

    # ── 1. Watchlist lookup ────────────────────────────────────────────────
    async with pool.acquire() as conn:
        watched = await conn.fetchrow(
            """SELECT id, enabled, daily_budget, active_hours_start, active_hours_end
               FROM cortex_watched_repos
               WHERE tenant_id = $1::uuid AND repo = $2""",
            tenant_id,
            repo,
        )

    if not watched:
        log.debug("ci_triage: repo %s not in watchlist for tenant %s", repo, tenant_id)
        return {"status": "skipped", "reason": "not_watched"}

    if not watched["enabled"]:
        log.debug("ci_triage: repo %s watchlist entry disabled", repo)
        return {"status": "skipped", "reason": "watch_disabled"}

    watched_repo_id = str(watched["id"])

    # ── 2. Dedup: have we already created a goal for this run_id? ─────────
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            """SELECT id FROM goals
               WHERE current_plan->>'ci_run_id' = $1
                  OR (title LIKE $2 AND status IN ('active','completed'))""",
            str(run_id),
            f"%-run-{run_id}",
        )

    if existing:
        log.info("ci_triage: run_id %s already has goal %s — skipping", run_id, existing["id"])
        return {"status": "skipped", "reason": "already_dispatched", "goal_id": str(existing["id"])}

    # ── 3. Daily budget check ──────────────────────────────────────────────
    daily_budget = watched["daily_budget"]
    async with pool.acquire() as conn:
        today_count = await conn.fetchval(
            """SELECT COUNT(*) FROM goals
               WHERE created_at >= CURRENT_DATE
                 AND current_plan->>'ci_watched_repo_id' = $1""",
            watched_repo_id,
        )

    if today_count >= daily_budget:
        log.warning(
            "ci_triage: daily budget exhausted for repo %s (%d/%d)",
            repo, today_count, daily_budget,
        )
        try:
            await _write_budget_exceeded_audit(
                pool,
                tenant_id=tenant_id,
                repo=repo,
                daily_budget=daily_budget,
                today_count=today_count,
            )
        except Exception as exc:
            log.warning("ci_triage: failed to write budget_exceeded audit: %s", exc)
        return {"status": "skipped", "reason": "budget_exceeded"}

    # ── 4. Active hours check ──────────────────────────────────────────────
    hours_start = watched["active_hours_start"]
    hours_end = watched["active_hours_end"]
    if hours_start and hours_end:
        now_time = datetime.now(timezone.utc).time().replace(tzinfo=None)
        # Handle overnight windows (e.g. 22:00–06:00)
        if hours_start <= hours_end:
            in_window = hours_start <= now_time <= hours_end
        else:
            in_window = now_time >= hours_start or now_time <= hours_end
        if not in_window:
            log.info("ci_triage: outside active hours %s–%s for repo %s", hours_start, hours_end, repo)
            return {"status": "skipped", "reason": "outside_active_hours"}

    # ── 5. Create Goal ─────────────────────────────────────────────────────
    head_branch = payload.get("head_branch") or stimulus.get("head_branch", "unknown")
    workflow_name = payload.get("workflow_name") or stimulus.get("workflow_name", "CI")
    html_url = payload.get("html_url") or stimulus.get("html_url", "")
    head_sha = payload.get("head_sha") or stimulus.get("head_sha", "")

    title = f"CI triage: {repo} {workflow_name} failure on {head_branch} (run {run_id})"
    description = (
        f"GitHub Actions workflow '{workflow_name}' failed on branch '{head_branch}'.\n"
        f"Repo: {repo}\nRun ID: {run_id}\nCommit: {head_sha}\nURL: {html_url}\n\n"
        f"Triage: locate root cause, draft minimal fix, open PR or leave diagnosis comment."
    )

    initial_plan = {
        "ci_run_id": str(run_id),
        "ci_repo": repo,
        "ci_watched_repo_id": watched_repo_id,
        "ci_head_branch": head_branch,
        "ci_head_sha": head_sha,
        "ci_workflow_name": workflow_name,
        "ci_html_url": html_url,
        "pod": "ci_triage_agent",
    }

    try:
        client = get_orchestrator()
        resp = await client.post(
            "/api/v1/goals",
            json={
                "title": title,
                "description": description,
                "priority": 5,
                "max_iterations": 12,
                "created_via": "cortex_ci_triage",
                # CI triage goals run autonomously — the human-in-the-loop
                # gate is the per-call MUTATE approval (open_fix_pr etc.)
                # surfaced through the capability platform's consent gate,
                # not a per-goal spec review. Setting review_policy='auto'
                # lets cortex skip the speccing-approval phase and dispatch
                # straight to ci_triage_agent.
                "review_policy": "auto",
            },
            headers={"Authorization": f"Bearer {settings.cortex_api_key}"},
        )
        if resp.status_code not in (200, 201):
            log.error(
                "ci_triage: failed to create goal for run %s: HTTP %d — %s",
                run_id, resp.status_code, resp.text[:200],
            )
            return {"status": "error", "reason": "goal_creation_failed", "http_status": resp.status_code}

        goal = resp.json()
        goal_id = goal["id"]

        # Persist the CI metadata into current_plan so dedup and pod routing work
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE goals SET current_plan = $1::jsonb WHERE id = $2::uuid",
                initial_plan,
                goal_id,
            )

        log.info(
            "ci_triage: dispatched goal %s for repo=%s run_id=%s branch=%s",
            goal_id, repo, run_id, head_branch,
        )
        return {"status": "dispatched", "goal_id": goal_id, "run_id": run_id}

    except Exception as e:
        log.error("ci_triage: unexpected error creating goal for run %s: %s", run_id, e)
        return {"status": "error", "reason": str(e)}


async def assess(ctx: DriveContext | None = None) -> DriveResult:
    """The CI triage drive doesn't add urgency on its own — it reacts to stimuli.

    Stimulus processing happens in handle_stimulus(), called directly from
    cycle.py when a ci.workflow_run.failure stimulus is drained from the queue.
    Return zero urgency to keep cortex's idle cycle calm.
    """
    return DriveResult(
        name="ci_triage",
        priority=2,
        urgency=0.0,
        description="reactive — see handle_stimulus",
        context={},
    )
