"""
Diagnosis Tools -- self-introspection for Nova agents.

These tools let Nova diagnose its own failures instead of asking the user
what went wrong. They expose existing diagnostic data (tasks, agent sessions,
guardrail findings, code reviews, service health, queue depths) as
agent-callable tools.

Tools provided:
  diagnose_task       -- comprehensive diagnostic info for a task
  check_service_health -- health status of all Nova services + queue depths
  get_recent_errors   -- error pattern analysis over recent failed tasks
  get_stage_output    -- checkpoint data for a specific pipeline stage
  get_task_timeline   -- full task lifecycle with durations
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import httpx
from nova_contracts import BlastRadius, ToolDefinition

log = logging.getLogger(__name__)

# ─── Tool definitions (what the LLM sees) ────────────────────────────────────

DIAGNOSIS_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="diagnose_task",
        description=(
            "Get comprehensive diagnostic information for a task. Returns the task's "
            "status, error, current stage, retry count, all agent session outputs and "
            "errors, guardrail findings, code review verdicts, checkpoint data, and a "
            "full timeline. Use this when a task fails or behaves unexpectedly."
        ),
        parameters={
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "UUID of the task to diagnose",
                },
            },
            "required": ["task_id"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="check_service_health",
        description=(
            "Check the health of all Nova services (orchestrator, llm-gateway, "
            "memory-service, chat-api, cortex, recovery) and Redis queue depths "
            "(task queue, dead letter, memory ingestion). Use this to determine "
            "if a failure is caused by a service being down or queues backing up."
        ),
        parameters={"type": "object", "properties": {}, "required": []},
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="get_recent_errors",
        description=(
            "Analyse recent task failures. Returns failed tasks grouped by error "
            "type and pipeline stage, with frequency counts. Use this to spot "
            "patterns like a specific stage consistently failing or a recurring "
            "error message."
        ),
        parameters={
            "type": "object",
            "properties": {
                "hours": {
                    "type": "integer",
                    "description": "How many hours back to look (default: 24, max: 168)",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="get_stage_output",
        description=(
            "Get what a specific pipeline stage produced for a task. Reads the "
            "checkpoint JSONB for the given task and stage name. Use this to "
            "inspect intermediate pipeline results (e.g. what the context agent "
            "gathered, what the guardrail agent flagged)."
        ),
        parameters={
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "UUID of the task",
                },
                "stage": {
                    "type": "string",
                    "description": (
                        "Pipeline stage name: 'context', 'task', 'guardrail', "
                        "'code_review', or 'decision'"
                    ),
                },
            },
            "required": ["task_id", "stage"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="get_task_timeline",
        description=(
            "Get the full lifecycle timeline of a task, including when it was "
            "created, queued, each agent session start/end with durations, and "
            "final completion. Use this to identify bottlenecks or stages that "
            "took unusually long."
        ),
        parameters={
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "UUID of the task",
                },
            },
            "required": ["task_id"],
        },
        blast_radius=BlastRadius.READ,
    ),
]


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _fmt_ts(ts: datetime | None) -> str | None:
    """Format a timestamp for display, or return None."""
    if ts is None:
        return None
    return ts.isoformat()


def _safe_json(obj) -> str:
    """JSON-serialize with fallback for non-serializable types."""
    def _default(o):
        if isinstance(o, datetime):
            return o.isoformat()
        return str(o)
    return json.dumps(obj, indent=2, default=_default)


# ─── Tool implementations ────────────────────────────────────────────────────

async def _execute_diagnose_task(task_id: str) -> str:
    """Comprehensive diagnostic dump for a single task."""
    from app.db import get_pool

    pool = get_pool()

    # Fetch the task
    task = await pool.fetchrow(
        """
        SELECT id, status, error, current_stage, retry_count, max_retries,
               output, checkpoint, user_input, goal_id, pod_id,
               total_cost_usd, total_input_tokens, total_output_tokens,
               created_at, queued_at, started_at, completed_at, metadata
        FROM tasks WHERE id = $1::uuid
        """,
        task_id,
    )
    if not task:
        return f"Task {task_id!r} not found."

    # Fetch agent sessions
    sessions = await pool.fetch(
        """
        SELECT id, role, position, status, model, input_tokens, output_tokens,
               cost_usd, output, error, started_at, completed_at, duration_ms
        FROM agent_sessions
        WHERE task_id = $1::uuid
        ORDER BY position, started_at
        """,
        task_id,
    )

    # Fetch guardrail findings
    findings = await pool.fetch(
        """
        SELECT finding_type, severity, description, evidence, status, resolution_notes,
               created_at, resolved_at
        FROM guardrail_findings
        WHERE task_id = $1::uuid
        ORDER BY created_at
        """,
        task_id,
    )

    # Fetch code reviews
    reviews = await pool.fetch(
        """
        SELECT iteration, verdict, issues, summary, created_at
        FROM code_reviews
        WHERE task_id = $1::uuid
        ORDER BY iteration
        """,
        task_id,
    )

    # Build the diagnostic report
    sections = []

    # Task overview
    sections.append("=== Task Diagnosis ===")
    sections.append(f"Task ID:       {task['id']}")
    sections.append(f"Status:        {task['status']}")
    sections.append(f"Current stage: {task['current_stage'] or 'none'}")
    sections.append(f"Retry count:   {task['retry_count']}/{task['max_retries']}")
    if task["error"]:
        sections.append(f"Error:         {task['error']}")
    if task["goal_id"]:
        sections.append(f"Goal ID:       {task['goal_id']}")
    sections.append(f"Input (first 200 chars): {(task['user_input'] or '')[:200]}")
    sections.append(f"Cost: ${float(task['total_cost_usd'] or 0):.6f}  "
                     f"({task['total_input_tokens']} in / {task['total_output_tokens']} out tokens)")

    # Agent sessions
    sections.append("")
    sections.append("=== Agent Sessions ===")
    if not sessions:
        sections.append("No agent sessions recorded.")
    for s in sessions:
        duration = f"{s['duration_ms']}ms" if s["duration_ms"] else "n/a"
        sections.append(
            f"  [{s['position']}] {s['role']}  status={s['status']}  "
            f"model={s['model'] or 'default'}  duration={duration}"
        )
        if s["error"]:
            sections.append(f"      ERROR: {s['error']}")
        if s["output"]:
            output_preview = _safe_json(s["output"])
            if len(output_preview) > 500:
                output_preview = output_preview[:500] + "... [truncated]"
            sections.append(f"      Output: {output_preview}")

    # Guardrail findings
    if findings:
        sections.append("")
        sections.append("=== Guardrail Findings ===")
        for f in findings:
            sections.append(
                f"  [{f['severity'].upper()}] {f['finding_type']}: {f['description']}"
            )
            if f["evidence"]:
                sections.append(f"      Evidence: {f['evidence'][:300]}")
            sections.append(f"      Status: {f['status']}")
            if f["resolution_notes"]:
                sections.append(f"      Resolution: {f['resolution_notes']}")

    # Code reviews
    if reviews:
        sections.append("")
        sections.append("=== Code Reviews ===")
        for r in reviews:
            sections.append(f"  Iteration {r['iteration']}: {r['verdict']}")
            if r["summary"]:
                sections.append(f"      Summary: {r['summary'][:300]}")
            issues = r["issues"]
            if issues:
                issue_list = issues if isinstance(issues, list) else []
                for issue in issue_list[:5]:
                    sev = issue.get("severity", "?")
                    desc = issue.get("description", str(issue))
                    sections.append(f"      - [{sev}] {desc}")
                if len(issue_list) > 5:
                    sections.append(f"      ... and {len(issue_list) - 5} more issues")

    # Checkpoint data (stage outputs)
    checkpoint = task["checkpoint"]
    if checkpoint and isinstance(checkpoint, dict) and checkpoint:
        sections.append("")
        sections.append("=== Checkpoint (stage outputs) ===")
        for stage_name, stage_data in checkpoint.items():
            preview = _safe_json(stage_data)
            if len(preview) > 300:
                preview = preview[:300] + "... [truncated]"
            sections.append(f"  {stage_name}: {preview}")

    # Timeline
    sections.append("")
    sections.append("=== Timeline ===")
    sections.append(f"  Created:   {_fmt_ts(task['created_at'])}")
    sections.append(f"  Queued:    {_fmt_ts(task['queued_at'])}")
    sections.append(f"  Started:   {_fmt_ts(task['started_at'])}")
    for s in sessions:
        label = f"  {s['role']}:"
        started = _fmt_ts(s["started_at"]) or "?"
        ended = _fmt_ts(s["completed_at"]) or "running"
        duration = f" ({s['duration_ms']}ms)" if s["duration_ms"] else ""
        sections.append(f"  {label:20s} {started} -> {ended}{duration}")
    sections.append(f"  Completed: {_fmt_ts(task['completed_at'])}")

    return "\n".join(sections)


async def _execute_check_service_health() -> str:
    """Hit each service's /health/ready and report status + queue depths."""
    services = {
        "orchestrator":   "http://localhost:8000",
        "llm-gateway":    "http://llm-gateway:8001",
        "memory-service": "http://memory-service:8002",
        "chat-api":       "http://chat-api:8080",
        "cortex":         "http://cortex:8100",
        "recovery":       "http://recovery:8888",
    }

    results = []
    results.append("=== Service Health ===")

    async with httpx.AsyncClient(timeout=5.0) as client:
        for name, base_url in services.items():
            try:
                resp = await client.get(f"{base_url}/health/ready")
                if resp.status_code == 200:
                    data = resp.json()
                    status = data.get("status", "unknown")
                    results.append(f"  {name:20s} {status.upper()}")
                else:
                    results.append(f"  {name:20s} UNHEALTHY (HTTP {resp.status_code})")
            except httpx.ConnectError:
                results.append(f"  {name:20s} DOWN (connection refused)")
            except httpx.TimeoutException:
                results.append(f"  {name:20s} DOWN (timeout)")
            except Exception as e:
                results.append(f"  {name:20s} ERROR ({e})")

    # Redis queue depths
    results.append("")
    results.append("=== Queue Depths ===")
    try:
        from app.store import get_redis
        redis = get_redis()

        # Task queue (db2 -- orchestrator's own Redis)
        task_depth = await redis.llen("nova:queue:tasks")
        dead_letter = await redis.llen("nova:queue:dead_letter")
        results.append(f"  Task queue:     {task_depth}")
        results.append(f"  Dead letter:    {dead_letter}")
    except Exception as e:
        results.append(f"  Task queue:     ERROR ({e})")

    # Memory ingestion queue lives in db0 (memory-service's Redis)
    try:
        import redis.asyncio as aioredis
        from app.config import settings
        # Ingestion queue is in db0, derive URL from orchestrator's db2 URL
        ingest_redis_url = settings.redis_url.rsplit("/", 1)[0] + "/0"
        ingest_redis = aioredis.from_url(ingest_redis_url, decode_responses=True)
        try:
            ingest_depth = await ingest_redis.llen("memory:ingestion:queue")
            results.append(f"  Memory ingest:  {ingest_depth}")
        finally:
            await ingest_redis.close()
    except Exception as e:
        results.append(f"  Memory ingest:  ERROR ({e})")

    return "\n".join(results)


