"""Whether a tag may bridge two documents — decided from live corpus state.

Replaces a 77-entry hand-maintained blocklist whose own comment instructed
you to keep growing it ("extend this set as new generic tags surface"). That
is the maintained-list anti-pattern CLAUDE.md names: a control you have to
edit the day a feature lands. Measured on the live corpus, 71 of its 77
entries named tags this deployment has never once seen.

Three tiers:

  STRUCTURAL  the tag labels what KIND or FORMAT a document is, not what it
              is ABOUT. It rides along as a search label but earns no graph
              edge — two notes sharing "transcript" are in the same broad
              category, not related.
  SPECIFIC    the tag names a subject; sharing it means something, so it may
              create edges.
  INERT       only one document carries it, so it can bridge nothing yet.
              NOT a judgement about the tag — a brand-new specific subject
              starts here and graduates the moment a second note uses it.

The derivation has two halves, and the second is the one a frequency rule
alone gets wrong.

**Rarity.** A tag on more than `ceiling` of the corpus is describing a
category rather than a subject. The ceiling scales with the corpus so it
never needs retuning.

**Entity backing.** A tag carried by a node that IS an entity (a `source` —
a followed channel, a feed) names a thing that demonstrably exists in the
corpus, and stays SPECIFIC however common it becomes. This is not a corner
case. `src-cloud-codes---videos` sits on 59 of 155 documents, so every
frequency ceiling calls it structural — yet it is the single most meaningful
tag here, the anchor holding one channel's videos together as one system.
Measured on tag edges alone: a frequency-only rule shatters the corpus from
[59, 30, 28, 24, 4, 3, 2, 2] into 58 pairs plus 36 orphans, while
entity-backing reproduces the blocklist's partition exactly. A frequency-only
rule appears to pass only because wiki-links happen to cover those systems
today — a coincidence of the summariser having run, not a property.

`SEED_FLOOR` survives as a floor, never a ceiling: no frequency rule can
catch a df≤2 generic in a small corpus, and the founding incident was exactly
that — a Bear Mountain hiking attraction bridged to the "Me at the zoo"
YouTube video through the coincidental word "zoo". Entity backing overrides
it, so a source literally named "news" still bridges. `seed_redundant()`
reports which entries the derived rule already subsumes, so the list shrinks
mechanically instead of growing by hand.
"""

from __future__ import annotations

import math
from typing import Iterable, Optional

STRUCTURAL = "structural"
SPECIFIC = "specific"
INERT = "inert"

# Node types that NAME a thing rather than describe one. A tag carried by one
# of these is a proper noun, however common it becomes.
ENTITY_TYPES = frozenset({"source"})

# Fraction of the corpus above which a tag is describing a category. The
# floor of 4 keeps a tiny corpus from calling everything structural.
CEILING_FRACTION = 0.10
CEILING_MIN = 4

# Hysteresis: a tag must exceed the ceiling by this much to be demoted, so a
# tag hovering at the boundary cannot flip a system between merged and split
# on consecutive 20s polls.
DEMOTE_MARGIN = 1.25

# The old _GENERIC_TAGS, kept ONLY as a floor for tags too rare for frequency
# to judge. Never extend it — if something belongs here and is common, the
# ceiling already catches it; if it is rare, add the subject tag that should
# have been there instead.
SEED_FLOOR = frozenset({
    # format / medium (several of these are auto-applied at ingest time)
    "media", "transcript", "transcripts", "video", "audio", "image",
    "photo", "photograph", "article", "document", "note", "notes",
    "summary", "digest", "overview", "guide", "reference", "data",
    "source", "sources", "tool", "tools", "content",
    # broad kinds of place / thing
    "zoo", "museum", "museums", "park", "state-park", "facilities",
    "visitor-info", "recreation", "hiking", "trail", "trails", "nature",
    "animals", "travel", "food", "music", "art", "people", "places",
    # broad subject areas
    "history", "science", "technology", "tech", "news", "sports",
    "sports-news", "tech-news", "ai-news", "culture", "internet-culture",
    "entertainment", "education", "politics", "business", "finance",
    "misc", "general", "info", "information",
    # broad geographies — a shared state/country/region is a LOCATION
    # category, not a shared subject: Bear Mountain State Park and the NY
    # Giants are both "new-york" yet wholly unrelated.
    "new-york", "new-york-city", "nyc", "united-states", "usa", "us",
    "america", "california", "texas", "florida", "europe", "asia",
    "africa", "world", "global",
})


