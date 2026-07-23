"""System + observability API (docs/plans/observability-board.md, phases 1–2).

Live machine readings for the Observability board, turn/cost rollups over the
existing turn ledger (#3), and — phase 2 — bucketed resource history plus a
fleet view read back out of the shared `resource_samples`/`instances` tables
every instance writes into.
"""

import json
import logging
import time
from datetime import timedelta

from fastapi import APIRouter, HTTPException

from app import db, instances, sysmon
from app.config import settings

log = logging.getLogger(__name__)
router = APIRouter()


# ── live resources + health ───────────────────────────────────────────────

@router.get("/api/v1/system/resources")
async def system_resources():
    """This instance's live gauges: CPU/RAM/load/disk + GPU/containers from
    its sidecar. Polled every few seconds by the board."""
    return await sysmon.snapshot()


@router.get("/api/v1/system/health")
async def system_health():
    """Up/down + latency for every dependency (DB + HTTP services)."""
    return await sysmon.health()


# an instance sampling every ~60s that hasn't written for 3 minutes is
# presumed unreachable — the P3 alert threshold will reuse this
_STALE_AFTER_S = 180


@router.get("/api/v1/system/fleet")
async def system_fleet():
    """Every Nova instance sharing this DB: registry row + its latest sample.
    Single box today = one row; a second backend on the same PG shows up here
    with no extra plumbing."""
    self_id = await instances.ensure_id()
    rows = []
    try:
        async with db.acquire() as conn:
            rows = await conn.fetch(
                """SELECT i.id, i.label, i.last_seen, i.reaches,
                          extract(epoch FROM (now() - i.last_seen)) AS age_s,
                          s.cpu_pct, s.mem_used_gb, s.mem_total_gb,
                          s.vram_used_gb, s.vram_total_gb, s.disk_used_gb,
                          s.disk_total_gb
                   FROM instances i
                   LEFT JOIN LATERAL (
                       SELECT * FROM resource_samples r
                       WHERE r.instance_id = i.id
                       ORDER BY r.ts DESC LIMIT 1) s ON true
                   ORDER BY i.first_seen""")
    except Exception:
        log.exception("fleet query failed; falling back to self row")
    def _r(v, nd=1):
        # REAL columns come back with float32 noise (31.200000762939453)
        return round(v, nd) if v is not None else None

    out = []
    for r in rows:
        age = float(r["age_s"]) if r["age_s"] is not None else None
        out.append({
            "id": r["id"], "label": r["label"],
            "self": r["id"] == self_id,
            # leadership is only knowable about ourselves until the advisory
            # lock lands; the single-leader assumption makes others False
            "leader": instances.is_leader() if r["id"] == self_id else False,
            "last_seen": r["last_seen"].timestamp() if r["last_seen"] else None,
            "stale": age is None or age > _STALE_AFTER_S,
            "reaches": json.loads(r["reaches"]) if r["reaches"] else {},
            "cpu_pct": _r(r["cpu_pct"]), "mem_used_gb": _r(r["mem_used_gb"]),
            "mem_total_gb": _r(r["mem_total_gb"]), "vram_used_gb": _r(r["vram_used_gb"]),
            "vram_total_gb": _r(r["vram_total_gb"]), "disk_used_gb": _r(r["disk_used_gb"]),
            "disk_total_gb": _r(r["disk_total_gb"]),
        })
    if not any(i["self"] for i in out):
        # first minute of a fresh install: the sampler hasn't run yet
        out.append({"id": self_id, "label": instances.label(),
                    "self": True, "leader": instances.is_leader(),
                    "last_seen": time.time(), "stale": False, "reaches": {}})
    return {"instances": out}


# ── resource history (phase 2) ────────────────────────────────────────────

# window → (span, bucket) — sized so a chart gets ~60–100 points
_HISTORY = {
    "1h": (timedelta(hours=1), timedelta(minutes=1)),
    "24h": (timedelta(hours=24), timedelta(minutes=15)),
    "7d": (timedelta(days=7), timedelta(hours=2)),
}


