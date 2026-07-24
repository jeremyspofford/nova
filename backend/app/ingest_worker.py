"""Ingestion worker — Nova's background ingest lane.

Drains the ingest_jobs queue one item at a time: claim -> extract + write the full
transcript via _ingest_media_core -> mark done/skipped/failed. This is what makes
following a source ASYNCHRONOUS: follow_source and the poll-followed-sources
automation only ENQUEUE (fast, transactional); the heavy download+transcribe work
happens here, off the chat request and off the scheduler tick. A long multi-channel
backfill can therefore never freeze a turn or vanish with a dropped connection.

Restart-safe: orphaned 'running' rows are requeued on startup, and the
media_ingests ledger dedupes so re-running a job is cheap. Single lane on purpose —
extraction (yt-dlp + whisper) is heavy, and we don't want to hammer the media
worker or YouTube; the queue, not parallelism, is what keeps throughput honest.
"""

import asyncio
import logging

from app import ingest_jobs, notify, source_subscriptions
from app.memory.memory import memory

log = logging.getLogger(__name__)

IDLE_SLEEP_S = 5    # nap when the queue is empty
PACE_SLEEP_S = 2    # small gap between jobs — polite to the media worker / YouTube
_PURGE_EVERY = 500  # drain iterations between old-row purges (cheap housekeeping)


async def _process(job: dict) -> None:
    """Run one claimed job to a terminal state. Never raises for an ingest
    failure — it records the outcome on the row; only a programming error
    escapes (the drain loop marks that failed too)."""
    from app import media_ingests
    from app.tools.builtin import _ingest_media_core  # late: avoids an import cycle

    job_id = job["id"]

    # Cheap dedupe before the expensive extract, when the key is already known.
    if job.get("media_key") and await media_ingests.get(job["media_key"]):
        await ingest_jobs.mark_skipped(job_id, reason="already ingested")
        return

    # No trace.turn here on purpose: the ingest_jobs row IS this job's durable,
    # per-item record (status, error, timing, result). The agent-turn ledger is
    # for LLM reasoning turns; a mechanical extract has no spans to show there.
    core = await _ingest_media_core(job["url"], source_key=job.get("source_key"))
    status = core.get("status")
    if status == "ingested":
        await ingest_jobs.mark_done(
            job_id, result_item_id=core.get("full_transcript_item_id"),
            title=core.get("title"))
        if job.get("source_key"):
            await source_subscriptions.increment_ingested(job["source_key"])
        # a duplicate enqueue (see find_open in _enqueue_source_entries) can
        # still leave an older failed/skipped sibling row for this same video
        # from before that fix — reap it now that this job proves it's stale
        media_key = job.get("media_key") or core.get("media_key")
        if media_key:
            await ingest_jobs.purge_superseded_siblings(media_key)
        log.info("ingested: %s", core.get("title") or job["url"])
    elif status == "already_ingested":
        await ingest_jobs.mark_skipped(job_id, reason="already ingested",
                                       title=core.get("title"))
    elif status == "skipped":  # live/upcoming stream — not retryable
        await ingest_jobs.mark_skipped(
            job_id, reason=core.get("reason", "not ingestible"))
    else:  # error — retry a few times (transient network/extractor hiccups)
        msg = core.get("error", "unknown error")
        requeue = job["attempts"] < job["max_attempts"]
        outcome = await ingest_jobs.mark_failed(job_id, error=msg, requeue=requeue)
        log.warning("ingest job %s (attempt %d): %s — %s",
                    "requeued" if outcome == "queued" else "failed",
                    job["attempts"], job["url"], msg)


async def _maybe_finalize_source(source_key: str) -> None:
    """When the last outstanding job for a followed source drains, write ONE
    journal entry summarizing the wave and ping the operator. Per-video journaling
    would flood the log (a backfill is 10-50 items); this gives Nova a single
    durable memory that the batch finished, and the operator a completion nudge —
    the '#26 digest lesson' applied to ingestion. Counts are exactly-once, so
    repeated waves never double-report."""
    if await ingest_jobs.active_count_for_source(source_key) > 0:
        return
    stats = await ingest_jobs.take_unannounced_source_stats(source_key)
    if not (stats["done"] or stats["failed"]):
        return  # a poll that found nothing new — stay quiet
    sub = await source_subscriptions.get(source_key)
    title = (sub.get("title") if sub else None) or source_key
    line = (f"Finished background ingestion for '{title}': {stats['done']} ingested"
            + (f", {stats['failed']} failed" if stats["failed"] else "")
            + (f", {stats['skipped']} skipped" if stats["skipped"] else "") + ".")
    try:
        await memory.write(line, type="journal", source_type="ingestion")
    except Exception:
        log.exception("journal write for finished ingestion batch failed")
    try:
        await notify.send(line, title="Ingestion complete", tags=["books"])
    except Exception:
        log.exception("notify for finished ingestion batch failed")


async def _drain_once() -> bool:
    """Claim and process a single job. Returns True if one was handled (so the
    loop keeps going without an idle nap), False when the queue is empty."""
    job = await ingest_jobs.claim_next()
    if not job:
        return False
    try:
        await _process(job)
    except asyncio.CancelledError:
        # Shutting down mid-job — leave it 'running'; reset_orphans requeues it
        # on the next startup and the ledger dedupes any partial work.
        raise
    except Exception:
        log.exception("ingest worker crashed on job %s; marking failed", job.get("id"))
        try:
            requeue = job["attempts"] < job["max_attempts"]
            await ingest_jobs.mark_failed(job["id"], error="worker exception",
                                          requeue=requeue)
        except Exception:
            log.exception("could not record job failure")
    finally:
        if job.get("source_key"):
            try:
                await _maybe_finalize_source(job["source_key"])
            except Exception:
                log.exception("finalize source failed")
    return True


async def loop():
    """The worker's heartbeat — started in main.py's lifespan alongside the
    scheduler. Tight while there's work, naps when idle; every error is contained
    so a single bad job never stops the lane."""
    log.info("Ingestion worker started")
    try:
        r = await ingest_jobs.reset_orphans()
        if r["requeued"] or r["parked"]:
            log.info("Startup recovery: resumed %d interrupted ingest job(s)"
                     "%s", r["requeued"],
                     f", parked {r['parked']} past the interruption cap"
                     if r["parked"] else "")
    except Exception:
        log.exception("orphan reset failed at startup; continuing")

    since_purge = 0
    while True:
        try:
            worked = await _drain_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("ingest worker loop error; continuing")
            worked = False
        since_purge += 1
        if since_purge >= _PURGE_EVERY:
            since_purge = 0
            try:
                await ingest_jobs.purge_old()
            except Exception:
                log.exception("ingest job purge failed; will retry later")
        await asyncio.sleep(PACE_SLEEP_S if worked else IDLE_SLEEP_S)
