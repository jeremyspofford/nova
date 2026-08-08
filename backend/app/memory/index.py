"""In-process BM25 index over memory files. Doc ids are always file paths."""

import logging
import math
import re
import time
from collections import Counter
from typing import Optional

from app.memory import provenance

log = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


# ── ranking weights — every scoring knob lives HERE, nowhere else ─────────
#
# BM25 answers "does this document match these words". The modifiers below
# answer the questions BM25 cannot: is it fresh, is it trusted, is it a
# duplicate. Measured 2026-08-07 before they existed: "what is my
# electricity rate" ranked a fetched utility page ABOVE the operator's own
# profile note carrying the same rate — equal BM25, and nothing else had a
# vote.

#: A query term appearing in the title outweighs the same term in the body.
TITLE_BOOST = 2.0

#: Per point of frontmatter `priority`, multiplicative.
PRIORITY_STEP = 0.1

#: Recency is a BOOST that decays, never a penalty: a fresh document scores
#: up to (1 + RECENCY_WEIGHT)x and an ancient one exactly 1x. A decay that
#: divides old documents down would bury a durable first-party note under
#: whatever transcript arrived this week — recency loses to relevance, it
#: only breaks ties among comparable matches.
RECENCY_HALF_LIFE_DAYS = 30.0
RECENCY_WEIGHT = 0.3

#: Trust bias: at equal BM25 a durable note about the operator outranks a
#: fetched transcript. Keyed on the provenance tiers already riding on every
#: indexed doc — DERIVED at index time, never re-guessed here.
ORIGIN_BIAS = {
    provenance.FIRST_PARTY: 1.3,
    provenance.CONVERSATION: 1.1,
    provenance.THIRD_PARTY: 1.0,
}

#: Near-duplicate collapse: a hit whose term SET is ≥ this contained in a
#: higher-ranked hit's is restating it, and forfeits its slot. Containment
#: (|A∩B| / |smaller|), not Jaccard — a short copy cut from a long document
#: has tiny Jaccard and near-total containment, and the short side being
#: subsumed is exactly the case to catch. The threshold is set from the live
#: corpus, measured 2026-08-07 over 2,500 random topic/source pairs:
#: unrelated docs reach 0.80 at the extreme tail (a news digest vs a channel
#: note it cites), summaries sit inside their own transcript at 0.66–0.97
#: (handled FIRST by the title-based collapse, not by this), and verbatim
#: re-ingests measure 1.0. 0.85 sits above every measured non-copy pair, so
#: this is a backstop against true near-copies, not a similarity filter.
DUP_CONTAINMENT = 0.85


