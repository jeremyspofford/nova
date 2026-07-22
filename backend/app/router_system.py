"""System + observability API (docs/plans/observability-board.md, phase 1).

Live machine readings for the Observability board, plus turn/cost rollups
computed over the existing turn ledger (#3) — the spans already carry token
counts, so this is pure aggregation, nothing new is captured.

Instance-aware from the start: readings are attributed to this instance, and
the fleet endpoint returns a one-row fleet today. Phase 2 populates the fleet
from a shared samples table; the shapes here don't change.
"""

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


@router.get("/api/v1/system/fleet")
async def system_fleet():
    """Every Nova instance sharing this DB. Today: just this one (identity +
    leadership). Phase 2 fills it from `resource_samples` heartbeats."""
    return {"instances": [{
        "id": await instances.ensure_id(),
        "label": instances.label(),
        "leader": instances.is_leader(),
        "self": True,
        "last_seen": time.time(),
    }]}


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
async def observability_summary(window: str = "24h"):
    """24h-style rollups: turn count, error rate, latency percentiles, token
    totals + estimated cost by model, source breakdown. Aggregates
    turn_traces/turn_spans — the ledger IS the cost substrate."""
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
               WHERE started_at > now() - $1::interval""", interval)
        src_rows = await conn.fetch(
            """SELECT source, count(*) AS n FROM turn_traces
               WHERE started_at > now() - $1::interval
               GROUP BY source""", interval)
        model_rows = await conn.fetch(
            """SELECT s.name AS model,
                      count(DISTINCT s.trace_id) AS turns,
                      count(*) AS calls,
                      sum(coalesce((s.detail->>'prompt_tokens')::numeric, 0))     AS prompt,
                      sum(coalesce((s.detail->>'completion_tokens')::numeric, 0)) AS completion
               FROM turn_spans s JOIN turn_traces t ON t.id = s.trace_id
               WHERE s.kind = 'llm_call'
                 AND t.started_at > now() - $1::interval
               GROUP BY s.name""", interval)

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
