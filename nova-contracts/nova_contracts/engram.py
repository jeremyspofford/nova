"""
Engram Network contracts — the graph memory API contract.

Engrams are atomic units of memory in a self-organizing neural graph.
This module defines the types used for ingestion, storage, and querying.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class EngramType(str, Enum):
    fact = "fact"
    episode = "episode"
    entity = "entity"
    preference = "preference"
    procedure = "procedure"
    schema_ = "schema"
    goal = "goal"
    self_model = "self_model"
    topic = "topic"


class EdgeRelation(str, Enum):
    caused_by = "caused_by"
    related_to = "related_to"
    contradicts = "contradicts"
    preceded = "preceded"
    enables = "enables"
    part_of = "part_of"
    instance_of = "instance_of"
    analogous_to = "analogous_to"


class IngestionSourceType(str, Enum):
    chat = "chat"
    pipeline = "pipeline"
    tool = "tool"
    consolidation = "consolidation"
    cortex = "cortex"
    journal = "journal"
    external = "external"
    self_reflection = "self_reflection"


class SourceKind(str, Enum):
    chat = "chat"
    intel_feed = "intel_feed"
    knowledge_crawl = "knowledge_crawl"
    manual_paste = "manual_paste"
    task_output = "task_output"
    pipeline_extraction = "pipeline_extraction"
    consolidation = "consolidation"
    api_response = "api_response"

class TemporalValidity(str, Enum):
    permanent = "permanent"
    dated = "dated"
    seasonal = "seasonal"
    unknown = "unknown"


class SourceCreate(BaseModel):
    """Payload for creating a new source record."""
    source_kind: SourceKind
    title: str | None = None
    uri: str | None = None
    content: str | None = None
    content_hash: str | None = None
    trust_score: float = 0.7
    author: str | None = None
    published_at: datetime | None = None
    completeness: str = "complete"
    coverage_notes: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SourceDetail(BaseModel):
    """Full source record returned by API."""
    id: UUID
    source_kind: SourceKind
    title: str | None = None
    uri: str | None = None
    summary: str | None = None
    section_summaries: list[dict[str, str]] | None = None
    trust_score: float
    verified_at: datetime | None = None
    stale: bool = False
    completeness: str = "complete"
    coverage_notes: str | None = None
    author: str | None = None
    published_at: datetime | None = None
    ingested_at: datetime
    metadata: dict[str, Any] = Field(default_factory=dict)
    engram_count: int = 0


class SourceSummary(BaseModel):
    """Lightweight source reference for domain awareness."""
    id: UUID
    source_kind: SourceKind
    title: str | None = None
    summary: str | None = None
    trust_score: float
    engram_count: int = 0


# ── Queue payload ────────────────────────────────────────────────────────────


class IngestionEvent(BaseModel):
    """Payload pushed to the memory:ingestion:queue Redis list."""
    raw_text: str
    source_type: IngestionSourceType = IngestionSourceType.chat
    source_id: UUID | None = None
    session_id: UUID | None = None
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: dict[str, Any] = Field(default_factory=dict)
    # Source provenance (new)
    source_uri: str | None = None
    source_title: str | None = None
    source_author: str | None = None
    source_trust: float | None = None
    # Multi-tenant isolation (FC-001). None = caller didn't set it; memory-service
    # treats that as the default tenant with a WARNING log during Phase 1-3
    # rollout, then becomes a strict 400 in Phase 4.
    tenant_id: UUID | None = None


# ── Decomposition output (structured LLM response) ──────────────────────────


class DecomposedEngram(BaseModel):
    """A single engram extracted by the decomposition LLM."""
    type: EngramType
    content: str
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    entities_referenced: list[str] = Field(default_factory=list)
    temporal: dict[str, Any] = Field(default_factory=dict)
    temporal_validity: str = "unknown"  # permanent, dated, unknown


class DecomposedRelationship(BaseModel):
    """A relationship between two engrams in the decomposition output."""
    from_index: int
    to_index: int
    relation: EdgeRelation
    strength: float = Field(default=0.5, ge=0.0, le=1.0)


class DecomposedContradiction(BaseModel):
    """A contradiction detected between a new engram and an existing one."""
    new_index: int
    existing_content_hint: str


class DecompositionResult(BaseModel):
    """Full structured output from the decomposition LLM."""
    engrams: list[DecomposedEngram] = Field(default_factory=list)
    relationships: list[DecomposedRelationship] = Field(default_factory=list)
    contradictions: list[DecomposedContradiction] = Field(default_factory=list)


# ── API request/response models ─────────────────────────────────────────────


class IngestRequest(BaseModel):
    """Direct ingestion request (bypasses queue)."""
    raw_text: str
    source_type: IngestionSourceType = IngestionSourceType.chat
    source_id: UUID | None = None
    session_id: UUID | None = None
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: dict[str, Any] = Field(default_factory=dict)
    # Multi-tenant isolation (FC-001) — see IngestionEvent.tenant_id.
    tenant_id: UUID | None = None


class ContextRequest(BaseModel):
    """Working-memory context assembly request (POST /engrams/context)."""
    query: str
    session_id: str = ""
    current_turn: int = 0
    depth: str = "standard"
    tenant_id: UUID | None = None


class ActivateRequest(BaseModel):
    """Spreading-activation request (POST /engrams/activate)."""
    query: str
    seed_count: int | None = None
    max_hops: int | None = None
    max_results: int | None = None
    depth: str = "standard"
    tenant_id: UUID | None = None


class MarkUsedRequest(BaseModel):
    """Feedback request: which surfaced engrams did the LLM actually cite."""
    retrieval_log_id: str
    engram_ids_used: list[str]
    tenant_id: UUID | None = None


class IngestResponse(BaseModel):
    engrams_created: int
    engrams_updated: int
    edges_created: int
    engram_ids: list[UUID]


class EngramDetail(BaseModel):
    """Full engram detail for API responses."""
    id: UUID
    type: EngramType
    content: str
    importance: float
    activation: float
    confidence: float
    access_count: int
    source_type: IngestionSourceType
    source_id: UUID | None = None
    superseded: bool = False
    created_at: datetime
    updated_at: datetime
    source_ref_id: UUID | None = None
    source_meta: dict[str, Any] = Field(default_factory=dict)
    temporal_validity: str = "unknown"
    valid_as_of: datetime | None = None
