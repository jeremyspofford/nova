"""System + observability API (docs/plans/observability-board.md, phases 1–2).

Live machine readings for the Observability board, turn/cost rollups over the
existing turn ledger (#3), and — phase 2 — bucketed resource history plus a
fleet view read back out of the shared `resource_samples`/`instances` tables
every instance writes into.
"""

import json
import logging
import time
from datetime import datetime, timedelta, timezone

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


@router.get("/api/v1/system/alerts")
async def system_alerts():
    """Active alerts + a short recently-cleared trail, instance-labeled.
    Raising/clearing is the leader's job on the scheduler tick — this just
    reads the state."""
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT a.id, a.instance_id, i.label, a.kind, a.message,
                      a.value, a.threshold, a.raised_at, a.cleared_at
               FROM monitor_alerts a
               LEFT JOIN instances i ON i.id = a.instance_id
               WHERE a.cleared_at IS NULL
                  OR a.cleared_at > now() - interval '7 days'
               ORDER BY a.cleared_at IS NOT NULL, a.raised_at DESC
               LIMIT 50""")
    out = [{
        "id": str(r["id"]), "instance_id": r["instance_id"],
        "label": r["label"] or r["instance_id"], "kind": r["kind"],
        "message": r["message"], "value": r["value"], "threshold": r["threshold"],
        "raised_at": r["raised_at"].timestamp(),
        "cleared_at": r["cleared_at"].timestamp() if r["cleared_at"] else None,
    } for r in rows]
    return {"active": [a for a in out if a["cleared_at"] is None],
            "recent": [a for a in out if a["cleared_at"] is not None]}


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
async def observability_summary(window: str = "24h", instance: str | None = None,
                                include_evals: bool = False):
    """24h-style rollups: turn count, error rate, latency percentiles, token
    totals + estimated cost by model, source breakdown. Aggregates
    turn_traces/turn_spans — the ledger IS the cost substrate. `instance`
    narrows to the turns one machine served (traces are stamped at flush).

    Eval replays are EXCLUDED unless asked for: on this install they are 2017
    of 2650 traces, so the headline error rate was measuring the harness, not
    her. What was left out is still counted (`eval_turns_excluded`) — traffic
    that silently vanishes from a dashboard is how 6M tokens went unnoticed."""
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
                 AND ($2::text IS NULL OR instance_id = $2)
                 AND ($3::bool OR source <> 'eval')""",
            interval, instance, include_evals)
        src_rows = await conn.fetch(
            """SELECT source, count(*) AS n FROM turn_traces
               WHERE started_at > now() - $1::interval
                 AND ($2::text IS NULL OR instance_id = $2)
                 AND ($3::bool OR source <> 'eval')
               GROUP BY source""", interval, instance, include_evals)
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
                 AND ($3::bool OR t.source <> 'eval')
               GROUP BY s.name""", interval, instance, include_evals)
        eval_excluded = 0
        if not include_evals:
            eval_excluded = await conn.fetchval(
                """SELECT count(*) FROM turn_traces
                   WHERE started_at > now() - $1::interval
                     AND ($2::text IS NULL OR instance_id = $2)
                     AND source = 'eval'""", interval, instance)

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
        "include_evals": include_evals,
        "eval_turns_excluded": int(eval_excluded or 0),
    }


# ── the spend / self-improvement read surface ─────────────────────────────
#
# ROADMAP #47's machinery (spend.py, improve_tick) refuses and backs off
# entirely in the backend, which is right — and until these routes existed it
# also refused invisibly: ten provider refusals sat in the ledger with the
# operator's own instructions in their detail, and nothing could show them.


def _parse_detail(value) -> dict:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


async def _improve_checks(wall: dict | None,
                          may: tuple[bool, str]) -> list[dict]:
    """`improve_tick`'s refusal reasons, re-asked READ-ONLY.

    The tick itself cannot be called here — its step 4 charges the goal — so
    each gate is asked the same question through the same module it reads in
    the tick, in the tick's order, and none of them writes anything. `wall`
    and `may` are passed in because the caller already fetched them for the
    hold state; asking twice could give the payload two different answers.
    """
    from app import goals, heartbeat

    checks: list[dict] = []

    goal = await goals.standing_for(goals.IMPROVE_SELF)
    if goal is not None:
        left = int(goal["max_actions"]) - int(goal["actions_used"])
        note = (f"\"{goal['title']}\" has {left} of {goal['max_actions']} "
                f"action(s) left")
    else:
        # standing_for filters out spent/expired goals, but "approve a new
        # goal" and "the switch is off" are different fixes — so a second
        # read distinguishes them before the answer is written down.
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT title, actions_used, max_actions,
                          (expires_at IS NOT NULL AND expires_at <= now())
                              AS expired
                     FROM goals
                    WHERE status = 'active' AND $1 = ANY(approved_verbs)
                    ORDER BY activated_at LIMIT 1""", "improve_self")
        if row is None:
            note = "no live goal authorises self-improvement"
        elif row["expired"]:
            note = (f"the goal \"{row['title']}\" has expired — approve a "
                    f"new one to continue")
        else:
            note = (f"the goal \"{row['title']}\" is out of actions "
                    f"({row['actions_used']} of {row['max_actions']} used) — "
                    f"approve a new one to continue")
    checks.append({"check": "goal", "ok": goal is not None, "note": note})

    async with db.acquire() as conn:
        busy = await conn.fetchrow(
            "SELECT id, status FROM action_runs WHERE lane = 'goal' "
            "  AND status IN ('queued', 'running', 'blocked') LIMIT 1")
    checks.append({"check": "busy", "ok": busy is None,
                   "note": (f"an improvement pass is already in flight "
                            f"(run {str(busy['id'])[:8]}, {busy['status']})"
                            if busy else "no pass is in flight")})

    checks.append({"check": "wall", "ok": wall is None,
                   "note": wall["note"] if wall else "no active wall"})

    allowed, why = may
    checks.append({"check": "ceiling", "ok": allowed, "note": why})

    dirty = await heartbeat.host_repo_wall()
    checks.append({"check": "host_repo", "ok": dirty is None,
                   "note": dirty or "the host tree would accept a landing"})
    return checks


