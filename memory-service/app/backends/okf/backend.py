"""
OKF markdown backend — MemoryBackend over the OKF bundle store + BM25 index.

Write routing:
- Explicit concept writes (the agent `remember` tool) pass an `okf`
  metadata dict {type, title, description?, tags?, target?, resource?}
  and land as topic/person/project/... files.
- Everything else (chat exchanges, screenpipe sessions, intel items —
  the high-volume queue producers) is appended as a digest entry to
  journal/YYYY-MM-DD.md, to be distilled by the nightly curation goal.

Zero LLM calls, zero embeddings: ingestion is a file write, retrieval is
BM25 (see index.py). Memory ids are bundle-relative paths.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings

from ..base import ContextResult, MemoryBackend, WriteResult
from .index import OkfIndex
from .store import OkfStore, extract_links

log = logging.getLogger(__name__)

# Trust defaults by producer source kind
TRUST_BY_SOURCE = {
    "chat": 0.95,
    "tool": 0.85,
    "pipeline": 0.80,
    "cortex": 0.85,
    "consolidation": 0.85,
    "self_reflection": 0.85,
    "journal": 0.90,
    "intel": 0.70,
    "knowledge": 0.70,
    "external": 0.70,
    "screenpipe": 0.80,
}

_CHARS_PER_TOKEN = 4  # cheap budget estimate


def _est_tokens(text: str) -> int:
    return len(text) // _CHARS_PER_TOKEN


class OkfBackend(MemoryBackend):
    name = "okf"

    def __init__(self, root: str | Path | None = None):
        self.store = OkfStore(Path(root or settings.okf_memory_dir))
        self.store.ensure_bundle()
        self.index = OkfIndex(self.store)
        self._retrievals_path = self.store.nova_dir / "retrievals.jsonl"

    # ── write ────────────────────────────────────────────────────────────

    async def write(
        self,
        raw_text: str,
        *,
        source_type: str = "chat",
        source_id: str | None = None,
        session_id: str | None = None,
        occurred_at: str | None = None,
        metadata: dict | None = None,
        tenant_id: str | None = None,
    ) -> WriteResult:
        if not raw_text.strip():
            return WriteResult()
        metadata = metadata or {}
        okf = metadata.get("okf") or {}

        nova_fm = {
            "nova_source_kind": source_type,
            "nova_trust": TRUST_BY_SOURCE.get(source_type, 0.7),
            "nova_session_id": session_id,
            "nova_source_id": source_id,
            "nova_tenant_id": tenant_id,
        }

        if okf.get("title"):
            # Deliberate concept write (remember tool / curation task)
            memory_id, created = await self.store.write_concept(
                type_=okf.get("type", "note"),
                title=okf["title"],
                body=raw_text,
                description=okf.get("description", ""),
                tags=okf.get("tags"),
                resource=okf.get("resource"),
                extra_frontmatter=nova_fm,
                target=okf.get("target"),
            )
        else:
            ts = None
            if occurred_at:
                try:
                    ts = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
                except ValueError:
                    ts = None
            memory_id = await self.store.append_journal(
                raw_text,
                source_kind=source_type,
                occurred_at=ts,
                extra_frontmatter=nova_fm,
            )
            created = False

        self.index.refresh()
        return WriteResult(
            items_created=1 if created else 0,
            items_updated=0 if created else 1,
            item_ids=[memory_id],
        )

    async def delete(self, memory_id: str) -> bool:
        deleted = await self.store.delete_file(memory_id)
        if deleted:
            self.index.refresh()
        return deleted

    # ── context ──────────────────────────────────────────────────────────

    async def context(
        self,
        query: str,
        *,
        session_id: str = "",
        current_turn: int = 0,
        depth: str = "standard",
        tenant_id: str | None = None,
        mark_used: bool = False,
    ) -> ContextResult:
        top_k = {"shallow": 3, "standard": settings.okf_context_top_k, "deep": 15}.get(
            depth, settings.okf_context_top_k
        )
        budget_chars = settings.okf_context_max_chars

        parts: list[str] = []
        index_body = self.store.root_index_body(max_chars=budget_chars // 3)
        if index_body:
            parts.append(f"## Memory Index\n{index_body}")

        hits = self.index.search(query, k=top_k) if query else []
        memory_ids: list[str] = []
        summaries: list[dict] = []
        used = sum(len(p) for p in parts)
        for h in hits:
            block = f"### {h.title} (`{h.memory_id}`)\n{h.excerpt}"
            if used + len(block) > budget_chars:
                break
            parts.append(block)
            used += len(block)
            memory_ids.append(h.memory_id)
            summaries.append(
                {"id": h.memory_id, "title": h.title, "score": h.score}
            )

        retrieval_log_id = None
        if memory_ids:
            retrieval_log_id = self._log_retrieval(query, memory_ids, session_id)
            if mark_used:
                for mid in memory_ids:
                    self.index.adjust_score(mid, +0.5)

        context = "\n\n".join(parts) if parts else ""
        if hits:
            context = "## Relevant Memories\n\n" + context

        return ContextResult(
            context=context,
            total_tokens=_est_tokens(context),
            memory_ids=memory_ids,
            memory_summaries=summaries,
            retrieval_log_id=retrieval_log_id,
        )

    def _log_retrieval(self, query: str, surfaced: list[str], session_id: str) -> str:
        rid = str(uuid.uuid4())
        try:
            self.store.nova_dir.mkdir(exist_ok=True)
            with self._retrievals_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "id": rid,
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "query": query[:500],
                    "session_id": session_id,
                    "surfaced": surfaced,
                }) + "\n")
        except OSError:
            log.warning("okf retrieval log write failed", exc_info=True)
        return rid

    # ── feedback ─────────────────────────────────────────────────────────

    async def mark_used(
        self,
        retrieval_log_id: str,
        used_ids: list[str],
        *,
        tenant_id: str | None = None,
    ) -> None:
        for mid in used_ids:
            self.index.adjust_score(mid, +1.0)

    async def feedback(
        self,
        memory_id: str,
        outcome_score: float,
        *,
        tenant_id: str | None = None,
    ) -> None:
        # outcome_score ∈ [−1, 1] maps directly onto the index accumulator.
        self.index.adjust_score(memory_id, outcome_score)

    # ── provenance / explain / stats ─────────────────────────────────────

    async def provenance(self, memory_id: str) -> dict[str, Any]:
        doc = self.store.read(memory_id)
        if doc is None:
            return {"memory_id": memory_id, "error": "not found"}
        fm, _body = doc
        known = {"type", "title", "description", "tags", "timestamp", "resource"}
        return {
            "memory_id": memory_id,
            "source_kind": fm.get("nova_source_kind"),
            "source_id": fm.get("nova_source_id"),
            "uri": fm.get("resource"),
            "title": fm.get("title"),
            "trust_score": fm.get("nova_trust"),
            "created_at": fm.get("timestamp"),
            "metadata": {
                k: v for k, v in fm.items()
                if k not in known and not k.startswith("nova_")
            } | {"type": fm.get("type")},
        }

    async def read_item(self, memory_id: str) -> dict[str, Any] | None:
        doc = self.store.read(memory_id)
        if doc is None:
            return None
        fm, body = doc
        return {
            "memory_id": memory_id,
            "title": fm.get("title") or memory_id,
            "type": fm.get("type"),
            "frontmatter": fm,
            "content": body,
        }

    async def explain(self, memory_id: str, query: str) -> dict[str, Any]:
        from .index import tokenize

        doc = self.store.read(memory_id)
        if doc is None:
            return {"memory_id": memory_id, "explanation": "not found",
                    "matched_fragments": []}
        excerpt = self.index._excerpt(memory_id, tokenize(query))
        return {
            "memory_id": memory_id,
            "explanation": f"BM25 keyword match in {memory_id}",
            "matched_fragments": [excerpt] if excerpt else [],
        }

    async def stats(self) -> dict[str, Any]:
        files = self.store.concept_files()
        last = None
        links = 0
        for p in files:
            try:
                mtime = p.stat().st_mtime
                if last is None or mtime > last:
                    last = mtime
            except OSError:
                continue
        try:
            for p in files:
                _fm, body = self.store.read(self.store.rel(p)) or ({}, "")
                links += len(extract_links(body))
        except Exception:
            pass
        return {
            "provider_name": self.name,
            "total_items": len(files),
            "total_edges": links,
            "last_ingestion": (
                datetime.fromtimestamp(last, tz=timezone.utc).isoformat() if last else None
            ),
            "capabilities": ["markdown", "okf", "bm25", "human_editable", "git_trackable"],
            "bundle_path": str(self.store.root),
        }

    # ── maintenance ──────────────────────────────────────────────────────

    async def reindex(self) -> dict[str, Any]:
        changed = self.index.refresh(full=True)
        return {"status": "ok", "backend": self.name, "reindexed": changed}

    async def consolidate(self) -> dict[str, Any]:
        """Journal retention backstop: archive journal files older than the
        retention window. Distillation into topics/ is the nightly curation
        goal's job (LLM-driven); this only prevents unbounded growth."""
        retention_days = settings.okf_journal_retention_days
        journal_dir = self.store.root / "journal"
        archive_dir = journal_dir / "archive"
        moved = 0
        if journal_dir.exists():
            cutoff = datetime.now(timezone.utc).timestamp() - retention_days * 86400
            for p in sorted(journal_dir.glob("*.md")):
                if p.name == "index.md":
                    continue
                try:
                    if p.stat().st_mtime < cutoff:
                        archive_dir.mkdir(exist_ok=True)
                        p.rename(archive_dir / p.name)
                        moved += 1
                except OSError:
                    continue
        if moved:
            self.index.refresh(full=True)
        return {"status": "ok", "backend": self.name, "journals_archived": moved}
