"""
Memory backend interface — the contract every storage implementation satisfies.

The memory-service owns a single neutral HTTP surface (/api/v1/memory/*,
see app/memory_router.py) and a single ingestion-queue consumer. Both
dispatch through a MemoryBackend resolved at request time by the factory
in app/backends/__init__.py, so producers and the orchestrator never know
which storage engine is active.

Required operations: write, context, mark_used, feedback, provenance, stats.
Optional: explain, consolidate, reindex — backends without a meaningful
implementation inherit the default no-op.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class WriteResult:
    items_created: int = 0
    items_updated: int = 0
    item_ids: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ContextResult:
    context: str = ""
    total_tokens: int = 0
    memory_ids: list[str] = field(default_factory=list)
    memory_summaries: list[dict] = field(default_factory=list)
    retrieval_log_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class MemoryBackend(ABC):
    """One storage engine behind the neutral memory API."""

    #: short identifier used in config (`memory.backend`) and stats
    name: str = "abstract"

    # ── Required ─────────────────────────────────────────────────────────

    @abstractmethod
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
        """Store new information. Called by both the queue consumer and
        the /ingest endpoint."""

    @abstractmethod
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
        """Retrieve formatted context for a query (the main read path)."""

    @abstractmethod
    async def mark_used(
        self,
        retrieval_log_id: str,
        used_ids: list[str],
        *,
        tenant_id: str | None = None,
    ) -> None:
        """Post-hoc usage feedback for a prior retrieval (inject mode)."""

    @abstractmethod
    async def feedback(
        self,
        memory_id: str,
        outcome_score: float,
        *,
        tenant_id: str | None = None,
    ) -> None:
        """Outcome feedback for a single item — adjusts future ranking."""

    @abstractmethod
    async def provenance(self, memory_id: str) -> dict[str, Any]:
        """Source record for a memory_id (where/when/who/trust)."""

    @abstractmethod
    async def stats(self) -> dict[str, Any]:
        """Provider stats; must include provider_name and total_items."""

    # ── Optional ─────────────────────────────────────────────────────────

    async def read_item(self, memory_id: str) -> dict[str, Any] | None:
        """Full content of one memory item (None if missing). Used by the
        agent's read tools when an excerpt isn't enough."""
        return None

    async def delete(self, memory_id: str) -> bool:
        """Delete one memory item (False if missing). Used by benchmark
        teardown so seeded test memories don't pollute the store.
        Default: unsupported."""
        raise NotImplementedError

    async def update_item(
        self,
        memory_id: str,
        *,
        frontmatter: dict[str, Any] | None = None,
        content: str | None = None,
    ) -> dict[str, Any] | None:
        """Replace fields/body of one item (None if missing). Powers the
        Brain page's Edit flow. Default: unsupported."""
        raise NotImplementedError

    async def graph(self) -> dict[str, Any]:
        """{nodes, edges} of the whole store for graph visualizations.
        Nodes carry id/title/type/tags/trust/degree; edges are index pairs.
        Default: unsupported."""
        raise NotImplementedError

    async def explain(self, memory_id: str, query: str) -> dict[str, Any]:
        """Why did this memory match? Default: unsupported."""
        return {
            "memory_id": memory_id,
            "explanation": f"backend '{self.name}' does not support explain",
            "matched_fragments": [],
        }

    async def consolidate(self) -> dict[str, Any]:
        """Background maintenance cycle. Default: no-op."""
        return {"status": "noop", "backend": self.name}

    async def reindex(self) -> dict[str, Any]:
        """Rebuild retrieval indices. Default: no-op."""
        return {"status": "noop", "backend": self.name}
