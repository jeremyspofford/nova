"""
Working Memory Gate — Phase 3 of the Engram Network.

Actively curates the LLM context window every turn. The context window
is a managed workspace ("desk"), not a FIFO transcript. Items are either
present in full or absent — no summarization mush.

Slot types: pinned (self-model, goal), sticky (key decisions),
refreshed (memories from activation), sliding (recent conversation),
expiring (open threads).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from app.config import settings
from app.embedding import get_embedding
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .activation import ActivatedEngram, spreading_activation
from .neural_router.serve import get_cached_model, neural_rerank
from .reconstruction import get_self_model_summary, reconstruct
from .retrieval_logger import log_retrieval

log = logging.getLogger(__name__)


# Retention weights for scoring
RETENTION_WEIGHTS = {
    "pinned": 10.0,
    "sticky": 5.0,
    "refreshed": 1.0,
    "sliding": 0.5,
    "expiring": 0.3,
}


@dataclass
class WorkingMemorySlot:
    slot_type: str  # pinned, sticky, refreshed, sliding, expiring
    content: str
    relevance_score: float = 1.0
    token_count: int = 0
    engram_id: str | None = None
    turn_added: int = 0
    turn_last_relevant: int = 0


@dataclass
class WorkingMemoryContext:
    """The assembled context window — ready for prompt injection."""

    self_model: str = ""
    active_goal: str = ""
    memories: str = ""
    key_decisions: str = ""
    open_threads: str = ""
    total_tokens: int = 0
    engram_ids: list[str] = field(default_factory=list)
    engram_summaries: list[dict] = field(default_factory=list)
    retrieval_log_id: str | None = None


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: 1 token ≈ 4 characters."""
    return len(text) // 4