async def _execute_get_recent_errors(hours: int = 24) -> str:
    """Query recent failed tasks and group by error type/stage."""
    from app.db import get_pool

    hours = max(1, min(hours, 168))
    pool = get_pool()

    # Fetch recent failed tasks
    rows = await pool.fetch(
        """
        SELECT id, status, error, current_stage, retry_count, created_at, completed_at
        FROM tasks
        WHERE status = 'failed'
          AND created_at > now() - make_interval(hours => $1)
        ORDER BY created_at DESC
        LIMIT 100
        """,
        hours,
    )

    if not rows:
        return f"No failed tasks in the last {hours} hours."

    sections = [f"=== Failed Tasks (last {hours}h) — {len(rows)} total ==="]

    # Group by stage
    by_stage: dict[str, int] = {}
    # Group by error pattern (first 80 chars)
    by_error: dict[str, int] = {}

    for r in rows:
        stage = r["current_stage"] or "unknown"
        by_stage[stage] = by_stage.get(stage, 0) + 1

        error = (r["error"] or "no error message")[:80]
        by_error[error] = by_error.get(error, 0) + 1

    sections.append("")
    sections.append("Failures by stage:")
    for stage, count in sorted(by_stage.items(), key=lambda x: -x[1]):
        sections.append(f"  {stage:25s} {count}")

    sections.append("")
    sections.append("Failures by error pattern:")
    for error, count in sorted(by_error.items(), key=lambda x: -x[1])[:15]:
        sections.append(f"  ({count}x) {error}")

    # Also check for failed agent sessions in the same window
    session_errors = await pool.fetch(
        """
        SELECT role, error, count(*) as cnt
        FROM agent_sessions
        WHERE status = 'failed'
          AND started_at > now() - make_interval(hours => $1)
          AND error IS NOT NULL
        GROUP BY role, error
        ORDER BY cnt DESC
        LIMIT 15
        """,
        hours,
    )

    if session_errors:
        sections.append("")
        sections.append("Agent session failures:")
        for s in session_errors:
            error_preview = (s["error"] or "")[:80]
            sections.append(f"  ({s['cnt']}x) [{s['role']}] {error_preview}")

    # Recent examples (last 5)
    sections.append("")
    sections.append("Most recent failures:")
    for r in rows[:5]:
        ts = _fmt_ts(r["created_at"])
        stage = r["current_stage"] or "?"
        error = (r["error"] or "no message")[:120]
        sections.append(f"  {ts}  stage={stage}  retries={r['retry_count']}")
        sections.append(f"    {error}")

    return "\n".join(sections)