@router.get("/api/v1/spend")
async def spend_overview(lane: str = "improve", entries_limit: int = 50):
    """Is the improvement loop running, why not, and what did it cost —
    one payload, every part read live and nothing charged or written.

    `improve.would_start` is the honest preview of the next heartbeat tick:
    the same gates `heartbeat.improve_tick` walks, asked read-only and in the
    tick's order, with the first refusing gate's own sentence as `reason`.
    `hold` turns the escalating wall backoff into a time the operator can
    read (`held_until`), and the ledger rows carry their `operator_note` —
    the instruction that was previously reachable only with psql."""
    from app import spend

    try:
        ceilings = await spend.ceilings(lane)
        ceilings_error = None
    except spend.NoCeiling as e:
        # The lane fails closed on this; the READ surface must instead say
        # so, because "the limit could not be read" is exactly the situation
        # this page exists to make visible.
        ceilings, ceilings_error = None, str(e)

    today = await spend.today(lane)
    wall = await spend.active_wall(lane)
    may = await spend.may_start(lane)

    rows = await spend.entries(lane, max(1, min(int(entries_limit), 200)))
    # entries() deliberately keeps `detail` out of the list shape; the
    # operator_note on a refusal row is the reason a pass never ran, so it is
    # joined back onto exactly those rows.
    refusal_ids = [r["id"] for r in rows if r["kind"] == spend.KIND_REFUSED]
    if refusal_ids:
        async with db.acquire() as conn:
            notes = await conn.fetch(
                """SELECT id, detail->>'operator_note' AS note,
                          detail->>'wall' AS wall, detail->>'reason' AS reason
                     FROM spend_ledger WHERE id = ANY($1::uuid[])""",
                refusal_ids)
        by_id = {str(n["id"]): n for n in notes}
        for r in rows:
            n = by_id.get(r["id"])
            if n is not None:
                r["operator_note"] = n["note"]
                r["wall"] = n["wall"] or spend.WALL_PROVIDER
                r["refusal_reason"] = n["reason"]

    async with db.acquire() as conn:
        lr = await conn.fetchrow(
            """SELECT id, run_id, goal_id, created_at, detail
                 FROM spend_ledger WHERE lane = $1 AND kind = $2
                ORDER BY created_at DESC LIMIT 1""",
            lane, spend.KIND_REFUSED)
    last_refusal = None
    if lr is not None:
        d = _parse_detail(lr["detail"])
        last_refusal = {
            "id": str(lr["id"]),
            "run_id": str(lr["run_id"]) if lr["run_id"] else None,
            "goal_id": str(lr["goal_id"]) if lr["goal_id"] else None,
            "at": lr["created_at"].isoformat(),
            "wall": str(d.get("wall") or spend.WALL_PROVIDER),
            "reason": d.get("reason"),
            "status": d.get("status"),
            "operator_note": d.get("operator_note"),
        }

    held_until = None
    if wall is not None:
        remaining = max(0.0, float(wall["cooldown_s"]) - float(wall["age_s"]))
        held_until = (datetime.now(timezone.utc)
                      + timedelta(seconds=remaining)).isoformat()
    hold = {
        "held": wall is not None,
        "wall": wall["wall"] if wall else None,
        "streak": wall["streak"] if wall else 0,
        "since": wall["at"] if wall else None,
        "cooldown_s": wall["cooldown_s"] if wall else None,
        "held_until": held_until,
        "reason": wall["note"] if wall else None,
        "last_refusal": last_refusal,
    }

    checks = await _improve_checks(wall, may)
    would_start = all(c["ok"] for c in checks)
    reason = next((c["note"] for c in checks if not c["ok"]), may[1])

    from app import goals as goals_mod
    async with db.acquire() as conn:
        goal_rows = await conn.fetch(
            """SELECT g.id, g.title, g.status, g.actions_used, g.max_actions,
                      g.activated_at, g.expires_at,
                      count(r.run_id)    AS refunds,
                      max(r.created_at)  AS last_refund_at,
                      (SELECT r2.reason FROM goal_action_refunds r2
                        WHERE r2.goal_id = g.id
                        ORDER BY r2.created_at DESC LIMIT 1)
                          AS last_refund_reason
                 FROM goals g
                 LEFT JOIN goal_action_refunds r ON r.goal_id = g.id
                WHERE $1 = ANY(g.approved_verbs)
                GROUP BY g.id
                ORDER BY g.activated_at DESC NULLS LAST LIMIT 10""",
            goals_mod.IMPROVE_SELF)
    goal_list = [{
        "id": str(g["id"]), "title": g["title"], "status": g["status"],
        "actions_used": g["actions_used"], "max_actions": g["max_actions"],
        "activated_at": g["activated_at"].isoformat()
        if g["activated_at"] else None,
        "expires_at": g["expires_at"].isoformat() if g["expires_at"] else None,
        "refunds": int(g["refunds"] or 0),
        "last_refund_at": g["last_refund_at"].isoformat()
        if g["last_refund_at"] else None,
        "last_refund_reason": g["last_refund_reason"],
    } for g in goal_rows]

    return {
        "lane": lane,
        "ceilings": ceilings,
        "ceilings_error": ceilings_error,
        "today": today,
        "hold": hold,
        "improve": {"would_start": would_start, "reason": reason,
                    "checks": checks},
        "goals": goal_list,
        "entries": rows,
    }


