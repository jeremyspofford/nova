"""
Neutral memory API — /api/v1/memory/*.

Backend-agnostic surface the orchestrator (and any other consumer) talks
to. Requests dispatch through the backend factory ("okf" markdown bundle
is the built-in backend; external providers plug in via
memory.provider_url on the orchestrator side).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from nova_contracts.memory import (
    ContextRequest,
    ContextResponse,
    ExplainRequest,
    ExplainResponse,
    FeedbackRequest,
    MarkUsedRequest,
    MemoryIngestRequest,
    MemoryIngestResponse,
    ProviderStats,
)

from app.backends import current_backend_name, get_backend

log = logging.getLogger(__name__)

memory_router = APIRouter(prefix="/api/v1/memory", tags=["memory"])


@memory_router.post("/context", response_model=ContextResponse)
async def get_context(req: ContextRequest):
    """Main read path: formatted context for prompt assembly."""
    backend = await get_backend()
    result = await backend.context(
        req.query,
        session_id=req.session_id,
        current_turn=req.current_turn,
        depth=req.depth,
        tenant_id=req.tenant_id,
        mark_used=req.mark_used,
    )
    return ContextResponse(
        context=result.context,
        total_tokens=result.total_tokens,
        memory_ids=result.memory_ids,
        retrieval_log_id=result.retrieval_log_id,
        metadata={
            **result.metadata,
            "backend": backend.name,
            "memory_summaries": result.memory_summaries,
        },
    )


@memory_router.post("/ingest", response_model=MemoryIngestResponse, status_code=201)
async def ingest(req: MemoryIngestRequest):
    """Direct write (bypasses the ingestion queue)."""
    backend = await get_backend()
    result = await backend.write(
        req.raw_text,
        source_type=req.source_type,
        source_id=req.source_id,
        session_id=req.session_id,
        occurred_at=req.occurred_at.isoformat() if req.occurred_at else None,
        metadata=req.metadata,
        tenant_id=req.tenant_id,
    )
    return MemoryIngestResponse(
        items_created=result.items_created,
        items_updated=result.items_updated,
        item_ids=result.item_ids,
    )


@memory_router.post("/mark-used")
async def mark_used(req: MarkUsedRequest):
    """Post-hoc usage feedback for a prior retrieval (inject mode)."""
    backend = await get_backend()
    await backend.mark_used(
        req.retrieval_log_id, req.used_ids, tenant_id=req.tenant_id
    )
    return {"status": "ok"}


@memory_router.post("/feedback")
async def feedback(req: FeedbackRequest):
    """Outcome feedback for a single memory item."""
    backend = await get_backend()
    await backend.feedback(
        req.memory_id, req.outcome_score, tenant_id=req.tenant_id
    )
    return {"status": "ok"}


@memory_router.get("/provenance/{memory_id:path}")
async def provenance(memory_id: str):
    """Source record for a memory item.

    ``:path`` converter because OKF memory ids are bundle-relative paths
    (e.g. ``topics/inference-setup.md``).
    """
    backend = await get_backend()
    result = await backend.provenance(memory_id)
    if result.get("error") == "not found":
        raise HTTPException(status_code=404, detail=f"memory {memory_id} not found")
    return result


@memory_router.get("/item/{memory_id:path}")
async def read_item(memory_id: str):
    """Full content of one memory item (agent read tools)."""
    backend = await get_backend()
    result = await backend.read_item(memory_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"memory {memory_id} not found")
    return result


@memory_router.delete("/item/{memory_id:path}", status_code=204)
async def delete_item(memory_id: str):
    """Delete one memory item (benchmark teardown, curation)."""
    backend = await get_backend()
    try:
        deleted = await backend.delete(memory_id)
    except NotImplementedError:
        raise HTTPException(
            status_code=501, detail=f"backend '{backend.name}' does not support delete"
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not deleted:
        raise HTTPException(status_code=404, detail=f"memory {memory_id} not found")


@memory_router.post("/explain", response_model=ExplainResponse)
async def explain(req: ExplainRequest):
    """Why did this memory match the query? (optional per backend)"""
    backend = await get_backend()
    result = await backend.explain(req.memory_id, req.query)
    return ExplainResponse(
        memory_id=req.memory_id,
        explanation=result.get("explanation", ""),
        matched_fragments=result.get("matched_fragments", []),
        metadata={"backend": backend.name},
    )


@memory_router.get("/stats", response_model=ProviderStats)
async def stats():
    """Active backend name + counts."""
    backend = await get_backend()
    raw = await backend.stats()
    return ProviderStats(
        provider_name=raw.get("provider_name", backend.name),
        total_items=raw.get("total_items", 0),
        total_edges=raw.get("total_edges", 0),
        last_ingestion=raw.get("last_ingestion"),
        capabilities=raw.get("capabilities", []),
        metadata={k: v for k, v in raw.items()
                  if k not in ("provider_name", "total_items", "total_edges",
                               "last_ingestion", "capabilities")},
    )


@memory_router.post("/consolidate")
async def consolidate():
    """Trigger the backend's maintenance cycle (no-op for backends without one)."""
    backend = await get_backend()
    return await backend.consolidate()


@memory_router.post("/reindex")
async def reindex():
    """Rebuild retrieval indices (no-op for backends without one)."""
    backend = await get_backend()
    return await backend.reindex()


@memory_router.get("/backend")
async def active_backend():
    """Which backend is live right now (dashboard selector reads this)."""
    return {"backend": await current_backend_name()}
