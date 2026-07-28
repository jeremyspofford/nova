"""Find long documents that have no summary, and write the missing ones.

    docker compose exec backend python -m app.summary_backfill --dry-run
    docker compose exec backend python -m app.summary_backfill --limit 3
    docker compose exec backend python -m app.summary_backfill

The gap is DERIVED from the corpus, never tracked in a table. A queue that
records "summarised: yes" is a second copy of the truth, and it is wrong the
moment a summary is deleted by hand or a worker dies between writing a
document and writing its summary — which is exactly the window
`summarise_ingest` leaves open on purpose, because an ingest must not wait on
a model call. Reading the answer off the documents means this is correct
after any crash, any manual edit, and any partial run, with nothing to
reconcile.

WHAT QUALIFIES is measured, not picked. A document earns a summary when a
summary would actually be smaller — see _MIN_SOURCE_CHARS, whose threshold
comes from the compression of the first 63 real pairs. Journals are excluded:
a journal IS the record of a conversation, and a distillation of one is a
worse version of something already written down.

Pairing is by TITLE: `<name>` pairs with `<name> — summary`. Slug rules live
inside the store and coupling to them would buy nothing.

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

# A journal is the record of what was said; summarising it produces a worse
# copy of something already durable.
_SKIP_KINDS = frozenset({"journal"})

# The size below which summarising does not pay, MEASURED rather than picked.
# Compression across the first 63 real summary/source pairs, 2026-07-28:
#
#     source size   n    median summary/source
#       0 –  8k     7          40%
#       8 – 12k    16          29%
#      12 – 20k    25          21%
#      20 – 40k    12          11%
#         40k+      3           7%
#
# Under 8k a "summary" runs 40% of its source and is a reformat, not a
# distillation — it costs a model call and a permanent second document to
# save very little. From 12k the median is a 5x reduction and worth having.
#
# This replaces a context-window fraction, which answered the wrong question.
# "Too long to read whole" was only ever one of the two reasons to summarise,
# and it is now the weaker one: local models get 40,960 tokens since dynamic
# sizing landed, so almost nothing fails to fit. What summaries are actually
# for is survey and retrieval quality, and those are a COMPRESSION argument.
_MIN_SOURCE_CHARS = 12_000


def _pending(docs: dict, min_chars: int,
             force: bool = False) -> list[tuple[str, str]]:
    """(doc_id, title) for every long document lacking a summary.

    `force` re-summarises documents that already have one. Needed after the
    first run wrote 76 summaries on the wrong model; the write itself uses
    replace=True on a deterministic title, so this overwrites in place and
    deletes nothing.
    """
    from app.summariser import SUMMARY_SUFFIX, summary_title
    # Pair on the summary's OWN naming rule rather than on string surgery:
    # summary_title strips "— full transcript" before appending, so slicing
    # the suffix off here would leave a stem that never matches its source
    # and every transcript would read as pending forever.
    summarised = set() if force else {
        str(m.get("title", "")) for m in docs.values()
        if str(m.get("title", "")).endswith(SUMMARY_SUFFIX)
    }
    out = []
    for doc_id, meta in sorted(docs.items()):
        title = str(meta.get("title", ""))
        if not title or title.endswith(SUMMARY_SUFFIX):
            continue
        if (meta.get("type") or "topic") in _SKIP_KINDS:
            continue
        if int(meta.get("chars") or 0) < min_chars:
            continue
        # Accept the LEGACY title too. 63 summaries were written before
        # summary_title stripped "— full transcript", so pairing only on the
        # new form would mark every one of them pending and re-spend a model
        # call each to produce a document that already exists. Their titles
        # correct themselves whenever one is re-summarised with --force.
        if (summary_title(title) not in summarised
                and f"{title}{SUMMARY_SUFFIX}" not in summarised):
            out.append((doc_id, title))
    return out


async def run(dry_run: bool = False, limit: int | None = None,
              min_chars: int | None = None, force: bool = False) -> int:
    from app import db, settings_store
    from app.agents import registry as agent_registry
    from app.memory.memory import memory

    from app.llm import providers

    await db.init_pool()
    await settings_store.warm()
    # Without this the provider cache is empty, is_configured() is False for
    # every cloud slug, and router.effective_model silently swaps the model
    # for the local fallback — so the first run of this script summarised 76
    # documents on ollama:qwen2.5:3b while reporting glm-5.2. A standalone
    # script has to warm everything the server warms at startup.
    await providers.warm()
    await memory.startup()

    agent = await agent_registry.get_agent_by_name("ingestion")
    model = (agent or {}).get("model") or ""

    if min_chars is None:
        min_chars = _MIN_SOURCE_CHARS
    pending = _pending(memory.index.docs, min_chars, force)
    print(f"{len(memory.index.docs)} documents indexed; {len(pending)} are "
          f"longer than {min_chars:,} chars and have no summary")
    # The threshold answers "too long to read whole", which is only one of the
    # two reasons to summarise. The other — undistilled material where search
    # returns filler and no survey is possible — applies at any length, and on
    # this corpus that is a 79-document difference. State it rather than
    # letting a default quietly decide.
    if min_chars > 0:
        everything = _pending(memory.index.docs, 0)
        if len(everything) > len(pending):
            print(f"  ({len(everything)} have no summary at any length — "
                  f"--min-chars 0 to include them)")
    if limit:
        pending = pending[:limit]
        print(f"limited to {len(pending)}")
    if dry_run:
        for doc_id, base in pending:
            chars = memory.index.docs[doc_id].get("chars", 0)
            print(f"  would summarise  {chars:>8,} chars  {base[:64]}")
        await db.close_pool()
        return 0

    if not model:
        print("no ingestion agent or model configured — nothing done")
        await db.close_pool()
        return 1
    print(f"summarising on {model}\n")

    from app import summariser
    written = failed = 0
    for n, (doc_id, base) in enumerate(pending, 1):
        meta = memory.index.docs.get(doc_id, {})
        print(f"[{n}/{len(pending)}] {base[:60]} "
              f"({meta.get('chars', 0):,} chars) ... ", end="", flush=True)
        try:
            got = await summariser.summarise(doc_id, model=model)
        except summariser.ProviderExhausted as exc:
            # STOP, do not continue. Every remaining document would hit the
            # same refusal, and a loop that keeps going turns one actionable
            # error into hundreds of "skipped" lines that bury it.
            print("STOPPED")
            print(f"\nThe provider has refused and will keep refusing:\n  {exc}\n"
                  f"{written} written before this. Nothing else was attempted — "
                  f"re-run once it is resolved and it will resume from here.")
            await db.close_pool()
            return 2
        except Exception as exc:  # noqa: BLE001 — one bad document must not stop the run
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
    ap.add_argument("--force", action="store_true",
                    help="re-summarise documents that already have a summary")
    ap.add_argument("--min-chars", type=int, default=None,
                    help="only documents at least this long. Defaults to "
                         f"{_MIN_SOURCE_CHARS:,}, the size below which a "
                         "summary measurably stops being much smaller than "
                         "its source; 0 includes every undistilled document.")
    args = ap.parse_args()
    return asyncio.run(run(dry_run=args.dry_run, limit=args.limit,
                           min_chars=args.min_chars, force=args.force))


if __name__ == "__main__":
    sys.exit(main())
