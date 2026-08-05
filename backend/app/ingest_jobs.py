"""Ingestion job queue — the durable half of content ingestion (migration 041).

Producers (follow_source backfill, the poll-followed-sources automation) ENQUEUE
media items here and return immediately; the background ingest_worker drains the
queue. This is what makes following a source asynchronous instead of a blocking
task on the chat turn. Mechanical CRUD, mirroring media_ingests and
source_subscriptions.

Durability contract:
  * rows persist, so a killed process RESUMES from the queue (reset_orphans puts
    any 'running' row a dead worker left behind back to 'queued');
  * claim_next uses FOR UPDATE SKIP LOCKED, so extra workers never grab one row;
  * the media_ingests ledger dedupes, so re-running a job is cheap and idempotent.
"""

import logging
import uuid
from typing import Optional

from app import db

log = logging.getLogger(__name__)

# How many times an interrupted (orphaned) job is resumed before it's parked
# 'failed'. Its own budget, separate from the error-retry attempts/max_attempts:
# a shutdown mid-job is not a job error, so it shouldn't spend the error budget —
# but a job that NEVER survives to completion must still stop eventually (see
# migration 044). Generous, since real restarts are rare; only a pathological
# reload rate or a job too long to ever finish uninterrupted will reach it.
MAX_ORPHANS = 5


def _rowcount(status: str) -> int:
    """Parse asyncpg's 'UPDATE n' / 'DELETE n' command tag into the row count."""
    try:
        return int(status.split()[-1])
    except (ValueError, IndexError):
        return 0


def _uuid_or_none(value) -> Optional[uuid.UUID]:
    if not value:
        return None
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


async def enqueue(*, url: str, media_key: Optional[str] = None,
                  title: Optional[str] = None, source_key: Optional[str] = None,
                  enqueued_by: str,
                  conversation_id: Optional[str] = None) -> Optional[dict]:
    """Add one media item to the queue. Idempotent while a job for the same
    media_key is still pending (partial unique index): returns None on conflict,
    so callers count only genuinely new work. A NULL media_key never conflicts —
    those dedupe at the worker against the media_ingests ledger."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO ingest_jobs
                 (url, media_key, title, source_key, enqueued_by, conversation_id)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (media_key) WHERE status IN ('queued', 'running')
                 DO NOTHING
               RETURNING *""",
            url, media_key, title, source_key, enqueued_by,
            _uuid_or_none(conversation_id))
    return dict(row) if row else None


async def claim_next() -> Optional[dict]:
    """Atomically take the oldest queued job and mark it running (attempts++).
    FOR UPDATE SKIP LOCKED so concurrent workers never claim the same row."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE ingest_jobs
                 SET status = 'running', started_at = now(),
                     attempts = attempts + 1, updated_at = now()
               WHERE id = (
                   SELECT id FROM ingest_jobs
                   WHERE status = 'queued'
                   ORDER BY enqueued_at
                   FOR UPDATE SKIP LOCKED
                   LIMIT 1)
               RETURNING *""")
    return dict(row) if row else None


async def mark_done(job_id, *, result_item_id: Optional[str] = None,
                    title: Optional[str] = None) -> None:
    async with db.acquire() as conn:
        await conn.execute(
            """UPDATE ingest_jobs
                 SET status = 'done', error = NULL, result_item_id = $2,
                     title = COALESCE($3, title),
                     finished_at = now(), updated_at = now()
               WHERE id = $1""",
            job_id, result_item_id, title)


async def mark_skipped(job_id, *, reason: str, title: Optional[str] = None) -> None:
    async with db.acquire() as conn:
        await conn.execute(
            """UPDATE ingest_jobs
                 SET status = 'skipped', error = $2, title = COALESCE($3, title),
                     finished_at = now(), updated_at = now()
               WHERE id = $1""",
            job_id, (reason or "")[:500], title)


async def mark_failed(job_id, *, error: str, requeue: bool) -> str:
    """requeue=True returns the job to 'queued' for another attempt (clearing
    started_at); False parks it at 'failed'. Returns the resulting status."""
    status = "queued" if requeue else "failed"
    async with db.acquire() as conn:
        await conn.execute(
            """UPDATE ingest_jobs
                 SET status = $2, error = $3,
                     started_at  = CASE WHEN $2 = 'queued' THEN NULL ELSE started_at END,
                     finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
                     updated_at = now()
               WHERE id = $1""",
            job_id, status, (error or "")[:500])
    return status


