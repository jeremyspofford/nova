"""Memory facade over the OKF store + BM25 index.

Invariant: every indexed doc id is a real file path relative to the memory dir,
so retrieval can always read the file back.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from app.config import settings
from app.memory.index import BM25Index
from app.memory.store import OkfStore

log = logging.getLogger(__name__)

_SNIPPET_CHARS = 500
_SKILL_SNIPPET_CHARS = 700


class OkfMemory:
    def __init__(self):
        self.store = OkfStore(settings.okf_memory_dir)
        self.index = BM25Index()
        self._lock = asyncio.Lock()

    # ── lifecycle ────────────────────────────────────────────────────────

    async def startup(self):
        """Full rescan of the memory dir (called from app lifespan)."""
        async with self._lock:
            for doc_id, mtime in self.store.iter_files():
                self._index_file(doc_id, mtime)
        log.info("Memory index ready: %d documents", self.index.total_docs)

    def _index_file(self, doc_id: str, mtime: float = 0.0):
        parsed = self.store.read_file(doc_id)
        if not parsed:
            self.index.remove(doc_id)
            return
        fm, body = parsed
        try:
            priority = int(fm.get("priority", 0))
        except (TypeError, ValueError):
            priority = 0
        self.index.upsert(doc_id, fm.get("title", doc_id), body,
                          fm.get("type", "topic"), priority, mtime)

    # ── writes ───────────────────────────────────────────────────────────

    async def write(self, content: str, *, type: str = "journal",
                    title: Optional[str] = None, description: Optional[str] = None,
                    category: Optional[str] = None, priority: int = 0,
                    tags: Optional[list[str]] = None, source_url: Optional[str] = None,
                    source_type: str = "chat") -> dict:
        """Write to memory. journal → append to today's file; skill/topic → concept file."""
        async with self._lock:
            if type in ("skill", "topic"):
                if not title:
                    return {"status": "error",
                            "error": f"title is required when writing a {type}"}
                metadata = {"type": type, "title": title, "priority": priority,
                            "source_type": source_type, "enabled": True}
                if description:
                    metadata["description"] = description
                if category:
                    metadata["category"] = category
                if tags:
                    metadata["tags"] = [str(t).strip().lower() for t in tags if str(t).strip()]
                if source_url:
                    metadata["source_url"] = source_url
                doc_id = self.store.write_concept(title, content, type, metadata)
            else:
                today = datetime.now(timezone.utc).date().isoformat()
                doc_id = self.store.append_journal(today, content)

            self._index_file(doc_id)
            return {"status": "written", "type": type, "id": doc_id}

    # ── retrieval ────────────────────────────────────────────────────────

    def _snippets(self, results: list[tuple[str, float]], max_chars: int,
                  snippet_chars: int) -> tuple[list[str], list[str]]:
        lines, ids, used = [], [], 0
        for doc_id, score in results:
            parsed = self.store.read_file(doc_id)
            if not parsed:
                continue
            fm, body = parsed
            snippet = body[:snippet_chars].strip()
            line = f"### {fm.get('title', doc_id)}\n{snippet}"
            if used + len(line) > max_chars:
                break
            lines.append(line)
            ids.append(doc_id)
            used += len(line)
        return lines, ids

    async def context(self, query: str, max_chars: Optional[int] = None) -> dict:
        """Relevant memories (topics + journals; skills are retrieved separately)."""
        max_chars = max_chars or settings.memory_context_max_chars
        results = self.index.search(query, type_filter={"topic", "journal", "source"},
                                    top_k=settings.memory_context_top_k)
        lines, ids = self._snippets(results, max_chars, _SNIPPET_CHARS)
        text = "\n\n".join(lines)
        return {
            "context": text,
            "total_tokens": len(text.split()),
            "memory_ids": ids,
        }

    async def skills_context(self, query: str) -> dict:
        """Applicable skills — full-enough bodies that they can actually steer behavior."""
        results = self.index.search(query, type_filter={"skill"}, top_k=3)
        lines, ids = self._snippets(results, 2500, _SKILL_SNIPPET_CHARS)
        text = "\n\n".join(lines)
        return {"context": text, "total_tokens": len(text.split()), "memory_ids": ids}

    async def read_item(self, doc_id: str) -> Optional[dict]:
        parsed = self.store.read_file(doc_id)
        if not parsed:
            return None
        fm, body = parsed
        return {"id": doc_id, "frontmatter": fm, "content": body}

    async def stats(self) -> dict:
        return {"indexed": self.index.total_docs, **self.store.get_stats()}

    # ── graph (Phase E) ──────────────────────────────────────────────────

    async def graph(self) -> dict:
        nodes, edges = [], []
        by_title: dict[str, str] = {}
        tag_map: dict[str, list[str]] = {}
        files = self.store.iter_files()

        for doc_id, mtime in files:
            parsed = self.store.read_file(doc_id)
            if not parsed:
                continue
            fm, body = parsed
            title = fm.get("title", doc_id)
            nodes.append({
                "id": doc_id,
                "label": title,
                "type": fm.get("type", "topic"),
                "mtime": mtime,
            })
            by_title[title.lower()] = doc_id
            for tag in self.store.extract_tags(fm):
                tag_map.setdefault(tag, []).append(doc_id)
            for link in self.store.extract_links(body):
                edges.append({"source": doc_id, "target_title": link.lower()})

        resolved = []
        seen = set()
        for e in edges:
            target = by_title.get(e["target_title"])
            if target and (e["source"], target) not in seen:
                seen.add((e["source"], target))
                resolved.append({"source": e["source"], "target": target, "kind": "link"})
        for tag, members in tag_map.items():
            for i in range(len(members) - 1):
                pair = (members[i], members[i + 1])
                if pair not in seen:
                    seen.add(pair)
                    resolved.append({"source": pair[0], "target": pair[1], "kind": "tag"})

        return {"nodes": nodes, "edges": resolved}


memory = OkfMemory()
