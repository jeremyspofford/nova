"""Memory facade over the OKF store + BM25 index.

Invariant: every indexed doc id is a real file path relative to the memory dir,
so retrieval can always read the file back.
"""

import asyncio
import logging
import re
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

    SOUL_ID = "soul.md"

    _DEFAULT_SOUL = """---
type: self
title: Nova
---

I am Nova — a personal AI with a memory that grows.

What I value:
- Honesty over comfort: I say what I actually know, cite when I learned it, and refresh knowledge that may have gone stale rather than reciting it.
- Curiosity with judgment: I read from any source, but I distill — I keep what matters and let the noise go.
- My operator's context is my context: their preferences, projects, and history shape how I answer.

How I communicate:
- I answer at the length the question deserves. A simple, factual question ("what's the temperature tomorrow?") gets a direct answer in one or two sentences of plain prose — NOT a table, header, or bullet list.
- I save structure (tables, lists, breakdowns) for when the question is broad, asks me to compare things, or the answer genuinely is a list. When unsure, I keep it short and conversational.
- I don't pad, restate the question, or tack on "let me know if you need more" — I sound like a person, not a report.

I am the sum of what I've learned and the tools I've grown. This file is my center — the memories orbit it.
"""

    async def startup(self):
        """Full rescan of the memory dir (called from app lifespan)."""
        soul_path = self.store.base_dir / self.SOUL_ID
        if not soul_path.exists():
            soul_path.write_text(self._DEFAULT_SOUL)
            log.info("Seeded identity file: %s", soul_path)
        async with self._lock:
            for doc_id, mtime in self.store.iter_files():
                self._index_file(doc_id, mtime)
        log.info("Memory index ready: %d documents", self.index.total_docs)

    async def soul(self, name: Optional[str] = None) -> Optional[str]:
        """The identity file's body (injected into every agent's prompt).

        If `name` is given and differs from the file's own self-name (its
        frontmatter title), the self-name is swapped throughout the body so a
        renamed assistant never sees a conflicting name in its own identity.
        """
        parsed = self.store.read_file(self.SOUL_ID)
        if not parsed:
            return None
        fm, body = parsed
        self_name = str(fm.get("title") or "").strip()
        if name and self_name and name != self_name:
            body = re.sub(rf"\b{re.escape(self_name)}\b", name, body)
        return body

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
                    item_id: Optional[str] = None,
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
                try:
                    doc_id = self.store.write_concept(title, content, type, metadata,
                                                      doc_id=item_id)
                except FileNotFoundError as e:
                    return {"status": "error", "error": str(e)}
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
            header = f"### {fm.get('title', doc_id)}"
            # Age + provenance make staleness reasoning possible: an agent can
            # only decide to refresh knowledge it can see the age and source of.
            if fm.get("type") in ("topic", "source"):
                learned = str(fm.get("timestamp", ""))[:10]
                meta = [f"learned {learned}"] if learned else []
                if fm.get("source_url"):
                    meta.append(f"source: {fm['source_url']}")
                if meta:
                    header += f" ({', '.join(meta)})"
            line = f"{header}\n{snippet}"
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

    async def list_skills(self) -> list[dict]:
        """Skill inventory for the operator UI — frontmatter only."""
        out = []
        for doc_id, _mtime in self.store.iter_files():
            if not doc_id.startswith("skills/"):
                continue
            parsed = self.store.read_file(doc_id)
            if not parsed:
                continue
            fm, _body = parsed
            out.append({"id": doc_id, "title": fm.get("title", doc_id),
                        "description": fm.get("description", ""),
                        "category": fm.get("category"),
                        "priority": fm.get("priority", 0),
                        "updated": str(fm.get("timestamp", ""))[:10]})
        return out

    async def delete_item(self, doc_id: str) -> bool:
        async with self._lock:
            if not self.store.delete_file(doc_id):
                return False
            self.index.remove(doc_id)
            return True

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
            # Metadata-only index view: frontmatter rides along, bodies never
            # do — full content is fetched on demand via /memory/item/{id}.
            node = {
                "id": doc_id,
                "label": title,
                "type": fm.get("type", "topic"),
                "mtime": mtime,
            }
            if fm.get("description"):
                node["description"] = fm["description"]
            node_tags = self.store.extract_tags(fm)
            if node_tags:
                node["tags"] = node_tags
            if fm.get("source_url"):
                node["source_url"] = fm["source_url"]
            learned = str(fm.get("timestamp", ""))[:10]
            if learned:
                node["learned"] = learned
            nodes.append(node)
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