async def _execute_get_stage_output(task_id: str, stage: str) -> str:
    """Return the checkpoint data for a specific pipeline stage."""
    from app.db import get_pool

    pool = get_pool()

    row = await pool.fetchrow(
        "SELECT checkpoint FROM tasks WHERE id = $1::uuid",
        task_id,
    )
    if not row:
        return f"Task {task_id!r} not found."

    checkpoint = row["checkpoint"]
    if not checkpoint or not isinstance(checkpoint, dict):
        return f"Task {task_id} has no checkpoint data."

    stage_data = checkpoint.get(stage)
    if stage_data is None:
        available = list(checkpoint.keys()) or ["none"]
        return (
            f"Stage '{stage}' not found in checkpoint for task {task_id}. "
            f"Available stages: {', '.join(available)}"
        )

    output = _safe_json(stage_data)
    # Cap output to avoid blowing up the LLM context
    if len(output) > 6000:
        output = output[:6000] + "\n\n[... truncated at 6000 chars ...]"

    return f"Stage '{stage}' output for task {task_id}:\n{output}"


async def _execute_get_task_timeline(task_id: str) -> str:
    """Full task lifecycle timeline with durations."""
    from app.db import get_pool

    pool = get_pool()

    task = await pool.fetchrow(
        """
        SELECT id, status, current_stage, user_input,
               created_at, queued_at, started_at, completed_at
        FROM tasks WHERE id = $1::uuid
        """,
        task_id,
    )
    if not task:
        return f"Task {task_id!r} not found."

    sessions = await pool.fetch(
        """
        SELECT role, position, status, model, started_at, completed_at, duration_ms
        FROM agent_sessions
        WHERE task_id = $1::uuid
        ORDER BY position, started_at
        """,
        task_id,
    )

    sections = [f"=== Timeline for task {task_id} ==="]
    sections.append(f"Status: {task['status']}")
    sections.append(f"Input:  {(task['user_input'] or '')[:150]}")
    sections.append("")

    events: list[tuple[str, datetime | None, str]] = []

    events.append(("Task created", task["created_at"], ""))
    if task["queued_at"]:
        wait = ""
        if task["created_at"] and task["queued_at"]:
            delta = (task["queued_at"] - task["created_at"]).total_seconds()
            wait = f" (waited {delta:.1f}s)"
        events.append(("Task queued", task["queued_at"], wait))
    if task["started_at"]:
        events.append(("Pipeline started", task["started_at"], ""))

    for s in sessions:
        role = s["role"]
        if s["started_at"]:
            events.append((f"{role} started", s["started_at"], f" model={s['model'] or 'default'}"))
        if s["completed_at"]:
            duration_note = f" ({s['duration_ms']}ms)" if s["duration_ms"] else ""
            status_note = f" status={s['status']}"
            events.append((f"{role} ended", s["completed_at"], f"{status_note}{duration_note}"))

    if task["completed_at"]:
        total = ""
        if task["created_at"] and task["completed_at"]:
            delta = (task["completed_at"] - task["created_at"]).total_seconds()
            total = f" (total {delta:.1f}s)"
        events.append((f"Task {task['status']}", task["completed_at"], total))

    # Sort by timestamp and render
    events.sort(key=lambda x: x[1] or datetime.min.replace(tzinfo=timezone.utc))
    for label, ts, note in events:
        ts_str = _fmt_ts(ts) or "?"
        sections.append(f"  {ts_str}  {label}{note}")

    # Summary stats
    sections.append("")
    sections.append("=== Duration Summary ===")
    for s in sessions:
        if s["duration_ms"]:
            sections.append(f"  {s['role']:20s} {s['duration_ms']:>8d}ms  ({s['status']})")
    if task["created_at"] and task["completed_at"]:
        total_ms = int((task["completed_at"] - task["created_at"]).total_seconds() * 1000)
        sections.append(f"  {'TOTAL':20s} {total_ms:>8d}ms")

    return "\n".join(sections)


# ─── Tool execution ───────────────────────────────────────────────────────────

async def execute_tool(name: str, arguments: dict) -> str:
    """Dispatch a diagnosis tool call by name."""
    log.info("Executing diagnosis tool: %s  args=%s", name, arguments)
    try:
        if name == "diagnose_task":
            return await _execute_diagnose_task(arguments["task_id"])
        elif name == "check_service_health":
            return await _execute_check_service_health()
        elif name == "get_recent_errors":
            return await _execute_get_recent_errors(
                hours=arguments.get("hours", 24),
            )
        elif name == "get_stage_output":
            return await _execute_get_stage_output(
                task_id=arguments["task_id"],
                stage=arguments["stage"],
            )
        elif name == "get_task_timeline":
            return await _execute_get_task_timeline(arguments["task_id"])
        else:
            return f"Unknown diagnosis tool '{name}'"
    except Exception as e:
        log.error("Diagnosis tool %s failed: %s", name, e, exc_info=True)
        return f"Tool '{name}' failed: {e}"
