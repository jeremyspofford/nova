"""API endpoints for AI quality scores and benchmark results."""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import httpx
from app.auth import AdminDep
from app.db import get_pool
from app.quality_loop.cases import BenchmarkCase, load_cases
from app.quality_loop.score import SCORER_REGISTRY
from app.quality_loop.snapshot import capture_snapshot
from app.quality_loop.teardown import teardown_benchmark_engrams
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

log = logging.getLogger(__name__)
quality_router = APIRouter(tags=["quality"])

# Cases directory — relative to /app/app/quality_router.py inside the container,
# parents[2] is /, so /benchmarks/quality/cases. Locally:
# orchestrator/app/quality_router.py → parents[2] is the repo root.
_CASES_DIR = Path(__file__).resolve().parents[2] / "benchmarks" / "quality" / "cases"


class ScoreBucket(BaseModel):
    period: str
    dimension: str
    avg_score: float
    count: int


class QualitySummary(BaseModel):
    period_days: int
    dimensions: dict
    composite: float


@quality_router.get("/api/v1/quality/scores", response_model=list[ScoreBucket])
async def get_quality_scores(
    _admin: AdminDep,
    dimension: str | None = None,
    conversation_id: str | None = None,
    granularity: str = Query("daily", regex="^(hourly|daily)$"),
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
):
    """Time-bucketed quality scores for dashboard charts."""
    pool = get_pool()

    now = datetime.now(timezone.utc)
    start = datetime.fromisoformat(from_) if from_ else now - timedelta(days=7)
    end = datetime.fromisoformat(to) if to else now

    trunc = "hour" if granularity == "hourly" else "day"

    conditions = ["created_at >= $1", "created_at <= $2"]
    params: list = [start, end]
    idx = 3

    if dimension:
        conditions.append(f"dimension = ${idx}")
        params.append(dimension)
        idx += 1

    if conversation_id:
        conditions.append(f"conversation_id = ${idx}::uuid")
        params.append(conversation_id)
        idx += 1

    where = " AND ".join(conditions)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT
                date_trunc('{trunc}', created_at) AS period,
                dimension,
                AVG(score) AS avg_score,
                COUNT(*) AS count
            FROM quality_scores
            WHERE {where}
            GROUP BY period, dimension
            ORDER BY period DESC
            """,
            *params,
        )

    return [
        ScoreBucket(
            period=row["period"].isoformat(),
            dimension=row["dimension"],
            avg_score=round(float(row["avg_score"]), 4),
            count=row["count"],
        )
        for row in rows
    ]


@quality_router.get("/api/v1/quality/summary")
async def get_quality_summary(
    _admin: AdminDep,
    period: str = Query("7d", regex=r"^\d+d$"),
):
    """Aggregated quality averages and trend vs previous period."""
    pool = get_pool()
    days = int(period.rstrip("d"))
    now = datetime.now(timezone.utc)
    current_start = now - timedelta(days=days)
    prev_start = current_start - timedelta(days=days)

    async with pool.acquire() as conn:
        current_rows = await conn.fetch(
            """
            SELECT dimension, AVG(score) AS avg, COUNT(*) AS count
            FROM quality_scores
            WHERE created_at >= $1
            GROUP BY dimension
            """,
            current_start,
        )

        prev_rows = await conn.fetch(
            """
            SELECT dimension, AVG(score) AS avg
            FROM quality_scores
            WHERE created_at >= $1 AND created_at < $2
            GROUP BY dimension
            """,
            prev_start,
            current_start,
        )

    prev_map = {r["dimension"]: float(r["avg"]) for r in prev_rows}

    WEIGHTS = {
        "memory_relevance": 0.30,
        "memory_recall": 0.25,
        "tool_accuracy": 0.20,
        "response_coherence": 0.15,
        "task_completion": 0.10,
    }

    dimensions = {}
    weighted_sum = 0.0
    weight_total = 0.0

    for row in current_rows:
        dim = row["dimension"]
        avg = round(float(row["avg"]), 4)
        prev_avg = prev_map.get(dim)
        trend = round(avg - prev_avg, 4) if prev_avg is not None else 0.0

        dimensions[dim] = {
            "avg": avg,
            "count": row["count"],
            "trend": trend,
        }

        w = WEIGHTS.get(dim, 0.0)
        weighted_sum += avg * w
        weight_total += w

    composite = round((weighted_sum / weight_total) * 100, 2) if weight_total > 0 else 0.0

    return {
        "period_days": days,
        "dimensions": dimensions,
        "composite": composite,
    }


@quality_router.post("/api/v1/quality/benchmarks/run", status_code=202)
async def run_quality_benchmark_v2(
    _admin: AdminDep,
    category: str | None = None,
):
    """Kick off a fixture-driven quality benchmark run.

    Captures a config snapshot, loads cases from
    benchmarks/quality/cases/*.yaml, runs each in-process via
    run_agent_turn, scores against the unified vocabulary, and tears
    down seeded engrams in a finally block. Returns run_id immediately;
    actual work runs in a background task.
    """
    pool = get_pool()

    snapshot_id, _ = await capture_snapshot("benchmark_run")

    async with pool.acquire() as conn:
        run_id = await conn.fetchval(
            """
            INSERT INTO quality_benchmark_runs
                (status, metadata, config_snapshot_id, vocabulary_version)
            VALUES ('running', $1, $2, 2)
            RETURNING id::text
            """,
            {"category_filter": category},
            snapshot_id,
        )

    asyncio.create_task(_run_benchmark_v2(run_id, category))
    return {"run_id": run_id, "status": "running"}


@quality_router.post("/api/v1/benchmarks/run-quality", status_code=202)
async def run_quality_benchmark_legacy(
    _admin: AdminDep,
    category: str | None = None,
):
    """Legacy alias. Will be removed once dashboard migrates."""
    return await run_quality_benchmark_v2(_admin, category)


# ── Tool-call instrumentation ─────────────────────────────────────────────────
# run_agent_turn does not surface tool_calls in the returned TaskResult, so we
# patch app.tools.execute_tool for the duration of a benchmark case to record
# tool invocations. Benchmarks run serially, so a module-level dict keyed by
# session_id is safe.
_BENCHMARK_TOOLS_USED: dict[str, list[str]] = {}

# Serialise benchmark runs so concurrent triggers can't corrupt the
# _ToolTracker monkey-patch on app.agents.runner.execute_tool. The second
# __aenter__ would otherwise capture the first run's wrapper as "original"
# and the first __aexit__ would restore the wrong reference.
_BENCHMARK_RUN_LOCK = asyncio.Lock()


class _ToolTracker:
    """Async context manager that records tool calls per session_id."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._original = None

    async def __aenter__(self) -> "_ToolTracker":
        from app.agents import runner as runner_mod
        _BENCHMARK_TOOLS_USED[self.session_id] = []
        self._original = runner_mod.execute_tool

        async def _tracking_execute_tool(name: str, arguments: dict) -> str:  # type: ignore[no-redef]
            try:
                _BENCHMARK_TOOLS_USED[self.session_id].append(name)
            except Exception:  # noqa: BLE001 — never block real tool calls
                pass
            return await self._original(name, arguments)

        runner_mod.execute_tool = _tracking_execute_tool
        return self

    async def __aexit__(self, *exc) -> None:
        from app.agents import runner as runner_mod
        if self._original is not None:
            runner_mod.execute_tool = self._original

    def calls(self) -> list[str]:
        return list(_BENCHMARK_TOOLS_USED.get(self.session_id, []))


async def _run_benchmark_v2(run_id: str, category: str | None) -> None:
    """Execute fixture-driven benchmark cases, score against unified vocabulary.

    Wrapped in a module-level lock so concurrent runs can't corrupt the
    _ToolTracker monkey-patch (each tracker captures app.agents.runner.execute_tool
    on enter and restores on exit — overlapping runs would clobber each other).

    Wrapped in a top-level try/except so any unhandled exception (e.g. YAML
    parse error in load_cases, DB transient failure) marks the run as 'failed'
    instead of leaving it stuck in 'running' forever.
    """
    pool = get_pool()
    try:
        async with _BENCHMARK_RUN_LOCK:
            cases = load_cases(_CASES_DIR, category=category)

            if not cases:
                await _mark_failed(pool, run_id, "no benchmark cases found")
                return

            seeded_engram_ids: list[str] = []
            case_results: list[dict] = []
            error_summary_parts: list[str] = []

            try:
                for case in cases:
                    log.info("Benchmark[%s]: running %s", run_id[:8], case.name)
                    try:
                        case_seeded, case_scores = await _run_single_case(case, run_id)
                        seeded_engram_ids.extend(case_seeded)
                        case_results.append({
                            "name": case.name,
                            "category": case.category,
                            "scores": case_scores,
                            "composite": (
                                sum(case_scores.values()) / len(case_scores)
                                if case_scores else 0.0
                            ),
                        })
                    except Exception as e:
                        log.exception("Case %s failed", case.name)
                        error_summary_parts.append(f"{case.name}: {e}")
                        case_results.append({
                            "name": case.name,
                            "category": case.category,
                            "scores": {},
                            "composite": 0.0,
                            "error": str(e)[:200],
                        })

                # Aggregate dimension_scores by averaging across cases
                dim_totals: dict[str, list[float]] = {}
                for cr in case_results:
                    for dim, score in cr["scores"].items():
                        dim_totals.setdefault(dim, []).append(score)
                dimension_scores = {
                    dim: round(sum(scores) / len(scores), 4)
                    for dim, scores in dim_totals.items()
                }

                all_composites = [cr["composite"] for cr in case_results if cr.get("scores")]
                composite = (
                    round((sum(all_composites) / len(all_composites)) * 100, 2)
                    if all_composites else 0.0
                )

                async with pool.acquire() as conn:
                    await conn.execute(
                        """
                        UPDATE quality_benchmark_runs
                        SET status = 'completed',
                            completed_at = NOW(),
                            composite_score = $2,
                            dimension_scores = $3,
                            case_results = $4,
                            error_summary = $5
                        WHERE id = $1::uuid
                        """,
                        run_id,
                        composite,
                        dimension_scores,
                        case_results,
                        "; ".join(error_summary_parts) if error_summary_parts else None,
                    )
                log.info("Benchmark[%s] completed: %.1f composite", run_id[:8], composite)

            finally:
                if seeded_engram_ids:
                    deleted = await teardown_benchmark_engrams(seeded_engram_ids)
                    log.info(
                        "Benchmark[%s] teardown: %d/%d engrams deleted",
                        run_id[:8], deleted, len(seeded_engram_ids),
                    )
    except Exception as e:
        log.exception("Benchmark[%s] crashed: %s", run_id[:8], e)
        try:
            await _mark_failed(pool, run_id, f"runner crash: {e}")
        except Exception:
            pass


async def _run_single_case(
    case: BenchmarkCase,
    run_id: str,
) -> tuple[list[str], dict[str, float]]:
    """Seed engrams, run conversation, score per-dimension.

    Returns (seeded_engram_ids, scores_by_dimension).
    """
    from app.agents.runner import run_agent_turn
    from app.model_resolver import resolve_default_model
    from app.store import ensure_primary_agent

    tag = run_id[:8]
    seeded_ids: list[str] = []

    # Seed benchmark engrams via the memory-service ingestion endpoint.
    async with httpx.AsyncClient(timeout=120) as client:
        for engram in case.seed_engrams:
            r = await client.post(
                "http://memory-service:8002/api/v1/engrams/ingest",
                json={
                    "raw_text": f"[benchmark:{tag}] {engram['content']}",
                    "source_type": engram.get("source_type", "chat"),
                    "source_metadata": {"benchmark_run_id": run_id},
                },
            )
            if r.status_code in (200, 201):
                seeded_ids.extend(r.json().get("engram_ids", []))
            # Give the ingestion worker a beat to drain before the next ingest.
            await asyncio.sleep(1)

    # Resolve a real agent — _build_nova_context and other helpers walk the
    # agent registry, so we cannot use a synthetic ID. ensure_primary_agent
    # is idempotent and returns the existing Nova primary if one exists.
    primary = await ensure_primary_agent()
    agent_id = str(primary.id)
    model = primary.config.model or await resolve_default_model()
    system_prompt = primary.config.system_prompt

    # One disposable session per case so memory cache and engram queue
    # don't conflate cases. Tool tracker keys off this same session_id.
    session_id = f"benchmark-{run_id[:8]}-{case.name}"

    responses: list[dict] = []
    async with _ToolTracker(session_id) as tracker:
        # Build conversation incrementally so multi-turn cases feed prior
        # exchanges back to the model.
        messages: list[dict] = []
        for msg in case.conversation:
            user_msg = msg.get("user", "")
            if not user_msg:
                continue
            messages.append({"role": "user", "content": user_msg})
            task_id = uuid4()
            try:
                result = await run_agent_turn(
                    agent_id=agent_id,
                    task_id=task_id,
                    session_id=session_id,
                    messages=messages,
                    model=model,
                    system_prompt=system_prompt,
                    api_key_id=None,
                    explicit_model=True,  # don't reroute via classifier
                    agent_name=primary.config.name,
                    skip_memory_storage=True,  # benchmarks don't pollute production engram graph
                )
            except Exception as e:
                log.warning("Benchmark[%s] case %s turn failed: %s",
                            run_id[:8], case.name, e)
                break

            response_text = result.response or ""
            responses.append({
                "content": response_text,
                "status": result.status.value if result.status else None,
                "error": result.error,
                "tools_used": tracker.calls(),
            })
            # Append the assistant turn so the next user message has context.
            messages.append({"role": "assistant", "content": response_text})

        tools_used = tracker.calls()

    # Score per declared dimension using the last response.
    last_response = responses[-1] if responses else {}
    response_text = last_response.get("content", "") or ""
    response_metadata = {"tools_used": tools_used}

    last_user_msg = ""
    if case.conversation:
        last_user_msg = case.conversation[-1].get("user", "") or ""

    scores: dict[str, float] = {}
    for dim, rule in case.scoring.items():
        if dim not in SCORER_REGISTRY:
            log.warning("unknown dimension in case %s: %s", case.name, dim)
            continue
        mode, fn = SCORER_REGISTRY[dim]
        try:
            if dim == "memory_relevance":
                # Retrieved engram IDs aren't surfaced from run_agent_turn
                # today; intersection with seeded_ids approximates retrieval.
                # Until the runner threads engram_ids back, we treat any
                # response that mentions the seed text as a "hit" via
                # downstream dimensions; here we pass empty retrieved.
                scores[dim] = await fn(rule, [], seeded_ids)
            elif dim == "instruction_adherence":
                scores[dim] = await fn(rule, last_user_msg, response_text)
            elif dim == "tool_accuracy":
                scores[dim] = fn(rule, response_metadata)
            elif mode == "async":
                scores[dim] = await fn(rule, response_text)
            else:
                scores[dim] = fn(rule, response_text)
        except Exception as e:
            log.warning("scorer %s failed for %s: %s", dim, case.name, e)
            scores[dim] = 0.0

    return seeded_ids, scores


async def _mark_failed(pool, run_id: str, error: str) -> None:
    """Mark a benchmark run as failed with an error message."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE quality_benchmark_runs
            SET status = 'failed', completed_at = NOW(), error_summary = $2
            WHERE id = $1::uuid
            """,
            run_id, error,
        )


@quality_router.get("/api/v1/quality/benchmarks/runs")
async def list_benchmark_runs(
    _admin: AdminDep,
    limit: int = Query(10, ge=1, le=50),
):
    """List recent benchmark runs (v2 path)."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, started_at, completed_at, status,
                   composite_score, dimension_scores, case_results,
                   metadata, config_snapshot_id::text, error_summary
            FROM quality_benchmark_runs
            ORDER BY started_at DESC
            LIMIT $1
            """,
            limit,
        )
    return [
        {
            "id": r["id"],
            "started_at": r["started_at"].isoformat() if r["started_at"] else None,
            "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
            "status": r["status"],
            # `is not None` check — a legitimate 0.0 score (broken-LLM failure mode)
            # must surface in the UI as 0, not be coerced to null/missing.
            "composite_score": float(r["composite_score"]) if r["composite_score"] is not None else None,
            "dimension_scores": r["dimension_scores"] or {},
            "case_results": r["case_results"] or [],
            "metadata": r["metadata"] or {},
            "config_snapshot_id": r["config_snapshot_id"],
            "error_summary": r["error_summary"],
        }
        for r in rows
    ]


@quality_router.post("/api/v1/benchmarks/quality-results")
async def post_quality_benchmark_results(
    _admin: AdminDep,
    results: dict,
):
    """Receive benchmark results from external runner (make benchmark-quality)."""
    pool = get_pool()
    async with pool.acquire() as conn:
        run_id = await conn.fetchval(
            """
            INSERT INTO quality_benchmark_runs
                (status, completed_at, composite_score, category_scores, case_results, metadata)
            VALUES ('completed', NOW(), $1, $2, $3, $4)
            RETURNING id::text
            """,
            results.get("composite_score", 0),
            results.get("category_scores", {}),
            results.get("cases", []),
            {"run_id": results.get("run_id"), "started_at": results.get("started_at")},
        )
    return {"id": run_id, "status": "completed"}


@quality_router.get("/api/v1/benchmarks/quality-results")
async def get_quality_benchmark_results(
    _admin: AdminDep,
    limit: int = Query(10, ge=1, le=50),
):
    """Return recent quality benchmark runs."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, started_at, completed_at, status,
                   composite_score, category_scores, case_results, metadata
            FROM quality_benchmark_runs
            ORDER BY started_at DESC
            LIMIT $1
            """,
            limit,
        )

    return [
        {
            "id": row["id"],
            "started_at": row["started_at"].isoformat() if row["started_at"] else None,
            "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
            "status": row["status"],
            # `is not None` check — see list_benchmark_runs comment.
            "composite_score": float(row["composite_score"]) if row["composite_score"] is not None else None,
            "category_scores": row["category_scores"] or {},
            "case_results": row["case_results"] or [],
            "metadata": row["metadata"] or {},
        }
        for row in rows
    ]


@quality_router.get("/api/v1/quality/snapshots/diff")
async def diff_snapshots(_admin: AdminDep, from_: str = Query(..., alias="from"), to: str = Query(...)):
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id::text, config FROM quality_config_snapshots WHERE id = ANY($1::uuid[])",
            [from_, to],
        )
    by_id = {r["id"]: r["config"] for r in rows}
    if from_ not in by_id or to not in by_id:
        raise HTTPException(404, "one or both snapshots not found")
    if from_ == to:
        return {"changed_keys": [], "from_only": {}, "to_only": {}}
    a, b = by_id[from_], by_id[to]
    changed = []
    for k in set(a.keys()) | set(b.keys()):
        if a.get(k) != b.get(k):
            changed.append({"key": k, "from": a.get(k), "to": b.get(k)})
    return {"changed_keys": changed, "from_id": from_, "to_id": to}


@quality_router.get("/api/v1/quality/snapshots/{snapshot_id}")
async def get_snapshot(_admin: AdminDep, snapshot_id: str):
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id::text, config_hash, config, captured_at, captured_by FROM quality_config_snapshots WHERE id = $1::uuid",
            snapshot_id,
        )
    if not row:
        raise HTTPException(404, "snapshot not found")
    return dict(row) | {"captured_at": row["captured_at"].isoformat()}


@quality_router.delete("/api/v1/benchmarks/quality-results")
async def delete_all_benchmark_results(_admin: AdminDep):
    """Delete all benchmark runs and quality scores."""
    pool = get_pool()
    async with pool.acquire() as conn:
        bench_del = await conn.execute("DELETE FROM quality_benchmark_runs")
        score_del = await conn.execute("DELETE FROM quality_scores")
    return {
        "benchmark_runs_deleted": int(bench_del.split()[-1]) if bench_del else 0,
        "quality_scores_deleted": int(score_del.split()[-1]) if score_del else 0,
    }


@quality_router.get("/api/v1/quality/loops")
async def list_loops(_admin: AdminDep):
    """List registered loops + their current agency + last session summary."""
    from app.quality_loop.registry import get_registry
    registry = get_registry()
    pool = get_pool()
    loops = []
    async with pool.acquire() as conn:
        for rl in registry.list():
            last = await conn.fetchrow(
                """
                SELECT id::text, started_at, completed_at, outcome, decision
                FROM quality_loop_sessions
                WHERE loop_name = $1
                ORDER BY started_at DESC LIMIT 1
                """,
                rl.name,
            )
            last_session = None
            if last:
                last_session = {
                    "id": last["id"],
                    "started_at": last["started_at"].isoformat() if last["started_at"] else None,
                    "completed_at": last["completed_at"].isoformat() if last["completed_at"] else None,
                    "outcome": last["outcome"],
                    "decision": last["decision"],
                }
            loops.append({
                "name": rl.name,
                "watches": rl.impl.watches,
                "agency": rl.agency,
                "last_session": last_session,
            })
    return loops


@quality_router.post("/api/v1/quality/loops/{name}/run-now")
async def run_loop_now(_admin: AdminDep, name: str):
    """Manual trigger — runs one iteration of the named loop."""
    from app.quality_loop.registry import get_registry
    from app.quality_loop.runner import iterate_loop
    registry = get_registry()
    try:
        rl = registry.get(name)
    except KeyError:
        raise HTTPException(404, f"loop '{name}' not registered")
    asyncio.create_task(iterate_loop(rl.impl))
    return {"loop": name, "started": True}


@quality_router.get("/api/v1/quality/loops/{name}/sessions")
async def list_loop_sessions(_admin: AdminDep, name: str, limit: int = Query(20, ge=1, le=100)):
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id::text, started_at, completed_at, outcome, decision,
                   proposed_changes, applied, notes, decided_by
            FROM quality_loop_sessions
            WHERE loop_name = $1
            ORDER BY started_at DESC LIMIT $2
            """,
            name, limit,
        )
    return [
        {
            "id": r["id"],
            "started_at": r["started_at"].isoformat() if r["started_at"] else None,
            "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
            "outcome": r["outcome"],
            "decision": r["decision"],
            "proposed_changes": r["proposed_changes"] or {},
            "applied": r["applied"],
            "notes": r["notes"] or {},
            "decided_by": r["decided_by"],
        }
        for r in rows
    ]


@quality_router.get("/api/v1/quality/loops/sessions/{session_id}")
async def get_loop_session(_admin: AdminDep, session_id: str):
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM quality_loop_sessions WHERE id = $1::uuid",
            session_id,
        )
    if not row:
        raise HTTPException(404, "session not found")
    return {
        "id": str(row["id"]),
        "loop_name": row["loop_name"],
        "started_at": row["started_at"].isoformat() if row["started_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
        "baseline_snapshot_id": str(row["baseline_snapshot_id"]) if row["baseline_snapshot_id"] else None,
        "baseline_run_id": str(row["baseline_run_id"]) if row["baseline_run_id"] else None,
        "proposed_changes": row["proposed_changes"] or {},
        "applied": row["applied"],
        "verification_run_id": str(row["verification_run_id"]) if row["verification_run_id"] else None,
        "outcome": row["outcome"],
        "decision": row["decision"],
        "decided_by": row["decided_by"],
        "decided_at": row["decided_at"].isoformat() if row["decided_at"] else None,
        "notes": row["notes"] or {},
    }


@quality_router.post("/api/v1/quality/loops/sessions/{session_id}/approve")
async def approve_loop_session(_admin: AdminDep, session_id: str):
    """Resume a propose_for_approval session: apply, verify, decide.

    Approval triggers a fresh loop iteration (proposal not replayed in v2).
    """
    from app.quality_loop.registry import get_registry
    from app.quality_loop.runner import iterate_loop
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT loop_name, decision FROM quality_loop_sessions WHERE id = $1::uuid",
            session_id,
        )
    if not row:
        raise HTTPException(404, "session not found")
    if row["decision"] != "pending_approval":
        raise HTTPException(409, f"session is in state '{row['decision']}', not pending_approval")
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE quality_loop_sessions SET decision = 'approved', decided_by = 'admin', decided_at = NOW() WHERE id = $1::uuid",
            session_id,
        )
    registry = get_registry()
    rl = registry.get(row["loop_name"])
    original_agency = rl.agency
    registry.set_agency(row["loop_name"], "auto_apply")
    try:
        asyncio.create_task(iterate_loop(rl.impl))
    finally:
        registry.set_agency(row["loop_name"], original_agency)
    return {
        "approved": True,
        "session_id": session_id,
        "note": "Approval triggers a fresh loop iteration; the original proposal is not replayed in v2.",
    }


@quality_router.post("/api/v1/quality/loops/sessions/{session_id}/reject")
async def reject_loop_session(_admin: AdminDep, session_id: str):
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT decision FROM quality_loop_sessions WHERE id = $1::uuid",
            session_id,
        )
    if not row:
        raise HTTPException(404, "session not found")
    if row["decision"] != "pending_approval":
        raise HTTPException(409, f"session is in state '{row['decision']}', not pending_approval")
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE quality_loop_sessions SET decision = 'rejected', decided_by = 'admin', decided_at = NOW() WHERE id = $1::uuid",
            session_id,
        )
    return {"rejected": True, "session_id": session_id}


@quality_router.patch("/api/v1/quality/loops/{name}/agency")
async def set_loop_agency(_admin: AdminDep, name: str, body: dict):
    """Change an agency mode at runtime. Persists to platform_config."""
    from app.quality_loop.registry import get_registry
    mode = body.get("agency")
    if mode not in {"auto_apply", "propose_for_approval", "alert_only"}:
        raise HTTPException(400, "agency must be auto_apply | propose_for_approval | alert_only")
    registry = get_registry()
    try:
        registry.set_agency(name, mode)
    except (KeyError, ValueError) as e:
        raise HTTPException(404, str(e))
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO platform_config (key, value, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = NOW()
            """,
            f"quality.loops.{name}.agency",
            mode,
        )
    return {"loop": name, "agency": mode}
