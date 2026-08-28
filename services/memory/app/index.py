"""Hand-rolled BM25 index over memory documents, in-process only.

This is a pure scoring engine — it knows nothing about the filesystem or
person scoping. Callers (api.py) hand it rel_path + metadata + text on
upsert, and pass a scope_prefix on every search; it is the caller's job
to keep the index synced (upsert/remove on every store write/delete) and
to re-verify scope on the results it hands back (belt and suspenders —
see api.py).

Deliberately small (no embeddings, no external search engine) per the
brief's YAGNI instruction: tokenizer + BM25 + a recency multiplier + a
snippet-window scan, nothing else.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime

_TOKEN_RE = re.compile(r"[a-z0-9]+")

# BM25 constants (Task 5 brief, verbatim).
K1 = 1.5
B = 0.75

# Recency boost: final = bm25 * (1 + RECENCY_WEIGHT * exp(-age_days / RECENCY_DECAY_DAYS))
RECENCY_WEIGHT = 0.5
RECENCY_DECAY_DAYS = 30.0

# Snippet window: SNIPPET_RADIUS chars on each side of the best-matching
# token run (so a full snippet is up to 2 * SNIPPET_RADIUS chars).
SNIPPET_RADIUS = 200


def tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


def _coerce_date(value: object) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value[:10])
    raise ValueError(f"unparseable created date: {value!r}")


@dataclass
class _Doc:
    rel_path: str
    title: str
    kind: str
    created: date
    text: str  # title + body — the one source both tokens and snippets come from
    term_freq: Counter
    length: int


class BM25Index:
    def __init__(self) -> None:
        self._docs: dict[str, _Doc] = {}
        self._df: Counter = Counter()
        self._avgdl: float = 0.0

    def upsert(self, rel_path: str, *, title: str, kind: str, created: object, body: str) -> None:
        self.remove(rel_path)
        text = f"{title}\n\n{body}"
        tf = Counter(tokenize(text))
        doc = _Doc(
            rel_path=rel_path,
            title=title,
            kind=kind,
            created=_coerce_date(created),
            text=text,
            term_freq=tf,
            length=sum(tf.values()),
        )
        self._docs[rel_path] = doc
        for term in tf:
            self._df[term] += 1
        self._recompute_avgdl()

    def remove(self, rel_path: str) -> None:
        doc = self._docs.pop(rel_path, None)
        if doc is None:
            return
        for term in doc.term_freq:
            self._df[term] -= 1
            if self._df[term] <= 0:
                del self._df[term]
        self._recompute_avgdl()

    def _recompute_avgdl(self) -> None:
        self._avgdl = (
            sum(d.length for d in self._docs.values()) / len(self._docs) if self._docs else 0.0
        )

    def search(
        self, query: str, *, scope_prefix: str, k: int = 5, today: date | None = None
    ) -> list[dict]:
        terms = tokenize(query)
        if not terms:
            return []
        n = len(self._docs)
        today = today or datetime.now(UTC).date()
        scored: list[tuple[float, _Doc]] = []
        for rel_path, doc in self._docs.items():
            if not rel_path.startswith(scope_prefix):
                continue
            raw = self._bm25(terms, doc, n)
            if raw <= 0:
                continue
            boosted = raw * self._recency_multiplier(doc.created, today)
            scored.append((boosted, doc))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [
            {
                "path": doc.rel_path,
                "title": doc.title,
                "kind": doc.kind,
                "snippet": _snippet(doc.text, terms),
                "score": score,
            }
            for score, doc in scored[: max(k, 0)]
        ]

    def _bm25(self, terms: list[str], doc: _Doc, n: int) -> float:
        score = 0.0
        for term in set(terms):
            df = self._df.get(term, 0)
            if df == 0:
                continue
            tf = doc.term_freq.get(term, 0)
            if tf == 0:
                continue
            idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
            denom = tf + K1 * (1 - B + B * (doc.length / self._avgdl if self._avgdl else 1.0))
            score += idf * (tf * (K1 + 1)) / denom
        return score

    @staticmethod
    def _recency_multiplier(created: date, today: date) -> float:
        age_days = max((today - created).days, 0)
        return 1 + RECENCY_WEIGHT * math.exp(-age_days / RECENCY_DECAY_DAYS)


def _snippet(text: str, terms: list[str]) -> str:
    """±SNIPPET_RADIUS chars around the best-matching token run: the
    hit position with the most other hits within SNIPPET_RADIUS chars of
    it, earliest position on ties."""
    term_set = set(terms)
    hits = [m.start() for m in _TOKEN_RE.finditer(text.lower()) if m.group(0) in term_set]
    if not hits:
        return text[: SNIPPET_RADIUS * 2].strip()
    best_start = hits[0]
    best_count = -1
    for center in hits:
        count = sum(1 for h in hits if abs(h - center) <= SNIPPET_RADIUS)
        if count > best_count:
            best_count = count
            best_start = center
    start = max(0, best_start - SNIPPET_RADIUS)
    end = min(len(text), best_start + SNIPPET_RADIUS)
    return text[start:end].strip()
