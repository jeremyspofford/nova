"""Find transcripts that have no summary, and write the missing ones.

    docker compose exec backend python -m app.transcript_backfill --dry-run
    docker compose exec backend python -m app.transcript_backfill --limit 3
    docker compose exec backend python -m app.transcript_backfill

The gap is DERIVED from the corpus, never tracked in a table. A queue that
records "summarised: yes" is a second copy of the truth, and it is wrong the
moment a summary is deleted by hand or a worker dies between writing the
transcript and writing the summary — which is exactly the window
`summarise_ingest` leaves open on purpose, because the ingest must not wait
on a model call. Reading the answer off the documents means this is correct
after any crash, any manual edit, and any partial run, with nothing to
reconcile.

Pairing is by TITLE, not by slug: `<video> — full transcript` pairs with
`<video> — summary`. Slug rules live inside the store and would couple this
to them for no gain.

Writing to live memory, so: --dry-run reports and changes nothing, --limit
bounds a trial run, and re-running is safe because the summary write uses
replace=True on a deterministic title.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

log = logging.getLogger(__name__)

_TRANSCRIPT_SUFFIX = " — full transcript"
_SUMMARY_SUFFIX = " — summary"


def _pending(docs: dict) -> list[tuple[str, str]]:
    """(transcript_id, base_title) for every transcript lacking a summary."""
    summarised = {
        str(m.get("title", ""))[: -len(_SUMMARY_SUFFIX)]
        for m in docs.values()
        if str(m.get("title", "")).endswith(_SUMMARY_SUFFIX)
    }
    out = []
    for doc_id, meta in sorted(docs.items()):
        title = str(meta.get("title", ""))
        if not title.endswith(_TRANSCRIPT_SUFFIX):
            continue
        base = title[: -len(_TRANSCRIPT_SUFFIX)]
        if base not in summarised:
            out.append((doc_id, base))
    return out


async def run(dry_run: bool = False, limit: int | None = None) -> int:
    from app import db, settings_store
    from app.agents import registry as agent_registry
    from app.memory.memory import memory

    await db.init_pool()
    await settings_store.warm()
    await memory.startup()

    pending = _pending(memory.index.docs)
    total_docs = len(memory.index.docs)
    print(f"{total_docs} documents indexed; {len(pending)} transcripts have "
          f"no summary")
    if limit:
        pending = pending[:limit]
        print(f"limited to {len(pending)}")
    if dry_run:
        for doc_id, base in pending:
            chars = memory.index.docs[doc_id].get("chars", 0)
            print(f"  would summarise  {chars:>8,} chars  {base[:64]}")
        await db.close_pool()
        return 0

    agent = await agent_registry.get_agent_by_name("ingestion")
    if not agent or not agent.get("model"):
        print("no ingestion agent or model configured — nothing done")
        await db.close_pool()
        return 1
    model = agent["model"]
    print(f"summarising on {model}\n")

    from app import transcript_summary
    written = failed = 0
    for n, (doc_id, base) in enumerate(pending, 1):
        meta = memory.index.docs.get(doc_id, {})
        item = await memory.read_item(doc_id)
        url = (item or {}).get("frontmatter", {}).get("source_url", "")
        print(f"[{n}/{len(pending)}] {base[:60]} "
              f"({meta.get('chars', 0):,} chars) ... ", end="", flush=True)
        try:
            got = await transcript_summary.summarise(
                doc_id, title=base, url=url,
                tags=list(meta.get("tags") or []), model=model)
        except Exception as exc:  # noqa: BLE001 — one bad video must not stop the run
            log.exception("summary failed for %s", doc_id)
            print(f"FAILED ({type(exc).__name__})")
            failed += 1
            continue
        if got:
            print("ok")
            written += 1
        else:
            print("skipped (no usable summary)")
            failed += 1

    print(f"\nwritten: {written}   not written: {failed}")
    await db.close_pool()
    return 0


def main() -> int:
    logging.basicConfig(level=logging.WARNING)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="report what is missing and write nothing")
    ap.add_argument("--limit", type=int, default=None,
                    help="summarise at most this many")
    args = ap.parse_args()
    return asyncio.run(run(dry_run=args.dry_run, limit=args.limit))


if __name__ == "__main__":
    sys.exit(main())
