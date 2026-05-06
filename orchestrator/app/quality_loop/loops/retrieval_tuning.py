"""Loop A — Retrieval Tuning.

Watches memory_relevance + memory_usage. Acts on three Redis runtime-config
keys: retrieval.top_k, retrieval.threshold, retrieval.spread_weight.

Strategy: coordinate-descent — pick the watched dimension with the worst
score, propose a single-knob change in the direction that should help.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Literal

import redis.asyncio as aioredis
from app.quality_loop.base import (
    AppliedChange,
    Decision,
    Proposal,
    SenseReading,
    Verification,
    decide_default,
)
from app.quality_loop.snapshot import capture_snapshot

log = logging.getLogger(__name__)

_BOUNDS = {
    "top_k":          (3, 15, 2),       # min, max, step
    "threshold":      (0.3, 0.7, 0.05),
    "spread_weight":  (0.1, 0.9, 0.1),
}

_GOOD_RELEVANCE = 0.75
_GOOD_USAGE = 0.70


def propose_step(current: dict[str, Any], reading: SenseReading) -> Proposal | None:
    """Pick a single-knob change. Returns None when scores are good enough."""
    relevance = reading.dimensions.get("memory_relevance", 1.0)
    usage = reading.dimensions.get("memory_usage", 1.0)

    if relevance >= _GOOD_RELEVANCE and usage >= _GOOD_USAGE:
        return None

    if relevance < _GOOD_RELEVANCE:
        cur_k = int(current.get("top_k", 5))
        new_k = min(cur_k + _BOUNDS["top_k"][2], _BOUNDS["top_k"][1])
        if new_k != cur_k:
            return Proposal(
                description=f"Increase retrieval.top_k {cur_k} -> {new_k}",
                changes={"retrieval.top_k": {"from": cur_k, "to": new_k}},
                rationale=f"memory_relevance={relevance:.2f} below {_GOOD_RELEVANCE}; cast wider retrieval net",
            )
        cur_t = float(current.get("threshold", 0.5))
        new_t = max(cur_t - _BOUNDS["threshold"][2], _BOUNDS["threshold"][0])
        if new_t != cur_t:
            return Proposal(
                description=f"Lower retrieval.threshold {cur_t:.2f} -> {new_t:.2f}",
                changes={"retrieval.threshold": {"from": cur_t, "to": new_t}},
                rationale="top_k at max; lower threshold to admit more candidates",
            )
        return None

    cur_s = float(current.get("spread_weight", 0.4))
    new_s = min(cur_s + _BOUNDS["spread_weight"][2], _BOUNDS["spread_weight"][1])
    if new_s != cur_s:
        return Proposal(
            description=f"Increase retrieval.spread_weight {cur_s:.2f} -> {new_s:.2f}",
            changes={"retrieval.spread_weight": {"from": cur_s, "to": new_s}},
            rationale=f"memory_usage={usage:.2f}; spread more aggressively to surface relevant context",
        )
    return None


def _gateway_redis():
    """Open a connection to db1 (gateway namespace) where nova:config:* keys live."""
    from app.config_sync import _gateway_redis_url
    return aioredis.from_url(_gateway_redis_url(), decode_responses=True)


async def _run_benchmark_synchronously() -> tuple[str, float, dict[str, float]]:
    """Run a benchmark inline and return (run_id, composite, dimension_scores).

    Used by sense() and verify(). Reuses the same code path as the HTTP
    endpoint but awaits completion.
    """
    from app.db import get_pool
    from app.quality_router import _run_benchmark_v2
    pool = get_pool()
    snapshot_id, _ = await capture_snapshot("loop_session")
    async with pool.acquire() as conn:
        run_id = await conn.fetchval(
            """
            INSERT INTO quality_benchmark_runs
                (status, metadata, config_snapshot_id, vocabulary_version)
            VALUES ('running', '{}'::jsonb, $1, 2)
            RETURNING id::text
            """,
            snapshot_id,
        )
    await _run_benchmark_v2(run_id, category=None)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT composite_score, dimension_scores FROM quality_benchmark_runs WHERE id = $1::uuid",
            run_id,
        )
    composite = float(row["composite_score"]) if row["composite_score"] is not None else 0.0
    dims = row["dimension_scores"] or {}
    return run_id, composite, dims


class RetrievalTuningLoop:
    name = "retrieval_tuning"
    watches = ["memory_relevance", "memory_usage"]
    agency: Literal["auto_apply", "propose_for_approval", "alert_only"] = "alert_only"

    async def _read_current(self) -> dict[str, Any]:
        redis = _gateway_redis()
        out: dict[str, Any] = {}
        try:
            for k in ("top_k", "threshold", "spread_weight"):
                raw = await redis.get(f"nova:config:retrieval.{k}")
                if raw is None:
                    continue
                try:
                    out[k] = json.loads(raw)
                except json.JSONDecodeError:
                    out[k] = raw
        finally:
            await redis.aclose()
        return out

    async def sense(self) -> SenseReading:
        run_id, composite, dims = await _run_benchmark_synchronously()
        snapshot_id, _ = await capture_snapshot("loop_session")
        return SenseReading(
            composite=composite,
            dimensions=dims,
            sample_size=7,
            snapshot_id=str(snapshot_id),
        )

    async def snapshot(self) -> str:
        sid, _ = await capture_snapshot("loop_session")
        return str(sid)

    async def propose(self, reading: SenseReading) -> Proposal | None:
        current = await self._read_current()
        return propose_step(current, reading)

    async def apply(self, proposal: Proposal) -> AppliedChange:
        redis = _gateway_redis()
        revert_actions: list[dict[str, Any]] = []
        try:
            for key, change in proposal.changes.items():
                redis_key = f"nova:config:{key}"
                old = change["from"]
                new = change["to"]
                await redis.set(redis_key, json.dumps(new))
                revert_actions.append({"key": redis_key, "value": json.dumps(old)})
        finally:
            await redis.aclose()
        return AppliedChange(
            proposal=proposal,
            applied_at=datetime.now(timezone.utc).isoformat(),
            revert_actions=revert_actions,
        )

    async def verify(self, baseline: SenseReading, applied: AppliedChange) -> Verification:
        run_id, composite, dims = await _run_benchmark_synchronously()
        delta: dict[str, float] = {"composite": composite - baseline.composite}
        for d, v in dims.items():
            delta[d] = v - baseline.dimensions.get(d, 0.0)
        snapshot_id, _ = await capture_snapshot("loop_session")
        after = SenseReading(
            composite=composite, dimensions=dims,
            sample_size=baseline.sample_size, snapshot_id=str(snapshot_id),
        )
        significant = abs(delta["composite"]) >= 1.0
        return Verification(baseline=baseline, after=after, delta=delta, significant=significant)

    async def decide(self, verification: Verification) -> Decision:
        return decide_default(verification, persist_threshold=2.0, revert_threshold=1.0)

    async def revert(self, applied: AppliedChange) -> None:
        redis = _gateway_redis()
        try:
            for action in applied.revert_actions:
                await redis.set(action["key"], action["value"])
        finally:
            await redis.aclose()