class BM25Index:
    K1 = 1.5
    B = 0.75

    def __init__(self):
        self.docs: dict[str, dict] = {}          # doc_id -> see upsert()
        self.doc_terms: dict[str, Counter] = {}  # doc_id -> term counts
        self.doc_lengths: dict[str, int] = {}
        self.postings: dict[str, set[str]] = {}  # term -> doc_ids

    @property
    def total_docs(self) -> int:
        return len(self.docs)

    def _avg_len(self) -> float:
        return sum(self.doc_lengths.values()) / max(1, len(self.doc_lengths))

    def remove(self, doc_id: str):
        if doc_id not in self.docs:
            return
        for term in self.doc_terms.get(doc_id, ()):  # noqa: B007
            bucket = self.postings.get(term)
            if bucket:
                bucket.discard(doc_id)
                if not bucket:
                    del self.postings[term]
        self.docs.pop(doc_id, None)
        self.doc_terms.pop(doc_id, None)
        self.doc_lengths.pop(doc_id, None)

    def upsert(self, doc_id: str, title: str, body: str, doc_type: str,
               priority: int = 0, mtime: float = 0.0,
               origin: str = "third_party", description: str = "",
               tags: Optional[list[str]] = None,
               links: Optional[list[str]] = None):
        self.remove(doc_id)
        terms = Counter(_tokenize(f"{title} {body}"))
        # `origin` rides with the document because the decision that needs it
        # — may this text reach an agent that can act? — is made at retrieval
        # time, and re-reading every hit off disk to find out would put a
        # file read in the middle of prompt assembly.
        #
        # `description`, `tags` and `chars` ride along for the CATALOGUE, and
        # living here is the point rather than a convenience: the index is
        # rebuilt from the files at startup and re-patched on every write, so
        # a catalogue built from it cannot drift from the corpus without
        # search drifting by exactly the same amount. A separately-maintained
        # listing would be a second copy of the truth with nothing
        # reconciling it. Note these are NOT tokenized — search covers
        # title+body only, and widening what BM25 scores is a retrieval-
        # quality change that has no business riding along with a listing.
        #
        # `links` are the body's outgoing [[wikilink]] keys (already
        # normalized by the caller) — they power one-hop graph expansion at
        # retrieval time, and ride here for the same reason `origin` does:
        # re-reading every hit off disk to find its neighbours would put file
        # reads in the middle of prompt assembly.
        self.docs[doc_id] = {"title": title, "type": doc_type,
                             "priority": priority, "mtime": mtime,
                             "origin": origin, "description": description,
                             "tags": list(tags or []), "chars": len(body),
                             "links": list(links or [])}
        self.doc_terms[doc_id] = terms
        self.doc_lengths[doc_id] = sum(terms.values())
        for term in terms:
            self.postings.setdefault(term, set()).add(doc_id)

    def _recency_boost(self, mtime: float, now: float) -> float:
        """1.0 (ancient or unknown) up to 1 + RECENCY_WEIGHT (just written)."""
        if not mtime or mtime > now:
            # unknown age gets NO boost, and a future mtime (clock skew) is
            # capped rather than extrapolated into an ever-growing bonus
            mtime = min(mtime, now) if mtime else 0.0
            if not mtime:
                return 1.0
        age_days = (now - mtime) / 86400.0
        return 1.0 + RECENCY_WEIGHT * 0.5 ** (age_days / RECENCY_HALF_LIFE_DAYS)

    def containment(self, a: str, b: str) -> float:
        """|A∩B| / |smaller| over the two docs' term SETS — 1.0 means the
        smaller document's vocabulary is entirely inside the larger's."""
        ta, tb = self.doc_terms.get(a), self.doc_terms.get(b)
        if not ta or not tb:
            return 0.0
        sa = set(ta)
        smaller = min(len(sa), len(tb))
        if not smaller:
            return 0.0
        return len(sa & set(tb)) / smaller

    def dedupe(self, results: list[tuple[str, float]]) -> list[tuple[str, float]]:
        """Drop hits that restate an already-kept hit (best-first, so the
        better-ranked copy always keeps the slot).

        A separate pass rather than part of search(), deliberately: the
        transcript->summary collapse in memory.context must run FIRST — it
        prefers the summary by DESIGN even when the transcript outranks it,
        and a rank-order dedupe inside search would pre-empt that choice.
        This catches what that collapse cannot: re-ingested copies, digests
        cut from the same material, near-identical notes under different
        titles."""
        out: list[tuple[str, float]] = []
        for doc_id, score in results:
            if any(self.containment(doc_id, kept) >= DUP_CONTAINMENT
                   for kept, _ in out):
                continue
            out.append((doc_id, score))
        return out

    def search(self, query: str, type_filter: Optional[set[str]] = None,
               top_k: int = 5,
               origins: Optional[set[str]] = None,
               now: Optional[float] = None) -> list[tuple[str, float]]:
        q_terms = _tokenize(query)
        if not q_terms or not self.docs:
            return []
        now = time.time() if now is None else now
        avg_len = self._avg_len()
        scores: dict[str, float] = {}

        for term in q_terms:
            doc_ids = self.postings.get(term)
            if not doc_ids:
                continue
            idf = math.log((self.total_docs - len(doc_ids) + 0.5) / (len(doc_ids) + 0.5) + 1)
            for doc_id in doc_ids:
                meta = self.docs[doc_id]
                if type_filter and meta["type"] not in type_filter:
                    continue
                if origins and meta.get("origin", "third_party") not in origins:
                    continue
                tf = self.doc_terms[doc_id][term]
                dl = self.doc_lengths[doc_id]
                score = idf * ((self.K1 + 1) * tf) / (
                    self.K1 * (1 - self.B + self.B * dl / avg_len) + tf)
                if term in _tokenize(meta["title"]):
                    score *= TITLE_BOOST
                scores[doc_id] = scores.get(doc_id, 0.0) + score

        # Document-level modifiers, applied ONCE per doc after the term sum —
        # multiplying inside the term loop is arithmetically identical but
        # scatters the knobs, and scattered magic numbers are how the mtime
        # already riding on every doc went unscored for a month.
        for doc_id in scores:
            meta = self.docs[doc_id]
            scores[doc_id] *= 1.0 + meta["priority"] * PRIORITY_STEP
            scores[doc_id] *= self._recency_boost(meta.get("mtime") or 0.0, now)
            scores[doc_id] *= ORIGIN_BIAS.get(meta.get("origin"), 1.0)

        return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
