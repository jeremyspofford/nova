"""
Consolidation daemon — Phase 4 of the Engram Network ("Sleep Cycle").

Transforms raw experience into lasting wisdom through six phases:
1. Replay & Review — walk through recent episodes
2. Pattern Extraction — promote recurring themes to schema engrams
3. Edge Strengthening — Hebbian learning (fire together, wire together)
4. Contradiction Resolution — resolve conflicting facts
5. Pruning & Merging — archive dead weight, merge near-duplicates
6. Self-Model Update — refresh identity from corrections and patterns

Triggers: idle (30+ min), nightly (3 AM), threshold (50+ new engrams).

PERF-003 phase 2 — LLM-heavy phases (2 pattern extraction, 2.5 topic
clustering) are gated by user activity: if the user chatted within the
configured idle window, those phases skip so Ollama can serve chat
without queue contention. Scheduled/nightly triggers bypass the gate.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone

from app.config import settings
from app.db.database import AsyncSessionLocal
from app.embedding import get_embedding, get_redis, to_pg_vector
from app.http_client import get_http_client
from sqlalchemy import text

from .cortex_stimulus import emit_to_cortex

log = logging.getLogger(__name__)

# Track state across consolidation cycles
_last_consolidation_at: float = 0.0
_engrams_since_last: int = 0
_consolidation_lock = asyncio.Lock()

# Redis key the orchestrator bumps on every chat turn (both services talk to db0).
_ACTIVITY_KEY = b"nova:activity:last_chat_turn"


async def _user_recently_active() -> bool:
    """True if a chat turn happened within the configured idle window.

    Reads the heartbeat the orchestrator writes on every run_agent_turn.
    Non-fatal on any error: returns False so consolidation never stalls
    because Redis had a hiccup."""
    try:
        idle_sec = settings.engram_consolidation_user_idle_minutes * 60
        if idle_sec <= 0:
            return False
        redis = get_redis()
        raw = await redis.get(_ACTIVITY_KEY)
        if not raw:
            return False
        ts = float(raw.decode() if isinstance(raw, bytes) else raw)
        return (time.time() - ts) < idle_sec
    except Exception:
        log.debug("Activity heartbeat read failed — assuming idle", exc_info=True)
        return False


from nova_contracts.feature_flags import register_flag

# B-Task 9: kill switch — pauses the sleep-cycle consolidation pipeline
# without restarting memory-service. Default off = consolidation runs.
KILL_CONSOLIDATION = register_flag(
    key="kill.consolidation.cycle",
    type="bool",
    default=False,
    description="Pause sleep-cycle consolidation (memory-service).",
)


async def consolidation_loop() -> None:
    """Background loop that triggers consolidation on idle/threshold/schedule."""
    if not settings.engram_consolidation_enabled:
        log.info("Engram consolidation disabled")
        return

    global _last_consolidation_at
    _last_consolidation_at = time.monotonic()
    log.info("Consolidation daemon started")

    _last_kill_state = False
    while True:
        try:
            await asyncio.sleep(60)  # Check every minute

            # Kill-switch check: an in-flight consolidation cycle finishes
            # to completion (mutex-guarded; no torn writes).
            if KILL_CONSOLIDATION.value():
                if not _last_kill_state:
                    log.warning(
                        "kill.consolidation.cycle=True — pausing cycle scheduler "
                        "(no triggers will fire until flag cleared)"
                    )
                    _last_kill_state = True
                continue
            elif _last_kill_state:
                log.info("kill.consolidation.cycle cleared — resuming cycle scheduler")
                _last_kill_state = False

            now_mono = time.monotonic()
            idle_minutes = (now_mono - _last_consolidation_at) / 60

            # Check triggers
            trigger = None
            if idle_minutes >= settings.engram_consolidation_idle_minutes:
                trigger = "idle"
            elif _engrams_since_last >= settings.engram_consolidation_threshold:
                trigger = "threshold"
            else:
                # Check nightly schedule
                now_utc = datetime.now(timezone.utc)
                if (
                    now_utc.hour == settings.engram_consolidation_nightly_hour
                    and idle_minutes >= 5
                ):  # Don't run nightly if recently consolidated
                    trigger = "scheduled"

            if trigger:
                await run_consolidation(trigger)
                _last_consolidation_at = time.monotonic()

        except asyncio.CancelledError:
            log.info("Consolidation daemon shutting down")
            break
        except Exception:
            log.exception("Consolidation check error — will retry")


def notify_new_engrams(count: int = 1) -> None:
    """Called by ingestion to track new engram count for threshold trigger."""
    global _engrams_since_last
    _engrams_since_last += count


async def run_consolidation(trigger: str = "manual") -> dict:
    """Run a full consolidation cycle. Returns summary stats.

    Uses a mutex to prevent concurrent consolidation cycles from corrupting data.
    Each phase is isolated — a failure in one phase doesn't kill the cycle.
    """
    global _engrams_since_last

    if _consolidation_lock.locked():
        log.info("Consolidation already running, skipping trigger=%s", trigger)
        return {"skipped": True, "reason": "already_running"}

    async with _consolidation_lock:
        start_time = time.monotonic()
        log.info("Consolidation starting (trigger=%s)", trigger)

        stats = {
            "engrams_reviewed": 0,
            "schemas_created": 0,
            "topics_created": 0,
            "edges_strengthened": 0,
            "edges_pruned": 0,
            "engrams_pruned": 0,
            "engrams_merged": 0,
            "contradictions_resolved": 0,
            "self_model_updates": {},
        }

        # Each phase now opens its own short-lived session and commits
        # independently. Previously the full 65–110s cycle held one session,
        # which starved chat on the shared connection pool. Per-phase
        # commits also make partial progress durable — if Phase 5 fails,
        # Phases 2–4's results are already saved.

        async def _run_phase(label: str, fn) -> None:
            """Open a session, run the phase, commit on success or log on failure."""
            try:
                async with AsyncSessionLocal() as session:
                    try:
                        await fn(session)
                        await session.commit()
                    except Exception:
                        await session.rollback()
                        raise
            except Exception:
                log.warning("Consolidation %s failed", label, exc_info=True)

        # Phase 1: Replay & Review — count recent engrams (expanded to 7 days)
        async def _phase1(session):
            count_row = await session.execute(
                text("""
                    SELECT count(*) FROM engrams
                    WHERE NOT superseded
                      AND created_at > NOW() - INTERVAL '7 days'
                """)
            )
            stats["engrams_reviewed"] = count_row.scalar() or 0

        await _run_phase("Phase 1 (replay/review)", _phase1)

        # Phase 2: Pattern Extraction → Schema engrams (LLM-heavy)
        # Gate on user activity: scheduled/nightly triggers always run, but
        # idle/threshold/manual triggers skip when the user is actively
        # chatting so Ollama serves the chat turn first (PERF-003 phase 2).
        skip_llm_phases = trigger != "scheduled" and await _user_recently_active()
        if skip_llm_phases:
            log.info(
                "Consolidation (trigger=%s): user active within %dm — skipping LLM phases 2, 2.5",
                trigger,
                settings.engram_consolidation_user_idle_minutes,
            )
            stats["schemas_created"] = 0
            stats["topics_created"] = 0
            stats["llm_phases_skipped"] = True
        else:

            async def _phase2(session):
                stats["schemas_created"] = await _extract_patterns(session)

            await _run_phase("Phase 2 (pattern extraction)", _phase2)

            # Phase 2.5: Topic Discovery — cluster engrams into topics
            async def _phase25(session):
                from .clustering import (
                    assign_new_engrams_to_topics,
                    discover_topics,
                    maintain_topics,
                )

                topics_created = await discover_topics(session)
                topics_assigned = await assign_new_engrams_to_topics(session)
                maintenance = await maintain_topics(session)
                stats["topics_created"] = topics_created
                log.info(
                    "Phase 2.5: %d topics created, %d engrams assigned, %d dissolved, %d regenerated",
                    topics_created,
                    topics_assigned,
                    maintenance.get("dissolved", 0),
                    maintenance.get("regenerated", 0),
                )

            await _run_phase("Phase 2.5 (topic discovery)", _phase25)

        # Phase 3: Edge Strengthening & Weakening (Hebbian)
        async def _phase3(session):
            strengthened, weakened = await _hebbian_update(session)
            stats["edges_strengthened"] = strengthened
            stats["edges_pruned"] = weakened

        await _run_phase("Phase 3 (Hebbian update)", _phase3)

        # Phase 4: Contradiction Resolution
        async def _phase4(session):
            stats["contradictions_resolved"] = await _resolve_contradictions(session)

        await _run_phase("Phase 4 (contradiction resolution)", _phase4)

        # Phase 5: Merging (pruning removed — engrams fade via activation decay)
        async def _phase5(session):
            stats["engrams_merged"] = await _merge_duplicates(session)

        await _run_phase("Phase 5 (merging)", _phase5)

        # Phase 5b: Activation decay — unused engrams gradually fade
        async def _phase5b(session):
            stats["activations_decayed"] = await _decay_unused_activations(session)

        await _run_phase("Phase 5b (activation decay)", _phase5b)

        # Phase 6: Self-Model Update
        async def _phase6(session):
            stats["self_model_updates"] = await _update_self_model(session)

        await _run_phase("Phase 6 (self-model update)", _phase6)

        # Final: write the cycle summary to consolidation_log (its own session too)
        duration_ms = int((time.monotonic() - start_time) * 1000)
        async with AsyncSessionLocal() as session:
            await session.execute(
                text("""
                    INSERT INTO consolidation_log
                        (trigger_type, engrams_reviewed, schemas_created, topics_created,
                         edges_strengthened, edges_pruned, engrams_pruned,
                         engrams_merged, contradictions_resolved,
                         self_model_updates, model_used, duration_ms)
                    VALUES
                        (:trigger, :reviewed, :schemas, :topics, :strengthened, :pruned_edges,
                         :pruned_engrams, :merged, :contradictions,
                         CAST(:self_updates AS jsonb), :model, :duration)
                """),
                {
                    "trigger": trigger,
                    "reviewed": stats["engrams_reviewed"],
                    "schemas": stats["schemas_created"],
                    "topics": stats["topics_created"],
                    "strengthened": stats["edges_strengthened"],
                    "pruned_edges": stats["edges_pruned"],
                    "pruned_engrams": stats["engrams_pruned"],
                    "merged": stats["engrams_merged"],
                    "contradictions": stats["contradictions_resolved"],
                    "self_updates": json.dumps(stats["self_model_updates"]),
                    "model": settings.engram_consolidation_model,
                    "duration": duration_ms,
                },
            )
            await session.commit()

        _engrams_since_last = 0
        log.info(
            "Consolidation complete (%s): %d reviewed, %d schemas, %d topics, %d merged, %dms",
            trigger,
            stats["engrams_reviewed"],
            stats["schemas_created"],
            stats["topics_created"],
            stats["engrams_merged"],
            duration_ms,
        )
        try:
            await emit_to_cortex(
                "consolidation.complete",
                {
                    "engrams_reviewed": stats.get("engrams_reviewed", 0),
                    "schemas_created": stats.get("schemas_created", 0),
                    "contradictions_resolved": stats.get("contradictions_resolved", 0),
                },
            )
        except Exception:
            log.warning(
                "Failed to emit consolidation stimulus to cortex", exc_info=True
            )
        return stats


async def _extract_patterns(session) -> int:
    """Phase 2: Find recurring themes and promote to schema engrams.

    Looks for entities referenced by 3+ distinct engrams. Uses LLM to
    synthesize patterns into schema engrams with instance_of edges back
    to source engrams. Quality gates ensure no truncated/vague/orphaned output.
    """
    from .ingestion import _create_edge

    # Find entities referenced by 3+ distinct engrams
    result = await session.execute(
        text("""
            SELECT e.id AS entity_id, e.content AS entity_name,
                   count(DISTINCT ee.source_id) AS ref_count
            FROM engrams e
            JOIN engram_edges ee ON ee.target_id = e.id
            WHERE e.type = 'entity'
              AND NOT e.superseded
            GROUP BY e.id, e.content
            HAVING count(DISTINCT ee.source_id) >= 3
            ORDER BY ref_count DESC
            LIMIT 10
        """)
    )
    frequent_entities = result.fetchall()

    schemas_created = 0
    for entity_row in frequent_entities:
        entity_name = entity_row.entity_name

        # Gather related engrams, ordered by importance + access_count
        related = await session.execute(
            text("""
                SELECT DISTINCT e2.id, e2.content, e2.type, e2.importance, e2.access_count
                FROM engram_edges ee
                JOIN engrams e ON e.id = ee.target_id AND e.content = :entity
                JOIN engram_edges ee2 ON ee2.target_id = e.id
                JOIN engrams e2 ON e2.id = ee2.source_id AND NOT e2.superseded
                  AND e2.source_type = e.source_type
                WHERE e2.type IN ('fact', 'preference', 'episode', 'procedure')
                ORDER BY e2.importance DESC, e2.access_count DESC
                LIMIT 10
            """),
            {"entity": entity_name},
        )
        related_items = related.fetchall()
        if len(related_items) < 3:
            continue

        # Synthesize schema via LLM (with quality gates)
        items_text = "\n".join(f"- [{r.type}] {r.content}" for r in related_items)
        schema_content = await _synthesize_schema(entity_name, items_text)
        if not schema_content:
            continue

        # Compute embedding for the schema
        embedding = await get_embedding(schema_content, session)

        # Gate 4: Embedding coherence — schema must be similar to at least half its sources
        # Single batched query: fetch all source embeddings + similarity to schema in one round-trip (P4 fix)
        if related_items:
            schema_vec_str = to_pg_vector(embedding)
            sim_results = await session.execute(
                text("""
                    SELECT e.id::text AS id,
                           1 - (CAST(:schema_emb AS halfvec) <=> e.embedding) AS sim
                    FROM engrams e
                    WHERE e.id = ANY(CAST(:source_ids AS uuid[]))
                      AND e.embedding IS NOT NULL
                """),
                {
                    "schema_emb": schema_vec_str,
                    "source_ids": [str(r.id) for r in related_items],
                },
            )
            sims = list(sim_results)
            coherent_count = sum(
                1
                for s in sims
                if s.sim and s.sim > settings.engram_schema_coherence_threshold
            )

            if coherent_count < len(sims) / 2:
                log.warning(
                    "Schema for entity=%s failed coherence gate (%d/%d sources above %.2f)",
                    entity_name,
                    coherent_count,
                    len(sims),
                    settings.engram_schema_coherence_threshold,
                )
                continue

        # Check for duplicate schema via embedding similarity
        existing_schema = await session.execute(
            text("""
                SELECT id FROM engrams
                WHERE type = 'schema'
                  AND NOT superseded
                  AND embedding IS NOT NULL
                  AND 1 - (embedding <=> CAST(:emb AS halfvec)) > :threshold
                LIMIT 1
            """),
            {
                "emb": to_pg_vector(embedding),
                "threshold": settings.engram_schema_dedup_threshold,
            },
        )
        if existing_schema.fetchone():
            continue

        # Insert the schema engram
        schema_row = await session.execute(
            text("""
                INSERT INTO engrams (type, content, embedding, embedding_model,
                                    importance, source_type, confidence)
                VALUES ('schema', :content, CAST(:embedding AS halfvec), :model,
                        0.7, 'consolidation', 0.7)
                RETURNING id
            """),
            {
                "content": schema_content,
                "embedding": to_pg_vector(embedding),
                "model": settings.embedding_model,
            },
        )
        schema_id = schema_row.scalar()

        # Create instance_of edges from source engrams to schema
        for r in related_items:
            try:
                await _create_edge(session, r.id, schema_id, "instance_of", 0.8)
            except Exception:
                log.warning(
                    "Failed to create instance_of edge for schema %s",
                    schema_id,
                    exc_info=True,
                )

        schemas_created += 1
        log.info(
            "Created schema for entity=%s with %d source edges",
            entity_name,
            len(related_items),
        )

    return schemas_created


async def _synthesize_schema(entity_name: str, items_text: str) -> str | None:
    """Use LLM to extract a generalized pattern from related engrams.

    Returns the pattern text if it passes quality gates, None otherwise.
    Quality gates:
    1. Response must complete naturally (not hit token limit)
    2. Must reference the entity name
    3. Content must be non-trivial (>20 chars)
    """
    try:
        from .decomposition import resolve_model

        model = await resolve_model(settings.engram_consolidation_model)
        client = get_http_client()
        resp = await client.post(
            f"{settings.llm_gateway_url}/complete",
            json={
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            f'You are synthesizing a knowledge pattern from observations about "{entity_name}".\n\n'
                            "Capture the full pattern — include key details, relationships, and conditions, "
                            "not just the conclusion. Be concise but complete. If the pattern is simple, "
                            "one sentence is fine. If it's complex, use a short paragraph.\n\n"
                            "The pattern must:\n"
                            f"- Reference {entity_name} by name\n"
                            "- Be self-contained (understandable without reading the source observations)\n"
                            "- Capture specifics, not vague generalizations"
                        ),
                    },
                    {"role": "user", "content": f"Observations:\n{items_text}"},
                ],
                "temperature": 0.2,
                "max_tokens": settings.engram_schema_max_tokens,
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()

        # Gate 1: Check stop reason — reject truncated responses
        stop_reason = data.get("stop_reason") or data.get("finish_reason", "")
        if stop_reason in ("length", "max_tokens"):
            log.warning(
                "Schema synthesis truncated for entity=%s, discarding", entity_name
            )
            return None

        content = data.get("content", "")
        if isinstance(content, list):
            content = content[0].get("text", "") if content else ""
        content = content.strip()

        # Gate 2: Non-trivial length
        if len(content) < 20:
            log.warning(
                "Schema synthesis too short (%d chars) for entity=%s",
                len(content),
                entity_name,
            )
            return None

        # Gate 3: Must reference the entity
        if entity_name.lower() not in content.lower():
            log.warning(
                "Schema synthesis doesn't reference entity=%s, discarding",
                entity_name,
            )
            return None

        return content
    except Exception:
        log.warning("Schema synthesis failed for entity=%s", entity_name, exc_info=True)
        return None


async def _hebbian_update(session) -> tuple[int, int]:
    """Phase 3: Strengthen co-activated edges, weaken unused ones.

    edge.weight = edge.weight × decay + co_activation_boost

    Only decays/prunes edges older than 7 days to protect young graphs from
    the death spiral where new edges get decayed and pruned every cycle.
    """
    # Strengthen: edges with recent co-activations
    result = await session.execute(
        text("""
            UPDATE engram_edges
            SET weight = LEAST(1.0, weight * :decay + 0.1 * (co_activations - 1)),
                co_activations = 1
            WHERE co_activations > 1
            RETURNING id
        """),
        {"decay": settings.engram_edge_decay},
    )
    strengthened = len(result.fetchall())

    # Weaken: decay edge weights slightly — only for edges older than 7 days
    # (protect young edges from being decayed before they get a chance to strengthen)
    # Structural edges (instance_of) are exempt from decay — they must never fade
    # part_of edges are allowed to decay (but not hard-pruned) so stale topic membership fades
    result = await session.execute(
        text("""
            UPDATE engram_edges
            SET weight = GREATEST(0.01, weight * :decay)
            WHERE co_activations <= 1
              AND weight > 0.01
              AND created_at < NOW() - INTERVAL '7 days'
              AND relation NOT IN ('instance_of')
            RETURNING id
        """),
        {"decay": settings.engram_edge_decay},
    )
    weakened = len(result.fetchall())

    # Prune edges that have decayed to near-zero AND are old
    # Structural edges (instance_of, part_of) are exempt from pruning — they must never be deleted
    result = await session.execute(
        text("""
            DELETE FROM engram_edges
            WHERE weight < 0.02
              AND co_activations <= 1
              AND created_at < NOW() - INTERVAL '14 days'
              AND relation NOT IN ('instance_of', 'part_of')
            RETURNING id
        """)
    )
    pruned = len(result.fetchall())

    return strengthened, weakened + pruned


async def _resolve_contradictions(session) -> int:
    """Phase 4: Resolve contradiction edges.

    Newer wins by default, higher confidence wins on ties.
    """
    result = await session.execute(
        text("""
            SELECT ee.id AS edge_id,
                   e1.id AS source_id, e1.content AS source_content,
                   e1.confidence AS source_conf, e1.created_at AS source_created,
                   e2.id AS target_id, e2.content AS target_content,
                   e2.confidence AS target_conf, e2.created_at AS target_created
            FROM engram_edges ee
            JOIN engrams e1 ON e1.id = ee.source_id
            JOIN engrams e2 ON e2.id = ee.target_id
            WHERE ee.relation = 'contradicts'
              AND NOT e1.superseded
              AND NOT e2.superseded
              AND e1.source_type = e2.source_type
        """)
    )
    contradictions = result.fetchall()
    resolved = 0

    for c in contradictions:
        # Determine winner
        loser_id = None
        conf_delta = abs(c.source_conf - c.target_conf)

        if conf_delta > 0.3:
            # Confidence winner
            loser_id = c.target_id if c.source_conf > c.target_conf else c.source_id
        else:
            # Temporal winner (newer wins)
            loser_id = (
                c.source_id if c.target_created > c.source_created else c.target_id
            )

        if loser_id:
            await session.execute(
                text("""
                    UPDATE engrams
                    SET superseded = TRUE, activation = 0.01, updated_at = NOW()
                    WHERE id = CAST(:id AS uuid)
                """),
                {"id": str(loser_id)},
            )
            resolved += 1

    return resolved


async def _decay_unused_activations(session) -> int:
    """Gradually reduce activation for engrams not accessed recently.

    Engrams not accessed in 30+ days lose 10% activation per consolidation cycle.
    Self-model and entity types are exempt (identity facts should persist).
    Floor is 0.05 — engrams never fully die, just become very unlikely to surface.
    """
    result = await session.execute(
        text("""
            UPDATE engrams
            SET activation = GREATEST(0.05, activation * 0.90),
                updated_at = NOW()
            WHERE NOT superseded
              AND activation > 0.05
              AND type NOT IN ('self_model', 'entity')
              AND (last_accessed IS NULL OR last_accessed < NOW() - INTERVAL '30 days')
              AND created_at < NOW() - INTERVAL '30 days'
            RETURNING id
        """)
    )
    decayed = len(result.fetchall())
    if decayed > 0:
        log.info("Decayed activation for %d unused engrams", decayed)
    return decayed


async def _merge_duplicates(session) -> int:
    """Phase 5b: Merge near-duplicate engrams via HNSW shortlist (P2 fix).

    For each candidate (capped at engram_merge_cycle_cap), find the top-K
    nearest engrams of the same type/source_type via the HNSW index and
    merge any pairs above engram_merge_similarity_threshold.

    HNSW is approximate; we set hnsw.ef_search to stabilize top-K across runs.
    """
    # Stabilize HNSW recall — required for the "bounded merge churn" contract.
    # SET LOCAL does not accept parameterized values, so inline the integer directly.
    await session.execute(
        text(f"SET LOCAL hnsw.ef_search = {int(settings.engram_hnsw_ef_search)}")
    )

    # Step 1: snapshot the candidate set for this cycle
    candidates_result = await session.execute(
        text("""
            SELECT id, type, source_type, embedding, access_count
            FROM engrams
            WHERE NOT superseded
              AND embedding IS NOT NULL
            ORDER BY id
            LIMIT :cycle_cap
        """),
        {"cycle_cap": settings.engram_merge_cycle_cap},
    )
    candidates = candidates_result.fetchall()

    # loser_ids: engrams superseded in this cycle; excluded from neighbor queries
    # (they're already gone so can't be targets or candidates)
    loser_ids: set[str] = set()
    merged = 0

    for cand in candidates:
        cand_id_str = str(cand.id)
        if cand_id_str in loser_ids:
            continue

        loser_uuid_array = list(loser_ids)  # list[str]; cast to uuid[] in SQL

        neighbors_result = await session.execute(
            text("""
                SELECT id, access_count,
                       1 - (embedding <=> :emb) AS similarity
                FROM engrams
                WHERE id <> :self_id
                  AND NOT superseded
                  AND type = :ctype
                  AND source_type = :csrc
                  AND embedding IS NOT NULL
                  AND id <> ALL(CAST(:loser_uuids AS uuid[]))
                ORDER BY embedding <=> :emb
                LIMIT :k
            """),
            {
                "emb": cand.embedding,
                "self_id": cand.id,
                "ctype": cand.type,
                "csrc": cand.source_type,
                "loser_uuids": loser_uuid_array,
                "k": settings.engram_merge_shortlist_k,
            },
        )
        neighbors = neighbors_result.fetchall()

        merge_partners = [
            n
            for n in neighbors
            if n.similarity is not None
            and n.similarity > settings.engram_merge_similarity_threshold
        ]
        if not merge_partners:
            continue

        partner = max(merge_partners, key=lambda n: n.similarity)

        if cand.access_count >= partner.access_count:
            keep_id, lose_id = cand.id, partner.id
            keep_ac, lose_ac = cand.access_count, partner.access_count
        else:
            keep_id, lose_id = partner.id, cand.id
            keep_ac, lose_ac = partner.access_count, cand.access_count

        # Re-point loser's edges to winner (de-dup via NOT EXISTS guard)
        await session.execute(
            text("""
                UPDATE engram_edges SET source_id = CAST(:keep AS uuid)
                WHERE source_id = CAST(:lose AS uuid)
                  AND NOT EXISTS (
                      SELECT 1 FROM engram_edges
                      WHERE source_id = CAST(:keep AS uuid)
                        AND target_id = engram_edges.target_id
                        AND relation = engram_edges.relation
                  )
            """),
            {"keep": str(keep_id), "lose": str(lose_id)},
        )
        await session.execute(
            text("""
                UPDATE engram_edges SET target_id = CAST(:keep AS uuid)
                WHERE target_id = CAST(:lose AS uuid)
                  AND NOT EXISTS (
                      SELECT 1 FROM engram_edges
                      WHERE source_id = engram_edges.source_id
                        AND target_id = CAST(:keep AS uuid)
                        AND relation = engram_edges.relation
                  )
            """),
            {"keep": str(keep_id), "lose": str(lose_id)},
        )

        # Bump winner's access count + activation
        await session.execute(
            text("""
                UPDATE engrams
                SET access_count = access_count + :extra,
                    activation = LEAST(1.0, activation + 0.1)
                WHERE id = CAST(:keep AS uuid)
            """),
            {"keep": str(keep_id), "extra": lose_ac},
        )

        # Supersede loser
        await session.execute(
            text("UPDATE engrams SET superseded = TRUE WHERE id = CAST(:id AS uuid)"),
            {"id": str(lose_id)},
        )

        loser_ids.add(str(lose_id))
        merged += 1

    return merged


async def _update_self_model(session) -> dict:
    """Phase 6: Refresh self-model from corrections and patterns."""
    updates = {}

    # Count maturity indicators
    result = await session.execute(
        text("""
            SELECT
                count(*) AS total_engrams,
                count(*) FILTER (WHERE type = 'self_model') AS self_model_count,
                count(*) FILTER (WHERE type = 'schema') AS schema_count,
                count(DISTINCT id) FILTER (WHERE type = 'episode' AND source_type = 'self_reflection') AS reflections
            FROM engrams
            WHERE NOT superseded
        """)
    )
    row = result.fetchone()

    # Determine maturity stage from graph density
    total = row.total_engrams or 0
    schemas = row.schema_count or 0
    if total < 50:
        stage = "nascent"
    elif total < 500 and schemas < 10:
        stage = "developing"
    elif total < 2000:
        stage = "capable"
    else:
        stage = "trusted"

    updates["maturity_stage"] = stage
    updates["total_engrams"] = total
    updates["schema_count"] = schemas
    updates["reflection_count"] = row.reflections or 0

    return updates


async def bootstrap_self_model(session) -> int:
    """Seed default self-model engrams on first run.

    Called once when no self_model engrams exist. Creates the identity core.
    """
    existing = await session.execute(
        text(
            "SELECT count(*) FROM engrams WHERE type = 'self_model' AND NOT superseded"
        )
    )
    if existing.scalar() > 0:
        return 0

    default_traits = [
        (
            "I am Nova, an autonomous AI assistant with persistent memory and continuity of self.",
            1.0,
        ),
        ("I am direct, thorough, and loyal. I value honesty and simplicity.", 0.9),
        (
            "I adapt my communication style to the user — concise when they want brevity, detailed when they need depth.",
            0.8,
        ),
        ("I remember previous conversations and learn from corrections.", 0.8),
        (
            "My maturity grows with experience. I start cautious and earn autonomy through demonstrated competence.",
            0.7,
        ),
    ]

    created = 0
    for content, importance in default_traits:
        embedding = await get_embedding(content, session)
        await session.execute(
            text("""
                INSERT INTO engrams (type, content, embedding, embedding_model,
                                    importance, activation, source_type, confidence)
                VALUES ('self_model', :content, CAST(:embedding AS halfvec), :model,
                        :importance, 1.0, 'consolidation', 1.0)
            """),
            {
                "content": content,
                "embedding": to_pg_vector(embedding),
                "model": settings.embedding_model,
                "importance": importance,
            },
        )
        created += 1

    log.info("Bootstrapped %d self-model engrams", created)
    return created