async def assemble_context(
    session: AsyncSession,
    query: str,
    session_id: str = "",
    current_turn: int = 0,
    depth: str = "standard",
    tenant_id: str = "00000000-0000-0000-0000-000000000001",
) -> WorkingMemoryContext:
    """Full working memory assembly: activate → reconstruct → gate → context.

    This is the main entry point called by the orchestrator via
    POST /api/v1/engrams/context. tenant_id threads through activation +
    retrieval logging so a second tenant's data never seeds another tenant's
    context (FC-001). Self-model, active goal, sticky decisions, open threads
    are not yet tenant-filtered — Phase 3 cleanup.
    """
    ctx = WorkingMemoryContext()

    # 1. Self-model (pinned — always present)
    self_model = await get_self_model_summary(session)
    ctx.self_model = self_model
    ctx.total_tokens += _estimate_tokens(self_model)

    # 2. Active goal (pinned — if any)
    goal = await _get_active_goal(session)
    if goal:
        ctx.active_goal = goal
        ctx.total_tokens += _estimate_tokens(goal)

    # 3. Spreading activation on the query
    # Widen the funnel when a neural router model is loaded
    model, _ = get_cached_model()
    if model is not None:
        seed_count = settings.neural_router_seed_count
        max_results = settings.neural_router_candidate_count
    else:
        seed_count = None  # use defaults
        max_results = None

    activated = await spreading_activation(
        session,
        query,
        seed_count=seed_count,
        max_results=max_results,
        depth=depth,
        tenant_id=tenant_id,
    )

    # Compute query embedding once per turn (P9 fix: reuse downstream in line 211)
    query_embedding = await get_embedding(query, session) if activated else None

    # 3b. Neural re-ranking (if model loaded)
    if activated and model is not None:
        # Before neural reranking, exclude index-node types
        rerank_candidates = [a for a in activated if a.type not in ("topic",)]

        # Build temporal context for feature extraction
        now = datetime.now(timezone.utc)
        temporal_context = {
            "time_of_day": now.hour / 24 + now.minute / 1440,
            "day_of_week": now.strftime("%A"),
            "active_goal": goal,
        }

        # Convert ActivatedEngram to dicts for reranking
        candidate_dicts = []
        for e in rerank_candidates:
            candidate_dicts.append(
                {
                    "id": str(e.id),
                    "type": e.type,
                    "content": e.content,
                    "cosine_similarity": e.activation,
                    "importance": e.importance,
                    "activation": e.activation,
                    "last_accessed": None,
                    "convergence_paths": e.convergence_paths,
                    "outcome_avg": getattr(e, "outcome_avg", None),
                    "outcome_count": getattr(e, "outcome_count", 0),
                    "embedding": None,  # Not stored on ActivatedEngram
                    "final_score": e.final_score,
                    "source_type": e.source_type,
                    "confidence": getattr(e, "confidence", 0.5),
                    "access_count": getattr(e, "access_count", 0),
                }
            )

        reranked_dicts = neural_rerank(
            candidate_dicts,
            query_embedding=query_embedding,
            temporal_context=temporal_context,
            max_results=settings.engram_max_results,
        )

        # Add back excluded topic engrams (they skip reranking but are still included)
        topic_engrams = [a for a in activated if a.type in ("topic",)]
        topic_dicts = [
            {
                "id": str(e.id),
                "type": e.type,
                "content": e.content,
                "cosine_similarity": e.activation,
                "importance": e.importance,
                "activation": e.activation,
                "last_accessed": None,
                "convergence_paths": e.convergence_paths,
                "outcome_avg": getattr(e, "outcome_avg", None),
                "outcome_count": getattr(e, "outcome_count", 0),
                "embedding": None,
                "final_score": e.final_score,
                "source_type": e.source_type,
                "confidence": getattr(e, "confidence", 0.5),
                "access_count": getattr(e, "access_count", 0),
            }
            for e in topic_engrams
        ]
        reranked_dicts.extend(topic_dicts)

        # Convert back to ActivatedEngram for reconstruction
        activated = [
            ActivatedEngram(
                id=d["id"],
                type=d["type"],
                content=d["content"],
                activation=d["activation"],
                importance=d["importance"],
                confidence=d.get("confidence", 0.5),
                final_score=d["final_score"],
                convergence_paths=d.get("convergence_paths", 0),
                access_count=d.get("access_count", 0),
                source_type=d.get("source_type", "chat"),
            )
            for d in reranked_dicts
        ]

    # 3c. Log retrieval observation for Neural Router training
    if activated:
        try:
            log_id = await log_retrieval(
                session,
                query_embedding=query_embedding,
                query_text=query,
                engram_ids_surfaced=[str(e.id) for e in activated],
                session_id=session_id,
                active_goal=goal,
                tenant_id=tenant_id,
            )
            ctx.retrieval_log_id = log_id
        except Exception:
            log.debug("Failed to log retrieval observation", exc_info=True)

    # 4. Reconstruct memories from activated engrams
    if activated:
        # Topic engrams are index/cluster nodes — useful for activation graph
        # traversal but not for context injection. Exclude from reconstruction.
        content_engrams = [e for e in activated if e.type not in ("topic",)]

        # Interleave personal and non-personal engrams so budget truncation
        # doesn't drop all chat memories when intel dominates top scores
        personal = [
            e
            for e in content_engrams
            if e.source_type in ("chat", "consolidation", "self_reflection")
        ]
        other = [
            e
            for e in content_engrams
            if e.source_type not in ("chat", "consolidation", "self_reflection")
        ]
        interleaved: list = []
        for i in range(max(len(personal), len(other))):
            if i < len(personal):
                interleaved.append(personal[i])
            if i < len(other):
                interleaved.append(other[i])
        content_engrams = interleaved

        ctx.engram_ids = [str(e.id) for e in content_engrams]
        ctx.engram_summaries = [
            {
                "id": str(e.id),
                "type": e.type,
                "preview": e.content[:80].strip(),
                "source_type": e.source_type,
            }
            for e in content_engrams
        ]
        memory_text = await reconstruct(
            session,
            content_engrams,
            context=query,
            self_model_summary=self_model,
        )
        # Trim to memory budget
        budget = settings.engram_wm_memory_budget
        if _estimate_tokens(memory_text) > budget:
            memory_text = memory_text[: budget * 4]
        ctx.memories = memory_text
        ctx.total_tokens += _estimate_tokens(memory_text)

    # 5. Key decisions (sticky — from session state)
    decisions = await _get_sticky_decisions(session, session_id)
    if decisions:
        ctx.key_decisions = decisions
        ctx.total_tokens += _estimate_tokens(decisions)

    # 6. Open threads (expiring)
    threads = await _get_open_threads(session, session_id, current_turn)
    if threads:
        ctx.open_threads = threads
        ctx.total_tokens += _estimate_tokens(threads)

    return ctx