class TagTiers:
    """A snapshot of the corpus's tag vocabulary and what each tag may do."""

    def __init__(self, docs: Iterable[tuple[str, Iterable[str]]],
                 previous: Optional[dict[str, str]] = None):
        """`docs` yields (doc_type, tags) for every memory body."""
        self.df: dict[str, int] = {}
        self.entity: set[str] = set()
        self.doc_count = 0
        for doc_type, tags in docs:
            self.doc_count += 1
            seen = {str(t).strip().lower() for t in (tags or []) if str(t).strip()}
            for t in seen:
                self.df[t] = self.df.get(t, 0) + 1
                if doc_type in ENTITY_TYPES:
                    self.entity.add(t)
        self.ceiling = max(CEILING_MIN, math.ceil(CEILING_FRACTION * self.doc_count))
        self._previous = previous or {}
        self._cache: dict[str, str] = {}

    # ── classification ───────────────────────────────────────────────────

    def tier(self, tag: str) -> str:
        t = str(tag).strip().lower()
        hit = self._cache.get(t)
        if hit is None:
            hit = self._cache[t] = self._classify(t)
        return hit

    def _classify(self, t: str) -> str:
        if t in self.entity:
            return SPECIFIC          # a named thing, at any frequency
        if t in SEED_FLOOR:
            return STRUCTURAL        # the floor frequency cannot see
        df = self.df.get(t, 0)
        if df <= self.ceiling:
            # hysteresis band: keep a previously-demoted tag demoted until it
            # falls back under the ceiling, so it cannot oscillate
            if (df > self.ceiling / DEMOTE_MARGIN
                    and self._previous.get(t) == STRUCTURAL):
                return STRUCTURAL
            return INERT if df < 2 else SPECIFIC
        if df <= self.ceiling * DEMOTE_MARGIN and self._previous.get(t) == SPECIFIC:
            return SPECIFIC
        return STRUCTURAL

    def bridges(self, tag: str) -> bool:
        """May this tag create a graph edge?"""
        return self.tier(tag) == SPECIFIC

    def is_structural(self, tag: str) -> bool:
        """Is this tag a category label rather than a subject?

        Distinct from `not bridges()`: a brand-new specific tag is INERT, not
        structural. Detectors and evals want THIS — they judge the tag, not
        whether the corpus has caught up with it yet.
        """
        return self.tier(tag) == STRUCTURAL

    def snapshot(self) -> dict[str, str]:
        """Tier per known tag — feed back in as `previous` for hysteresis."""
        return {t: self.tier(t) for t in self.df}

    # ── self-reporting, so the seed list shrinks instead of growing ──────

    def seed_redundant(self) -> dict[str, list[str]]:
        """Which SEED_FLOOR entries the derived rule no longer needs.

        `absent` never appear in this corpus at all; `derived` are already
        over the ceiling, so frequency would call them structural unaided.
        Anything left in `load_bearing` is the only part still earning a
        hand-maintained list.
        """
        absent, derived, load_bearing = [], [], []
        for t in sorted(SEED_FLOOR):
            df = self.df.get(t, 0)
            if df == 0:
                absent.append(t)
            elif t in self.entity:
                derived.append(t)      # entity backing would have saved it
            elif df > self.ceiling:
                derived.append(t)
            else:
                load_bearing.append(t)
        return {"absent": absent, "derived": derived,
                "load_bearing": load_bearing}
