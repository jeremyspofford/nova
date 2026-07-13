"""BM25 index for memory retrieval."""

import logging
import math
from collections import Counter
from typing import Optional

log = logging.getLogger(__name__)


class BM25Index:
    """Simple BM25 implementation for memory retrieval."""

    def __init__(self):
        self.documents = {}  # doc_id -> {title, body, type, priority}
        self.inverted_index = {}  # term -> set of doc_ids
        self.doc_freqs = {}  # (doc_id, term) -> frequency
        self.doc_lengths = {}  # doc_id -> length
        self.avg_doc_length = 0
        self.total_docs = 0

        # BM25 parameters
        self.k1 = 1.5  # term frequency saturation
        self.b = 0.75  # document length normalization

    def _tokenize(self, text: str) -> list[str]:
        """Simple tokenization."""
        return text.lower().split()

    def add_document(self, doc_id: str, title: str, body: str, doc_type: str = "topic", priority: int = 0):
        """Add a document to the index."""
        self.documents[doc_id] = {
            "title": title,
            "body": body,
            "type": doc_type,
            "priority": priority,
        }

        # Tokenize and index
        tokens = self._tokenize(f"{title} {body}")
        token_counts = Counter(tokens)

        self.doc_lengths[doc_id] = len(tokens)

        for token, count in token_counts.items():
            if token not in self.inverted_index:
                self.inverted_index[token] = set()
            self.inverted_index[token].add(doc_id)
            self.doc_freqs[(doc_id, token)] = count

        self.total_docs = len(self.documents)
        self.avg_doc_length = sum(self.doc_lengths.values()) / max(1, self.total_docs)

    def search(self, query: str, type_filter: Optional[set[str]] = None, top_k: int = 5) -> list[tuple[str, float]]:
        """Search for documents using BM25."""
        query_tokens = self._tokenize(query)
        scores = {}

        for token in query_tokens:
            if token not in self.inverted_index:
                continue

            idf = math.log((self.total_docs - len(self.inverted_index[token]) + 0.5) / (len(self.inverted_index[token]) + 0.5) + 1)

            for doc_id in self.inverted_index[token]:
                if type_filter and self.documents[doc_id]["type"] not in type_filter:
                    continue

                tf = self.doc_freqs.get((doc_id, token), 0)
                doc_length = self.doc_lengths[doc_id]

                bm25_score = idf * ((self.k1 + 1) * tf) / (self.k1 * (1 - self.b + self.b * (doc_length / self.avg_doc_length)) + tf)

                # Boost based on priority
                priority_boost = 1.0 + (self.documents[doc_id]["priority"] * 0.1)
                bm25_score *= priority_boost

                # Boost for title matches
                if token in self._tokenize(self.documents[doc_id]["title"]):
                    bm25_score *= 2.0

                scores[doc_id] = scores.get(doc_id, 0) + bm25_score

        # Sort by score and return top_k
        sorted_results = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return sorted_results[:top_k]