def format_context_prompt(ctx: WorkingMemoryContext) -> str:
    """Format the WorkingMemoryContext into a prompt-ready string.

    Order follows the spec:
    1. Self-model (pinned)
    2. Active goal (pinned)
    3. Reconstructed memories (refreshed)
    4. Key decisions (sticky)
    5. Open threads (expiring)
    """
    sections: list[str] = []

    if ctx.self_model:
        sections.append(f"## About Me\n{ctx.self_model}")

    if ctx.active_goal:
        sections.append(f"## Current Goal\n{ctx.active_goal}")

    if ctx.memories:
        sections.append(f"## Relevant Memories\n{ctx.memories}")

    if ctx.key_decisions:
        sections.append(f"## Key Decisions This Session\n{ctx.key_decisions}")

    if ctx.open_threads:
        sections.append(f"## Open Threads\n{ctx.open_threads}")

    return "\n\n".join(sections)


async def _get_active_goal(session: AsyncSession) -> str:
    """Get the most active goal engram."""
    result = await session.execute(
        text("""
            SELECT content FROM engrams
            WHERE type = 'goal'
              AND NOT superseded
              AND activation > 0.3
            ORDER BY activation DESC, importance DESC
            LIMIT 1
        """)
    )
    row = result.fetchone()
    return row.content if row else ""


async def _get_sticky_decisions(session: AsyncSession, session_id: str) -> str:
    """Get key decisions from the current session's working memory slots."""
    if not session_id:
        return ""
    result = await session.execute(
        text("""
            SELECT content FROM working_memory_slots
            WHERE session_id = :session_id
              AND slot_type = 'sticky'
            ORDER BY relevance_score DESC
        """),
        {"session_id": session_id},
    )
    rows = result.fetchall()
    if not rows:
        return ""
    return "\n".join(f"- {row.content}" for row in rows)


async def _get_open_threads(
    session: AsyncSession,
    session_id: str,
    current_turn: int,
) -> str:
    """Get expiring open threads that are still relevant."""
    if not session_id:
        return ""
    result = await session.execute(
        text("""
            SELECT content FROM working_memory_slots
            WHERE session_id = :session_id
              AND slot_type = 'expiring'
              AND (turn_last_relevant >= :min_turn OR turn_last_relevant = 0)
            ORDER BY relevance_score DESC
            LIMIT 5
        """),
        {"session_id": session_id, "min_turn": max(0, current_turn - 5)},
    )
    rows = result.fetchall()
    if not rows:
        return ""
    return "\n".join(f"- {row.content}" for row in rows)


async def add_sticky_decision(
    session: AsyncSession,
    session_id: str,
    content: str,
    turn: int = 0,
) -> None:
    """Pin a key decision to the working memory for this session."""
    await session.execute(
        text("""
            INSERT INTO working_memory_slots
                (session_id, slot_type, content, token_count, turn_added, turn_last_relevant)
            VALUES (:session_id, 'sticky', :content, :tokens, :turn, :turn)
        """),
        {
            "session_id": session_id,
            "content": content,
            "tokens": _estimate_tokens(content),
            "turn": turn,
        },
    )
