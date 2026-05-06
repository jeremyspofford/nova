"""
Engram ingestion worker — consumes raw events from Redis queue, decomposes
them into engrams, resolves entities, creates edges, and stores everything.

Runs as an asyncio background task on the engram:ingestion:queue.
Zero impact on chat latency — all processing is async background work.

Crash safety: uses BLMOVE (main → processing list) + LREM-after-success
pattern so a kill/OOM/container-restart during decomposition doesn't
vaporize the payload. On startup, any items still in the processing
list from a prior crashed run are pushed back to the main queue.
"""

from __future__ import annotations

import asyncio
import json
import logging
from uuid import UUID

from app.config import settings
from app.db.database import AsyncSessionLocal
from app.embedding import get_embedding, get_redis, to_pg_vector
from sqlalchemy import text

from .consolidation import notify_new_engrams
from .cortex_stimulus import emit_to_cortex
from .decomposition import decompose
from .entity_resolution import (
    find_contradiction_candidates,
    find_existing_entity,
    find_similar_engram,
    find_similar_engram_any_type,
    update_existing_engram,
)

log = logging.getLogger(__name__)

# Default tenant for single-instance Nova
DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"

# Concurrency limit for LLM decomposition calls (backpressure)
_decomposition_semaphore = asyncio.Semaphore(5)

# Suffix for the companion "processing" list that holds in-flight payloads
# so a mid-work crash doesn't lose them.
_PROCESSING_SUFFIX = ":processing"


def _processing_list_name() -> str:
    return settings.engram_ingestion_queue + _PROCESSING_SUFFIX


async def _recover_processing_list(redis) -> int:
    """On startup, push any orphaned in-flight payloads back to the main queue.
    These come from a prior worker that was killed before it could LREM them.
    Returns the number of payloads recovered."""
    processing = _processing_list_name()
    items = await redis.lrange(processing, 0, -1)
    if not items:
        return 0
    async with redis.pipeline(transaction=True) as pipe:
        for item in items:
            # Push to head so recovered items are handled FIRST (FIFO preservation
            # with BRPOP-style tail consumption).
            pipe.lpush(settings.engram_ingestion_queue, item)
        pipe.delete(processing)
        await pipe.execute()
    return len(items)


async def _process_event_guarded(
    payload_str: str,
    payload_raw,
    processing_list: str,
) -> None:
    """Run _process_event under the decomposition semaphore with error handling.
    Removes the payload from the processing list on completion (success or
    caught failure). Only uncaught crashes leave items behind for recovery."""
    redis = get_redis()
    try:
        async with _decomposition_semaphore:
            await _process_event(payload_str)
    except Exception:
        log.exception("Engram ingestion failed for event: %s", payload_str[:200])
    finally:
        # Even on failure, drop from processing — matches prior BRPOP behavior
        # where exceptions already discarded the payload. The reliability win
        # here is specifically around CRASHES, not logical failures.
        try:
            await redis.lrem(processing_list, 1, payload_raw)
        except Exception:
            log.warning("Failed to clear payload from processing list", exc_info=True)


from nova_contracts.feature_flags import register_flag

# B-Task 9: kill switch — pauses new engram decomposition. In-flight
# items still complete; the BLMOVE just becomes a no-op until the flag
# clears. Default off = ingestion runs.
KILL_INGESTION = register_flag(
    key="kill.engram.ingestion",
    type="bool",
    default=False,
    description="Pause new engram decomposition (memory-service).",
)


