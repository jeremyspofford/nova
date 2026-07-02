"""
Memory Provider Interface contracts — the abstract contract for any memory system.

Any service implementing endpoints that accept/return these types
is a valid drop-in memory provider for Nova's orchestrator. The neutral
HTTP surface lives at /api/v1/memory/* on the memory-service; backends
(engram graph, OKF markdown bundle, external providers) plug in behind it.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

# ── Context retrieval ────────────────────────────────────────────────────────


class ContextRequest(BaseModel):
    """Request to retrieve relevant context for a query."""
    query: str
    session_id: str = ""
    current_turn: int = 0
    depth: str = "standard"  # shallow, standard, deep
    query_embedding: list[float] | None = None  # Optional pre-computed embedding for fair benchmarking
    max_results: int = 20
    tenant_id: str | None = None
    # When true, the backend records surfaced items as used at retrieval time.
    # Set by agent-driven tool retrievals (the agent explicitly asking IS the
    # usage signal); inject-mode retrievals leave this false and send feedback
    # post-hoc via FeedbackRequest.
    mark_used: bool = False


class ContextResponse(BaseModel):
    """Response from a memory provider's context retrieval."""
    context: str  # Formatted text ready for LLM injection
    total_tokens: int
    memory_ids: list[str] = Field(default_factory=list)  # Provider-specific item IDs
    retrieval_log_id: str | None = None  # For feedback loop
    metadata: dict[str, Any] = Field(default_factory=dict)  # Provider-specific data


# ── Ingestion ────────────────────────────────────────────────────────────────


class MemoryIngestRequest(BaseModel):
    """Request to store new information in the memory system."""
    raw_text: str
    source_type: str = "chat"
    source_id: str | None = None
    session_id: str | None = None
    occurred_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    tenant_id: str | None = None


class MemoryIngestResponse(BaseModel):
    """Response from memory ingestion."""
    items_created: int
    items_updated: int
    item_ids: list[str] = Field(default_factory=list)


# ── Feedback ─────────────────────────────────────────────────────────────────


class MarkUsedRequest(BaseModel):
    """Feedback on which retrieved items were actually used."""
    retrieval_log_id: str
    used_ids: list[str]
    session_id: str = ""
    tenant_id: str | None = None


class FeedbackRequest(BaseModel):
    """Outcome feedback for a memory item — adjusts future ranking."""
    memory_id: str
    outcome_score: float = Field(ge=-1.0, le=1.0)  # −1 bad … +1 good
    session_id: str = ""
    tenant_id: str | None = None


# ── Provenance / explainability ──────────────────────────────────────────────


class ProvenanceResponse(BaseModel):
    """Where a memory came from: source record for a memory_id."""
    memory_id: str
    source_kind: str | None = None  # chat, intel_feed, knowledge_crawl, ...
    source_id: str | None = None
    uri: str | None = None
    title: str | None = None
    author: str | None = None
    trust_score: float | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ExplainRequest(BaseModel):
    """Ask a backend why a memory matched a query."""
    memory_id: str
    query: str
    tenant_id: str | None = None


class ExplainResponse(BaseModel):
    """Reasoning trace — engram: activation path; markdown: matching lines."""
    memory_id: str
    explanation: str
    matched_fragments: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


# ── Provider stats ───────────────────────────────────────────────────────────


class ProviderStats(BaseModel):
    """Health and metrics from a memory provider."""
    provider_name: str
    provider_version: str = "0.1.0"
    total_items: int = 0
    total_edges: int = 0  # 0 for non-graph providers
    last_ingestion: datetime | None = None
    capabilities: list[str] = Field(default_factory=list)  # e.g., ["graph_traversal", "consolidation", "neural_reranking"]
    metadata: dict[str, Any] = Field(default_factory=dict)
