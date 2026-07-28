"""Give every document a tag that can connect it to another document.

    docker compose exec backend python -m app.subject_backfill --dry-run
    docker compose exec backend python -m app.subject_backfill --limit 3
    docker compose exec backend python -m app.subject_backfill

Fixing the graph's chain edges made it honest and showed what was underneath:
six real topical edges across 182 nodes. The summariser now derives grounded
subject tags for anything ingested from here on, but the corpus already on
disk was written without them, and a fix that only applies to future
documents leaves the graph empty for months.

WHY A DOCUMENT ENDS UP UNCONNECTABLE. `_ingest_media_core` writes a followed
video with ["media", "transcript", "src-<channel>", "<title-slug>"]. The
first two are in _GENERIC_TAGS and earn no edge; the third has 65 members, so
it names a category and earns none; the fourth comes from the title, so it is
unique to that one video. Nothing there can ever be shared with a different
subject.

ONE CALL TAGS TWO DOCUMENTS. A transcript and its summary are the same
material, so subjects are derived once — from the summary, which is short and
already distilled — and written to BOTH. That halves the cost and, more
importantly, means the pair carries identical subjects, so whichever one a
search surfaces sits in the same neighbourhood.

Tags are GROUNDED against the full source, not the summary: a subject that
does not appear in the original is dropped. A fabricated tag does not merely
mislabel one document — it invents a relationship between every document that
carries it, which is the exact failure the chain edges were.

Frontmatter is edited in place through the store's own parser and renderer,
so the body, the timestamp and every other field survive byte for byte. Only
`tags` changes.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from typing import Optional

log = logging.getLogger(__name__)

_SKIP_KINDS = frozenset({"journal", "source"})

# Enough of the text to name its subjects. Whole documents are not needed —
# subjects are stated early and repeatedly, and this runs once per pair.
_INPUT_CHARS = 4_000


def _connectable(tags: list[str], counts: dict, generic: frozenset,
                 clique_max: int, intra_pair: frozenset = frozenset()) -> list[str]:
    """Tags that could put this document in a neighbourhood with another.

    A tag is useless for connection when it names a KIND (generic), when so
    many documents carry it that it names a category, or when it is unique to
    one document.

    And one more, which a first pass here got wrong and undercounted the
    problem by six times: a tag whose only members are a document and ITS OWN
    SUMMARY. `_video_tag` is derived from the title, so every transcript
    shares exactly one tag with its own summary and nothing else. Two members
    looks connectable and connects the pair to nobody.
    """
    return [t for t in tags
            if t.lower() not in generic and t not in intra_pair
            and 2 <= counts.get(t, 0) <= clique_max]


async def run(dry_run: bool = False, limit: Optional[int] = None) -> int:
    from app import db, settings_store, summariser
    from app.agents import registry as agent_registry
    from app.llm import providers
    from app.memory.memory import memory, OkfMemory
    from app.summariser import SUMMARY_SUFFIX, summary_title

    await db.init_pool()
    await settings_store.warm()
    await providers.warm()
    await memory.startup()

    agent = await agent_registry.get_agent_by_name("ingestion")
    model = (agent or {}).get("model") or ""

    docs = memory.index.docs
    counts: dict = {}
    members: dict = {}
    for doc_id, meta in docs.items():
        for t in meta.get("tags") or []:
            counts[t] = counts.get(t, 0) + 1
            members.setdefault(t, []).append(doc_id)

    # tags carried only by one document and its own summary — see _connectable
    def _stem(doc_id: str) -> str:
        """The shared identity of a document and its summary.

        Both suffixes come off, repeatedly. Reducing a transcript to "X" but
        its summary to "X — summary" leaves the pair looking like two
        different subjects, which is what made the first count read 23 when
        the real number is far higher.
        """
        t = str(docs[doc_id].get("title", ""))
        for _ in range(3):
            for suf in (SUMMARY_SUFFIX, " — full transcript"):
                if t.endswith(suf):
                    t = t[: -len(suf)]
        return t.strip()
    intra_pair = frozenset(
        t for t, ids in members.items()
        if len({_stem(i) for i in ids}) == 1)

    # Pair each source with its summary so one call serves both.
    by_title = {str(m.get("title", "")): d for d, m in docs.items()}
    pairs: list[tuple[str, Optional[str]]] = []
    seen: set[str] = set()
    for doc_id, meta in sorted(docs.items()):
        title = str(meta.get("title", ""))
        if (meta.get("type") or "topic") in _SKIP_KINDS or doc_id in seen:
            continue
        if title.endswith(SUMMARY_SUFFIX):
            continue                      # reached via its source below
        twin = by_title.get(summary_title(title)) or by_title.get(
            f"{title}{SUMMARY_SUFFIX}")
        both = [doc_id] + ([twin] if twin else [])
        if any(_connectable(docs[d].get("tags") or [], counts,
                            OkfMemory._GENERIC_TAGS, OkfMemory._TAG_CLIQUE_MAX,
                            intra_pair)
               for d in both):
            continue                      # already connectable
        seen.update(both)
        pairs.append((doc_id, twin))

    print(f"{len(docs)} documents indexed; {len(pairs)} have no tag that "
          f"could connect them to another document")
    if limit:
        pairs = pairs[:limit]
        print(f"limited to {len(pairs)}")
    if dry_run:
        for doc_id, twin in pairs:
            print(f"  {docs[doc_id].get('title','')[:58]:60} "
                  f"{'(+summary)' if twin else ''}")
        await db.close_pool()
        return 0
    if not model:
        print("no ingestion agent or model configured — nothing done")
        await db.close_pool()
        return 1
    print(f"deriving subjects on {model}\n")

    store = memory.store
    tagged = skipped = 0
    for n, (doc_id, twin) in enumerate(pairs, 1):
        title = str(docs[doc_id].get("title", ""))[:52]
        print(f"[{n}/{len(pairs)}] {title:54} ... ", end="", flush=True)
        source = (await memory.read_item(doc_id) or {}).get("content") or ""
        # prefer the SUMMARY as input — short, distilled, already checked
        text_doc = twin or doc_id
        text = ((await memory.read_item(text_doc) or {}).get("content") or "")
        if not source.strip():
            print("empty")
            skipped += 1
            continue
        try:
            subjects = await summariser.subject_tags(
                text[:_INPUT_CHARS], source, model)
        except summariser.ProviderExhausted as exc:
            print("STOPPED")
            print(f"\nThe provider has refused and will keep refusing:\n  {exc}"
                  f"\n{tagged} tagged before this; re-run to resume.")
            await db.close_pool()
            return 2
        except Exception as exc:  # noqa: BLE001 — one document must not stop the run
            log.exception("subjects failed for %s", doc_id)
            print(f"FAILED ({type(exc).__name__})")
            skipped += 1
            continue
        if not subjects:
            print("none grounded")
            skipped += 1
            continue
        for target in [doc_id] + ([twin] if twin else []):
            parsed = store.read_file(target)
            if not parsed:
                continue
            fm, body = parsed
            existing = store.extract_tags(fm)
            merged = existing + [s for s in subjects if s not in existing]
            fm["tags"] = merged
            path = store.base_dir / target
            path.write_text(store.render_frontmatter(fm) + "\n\n" + body,
                            encoding="utf-8")
            memory._index_file(target)
        print("+" + ", ".join(subjects))
        tagged += 1

    print(f"\ntagged: {tagged}   skipped: {skipped}")
    await db.close_pool()
    return 0


def main() -> int:
    logging.basicConfig(level=logging.WARNING)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()
    return asyncio.run(run(dry_run=args.dry_run, limit=args.limit))


if __name__ == "__main__":
    sys.exit(main())