async def ingestion_loop() -> None:
    """Main ingestion loop — atomic BLMOVE from queue to processing list, then
    process each event. Startup recovers any orphaned in-flight payloads."""
    if not settings.engram_ingestion_enabled:
        log.info("Engram ingestion disabled")
        return

    redis = get_redis()
    queue = settings.engram_ingestion_queue
    processing = _processing_list_name()

    # Crash recovery: items left in the processing list are from a prior
    # worker that died before completing them.
    recovered = await _recover_processing_list(redis)
    if recovered:
        log.info(
            "Recovered %d orphaned ingestion payload(s) from processing list", recovered
        )

    log.info("Engram ingestion worker started (queue=%s)", queue)

    _last_kill_state = False
    while True:
        try:
            # Kill-switch check: items already moved to the processing list
            # complete normally; new payloads are deferred.
            if KILL_INGESTION.value():
                if not _last_kill_state:
                    log.warning(
                        "kill.engram.ingestion=True — new decomposition paused "
                        "(in-flight items still complete; queue continues to grow)"
                    )
                    _last_kill_state = True
                await asyncio.sleep(int(settings.engram_ingestion_batch_timeout) or 1)
                continue
            elif _last_kill_state:
                log.info("kill.engram.ingestion cleared — resuming decomposition")
                _last_kill_state = False

            # BLMOVE atomically pops the tail of the main queue and pushes it
            # to the head of the processing list. Returns None on timeout.
            payload_raw = await redis.blmove(
                queue,
                processing,
                int(settings.engram_ingestion_batch_timeout),
                src="RIGHT",
                dest="LEFT",
            )
            if payload_raw is None:
                continue

            # Keep the raw value for LREM (Redis matches by byte equality);
            # decode only for JSON parsing / downstream use.
            payload_str = (
                payload_raw.decode("utf-8")
                if isinstance(payload_raw, bytes)
                else payload_raw
            )

            try:
                json.loads(payload_str)
            except json.JSONDecodeError:
                log.warning(
                    "Malformed ingestion event (not valid JSON), dropping: %s",
                    payload_str[:200],
                )
                try:
                    await redis.lrem(processing, 1, payload_raw)
                except Exception:
                    log.warning(
                        "Failed to clear malformed payload from processing list",
                        exc_info=True,
                    )
                continue

            # Fire into background so the loop isn't blocked.
            # The semaphore inside _process_event_guarded gates
            # expensive LLM calls to at most 5 concurrent.
            asyncio.create_task(
                _process_event_guarded(payload_str, payload_raw, processing),
                name="engram-ingest",
            )

        except asyncio.CancelledError:
            log.info("Engram ingestion worker shutting down")
            break
        except Exception:
            log.exception("Engram ingestion error — will retry")
            await asyncio.sleep(1.0)


async def ingest_direct(
    raw_text: str,
    source_type: str = "chat",
    source_id: str | None = None,
    session_id: str | None = None,
    occurred_at: str | None = None,
    metadata: dict | None = None,
    tenant_id: str | None = None,
) -> dict:
    """Direct ingestion (bypasses queue). Used by the /engrams/ingest endpoint.

    Returns summary: {engrams_created, engrams_updated, edges_created, engram_ids}.
    """
    event = {
        "raw_text": raw_text,
        "source_type": source_type,
        "source_id": source_id,
        "session_id": session_id,
        "occurred_at": occurred_at,
        "metadata": metadata or {},
        "tenant_id": tenant_id,
    }
    return await _process_event(json.dumps(event))


def _map_source_type_to_kind(source_type: str) -> str:
    """Map IngestionSourceType values to SourceKind values."""
    mapping = {
        "chat": "chat",
        "intel": "intel_feed",
        "knowledge": "knowledge_crawl",
        "pipeline": "pipeline_extraction",
        "tool": "task_output",
        "consolidation": "consolidation",
        "cortex": "task_output",
        "journal": "manual_paste",
        "external": "knowledge_crawl",
        "screenpipe": "screenpipe",
        "self_reflection": "consolidation",
    }
    return mapping.get(source_type, "manual_paste")