@router.get("/api/v1/system/resources/history")
async def resources_history(window: str = "24h", instance: str | None = None):
    """Bucketed series from `resource_samples` for the sparklines. Averages
    per date_bin bucket; gauges' totals ride along for scale."""
    if window not in _HISTORY:
        raise HTTPException(status_code=422,
                            detail=f"window must be one of {list(_HISTORY)}")
    span, bucket = _HISTORY[window]
    inst = instance or await instances.ensure_id()
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT date_bin($3, ts, to_timestamp(0)) AS bucket,
                      round(avg(cpu_pct)::numeric, 1)      AS cpu_pct,
                      round(avg(mem_used_gb)::numeric, 2)  AS mem_used_gb,
                      max(mem_total_gb)                    AS mem_total_gb,
                      round(avg(vram_used_gb)::numeric, 2) AS vram_used_gb,
                      max(vram_total_gb)                   AS vram_total_gb,
                      round(avg(gpu_pct)::numeric, 1)      AS gpu_pct,
                      max(gpu_temp_c)                      AS gpu_temp_c,
                      round(avg(disk_used_gb)::numeric, 1) AS disk_used_gb,
                      max(disk_total_gb)                   AS disk_total_gb
               FROM resource_samples
               WHERE instance_id = $1 AND ts > now() - $2::interval
               GROUP BY bucket ORDER BY bucket""",
            inst, span, bucket)
    return {
        "window": window,
        "instance": inst,
        "bucket_secs": int(bucket.total_seconds()),
        "points": [{
            "ts": r["bucket"].timestamp(),
            "cpu_pct": float(r["cpu_pct"]) if r["cpu_pct"] is not None else None,
            "mem_used_gb": float(r["mem_used_gb"]) if r["mem_used_gb"] is not None else None,
            "mem_total_gb": round(r["mem_total_gb"], 1) if r["mem_total_gb"] is not None else None,
            "vram_used_gb": float(r["vram_used_gb"]) if r["vram_used_gb"] is not None else None,
            "vram_total_gb": round(r["vram_total_gb"], 1) if r["vram_total_gb"] is not None else None,
            "gpu_pct": float(r["gpu_pct"]) if r["gpu_pct"] is not None else None,
            "gpu_temp_c": round(r["gpu_temp_c"], 1) if r["gpu_temp_c"] is not None else None,
            "disk_used_gb": float(r["disk_used_gb"]) if r["disk_used_gb"] is not None else None,
            "disk_total_gb": round(r["disk_total_gb"], 1) if r["disk_total_gb"] is not None else None,
        } for r in rows],
    }


# ── turn / cost rollups over the ledger ───────────────────────────────────

# asyncpg binds $1::interval as a timedelta, not a text string
_WINDOWS = {"1h": timedelta(hours=1), "6h": timedelta(hours=6),
            "24h": timedelta(days=1), "7d": timedelta(days=7)}

# USD per 1M tokens (prompt, completion). Best-effort placeholder to be
# replaced by an operator-editable table (plan decision #5); local models are
# free. Everything labelled "est." — approximate by design.
_PRICES: dict[str, tuple[float, float]] = {
    settings.default_model: (0.93, 2.92),   # glm-5.2 on OpenRouter (config note)
}
_CLOUD_PROVIDERS = {"openrouter", "openai", "anthropic", "google", "groq",
                    "together", "deepseek", "mistral", "xai"}


def _price(model: str | None) -> tuple[float, float] | None:
    """(prompt, completion) $/1M, or None when it's a cloud model we have no
    price for. Local models (bundled pool / bare or non-cloud prefix) = free."""
    if not model:
        return None
    if model in _PRICES:
        return _PRICES[model]
    provider = model.split(":", 1)[0] if ":" in model else ""
    if provider in _CLOUD_PROVIDERS:
        return None
    return (0.0, 0.0)   # local


@router.get("/api/v1/observability/summary")
async def observability_summary(window: str = "24h", instance: str | None = None):
    """24h-style rollups: turn count, error rate, latency percentiles, token
    totals + estimated cost by model, source breakdown. Aggregates
    turn_traces/turn_spans — the ledger IS the cost substrate. `instance`
    narrows to the turns one machine served (traces are stamped at flush)."""
    if window not in _WINDOWS:
        raise HTTPException(status_code=422, detail=f"window must be one of {list(_WINDOWS)}")
    interval = _WINDOWS[window]
    async with db.acquire() as conn:
        agg = await conn.fetchrow(
            """SELECT count(*) AS turns,
                      count(*) FILTER (WHERE status = 'error')     AS errors,
                      count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
                      percentile_cont(0.5) WITHIN GROUP (
                          ORDER BY extract(epoch FROM finished_at - started_at)) AS p50,
                      percentile_cont(0.95) WITHIN GROUP (
                          ORDER BY extract(epoch FROM finished_at - started_at)) AS p95
               FROM turn_traces
               WHERE started_at > now() - $1::interval
                 AND ($2::text IS NULL OR instance_id = $2)""", interval, instance)
        src_rows = await conn.fetch(
            """SELECT source, count(*) AS n FROM turn_traces
               WHERE started_at > now() - $1::interval
                 AND ($2::text IS NULL OR instance_id = $2)
               GROUP BY source""", interval, instance)
        model_rows = await conn.fetch(
            """SELECT s.name AS model,
                      count(DISTINCT s.trace_id) AS turns,
                      count(*) AS calls,
                      sum(coalesce((s.detail->>'prompt_tokens')::numeric, 0))     AS prompt,
                      sum(coalesce((s.detail->>'completion_tokens')::numeric, 0)) AS completion
               FROM turn_spans s JOIN turn_traces t ON t.id = s.trace_id
               WHERE s.kind = 'llm_call'
                 AND t.started_at > now() - $1::interval
                 AND ($2::text IS NULL OR t.instance_id = $2)
               GROUP BY s.name""", interval, instance)

    by_model, total_prompt, total_completion, total_cost, partial = [], 0, 0, 0.0, False
    for r in model_rows:
        prompt, completion = int(r["prompt"] or 0), int(r["completion"] or 0)
        total_prompt += prompt
        total_completion += completion
        price = _price(r["model"])
        priced = price is not None
        cost = round(prompt / 1e6 * price[0] + completion / 1e6 * price[1], 4) if priced else None
        if priced:
            total_cost += cost
        elif prompt or completion:
            partial = True
        by_model.append({"model": r["model"], "turns": r["turns"], "calls": r["calls"],
                         "prompt": prompt, "completion": completion,
                         "est_cost": cost, "priced": priced})
    by_model.sort(key=lambda m: m["prompt"] + m["completion"], reverse=True)

    turns = agg["turns"] or 0
    return {
        "window": window,
        "turns": turns,
        "errors": agg["errors"] or 0,
        "cancelled": agg["cancelled"] or 0,
        "error_rate": round((agg["errors"] or 0) / turns, 3) if turns else 0.0,
        "p50_secs": round(float(agg["p50"]), 2) if agg["p50"] is not None else None,
        "p95_secs": round(float(agg["p95"]), 2) if agg["p95"] is not None else None,
        "tokens": {"prompt": total_prompt, "completion": total_completion,
                   "total": total_prompt + total_completion},
        "est_cost": round(total_cost, 4),
        "cost_partial": partial,
        "by_model": by_model,
        "sources": {r["source"]: r["n"] for r in src_rows},
    }
