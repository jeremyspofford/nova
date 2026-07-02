"""
Engram backend — adapter that satisfies MemoryBackend over the existing
engram graph code (ingestion, working-memory context assembly, retrieval
logging, outcome feedback, sources provenance).

This is a thin dispatch layer: all engram logic stays in app/engram/.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from app.db.database import get_db
from sqlalchemy import text

from .base import ContextResult, MemoryBackend, WriteResult

log = logging.getLogger(__name__)

DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"


class EngramBackend(MemoryBackend):
    name = "engram"

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
        from app.engram.ingestion import ingest_direct

        result = await ingest_direct(
            raw_text=raw_text,
            source_type=source_type,
            source_id=source_id,
            session_id=session_id,
            occurred_at=occurred_at,
            metadata=metadata,
            tenant_id=tenant_id or DEFAULT_TENANT,
        )
        return WriteResult(
            items_created=result.get("engrams_created", 0),
            items_updated=result.get("engrams_updated", 0),
            item_ids=result.get("engram_ids", []),
            metadata={"edges_created": result.get("edges_created", 0)},
        )

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
        from app.engram.retrieval_logger import mark_engrams_used
        from app.engram.working_memory import assemble_context, format_context_prompt

        async with get_db() as session:
            ctx = await assemble_context(
                session,
                query=query,
                session_id=session_id,
                current_turn=current_turn,
                depth=depth,
                tenant_id=tenant_id or DEFAULT_TENANT,
            )
            # Agent-driven retrieval: the agent explicitly asked, which IS the
            # usage signal — record it now instead of waiting for post-hoc
            # /feedback that tools-mode callers can't easily send.
            if mark_used and ctx.retrieval_log_id and ctx.engram_ids:
                try:
                    await mark_engrams_used(
                        session, ctx.retrieval_log_id, ctx.engram_ids
                    )
                    await session.commit()
                except Exception:
                    log.warning("mark_used-at-retrieval failed", exc_info=True)

        return ContextResult(
            context=format_context_prompt(ctx),
            total_tokens=ctx.total_tokens,
            memory_ids=ctx.engram_ids,
            memory_summaries=ctx.engram_summaries,
            retrieval_log_id=ctx.retrieval_log_id,
            metadata={
                "sections": {
                    "self_model": bool(ctx.self_model),
                    "active_goal": bool(ctx.active_goal),
                    "memories": bool(ctx.memories),
                    "key_decisions": bool(ctx.key_decisions),
                    "open_threads": bool(ctx.open_threads),
                }
            },
        )

    async def mark_used(
        self,
        retrieval_log_id: str,
        used_ids: list[str],
        *,
        tenant_id: str | None = None,
    ) -> None:
        from app.engram.retrieval_logger import mark_engrams_used

        tenant = tenant_id or DEFAULT_TENANT
        async with get_db() as session:
            owner = await session.execute(
                text("SELECT tenant_id FROM retrieval_log WHERE id = CAST(:id AS uuid)"),
                {"id": retrieval_log_id},
            )
            owner_tid = owner.scalar()
            if owner_tid is not None and str(owner_tid) != tenant:
                log.warning(
                    "mark_used: retrieval_log %s belongs to tenant %s, caller is %s — ignored",
                    retrieval_log_id, owner_tid, tenant,
                )
                return
            await mark_engrams_used(session, retrieval_log_id, used_ids)
            await session.commit()

    async def feedback(
        self,
        memory_id: str,
        outcome_score: float,
        *,
        tenant_id: str | None = None,
    ) -> None:
        from app.engram.outcome_feedback import process_feedback

        async with get_db() as session:
            await process_feedback(
                session,
                [{"engram_id": memory_id, "outcome_score": outcome_score, "task_type": "api"}],
            )
            await session.commit()

    async def provenance(self, memory_id: str) -> dict[str, Any]:
        from app.engram.sources import get_source

        async with get_db() as session:
            row = await session.execute(
                text("""
                    SELECT e.id, e.type, e.source_type, e.source_ref_id,
                           e.created_at, e.confidence
                    FROM engrams e WHERE e.id = CAST(:id AS uuid)
                """),
                {"id": memory_id},
            )
            engram = row.mappings().first()
            if engram is None:
                return {"memory_id": memory_id, "error": "not found"}

            out: dict[str, Any] = {
                "memory_id": memory_id,
                "source_kind": engram["source_type"],
                "created_at": engram["created_at"].isoformat()
                if engram["created_at"] else None,
                "metadata": {"engram_type": engram["type"],
                             "confidence": float(engram["confidence"] or 0)},
            }
            if engram["source_ref_id"]:
                source = await get_source(session, UUID(str(engram["source_ref_id"])))
                if source:
                    out.update({
                        "source_id": str(source.get("id")),
                        "source_kind": source.get("source_kind") or out["source_kind"],
                        "uri": source.get("uri"),
                        "title": source.get("title"),
                        "author": source.get("author"),
                        "trust_score": source.get("trust_score"),
                    })
            return out

    async def stats(self) -> dict[str, Any]:
        async with get_db() as session:
            total = (await session.execute(text("SELECT count(*) FROM engrams"))).scalar()
            edges = (await session.execute(text("SELECT count(*) FROM engram_edges"))).scalar()
            last = (await session.execute(
                text("SELECT max(created_at) FROM engrams")
            )).scalar()
        return {
            "provider_name": self.name,
            "total_items": total or 0,
            "total_edges": edges or 0,
            "last_ingestion": last.isoformat() if last else None,
            "capabilities": ["graph_traversal", "consolidation", "spreading_activation"],
        }

    async def explain(self, memory_id: str, query: str) -> dict[str, Any]:
        async with get_db() as session:
            row = await session.execute(
                text("""
                    SELECT content, activation, importance, access_count
                    FROM engrams WHERE id = CAST(:id AS uuid)
                """),
                {"id": memory_id},
            )
            m = row.mappings().first()
        if m is None:
            return {"memory_id": memory_id, "explanation": "not found",
                    "matched_fragments": []}
        return {
            "memory_id": memory_id,
            "explanation": (
                f"activation={float(m['activation']):.3f} "
                f"importance={float(m['importance']):.3f} "
                f"access_count={m['access_count']} — surfaced by cosine seed + "
                "spreading activation through weighted edges"
            ),
            "matched_fragments": [m["content"][:500]],
        }

    async def consolidate(self) -> dict[str, Any]:
        from app.engram.consolidation import run_consolidation

        return await run_consolidation(trigger="manual")

    async def reindex(self) -> dict[str, Any]:
        # Engram retrieval indices (HNSW, TSV) are maintained by Postgres.
        return {"status": "noop", "backend": self.name,
                "detail": "indices are DB-maintained"}