async def _process_event(raw_payload: str) -> dict:
    """Process a single ingestion event: decompose → resolve → store → link."""
    event = json.loads(raw_payload)
    raw_text = event.get("raw_text", "")
    source_type = event.get("source_type", "chat")
    source_id = event.get("source_id")
    occurred_at_raw = event.get("occurred_at")
    # Parse ISO string to datetime — asyncpg requires datetime objects, not strings
    occurred_at = None
    if occurred_at_raw:
        from datetime import datetime, timezone

        try:
            occurred_at = datetime.fromisoformat(occurred_at_raw.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            occurred_at = datetime.now(timezone.utc)
    metadata = event.get("metadata", {})
    # FC-001 grace period: payloads enqueued before Phase 2 rolled out may not
    # carry tenant_id. Fall back to DEFAULT_TENANT with a WARN so we can spot
    # stragglers in prod logs. Phase 4 will reject missing tenant_id outright.
    tenant_id = event.get("tenant_id") or None
    if tenant_id is None:
        log.warning(
            "engram ingestion payload missing tenant_id — defaulting to %s",
            DEFAULT_TENANT,
        )
        tenant_id = DEFAULT_TENANT

    if not raw_text.strip():
        return {
            "engrams_created": 0,
            "engrams_updated": 0,
            "edges_created": 0,
            "engram_ids": [],
        }

    # Step 1: Decompose raw text into structured engrams
    decomposition = await decompose(raw_text, source_type=source_type)

    if not decomposition.engrams:
        log.debug("Decomposition produced no engrams for: %s", raw_text[:100])
        return {
            "engrams_created": 0,
            "engrams_updated": 0,
            "edges_created": 0,
            "engram_ids": [],
        }

    engrams_created = 0
    engrams_updated = 0
    edges_created = 0
    engram_ids: list[UUID] = []
    # Maps decomposition index → actual engram UUID (for edge creation)
    index_to_id: dict[int, UUID] = {}

    async with AsyncSessionLocal() as session:
        # ── Source provenance ─────────────────────────────────────────────────
        source_ref_id = None
        source_meta = {}
        trust = 0.7
        try:
            from .sources import DEFAULT_TRUST, find_or_create_source

            source_kind = _map_source_type_to_kind(source_type)
            source_uri = event.get("source_uri") or metadata.get("url")
            source_title = event.get("source_title") or metadata.get("feed_name")
            source_author = event.get("source_author") or metadata.get("author")
            trust_override = event.get("source_trust")

            source_ref_id = await find_or_create_source(
                session,
                source_kind=source_kind,
                title=source_title,
                uri=source_uri,
                content=raw_text,
                trust_score=trust_override if trust_override is not None else None,
                author=source_author,
                metadata=metadata,
                tenant_id=tenant_id,
            )
            source_meta = {
                k: v
                for k, v in {
                    "url": source_uri,
                    "title": source_title,
                    "author": source_author,
                    "feed_name": metadata.get("feed_name"),
                    "session_id": event.get("session_id"),
                }.items()
                if v
            }
            trust = (
                trust_override
                if trust_override is not None
                else DEFAULT_TRUST.get(source_kind, 0.7)
            )
        except Exception as exc:
            log.warning("Source creation failed (non-fatal): %s", exc)

        # Step 2: For each decomposed engram, resolve entities and store
        for i, decomposed in enumerate(decomposition.engrams):
            try:
                engram_id, was_new = await _store_or_update_engram(
                    session=session,
                    decomposed_type=decomposed.type.value
                    if hasattr(decomposed.type, "value")
                    else decomposed.type,
                    content=decomposed.content,
                    importance=decomposed.importance,
                    entities_referenced=decomposed.entities_referenced,
                    temporal=decomposed.temporal,
                    source_type=source_type,
                    source_id=source_id,
                    occurred_at=occurred_at,
                    metadata=metadata,
                    source_ref_id=source_ref_id,
                    source_meta=source_meta,
                    trust=trust,
                    temporal_validity=getattr(
                        decomposed, "temporal_validity", "unknown"
                    ),
                    tenant_id=tenant_id,
                )
                index_to_id[i] = engram_id
                engram_ids.append(engram_id)
                if was_new:
                    engrams_created += 1
                else:
                    engrams_updated += 1
            except Exception:
                log.exception(
                    "Failed to store engram %d: %s", i, decomposed.content[:80]
                )

        # Step 3: Create edges from decomposition relationships
        for rel in decomposition.relationships:
            try:
                src_id = index_to_id.get(rel.from_index)
                tgt_id = index_to_id.get(rel.to_index)
                if src_id and tgt_id and src_id != tgt_id:
                    created = await _create_edge(
                        session,
                        src_id,
                        tgt_id,
                        rel.relation.value
                        if hasattr(rel.relation, "value")
                        else rel.relation,
                        rel.strength,
                    )
                    if created:
                        edges_created += 1
            except Exception:
                log.warning("Failed to create relationship edge", exc_info=True)

        # Step 4: Create co-occurrence edges (sequential neighbors only, not O(n²) all-pairs)
        all_ids = list(index_to_id.values())
        for j in range(len(all_ids) - 1):
            if all_ids[j] != all_ids[j + 1]:
                try:
                    created = await _create_edge(
                        session,
                        all_ids[j],
                        all_ids[j + 1],
                        "related_to",
                        0.3,  # co-occurrence edges are weaker
                    )
                    if created:
                        edges_created += 1
                except Exception:
                    pass  # co-occurrence edges are best-effort

        # Step 5: Handle contradictions
        for contradiction in decomposition.contradictions:
            try:
                new_id = index_to_id.get(contradiction.new_index)
                if not new_id:
                    continue

                # Get embedding for the new engram to find contradiction candidates
                new_engram_content = decomposition.engrams[
                    contradiction.new_index
                ].content
                embedding = await get_embedding(new_engram_content, session)
                candidates = await find_contradiction_candidates(
                    session,
                    embedding,
                    contradiction.existing_content_hint,
                    tenant_id=tenant_id,
                )
                for candidate in candidates:
                    created = await _create_edge(
                        session,
                        new_id,
                        candidate["id"],
                        "contradicts",
                        0.8,
                    )
                    if created:
                        edges_created += 1
                        log.info(
                            "Contradiction edge: '%s' contradicts '%s'",
                            new_engram_content[:60],
                            candidate["content"][:60],
                        )
                        await emit_to_cortex(
                            "engram.contradiction",
                            {
                                "engram_id": str(new_id),
                                "conflicting_with": str(candidate["id"]),
                            },
                        )
            except Exception:
                log.warning("Failed to process contradiction", exc_info=True)

        # Generate source summary (non-fatal)
        if source_ref_id and len(raw_text) > 200:
            try:
                from .sources import generate_source_summary, update_source_summary

                summary = await generate_source_summary(raw_text)
                if summary:
                    await update_source_summary(session, source_ref_id, summary)
            except Exception as exc:
                log.warning("Source summarization failed (non-fatal): %s", exc)

        await session.commit()

    summary = {
        "engrams_created": engrams_created,
        "engrams_updated": engrams_updated,
        "edges_created": edges_created,
        "engram_ids": engram_ids,
    }
    log.info(
        "Ingested: %d created, %d updated, %d edges from: %s",
        engrams_created,
        engrams_updated,
        edges_created,
        raw_text[:80],
    )

    # Notify consolidation daemon about new engrams (threshold trigger)
    if engrams_created > 0:
        notify_new_engrams(engrams_created)

    return summary


async def _store_or_update_engram(
    session,
    decomposed_type: str,
    content: str,
    importance: float,
    entities_referenced: list[str],
    temporal: dict,
    source_type: str,
    source_id: str | None,
    occurred_at: str | None,
    metadata: dict,
    source_ref_id=None,
    source_meta=None,
    trust=0.8,
    temporal_validity: str = "unknown",
    tenant_id: str = DEFAULT_TENANT,
) -> tuple[UUID, bool]:
    """Store a new engram or update an existing one after entity resolution.

    Returns (engram_id, is_new).
    """
    # Entity resolution: check for existing matches. All dedup queries are
    # tenant-scoped so tenant A never collapses into tenant B's engrams (FC-001).
    existing = None

    if decomposed_type == "entity" and content:
        # Strategy 1: exact name match for entities
        existing = await find_existing_entity(session, content, tenant_id=tenant_id)

    # Always compute embedding — needed for dedup and INSERT
    embedding = await get_embedding(content, session)

    if not existing:
        # Strategy 2: embedding similarity for entity-type engrams
        if decomposed_type == "entity":
            existing = await find_similar_engram(
                session,
                embedding,
                decomposed_type,
                tenant_id=tenant_id,
            )

    if existing:
        # Update existing engram instead of creating duplicate
        await update_existing_engram(
            session,
            existing["id"],
            importance_boost=max(0, importance - existing["importance"]) * 0.5,
        )
        return existing["id"], False

    # Fact-level dedup: merge near-duplicate facts instead of creating duplicates
    if decomposed_type in ("fact", "episode", "procedure", "preference"):
        similar = await find_similar_engram(
            session,
            embedding,
            decomposed_type,
            threshold=settings.engram_fact_dedup_threshold,
            tenant_id=tenant_id,
        )
        if similar:
            await update_existing_engram(session, similar["id"], importance)
            log.debug("Fact dedup: merged into existing engram %s", similar["id"])
            # Preserve source linkage on the existing engram
            if source_ref_id:
                await _append_source_ref(session, similar["id"], source_ref_id)
            return similar["id"], False

    # Cross-type dedup: catch "Jeremy" as both fact and entity
    cross_match = await find_similar_engram_any_type(
        session,
        embedding,
        threshold=settings.engram_entity_similarity_threshold,  # 0.92
        tenant_id=tenant_id,
    )
    if cross_match:
        await update_existing_engram(
            session,
            cross_match["id"],
            importance_boost=max(0, importance - cross_match["importance"]) * 0.3,
        )
        log.debug(
            "Cross-type dedup: merged %s into existing %s engram %s",
            decomposed_type,
            cross_match["type"],
            cross_match["id"],
        )
        if source_ref_id:
            await _append_source_ref(session, cross_match["id"], source_ref_id)
        return cross_match["id"], False

    # Create new engram
    fragments = {
        "entities_referenced": entities_referenced,
        **({"temporal": temporal} if temporal else {}),
    }

    # Validate source_id as UUID — set to None if not valid
    valid_source_id = None
    if source_id:
        try:
            UUID(source_id)
            valid_source_id = source_id
        except (ValueError, AttributeError):
            pass

    result = await session.execute(
        text("""
            INSERT INTO engrams (
                type, content, fragments, embedding, embedding_model,
                occurred_at, importance, source_type, source_id,
                confidence, tenant_id, source_ref_id, source_meta,
                temporal_validity
            ) VALUES (
                :type, :content, CAST(:fragments AS jsonb),
                CAST(:embedding AS halfvec), :embedding_model,
                CAST(:occurred_at AS timestamptz), :importance,
                :source_type, CAST(:source_id AS uuid),
                :confidence, CAST(:tenant_id AS uuid),
                :source_ref_id, CAST(:source_meta AS jsonb),
                :temporal_validity
            )
            RETURNING id
        """),
        {
            "type": decomposed_type,
            "content": content,
            "fragments": json.dumps(fragments),
            "embedding": to_pg_vector(embedding),
            "embedding_model": settings.embedding_model,
            "occurred_at": occurred_at,
            "importance": importance,
            "source_type": source_type,
            "source_id": valid_source_id,
            "confidence": trust,
            "tenant_id": tenant_id,
            "source_ref_id": source_ref_id,
            "source_meta": json.dumps(source_meta or {}),
            "temporal_validity": temporal_validity,
        },
    )
    row = result.fetchone()

    # Create edges from this engram to existing entities it references
    for entity_name in entities_referenced:
        try:
            entity_match = await find_existing_entity(
                session, entity_name, tenant_id=tenant_id
            )
            if entity_match and entity_match["id"] != row.id:
                await _create_edge(
                    session, row.id, entity_match["id"], "related_to", 0.5
                )
        except Exception:
            pass  # entity linking is best-effort

    return row.id, True


async def _append_source_ref(session, engram_id, source_ref_id) -> None:
    """Append a source reference to an existing engram's source_meta."""
    await session.execute(
        text("""
            UPDATE engrams
            SET source_meta = jsonb_set(
                COALESCE(source_meta, '{}'),
                '{additional_sources}',
                COALESCE(source_meta->'additional_sources', '[]'::jsonb) || to_jsonb(:ref::text)
            )
            WHERE id = CAST(:id AS uuid)
        """),
        {"id": str(engram_id), "ref": str(source_ref_id)},
    )


async def _create_edge(
    session,
    source_id: UUID,
    target_id: UUID,
    relation: str,
    weight: float,
) -> bool:
    """Create or strengthen an edge between two engrams.

    Uses ON CONFLICT to increment co_activations and update weight
    if the edge already exists. Returns True if a new edge was created.
    """
    result = await session.execute(
        text("""
            INSERT INTO engram_edges (source_id, target_id, relation, weight)
            VALUES (CAST(:src AS uuid), CAST(:tgt AS uuid), :relation, :weight)
            ON CONFLICT (source_id, target_id, relation) DO UPDATE SET
                co_activations = engram_edges.co_activations + 1,
                weight = LEAST(1.0, engram_edges.weight + 0.05),
                last_co_activated = NOW()
            RETURNING (xmax = 0) AS is_new
        """),
        {
            "src": str(source_id),
            "tgt": str(target_id),
            "relation": relation,
            "weight": weight,
        },
    )
    row = result.fetchone()
    return row.is_new if row else False
