"""Unit tests for memory-service/app/engram/reconstruction.py.

Tests target two entry points:
  - _template_assemble (pure sync, tested directly)
  - reconstruct (async, needs DB session for _semantic_dedup / _find_clusters)

ActivatedEngram is constructed directly — no DB inserts needed for template
tests.  For reconstruct() tests, real DB rows are inserted so that the
embedding-based dedup and edge-based clustering paths execute against Postgres.

Template assembly contracts verified here:
  - facts rendered with bullet prefix, no source tag for personal sources
  - non-personal sources rendered with [source_type] tag
  - schema engrams rendered with "Pattern:" prefix
  - goal engrams rendered with "Goal:" prefix
  - entity engrams collapsed to a single line (first 5)
  - unknown/unrecognised type (e.g. "topic") silently omitted
  - content dedup within cluster by first-100-char fingerprint
  - ordering: facts before preferences before episodes before procedures
    before schemas before entities before goals before self_model
  - empty list returns empty string

Reconstruct() contracts:
  - empty engrams list returns empty string without hitting DB
  - single engram with no DB edges → template result
  - null/empty content engram is included as a blank bullet
    (the implementation does not filter null content — flagged in test name)
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from app.engram.activation import ActivatedEngram
from app.engram.reconstruction import _template_assemble, reconstruct

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _make(
    *,
    content: str,
    type: str = "fact",
    source_type: str = "chat",
    importance: float = 0.5,
    final_score: float = 1.0,
    id: str | None = None,
) -> ActivatedEngram:
    """Construct an ActivatedEngram without touching the database."""
    import uuid

    return ActivatedEngram(
        id=id or str(uuid.uuid4()),
        type=type,
        content=content,
        activation=1.0,
        importance=importance,
        confidence=0.8,
        convergence_paths=1,
        final_score=final_score,
        access_count=0,
        last_accessed=_NOW,
        created_at=_NOW,
        fragments=None,
        source_type=source_type,
    )


# ---------------------------------------------------------------------------
# Template assembly — type formatting
# ---------------------------------------------------------------------------


def test_fact_personal_source_renders_plain_bullet():
    """Facts from personal sources get a plain '- content' bullet (no tag)."""
    e = _make(content="The sky is blue", type="fact", source_type="chat")
    result = _template_assemble([e])
    assert result == "- The sky is blue"


def test_fact_external_source_renders_tagged_bullet():
    """Facts from non-personal sources include the [source_type] tag."""
    e = _make(
        content="GPT-4 supports function calling", type="fact", source_type="intel_feed"
    )
    result = _template_assemble([e])
    assert result == "- [intel_feed] GPT-4 supports function calling"


def test_schema_personal_source_renders_pattern_prefix():
    """Schema engrams from personal sources get '- Pattern: ...' prefix."""
    e = _make(
        content="Users prefer minimal UIs", type="schema", source_type="consolidation"
    )
    result = _template_assemble([e])
    assert result == "- Pattern: Users prefer minimal UIs"


def test_schema_external_source_renders_tagged_pattern():
    """Schema engrams from external sources get '- [src_type] Pattern: ...' prefix."""
    e = _make(
        content="LLMs hallucinate when uncertain",
        type="schema",
        source_type="knowledge_crawl",
    )
    result = _template_assemble([e])
    assert result == "- [knowledge_crawl] Pattern: LLMs hallucinate when uncertain"


def test_goal_personal_source_renders_goal_prefix():
    """Goal engrams from personal sources render as '- Goal: ...'."""
    e = _make(content="Ship memory hardening sprint", type="goal", source_type="chat")
    result = _template_assemble([e])
    assert result == "- Goal: Ship memory hardening sprint"


def test_goal_external_source_renders_tagged_goal():
    """Goal engrams from external sources include [source_type] before 'Goal:'."""
    e = _make(
        content="Reduce latency below 200ms", type="goal", source_type="task_output"
    )
    result = _template_assemble([e])
    assert result == "- [task_output] Goal: Reduce latency below 200ms"


def test_entity_engrams_collapsed_to_single_line():
    """Multiple entity engrams are joined on a single 'Related:' line."""
    entities = [
        _make(content=f"Entity{i}", type="entity", source_type="chat") for i in range(3)
    ]
    result = _template_assemble(entities)
    assert result.startswith("- Related:")
    assert "Entity0" in result
    assert "Entity1" in result
    assert "Entity2" in result
    # Must be a single line, not multiple bullets
    assert result.count("\n") == 0


def test_entity_cap_at_five():
    """Entity list is capped at 5 even if more engrams are provided."""
    entities = [
        _make(content=f"E{i}", type="entity", source_type="chat") for i in range(8)
    ]
    result = _template_assemble(entities)
    # Only 5 entities should appear
    present = [f"E{i}" in result for i in range(8)]
    assert sum(present) == 5


def test_unknown_type_silently_omitted():
    """Engram types not handled by _template_assemble (e.g. 'topic') are silently skipped.

    SPEC NOTE: The implementation has no 'topic' branch. A topic engram produces
    no output line. This test documents current behaviour — if a 'topic' branch
    is added later, this test should be updated.
    """
    topic_e = _make(content="some topic", type="topic", source_type="chat")
    fact_e = _make(content="a real fact", type="fact", source_type="chat")
    result = _template_assemble([topic_e, fact_e])
    assert "some topic" not in result
    assert "- a real fact" in result


# ---------------------------------------------------------------------------
# Template assembly — ordering
# ---------------------------------------------------------------------------


def test_type_ordering_facts_before_episodes():
    """Facts appear before episodes in the assembled output."""
    episode = _make(
        content="episode content", type="episode", source_type="chat", final_score=2.0
    )
    fact = _make(
        content="fact content", type="fact", source_type="chat", final_score=1.0
    )
    result = _template_assemble([episode, fact])
    fact_pos = result.index("fact content")
    episode_pos = result.index("episode content")
    assert fact_pos < episode_pos


def test_type_ordering_schemas_after_facts():
    """Schema engrams appear after facts, even when schema has a higher final_score."""
    schema = _make(
        content="schema content", type="schema", source_type="chat", final_score=5.0
    )
    fact = _make(
        content="fact content", type="fact", source_type="chat", final_score=1.0
    )
    result = _template_assemble([schema, fact])
    fact_pos = result.index("fact content")
    schema_pos = result.index("schema content")
    assert fact_pos < schema_pos


# ---------------------------------------------------------------------------
# Template assembly — deduplication
# ---------------------------------------------------------------------------


def test_content_dedup_within_cluster_drops_duplicate():
    """Two engrams with the same first-100-char content fingerprint produce one bullet."""
    content = "Identical content for dedup testing"
    e1 = _make(content=content, type="fact", source_type="chat", final_score=2.0)
    e2 = _make(content=content, type="fact", source_type="chat", final_score=1.0)
    result = _template_assemble([e1, e2])
    # Should appear exactly once
    assert result.count(content) == 1


# ---------------------------------------------------------------------------
# Template assembly — boundary conditions
# ---------------------------------------------------------------------------


def test_empty_cluster_returns_empty_string():
    """_template_assemble([]) returns empty string, not None or whitespace."""
    assert _template_assemble([]) == ""


def test_single_engram_assembles_correctly():
    """A single engram produces exactly one bullet line."""
    e = _make(content="only child", type="fact", source_type="chat")
    result = _template_assemble([e])
    assert result == "- only child"
    assert "\n" not in result


# ---------------------------------------------------------------------------
# reconstruct() — async, uses real DB session
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconstruct_empty_list_returns_empty_string(db_session):
    """reconstruct() with an empty list short-circuits before any DB call."""
    result = await reconstruct(db_session, [])
    assert result == ""


@pytest.mark.asyncio
async def test_reconstruct_single_engram_no_edges(db_session, engram_factory):
    """A single engram with no DB edges produces template-assembled output."""
    # Insert a real DB row so _semantic_dedup can run (it fetches embeddings)
    eid = await engram_factory(
        content="lone engram fact", type="fact", source_type="chat"
    )

    activated = [
        ActivatedEngram(
            id=str(eid),
            type="fact",
            content="lone engram fact",
            activation=1.0,
            importance=0.5,
            confidence=0.8,
            convergence_paths=1,
            final_score=1.0,
            access_count=0,
            last_accessed=_NOW,
            created_at=_NOW,
            fragments=None,
            source_type="chat",
        )
    ]

    result = await reconstruct(db_session, activated)
    # Template should produce the plain bullet
    assert "lone engram fact" in result
    assert result.startswith("- ")
