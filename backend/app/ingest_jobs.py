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


async def retry(job_id) -> Optional[dict]:
    """Operator retry of a failed/skipped job: reset it to queued with a fresh
    error AND interruption budget (attempts=0, orphans=0) so the worker picks it
    up again. Returns the row, or None if it wasn't retryable."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE ingest_jobs
                 SET status = 'queued', error = NULL, attempts = 0, orphans = 0,
                     started_at = NULL, finished_at = NULL, updated_at = now()
               WHERE id = $1 AND status IN ('failed', 'skipped')
               RETURNING *""",
            job_id)
    return dict(row) if row else None


async def summary(recent: int = 60) -> dict:
    """Counts by status + the most-recently-touched jobs — the ingestion panel's
    one call."""
    async with db.acquire() as conn:
        counts = await conn.fetch(
            "SELECT status, count(*) AS n FROM ingest_jobs GROUP BY status")
        rows = await conn.fetch(
            """SELECT id, url, title, source_key, status, attempts, max_attempts,
                      orphans, error, result_item_id, enqueued_by, enqueued_at,
                      started_at, finished_at
               FROM ingest_jobs
               ORDER BY COALESCE(finished_at, started_at, enqueued_at) DESC
               LIMIT $1""",
            recent)
    return {"counts": {r["status"]: r["n"] for r in counts},
            "jobs": [dict(r) for r in rows]}


async def purge_old(days: int = 7) -> int:
    """Trim finished (done/skipped) rows older than `days` — diagnostics, nothing
    depends on them. Failed rows are kept until retried or manually cleared."""
    async with db.acquire() as conn:
        res = await conn.execute(
            "DELETE FROM ingest_jobs WHERE status IN ('done', 'skipped') "
            "AND finished_at < now() - ($1 || ' days')::interval", str(days))
    try:
        return int(res.split()[-1])
    except (ValueError, IndexError):
        return 0
