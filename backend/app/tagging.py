"""Tag-hygiene detector — flags a topic that will float alone in the graph.

The second application of the pattern durability.py established: when four
attempts at instruction fail to move a rate, stop asking and check.

Nova's brain graph draws an edge between two notes when they share a
SPECIFIC subject tag. `_GENERIC_TAGS` is the set that deliberately earns no
edge — format words (video, transcript), broad kinds (zoo, museum), broad
subject areas (history, technology) and broad geographies (new-york). That
set exists because of a real incident: a note tagged `zoo` and `new-york`
asserted a relationship between Bear Mountain State Park and a 2005 YouTube
clip about elephants, and the operator's rule out of it was that unrelated
notes must not link.

The failure this catches is the mirror image: a topic whose tags are ALL
generic earns no edges at all. It is not wrong, it is invisible — it sits
in the graph as an island, and nothing surfaces it by association ever
again. That is worse than a bad tag, because a bad tag is at least
noticeable.

Same contract as durability.detect: a WARNING carried back on the tool
result with the item_id, so the model can retag in the same turn. Never a
block — an operator writing "a note about zoos in general" is entitled to
generic tags, and the model is entitled to say so.

THRESHOLD, and why it is laxer than the eval suite's. The ingestion suite
checks `tags.no_generic`, which fails if ANY tag is generic; this fires
only when ALL of them are. The gap is deliberate: the tech-news-digest
automation writes topics tagged ai-news / tech-news / digest on purpose,
and the news-summarizer suite sets no_generic=false for exactly that
reason. A detector firing on any generic tag would nag that automation
every single day. "All generic" is the case with no defence — the note
earns no edges at all and nothing will ever surface it by association.

HONESTY, 2026-07-24: unlike durability.py, this has NOT yet caught a real
failure. Across 14 graded runs neither glm-5.2 nor qwen3:8b produced an
all-generic tag set (the 8b did fail the suite's stricter check, with a
MIX, which this deliberately allows). It is cheap insurance against a
documented incident for the weaker models the phase-3 gate keeps trying —
not a fix for a measured problem. Delete it without ceremony if it never
fires.
"""

import logging
from typing import Optional

log = logging.getLogger(__name__)


def _generic() -> frozenset:
    from app.memory.memory import OkfMemory
    return OkfMemory._GENERIC_TAGS


def detect(tags: Optional[list]) -> Optional[list]:
    """The generic tags, when a topic has NOTHING but generic tags.

    Returns None when at least one specific tag is present — one real
    subject tag is enough to connect the note, and mixing a broad label
    alongside it is normal and useful for search.
    """
    cleaned = [str(t).strip().lower() for t in (tags or []) if str(t).strip()]
    if not cleaned:
        return None      # the missing-tags case is the write path's business
    generic = _generic()
    if any(t not in generic for t in cleaned):
        return None
    return cleaned


WARNING = (
    "Every tag on this topic is a generic category ({found}), so it earns no "
    "edges in the memory graph — it will sit there unconnected and nothing "
    "will surface it by association. Add at least one tag naming the topic's "
    "SPECIFIC subject (bear-mountain, model-context-protocol, kimi-k3) and "
    "rewrite it with write_memory item_id={item_id!r}. Keep the broad ones "
    "too if they help you search; they just cannot be the only ones."
)
