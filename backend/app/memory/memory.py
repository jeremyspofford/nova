"""Memory facade - high-level interface for memory operations."""

import asyncio
import logging
from datetime import datetime
from typing import Optional
from app.memory.store import OkfStore
from app.memory.index import BM25Index
from app.config import settings

log = logging.getLogger(__name__)


class OkfMemory:
    """High-level memory interface using OKF markdown store."""

    def __init__(self):
        self.store = OkfStore(settings.okf_memory_dir)
        self.index = BM25Index()
        self.index_lock = asyncio.Lock()
        self._indexed = False

    async def _ensure_indexed(self):
        """Lazy-load and index all documents."""
        if self._indexed:
            return

        async with self.index_lock:
            if self._indexed:  # Double-check
                return

            # Index all existing documents
            for concept_type in ["topic", "skill", "journal"]:
                for rel_path in self.store.list_files(concept_type):
                    result = self.store.read_file(rel_path)
                    if result:
                        fm, body = result
                        doc_id = rel_path
                        title = fm.get("title", rel_path)
                        priority = int(fm.get("priority", 0))
                        self.index.add_document(doc_id, title, body, concept_type, priority)

            self._indexed = True
            log.info(f"Memory index loaded: {self.index.total_docs} documents")

    async def write(self, content: str, source_type: str = "chat", metadata: Optional[dict] = None) -> dict:
        """Write content to memory."""
        metadata = metadata or {}
        metadata.setdefault("source_type", source_type)

        # Append to today's journal
        today = datetime.utcnow().date().isoformat()
        self.store.append_journal(today, content)

        # Also index in-memory for quick retrieval
        doc_id = f"journal:{today}:{datetime.utcnow().timestamp()}"
        self.index.add_document(doc_id, "Journal Entry", content, "journal", 0)

        return {"status": "written", "type": "journal"}

    async def context(self, query: str, max_chars: int = 4000) -> dict:
        """Retrieve context from memory for a query."""
        await self._ensure_indexed()

        results = self.index.search(query, top_k=5)

        context_lines = []
        total_chars = 0

        for doc_id, score in results:
            if doc_id not in self.store.documents:
                result = self.store.read_file(doc_id)
                if not result:
                    continue
                fm, body = result
                title = fm.get("title", doc_id)
                content = body[:500]  # Trim long documents
            else:
                doc = self.store.documents[doc_id]
                title = doc["title"]
                content = doc["body"][:500]

            item = f"- **{title}** (score: {score:.2f}): {content}"
            if total_chars + len(item) > max_chars:
                break

            context_lines.append(item)
            total_chars += len(item)

        context_text = "\n".join(context_lines) if context_lines else "No relevant memories found."

        return {
            "context": context_text,
            "total_tokens": len(context_text.split()) + 10,  # Rough estimate
            "memory_ids": [doc_id for doc_id, _ in results],
            "metadata": {"query": query, "results_count": len(results)},
        }

    async def skills_context(self, query: str) -> dict:
        """Retrieve applicable skills for a query."""
        await self._ensure_indexed()

        results = self.index.search(query, type_filter={"skill"}, top_k=3)

        skill_lines = []
        for doc_id, score in results:
            if doc_id not in self.store.documents:
                result = self.store.read_file(doc_id)
                if not result:
                    continue
                fm, body = result
                title = fm.get("title", doc_id)
            else:
                doc = self.store.documents[doc_id]
                title = doc["title"]

            skill_lines.append(f"- {title}")

        skills_text = "\n".join(skill_lines) if skill_lines else "No applicable skills found."

        return {
            "context": skills_text,
            "total_tokens": len(skills_text.split()) + 5,
            "memory_ids": [doc_id for doc_id, _ in results],
        }

    async def stats(self) -> dict:
        """Get memory statistics."""
        await self._ensure_indexed()
        return {
            "total_items": self.index.total_docs,
            **self.store.get_stats(),
        }

    async def mark_used(self, memory_ids: list[str], agent_id: Optional[str] = None):
        """Mark memories as used (for future analytics)."""
        log.debug(f"Marked {len(memory_ids)} memories as used")

    async def feedback(self, memory_id: str, feedback_type: str, value: float):
        """Record feedback on memory retrieval."""
        log.debug(f"Feedback on {memory_id}: {feedback_type}={value}")

    async def provenance(self, memory_id: str) -> Optional[dict]:
        """Get provenance/metadata for a memory item."""
        result = self.store.read_file(memory_id)
        if result:
            fm, body = result
            return fm
        return None


# Global instance
memory = OkfMemory()
