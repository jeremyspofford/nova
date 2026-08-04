"""Runs approved recommendation actions. Durable, leader-gated, one at a time.

Mirrors `ingest_worker` / `ingest_jobs` deliberately — rows survive a restart,
`FOR UPDATE SKIP LOCKED` means two backends never claim one run, and orphans
left 'running' by a dead process are recovered at boot.

The one thing this adds over that pattern is the JOIN in `claim_next()`:

    WHERE r.status = 'queued'
      AND rec.status = 'approved' AND rec.decided_by = 'operator'

The operator's approval is a STANDING PRECONDITION of every claim, re-checked
against the live row at the moment work starts, rather than a fact trusted
once when the run was enqueued. Dismiss a card while its run is still queued
and the run never starts. The only writer of those two columns is
`recommendations.decide()`, which sits behind the authenticated operator API
and is not reachable by any agent.
"""

import asyncio
import json
import logging
from typing import Optional

from app import db, instances

log = logging.getLogger(__name__)

POLL_S = 3.0
MAX_ORPHANS = 2


async def claim_next() -> Optional[dict]:
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE action_runs
                 SET status = 'running', started_at = now(),
                     attempts = attempts + 1, updated_at = now()
               WHERE id = (
                   SELECT r0.id FROM action_runs r0
                     JOIN recommendations rec ON rec.id = r0.recommendation_id
                    WHERE r0.status = 'queued'
                      AND rec.status = 'approved'
                      AND rec.decided_by = 'operator'
                    ORDER BY r0.created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1)
               RETURNING *""")
    return dict(row) if row else None


async def append_step(run_id, name: str, status: str, detail: str = "") -> None:
    """Append to the run's receipt log. The card reads this live, so a step
    that lands here is a step the operator can see happening."""
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE action_runs SET steps = steps || $2::jsonb, "
            "updated_at = now() WHERE id = $1", run_id,
            json.dumps([{"step": name, "status": status, "detail": detail[:400]}]))


async def _finish(run_id, status: str, *, result: Optional[dict] = None,
                  error: str = "") -> None:
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE action_runs SET status = $2, result = $3, error = $4, "
            "finished_at = now(), updated_at = now() WHERE id = $1",
            run_id, status, json.dumps(result) if result else None,
            (error or "")[:2000] or None)


async def _process(run: dict) -> None:
    from app import actions, notify, recommendations, settings_store

    run_id = run["id"]
    rec_id = run["recommendation_id"]
    raw = run["action"]
    raw = json.loads(raw) if isinstance(raw, str) else raw

    async def step(name, status, detail=""):
        await append_step(run_id, name, status, detail)

    try:
        # parsed AGAIN here, not trusted from enqueue time. The frozen copy in
        # action_runs.action is what the operator approved, and it still has
        # to typecheck before an executor is looked up.
        doc = actions.parse(raw)
        spec = actions._TYPES[doc.type]
        if spec.execute is None:
            raise RuntimeError(f"no executor for {doc.type}")

        async with db.acquire() as conn:
            rec = await conn.fetchrow(
                "SELECT id, action_tools FROM recommendations WHERE id = $1", rec_id)
        tools = rec["action_tools"] if rec else None
        rec_dict = {"id": str(rec_id),
                    "action_tools": json.loads(tools) if isinstance(tools, str) else tools}

        timeout = float(settings_store.get("actions.timeout_s")
                        or actions.DEFAULT_EXECUTE_TIMEOUT_S)
        result = await asyncio.wait_for(
            spec.execute(doc, rec_dict, step=step), timeout)
        await _finish(run_id, "succeeded", result=result)
        log.info("Action run %s succeeded: %s", run_id, doc.type)
        summary = "installed"
    except asyncio.TimeoutError:
        await step("timeout", "error", "the executor did not finish in time")
        await _finish(run_id, "failed", error="timed out")
        log.warning("Action run %s timed out", run_id)
        summary = "timed out"
    except Exception as e:                            # noqa: BLE001
        detail = str(e)
        await step("failed", "error", detail)
        await _finish(run_id, "failed", error=detail)
        log.warning("Action run %s failed: %s", run_id, detail)
        summary = f"failed — {detail}"

    # A failure the operator never learns about is the silent no-op this whole
    # lane exists to remove, so BOTH outcomes reach him and both reach her.
    try:
        async with db.acquire() as conn:
            title = await conn.fetchval(
                "SELECT title FROM recommendations WHERE id = $1", rec_id) or "a recommendation"
        await notify.send(f"{title}: {summary}"[:200],
                          title="Nova acted on your approval"[:90],
                          tags=["gear"], click="/chat?inbox=open")
        await recommendations.record_run_outcome(str(rec_id), summary)
    except Exception:
        log.exception("receipt for action run %s failed", run_id)


async def reset_orphans() -> dict:
    """Recover runs left 'running' when the process died.

    Requeued up to MAX_ORPHANS times, then parked as 'failed' and still
    operator-retryable. Unlike an ingest job these are NOT idempotent — a
    half-run that already created a server would hit the unique-name
    constraint on retry and fail cleanly, which is the safe direction: it
    refuses rather than registering a second copy.
    """
    async with db.acquire() as conn:
        async with conn.transaction():
            parked = await conn.execute(
                """UPDATE action_runs
                     SET status = 'failed',
                         error = 'interrupted ' || orphans::text ||
                                 '× by a restart before finishing — press Run again',
                         finished_at = now(), updated_at = now()
                   WHERE status = 'running' AND orphans >= $1""", MAX_ORPHANS)
            requeued = await conn.execute(
                """UPDATE action_runs
                     SET status = 'queued', started_at = NULL,
                         orphans = orphans + 1, updated_at = now()
                   WHERE status = 'running'""")
    out = {"requeued": _rowcount(requeued), "parked": _rowcount(parked)}
    if out["requeued"] or out["parked"]:
        log.info("action runs recovered at boot: %s", out)
    return out


def _rowcount(tag: str) -> int:
    try:
        return int(str(tag).rsplit(" ", 1)[-1])
    except ValueError:
        return 0


async def loop() -> None:
    """Leader-gated poll. Followers idle so an approval is executed once."""
    from app import settings_store
    while True:
        try:
            if instances.is_leader() and settings_store.get("actions.enabled") is not False:
                run = await claim_next()
                if run is not None:
                    await _process(run)
                    continue                     # drain rather than sleep
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("action worker tick failed")
        await asyncio.sleep(POLL_S)
