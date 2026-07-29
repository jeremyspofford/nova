"""What is accumulating, against what is actually being used.

Jeremy, 2026-07-27: "back when I asked it to follow these videos, Nova should
be thinking about ways that it can use them... maybe Nova should have
recommended creating a summariser feature for long documents."

Correct, and the reason she did not is mechanical rather than a failure of
character. Every live automation DOES work — fetch, refresh, digest. None
reviews. And more decisively: nothing recorded WHICH documents came back from
retrieval, only how many characters did, so "82 transcripts ingested since
July, none ever used in an answer" was not a fact anybody could compute. She
cannot notice a pattern nobody measures.

So this module is the measurement, and it is deliberately ARITHMETIC, not
judgement. The model is handed counts it did not derive and cannot fudge; its
job is to decide whether a number is worth raising, which is the part a model
is actually good at. Handing it the raw span rows and asking it to count would
reproduce the failure mode this whole codebase is built against.

The window is bounded by trace retention (`trace.retention_days`, default 14),
because that is how long the evidence lives. A document that existed before
the window shows as never-retrieved simply for being old, so recency is
reported alongside — but only as file MTIME, which a bulk retag resets for
every file at once. Stated rather than papered over: the number to act on is
retrieved-against-documents, which needs no date at all.
"""

from __future__ import annotations

import logging

from app import db

log = logging.getLogger(__name__)

# A cap on what any one report may name. The output is read into a prompt.
_MAX_NAMED = 25


async def retrieved_ids(days: int) -> dict[str, int]:
    """doc_id -> how many turns retrieved it, over the last `days`.

    Reads `memory_ids` off the memory_retrieval spans the runner writes. A
    span from before that field shipped simply contributes nothing, which is
    the right degradation: it under-counts usage, so the report errs toward
    "this looks unused" — the direction that prompts a look rather than a
    false all-clear.
    """
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT doc_id, count(*)::int AS hits
              FROM turn_spans s,
                   LATERAL jsonb_array_elements_text(s.detail->'memory_ids') AS doc_id
             WHERE s.name = 'memory_retrieval'
               AND s.started_at > now() - ($1 || ' days')::interval
               AND jsonb_typeof(s.detail->'memory_ids') = 'array'
             GROUP BY doc_id
            """, str(int(days)))
    return {r["doc_id"]: r["hits"] for r in rows}


async def report(days: int = 14, memory=None) -> dict:
    """The accumulation-vs-use picture, computed here so nothing is guessed."""
    if memory is None:
        from app.memory.memory import memory as _m
        memory = _m

    used = await retrieved_ids(days)
    docs = dict(memory.index.docs)
    cutoff = _cutoff(days)

    groups: dict[str, dict] = {}
    never: list[str] = []
    for doc_id, meta in docs.items():
        # Group by the SOURCE tag when there is one — that is the unit Jeremy
        # actually decides about ("is this channel earning its slot"), not the
        # individual video.
        group = _group_of(meta)
        g = groups.setdefault(group, {"documents": 0, "retrieved": 0,
                                      "retrievals": 0, "changed_in_window": 0})
        g["documents"] += 1
        hits = used.get(doc_id, 0)
        if hits:
            g["retrieved"] += 1
            g["retrievals"] += hits
        elif (meta.get("mtime") or 0) < cutoff:
            # only fair to call it unused if it existed for the whole window
            never.append(doc_id)
        if (meta.get("mtime") or 0) >= cutoff:
            g["changed_in_window"] += 1

    ranked = sorted(groups.items(),
                    key=lambda kv: (kv[1]["retrieved"] / max(kv[1]["documents"], 1),
                                    -kv[1]["documents"]))
    return {
        "window_days": days,
        "documents_total": len(docs),
        "documents_retrieved": sum(1 for d in docs if used.get(d)),
        "retrievals_total": sum(used.values()),
        "never_retrieved_count": len(never),
        "never_retrieved_sample": sorted(never)[:_MAX_NAMED],
        "by_group": [{"group": name, **stats} for name, stats in ranked[:_MAX_NAMED]],
        "note": ("Counts come from memory_retrieval trace spans, which are "
                 "pruned on trace.retention_days — a document retrieved only "
                 "before the window counts as unused here. `changed_in_window` "
                 "is FILE MTIME, not ingest date: a bulk retag rewrites every "
                 "file and resets it, so treat it as 'recently touched', not "
                 "'recently arrived'. The number to act on is retrieved vs "
                 "documents."),
    }


def _cutoff(days: int) -> float:
    import time
    return time.time() - days * 86400


def _group_of(meta: dict) -> str:
    """The source a document belongs to, from its own tags."""
    for tag in (meta.get("tags") or []):
        if str(tag).startswith("src-"):
            return str(tag)
    return str(meta.get("type") or "other")
