"""One-time, idempotent repair: anchor already-ingested followed-source
transcripts to their source in the brain graph.

Transcripts ingested BEFORE the source-anchor fix carry only non-bridging tags
(media/transcript are generic; the per-video slug is unique and batch mode wrote
no chunks to share it) and no link to their channel — so each one drifts as a
lone rogue in the atlas instead of clustering under its source. This walks the
media_ingests ledger (source_key + full_transcript_item_id), makes sure every
followed source has its `source` node, and stamps the shared source tag + a
`Source: [[channel]]` link onto each orphan transcript.

Runs at startup. Every write is guarded (a source node / transcript that already
carries its tag is skipped), so after the first pass it's a cheap no-op that
never re-touches a file — no brain-graph mtime churn. Transcript re-tags preserve
mtime, so a repaired video does not look freshly learned.
"""

import logging

from app import db, source_subscriptions
from app.memory.memory import memory

log = logging.getLogger(__name__)


async def run() -> None:
    """Best-effort; a failure here must never block startup."""
    try:
        await _run()
    except Exception:
        log.exception("source-anchor backfill failed; continuing")


async def _run() -> None:
    # late import: builtin.py imports heavy tool deps and pulls in memory
    from app.tools.builtin import _ensure_source_node, _source_tag, _video_tag

    subs = {s["source_key"]: s for s in await source_subscriptions.list_all()}
    if not subs:
        return

    created = 0
    for sub in subs.values():
        if await _ensure_source_node(sub):
            created += 1

    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT title, full_transcript_item_id, source_key FROM media_ingests "
            "WHERE source_key IS NOT NULL AND full_transcript_item_id IS NOT NULL")

    retagged = 0
    for r in rows:
        sub = subs.get(r["source_key"])
        chan = (sub.get("title") or "").strip() if sub else ""
        if not chan:
            continue   # source was unfollowed+deleted — nothing to anchor to
        # canonical source-only tags: source first, then the format labels and
        # the per-video slug — everything the fuzzy link pass added is dropped
        tags = [_source_tag(chan), "media", "transcript", _video_tag(r["title"])]
        mtime = memory.store.normalize_source_transcript(
            r["full_transcript_item_id"], tags, chan)
        if mtime is not None:
            memory._index_file(r["full_transcript_item_id"], mtime)
            retagged += 1

    if created or retagged:
        log.info("Source-anchor backfill: %d source node(s), %d transcript(s) linked",
                 created, retagged)