async def reset_orphans() -> dict:
    """Startup recovery for jobs left 'running' when the process died. Each is
    RESUMED (requeued, its `orphans` counter bumped) up to MAX_ORPHANS times —
    the ledger dedupes, so re-running is safe. Past the cap it's PARKED as
    'failed' (still operator-retryable) instead of looping forever: a job that
    never survives to completion — e.g. a long transcription repeatedly cut short
    by restarts — would otherwise retry endlessly with no progress. Park BEFORE
    requeue so the just-incremented count doesn't over-shoot. Returns
    {'requeued', 'parked'}."""
    async with db.acquire() as conn:
        async with conn.transaction():
            parked = await conn.execute(
                """UPDATE ingest_jobs
                     SET status = 'failed',
                         error = 'interrupted ' || orphans::text || '× before '
                                 'completing (a long job repeatedly cut short by '
                                 'restarts) — Retry to resume',
                         finished_at = now(), updated_at = now()
                   WHERE status = 'running' AND orphans >= $1""",
                MAX_ORPHANS)
            requeued = await conn.execute(
                """UPDATE ingest_jobs
                     SET status = 'queued', started_at = NULL,
                         orphans = orphans + 1, updated_at = now()
                   WHERE status = 'running'""")
    return {"requeued": _rowcount(requeued), "parked": _rowcount(parked)}


async def active_count_for_source(source_key: str) -> int:
    """Queued + running jobs still outstanding for a source — zero means its
    current backfill/poll wave has drained."""
    async with db.acquire() as conn:
        return await conn.fetchval(
            "SELECT count(*) FROM ingest_jobs "
            "WHERE source_key = $1 AND status IN ('queued', 'running')",
            source_key) or 0


async def take_unannounced_source_stats(source_key: str) -> dict:
    """Count this source's terminal jobs that haven't been rolled into a
    completion announcement yet, and mark them announced — exactly-once per job,
    so repeated backfill waves each get their own honest summary (never a
    cumulative total)."""
    async with db.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """SELECT count(*) FILTER (WHERE status = 'done')    AS done,
                          count(*) FILTER (WHERE status = 'failed')  AS failed,
                          count(*) FILTER (WHERE status = 'skipped') AS skipped
                   FROM ingest_jobs
                   WHERE source_key = $1 AND announced = false
                     AND status IN ('done', 'failed', 'skipped')""",
                source_key)
            await conn.execute(
                "UPDATE ingest_jobs SET announced = true "
                "WHERE source_key = $1 AND announced = false "
                "AND status IN ('done', 'failed', 'skipped')",
                source_key)
    return {"done": row["done"], "failed": row["failed"], "skipped": row["skipped"]}


DISMISSABLE = ("done", "failed", "skipped")


