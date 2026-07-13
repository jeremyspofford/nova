"""In-process BM25 index over memory files. Doc ids are always file paths."""

import logging
import math
import re
from collections import Counter
from typing import Optional

log = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


class BM25Index:
    K1 = 1.5
    B = 0.75

    def __init__(self):
        self.docs: dict[str, dict] = {}          # doc_id -> {title, type, priority, mtime}
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
               priority: int = 0, mtime: float = 0.0):
        self.remove(doc_id)
        terms = Counter(_tokenize(f"{title} {body}"))
        self.docs[doc_id] = {"title": title, "type": doc_type,
                             "priority": priority, "mtime": mtime}
        self.doc_terms[doc_id] = terms
        self.doc_lengths[doc_id] = sum(terms.values())
        for term in terms:
            self.postings.setdefault(term, set()).add(doc_id)

    def search(self, query: str, type_filter: Optional[set[str]] = None,
               top_k: int = 5) -> list[tuple[str, float]]:
        q_terms = _tokenize(query)
        if not q_terms or not self.docs:
            return []
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
                tf = self.doc_terms[doc_id][term]
                dl = self.doc_lengths[doc_id]
                score = idf * ((self.K1 + 1) * tf) / (
                    self.K1 * (1 - self.B + self.B * dl / avg_len) + tf)
                if term in _tokenize(meta["title"]):
                    score *= 2.0
                score *= 1.0 + meta["priority"] * 0.1
                scores[doc_id] = scores.get(doc_id, 0.0) + score

        return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
