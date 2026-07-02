"""
BM25 keyword index over the OKF bundle — .nova/index.json.

No embeddings, no LLM calls: retrieval is Okapi BM25 over tokenized file
contents with boosts for title/tag hits, feedback score, and recency.

Self-healing: every search/refresh stats the bundle; files whose mtime
changed are re-tokenized, deleted files drop out. Direct edits by humans
or agent file tools are therefore fully supported.
"""

from __future__ import annotations

import json
import logging
import math
import re
import time
from dataclasses import dataclass
from pathlib import Path

from .store import OkfStore, parse_document

log = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOPWORDS = frozenset(
    "a an and are as at be but by for from has have i in is it its of on or "
    "that the this to was were what when where which who will with you your".split()
)

K1 = 1.5
B = 0.75


def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if t not in _STOPWORDS and len(t) > 1]


@dataclass
class SearchHit:
    memory_id: str
    score: float
    title: str
    excerpt: str


class OkfIndex:
    def __init__(self, store: OkfStore):
        self.store = store
        self.path = store.nova_dir / "index.json"
        self._data: dict | None = None

    # ── Persistence ──────────────────────────────────────────────────────

    def _load(self) -> dict:
        if self._data is None:
            try:
                self._data = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self._data = {"files": {}}
        return self._data

    def _save(self) -> None:
        if self._data is not None:
            self.store.nova_dir.mkdir(exist_ok=True)
            self.path.write_text(json.dumps(self._data), encoding="utf-8")

    # ── Refresh (self-heal on mtime drift) ───────────────────────────────

    def refresh(self, full: bool = False) -> int:
        """Bring the index in line with the filesystem. Returns number of
        files (re)indexed."""
        data = self._load()
        files: dict = data["files"] if not full else {}
        seen: set[str] = set()
        changed = 0

        for p in self.store.concept_files():
            rel = self.store.rel(p)
            seen.add(rel)
            try:
                mtime = p.stat().st_mtime
            except OSError:
                continue
            entry = files.get(rel)
            if entry and entry.get("mtime") == mtime:
                continue

            try:
                fm, body = parse_document(p.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
            tokens = tokenize(body)
            tf: dict[str, int] = {}
            for t in tokens:
                tf[t] = tf.get(t, 0) + 1
            files[rel] = {
                "mtime": mtime,
                "title": str(fm.get("title") or p.stem),
                "tags": [str(t).lower() for t in (fm.get("tags") or [])],
                "type": str(fm.get("type") or "note"),
                "timestamp": str(fm.get("timestamp") or ""),
                "tf": tf,
                "len": len(tokens),
                # feedback accumulator survives re-tokenization
                "score": (entry or {}).get("score", 0.0),
            }
            changed += 1

        for rel in list(files):
            if rel not in seen:
                del files[rel]
                changed += 1

        data["files"] = files
        self._data = data
        if changed:
            self._save()
        return changed

    # ── Feedback ─────────────────────────────────────────────────────────

    def adjust_score(self, memory_id: str, delta: float) -> None:
        data = self._load()
        entry = data["files"].get(memory_id.lstrip("/"))
        if entry is not None:
            entry["score"] = max(-10.0, min(10.0, entry.get("score", 0.0) + delta))
            self._save()

    # ── Search ───────────────────────────────────────────────────────────

    def search(self, query: str, k: int = 8) -> list[SearchHit]:
        self.refresh()
        data = self._load()
        files = data["files"]
        if not files:
            return []

        terms = tokenize(query)
        if not terms:
            return []

        n_docs = len(files)
        avg_len = max(1.0, sum(f["len"] for f in files.values()) / n_docs)
        # document frequency per term
        df = {t: sum(1 for f in files.values() if t in f["tf"]) for t in terms}
        now = time.time()

        scored: list[tuple[float, str]] = []
        for rel, f in files.items():
            score = 0.0
            for t in terms:
                tf = f["tf"].get(t, 0)
                if tf == 0:
                    continue
                idf = math.log(1 + (n_docs - df[t] + 0.5) / (df[t] + 0.5))
                score += idf * (tf * (K1 + 1)) / (
                    tf + K1 * (1 - B + B * f["len"] / avg_len)
                )
            # Title/tag hits matter more than body hits
            title_tokens = set(tokenize(f["title"]))
            score += sum(0.5 for t in terms if t in title_tokens)
            score += sum(0.3 for t in terms if t in f["tags"])
            if score <= 0:
                continue
            # Feedback boost: ±10% per accumulated point
            score *= 1.0 + 0.1 * f.get("score", 0.0)
            # Recency: gentle boost for files touched in the last month
            age_days = max(0.0, (now - f["mtime"]) / 86400)
            score *= 1.0 + 0.15 * math.exp(-age_days / 30)
            scored.append((score, rel))

        scored.sort(reverse=True)
        hits = []
        for score, rel in scored[:k]:
            hits.append(
                SearchHit(
                    memory_id=rel,
                    score=round(score, 4),
                    title=files[rel]["title"],
                    excerpt=self._excerpt(rel, terms),
                )
            )
        return hits

    def _excerpt(self, memory_id: str, terms: list[str], window: int = 3,
                 max_chars: int = 700) -> str:
        """Best-matching line window from the file (grep-legible explain)."""
        doc = self.store.read(memory_id)
        if doc is None:
            return ""
        _fm, body = doc
        lines = body.split("\n")
        best_i, best_hits = 0, -1
        for i, line in enumerate(lines):
            lt = set(tokenize(line))
            hits = sum(1 for t in terms if t in lt)
            if hits > best_hits:
                best_i, best_hits = i, hits
        lo = max(0, best_i - window)
        hi = min(len(lines), best_i + window + 1)
        return "\n".join(lines[lo:hi]).strip()[:max_chars]