async def dismiss(job_id) -> Optional[dict]:
    """Clear one terminal row off the Activity page. Returns the row, or None
    if it wasn't dismissable.

    The status guard is the whole control, and it is in the WHERE clause: a
    queued or running job is LIVE WORK, and hiding live work from the operator
    is how a queue silently stops. Only something already finished — done,
    failed or skipped — can be cleared.

    Not a delete. `dismissed_at` is a tombstone the followed-source poll reads
    (see `_enqueue_source_entries`), which is what makes clearing a permanently
    failing video actually stop it coming back. See migration 091.
    """
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE ingest_jobs
                 SET dismissed_at = now(), updated_at = now()
               WHERE id = $1 AND dismissed_at IS NULL
                 AND status = ANY($2)
               RETURNING *""",
            job_id, list(DISMISSABLE))
    return dict(row) if row else None


async def dismiss_finished() -> int:
    """Clear every finished row at once — the 'Clear finished' button. Live
    work (queued/running) is untouched by the same predicate as `dismiss`.
    Returns how many rows were cleared."""
    async with db.acquire() as conn:
        res = await conn.execute(
            """UPDATE ingest_jobs
                 SET dismissed_at = now(), updated_at = now()
               WHERE dismissed_at IS NULL AND status = ANY($1)""",
            list(DISMISSABLE))
    return _rowcount(res)


async def restore(job_id) -> Optional[dict]:
    """Undo a dismissal — the row returns to the panel in whatever state it was
    already in. Deliberately NOT a retry: restoring a dismissed 'done' row must
    not re-run a completed ingest. The operator retries it afterwards if that's
    what they meant."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE ingest_jobs
                 SET dismissed_at = NULL, updated_at = now()
               WHERE id = $1 AND dismissed_at IS NOT NULL
               RETURNING *""",
            job_id)
    return dict(row) if row else None


async def find_open(media_key: str) -> Optional[dict]:
    """Most recent non-done job for this media_key, if any. Lets a producer
    (follow_source backfill, poll) revive a stuck failed/skipped row instead
    of enqueueing a duplicate — the previous gap: both producers only checked
    the media_ingests ledger + the active-queue unique index, so a video whose
    first attempt failed/was interrupted would get a brand-new job row on the
    next poll, orphaning the old one at 'failed' forever even after the video
    was genuinely ingested via its twin."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT * FROM ingest_jobs WHERE media_key = $1 AND status != 'done'
               ORDER BY enqueued_at DESC LIMIT 1""",
            media_key)
    return dict(row) if row else None


async def purge_superseded_siblings(media_key: str) -> int:
    """After a job for `media_key` lands 'done', remove any OTHER failed/skipped
    rows for the same media_key — leftovers from the duplicate-enqueue race
    find_open() now prevents going forward, and from before this fix shipped.
    Their outcome is stale: the video is confirmed ingested by the row that
    just completed. Returns rows removed."""
    async with db.acquire() as conn:
        res = await conn.execute(
            """DELETE FROM ingest_jobs
               WHERE media_key = $1 AND status IN ('failed', 'skipped')""",
            media_key)
    return _rowcount(res)


async def retry(job_id, *, refill_agent_budget: bool = False,
                clear_dismissal: bool = False) -> Optional[dict]:
    """Retry of a failed/skipped job: reset it to queued with a fresh error AND
    interruption budget (attempts=0, orphans=0) so the worker picks it up
    again. Returns the row, or None if it wasn't retryable.

    `refill_agent_budget` is the operator's alone, and it is OPT-IN because
    this function has a second caller. `_enqueue_source_entries` revives
    stuck jobs from the followed-source poll — an unattended, scheduled path a
    model can also trigger with `poll_sources` — so a version of this that
    always zeroed `agent_retries` would let the poll refill the model's retry
    budget on a timer. The WHERE-clause control in `retry_by_agent` would then
    be a control the system defeated by itself, on a schedule.

    `clear_dismissal` is opt-in for exactly the same reason and the same
    caller. A retry the OPERATOR asked for plainly overrules his own earlier
    dismissal — he is looking at the row. A revival by the poll must not, or
    the tombstone would be swept away by the very loop it exists to stop, and
    the two members-only videos would be back within the hour. The poll also
    skips dismissed rows before it ever reaches here; this flag is the second
    of the two guards, so neither alone is load-bearing."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE ingest_jobs
                 SET status = 'queued', error = NULL, attempts = 0, orphans = 0,
                     agent_retries = CASE WHEN $2 THEN 0 ELSE agent_retries END,
                     dismissed_at = CASE WHEN $3 THEN NULL ELSE dismissed_at END,
                     started_at = NULL, finished_at = NULL, updated_at = now()
               WHERE id = $1 AND status IN ('failed', 'skipped')
                 AND (dismissed_at IS NULL OR $3)
               RETURNING *""",
            job_id, refill_agent_budget, clear_dismissal)
    return dict(row) if row else None


# How many times a MODEL may re-queue one job. Separate from `max_attempts`
# (the worker's own transient-error budget) because they defend against
# different things: max_attempts against a flaky network, this against a model
# that reads "it failed" and retries in a loop.
AGENT_RETRY_BUDGET = 1


async def retry_by_agent(job_id, *, agent_name: str = "") -> dict:
    """Agent retry, refused in SQL rather than in a prompt.

    The whole control is the WHERE clause: the row must still be failed or
    skipped, and its agent budget must be unspent. Postgres returns zero rows
    otherwise and there is nothing here for a model to talk around — it cannot
    zero `agent_retries`, because the only UPDATE that does is `retry` above,
    reachable solely from the operator's authenticated endpoint.

    Returns {"status": "queued"|"not_retryable"|"budget_spent"|"dismissed"|
    "not_found"} plus the row when it worked. The refusals are distinguished
    with one extra SELECT so she can tell the operator WHICH wall she hit — "I
    already retried this once, use the Retry button on Activity" is actionable,
    and a bare no is what sends a model round the loop again.

    `dismissed_at IS NULL` joins the WHERE clause because a dismissal is an
    operator DECISION about a row, not a state to be worked around. He cleared
    those two members-only videos off the page precisely so nothing would keep
    trying them; a model that could re-queue one would undo that on his behalf,
    silently, and put the row back on his screen.
    """
    async with db.acquire() as conn:
        # The CTE carries the OLD error out with the row. The UPDATE clears
        # `error` (the job is queued again and has not failed yet), so
        # RETURNING alone hands the caller a NULL — and the reason it failed
        # is exactly what the audit event and the reply need to say.
        row = await conn.fetchrow(
            """WITH prev AS (
                   SELECT id, error AS prev_error FROM ingest_jobs WHERE id = $1
               )
               UPDATE ingest_jobs j
                  SET status = 'queued', error = NULL, attempts = 0, orphans = 0,
                      agent_retries = j.agent_retries + 1,
                      started_at = NULL, finished_at = NULL, updated_at = now()
                 FROM prev
                WHERE j.id = prev.id
                  AND j.status IN ('failed', 'skipped')
                  AND j.agent_retries < $2
                  AND j.dismissed_at IS NULL
               RETURNING j.*, prev.prev_error""",
            job_id, AGENT_RETRY_BUDGET)
        if row:
            log.info("agent %s re-queued ingest job %s", agent_name or "?", job_id)
            return {"status": "queued", "job": dict(row)}
        cur = await conn.fetchrow(
            "SELECT status, agent_retries, dismissed_at, url, title "
            "FROM ingest_jobs WHERE id = $1", job_id)
    if not cur:
        return {"status": "not_found"}
    # DISMISSAL FIRST among the refusals. It is the operator's own decision and
    # it outranks both of the budget answers: telling him "you already retried
    # this once" about a row he deliberately cleared explains the wrong wall.
    if cur["dismissed_at"] is not None:
        return {"status": "dismissed", "job": dict(cur)}
    # STATUS FIRST, and the order is load-bearing. A row that is no longer
    # failed/skipped was not refused for budget, whatever the counter says —
    # it may have been re-queued by this very tool and already SUCCEEDED, and
    # answering "budget_spent" makes the tool say "it failed again" about a
    # finished download. That is the same species of confidently-wrong this
    # whole lane exists to remove, just pointing the other way.
    if cur["status"] not in ("failed", "skipped"):
        return {"status": "not_retryable", "job": dict(cur)}
    if cur["agent_retries"] >= AGENT_RETRY_BUDGET:
        return {"status": "budget_spent", "job": dict(cur)}
    return {"status": "not_retryable", "job": dict(cur)}


async def summary(recent: int = 60) -> dict:
    """Counts by status + the most-recently-touched jobs — the ingestion panel's
    one call.

    Dismissed rows are excluded from BOTH halves, which is the point of the
    feature: the rail badge is driven by these counts, so a cleared failure
    that still reddened the badge would have been cleared from nowhere. The
    `dismissed` total rides along so the panel can offer to show them again —
    hidden is not deleted, and the operator should be able to see that."""
    async with db.acquire() as conn:
        counts = await conn.fetch(
            "SELECT status, count(*) AS n FROM ingest_jobs "
            "WHERE dismissed_at IS NULL GROUP BY status")
        rows = await conn.fetch(
            """SELECT id, url, title, source_key, status, attempts, max_attempts,
                      orphans, error, result_item_id, enqueued_by, enqueued_at,
                      started_at, finished_at, dismissed_at
               FROM ingest_jobs
               WHERE dismissed_at IS NULL
               ORDER BY COALESCE(finished_at, started_at, enqueued_at) DESC
               LIMIT $1""",
            recent)
        dismissed = await conn.fetchval(
            "SELECT count(*) FROM ingest_jobs WHERE dismissed_at IS NOT NULL")
    return {"counts": {r["status"]: r["n"] for r in counts},
            "jobs": [dict(r) for r in rows],
            "dismissed": int(dismissed or 0)}


async def purge_old(days: int = 7) -> int:
    """Trim finished rows older than `days` — diagnostics, nothing depends on
    them. Failed rows are kept until retried or manually cleared.

    A DISMISSED 'skipped' row is the one exception, and it is not a tidiness
    call: that row IS the tombstone. `find_open` revives anything that is not
    'done', and a live/upcoming-stream skip leaves no media_ingests ledger
    entry to fall back on — so deleting it hands the next poll a clean slate,
    `_enqueue_source_entries` takes the enqueue branch, and the item the
    operator cleared is downloaded and back on his page. The sweep would have
    quietly undone the decision a week later, which is exactly the resurrection
    this feature exists to stop, just on a timer.

    'done' needs no such guard: the media_ingests ledger is checked first and
    is never purged, so a dismissed done row was never what was protecting that
    media_key. Keeping the asymmetry is what stops every cleared row living
    forever — done rows are the bulk of the trail."""
    async with db.acquire() as conn:
        res = await conn.execute(
            "DELETE FROM ingest_jobs "
            "WHERE finished_at < now() - ($1 || ' days')::interval "
            "  AND (status = 'done' "
            "       OR (status = 'skipped' AND dismissed_at IS NULL))",
            str(days))
    try:
        return int(res.split()[-1])
    except (ValueError, IndexError):
        return 0