@router.patch("/api/v1/spend/ceilings")
async def spend_set_ceilings(body: dict):
    """The operator moves a ceiling, effective at the next check —
    `spend.ceilings()` is read live on every `may_start`, so lowering it
    stops the very next pass without a restart. This route is that sentence
    made reachable: `set_ceiling` had zero callers until it existed."""
    from app import spend
    lane = str(body.get("lane") or spend.LANE_IMPROVE)
    try:
        limits = {
            "max_passes": (None if body.get("max_passes") is None
                           else int(body["max_passes"])),
            "max_tokens": (None if body.get("max_tokens") is None
                           else int(body["max_tokens"])),
            "max_usd": (None if body.get("max_usd") is None
                        else float(body["max_usd"])),
        }
    except (TypeError, ValueError):
        raise HTTPException(status_code=422,
                            detail="ceilings must be numbers") from None
    try:
        return await spend.set_ceiling(lane, updated_by="operator", **limits)
    except spend.NoCeiling as e:
        raise HTTPException(status_code=503, detail=str(e)) from None
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None


@router.get("/api/v1/spend/tokens")
async def spend_tokens(days: int = 7):
    """Cloud usage the spend ledger never saw: tokens by day × source ×
    model, summed in SQL over llm_call spans (migration 133 indexes them).

    This is the surface for "6.3M prompt tokens went to OpenRouter last
    night" — chat, evals, automations and the heartbeat all write llm_call
    spans, so every lane lands here whether or not any ledger metered it.
    `unmetered_calls` counts spans that carried no token figures at all;
    those calls cost something and their rows sum as zero, so the count is
    reported rather than folded in as cheap."""
    days = max(1, min(int(days), 31))
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT s.started_at::date AS day, t.source, s.name AS model,
                      count(*) AS calls,
                      count(*) FILTER (
                          WHERE NOT (s.detail ? 'prompt_tokens'
                                     OR s.detail ? 'completion_tokens'))
                          AS unmetered_calls,
                      sum(coalesce((s.detail->>'prompt_tokens')::numeric, 0))
                          AS prompt,
                      sum(coalesce((s.detail->>'completion_tokens')::numeric,
                                   0)) AS completion
                 FROM turn_spans s JOIN turn_traces t ON t.id = s.trace_id
                WHERE s.kind = 'llm_call'
                  AND s.started_at >= current_date - ($1::int - 1)
                GROUP BY 1, 2, 3
                ORDER BY 1 DESC, prompt DESC""", days)
    out, totals = [], {"calls": 0, "unmetered_calls": 0,
                       "prompt_tokens": 0, "completion_tokens": 0}
    by_source: dict[str, dict] = {}
    for r in rows:
        prompt, completion = int(r["prompt"] or 0), int(r["completion"] or 0)
        out.append({"day": str(r["day"]), "source": r["source"],
                    "model": r["model"], "calls": int(r["calls"]),
                    "unmetered_calls": int(r["unmetered_calls"] or 0),
                    "prompt_tokens": prompt, "completion_tokens": completion,
                    "tokens": prompt + completion})
        totals["calls"] += int(r["calls"])
        totals["unmetered_calls"] += int(r["unmetered_calls"] or 0)
        totals["prompt_tokens"] += prompt
        totals["completion_tokens"] += completion
        s = by_source.setdefault(
            r["source"], {"calls": 0, "prompt_tokens": 0,
                          "completion_tokens": 0})
        s["calls"] += int(r["calls"])
        s["prompt_tokens"] += prompt
        s["completion_tokens"] += completion
    totals["tokens"] = totals["prompt_tokens"] + totals["completion_tokens"]
    return {"days": days, "rows": out, "totals": totals,
            "by_source": by_source}
